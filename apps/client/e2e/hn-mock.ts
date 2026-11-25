// A local mock of Hacker News for tests: its login and reply pages (news.ycombinator.com) and its public API
// (hacker-news.firebaseio.com). Nothing here talks to the real HN: tests route both hosts here.
//
// Where the wording and markup come from (docs/POSTING.md, the QA notes): [V] read from HN itself or a capture of it;
// [I] inferred, from HN's open Arc source or maintained clients (weiran/Hackers, Harmonic, Hacki, Materialistic).
//   [V] "Unknown or expired link." as a bare body (Harmonic, captured 11 Oct 2026)
//   [V] the reply form: action="comment", hidden parent/goto/hmac, textarea "text" (live page, 22 Nov 2026)
//   [V] login form fields acct/pw/goto, cookie "user"; "Threads are closed to new comments after two weeks" (FAQ)
//   [I] "You have to be logged in to comment.", "Bad login.", "You're posting too fast. Please slow down. Thanks.",
//       "Please try again.", the commconfirm round (weiran/Hackers fixtures, modelled on live captures, Aug 2026)
//   [I] "Validation required. If this doesn't work, you can email hn@ycombinator.com." + g-recaptcha (Harmonic)
//   [I] "Sorry, we're not able to serve your requests this quickly." (HN's throttle page, from memory of it)
//   [I] a closed thread's reply page: the comment and no form; a too-long comment: no known limit (not modelled)
// The API text of a comment is HN's HTML: first paragraph bare, later ones after an unclosed <p>, and slashes and
// quotes as entities (as HN sends them).
import { hnHtml } from '../src/hnformat.ts';

export type Req = { method: string; url: string; headers: Record<string, string>; body?: string };
export type Res = { status: number; headers: Record<string, string>; body: string };
type Item = { id: number; type: 'story' | 'comment'; by?: string; time: number; text?: string; title?: string;
  parent?: number; kids: number[]; dead?: boolean; deleted?: boolean; at: number };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]!));
/** your text as HN's API returns it */
export function apiHtml(text: string) {
  return hnHtml(text).replace(/^<p>/, '').replace(/<\/p>/g, '').replace(/\//g, '&#x2F;').replace(/<&#x2F;/g, '</');
}
const page = (title: string, me: string, body: string) => `<html lang="en" op="${title === 'Add Comment' ? 'addcomment' : 'news'}"><head><meta name="referrer" content="origin"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} | Hacker News</title></head><body><center><table id="hnmain" border="0" cellpadding="0" cellspacing="0" width="85%" bgcolor="#f6f6ef"><tr><td bgcolor="#ff6600"><table border="0" cellpadding="0" cellspacing="0" width="100%" style="padding:2px"><tr><td style="line-height:12pt; height:10px;"><span class="pagetop"><b class="hnname"><a href="news">Hacker News</a></b></span></td><td style="text-align:right;padding-right:4px;"><span class="pagetop">${me ? `<a id="me" href="user?id=${me}">${me}</a> (1) | <a id="logout" rel="nofollow" href="logout?auth=0&amp;goto=news">logout</a>` : '<a href="login?goto=news">login</a>'}</span></td></tr></table></td></tr><tr id="pagespace" title="${title}" style="height:10px"></tr><tr><td>${body}</td></tr></table></center></body></html>`;
const loginPage = (msg: string, goto: string) => `<html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Login | Hacker News</title></head><body>${msg}<br><br><b>Login</b><br><br><form action="login" method="post"><input type="hidden" name="goto" value="${esc(goto)}"><table border="0"><tr><td>username:</td><td><input type="text" name="acct" size="20" autocorrect="off" spellcheck="false" autocapitalize="off" autofocus="true"></td></tr><tr><td>password:</td><td><input type="password" name="pw" size="20"></td></tr></table><br><input type="submit" value="login"></form><a href="forgot">Forgot your password?</a><br><br><b>Create Account</b><br><br><form action="login" method="post"><input type="hidden" name="goto" value="${esc(goto)}"><input type="hidden" name="creating" value="t"><table border="0"><tr><td>username:</td><td><input type="text" name="acct" size="20" autocorrect="off" spellcheck="false" autocapitalize="off"></td></tr><tr><td>password:</td><td><input type="password" name="pw" size="20"></td></tr></table><br><input type="submit" value="create account"></form></body></html>`;

export class HnMock {
  items = new Map<number, Item>();
  users = new Map<string, { pw: string; banned?: boolean; delay?: boolean }>([['alice', { pw: 'mock-only-pass' }], ['bob', { pw: 'x' }], ['carol', { pw: 'x' }], ['mallory', { pw: 'mock-only-pass', banned: true }], ['newbie', { pw: 'mock-only-pass', delay: true }]]);
  sessions = new Map<string, string>();                  // cookie token -> user
  private hmacs = new Map<string, { user: string; parent: number; at: number }>();
  private lastPost = new Map<string, number>();
  private msgs = new Map<string, string>();               // fnid -> a message page
  private seq = 0;
  /** every comment posted, in order (what the tests assert on) */
  posts: { user: string; parent: number; text: string; id: number }[] = [];
  /** every request, method and path only (no bodies, no cookies) */
  log: string[] = [];
  mode = { siteDown: false, apiDown: false, throttled: false, captchaLogin: false, confirmNext: false, slowMs: 0,
    tooFastMs: 0, hmacTtlMs: 1_800_000, apiLagMs: 0 };
  now = () => Date.now();

  constructor() {
    const t = Math.floor(this.now() / 1000);
    const add = (it: Omit<Item, 'kids' | 'at'> & { kids?: number[] }) => {
      this.items.set(it.id, { kids: [], at: 0, ...it });
      if (it.parent) this.items.get(it.parent)?.kids.push(it.id);
    };
    add({ id: 46100000, type: 'story', by: 'pg', time: t - 7200, title: 'Show HN: A tower you can walk into' });
    add({ id: 46100001, type: 'comment', by: 'bob', time: t - 5000, parent: 46100000, text: apiHtml('The borrow checker is the reason this compiles at all, not LLVM.\n\nSee https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html for why.') });
    add({ id: 46100002, type: 'comment', by: 'carol', time: t - 4000, parent: 46100001, text: apiHtml('I disagree: *LLVM* is why it is fast; the checker only says no.') });
    add({ id: 46100003, type: 'comment', time: t - 3000, parent: 46100000, deleted: true });
    add({ id: 46100004, type: 'comment', by: 'spammer', time: t - 2000, parent: 46100000, dead: true, text: apiHtml('Buy now') });
    add({ id: 46000000, type: 'story', by: 'pg', time: t - 15 * 86400, title: 'An old thread' });
    add({ id: 46000001, type: 'comment', by: 'dave', time: t - 15 * 86400, parent: 46000000, text: apiHtml('Two weeks ago, this was news.') });
  }

  /** sign `user` in (as if they had, on HN, earlier): returns the cookie value */
  signIn(user: string) { const tok = `${user}&${this.rand(24)}`; this.sessions.set(tok, user); return tok; }

  async handle(req: Req): Promise<Res> {
    const u = new URL(req.url);
    this.log.push(`${req.method} ${u.host}${u.pathname}`);
    if (this.mode.slowMs) await new Promise((r) => setTimeout(r, this.mode.slowMs));
    return u.host === 'hacker-news.firebaseio.com' ? this.api(u) : this.site(req, u);
  }

  // ---------------------------------------------------------------- the API
  private api(u: URL): Res {
    const json = (v: unknown, status = 200): Res => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-cache' }, body: JSON.stringify(v) });
    if (this.mode.apiDown) return json({ error: 'Service Unavailable' }, 503);
    let m = /^\/v0\/item\/(\d+)\.json$/.exec(u.pathname);
    if (m) {
      const it = this.items.get(Number(m[1]));
      if (!it || (it.at && this.now() - it.at < this.mode.apiLagMs)) return json(null);
      const kids = it.kids.filter((k) => { const c = this.items.get(k)!; return !c.at || this.now() - c.at >= this.mode.apiLagMs; });
      const { at: _at, kids: _k, ...rest } = it;
      if (it.deleted) return json({ deleted: true, id: it.id, parent: it.parent, time: it.time, type: it.type });
      return json({ ...rest, ...(kids.length ? { kids: [...kids].reverse() } : {}) });
    }
    m = /^\/v0\/user\/([A-Za-z0-9_-]+)\.json$/.exec(u.pathname);
    if (m) {
      const name = m[1];
      if (!this.users.has(name)) return json(null);
      const submitted = [...this.items.values()].filter((it) => it.by === name).map((it) => it.id).reverse();
      return json({ id: name, created: 1600000000, karma: 1, submitted });
    }
    return json(null, 404);
  }

  // ---------------------------------------------------------------- the site
  private site(req: Req, u: URL): Res {
    const html = (body: string, status = 200, headers: Record<string, string> = {}): Res => ({ status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', ...headers }, body });
    const go = (to: string, headers: Record<string, string> = {}): Res => ({ status: 302, headers: { location: to, ...headers }, body: '' });
    if (this.mode.siteDown) return html('<html><body>Sorry.</body></html>', 502);
    if (this.mode.throttled) return html("Sorry, we're not able to serve your requests this quickly.", 503);
    const me = this.me(req);
    const f = new URLSearchParams(req.method === 'POST' ? req.body ?? '' : u.search);
    const p = u.pathname;
    if (p === '/reply' && req.method === 'GET') {
      const id = Number(f.get('id')), goto = f.get('goto') ?? 'news', it = this.items.get(id);
      if (!it || it.deleted) return html('No such item.');
      if (!me) return html(loginPage('You have to be logged in to comment.', `reply?id=${id}&goto=${encodeURIComponent(goto)}`));
      return html(this.replyPage(it, me, goto));
    }
    if (p === '/login' && req.method === 'GET') return html(loginPage('', f.get('goto') ?? 'news'));
    if (p === '/login' && req.method === 'POST') {
      const acct = f.get('acct') ?? '', pw = f.get('pw') ?? '', goto = f.get('goto') ?? 'news', user = this.users.get(acct);
      if (this.mode.captchaLogin && !f.get('g-recaptcha-response')) {
        return html(`<html><body>Validation required. If this doesn't work, you can email <a href="mailto:hn@ycombinator.com">hn@ycombinator.com</a>.<br><br><form method="post" action="/login"><input type="hidden" name="acct" value="${esc(acct)}"><input type="hidden" name="pw" value="${esc(pw)}"><input type="hidden" name="goto" value="${esc(goto)}"><div class="g-recaptcha" data-sitekey="mock-site-key"></div><br><input type="submit" value="submit"></form></body></html>`);
      }
      if (!user || user.pw !== pw) return html(loginPage('Bad login.', goto));
      return go(goto, { 'set-cookie': `user=${this.signIn(acct)}; Path=/; Secure; HttpOnly; SameSite=Lax` });
    }
    if (p === '/comment' && req.method === 'POST') return this.comment(f, me, html, go);
    if (p === '/x') { const m = this.msgs.get(f.get('fnid') ?? ''); return m ? html(m) : html('Unknown or expired link.'); }
    if (p === '/item') {
      const it = this.items.get(Number(f.get('id')));
      if (!it) return html('No such item.');
      const kids = it.kids.map((k) => this.items.get(k)!).filter((c) => !c.deleted).map((c) => `<tr class="athing comtr" id="${c.id}"><td><span class="comhead"><a href="user?id=${c.by}" class="hnuser">${c.by}</a></span><div class="comment"><div class="commtext c00">${(c.text ?? '').replace(/&#x2F;/g, '/')}</div></div></td></tr>`).join('');
      return html(page(it.title ?? 'Comment', me, `<table class="comment-tree">${kids}</table>`));
    }
    if (p === '/logout') return go('news', { 'set-cookie': 'user=; Path=/; Max-Age=0' });
    if (p === '/news' || p === '/') return html(page('Hacker News', me, ''));
    return html('Unknown.', 404);
  }

  private replyPage(it: Item, me: string, goto: string, text = '', msg = '') {
    const closed = it.type === 'comment' && this.now() / 1000 - this.storyOf(it).time > 14 * 86400;
    const hmac = this.rand(40);
    this.hmacs.set(hmac, { user: me, parent: it.id, at: this.now() });
    const form = closed ? '' : `<tr><td></td><td><form action="comment" method="post"><input type="hidden" name="parent" value="${it.id}"><input type="hidden" name="goto" value="${esc(goto)}"><input type="hidden" name="hmac" value="${hmac}"><textarea name="text" rows="8" cols="80" wrap="virtual">${esc(text)}</textarea><br><br><input type="submit" value="reply"></form></td></tr>`;
    return page('Add Comment', me, `${msg ? `<p>${msg}</p>` : ''}<table class="fatitem" border="0"><tr class="athing" id="${it.id}"><td class="default"><span class="comhead"><a href="user?id=${it.by}" class="hnuser">${it.by}</a></span><div class="comment"><div class="commtext c00">${(it.text ?? '').replace(/&#x2F;/g, '/')}</div></div></td></tr>${form}</table>`);
  }
  private storyOf(it: Item): Item { let s = it; while (s.parent) s = this.items.get(s.parent)!; return s; }

  private comment(f: URLSearchParams, cookieUser: string, html: (b: string, s?: number) => Res, go: (to: string) => Res): Res {
    // Hacki and Materialistic sign in inline (acct + pw, no hmac); HN's own form sends its cookie and the hmac
    const inline = f.get('acct') ? this.users.get(f.get('acct')!) : undefined;
    const me = inline && inline.pw === f.get('pw') ? f.get('acct')! : cookieUser;
    const parent = Number(f.get('parent')), goto = f.get('goto') || '', text = (f.get('text') ?? '').replace(/\r\n/g, '\n');
    if (!me) return html(loginPage('You have to be logged in to comment.', goto || 'news'));
    const it = this.items.get(parent);
    if (!it || it.deleted) return html('No such item.');
    if (!inline) {
      const h = this.hmacs.get(f.get('hmac') ?? '');
      if (!h || h.user !== me || h.parent !== parent || this.now() - h.at > this.mode.hmacTtlMs) return html('Unknown or expired link.');
    }
    if (!text.trim()) return this.msg(html('Please try again.').body, go);
    if (this.mode.tooFastMs && this.now() - (this.lastPost.get(me) ?? -1e15) < this.mode.tooFastMs) return this.msg("You're posting too fast. Please slow down. Thanks.", go);
    if (this.mode.confirmNext) {
      this.mode.confirmNext = false;
      return this.msg(this.replyPage(it, me, goto, text, 'Please confirm that this is your comment by submitting it one more time. This is a security measure. It usually happens when you log in after the original page was loaded.'), go, 'commconfirm');
    }
    const id = Math.max(...this.items.keys()) + 1, user = this.users.get(me);
    this.items.set(id, { id, type: 'comment', by: me, time: Math.floor(this.now() / 1000), parent, kids: [], at: this.now(),
      text: user?.delay ? '[delayed]' : apiHtml(text), ...(user?.banned ? { dead: true } : {}) });
    it.kids.push(id);
    this.lastPost.set(me, this.now());
    this.posts.push({ user: me, parent, text, id });
    return go(goto || (inline ? '/' : `item?id=${parent}`));
  }
  private msg(body: string, go: (to: string) => Res, fnop = 'msg') {
    const fnid = this.rand(22);
    this.msgs.set(fnid, body);
    return go(`x?fnid=${fnid}&fnop=${fnop}`);
  }
  private me(req: Req) {
    const c = /(?:^|;\s*)user=([^;]+)/.exec(req.headers.cookie ?? req.headers.Cookie ?? '')?.[1];
    return c ? this.sessions.get(decodeURIComponent(c)) ?? '' : '';
  }
  private rand(n: number) { let s = ''; while (s.length < n) s += (++this.seq * 2654435761 >>> 0).toString(16) + Math.random().toString(16).slice(2); return s.slice(0, n); }
}
