// Posts a reply to Hacker News as you, with your own session (the browser's cookies for news.ycombinator.com, which
// this extension may use because of its host permission). We never see your password or your cookie: the request
// goes from your browser to Hacker News, exactly as HN's own reply form would send it.
//
// Nothing posts without you: each request opens a small window of the extension's own showing the words and where
// they go, and only its Post button sends them (a page, even a compromised one, can only ask).
const HN = 'https://news.ycombinator.com';
const pending = new Map();                             // confirmation id -> { parent, story, text, reply }

async function whoami() {
  // the account HN thinks you're logged in as (its top bar links to your user page)
  const html = await (await fetch(`${HN}/news`, { credentials: 'include' })).text();
  return /<a id="me" href="user\?id=([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? '';
}

async function post({ parent, story, text }) {
  // HN's own reply page for that comment carries the one-time token its form needs
  const page = await (await fetch(`${HN}/reply?id=${parent}&goto=${encodeURIComponent(`item?id=${story}#${parent}`)}`, { credentials: 'include' })).text();
  if (/name="acct"/.test(page)) return { ok: false, error: 'Log in to Hacker News in this browser first' };
  const hmac = /name="hmac" value="([^"]+)"/.exec(page)?.[1];
  if (!hmac) return { ok: false, error: 'Hacker News didn’t offer a reply form for that comment' };
  const body = new URLSearchParams({ parent: String(parent), goto: `item?id=${story}#${parent}`, hmac, text });
  const r = await fetch(`${HN}/comment`, { method: 'POST', credentials: 'include', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const out = await r.text();
  // success lands on the thread; anything else is HN explaining (posting too fast, a duplicate, a dead thread)
  if (r.url.includes('item?id=') && !/posting too fast|you can't post/i.test(out)) return { ok: true };
  const why = /<td[^>]*>([^<]{8,160})<\/td>/.exec(out)?.[1]?.trim();
  return { ok: false, error: why || 'Hacker News didn’t take it' };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.kind === 'whoami') { whoami().then((user) => reply({ user }), () => reply({ user: '' })); return true; }
  if (msg.kind === 'post') {
    const id = crypto.randomUUID();
    pending.set(id, { ...msg, reply });
    chrome.windows.create({ url: `confirm.html#${id}`, type: 'popup', width: 420, height: 380 });
    return true;                                       // the answer comes when you decide
  }
  if (msg.kind === 'confirm-get') { const p = pending.get(msg.id); reply(p ? { parent: p.parent, story: p.story, text: p.text } : null); return; }
  if (msg.kind === 'confirm') {
    const p = pending.get(msg.id);
    if (!p) { reply({ ok: false }); return; }
    pending.delete(msg.id);
    if (!msg.yes) { p.reply({ ok: false, error: 'Not posted' }); reply({ ok: true }); return; }
    post(p).then((r) => { p.reply(r); reply(r); }, (e) => { const r = { ok: false, error: String(e).slice(0, 120) }; p.reply(r); reply(r); });
    return true;
  }
});
