import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readSupport, withSupport, supportPage, supportSite, missingMarks, MARKS, SUPPORT_CSP, type Support } from './support.ts';

const INDEX = readFileSync(join(import.meta.dirname, '../../client/index.html'), 'utf8');
const URL_ = 'https://github.com/sponsors/example', CUP_ = 'https://buymeacoffee.com/example';
const on: Support = { url: URL_, coffee: null, upi: null };
/** GitHub and a coffee: what the tower runs with */
const both: Support = { url: URL_, coffee: CUP_, upi: null };
/** what support adds to the page, taken out again (each piece, wherever it went) */
const strip = (page: string) => page.replace(/<style>\n#splash[\s\S]*?<\/style>|<p id="give">[\s\S]*?<\/p>|<p id="credit">[\s\S]*?<\/p>|<span class="gifts">[\s\S]*?<\/a><\/span>/g, '');
const count = (s: string, x: string | RegExp) => typeof x === 'string' ? s.split(x).length - 1 : (s.match(new RegExp(x, 'g')) ?? []).length;
/** every <a …> tag in a page, with its attributes */
const links = (html: string) => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, inner]) => ({ attrs, inner, href: /href="([^"]*)"/.exec(attrs)?.[1] }));

test('the page carries each marker exactly once (else a piece would silently go missing, or twice)', () => {
  for (const m of Object.values(MARKS)) assert.equal(count(INDEX, m), 1, m);
  assert.deepEqual(missingMarks(INDEX), []);
  assert.deepEqual(missingMarks(INDEX.replace(MARKS.door, '')), [MARKS.door], 'and towerd can tell when one is gone');
});

test('unset: the page goes out exactly as it was before support existed, with nothing of it inside', () => {
  const off = withSupport(INDEX, null);
  assert.equal(off, Object.values(MARKS).reduce((s, m) => s.replace(m, ''), INDEX));
  for (const trace of ['support', 'Sponsor', 'sponsor', 'github.com', 'buymeacoffee', 'coffee', 'Rounak', 'id="give"', 'id="credit"', 'class="gifts"']) assert.ok(!off.includes(trace), trace);
  assert.equal(readSupport({}).support, null);
  assert.equal(readSupport({ SPONSOR_URL: '   ' }).support, null);
  assert.equal(readSupport({ SPONSOR_UPI: 'name@bank' }).support, null, 'a UPI ID alone turns nothing on');
  assert.equal(readSupport({ SPONSOR_COFFEE: CUP_ }).support, null, 'nor a coffee page alone');
});

test('set: two icons after the name, a line at the foot of the door, a credit at the table, their styles, each once', () => {
  for (const s of [on, both]) {
    const page = withSupport(INDEX, s);
    for (const m of Object.values(MARKS)) assert.ok(!page.includes(m), `${m} filled`);
    assert.equal(count(page, 'id="give"'), 1);
    assert.equal(count(page, 'id="credit"'), 1);
    assert.equal(count(page, 'class="gifts"'), 2, 'the corner and the table');
    assert.equal(count(page, '<style>'), count(INDEX, '<style>') + 1);
    // the icons follow the name in the corner, on its line; the door's line is the splash's own last child, right after
    // its button; the credit is the body's, right after the seat's controls (next in tab order) and outside them
    // (#controls is transformed on touch screens, which would make it the credit's containing block)
    assert.match(page, /Tower <i>of<\/i> HN<span class="gifts">[^\n]*?<\/a><\/span><\/div><div id="live">/);
    assert.match(page, /Waking the tower…<\/button>\n<\/div><p id="give">[^\n]*<\/p><\/div>\n/);
    assert.match(page, /id="leave">Stand up<\/button><\/div><p id="credit">[^\n]*<\/p>\n<div id="splash"/);
    assert.ok(page.indexOf('</style><style>\n#splash') > 0 && page.indexOf('<style>\n#splash') < page.indexOf('</head>'), 'the styles, in the head');
    // and nothing else in the page changed
    assert.equal(strip(page), withSupport(INDEX, null));
  }
});

test('every way to give goes straight to its page, in a new tab, telling no one where from; the door names them, the corner and the table show their icons', () => {
  const page = withSupport(INDEX, both), words = (h: string) => h.replace(/<svg[\s\S]*?<\/svg>|<[^>]+>/g, '');
  const at = (from: string) => { const i = page.indexOf(from); return links(page.slice(i, page.indexOf(from.startsWith('<p') ? '</p>' : '</span></div>', i))); };
  const door = at('<p id="give">'), corner = at('<span class="gifts">'), credit = at('<p id="credit">');
  for (const [where, ls] of [['door', door], ['corner', corner], ['table', credit]] as const) {
    assert.deepEqual(ls.map((l) => l.href), [URL_, CUP_], where);
    for (const l of ls) {
      assert.match(l.attrs, /target="_blank" rel="noopener noreferrer"/, where);
      assert.match(l.inner, /<span class="vh"> \(opens in a new tab\)<\/span>$/, `${where}: a screen reader hears that it opens a tab`);
      assert.match(l.inner, /^<svg viewBox="0 0 16 16" aria-hidden="true">/, `${where}: the icon is drawn, and hidden (the words say it)`);
    }
  }
  // the door, where a first visit reads them: each with its word; a screen reader hears whose and where
  assert.deepEqual(door.map((l) => words(l.inner)), ['Sponsor Rounak on GitHub (opens in a new tab)', 'Buy me a coffee (opens in a new tab)']);
  assert.ok(page.includes('<p id="give">Made by Rounak · <a class="gift gh"'), 'who made it, then the ways to give');
  // the corner and the table: the icons alone, named for a screen reader, and for a pointer or focus by their tip
  for (const ls of [corner, credit]) {
    assert.deepEqual(ls.map((l) => words(l.inner)), ['Sponsor Rounak on GitHub (opens in a new tab)', 'Buy Rounak a coffee (opens in a new tab)']);
    assert.deepEqual(ls.map((l) => /data-tip="([^"]*)"/.exec(l.attrs)?.[1]), ['Sponsor on GitHub', 'Buy me a coffee']);
  }
  assert.equal(count(page, 'href="https://'), count(INDEX, 'href="https://') + 6, 'two ways out, in three places, no more');
  // GitHub alone: one way, in each place
  assert.equal(count(withSupport(INDEX, on), 'href="https://'), count(INDEX, 'href="https://') + 3);
  assert.ok(!withSupport(INDEX, on).includes('buymeacoffee'), 'no coffee page, no cup');
});

test('readable, reachable and calm: no hiding from screen readers, a focus ring, and no motion when asked for none', () => {
  const page = withSupport(INDEX, both), css = page.slice(page.indexOf('<style>\n#splash'), page.indexOf('</style>', page.indexOf('<style>\n#splash')));
  const give = /<p id="give">[\s\S]*?<\/p>/.exec(page)![0], credit = /<p id="credit">[\s\S]*?<\/p>/.exec(page)![0];
  const corner = /<span class="gifts">[\s\S]*?<\/a><\/span>/.exec(page)![0];
  // (the icons are drawn, and hidden: the words say it)
  for (const el of [give, credit, corner]) assert.ok(!/aria-hidden|tabindex="-1"|aria-live/.test(el.replace(/<svg[\s\S]*?<\/svg>/g, '')), el);
  assert.match(css, /#give a:focus-visible,#credit a:focus-visible,\.gifts \.gift:focus-visible\{outline:2px solid #fff/);
  // a tip shows for the keyboard as for a pointer; a touch screen has no pointer to rest, and no tip that would stick
  assert.match(css, /\.gifts \.gift:hover::after,\.gifts \.gift:focus-visible::after\{opacity:1/);
  assert.match(css, /@media \(hover: none\) \{ \.gifts \.gift::after \{ display:none \} \}/);
  // the corner is the name's: it takes no clicks (the scene's), but its icons do
  assert.match(INDEX, /#brand \{[^}]*pointer-events:none/);
  assert.match(css, /\.gifts \.gift\{[^}]*pointer-events:auto/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ #credit, body\[data-mode="table"\]:not\(\.reply-open\) #credit \{ transition:none \} \.gift svg, \.gifts \.gift, \.gifts \.gift::after \{ transition:none \} \}/);
  // hidden (not merely transparent) outside a table: no invisible link to tab into on the tower
  assert.match(css, /#credit\{[^}]*visibility:hidden/);
  assert.match(css, /body\[data-mode="table"\]:not\(\.reply-open\) #credit \{ visibility:visible/);
});

test('the corner\'s icons go when the corner does: a name made transparent must not leave links to tap or Tab into', () => {
  const css = withSupport(INDEX, both).match(/<style>\n#splash[\s\S]*?<\/style>/)![0];
  // every state in which the page hides the corner (it only fades it: opacity), the icons are hidden outright
  assert.match(INDEX, /body\.door :is\(#brand, #lean\) \{ opacity:0/);
  assert.match(INDEX, /body\[data-mode="table"\] #brand \{ opacity:0 \}/);
  // (the media block it sits in: the nearest opening line above it)
  const at = INDEX.indexOf('body:not([data-mode="tower"]) #brand, body:not([data-mode="tower"]) #scrim { opacity:0 }');
  assert.ok(at > 0);
  const opener = INDEX.slice(0, at).split('\n').reverse().find((l) => /^\s*@media .*\{\s*$/.test(l))!;
  const narrow = /@media (.*?)\s*\{\s*$/.exec(opener)![1];
  assert.ok(css.includes('body.door #brand .gifts,body[data-mode="table"] #brand .gifts{visibility:hidden}'));
  assert.ok(css.includes(`@media ${narrow.trim()} { body:not([data-mode="tower"]) #brand .gifts { visibility:hidden } }`), narrow);
  // a finger finds them: each target at least 24 px (WCAG 2.2, 2.5.8), a little air between the two
  const icon = Number(/\.gift svg\{width:(\d+)px/.exec(css)![1]), pad = Number(/\.gifts \.gift\{[^}]*padding:(\d+)px/.exec(css)![1]);
  assert.ok(icon + 2 * pad >= 24, `${icon + 2 * pad} px`);
  assert.match(css, /\.gifts\{[^}]*gap:[1-9]/);
  // the tip shows the name to the eye; a screen reader already has it from the link (generated text joins the name)
  assert.ok(css.includes('content:attr(data-tip);content:attr(data-tip) / "";'));
  // and the door's icons take their own colour too (its own rule is more specific than the shared one)
  assert.ok(css.includes('#give .gift.gh:hover svg') && css.includes('#give .gift.coffee:hover svg'));
});

test('a coffee page without GitHub\'s turns nothing on, and says so', () => {
  const r = readSupport({ SPONSOR_COFFEE: CUP_ });
  assert.equal(r.support, null);
  assert.match(r.problems[0], /SPONSOR_COFFEE needs SPONSOR_URL/);
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
  // with a coffee page: offered beside GitHub, in a quieter button, and said in the words above them
  const two = supportPage(both), ways = links(two).filter((l) => l.href?.startsWith('https:'));
  assert.deepEqual(ways.map((l) => l.href), [URL_, CUP_]);
  assert.match(ways[1].attrs, /class="go two"/);
  assert.match(ways[1].inner, /^Buy me a coffee/);
  assert.ok(two.includes('through GitHub Sponsors, or buy me a coffee.') && !page.includes('coffee'));
  assert.ok(Buffer.byteLength(two) < 4096, `small: ${Buffer.byteLength(two)} bytes`);
  assert.ok(links(page).some((l) => l.href === '/'), 'a way back to the tower');
  assert.ok(Buffer.byteLength(page) < 4096, `small: ${Buffer.byteLength(page)} bytes`);
  // its policy lets it run nothing, be framed by no one, post nowhere, and load nothing but its own icon (which exists)
  const policy = SUPPORT_CSP.split('; ');
  assert.deepEqual(policy.sort(), ["base-uri 'none'", "default-src 'none'", "form-action 'none'", "frame-ancestors 'none'", "img-src 'self'", "style-src 'unsafe-inline'"]);
  assert.ok(page.includes('href="/icon-192.png"') && existsSync(join(import.meta.dirname, '../../client/public/icon-192.png')));
});

test('no exclamation marks and no "please" anywhere a visitor reads', () => {
  const words = (h: string) => h.replace(/<style>[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<[^>]+>/g, ' ');
  const page = withSupport(INDEX, both), added = /<p id="give">[\s\S]*?<\/p>/.exec(page)![0] + /<p id="credit">[\s\S]*?<\/p>/.exec(page)![0] + /<span class="gifts">[\s\S]*?<\/a><\/span>/.exec(page)![0];
  for (const said of [words(added), words(supportPage({ url: URL_, coffee: CUP_, upi: 'name@bank' }).replace(/<!doctype html>/, ''))]) {
    assert.ok(!said.includes('!'), said);
    assert.ok(!/please/i.test(said), said);
  }
});

test('only a GitHub Sponsors page turns it on: anything else keeps it off, so a typo never ships a dead link', () => {
  for (const bad of ['http://github.com/sponsors/example', 'https://evil.example/sponsors/example', 'https://github.com/example',
    'https://github.com/sponsors/', 'https://github.com/sponsors/-example', 'https://github.com/sponsors/ex--ample', 'https://github.com/sponsors/ex ample',
    'https://github.com/sponsors/a/b', 'https://github.com:8443/sponsors/example', 'https://me@github.com/sponsors/example',
    'https://github.com.evil.example/sponsors/example', 'javascript:alert(1)', 'github.com/sponsors/example', 'https://github.com/sponsors/' + 'a'.repeat(40),
    'https://evilgithub.com/sponsors/example', 'https://:pw@github.com/sponsors/example', 'https://github.com/sponsors/ex_ample', 'https://www.github.com/sponsors/example']) {
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

test('a coffee page is only ever Buy Me a Coffee\'s: anything else is left out, and said so; GitHub stays on', () => {
  for (const good of [' https://buymeacoffee.com/rounakdatta ', 'https://www.buymeacoffee.com/rounakdatta', 'https://buymeacoffee.com/rounakdatta/', 'https://buymeacoffee.com/rounakdatta#x'])
    assert.match(readSupport({ SPONSOR_URL: URL_, SPONSOR_COFFEE: good }).support!.coffee!, /^https:\/\/(www\.)?buymeacoffee\.com\/rounakdatta\/?$/, good);
  for (const bad of ['http://buymeacoffee.com/x', 'https://buymeacoffee.com/', 'https://buymeacoffee.com/a/b', 'https://buymeacoffee.com/x?ref=y', 'https://evil.example/x',
    'https://buymeacoffee.com.evil.example/x', 'https://me@buymeacoffee.com/x', 'https://buymeacoffee.com:8443/x', 'buymeacoffee.com/x', 'javascript:alert(1)', 'https://buymeacoffee.com/-x"<']) {
    const r = readSupport({ SPONSOR_URL: URL_, SPONSOR_COFFEE: bad });
    assert.equal(r.support?.url, URL_, bad);
    assert.equal(r.support?.coffee, null, bad);
    assert.match(r.problems[0], /SPONSOR_COFFEE must be/, bad);
  }
});

test('a UPI ID adds one line to /support only; a malformed one is left out, and said so', () => {
  const r = readSupport({ SPONSOR_URL: URL_, SPONSOR_UPI: 'rounak.d@okaxis' });
  assert.deepEqual(r, { support: { url: URL_, coffee: null, upi: 'rounak.d@okaxis' }, problems: [] });
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
  assert.equal(strip(page), withSupport(INDEX, null));
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

test('the door styles its own paragraphs: the line beneath them is specific enough to stay small and quiet', () => {
  // `#splash p` (the door's description: 17 px, bright) outranks a bare `#give`; it once made the line as loud as the copy
  assert.match(INDEX, /#splash p \{[^}]*font-size/);
  const css = withSupport(INDEX, on).match(/<style>\n#splash[\s\S]*?<\/style>/)![0];
  assert.match(css, /\n#splash #give\{[^}]*color:var\(--mute\);font-size:12\.5px/);
  assert.ok(!/[\n,]#give\{/.test(css), 'never the bare id, which #splash p outranks');
});

test('a hand-made config still cannot break out of its attribute or its line of text', () => {
  // readSupport would refuse these; the escaping must hold on its own all the same
  const evil: Support = { url: 'https://github.com/sponsors/x?a="><script>alert(1)</script>&b=\'', coffee: 'https://buymeacoffee.com/x"><svg onload=alert(1)>', upi: '"><img src=x onerror=alert(1)>@x' };
  for (const page of [withSupport(INDEX, evil), supportPage(evil)]) {
    assert.ok(!/<script>alert|<img src=x|<svg onload/.test(page), 'no markup from the config');
    assert.ok(page.includes(`href="https://github.com/sponsors/x?a=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;b='"`), 'one attribute, escaped');
    assert.ok(page.includes('href="https://buymeacoffee.com/x&quot;&gt;&lt;svg onload=alert(1)&gt;"'), 'and the coffee page\'s');
  }
  assert.ok(supportPage(evil).includes('pa=%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E%40x&amp;'));
});

test('the credit takes the hint\'s baseline, and only the widths where the hint has moved away from it', () => {
  const css = withSupport(INDEX, on).match(/<style>\n#splash[\s\S]*?<\/style>/)![0];
  // at or below this width the page moves the hint to the credit's own left; above it, the hint is centred
  const [, w] = /@media \(max-width: (\d+)px\) \{ body\[data-mode="table"\] #hint \{ left:24px/.exec(INDEX)!;
  // (`not all and (max-width)`, not `width >`: range syntax is lost on Chrome 94–103, which still runs the tower)
  assert.ok(css.includes(`@media not all and (max-width: ${w}px) { body[data-mode="table"]:not(.reply-open) #credit { visibility:visible`), w);
  assert.match(css, /#credit\{position:fixed;left:24px;/);
  const [, bottom] = /body\[data-mode="table"\] #hint \{ bottom:([^}]+?) \}/.exec(INDEX)!;
  assert.ok(css.includes(`#credit{position:fixed;left:24px;bottom:${bottom};`), bottom);
  // the door's line clears a phone's home bar
  assert.match(css, /#splash #give\{[^}]*padding:0 24px max\(18px, env\(safe-area-inset-bottom\)\)/);
});

test('what towerd serves: off, nothing answers and nothing changes; on, /support under its own policy, counted bare', () => {
  const f = { body: Buffer.from(INDEX), mtime: 1 };
  const off = supportSite(null);
  for (const path of ['/support', '/support/']) assert.equal(off.answer('GET', path), null, path);
  assert.equal(off.page, null);
  assert.deepEqual(off.status(), {});
  assert.equal(off.index(f).toString(), withSupport(INDEX, null));

  const site = supportSite(on);
  for (const path of ['/', '/supportx', '/support/x', '/SUPPORT', '/support.html', '/live/support']) assert.equal(site.answer('GET', path), null, path);
  const a = site.answer('GET', '/support')!;
  assert.equal(a.status, 200);
  assert.deepEqual(a.headers, { 'cache-control': 'no-cache', etag: a.headers.etag, vary: 'accept-encoding', 'content-type': 'text/html; charset=utf-8',
    'content-security-policy': SUPPORT_CSP, 'referrer-policy': 'strict-origin-when-cross-origin' });
  assert.match(a.headers.etag, /^W\/"[\w-]{16}"$/);
  assert.equal(site.page!.toString(), supportPage(on));
  assert.equal(site.answer('GET', '/support/')!.status, 200);
  assert.equal(site.answer('GET', '/support', a.headers.etag)!.status, 304);
  assert.deepEqual(Object.keys(site.answer('HEAD', '/support', a.headers.etag)!.headers).sort(), ['cache-control', 'etag', 'vary']);
  assert.equal(site.answer('GET', '/support', 'W/"something else"')!.status, 200);
  // a view is a GET (a 304 is someone looking again; a HEAD is no one): four above
  assert.deepEqual(site.status(), { support: { views: 4 } });
  // the page as served: filled, and rebuilt only when the file changes
  const first = site.index(f);
  assert.equal(first.toString(), withSupport(INDEX, on));
  // (identity, through assert.ok: a failing assert.equal of two Buffers has node's test runner diff them byte by byte,
  // hundreds of MB a second for a page; a broken memo here once took the whole box down)
  assert.ok(site.index({ body: Buffer.from('changed'), mtime: 1 }) === first, 'same file: the same bytes');
  const next = '<p>x</p><!--support:door-->';
  assert.equal(site.index({ body: Buffer.from(next), mtime: 2 }).toString(), withSupport(next, on), 'a new file: rebuilt');
  // and towerd only glues it in: read from the environment, asked first for every GET or HEAD, its page and its count
  const main = readFileSync(join(import.meta.dirname, 'main.ts'), 'utf8');
  assert.match(main, /readSupport\(process\.env\)/);
  assert.match(main, /const support = supportSite\(SUPPORT\);/);
  const at = (s: string) => { const i = main.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at("req.method !== 'GET' && req.method !== 'HEAD'") < at('support.answer(') && at('support.answer(') < at("if (!url.pathname.startsWith('/live/')) {"));
  assert.match(main, /if \(p === INDEX\) file\.body = support\.index\(file\);/);
  assert.match(main, /\.\.\.support\.status\(\) \}\)\);/);
});

test('the door line and the credit keep the rules their look depends on', () => {
  const css = withSupport(INDEX, on).match(/<style>\n#splash[\s\S]*?<\/style>/)![0];
  for (const rule of ['#splash{grid-template-rows:1fr auto}', 'max-width:min(100%, 720px)', 'text-align:center;text-wrap:balance}', '#splash #give a{white-space:nowrap}',
    '@media (max-height: 420px) { #splash #give { display:none } }', 'z-index:3;', 'text-decoration:underline;', 'white-space:nowrap;visibility:hidden;opacity:0;'])
    assert.ok(css.includes(rule), rule);
  assert.equal(readSupport({ SPONSOR_URL: URL_, SPONSOR_UPI: '  rounak.d@okaxis ' }).support?.upi, 'rounak.d@okaxis', 'spaces round a UPI ID are not part of it');
});
