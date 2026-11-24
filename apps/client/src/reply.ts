// Replying, by voice. Walk up to someone (or sit at their table), say what you want to say back, read it, fix it,
// and post it to Hacker News as yourself.
//
// Your words stay yours: your browser turns speech into text (its own recognition, nothing on our server), nothing
// rewrites them (HN asks for human comments), and nothing is posted until you press Post. How it posts:
//   - with the Tower of HN companion extension (desktop): straight from your browser, with your own Hacker News
//     session; we never see your password or your cookie;
//   - without it (any phone, any browser): a hand-off. The text is copied, HN's own reply page opens for that
//     comment, you paste and press reply there.
// And when someone answers you, you hear it: a reply to one of your comments on the floor you're on is said next at
// its table and brought to your ears; one anywhere else on the tower gets a note that takes you there.
import { esc } from './util.ts';

export interface ReplyTarget { id: number; by: string; story: number; title: string }

type Rec = { start(): void; stop(): void; abort(): void; continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null };
// (iOS has no speech recognition in a home-screen web app, though the constructor is there: typing there)
const standaloneIOS = (/iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))
  && (matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
const SR = standaloneIOS ? undefined : (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;
const HN = 'https://hacker-news.firebaseio.com/v0';

/** HN's HTML (paragraphs, links, entities) as plain text: parsed in an inert document (nothing in it can run) */
function plain(html: string) {
  const doc = new DOMParser().parseFromString(html.replace(/<p>/gi, '\n\n'), 'text/html');
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

export class Reply {
  /** your Hacker News username (kept in this browser only): to find replies to you, and to know your reply landed */
  me = localStorage.getItem('tohn-me') ?? '';
  /** the companion extension answered (it posts with your own HN session) */
  private ext = false;
  private el: HTMLElement;
  private rec: Rec | null = null;
  private listening = false;
  private target: ReplyTarget | null = null;
  private base = '';                                     // the text before this round of listening
  /** the room goes quiet while you speak (so the microphone hears you, not the toys), and back after */
  onListen: (on: boolean) => void = () => {};
  onOpen: (on: boolean) => void = () => {};

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'reply';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Reply');
    document.body.appendChild(this.el);
    // a companion extension says hello through the page (its content script listens on our origin)
    addEventListener('message', (e) => {
      if (e.source !== window || !e.data || typeof e.data !== 'object') return;
      if (e.data.tohn === 'here') { this.ext = true; if (!this.me && typeof e.data.user === 'string' && e.data.user) this.setMe(e.data.user); }
      if (e.data.tohn === 'posted' && this.target && e.data.parent === this.target.id) this.posted(!!e.data.ok, String(e.data.error ?? ''));
    });
    window.postMessage({ tohn: 'hello' }, location.origin);
  }

  get open() { return !!this.target; }
  get to() { return this.target; }
  get canListen() { return !!SR; }

  setMe(name: string) {
    const n = name.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 15);
    this.me = n;
    if (n) localStorage.setItem('tohn-me', n); else localStorage.removeItem('tohn-me');
  }

  /** Open the sheet to answer comment `t`; their words are fetched to show what you're answering. */
  show(t: ReplyTarget) {
    this.stop();
    this.target = t;
    this.base = '';
    this.onOpen(true);
    this.render('');
    // what you're answering: the words the room already has at once, then HN's own text when it arrives
    let real = false;
    this.said = (id, text) => { if (!real && this.target?.id === id) this.quote(text); };
    fetch(`${HN}/item/${t.id}.json`).then((r) => r.json()).then((it: { text?: string } | null) => {
      if (this.target?.id !== t.id || !it?.text) return;
      real = true;
      this.quote(plain(it.text));
    }).catch(() => {});
  }
  /** the words of the comment being answered, as soon as the room has them (from its voicing) */
  said: (id: number, text: string) => void = () => {};
  private quote(text: string) {
    const q = this.el.querySelector('.their');
    if (q) q.textContent = `“${text.slice(0, 260)}${text.length > 260 ? '…' : ''}”`;
  }

  close() {
    this.stop();
    this.target = null;
    this.el.classList.remove('show');
    this.onOpen(false);
  }

  private text() { return (this.el.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? ''; }

  private render(text: string) {
    const t = this.target!, tap = matchMedia('(hover: none)').matches ? 'Tap' : 'Click';
    // honest about what the button does: with the extension it posts; without, it continues on HN's own page
    const act = this.ext ? 'Post to Hacker News' : 'Continue on Hacker News ↗';
    const how = this.ext
      ? `Posts as you, with your own Hacker News session (the Tower of HN extension). We never see your password.`
      : `Opens Hacker News on that comment with your words copied: paste, then press reply.`;
    const field = (label: string, ph: string) => `<div class="me"><label for="hn-me">${label}</label><input id="hn-me" type="text" value="${esc(this.me)}" placeholder="${ph}" autocomplete="username" spellcheck="false"></div>`;
    this.el.innerHTML = `<button class="x" type="button" aria-label="Close">×</button>
      <div class="to">Reply to <b>${esc(t.by)}</b>${this.me ? ` · <span class="as" role="button" tabindex="0" title="Change">as ${esc(this.me)}</span>` : ''}</div>
      <p class="their">…</p>
      ${SR ? `<button class="mic" type="button" aria-label="Speak your reply"><span class="ring"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12z" fill="currentColor"/></svg></button>
      <div class="state">${tap} to speak</div>` : `<div class="state">This browser can't hear you: type your reply</div>`}
      <textarea rows="4" placeholder="${SR ? 'Your words appear here, and you can fix them' : 'Your reply'}" maxlength="6000">${esc(text)}</textarea>
      <button class="post" type="button" ${text.trim() ? '' : 'disabled'}>${act}</button>
      ${this.me ? '' : field('Your HN username', 'so your reply can walk in here')}
      <p class="how">${how} Your words, exactly: nothing rewrites them.</p>`;
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    q('.x').onclick = () => this.close();
    const ta = q('textarea') as HTMLTextAreaElement, post = q('.post') as HTMLButtonElement;
    ta.oninput = () => { post.disabled = !ta.value.trim(); if (!this.listening) this.base = ta.value; };
    const me = this.el.querySelector('#hn-me') as HTMLInputElement | null;
    if (me) me.onchange = () => this.setMe(me.value);
    // "as you": tap to change the name (it opens the field in place)
    const as = this.el.querySelector('.as') as HTMLElement | null;
    if (as) as.onclick = () => { as.remove(); post.insertAdjacentHTML('afterend', field('Your HN username', 'so your reply can walk in here')); const f = this.el.querySelector('#hn-me') as HTMLInputElement; f.onchange = () => this.setMe(f.value); f.focus(); };
    post.onclick = () => this.post();
    const mic = this.el.querySelector('.mic') as HTMLElement | null;
    if (mic) mic.onclick = () => (this.listening ? this.stop() : this.listen());
    this.el.classList.add('show');
    // at a desk, the keyboard lands on the microphone (Enter talks); a phone keeps its keyboard down until you type
    if (matchMedia('(hover: hover)').matches) (mic ?? ta).focus({ preventScroll: true });
  }

  /** Start hearing you: what you say is added to the text, live; tap again (or pause) to stop. */
  private listen() {
    if (!SR || this.listening) return;
    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
    const ta = this.el.querySelector('textarea') as HTMLTextAreaElement;
    this.base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
    rec.onresult = (e) => {
      let fin = '', mid = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i], w = r[0].transcript;
        if (r.isFinal) fin += w; else mid += w;
      }
      ta.value = this.base + tidy(fin + mid);
      (this.el.querySelector('.post') as HTMLButtonElement).disabled = !ta.value.trim();
    };
    const tap = matchMedia('(hover: none)').matches ? 'tap' : 'click';
    rec.onerror = (e) => { this.state(e.error === 'not-allowed' ? 'The microphone is blocked for this site' : e.error === 'no-speech' ? `Didn’t catch that: ${tap} to try again` : `Couldn’t hear: ${tap} to try again`); };
    rec.onend = () => { if (this.rec === rec) this.stop(); };
    this.rec = rec;
    try { rec.start(); } catch { this.state('Couldn’t start the microphone'); return; }
    this.listening = true;
    this.el.classList.add('listening');
    this.state(`Listening… ${tap} when you’re done`);
    this.onListen(true);
  }

  private stop() {
    if (this.rec) { const r = this.rec; this.rec = null; try { r.stop(); } catch { /* done */ } }
    if (this.listening) {
      this.listening = false;
      this.el.classList.remove('listening');
      this.base = this.text();
      const tap = matchMedia('(hover: none)').matches ? 'tap' : 'click';
      this.state(this.text().trim() ? `Read it over, then send it (or ${tap} to add more)` : `${tap[0].toUpperCase() + tap.slice(1)} to speak`);
      this.onListen(false);
    }
  }

  private state(s: string) { const el = this.el.querySelector('.state'); if (el) el.textContent = s; }

  /** Post: through the extension (your own session), or hand it to HN's reply page. */
  private post() {
    const t = this.target, text = this.text().trim();
    if (!t || !text) return;
    this.stop();
    if (this.ext) {
      this.state('Posting…');
      (this.el.querySelector('.post') as HTMLButtonElement).disabled = true;
      window.postMessage({ tohn: 'post', parent: t.id, story: t.story, text }, location.origin);   // answered with its parent
      return;
    }
    // the hand-off: copy, then open HN's own reply form for that comment (a new tab, from this tap)
    const url = `https://news.ycombinator.com/reply?id=${t.id}&goto=${encodeURIComponent(`item?id=${t.story}#${t.id}`)}`;
    const copy = () => navigator.clipboard?.writeText ? navigator.clipboard.writeText(text).then(() => true, () => false) : Promise.resolve(false);
    copy().then((ok) => this.handed(url, text, ok));
    window.open(url, '_blank', 'noopener');
  }
  /** Over to HN: the words stay here (a copy can fail, or be overwritten by logging in), with a way to copy again,
   *  and a done state: back here, the app says it's watching for your reply. */
  private handed(url: string, text: string, copied: boolean) {
    this.el.innerHTML = `<button class="x" type="button" aria-label="Close">×</button>
      <div class="to">Over to Hacker News</div>
      <p class="their">${copied ? 'Your reply is on the clipboard.' : 'Copy your reply below.'} Paste it in the box that opened and press <b>reply</b> (log in first if HN asks).</p>
      <textarea rows="4" readonly>${esc(text)}</textarea>
      ${this.me ? '' : `<div class="me"><label for="hn-me">Posted as</label><input id="hn-me" type="text" placeholder="your HN username, so you can walk in and say it" autocomplete="username" spellcheck="false"></div>`}
      <button class="post done" type="button">Done, I posted it</button>
      <p class="how"><a class="copy" href="#">Copy it again</a> · <a href="${url}" target="_blank" rel="noopener">Open it again ↗</a></p>`;
    (this.el.querySelector('.x') as HTMLElement).onclick = () => this.close();
    const me = this.el.querySelector('#hn-me') as HTMLInputElement | null;
    if (me) me.onchange = () => this.setMe(me.value);
    (this.el.querySelector('.done') as HTMLElement).onclick = () => { if (me?.value) this.setMe(me.value); this.close(); this.onDone(); };
    const copy = this.el.querySelector('.copy') as HTMLAnchorElement, ta = this.el.querySelector('textarea') as HTMLTextAreaElement;
    copy.onclick = (e) => {
      e.preventDefault();
      const done = (ok: boolean) => { copy.textContent = ok ? 'Copied' : 'Select the text and copy it'; };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => { ta.select(); done(false); });
      else { ta.select(); done(document.execCommand?.('copy') ?? false); }
    };
  }
  /** you're back from HN, having posted */
  onDone: () => void = () => {};
  private posted(ok: boolean, error: string) {
    if (!ok) { this.state(error || 'Hacker News didn’t take it: try again, or post it there'); (this.el.querySelector('.post') as HTMLButtonElement).disabled = false; return; }
    this.el.innerHTML = `<button class="x" type="button" aria-label="Close">×</button><div class="to">Posted</div>
      <p class="their">It’s on Hacker News. When the room catches up, you’ll walk in and say it.</p>`;
    (this.el.querySelector('.x') as HTMLElement).onclick = () => this.close();
  }
}

/** speech into a sentence: a capital to start (no other changes: the words are yours) */
function tidy(s: string) {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t[0].toUpperCase() + t.slice(1);
}

/**
 * Replies to you, anywhere on Hacker News: your recent comments, checked every couple of minutes while the page is
 * open and visible, for answers that weren't there before. (The HN API answers browsers directly: nothing of yours
 * goes through our server.)
 */
export class Replies {
  private seen = new Set<number>();
  private primed = false;
  private timer = 0;
  onReply: (r: { id: number; by: string; parent: number; story?: number }) => void = () => {};

  private name = '';
  start(me: () => string) {
    clearInterval(this.timer);
    const tick = async () => {
      const name = me();
      if (!name || document.hidden) return;
      if (name !== this.name) { this.name = name; this.seen.clear(); this.primed = false; }
      try {
        const u = await (await fetch(`${HN}/user/${encodeURIComponent(name)}.json`)).json() as { submitted?: number[] } | null;
        const mine = (u?.submitted ?? []).slice(0, 25);
        const items = await Promise.all(mine.map((id) => fetch(`${HN}/item/${id}.json`).then((r) => r.json()).catch(() => null))) as ({ id: number; kids?: number[]; type?: string; parent?: number } | null)[];
        for (const it of items) {
          if (!it || it.type !== 'comment') continue;
          for (const k of it.kids ?? []) {
            if (this.seen.has(k)) continue;
            this.seen.add(k);
            if (!this.primed) continue;                 // the first look only learns what's there already
            const r = await (await fetch(`${HN}/item/${k}.json`)).json() as { by?: string; dead?: boolean; deleted?: boolean } | null;
            if (r?.by && !r.dead && !r.deleted && r.by !== name) this.onReply({ id: k, by: r.by, parent: it.id });
          }
        }
        this.primed = true;
      } catch { /* offline: next time */ }
    };
    tick();
    this.timer = window.setInterval(tick, 120_000);
  }
}
