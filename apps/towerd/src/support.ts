// Support: one config value turns on a quiet way to sponsor Tower of HN; unset, it leaves no trace.
//   SPONSOR_URL     the maker's GitHub Sponsors page, https://github.com/sponsors/<name>. Anything else is refused
//                   (towerd logs why and carries on as if it were unset), so a typo can never ship a dead link.
//   SPONSOR_COFFEE  optional, a Buy Me a Coffee page (https://buymeacoffee.com/<name>): offered beside GitHub, everywhere.
//   SPONSOR_UPI     optional, a UPI ID (name@bank): /support offers it beside GitHub, for people paying from India.
// Set, towerd fills four markers in the client's index.html (the styles; two small icons after the name in the corner;
// a line at the foot of the door; a credit in the table's letterbox, the frame round the picture), each going straight
// to GitHub Sponsors (and the coffee page), and serves /support: the page to share (the app links the ways themselves).
// Unset, it empties them: index.html goes out byte for byte as it did before this existed, and /support is the app, as
// any other unknown path is.
// None of it is a comment or a turn: nothing here can reach the voices, which only ever read Hacker News.
// supportSite() is all towerd asks of it (its HTTP layer only glues it in), so the tests drive what it serves.
import { createHash } from 'node:crypto';

export type Support = { url: string; coffee: string | null; upi: string | null };

/** In index.html, where each piece goes (an HTML comment, so the page is whole without them). */
export const MARKS = { head: '<!--support:head-->', brand: '<!--support:brand-->', door: '<!--support:door-->', table: '<!--support:table-->' } as const;
/** The markers a page lacks (a build that dropped its comments couldn't carry support: towerd says so at boot). */
export const missingMarks = (html: string) => Object.values(MARKS).filter((m) => !html.includes(m));

// GitHub logins: letters, digits and single hyphens inside, at most 39
const LOGIN = /^\/sponsors\/[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/?$/;
const UPI_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,255}@[A-Za-z][A-Za-z0-9.-]{1,63}$/;
// Buy Me a Coffee pages: buymeacoffee.com/<name>, a name of letters, digits, _ . and -
const COFFEE = /^\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/?$/;

/** The config, checked. `problems` says what was refused, for the log; a refused URL means support is off. */
export function readSupport(env: Record<string, string | undefined>): { support: Support | null; problems: string[] } {
  const problems: string[] = [];
  const raw = (env.SPONSOR_URL ?? '').trim();
  if (!raw) {
    if ((env.SPONSOR_COFFEE ?? '').trim()) problems.push('SPONSOR_COFFEE needs SPONSOR_URL beside it: support stays off');
    return { support: null, problems };
  }
  let u: URL | null = null;
  try { u = new URL(raw); } catch { /* refused below */ }
  if (!u || u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password || !LOGIN.test(u.pathname)) {
    problems.push('SPONSOR_URL must be https://github.com/sponsors/<name>: support stays off');
    return { support: null, problems };
  }
  u.hash = '';
  const id = (env.SPONSOR_UPI ?? '').trim();
  if (id && !UPI_ID.test(id)) problems.push('SPONSOR_UPI must be a UPI ID like name@bank: left out');
  const cup = (env.SPONSOR_COFFEE ?? '').trim();
  let coffee: URL | null = null;
  if (cup) {
    try { coffee = new URL(cup); } catch { /* refused below */ }
    if (!coffee || coffee.protocol !== 'https:' || !['buymeacoffee.com', 'www.buymeacoffee.com'].includes(coffee.hostname) || coffee.port
      || coffee.username || coffee.password || coffee.search || !COFFEE.test(coffee.pathname)) {
      problems.push('SPONSOR_COFFEE must be https://buymeacoffee.com/<name>: left out');
      coffee = null;
    } else coffee.hash = '';
  }
  return { support: { url: u.href, coffee: coffee?.href ?? null, upi: id && UPI_ID.test(id) ? id : null }, problems };
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// leaving the site: says so to the eye (an arrow, drawn like the app's others) and to a screen reader (in words)
const OUT = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  + '<span class="vh"> (opens in a new tab)</span>';
const out = (href: string, label: string, cls = '') =>
  `<a${cls ? ` class="${cls}"` : ''} href="${attr(href)}" target="_blank" rel="noopener noreferrer">${label}${OUT}</a>`;
// The two ways to give, drawn as the app draws its icons (a line, in the text's colour): GitHub Sponsors' heart, and
// Buy Me a Coffee's cup. Each turns its own colour under a pointer or the keyboard's focus, and nowhere else.
const HEART = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13.4S2.3 10 2.3 6.1a3 3 0 0 1 5.7-1.6 3 3 0 0 1 5.7 1.6C13.7 10 8 13.4 8 13.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const CUP = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.3 2.6h5.4l.6 1.9H4.7zM3.9 4.5h8.2M4.7 4.5l.9 9h4.8l.9-9M5.2 8.4h5.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
type Way = { href: string; cls: string; icon: string; tip: string; said: string; word: string };
const ways = (s: Support): Way[] => [
  { href: s.url, cls: 'gh', icon: HEART, tip: 'Sponsor on GitHub', said: 'Sponsor Rounak on GitHub', word: 'Sponsor' },
  ...(s.coffee ? [{ href: s.coffee, cls: 'coffee', icon: CUP, tip: 'Buy me a coffee', said: 'Buy Rounak a coffee', word: 'Buy me a coffee' }] : []),
];
const NEW_TAB = '<span class="vh"> (opens in a new tab)</span>';
/** the icons alone (the corner, the table): a screen reader hears what each does, a pointer or focus shows its name */
const icons = (s: Support) => `<span class="gifts">${ways(s).map((w) =>
  `<a class="gift ${w.cls}" href="${attr(w.href)}" target="_blank" rel="noopener noreferrer" data-tip="${w.tip}">${w.icon}<span class="vh">${w.said}</span>${NEW_TAB}</a>`).join('')}</span>`;
/** each with its word (the door: a first visit reads what they are) */
const worded = (s: Support) => ways(s).map((w) =>
  `<a class="gift ${w.cls}" href="${attr(w.href)}" target="_blank" rel="noopener noreferrer">${w.icon}${w.word}${w.cls === 'gh' ? '<span class="vh"> Rounak on GitHub</span>' : ''}${NEW_TAB}</a>`).join(' · ');

// Matches the overlay's own language: --mute for quiet words, --ink for what you can act on, underlined so a link
// never depends on colour alone; the white focus ring the elevator uses. The credit lives in the letterbox at a
// table, the black bar below the picture, and only where the bar has room for it beside the hint and the controls
// (wider than 1180 px, where the hint is centred: exactly where the page's own `max-width: 1180px` rule stops). A phone's bars are already full (the title above, the controls
// below), so a phone meets it on the door. The door's line is `#splash #give`: the door styles its own paragraphs
// (`#splash p`, its description), and only a selector this specific keeps the line small and quiet beneath it.
const CSS = `<style>
#splash{grid-template-rows:1fr auto}
#splash #give{margin:0;padding:0 24px max(18px, env(safe-area-inset-bottom));max-width:min(100%, 720px);color:var(--mute);font-size:12.5px;line-height:1.5;text-align:center;text-wrap:balance}
#splash #give a{white-space:nowrap}
#give a,#credit a{color:var(--ink);text-decoration:underline;text-decoration-color:#efe9e059;text-underline-offset:3px}
#give a:hover,#credit a:hover{text-decoration-color:currentColor}
#give a:focus-visible,#credit a:focus-visible,.gifts .gift:focus-visible{outline:2px solid #fff;outline-offset:3px;border-radius:3px}
#credit{position:fixed;left:24px;bottom:calc(8.5vh / 2 - 9px);z-index:3;margin:0;color:var(--mute);font-size:12.5px;white-space:nowrap;visibility:hidden;opacity:0;transition:opacity .3s, visibility 0s .3s}
.gift svg{width:13px;height:13px;flex:none;transition:color .2s}
#give .gift{display:inline-flex;align-items:center;gap:5px}
#give .gift svg{color:var(--mute)}
.gift.gh:hover svg,.gift.gh:focus-visible svg,#give .gift.gh:hover svg,#give .gift.gh:focus-visible svg{color:#db61a2}
.gift.coffee:hover svg,.gift.coffee:focus-visible svg,#give .gift.coffee:hover svg,#give .gift.coffee:focus-visible svg{color:#ffdd00}
.gifts{display:inline-flex;align-items:center;gap:3px;margin-left:7px;vertical-align:-4px;letter-spacing:0;text-shadow:none}
.gifts .gift{position:relative;display:inline-flex;padding:6px;border-radius:999px;color:var(--mute);opacity:.7;pointer-events:auto;text-decoration:none;transition:opacity .2s}
.gifts .gift:hover,.gifts .gift:focus-visible{opacity:1}
.gifts .gift::after{content:attr(data-tip);content:attr(data-tip) / "";position:absolute;left:50%;top:calc(100% + 6px);transform:translate(-50%, -3px);padding:4px 9px;border-radius:7px;background:#0b0e18f0;color:var(--ink);font-size:12px;font-weight:500;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .15s, transform .15s}
.gifts .gift:hover::after,.gifts .gift:focus-visible::after{opacity:1;transform:translate(-50%, 0)}
#credit .gifts{margin-left:6px;vertical-align:-4px}
#credit .gifts .gift::after{top:auto;bottom:calc(100% + 6px);transform:translate(-50%, 3px)}
#credit .gifts .gift:hover::after,#credit .gifts .gift:focus-visible::after{transform:translate(-50%, 0)}
@media (hover: none) { .gifts .gift::after { display:none } }
body.door #brand .gifts,body[data-mode="table"] #brand .gifts{visibility:hidden}
@media (max-width: 700px), (hover: none) { body:not([data-mode="tower"]) #brand .gifts { visibility:hidden } }
@media not all and (max-width: 1180px) { body[data-mode="table"]:not(.reply-open) #credit { visibility:visible; opacity:1; transition:opacity .6s .5s } }
@media (max-height: 420px) { #splash #give { display:none } }
@media (prefers-reduced-motion: reduce) { #credit, body[data-mode="table"]:not(.reply-open) #credit { transition:none } .gift svg, .gifts .gift, .gifts .gift::after { transition:none } }
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
</style>`;

/** The client's index.html with the markers filled (support on) or emptied (off). */
export function withSupport(html: string, s: Support | null): string {
  const fill = s ? {
    head: CSS,
    brand: icons(s),
    door: `<p id="give">Made by Rounak · ${worded(s)}</p>`,
    table: `<p id="credit">Made by Rounak${icons(s)}</p>`,
  } : { head: '', brand: '', door: '', table: '' };
  // a function, not a string, as the replacement: in a string, `$&`, `$'` and `$\`` would act (a URL may hold a $)
  return html.replace(MARKS.head, () => fill.head).replace(MARKS.brand, () => fill.brand).replace(MARKS.door, () => fill.door).replace(MARKS.table, () => fill.table);
}

/** The page loads nothing but its icon, runs nothing and can't be framed; its one way out is a plain link. */
export const SUPPORT_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** /support: who makes it, what sponsoring pays for, how, and that it changes nothing. Static: no script at all. */
export function supportPage(s: Support): string {
  const coffee = s.coffee ? out(s.coffee, 'Buy me a coffee', 'go two') : '';
  const upi = s.upi
    ? `\n<p class="small">Paying from India? UPI works too: <a href="upi://pay?pa=${attr(encodeURIComponent(s.upi))}&amp;pn=Rounak%20Datta&amp;cu=INR">${text(s.upi)}</a></p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#070a14">
<meta name="description" content="Tower of HN is made by one person. Sponsor it on GitHub, monthly or once, in any amount.">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<title>Support Tower of HN</title>
<style>
:root{--ink:#efe9e0;--mute:#9aa3b6;--hn:#ff6a1a}
*{box-sizing:border-box}
html{background:#070a14}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:max(40px, env(safe-area-inset-top)) max(22px, env(safe-area-inset-right)) max(40px, env(safe-area-inset-bottom)) max(22px, env(safe-area-inset-left));
  background:radial-gradient(ellipse at 50% 90%, #24150b8c, #070a1400 62%) #070a14;color:#c8c1b6;font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:33rem}
.home{font-size:17px;font-weight:650;letter-spacing:.2px;color:#fff3ea;text-decoration:none;text-shadow:0 0 6px #ff9a6b8c, 0 0 18px #ff783c40}
.home i{font-style:normal;color:var(--hn);text-shadow:0 0 8px #ff5a0acc, 0 0 22px #ff5a0a59}
h1{margin:30px 0 16px;color:var(--ink);font-size:clamp(28px, 6vw, 40px);line-height:1.12;font-weight:700;letter-spacing:-.5px;text-wrap:balance}
p{margin:0 0 12px;text-wrap:pretty}
a{color:var(--ink);text-underline-offset:3px}
a:focus-visible{outline:2px solid #fff;outline-offset:3px;border-radius:4px}
.go{display:inline-flex;align-items:center;gap:8px;margin:16px 0 20px;padding:13px 24px 13px 26px;border-radius:999px;background:var(--ink);color:#111;font-size:15px;font-weight:700;text-decoration:none;box-shadow:0 10px 40px #ff8c3c40}
.go:hover{background:#fff}
.go:focus-visible{border-radius:999px}
.go svg{width:12px;height:12px}
.go.two{margin-left:8px;background:none;color:var(--ink);box-shadow:inset 0 0 0 1.5px #efe9e066}
.go.two:hover{background:#efe9e014}
.small{color:var(--mute);font-size:14px;text-wrap:balance}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
</style>
</head>
<body>
<main>
<a class="home" href="/">Tower <i>of</i> HN</a>
<h1>Support Tower&nbsp;of&nbsp;HN</h1>
<p>I’m Rounak Datta, and I build Tower&nbsp;of&nbsp;HN on my own. It runs on a few small servers that read the comments aloud.</p>
<p>Sponsorships pay for those servers, the domain, and the time it takes to keep making it better.</p>
<p>You can sponsor monthly or just once, with any amount, through GitHub Sponsors${s.coffee ? ', or buy me a coffee' : ''}.</p>
${out(s.url, 'Sponsor on GitHub', 'go')}${coffee}${upi}
<p class="small">Sponsoring is voluntary and unlocks nothing. Everyone hears the same tower.</p>
</main>
</body>
</html>
`;
}

/**
 * towerd's support, built once from the config: what /support answers, the client's page as served, and what /status
 * adds. Off (null), it answers nothing and changes nothing. Views are counted as towerd counts clips: a number since
 * start, nothing about who.
 */
export function supportSite(s: Support | null) {
  const page = s ? Buffer.from(supportPage(s)) : null;
  const tag = page ? `W/"${createHash('sha1').update(page).digest('base64url').slice(0, 16)}"` : '';   // weak, as /live's
  let views = 0, memo: { mtime: number; body: Buffer } | null = null;
  return {
    /** the page /support sends (null: off), for towerd to compress as it does any other */
    page,
    /** /support's answer to a GET or HEAD: null when off, or for any other path (the app answers those) */
    answer(method: string, path: string, ifNoneMatch?: string): { status: 200 | 304; headers: Record<string, string> } | null {
      if (!page || (path !== '/support' && path !== '/support/')) return null;
      if (method === 'GET') views++;
      const headers: Record<string, string> = { 'cache-control': 'no-cache', etag: tag, vary: 'accept-encoding' };
      if (ifNoneMatch === tag) return { status: 304, headers };
      return { status: 200, headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': SUPPORT_CSP, 'referrer-policy': 'strict-origin-when-cross-origin' } };
    },
    /** the client's index.html as served: rebuilt only when the file changes */
    index(f: { body: Buffer; mtime: number }): Buffer {
      if (memo?.mtime !== f.mtime) memo = { mtime: f.mtime, body: Buffer.from(withSupport(f.body.toString('utf8'), s)) };
      return memo.body;
    },
    /** what /status adds: nothing while off */
    status: () => (s ? { support: { views } } : {}),
  };
}
