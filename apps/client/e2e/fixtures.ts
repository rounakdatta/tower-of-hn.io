// What every reply test gets: a fresh HN mock behind HN's real hostnames, nothing else reachable outside the machine,
// a record of what the page copied, and (on request) a speech recogniser the test speaks through.
import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import { HnMock } from './hn-mock.ts';

export { expect };
/** the account the mock knows (never a real HN account; the mock's password only) */
export const ALICE = { acct: 'alice', pw: 'mock-only-pass' };
export const BOB = { id: 46100001, story: 46100000 };
export const replyUrl = (id: number, story: number) => `https://news.ycombinator.com/reply?id=${id}&goto=${encodeURIComponent(`item?id=${story}#${id}`)}`;

export const test = base.extend<{ mock: HnMock; speech: void }>({
  mock: async ({ context }, use) => {
    const mock = new HnMock();
    // a request the browser makes by following a redirect is never routed (Playwright's network docs; WebKit refuses a
    // fulfilled redirect outright), so it would reach the real HN: the mock's redirects are sent as pages that navigate
    // instead (below), and any request that still arrives by a redirect fails the test
    const leaks: string[] = [];
    context.on('request', (q) => { if (q.redirectedFrom()) leaks.push(q.url()); });
    // nothing leaves this machine but for HN's two hosts, which are the mock
    await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/]|news\.ycombinator\.com\/|hacker-news\.firebaseio\.com\/)/, (r) => r.abort());
    await context.route(/^https:\/\/(news\.ycombinator\.com|hacker-news\.firebaseio\.com)\//, async (route) => {
      const r = route.request();
      // (WebKit adds cookies below the interception layer: the mock reads them from the browser's jar, in every engine)
      const cookie = (await context.cookies(r.url())).map((c) => `${c.name}=${c.value}`).join('; ');
      const res = await mock.handle({ method: r.method(), url: r.url(), headers: { ...(await r.allHeaders()), cookie }, body: r.postData() ?? '' });
      const set = res.headers['set-cookie'];
      if (set) await keepCookie(context, set);           // (every engine keeps it, fulfilled or not)
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        const to = new URL(res.headers.location, r.url()).href.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<meta http-equiv="refresh" content="0; url=${to}">` });
        return;
      }
      await route.fulfill({ status: res.status, headers: res.headers, body: res.body });
    });
    // what the page put on the clipboard (the real clipboard is still written: the page sees the real outcome)
    await context.addInitScript(() => {
      const c = navigator.clipboard as Clipboard | undefined;
      if (!c?.writeText) return;
      const write = c.writeText.bind(c);
      c.writeText = (t: string) => { (window as unknown as { __copied: string }).__copied = t; return write(t); };
    });
    await use(mock);
    expect(leaks, 'requests that went round the HN mock').toEqual([]);
  },
  speech: async ({ context }, use) => { await context.addInitScript(fakeSpeech); await use(); },
});

async function keepCookie(context: BrowserContext, set: string) {
  const [kv] = set.split(';'), i = kv.indexOf('='), name = kv.slice(0, i), value = kv.slice(i + 1);
  if (/max-age=0/i.test(set) || !value) await context.clearCookies({ name, domain: 'news.ycombinator.com' });
  else await context.addCookies([{ name, value, domain: 'news.ycombinator.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
}
/** already signed in on HN in this browser (as most HN readers are) */
export async function signedIn(context: BrowserContext, mock: HnMock, user = ALICE.acct) {
  await context.addCookies([{ name: 'user', value: mock.signIn(user), domain: 'news.ycombinator.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
}
/** what the page last copied */
export const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? null);
/** paste on HN's page: the real clipboard where the engine lets a test read it, else what the page copied */
export async function paste(hn: Page, page: Page, browserName: string) {
  const box = hn.locator('textarea[name=text]');
  await box.click();
  if (browserName === 'chromium') await hn.keyboard.press('ControlOrMeta+V');
  else await box.fill((await copied(page)) ?? '');
}
/** sign in on HN's own login page (the mock's) */
export async function hnLogin(hn: Page, pw = ALICE.pw) {
  const form = hn.locator('form').first();
  await form.locator('input[name=acct]').fill(ALICE.acct);
  await form.locator('input[name=pw]').fill(pw);
  await form.locator('input[type=submit]').click();
}

/** A stand-in for the browser's SpeechRecognition that the test speaks through (window.__sr): the events, in the
 *  order real engines send them (an error is followed by end; stop() delivers the last words, then end). */
function fakeSpeech() {
  type R = { t: string; isFinal: boolean };
  const ctl = { started: 0, stopped: 0, aborted: 0, deny: '', active: null as null | FakeSR, lang: '', continuous: false, interim: false } as Record<string, unknown> & { active: null | FakeSR; deny: string; started: number; stopped: number; aborted: number };
  class FakeSR {
    continuous = false; interimResults = false; lang = '';
    onresult: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null; onend: (() => void) | null = null;
    res: R[] = [];
    start() {
      if (ctl.active) throw new DOMException('recognition has already started', 'InvalidStateError');
      ctl.started++; ctl.active = this; ctl.lang = this.lang; ctl.continuous = this.continuous; ctl.interim = this.interimResults;
      if (ctl.deny) setTimeout(() => { this.onerror?.({ error: ctl.deny }); this.end(); }, 30);
    }
    stop() { ctl.stopped++; setTimeout(() => { const l = this.res[this.res.length - 1]; if (l && !l.isFinal) { l.isFinal = true; this.emit(); } this.end(); }, 60); }
    abort() { ctl.aborted++; setTimeout(() => { this.onerror?.({ error: 'aborted' }); this.end(); }, 10); }
    end() { if (ctl.active === this) ctl.active = null; this.onend?.(); }
    emit() { this.onresult?.({ resultIndex: 0, results: this.res.map((x) => Object.assign([{ transcript: x.t, confidence: 0.9 }], { isFinal: x.isFinal })) }); }
  }
  Object.assign(ctl, {
    /** the latest words: they replace an unfinished result (as an engine refines its guess) */
    hear(t: string, isFinal = false) { const a = ctl.active; if (!a) return false; const l = a.res[a.res.length - 1]; if (l && !l.isFinal) a.res[a.res.length - 1] = { t, isFinal }; else a.res.push({ t, isFinal }); a.emit(); return true; },
    /** a new result after the others (how Android repeats itself) */
    push(t: string, isFinal = true) { const a = ctl.active; if (!a) return false; a.res.push({ t, isFinal }); a.emit(); return true; },
    fail(code: string) { const a = ctl.active; a?.onerror?.({ error: code }); a?.end(); },
    end() { ctl.active?.end(); },
  });
  const w = window as unknown as Record<string, unknown>;
  w.__sr = ctl; w.SpeechRecognition = FakeSR; w.webkitSpeechRecognition = FakeSR;
}
