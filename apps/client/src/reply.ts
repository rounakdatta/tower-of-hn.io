// Replying, by voice. Walk up to someone (or sit at their table), say what you want to say back, read it, fix it,
// and post it to Hacker News as yourself. Loaded the first time you reply (it isn't part of the page's first load).
//
// Your words stay yours: your browser turns speech into text (its own recognition; we never get the audio), nothing
// rewrites them (HN asks for human comments: only a capital where a sentence starts), and nothing is posted until you
// press reply on Hacker News's own page. How it posts:
//   - without the extension (any phone, any browser): a hand-off. Your words are copied, HN's own reply page opens for
//     that comment, you paste and press reply there (signing in first, on HN, if it asks). We never see a password.
//   - with the Tower of HN companion extension (desktop): from your browser, with your own Hacker News session, after
//     the extension's own confirmation window.
// Either way the sheet then watches HN's public API for your reply under that comment, and says when it's there.
//
// Nothing you write is lost: a draft per comment is kept in this browser (a week, the latest 20), through closing the
// sheet, a reload, or a phone dropping the tab while you're on HN; a hand-off survives a reload too.
import { esc } from './util.ts';
import { you } from './you.ts';
import { hnHtml, hnPlain, asPosted, yours } from './hnformat.ts';
import { heard, join, type Result } from './dictation.ts';
import './reply.css';

export interface ReplyTarget { id: number; by: string; story: number; title: string }
/** your reply, seen on Hacker News */
export interface Landed { id: number; parent: number; to: string; by: string; dead: boolean; delayed: boolean }

type Rec = { start(): void; stop(): void; abort(): void; continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<Result> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null };
type Item = { id: number; by?: string; text?: string; time?: number; kids?: number[]; dead?: boolean; deleted?: boolean } | null;
type Handoff = { id: number; story: number; by: string; text: string; at: number; kids: number[] | null };

const ua = navigator.userAgent;
// (iOS has no speech recognition in a home-screen web app, though the constructor is there: typing there)
const standaloneIOS = (/iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1))
  && (matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
const SR = standaloneIOS ? undefined : (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;
/** whose service turns your voice into text: the browser's own (every iPhone browser is Safari underneath) */
const EAR = /iP(hone|ad|od)/.test(ua) || (/Safari\//.test(ua) && !/Chrom|Edg\//.test(ua)) ? 'Apple' : /Edg\//.test(ua) ? 'Microsoft' : 'Google';
const TOUCH = matchMedia('(hover: none)').matches, ANDROID = /Android/.test(ua);
const tap = TOUCH ? 'tap' : 'click', Tap = TOUCH ? 'Tap' : 'Click';
const API = 'https://hacker-news.firebaseio.com/v0', SITE = 'https://news.ycombinator.com';
const DRAFTS = 'tohn-drafts', HANDOFF = 'tohn-handoff', WEEK = 7 * 86_400_000;
const WATCH_MS = 600_000, EVERY_MS = 5000;
const X = '<button class="x" type="button" aria-label="Close">×</button>';
const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12z" fill="currentColor"/></svg>';
/** text HN will format (italics, code, links, paragraphs): worth a preview */
const FORMATTED = /\*|https?:\/\/|\n[ \t]*\n|(^|\n) {2,}\S/;

const item = (id: number): Promise<Item> => fetch(`${API}/item/${id}.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
const replyUrl = (h: { id: number; story: number }) => `${SITE}/reply?id=${h.id}&goto=${encodeURIComponent(`item?id=${h.story}#${h.id}`)}`;
const store = {
  get<T>(k: string, or: T): T { try { return JSON.parse(localStorage.getItem(k) ?? 'null') ?? or; } catch { return or; } },
  set(k: string, v: unknown) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode, or full */ } },
};

/** Drafts, one per comment you're answering: in this browser only, for a week, the latest 20. */
export const drafts = {
  get(id: number): string {
    const d = store.get<Record<string, { text: string; at: number }>>(DRAFTS, {})[id];
    return d && Date.now() - d.at < WEEK ? d.text : '';
  },
  put(id: number, text: string) {
    const all = store.get<Record<string, { text: string; at: number }>>(DRAFTS, {}), now = Date.now();
    if (text.trim()) all[id] = { text, at: now }; else delete all[id];
    store.set(DRAFTS, Object.fromEntries(Object.entries(all).filter(([, d]) => now - d.at < WEEK).sort((a, b) => b[1].at - a[1].at).slice(0, 20)));
  },
};

/**
 * After a hand-off: is your reply on Hacker News yet? The comment's new answers (the ones it didn't have when you
 * opened the sheet), matched to you. Asked of HN's public API every few seconds while this page is visible (not while
 * you're on HN's tab), for ten minutes. It outlives the sheet, and a reload (the hand-off is kept in this browser).
 */
class Watch {
  h: Handoff | null = null;
  private checked = new Set<number>();
  private timer = 0;
  private busy = false;
  onFound: (l: Landed) => void = () => {};
  onGiveUp: (h: Handoff) => void = () => {};

  constructor() { addEventListener('visibilitychange', () => { if (!document.hidden && this.h) this.look(); }); }
  start(h: Handoff) {
    this.h = h; this.checked.clear();
    store.set(HANDOFF, h);
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.look(), EVERY_MS);
  }
  stop() { this.h = null; clearTimeout(this.timer); store.set(HANDOFF, null); }
  private async look() {
    const h = this.h;
    if (!h || this.busy) return;
    clearTimeout(this.timer);
    if (Date.now() - h.at > WATCH_MS) { this.stop(); this.onGiveUp(h); return; }
    if (!document.hidden) {
      this.busy = true;
      try {
        const p = await item(h.id);
        if (!p) throw new Error('no answer');                              // HN's API is down: next time
        for (const k of (p.kids ?? []).filter((x) => !h.kids?.includes(x) && !this.checked.has(x)).slice(0, 20)) {
          const c = await item(k);
          if (!c || c.deleted) { this.checked.add(k); continue; }
          // (no list of the answers from before you sent it on: only one written since then can be yours)
          if (!h.kids && (c.time ?? 0) < h.at / 1000 - 120) { this.checked.add(k); continue; }
          const how = yours(c, h.text, you.me);
          if (!how) { if (c.text && c.text !== '[delayed]') this.checked.add(k); continue; }   // (a held one: look again)
          if (how !== 'name' && c.by && asPosted(h.text).split(' ').length >= 5) you.set(c.by);   // that's you, then
          if (this.h !== h) return;
          this.stop();
          this.onFound({ id: k, parent: h.id, to: h.by, by: c.by ?? '', dead: !!c.dead, delayed: c.text === '[delayed]' });
          return;
        }
      } catch { /* offline, or HN's API is slow: next time */ } finally { this.busy = false; }
    }
    if (this.h === h) this.timer = window.setTimeout(() => this.look(), EVERY_MS);
  }
}
const watch = new Watch();

// ---------------------------------------------------------------- the sheet
export class Reply {
  private el: HTMLElement;
  private rec: Rec | null = null;
  private listening = false;
  private target: ReplyTarget | null = null;
  private base = '';                                     // the text before this round of listening
  private kids: number[] | null = null;                  // the answers that comment had when you opened the sheet
  private back: Element | null = null;                   // where the keyboard goes back to on close
  private failed = '';                                   // a microphone problem being shown (until you try again)
  private shut = '';                                     // why HN won't take a reply to this comment
  private saveTimer = 0;
  private hushTimer = 0;
  private extTimer = 0;
  private busy = false;
  private composing = false;
  /** the room goes quiet while you speak (so the microphone hears you, not the toys), and back after */
  onListen: (on: boolean) => void = () => {};
  onOpen: (on: boolean) => void = () => {};
  /** your reply is on Hacker News: the sheet says so itself while it's open on that comment */
  onLanded: (l: Landed) => void = () => {};
  /** the words of the comment being answered, as soon as the room has them (from its voicing) */
  said: (id: number, text: string) => void = () => {};

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'reply';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-labelledby', 'reply-to');
    document.body.appendChild(this.el);
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.escape(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && this.composing) { e.preventDefault(); this.post(); }
    });
    // the extension answers a post with its parent (and only for the comment it was asked about)
    addEventListener('message', (e) => {
      if (e.source !== window || !e.data || typeof e.data !== 'object' || e.data.tohn !== 'posted') return;
      if (this.target && e.data.parent === this.target.id && this.busy) this.extAnswer(!!e.data.ok, String(e.data.error ?? ''));
    });
    const keep = () => this.saveNow();
    addEventListener('pagehide', keep);
    addEventListener('visibilitychange', () => { if (document.hidden) keep(); });
    watch.onFound = (l) => {
      drafts.put(l.parent, '');
      if (this.target?.id === l.parent) this.posted(l);
      this.onLanded(l);
    };
    watch.onGiveUp = (h) => { if (this.target?.id === h.id && !this.composing) this.notYet(); };
  }

  get open() { return !!this.target; }
  get to() { return this.target; }

  /** Back after a reload with a reply handed to HN: keep watching for it (no sheet; a note when it's there). */
  resume() { const h = store.get<Handoff | null>(HANDOFF, null); if (h && Date.now() - h.at < WATCH_MS) watch.start(h); }

  /** Open the sheet to answer comment `t`: your draft for it, if there is one; their words, to show what you're
   *  answering (the room's first, then HN's own). */
  show(t: ReplyTarget) {
    if (this.target) this.saveNow();                     // (the last few keys, before anything changes)
    this.cut();
    if (!this.target) this.back = document.activeElement;
    this.target = t; this.kids = null; this.failed = ''; this.shut = ''; this.busy = false;
    clearTimeout(this.extTimer);
    this.onOpen(true);
    const h = watch.h;
    if (h && h.id === t.id) this.handed(h, null);
    else { const d = drafts.get(t.id); this.render(d, d ? 'draft' : ''); }
    this.el.classList.add('show');
    visualViewport?.addEventListener('resize', this.fit);
    visualViewport?.addEventListener('scroll', this.fit);
    this.fit();
    let real = false;
    this.said = (id, text) => { if (!real && this.target?.id === id) this.quote(text); };
    item(t.id).then((it) => {
      if (this.target?.id !== t.id || !it) return;
      this.kids = it.kids ?? [];
      if (it.text) { real = true; this.quote(hnPlain(it.text)); }
      if (it.deleted) this.closed('That comment was deleted: Hacker News takes no replies to it. Your words are kept here.');
    }).catch(() => {});
    // HN's FAQ: "Threads are closed to new comments after two weeks, or if the submission has been killed"
    item(t.story).then((s) => {
      if (this.target?.id === t.id && s && (s.dead || s.deleted || Date.now() / 1000 - (s.time ?? Infinity) > 14 * 86400)) {
        this.closed('This thread is closed: Hacker News takes no new comments after two weeks, or on a killed story. Your words are kept here.');
      }
    }).catch(() => {});
  }
  /** the comment can't be answered on HN: say why, before you write (or keep what you wrote) */
  private closed(why: string) {
    if (!this.composing) return;
    this.shut = why;
    this.state(why, 'error');
    const post = this.$<HTMLButtonElement>('.post');
    if (post) { post.disabled = true; post.dataset.closed = '1'; }
  }
  private quote(text: string) {
    const q = this.el.querySelector('.quote');
    if (q) q.textContent = `“${text.slice(0, 260)}${text.length > 260 ? '…' : ''}”`;
  }

  close() {
    this.cut();
    this.saveNow();
    this.target = null;
    this.composing = false;
    this.el.classList.remove('show', 'kb');
    visualViewport?.removeEventListener('resize', this.fit);
    visualViewport?.removeEventListener('scroll', this.fit);
    this.onOpen(false);
    const b = this.back as HTMLElement | null;
    this.back = null;
    if (b?.isConnected && typeof b.focus === 'function' && b !== document.body) b.focus({ preventScroll: true });
  }
  /** Esc: stop listening first; then close (your draft stays) */
  escape() { if (this.listening) this.hush(); else this.close(); }

  /** The sheet sits above a phone's keyboard, and fits what's left of the screen. */
  private fit = () => {
    const v = visualViewport;
    if (!v) return;
    const kb = Math.abs(v.scale - 1) > 0.01 ? 0 : Math.max(0, Math.round(innerHeight - v.height - v.offsetTop));
    this.el.style.setProperty('--kb', `${kb}px`);
    this.el.style.setProperty('--vh', `${Math.round(v.height)}px`);
    this.el.classList.toggle('kb', kb > 80);
  };

  private $<T extends HTMLElement>(s: string) { return this.el.querySelector(s) as T | null; }
  private text() { return this.$<HTMLTextAreaElement>('textarea')?.value ?? ''; }
  private state(s: string, kind: '' | 'error' | 'wait' = '') {
    const el = this.$('.state');
    if (!el) return;
    el.textContent = s;
    el.className = `state ${kind}`.trim();
  }
  private idle() {
    if (this.shut) return this.shut;
    if (this.failed) return this.failed;
    if (!SR) return standaloneIOS ? 'No dictation in a home-screen app: type, or use your keyboard’s mic' : 'This browser can’t take dictation: type, or use your keyboard’s mic';
    return this.text().trim() ? `Read it over, then send it (or ${tap} the mic to add more)` : `${Tap} to speak`;
  }

  /** writing: the microphone, the box (yours to edit), and the one button that sends it on */
  private render(text: string, why: '' | 'draft' = '') {
    const t = this.target!;
    this.composing = true;
    const act = you.ext ? 'Post to Hacker News' : 'Continue on Hacker News ↗';
    const how = you.ext
      ? 'Posts as you, with your own Hacker News session (the Tower of HN extension): we never see your password.'
      : 'Copies your words and opens that comment on Hacker News: paste, then press reply.';
    this.el.innerHTML = `${X}
      <div class="to" id="reply-to" tabindex="-1">Reply to <b>${esc(t.by)}</b>${you.me ? ` <button class="as" type="button" title="Not you? Change or forget it">as ${esc(you.me)}</button>` : ''}</div>
      <p class="quote">…</p>
      ${SR ? `<button class="mic" type="button" aria-pressed="false" aria-label="Speak your reply"><span class="ring"></span>${MIC}</button>` : ''}
      <div class="state" role="status"></div>
      <textarea rows="4" aria-label="Your reply to ${esc(t.by)}" placeholder="${SR ? 'Your words appear here, and you can fix them' : 'Your reply'}">${esc(text)}</textarea>
      <div class="foot"><button class="peek" type="button" aria-pressed="false" hidden>Preview</button></div>
      <div class="preview" hidden></div>
      <button class="post" type="button" aria-keyshortcuts="Meta+Enter Control+Enter" ${text.trim() && !this.shut ? '' : 'disabled'}${this.shut ? ' data-closed="1"' : ''}>${act}${TOUCH ? '' : ' <kbd aria-hidden="true">⌘↩</kbd>'}</button>
      <p class="how">${how} Your words, exactly: nothing rewrites them.${SR ? ` Speech becomes text in your browser, by ${EAR}’s service: we never get your voice.` : ''}</p>`;
    if (!TOUCH && !/Mac/.test(navigator.platform)) { const k = this.$('.post kbd'); if (k) k.textContent = 'Ctrl ↩'; }
    this.state(why === 'draft' ? `Your draft is back. ${this.idle()}` : this.idle());
    const ta = this.$<HTMLTextAreaElement>('textarea')!, post = this.$<HTMLButtonElement>('.post')!;
    const peek = this.$<HTMLButtonElement>('.peek')!, pre = this.$('.preview')!;
    this.$('.x')!.onclick = () => this.close();
    ta.oninput = () => {
      if (this.listening) this.cut();                    // typing takes over from the microphone
      this.base = ta.value;
      this.changed();
    };
    peek.hidden = !FORMATTED.test(text);
    peek.onclick = () => {
      const on = pre.hidden;
      if (on) this.cut();
      if (on) pre.innerHTML = hnHtml(this.text()) || '<p class="none">Nothing yet</p>';
      pre.hidden = !on; ta.hidden = on;
      peek.textContent = on ? 'Edit' : 'Preview';
      peek.setAttribute('aria-pressed', String(on));
      if (!on) ta.focus({ preventScroll: true });
    };
    post.onclick = () => this.post();
    const as = this.$<HTMLButtonElement>('.as');
    if (as) as.onclick = () => this.rename(as);
    const mic = this.$<HTMLButtonElement>('.mic');
    if (mic) mic.onclick = () => (this.listening ? this.hush() : this.listen());
    // at a desk, the keyboard lands on the microphone (Enter talks); a phone keeps its keyboard down until you type
    // (its focus goes to the heading, which tells a screen reader where it is)
    (TOUCH ? this.$('#reply-to') : mic ?? ta)?.focus({ preventScroll: true });
  }
  /** "as alice": not you? change it, or empty it to forget (it lives in this browser only) */
  private rename(as: HTMLElement) {
    as.outerHTML = `<span class="me"><label for="hn-me">as</label><input id="hn-me" type="text" value="${esc(you.me)}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="hn-me-why"><span id="hn-me-why" hidden>Your Hacker News username, kept in this browser only. Empty it to forget it.</span></span>`;
    const f = this.$<HTMLInputElement>('#hn-me')!;
    f.onchange = () => you.set(f.value);
    f.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); you.set(f.value); this.$<HTMLTextAreaElement>('textarea')?.focus(); } };
    f.focus(); f.select();
  }
  /** the box changed (you, or the microphone): the button, the preview, and the draft keep up */
  private changed() {
    const ta = this.$<HTMLTextAreaElement>('textarea'), post = this.$<HTMLButtonElement>('.post'), peek = this.$<HTMLButtonElement>('.peek');
    if (!ta || !post) return;
    if (!this.busy) post.disabled = !ta.value.trim() || post.dataset.closed === '1';
    if (peek && peek.hidden === FORMATTED.test(ta.value)) peek.hidden = !peek.hidden;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 400);
  }
  private saveNow() {
    clearTimeout(this.saveTimer);
    if (this.target && this.composing) drafts.put(this.target.id, this.text());
  }

  /** Start hearing you: what you say goes into the box, live, after what's there; tap again (or pause) to stop. */
  private listen() {
    if (!SR || this.rec) return;
    const ta = this.$<HTMLTextAreaElement>('textarea')!;
    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
    this.base = ta.value;
    this.failed = '';
    rec.onresult = (e) => {
      if (this.rec !== rec) return;                      // (cut off: you typed, or closed the sheet)
      ta.value = join(this.base, heard(e.results, ANDROID));
      this.changed();
    };
    rec.onerror = (e) => { if (this.rec === rec) this.fail(e.error); };
    rec.onend = () => { if (this.rec === rec) this.done(); };
    this.rec = rec;
    try { rec.start(); } catch { this.rec = null; this.fail('start'); return; }
    this.listening = true;
    this.el.classList.add('listening');
    const mic = this.$('.mic');
    mic?.setAttribute('aria-pressed', 'true'); mic?.setAttribute('aria-label', 'Stop listening');
    this.state(`Listening… ${tap} when you’re done`);
    this.onListen(true);
  }
  /** you're done: the words still on their way finish this round (the end of the session closes it) */
  private hush() {
    const rec = this.rec;
    if (!rec) return;
    try { rec.stop(); } catch { /* already over */ }
    clearTimeout(this.hushTimer);
    this.hushTimer = window.setTimeout(() => { if (this.rec === rec) this.cut(); }, 3000);   // (it never said it ended)
  }
  /** stop at once, and drop whatever is still on its way (you started typing, or closed the sheet) */
  private cut() {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    try { rec.abort(); } catch { /* already over */ }
    this.done();
  }
  private done() {
    clearTimeout(this.hushTimer);
    this.rec = null;
    if (!this.listening) return;
    this.listening = false;
    this.el.classList.remove('listening');
    const mic = this.$('.mic');
    mic?.setAttribute('aria-pressed', 'false'); mic?.setAttribute('aria-label', 'Speak your reply');
    this.base = this.text();
    this.state(this.idle(), this.failed || this.shut ? 'error' : '');
    this.saveNow();
    this.onListen(false);
  }
  /** a microphone problem, in words, with a way on (it stays until you try again) */
  private fail(code: string) {
    const lang = navigator.language || 'your language';
    const say: Record<string, string> = {
      'not-allowed': 'The microphone is blocked for this site: allow it in your browser’s site settings, or type',
      'service-not-allowed': 'Dictation is off on this device (on iPhone it needs Siri): type, or use your keyboard’s mic',
      'audio-capture': 'No microphone found: type your reply',
      'network': `Dictation needs a connection: type, or ${tap} to try again`,
      'language-not-supported': `Dictation doesn’t know ${lang} here: type your reply`,
      'no-speech': `Didn’t catch that: ${tap} to try again`,
      'aborted': '',
    };
    this.failed = say[code] ?? `Couldn’t hear you: ${tap} to try again`;
    if (this.failed) this.state(this.failed, 'error');
    if (!this.listening) this.state(this.idle(), this.failed || this.shut ? 'error' : '');
  }

  /** Send it on: through the extension (your own session), or handed to HN's own reply page. */
  private post() {
    const t = this.target, text = this.text().trim();
    if (!t || !text || this.busy || !this.composing) return;
    this.cut();
    this.saveNow();
    const post = this.$<HTMLButtonElement>('.post')!;
    if (!navigator.onLine) { this.state('You’re offline. Your reply is kept here: send it when you’re back', 'error'); return; }
    this.busy = true; post.disabled = true;               // (one tap, one tab)
    const h: Handoff = { id: t.id, story: t.story, by: t.by, text, at: Date.now(), kids: this.kids };
    if (you.ext) {
      this.state('Confirm it in the extension’s window…', 'wait');
      window.postMessage({ tohn: 'post', parent: t.id, story: t.story, text }, location.origin);   // answered with its parent
      this.extTimer = window.setTimeout(() => this.extAnswer(false, 'No answer from the extension'), 120_000);
      return;
    }
    // the hand-off: copy, and open HN's own reply form for that comment (a new tab, from this tap)
    const ta = this.$<HTMLTextAreaElement>('textarea');
    const copied = copy(text, ta);
    window.open(replyUrl(h), '_blank', 'noopener');
    watch.start(h);
    if (!h.kids) item(h.id).then((p) => { if (p && !h.kids) { h.kids = p.kids ?? []; if (watch.h === h) watch.start(h); } }).catch(() => {});
    copied.then((ok) => { if (this.target?.id === t.id && this.busy) this.handed(h, ok); });
  }
  private extAnswer(ok: boolean, error: string) {
    clearTimeout(this.extTimer);
    const t = this.target;
    if (!t || !this.busy) return;
    this.busy = false;
    if (ok) { this.composing = false; this.state('Posted. Finding it on Hacker News…', 'wait'); watch.start({ id: t.id, story: t.story, by: t.by, text: this.text().trim(), at: Date.now(), kids: this.kids }); return; }
    this.changed();
    this.state(`${error || 'Hacker News didn’t take it'}. Your words are still here.`, 'error');
    const how = this.$('.how');
    if (how) { how.innerHTML = `Or <a href="${replyUrl(t)}" target="_blank" rel="noopener">post it on Hacker News’s own page ↗</a> (copy it first).`; }
  }
  /** Over to HN: the words stay here (a copy can fail, or be overwritten while signing in), with ways to copy them
   *  again, reopen HN, or go back and edit; meanwhile it watches for your reply. */
  private handed(h: Handoff, copied: boolean | null) {
    this.composing = false; this.busy = false;
    this.el.innerHTML = `${X}
      <div class="to" id="reply-to">Over to Hacker News</div>
      <p class="said">${copied ? 'Your words are copied.' : copied === null ? 'Your words are below.' : 'Copy your words below.'} In the page that opened, paste them and press <b>reply</b> (sign in there first if HN asks).</p>
      <textarea rows="3" readonly aria-label="Your reply">${esc(h.text)}</textarea>
      <p class="again"><button class="copy" type="button">Copy again</button><a href="${replyUrl(h)}" target="_blank" rel="noopener">Open it again ↗</a><button class="edit" type="button">Edit</button></p>
      <div class="state wait" role="status">Watching for your reply on Hacker News…</div>`;
    this.$('.x')!.onclick = () => this.close();
    const ta = this.$<HTMLTextAreaElement>('textarea')!, c = this.$<HTMLButtonElement>('.copy')!;
    c.onclick = () => copy(h.text, ta).then((ok) => { c.textContent = ok ? 'Copied' : 'Select it and copy'; if (!ok) ta.select(); });
    this.$<HTMLButtonElement>('.edit')!.onclick = () => { watch.stop(); this.render(drafts.get(h.id) || h.text); this.$<HTMLTextAreaElement>('textarea')?.focus(); };
    if (!TOUCH) c.focus({ preventScroll: true });
  }
  private notYet() {
    this.state('Not seen on Hacker News yet (its API can lag). If HN showed an error, your words are still here.', 'error');
  }
  /** It's there: where to see it, and HN's own rules for changing it */
  private posted(l: Landed) {
    this.composing = false; this.busy = false;
    const what = l.dead ? `It’s on Hacker News${l.by ? ` as <b>${esc(l.by)}</b>` : ''}, but HN marked it [dead], so others don’t see it.`
      : l.delayed ? 'It’s on Hacker News, held for a few minutes before others see it (HN shows it as [delayed]).'
      : `It’s on Hacker News${l.by ? ` as <b>${esc(l.by)}</b>` : ''}.${you.me ? ' In a minute or two you walk in by the lift and say it.' : ''}`;
    this.el.innerHTML = `${X}
      <div class="to" id="reply-to">Posted</div>
      <p class="said">${what}</p>
      <a class="post" href="${SITE}/item?id=${l.id}" target="_blank" rel="noopener">See it on Hacker News ↗</a>
      <p class="how">HN lets you edit or delete it there for two hours.${you.me ? ` Your HN name is kept in this browser only, to bring your replies and the answers to them here. <button class="forget" type="button">Forget it</button>` : ''}</p>`;
    this.$('.x')!.onclick = () => this.close();
    const f = this.$<HTMLButtonElement>('.forget');
    if (f) f.onclick = () => { you.set(''); f.parentElement!.textContent = 'HN lets you edit or delete it there for two hours. Forgotten.'; };
    this.$<HTMLElement>('.post')?.focus({ preventScroll: true });
  }
}

/** Your words onto the clipboard: within the tap (iOS asks for that), and the old way where there's no clipboard API */
function copy(text: string, ta: HTMLTextAreaElement | null): Promise<boolean> {
  const legacy = () => {
    if (!ta) return false;
    const [a, b] = [ta.selectionStart, ta.selectionEnd];
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
    ta.setSelectionRange(a, b);
    return ok;
  };
  if (!navigator.clipboard?.writeText) return Promise.resolve(legacy());
  return Promise.race([navigator.clipboard.writeText(text).then(() => true, legacy), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
}
