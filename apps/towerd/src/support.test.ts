import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readSupport, withSupport, supportPage, MARKS, SUPPORT_CSP, type Support } from './support.ts';

const INDEX = readFileSync(join(import.meta.dirname, '../../client/index.html'), 'utf8');
const URL_ = 'https://github.com/sponsors/example';
const on: Support = { url: URL_, upi: null };
const count = (s: string, x: string | RegExp) => typeof x === 'string' ? s.split(x).length - 1 : (s.match(new RegExp(x, 'g')) ?? []).length;
/** every <a …> tag in a page, with its attributes */
const links = (html: string) => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, inner]) => ({ attrs, inner, href: /href="([^"]*)"/.exec(attrs)?.[1] }));

test('the page carries each marker exactly once (else a piece would silently go missing, or twice)', () => {
  for (const m of Object.values(MARKS)) assert.equal(count(INDEX, m), 1, m);
});

test('unset: the page goes out exactly as it was before support existed, with nothing of it inside', () => {
  const off = withSupport(INDEX, null);
  assert.equal(off, Object.values(MARKS).reduce((s, m) => s.replace(m, ''), INDEX));
  for (const trace of ['support', 'Sponsor', 'sponsor', 'github.com', 'Rounak', 'id="give"', 'id="credit"']) assert.ok(!off.includes(trace), trace);
  assert.equal(readSupport({}).support, null);
  assert.equal(readSupport({ SPONSOR_URL: '   ' }).support, null);
  assert.equal(readSupport({ SPONSOR_UPI: 'name@bank' }).support, null, 'a UPI ID alone turns nothing on');
});

test('set: a line at the foot of the door, a credit at the table, their styles, each once', () => {
  const page = withSupport(INDEX, on);
  for (const m of Object.values(MARKS)) assert.ok(!page.includes(m), `${m} filled`);
  assert.equal(count(page, 'id="give"'), 1);
  assert.equal(count(page, 'id="credit"'), 1);
  assert.equal(count(page, '<style>'), count(INDEX, '<style>') + 1);
  // the door's line sits inside the door, after its own words; the credit after the seat's controls (tab order)
  const splash = page.indexOf('<div id="splash"'), give = page.indexOf('id="give"'), body = page.indexOf('</body>');
  assert.ok(splash > 0 && give > splash && give < body && give > page.indexOf('Headphones on.'));
  assert.ok(page.indexOf('id="credit"') > page.indexOf('id="controls"'));
  // and nothing else in the page changed
  assert.equal(page.replace(/<style>\n#splash[\s\S]*?<\/style>|<p id="give">[\s\S]*?<\/p>|<p id="credit">[\s\S]*?<\/p>/g, ''), withSupport(INDEX, null));
});

test('the door points to /support; the credit points straight to GitHub, in a new tab, telling no one where from', () => {
  const page = withSupport(INDEX, on);
  const door = links(page.slice(page.indexOf('<p id="give">')))[0], credit = links(page.slice(page.indexOf('<p id="credit">')))[0];
  assert.equal(door.href, '/support');
  assert.ok(!/target=/.test(door.attrs), 'our own page: same tab');
  assert.equal(credit.href, URL_);
  assert.match(credit.attrs, /target="_blank"/);
  assert.match(credit.attrs, /rel="noopener noreferrer"/);
  // GitHub is named where the eye reads the link, and a screen reader hears that it opens a tab
  assert.match(credit.inner, /^Sponsor on GitHub/);
  assert.match(credit.inner, /<span class="vh"> \(opens in a new tab\)<\/span>/);
  assert.match(credit.inner, /<svg[^>]*aria-hidden="true"/);
  assert.equal(count(page, 'href="https://'), count(INDEX, 'href="https://') + 1, 'one way out to GitHub, no more');
});

test('readable, reachable and calm: no hiding from screen readers, a focus ring, and no motion when asked for none', () => {
  const page = withSupport(INDEX, on), css = page.slice(page.indexOf('<style>\n#splash'), page.indexOf('</style>', page.indexOf('<style>\n#splash')));
  const give = /<p id="give">[\s\S]*?<\/p>/.exec(page)![0], credit = /<p id="credit">[\s\S]*?<\/p>/.exec(page)![0];
  // (the arrow is drawn, and hidden: the words say it)
  for (const el of [give, credit]) assert.ok(!/aria-hidden|tabindex="-1"|aria-live/.test(el.replace(/<svg[\s\S]*?<\/svg>/, '')), el);
  assert.match(css, /#give a:focus-visible,#credit a:focus-visible\{outline:2px solid #fff/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ #credit, body\[data-mode="table"\]:not\(\.reply-open\) #credit \{ transition:none \} \}/);
  // hidden (not merely transparent) outside a table: no invisible link to tab into on the tower
  assert.match(css, /#credit\{[^}]*visibility:hidden/);
  assert.match(css, /body\[data-mode="table"\]:not\(\.reply-open\) #credit \{ visibility:visible/);
});

test('/support: who, what it pays for, monthly or once, any amount, the button, voluntary; no script, no form, no frame', () => {
  const page = supportPage(on);
  for (const said of ['Rounak Datta', 'servers', 'monthly or just once', 'any amount', 'GitHub Sponsors', 'voluntary and unlocks nothing'])
    assert.ok(page.includes(said), said);
  for (const never of ['<script', '<iframe', '<form', '<input', 'on' + 'click', 'cookie']) assert.ok(!page.includes(never), never);
  const out = links(page).filter((l) => l.href?.startsWith('https:'));
  assert.equal(out.length, 1);
  assert.equal(out[0].href, URL_);
  assert.match(out[0].attrs, /target="_blank" rel="noopener noreferrer"/);
  assert.match(out[0].inner, /^Sponsor on GitHub/);
  assert.ok(links(page).some((l) => l.href === '/'), 'a way back to the tower');
  assert.ok(Buffer.byteLength(page) < 4096, `small: ${Buffer.byteLength(page)} bytes`);
  // its policy lets it run nothing at all
  assert.match(SUPPORT_CSP, /^default-src 'none';/);
  assert.ok(!/script-src|unsafe-eval/.test(SUPPORT_CSP));
});

test('no exclamation marks and no "please" anywhere a visitor reads', () => {
  const words = (h: string) => h.replace(/<style>[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<[^>]+>/g, ' ');
  const page = withSupport(INDEX, on), added = /<p id="give">[\s\S]*?<\/p>/.exec(page)![0] + /<p id="credit">[\s\S]*?<\/p>/.exec(page)![0];
  for (const said of [words(added), words(supportPage({ url: URL_, upi: 'name@bank' }).replace(/<!doctype html>/, ''))]) {
    assert.ok(!said.includes('!'), said);
    assert.ok(!/please/i.test(said), said);
  }
});

test('only a GitHub Sponsors page turns it on: anything else keeps it off, so a typo never ships a dead link', () => {
  for (const bad of ['http://github.com/sponsors/example', 'https://evil.example/sponsors/example', 'https://github.com/example',
    'https://github.com/sponsors/', 'https://github.com/sponsors/-example', 'https://github.com/sponsors/ex--ample', 'https://github.com/sponsors/ex ample',
    'https://github.com/sponsors/a/b', 'https://github.com:8443/sponsors/example', 'https://me@github.com/sponsors/example',
    'https://github.com.evil.example/sponsors/example', 'javascript:alert(1)', 'github.com/sponsors/example', 'https://github.com/sponsors/' + 'a'.repeat(40)]) {
    const r = readSupport({ SPONSOR_URL: bad });
    assert.equal(r.support, null, bad);
    assert.match(r.problems[0], /SPONSOR_URL must be/, bad);
  }
  assert.equal(readSupport({ SPONSOR_URL: ' https://github.com/sponsors/rounakdatta ' }).support?.url, 'https://github.com/sponsors/rounakdatta');
  assert.equal(readSupport({ SPONSOR_URL: 'https://github.com/sponsors/Rounak-Datta/' }).support?.url, 'https://github.com/sponsors/Rounak-Datta/');
  assert.equal(readSupport({ SPONSOR_URL: 'https://github.com/sponsors/example#x' }).support?.url, URL_, 'a fragment is dropped');
  // a query survives, escaped for the attribute it lands in
  const q = readSupport({ SPONSOR_URL: 'https://github.com/sponsors/example?frequency=one-time&sponsor=x"<' }).support!;
  assert.ok(withSupport(INDEX, q).includes('href="https://github.com/sponsors/example?frequency=one-time&amp;sponsor=x%22%3C"'));
  assert.ok(supportPage(q).includes('href="https://github.com/sponsors/example?frequency=one-time&amp;sponsor=x%22%3C"'));
});

test('a UPI ID adds one line to /support only; a malformed one is left out, and said so', () => {
  const r = readSupport({ SPONSOR_URL: URL_, SPONSOR_UPI: 'rounak.d@okaxis' });
  assert.deepEqual(r, { support: { url: URL_, upi: 'rounak.d@okaxis' }, problems: [] });
  const page = supportPage(r.support!);
  assert.ok(page.includes('<a href="upi://pay?pa=rounak.d%40okaxis&amp;pn=Rounak%20Datta&amp;cu=INR">rounak.d@okaxis</a>'));
  assert.ok(!withSupport(INDEX, r.support).includes('upi'), 'never on the door or at a table');
  assert.ok(!supportPage(on).includes('upi'));
  for (const bad of ['rounak', '@okaxis', 'rounak@', 'a b@okaxis', 'rounak@ok axis', '<x>@okaxis', 'rounak@okaxis"']) {
    const b = readSupport({ SPONSOR_URL: URL_, SPONSOR_UPI: bad });
    assert.equal(b.support?.upi, null, bad);
    assert.match(b.problems[0], /SPONSOR_UPI must be/, bad);
  }
});

test('a $ in the URL is only ever a character: nothing of the page is copied into the link', () => {
  // in a string replacement `$&` is the marker, `$`` everything before it; the URL keeps both as typed
  const s = readSupport({ SPONSOR_URL: 'https://github.com/sponsors/example?a=$&b=$`&c=$$' }).support!;
  const page = withSupport(INDEX, s), credit = /<p id="credit">[\s\S]*?<\/p>/.exec(page)![0];
  assert.equal(links(credit)[0].href, 'https://github.com/sponsors/example?a=$&amp;b=$`&amp;c=$$');
  assert.equal(count(page, '<!doctype html>'), 1);
  assert.equal(page.replace(/<style>\n#splash[\s\S]*?<\/style>|<p id="give">[\s\S]*?<\/p>|<p id="credit">[\s\S]*?<\/p>/g, ''), withSupport(INDEX, null));
});

test('the voices never say it: what they read is made from Hacker News by code that cannot see the note', () => {
  const root = join(import.meta.dirname, '../../..'), here = import.meta.dirname;
  const src = (dir: string, ext: RegExp) => readdirSync(dir).filter((f) => ext.test(f) && !f.includes('.test.')).map((f) => join(dir, f));
  const trace = /support\.ts|withSupport|supportPage|readSupport|SPONSOR_|Rounak Datta|['"#](give|credit)['"]/;
  // the spoken form, the voicing queue, its tags and store, the worker that voices; and the client, which plays the
  // clips and shows their subtitles: none of it can name the note, so none of it can carry it to a voice
  const voice = [...src(join(root, 'packages/core/src'), /\.ts$/), ...['queue.ts', 'tags.ts', 'store.ts'].map((f) => join(here, f)),
    ...src(join(root, 'apps/voice-worker'), /\.py$/), ...src(join(root, 'apps/client/src'), /\.ts$/)];
  assert.ok(voice.length > 20, `${voice.length} files looked at`);
  for (const f of voice) assert.ok(!trace.test(readFileSync(f, 'utf8')), f);
  // towerd hands it to the page and to /support only: support.ts is imported once, by the HTTP layer
  const users = src(here, /\.ts$/).filter((f) => readFileSync(f, 'utf8').includes("from './support.ts'"));
  assert.deepEqual(users.map((f) => f.slice(here.length + 1)), ['main.ts']);
});
