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

/**
 * What a line is, to the scrubber: positions along it (x, from 0 to `total`, in the line's own units), the comments on
 * it (k), and what to say about any point. A conversation's line (lineModel) is the narration's clock; the floor's
 * (FLOOR_TIMELINE, floorline.ts) is the floor's own clock, compressed.
 */
export interface ScrubModel {
  readonly total: number;
  /** comments on the line */
  readonly count: number;
  /** what the slider is called */
  readonly label: string;
  /** the comment at x (the latest to have started by x; the first, before it) */
  at(x: number): number;
  /** where comment k starts */
  start(k: number): number;
  /** the keys: the start of the comment `step` away from the one at x */
  step(x: number, step: number): number;
  /** Home and End */
  home(): number;
  end(): number;
  /** arrivals in each of n equal stretches (and departures, where people leave), and the busiest of either */
  flow(n: number): { up: ArrayLike<number>; down?: ArrayLike<number>; max: number };
  /** where ticks hang under the line (the talk branching; a table opening) */
  ticks(): ArrayLike<number>;
  /** the whole line's length, said ("1 h 12 min") */
  length(): string;
  /** the slider's value (whole seconds), its maximum, and what a screen reader says at x */
  aria(x: number): { now: number; max: number; text: string };
  /** the card at x: how far in, who's around, whose comment it is */
  card(x: number): { when: string; around: string; k: number; by: string };
  /** a stretch to light on the line (the table you sit at, on the floor's), or null */
  band(): readonly [number, number] | null;
  /** what a screen reader hears about the line, once (the floor's rule for when people leave), if anything */
  readonly about?: string;
}

/** a conversation's own line (TIMELINE): `others` are the people in the room who aren't in it (for the count) */
export function lineModel(line: Line, others = 0): ScrubModel & { line: Line } {
  const ms = line.moments;
  return {
    line, total: line.total, count: ms.length, label: 'Conversation timeline',
    at: (x) => turnAt(line, x), start: (k) => ms[k].start, step: (x, n) => stepFrom(line, x, n),
    home: () => ms[0].start, end: () => ms[ms.length - 1].start,
    flow: (n) => { const { bins, max } = joinsIn(line, n); return { up: bins, max }; },
    ticks: () => line.branches.map((k) => ms[k].start),
    length: () => sayIn(line.total).replace(/ in$/, ''),
    aria: (x) => ({ now: Math.floor(x), max: Math.floor(line.total), text: valueText(line, x, others) }),
    card: (x) => { const k = turnAt(line, x), m = ms[k], n = m.joined + others; return { when: sayIn(x), around: ` · ${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}`, k, by: m.by }; },
    band: () => null,
  };
}

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
const GONE = 9;                        // the tallest bar of people going, hanging under the line (the floor's)
const CARD = 320, GAP = 8;             // the card's widest, and the least it leaves between itself and the screen's edge
const SLOP = 6;                        // a finger goes this far sideways before it is a drag
const SETTLE = 350;                    // keys: play from there this long after the last one
const LINGER = 2500;                   // a finger has gone: it stays up this long
const HOLD = 1500;                     // after a seek the host's old time can still arrive: not for this long
const GLANCE = 90, LEAVE = 160;        // a pointer must stay a moment to raise it (passing through to a pill doesn't), and goes a moment late
// why it is raised: any one of these keeps it up
const HOVER = 1, FOCUS = 2, TOUCH = 4, DRAG = 8, PEEK = 16;
/** the first time it appears: up for a moment, so a thumb knows there's a line to pull (nothing at rest says so) */
const PEEK_FOR = 2600;
/** comments a key moves by (Shift: ten; Page Up and Down always ten). Up and right are later, as on any slider: it is also how a screen reader's swipe arrives */
const STEPS = new Map([['ArrowRight', 1], ['ArrowUp', 1], ['ArrowLeft', -1], ['ArrowDown', -1], ['PageUp', 10], ['PageDown', -10]]);
const SVG = (cls: string) => `<svg class="${cls}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path/></svg>`;

export class Scrubber {
  readonly el: HTMLElement;
  private m: ScrubModel = lineModel({ moments: [], total: 0, branches: [], people: 0 });
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
  private offX = 0; private lastX0 = 0;   // where a seek let go, and the pointer's last x (the card stays away until it moves on)
  private cardK = -1; private said: string | null = null; private tries = 0;
  private track: HTMLElement; private pos: HTMLElement; private done: HTMLElement; private lit: HTMLElement;
  private knob: HTMLElement; private hit: HTMLElement; private total: HTMLElement; private guide: HTMLElement; private card: HTMLElement;
  private hists: SVGSVGElement[]; private ticks: SVGSVGElement; private gone: SVGSVGElement; private bandEl: HTMLElement; private noteEl: HTMLElement;
  private whenT: HTMLElement; private whenN: HTMLElement; private by: HTMLElement; private words: HTMLElement;

  constructor(private host: ScrubberHost, parent: HTMLElement = document.body) {
    const el = this.el = document.createElement('div');
    el.id = 'timeline'; el.className = 'tl'; el.dataset.state = 'hidden';
    el.style.setProperty('--rise', `${RISE}px`);
    // (the knob is a div, not a button: Space belongs to the app (pause), and a button would take it)
    el.innerHTML = `<div class="tl-rail"></div>`
      + `<div class="tl-track"><div class="tl-band"></div><div class="tl-done"></div><div class="tl-bars">${SVG('tl-hist')}<div class="tl-lit">${SVG('tl-hist')}</div></div><div class="tl-gone">${SVG('tl-hist')}</div>`
      + `<div class="tl-ticks">${SVG('tl-tick')}</div><span class="tl-total" aria-hidden="true"></span>`
      + `<div class="tl-pos"><div class="tl-knob" role="slider" tabindex="0" aria-label="Conversation timeline" aria-valuemin="0"></div></div></div>`
      + `<div class="tl-guide"></div>`
      + `<div class="tl-card" aria-hidden="true"><div class="tl-when"><b></b><span></span></div><div class="tl-says"><b class="tl-by"></b><span class="tl-words"></span></div><div class="tl-note"></div></div>`
      + `<div class="tl-hit"></div><span class="tl-about" id="tl-about" hidden></span>`;
    parent.appendChild(el);
    const $ = <T extends Element = HTMLElement>(s: string) => el.querySelector(s) as T;
    this.track = $('.tl-track'); this.pos = $('.tl-pos'); this.done = $('.tl-done'); this.lit = $('.tl-lit'); this.knob = $('.tl-knob'); this.hit = $('.tl-hit');
    this.total = $('.tl-total'); this.guide = $('.tl-guide'); this.card = $('.tl-card');
    this.hists = [...el.querySelectorAll<SVGSVGElement>('.tl-bars .tl-hist')]; this.ticks = $<SVGSVGElement>('.tl-tick');
    this.gone = $<SVGSVGElement>('.tl-gone .tl-hist'); this.bandEl = $('.tl-band'); this.noteEl = $('.tl-note');
    this.whenT = $('.tl-when b'); this.whenN = $('.tl-when span'); this.by = $('.tl-by'); this.words = $('.tl-words');
    const h = this.hit;
    h.addEventListener('pointerdown', this.down); h.addEventListener('pointermove', this.move); h.addEventListener('pointerup', this.up);
    h.addEventListener('pointercancel', this.lost); h.addEventListener('lostpointercapture', this.lost);
    h.addEventListener('pointerenter', this.enter); h.addEventListener('pointerleave', this.leave);
    this.knob.addEventListener('keydown', this.key); this.knob.addEventListener('focus', this.focus); this.knob.addEventListener('blur', this.blur);
    new ResizeObserver(() => { if (this.on && this.usable) { this.layout(); this.lastF = -1; this.paint(); if (this.open) this.say(); } }).observe(this.track);
  }

  get scrubbing() { return this.drag; }

  /** a new line to scrub (seated at a conversation: lineModel; the floor's: floorline.ts), the playhead at t */
  show(m: ScrubModel, t = 0) {
    this.reset();
    this.m = m; this.on = true;
    this.knob.setAttribute('aria-label', m.label);
    // (the line's own rules, said once to a screen reader: the floor's leaving rule)
    const about = this.el.querySelector('.tl-about')!;
    about.textContent = m.about ?? '';
    if (m.about) this.knob.setAttribute('aria-describedby', 'tl-about'); else this.knob.removeAttribute('aria-describedby');
    this.t = this.view = Math.max(0, Math.min(t, m.total));
    for (const type of ['pointerdown', 'pointerup', 'pointercancel']) addEventListener(type, this.any as EventListener, true);
    this.refit();
  }

  hide() {
    this.reset();
    delete this.el.dataset.card;
    this.on = false;
    for (const type of ['pointerdown', 'pointerup', 'pointercancel']) removeEventListener(type, this.any as EventListener, true);
    if (document.activeElement === this.knob) this.knob.blur();
    this.state();
  }

  /** Raised for a moment by itself (the first time anyone sits down with it): what it is, shown once, then out of the way. */
  peek() {
    if (!this.on || !this.usable || this.open) return;
    this.set(PEEK, true);
    clearTimeout(this.tPeek);
    this.tPeek = window.setTimeout(() => this.set(PEEK, false), PEEK_FOR);
  }
  private tPeek = 0;

  /** The playhead while it plays (a few times a second): only styles are written, nothing is measured. */
  setTime(t: number, playing: boolean) {
    if (playing !== this.playing) { this.playing = playing; this.el.dataset.playing = playing ? '1' : '0'; }
    this.t = Math.max(0, Math.min(t, this.m.total));
    // not while it is in hand, or the keys are still settling, or just after a seek (the host's old time can still be on
    // its way: the knob would go back to it and forward again)
    if (!this.on || !this.usable || this.drag || this.tKey || performance.now() < this.hold) return;
    this.view = this.t;
    this.paint(); this.aria(false);
    if (this.open) this.say();
  }

  /** The conversation grew or got voiced (or the floor did): redraw, and keep the playhead where it is (not in comments). */
  refresh(m: ScrubModel) {
    this.m = m;
    this.t = Math.min(this.t, m.total); this.view = Math.min(this.view, m.total);
    this.cardK = -1;                                                    // (someone's words may be known now)
    if (this.on) this.refit();
  }

  // ---------------------------------------------------------------- drawing

  private refit() {
    this.usable = this.m.count > 1 && this.m.total > 0;
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
    const M = this.m, w = this.box.width, n = Math.max(1, Math.floor(w / PITCH)), { up, down, max } = M.flow(n), step = w / n;
    // (the square root keeps the quiet stretches visible: a thread opens with a crowd, and a linear scale would flatten the rest)
    const bars = (bins: ArrayLike<number>, H: number, hang: boolean) => {
      let d = '';
      if (max) for (let i = 0; i < n; i++) if (bins[i]) {
        const h = Math.max(2, Math.round(H * Math.sqrt(bins[i] / max)));
        d += `M${(i * step + (step - BAR) / 2).toFixed(2)} ${hang ? 0 : H - h}h${BAR}v${h}h-${BAR}z`;
      }
      return d;
    };
    const d = bars(up, RISE, false);
    for (const s of this.hists) { s.setAttribute('viewBox', `0 0 ${w} ${RISE}`); s.firstElementChild!.setAttribute('d', d); }
    this.hists[0].dataset.bins = String(n); this.hists[0].dataset.peak = String(max);   // (what it decided, for a test to read)
    // people going (where the line has them: the floor's): a fainter trace hanging under the line, so the room's ebb reads too
    this.gone.setAttribute('viewBox', `0 0 ${w} ${GONE}`); this.gone.firstElementChild!.setAttribute('d', down ? bars(down, GONE, true) : '');
    this.el.classList.toggle('tl-ebb', !!down);
    let td = '', last = -1;
    const ticks = M.ticks();
    for (let k = 0; k < ticks.length; k++) {
      const x = Math.min(Math.floor(w) - 1, Math.round((ticks[k] / M.total) * w));
      if (x !== last) td += `M${x} 0h1v${TICK}h-1z`;
      last = x;
    }
    this.ticks.setAttribute('viewBox', `0 0 ${w} ${TICK}`); this.ticks.firstElementChild!.setAttribute('d', td);
    this.total.textContent = M.length();
    this.knob.setAttribute('aria-valuemax', String(M.aria(M.total).max));
    // (the table you sit at, on the floor's line: its stretch, lit)
    const b = M.band();
    this.bandEl.hidden = !b;
    if (b) { this.bandEl.style.left = `${((b[0] / M.total) * 100).toFixed(3)}%`; this.bandEl.style.width = `${(Math.max(0.004, (b[1] - b[0]) / M.total) * 100).toFixed(3)}%`; }
  }

  /** the knob, the played line and the warm bars, all from one fraction: transforms and a clip, no layout */
  private paint() {
    const T = this.m.total, f = T > 0 ? Math.min(1, Math.max(0, this.view / T)) : 0, key = Math.round(f * 1e5);
    if (key === this.lastF) return;
    this.lastF = key;
    this.pos.style.transform = `translateX(${(f * 100).toFixed(3)}%)`;     // (the wrapper is as wide as the track)
    this.done.style.transform = `scaleX(${f.toFixed(5)})`;
    this.lit.style.clipPath = `inset(0 ${(100 - f * 100).toFixed(3)}% 0 0)`;
  }

  /** what a screen reader says of the knob: every second while it plays, but a focused one only when the commenter changes */
  private aria(force: boolean) {
    const t = this.view, a = this.m.aria(t), s = a.now, k = this.m.at(t);
    if (!force && (s === this.ariaS || (k === this.ariaK && document.activeElement === this.knob))) return;
    this.ariaS = s; this.ariaK = k;
    this.knob.setAttribute('aria-valuenow', String(s));
    this.knob.setAttribute('aria-valuetext', a.text);
  }

  /** the card: the moment under the pointer, or under the knob when nobody is pointing */
  private say() {
    if (!this.usable) return;
    const M = this.m, { left, width, vw, m0, m1, card } = this.box;
    const f = this.cursor === null ? this.view / M.total : Math.min(1, Math.max(0, (this.cursor - left) / width)), t = f * M.total;
    const c = M.card(t), k = c.k;
    // (placed here rather than by CSS clamp(): the same in every engine, and nothing is measured)
    const x = Math.round((left + f * width) * 10) / 10;
    if (x !== this.lastX) {
      this.lastX = x;
      this.guide.style.transform = `translateX(${x}px)`;
      this.card.style.transform = `translateX(${Math.round(Math.min(Math.max(x - card / 2, m0), vw - card - m1) * 10) / 10}px)`;
    }
    if (this.whenT.textContent !== c.when) this.whenT.textContent = c.when;
    if (this.whenN.textContent !== c.around) this.whenN.textContent = c.around;
    if (k !== this.cardK) {                                             // a new commenter: their name now, their words when they are known
      this.cardK = k; this.said = null; this.tries = 0;
      this.by.textContent = c.by; this.words.textContent = ''; this.words.classList.remove('in');
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

  private tAt(x: number) { return Math.min(1, Math.max(0, (x - this.box.left) / this.box.width)) * this.m.total; }
  private scrub(t: number) { if (t !== this.lastScrub) { this.lastScrub = t; this.host.onScrub(t, this.m.at(t)); } }

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
    if (this.el.dataset.card && Math.abs(e.clientX - this.offX) >= SLOP) delete this.el.dataset.card;
    this.lastX0 = e.clientX;
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
    if (seek) { this.el.dataset.card = 'off'; this.offX = this.lastX0; }   // (the caption now says who: the card comes back when the pointer moves on)
    if (seek) this.seek(this.m.at(this.view));
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
    delete this.el.dataset.card;
    const M = this.m, step = STEPS.get(e.key);
    let to: number;
    if (step) {
      to = M.step(this.view, e.shiftKey && Math.abs(step) === 1 ? step * 10 : step);
      // no next comment after the last, no previous before the first: a key with nowhere to go changes nothing (stepFrom
      // clamps to the comment you are in, which would restart it)
      if (step > 0 ? to <= this.view : to >= this.view) { e.preventDefault(); return; }
    }
    else if (e.key === 'Home') to = M.home();
    else if (e.key === 'End') to = M.end();
    else return;      // Space, Esc, N, R, M are the app's, heard at the window: never touched here
    e.preventDefault();
    this.cursor = null; this.view = to;
    this.set(FOCUS, true); this.paint(); this.aria(true); this.say();
    this.host.onScrub(to, M.at(to));
    clearTimeout(this.tKey);
    this.tKey = window.setTimeout(() => { this.tKey = 0; this.seek(this.m.at(this.view)); }, SETTLE);
  };

  /** play from comment k: the knob goes to its start, and the host's time is not heard for a moment while it gets there */
  private seek(k: number) {
    if (k < 0 || k >= this.m.count) return;
    const x = this.m.start(k);
    this.view = this.t = x;
    this.paint(); this.aria(true);
    this.hold = performance.now() + HOLD;
    this.host.onSeek(x, k);
  }

  /** a line under the card's words (the floor's rule about leaving, the first time it shows), or nothing */
  note(text: string | null) { this.noteEl.textContent = text ?? ''; this.el.classList.toggle('tl-noted', !!text); }

  private reset() {
    if (this.drag) this.release(false, false);                          // (the host hears the drag end, and nothing is sought)
    clearTimeout(this.tGlance); clearTimeout(this.tLeave); clearTimeout(this.tLinger); clearTimeout(this.tKey); clearTimeout(this.tPeek);
    this.tKey = 0;
    cancelAnimationFrame(this.raf);
    if (this.pid >= 0) { try { this.hit.releasePointerCapture(this.pid); } catch { /* not held */ } }   // (a finger still down on a timeline that went away)
    this.raf = 0; this.pid = -1; this.open = 0; this.cursor = null; this.hold = 0; this.cardK = -1; this.lastF = -1; this.lastX = -1; this.downs.clear();
    delete this.el.dataset.held;
  }
}
