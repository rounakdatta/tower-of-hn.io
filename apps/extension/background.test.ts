// node --test apps/extension/background.test.ts — the companion extension's HN requests, against the HN mock
// (apps/client/e2e/hn-mock.ts): the real background.js and content.js, loaded with a stand-in `chrome`, and a fetch that
// carries your HN session cookie the way the browser would. Nothing reaches the real HN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { HnMock } from '../client/e2e/hn-mock.ts';

const BG = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
const CONTENT = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
const BOB = { parent: 46100001, story: 46100000 };

/** background.js with a browser around it: returns how to ask it to post, and how to answer its confirm window */
function extension(mock: HnMock, cookie: string | null) {
  const listeners: ((msg: unknown, sender: unknown, reply: (r: unknown) => void) => unknown)[] = [];
  const removed: ((id: number) => void)[] = [];
  const windows: { id: number; url: string }[] = [];
  async function fetch(input: string, init: { method?: string; body?: unknown; credentials?: string } = {}) {
    let url = String(input), method = init.method ?? 'GET', body = init.body ? String(init.body) : '';
    for (let hop = 0; hop < 6; hop++) {
      const withCookie = init.credentials === 'include' && url.startsWith('https://news.ycombinator.com/') && cookie;
      const res = await mock.handle({ method, url, headers: withCookie ? { cookie: `user=${cookie}` } : {}, body });
      if (res.status >= 300 && res.status < 400) { url = new URL(res.headers.location, url).href; method = 'GET'; body = ''; continue; }
      return { ok: res.status < 400, status: res.status, url, text: async () => res.body, json: async () => JSON.parse(res.body) };
    }
    throw new Error('too many redirects');
  }
  const chrome = {
    runtime: { onMessage: { addListener: (f: (typeof listeners)[number]) => listeners.push(f) } },
    windows: {
      create: (o: { url: string }) => { const w = { id: windows.length + 1, url: o.url }; windows.push(w); return Promise.resolve(w); },
      onRemoved: { addListener: (f: (id: number) => void) => removed.push(f) },
    },
  };
  runInNewContext(BG, { chrome, fetch, URLSearchParams, URL, crypto, console, setTimeout, String, Date, encodeURIComponent });
  // (answers are made in the script's own realm: compared as plain data)
  const send = (msg: unknown) => new Promise((res) => { for (const l of listeners) l(msg, {}, (r) => res(JSON.parse(JSON.stringify(r ?? null)))); });
  return {
    windows,
    /** the page asks; the answer comes once the confirm window is decided (or closed) */
    ask: (text: string, to = BOB) => send({ kind: 'post', parent: to.parent, story: to.story, text, from: 'https://towerofhn.taptappers.club' }),
    /** the confirm window: Post (or Cancel) */
    decide: async (yes: boolean) => { await new Promise((r) => setTimeout(r, 5)); const id = windows.at(-1)!.url.split('#')[1]; return send({ kind: 'confirm', id, yes }); },
    closeWindow: async () => { await new Promise((r) => setTimeout(r, 5)); for (const f of removed) f(windows.at(-1)!.id); },
  };
}

test('signed in on HN: one confirmed post, once', async () => {
  const mock = new HnMock(), ext = extension(mock, mock.signIn('alice'));
  const answer = ext.ask('Posted by the extension, after its own window.');
  assert.deepEqual(await ext.decide(true), { ok: true });
  assert.deepEqual(await answer, { ok: true });
  assert.deepEqual(mock.posts.map((p) => [p.user, p.parent, p.text]), [['alice', BOB.parent, 'Posted by the extension, after its own window.']]);
});

test('Cancel in its window posts nothing', async () => {
  const mock = new HnMock(), ext = extension(mock, mock.signIn('alice'));
  const answer = ext.ask('Never mind.');
  await ext.decide(false);
  assert.deepEqual(await answer, { ok: false, error: 'Not posted' });
  assert.equal(mock.posts.length, 0);
});

test('closing its window without deciding answers the page (it doesn\'t wait forever)', async () => {
  const mock = new HnMock(), ext = extension(mock, mock.signIn('alice'));
  const answer = ext.ask('Closed the window.');
  await ext.closeWindow();
  assert.deepEqual(await Promise.race([answer, new Promise((r) => setTimeout(() => r('no answer'), 200))]), { ok: false, error: 'Not posted' });
  assert.equal(mock.posts.length, 0);
});

test('signed out on HN: says to sign in there, posts nothing', async () => {
  const mock = new HnMock(), ext = extension(mock, null);
  const answer = ext.ask('Who am I?');
  await ext.decide(true);
  assert.deepEqual(await answer, { ok: false, error: 'Log in to Hacker News in this browser first' });
  assert.equal(mock.posts.length, 0);
});

test('HN asks to confirm a resubmission: answered once, posted once', async () => {
  const mock = new HnMock(), ext = extension(mock, mock.signIn('alice'));
  mock.mode.confirmNext = true;
  const answer = ext.ask('Confirm me.');
  await ext.decide(true);
  assert.deepEqual(await answer, { ok: true });
  assert.equal(mock.posts.length, 1);
});

test('HN refuses ("posting too fast", an expired form): HN\'s own words reach you', async () => {
  const mock = new HnMock(), ext = extension(mock, mock.signIn('alice'));
  mock.mode.tooFastMs = 600_000;
  let answer = ext.ask('First one.'); await ext.decide(true); await answer;
  answer = ext.ask('Second one, too soon.'); await ext.decide(true);
  assert.deepEqual(await answer, { ok: false, error: "You're posting too fast. Please slow down. Thanks." });
  mock.mode.tooFastMs = 0; mock.mode.hmacTtlMs = -1;
  answer = ext.ask('With a stale form.'); await ext.decide(true);
  assert.deepEqual(await answer, { ok: false, error: 'Unknown or expired link.' });
  assert.equal(mock.posts.length, 1);
});

test('a retry after a post that did land (HN returns no id) is not posted twice, formatting and links included', async () => {
  const mock = new HnMock(), cookie = mock.signIn('alice'), ext = extension(mock, cookie);
  const text = 'This is *exactly* why: https://example.com/a/very/long/path/that/hn/will/shorten/for/display/purposes/ok';
  let answer = ext.ask(text); await ext.decide(true);
  assert.deepEqual(await answer, { ok: true });
  answer = ext.ask(text); await ext.decide(true);                               // the page timed out and asked again
  assert.deepEqual(await answer, { ok: true });
  assert.equal(mock.posts.length, 1);
});

test('content.js: a page message it won\'t pass on is still answered (the sheet never hangs on "Posting…")', async () => {
  const posted: unknown[] = [];
  const listeners: ((e: unknown) => void)[] = [];
  const window = {
    addEventListener: (_: string, f: (e: unknown) => void) => listeners.push(f),
    postMessage: (m: unknown) => posted.push(m),
  };
  const location = { origin: 'https://towerofhn.taptappers.club' };
  runInNewContext(CONTENT, { window, location, chrome: { runtime: { sendMessage: () => assert.fail('nothing should be sent on') } }, Number });
  for (const l of listeners) l({ source: window, origin: location.origin, data: { tohn: 'post', parent: 1, story: 2, text: 'x'.repeat(8001), nonce: 'n-1' } });
  assert.equal(posted.length, 1);
  assert.match(String((posted[0] as { error: string }).error), /too long/i);
  assert.equal((posted[0] as { nonce: string }).nonce, 'n-1');                  // (matched to its own request)
});
