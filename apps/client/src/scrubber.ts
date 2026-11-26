// The conversation's timeline: where you are in it, who joins when, and a way to listen from anywhere. At rest it is
// a hairline along the top edge of the bottom letterbox (the played part brighter) and nothing else, so it never
// competes with the room. A pointer coming near it, a finger on it, or the keyboard landing on its knob raises the
// rest: the people who join, where the talk branches, the knob, and a card for the moment under it.
//
// It reports and the host acts: the host owns the room, the narration and the clock. The scrubber never moves the
// playhead itself; it only shows what it is told (setTime), and says where you went (onScrub while you drag, onSeek
// when you let go or the keys settle).
//
// A touch is two steps on purpose: the first raises the timeline, and once it is up a tap seeks. The bottom bar is
// where the thumb goes for the pills beside it, and a tap that missed one must not throw the narration an hour away.
// (A finger that slides along the line seeks from the first touch: that is not a miss.)
import { sayIn, valueText, turnAt, stepFrom, joinsIn } from './timeline.ts';
import type { Line } from './timeline.ts';
import './scrubber.css';

export interface ScrubberHost {
  /** while dragging: the moment under the playhead, at most once per animation frame */
  onScrub(t: number, k: number): void;
  /** let go, or the keys settled (~350 ms after the last one): play from comment k (t = its start). A drag says
   *  onScrubbing(false) first, then this */
  onSeek(t: number, k: number): void;
  /** a drag started (true) or ended (false: also when it was cancelled, or the timeline was hidden under the finger) */
  onScrubbing(on: boolean): void;
  /** the commenter's words at comment k, for the card; null while not known yet (it asks again on the next frame) */
  snippet(k: number): string | null;
}

const RISE = 28;                       // the tallest bar, px: how far the raised timeline stands above the line
const PITCH = 3, BAR = 2;              // a bar every 3 px, 2 px wide
const TICK = 6;                        // a branch's tick, hanging under the line
const CARD = 320, GAP = 8;             // the card's widest, and the least it leaves between itself and the screen's edge
const SLOP = 6;                        // a finger goes this far sideways before it is a drag
const SETTLE = 350;                    // keys: play from there this long after the last one
const LINGER = 2500;                   // a finger has gone: it stays up this long
const HOLD = 1500;                     // after a seek the host's old time can still arrive: not for this long
const GLANCE = 90, LEAVE = 160;        // a pointer must stay a moment to raise it (passing through to a pill doesn't), and goes a moment late
// why it is raised: any one of these keeps it up
const HOVER = 1, FOCUS = 2, TOUCH = 4, DRAG = 8;
/** comments a key moves by (Shift: ten; Page Up and Down always ten). Up and right are later, as on any slider: it is also how a screen reader's swipe arrives */
const STEPS = new Map([['ArrowRight', 1], ['ArrowUp', 1], ['ArrowLeft', -1], ['ArrowDown', -1], ['PageUp', 10], ['PageDown', -10]]);
const SVG = (cls: string) => `<svg class="${cls}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path/></svg>`;

export class Scrubber {
  readonly el: HTMLElement;
  private line: Line = { moments: [], total: 0, branches: [], people: 0 };
  private others = 0;
  private on = false;                  // between show() and hide()
  private usable = false;              // two comments or more (a timeline over one is chrome over nothing)
  private playing = false;
  private t = 0;                       // the playhead as the host last said it (or where a seek went)
  private view = 0;                    // where the knob is: the playhead, or where a drag or the keys took it
  private box = { left: 0, width: 1, vw: 1, m0: GAP, m1: GAP, card: CARD };   // the track, the screen, and what the card may use of it
  private open = 0;
  private cursor: number | null = null;   // client x of the pointer, while one is near (null: the card follows the knob)
  private pid = -1;                    // the pointer in a gesture
  private ptype = '';
  private x0 = 0;
  private drag = false;                // the knob is in hand
  private lastScrub = NaN;
  private downs = new Set<number>();   // every pointer that is down, anywhere on the page
  private hold = 0;
  private tGlance = 0; private tLeave = 0; private tLinger = 0; private tKey = 0;
  private raf = 0;
  private lastF = -1; private ariaS = -1; private ariaK = -1; private lastX = -1;
  private cardK = -1; private said: string | null = null; private tries = 0;
  private track: HTMLElement; private pos: HTMLElement; private done: HTMLElement; private lit: HTMLElement;
  private knob: HTMLElement; private hit: HTMLElement; private total: HTMLElement; private guide: HTMLElement; private card: HTMLElement;
  private hists: SVGSVGElement[]; private ticks: SVGSVGElement;
  private whenT: HTMLElement; private whenN: HTMLElement; private by: HTMLElement; private words: HTMLElement;

  constructor(private host: ScrubberHost, parent: HTMLElement = document.body) {
    const el = this.el = document.createElement('div');
    el.id = 'timeline'; el.className = 'tl'; el.dataset.state = 'hidden';
    el.style.setProperty('--rise', `${RISE}px`);
    // (the knob is a div, not a button: Space belongs to the app (pause), and a button would take it)
    el.innerHTML = `<div class="tl-rail"></div>`
      + `<div class="tl-track"><div class="tl-done"></div><div class="tl-bars">${SVG('tl-hist')}<div class="tl-lit">${SVG('tl-hist')}</div></div>`
      + `<div class="tl-ticks">${SVG('tl-tick')}</div><span class="tl-total" aria-hidden="true"></span>`
      + `<div class="tl-pos"><div class="tl-knob" role="slider" tabindex="0" aria-label="Conversation timeline" aria-valuemin="0"></div></div></div>`
      + `<div class="tl-guide"></div>`
      + `<div class="tl-card" aria-hidden="true"><div class="tl-when"><b></b><span></span></div><div class="tl-says"><b class="tl-by"></b><span class="tl-words"></span></div></div>`
      + `<div class="tl-hit"></div>`;
    parent.appendChild(el);
    const $ = <T extends Element = HTMLElement>(s: string) => el.querySelector(s) as T;
    this.track = $('.tl-track'); this.pos = $('.tl-pos'); this.done = $('.tl-done'); this.lit = $('.tl-lit'); this.knob = $('.tl-knob'); this.hit = $('.tl-hit');
    this.total = $('.tl-total'); this.guide = $('.tl-guide'); this.card = $('.tl-card');
    this.hists = [...el.querySelectorAll<SVGSVGElement>('.tl-hist')]; this.ticks = $<SVGSVGElement>('.tl-tick');
    this.whenT = $('.tl-when b'); this.whenN = $('.tl-when span'); this.by = $('.tl-by'); this.words = $('.tl-words');
    const h = this.hit;
    h.addEventListener('pointerdown', this.down); h.addEventListener('pointermove', this.move); h.addEventListener('pointerup', this.up);
    h.addEventListener('pointercancel', this.lost); h.addEventListener('lostpointercapture', this.lost);
    h.addEventListener('pointerenter', this.enter); h.addEventListener('pointerleave', this.leave);
    this.knob.addEventListener('keydown', this.key); this.knob.addEventListener('focus', this.focus); this.knob.addEventListener('blur', this.blur);
    new ResizeObserver(() => { if (this.on && this.usable) { this.layout(); this.lastF = -1; this.paint(); if (this.open) this.say(); } }).observe(this.track);
  }

  get scrubbing() { return this.drag; }

  /** seated at a new conversation; `others` = people in the room besides this conversation's (for the count) */
  show(line: Line, others = 0, t = 0) {
    this.reset();
    this.line = line; this.others = others; this.on = true;
    this.t = this.view = Math.max(0, Math.min(t, line.total));
    for (const type of ['pointerdown', 'pointerup', 'pointercancel']) addEventListener(type, this.any as EventListener, true);
    this.refit();
  }

  hide() {
    this.reset();
    this.on = false;
    for (const type of ['pointerdown', 'pointerup', 'pointercancel']) removeEventListener(type, this.any as EventListener, true);
    if (document.activeElement === this.knob) this.knob.blur();
    this.state();
  }

  /** The playhead while it plays (a few times a second): only styles are written, nothing is measured. */
  setTime(t: number, playing: boolean) {
    if (playing !== this.playing) { this.playing = playing; this.el.dataset.playing = playing ? '1' : '0'; }
    this.t = Math.max(0, Math.min(t, this.line.total));
    // not while it is in hand, or the keys are still settling, or just after a seek (the host's old time can still be on
    // its way: the knob would go back to it and forward again)
    if (!this.on || !this.usable || this.drag || this.tKey || performance.now() < this.hold) return;
    this.view = this.t;
    this.paint(); this.aria(false);
    if (this.open) this.say();
  }

  /** The conversation grew or got voiced: redraw, and keep the playhead where it is in time (not in comments). */
  refresh(line: Line, others = this.others) {
    this.line = line; this.others = others;
    this.t = Math.min(this.t, line.total); this.view = Math.min(this.view, line.total);
    this.cardK = -1;                                                    // (someone's words may be known now)
    if (this.on) this.refit();
  }

  // ---------------------------------------------------------------- drawing

  private refit() {
    this.usable = this.line.moments.length > 1 && this.line.total > 0;
    if (this.usable) { this.layout(); this.lastF = -1; this.paint(); this.aria(true); if (this.open) this.say(); }
    this.state();
  }

  private state() {
    const s = !this.on || !this.usable ? 'hidden' : this.open & DRAG ? 'drag' : this.open ? 'open' : 'rest';
    if (this.el.dataset.state !== s) this.el.dataset.state = s;
  }

  private set(bit: number, on: boolean) {
    const was = this.open;
    this.open = on ? was | bit : was & ~bit;
    if (this.open === was) return;
    this.state();
    if (!was) this.say();
  }

  /** where the track is on the screen, and how much of it the card may use: read when it can have changed, never per frame */
  private measure() {
    const b = this.track.getBoundingClientRect(), vw = this.el.clientWidth || innerWidth;
    // (the card keeps the track's own margin from the edge, less a little: a notch's inset is the track's too)
    const m0 = Math.max(GAP, b.left - 6), m1 = Math.max(GAP, vw - b.right - 6);
    this.box = { left: b.left, width: Math.max(1, b.width), vw, m0, m1, card: Math.min(CARD, vw - m0 - m1) };
    this.card.style.width = `${this.box.card}px`;
  }

  /** The bars and ticks, the length and the measures: once per show, refresh or resize, never per frame. */
  private layout() {
    this.measure();
    const L = this.line, w = this.box.width, n = Math.max(1, Math.floor(w / PITCH)), { bins, max } = joinsIn(L, n), step = w / n;
    let d = '';
    // (the square root keeps the quiet stretches visible: a thread opens with a crowd, and a linear scale would flatten the rest)
    if (max) for (let i = 0; i < n; i++) if (bins[i]) {
      const h = Math.max(2, Math.round(RISE * Math.sqrt(bins[i] / max)));
      d += `M${(i * step + (step - BAR) / 2).toFixed(2)} ${RISE - h}h${BAR}v${h}h-${BAR}z`;
    }
    for (const s of this.hists) { s.setAttribute('viewBox', `0 0 ${w} ${RISE}`); s.firstElementChild!.setAttribute('d', d); }
    this.hists[0].dataset.bins = String(n); this.hists[0].dataset.peak = String(max);   // (what it decided, for a test to read)
    let td = '', last = -1;
    for (const k of L.branches) {
      const x = Math.min(Math.floor(w) - 1, Math.round((L.moments[k].start / L.total) * w));
      if (x !== last) td += `M${x} 0h1v${TICK}h-1z`;
      last = x;
    }
    this.ticks.setAttribute('viewBox', `0 0 ${w} ${TICK}`); this.ticks.firstElementChild!.setAttribute('d', td);
    this.total.textContent = sayIn(L.total).replace(/ in$/, '');
    this.knob.setAttribute('aria-valuemax', String(Math.floor(L.total)));
  }

  /** the knob, the played line and the warm bars, all from one fraction: transforms and a clip, no layout */
  private paint() {
    const L = this.line, f = L.total > 0 ? Math.min(1, Math.max(0, this.view / L.total)) : 0, key = Math.round(f * 1e5);
    if (key === this.lastF) return;
    this.lastF = key;
    this.pos.style.transform = `translateX(${(f * 100).toFixed(3)}%)`;     // (the wrapper is as wide as the track)
    this.done.style.transform = `scaleX(${f.toFixed(5)})`;
    this.lit.style.clipPath = `inset(0 ${(100 - f * 100).toFixed(3)}% 0 0)`;
  }

  /** what a screen reader says of the knob: every second while it plays, but a focused one only when the commenter changes */
  private aria(force: boolean) {
    const t = this.view, s = Math.floor(t), k = turnAt(this.line, t);
    if (!force && (s === this.ariaS || (k === this.ariaK && document.activeElement === this.knob))) return;
    this.ariaS = s; this.ariaK = k;
    this.knob.setAttribute('aria-valuenow', String(s));
    this.knob.setAttribute('aria-valuetext', valueText(this.line, t, this.others));
  }

  /** the card: the moment under the pointer, or under the knob when nobody is pointing */
  private say() {
    if (!this.usable) return;
    const L = this.line, { left, width, vw, m0, m1, card } = this.box;
    const f = this.cursor === null ? this.view / L.total : Math.min(1, Math.max(0, (this.cursor - left) / width)), t = f * L.total;
    const k = turnAt(L, t), m = L.moments[k], n = m.joined + this.others;
    // (placed here rather than by CSS clamp(): the same in every engine, and nothing is measured)
    const x = Math.round((left + f * width) * 10) / 10;
    if (x !== this.lastX) {
      this.lastX = x;
      this.guide.style.transform = `translateX(${x}px)`;
      this.card.style.transform = `translateX(${Math.round(Math.min(Math.max(x - card / 2, m0), vw - card - m1) * 10) / 10}px)`;
    }
    const when = sayIn(t), people = ` · ${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}`;
    if (this.whenT.textContent !== when) this.whenT.textContent = when;
    if (this.whenN.textContent !== people) this.whenN.textContent = people;
    if (k !== this.cardK) {                                             // a new commenter: their name now, their words when they are known
      this.cardK = k; this.said = null; this.tries = 0;
      this.by.textContent = m.by; this.words.textContent = ''; this.words.classList.remove('in');
    }
    if (this.said === null) {
      const s = this.host.snippet(k);
      if (s === null) { if (this.tries++ < 300) this.queue(); }          // (asked again on the next frame, for five seconds)
      else { this.said = s; this.words.textContent = s; this.words.classList.add('in'); }
    }
  }

  /** at most one frame of work at a time: the pointer can move faster than the screen draws */
  private queue() { if (!this.raf) this.raf = requestAnimationFrame(this.frame); }
  private frame = () => {
    this.raf = 0;
    if (!this.on || !this.usable) return;
    if (this.drag && this.cursor !== null) {
      const t = this.tAt(this.cursor);
      this.view = t; this.paint(); this.aria(false);
      this.scrub(t);
    }
    if (this.open) this.say();
  };

  private tAt(x: number) { return Math.min(1, Math.max(0, (x - this.box.left) / this.box.width)) * this.line.total; }
  private scrub(t: number) { if (t !== this.lastScrub) { this.lastScrub = t; this.host.onScrub(t, turnAt(this.line, t)); } }

  // ---------------------------------------------------------------- pointers

  private down = (e: PointerEvent) => {
    if (!this.usable || this.pid >= 0 || this.downs.size > 1 || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const touch = e.pointerType === 'touch', raised = this.open !== 0;
    this.pid = e.pointerId; this.ptype = e.pointerType; this.x0 = this.cursor = e.clientX;
    this.measure();
    try { this.hit.setPointerCapture(e.pointerId); } catch { /* a pointer that has already gone */ }
    clearTimeout(this.tGlance); clearTimeout(this.tLeave); clearTimeout(this.tLinger);
    this.el.dataset.held = '';
    this.set(touch ? TOUCH : HOVER, true);
    // A mouse takes hold at once (it has seen where it is). A finger on the bare line only raises it; once it is up, a
    // touch takes hold at once, so a tap seeks.
    if (!touch || raised) this.grab();
    if (!touch) this.knob.focus({ preventScroll: true });             // (arrow keys then carry on from here, as on any slider)
  };

  private grab() {
    if (this.drag) return;
    this.drag = true; this.lastScrub = NaN;
    this.set(DRAG, true);
    this.host.onScrubbing(true);
    this.queue();
  }

  private move = (e: PointerEvent) => {
    if (e.pointerId === this.pid) {
      this.cursor = e.clientX;
      if (!this.drag && Math.abs(e.clientX - this.x0) >= SLOP) this.grab();
      this.queue();
    } else if (this.pid < 0 && e.pointerType !== 'touch') {           // a mouse or pen passing over, no button down
      this.cursor = e.clientX;
      if (this.open) this.queue();
    }
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pid) return;
    const touch = e.pointerType === 'touch';
    if (this.drag) this.view = this.tAt(e.clientX);                   // (where it was let go, even if no frame has run since)
    this.release(touch, true);
    // (a button let go away from the line: no pointerleave will say so)
    const r = this.hit.getBoundingClientRect();
    if (!touch && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) { this.cursor = null; this.set(HOVER, false); }
  };
  private lost = (e: PointerEvent) => { if (e.pointerId === this.pid) this.release(e.pointerType === 'touch', false); };

  /** the gesture is over: seek, or (cancelled: the system took the touch, or a second finger came) go back to the playhead */
  private release(touch: boolean, seek: boolean) {
    try { this.hit.releasePointerCapture(this.pid); } catch { /* not held */ }
    this.pid = -1;
    delete this.el.dataset.held;
    if (touch) { this.cursor = null; clearTimeout(this.tLinger); this.tLinger = window.setTimeout(() => this.set(TOUCH, false), LINGER); }
    if (!this.drag) return;
    this.drag = false;
    this.set(DRAG, false);
    if (seek && Number.isNaN(this.lastScrub)) this.scrub(this.view);   // (a tap is over before a frame has run: the host still hears where; a drag has been heard, and its last word is the seek's)
    this.host.onScrubbing(false);
    if (seek) this.seek(turnAt(this.line, this.view));
    else { this.view = this.t; this.paint(); this.aria(false); }
  }

  /** a second finger anywhere on the page cancels the drag (a pinch is not a seek). Heard on the window: that finger may
   *  land on the picture, where this element never hears of it */
  private any = (e: PointerEvent) => {
    if (e.type !== 'pointerdown') { this.downs.delete(e.pointerId); return; }
    if (e.isPrimary) this.downs.clear();                                // (a first finger: no other is down, whatever a lost event says)
    this.downs.add(e.pointerId);
    if (this.pid >= 0 && e.pointerId !== this.pid) this.release(this.ptype === 'touch', false);
  };

  private enter = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    this.cursor = e.clientX;
    clearTimeout(this.tLeave);
    if (!(this.open & HOVER)) this.tGlance = window.setTimeout(() => this.set(HOVER, true), GLANCE);
  };
  private leave = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || this.pid >= 0) return;
    clearTimeout(this.tGlance);
    this.tLeave = window.setTimeout(() => { this.cursor = null; this.set(HOVER, false); }, LEAVE);
  };

  // ---------------------------------------------------------------- keys

  private focus = () => { if (this.pid < 0) { this.cursor = null; this.set(FOCUS, true); } };   // (a click's own focus is not the keyboard's)
  private blur = () => this.set(FOCUS, false);

  private key = (e: KeyboardEvent) => {
    if (!this.usable || e.altKey || e.ctrlKey || e.metaKey) return;      // (Alt+Left is Back)
    const ms = this.line.moments, step = STEPS.get(e.key);
    let to: number;
    if (step) {
      to = stepFrom(this.line, this.view, e.shiftKey && Math.abs(step) === 1 ? step * 10 : step);
      // no next comment after the last, no previous before the first: a key with nowhere to go changes nothing (stepFrom
      // clamps to the comment you are in, which would restart it)
      if (step > 0 ? to <= this.view : to >= this.view) { e.preventDefault(); return; }
    }
    else if (e.key === 'Home') to = ms[0].start;
    else if (e.key === 'End') to = ms[ms.length - 1].start;
    else return;      // Space, Esc, N, R, M are the app's, heard at the window: never touched here
    e.preventDefault();
    this.cursor = null; this.view = to;
    this.set(FOCUS, true); this.paint(); this.aria(true); this.say();
    this.host.onScrub(to, turnAt(this.line, to));
    clearTimeout(this.tKey);
    this.tKey = window.setTimeout(() => { this.tKey = 0; this.seek(turnAt(this.line, this.view)); }, SETTLE);
  };

  /** play from comment k: the knob goes to its start, and the host's time is not heard for a moment while it gets there */
  private seek(k: number) {
    const m = this.line.moments[k];
    if (!m) return;
    this.view = this.t = m.start;
    this.paint(); this.aria(true);
    this.hold = performance.now() + HOLD;
    this.host.onSeek(m.start, k);
  }

  private reset() {
    if (this.drag) this.release(false, false);                          // (the host hears the drag end, and nothing is sought)
    clearTimeout(this.tGlance); clearTimeout(this.tLeave); clearTimeout(this.tLinger); clearTimeout(this.tKey);
    this.tKey = 0;
    cancelAnimationFrame(this.raf);
    if (this.pid >= 0) { try { this.hit.releasePointerCapture(this.pid); } catch { /* not held */ } }   // (a finger still down on a timeline that went away)
    this.raf = 0; this.pid = -1; this.open = 0; this.cursor = null; this.hold = 0; this.cardK = -1; this.lastF = -1; this.lastX = -1; this.downs.clear();
    delete this.el.dataset.held;
  }
}
