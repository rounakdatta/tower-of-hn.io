// Posts a reply to Hacker News as you, with your own session (the browser's cookies for news.ycombinator.com, which
// this extension may use because of its host permission). We never see your password or your cookie: the request
// goes from your browser to Hacker News, exactly as HN's own reply form would send it.
//
// Nothing posts without you: each request opens a small window of the extension's own showing the words and where
// they go, and only its Post button sends them (a page, even a compromised one, can only ask).
const HN = 'https://news.ycombinator.com';
const pending = new Map();                             // confirmation id -> { parent, story, text, reply }
const windowOf = new Map();                            // its confirmation window -> confirmation id

async function whoami() {
  // the account HN thinks you're logged in as (its top bar links to your user page)
  const html = await (await fetch(`${HN}/news`, { credentials: 'include' })).text();
  return /<a id="me" href="user\?id=([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? '';
}

/** HN's HTML as plain words: tags out, every entity decoded, spaces collapsed (to compare with what you said) */
function words(html) {
  return html.replace(/<p>/gi, ' ').replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
/** The words alone: letters and digits, links left out (HN formats *this* as italics, and shortens long links) */
const skeleton = (s) => s.replace(/https?:\/\/\S+/g, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Already there? A post that timed out may have landed (HN returns no comment id): your reply under that comment,
 *  in the last quarter of an hour, with these words. Only then is a retry skipped. */
async function already(parent, user, text) {
  if (!user) return false;
  const API = 'https://hacker-news.firebaseio.com/v0', want = skeleton(text), since = Date.now() / 1000 - 900;
  const kids = (await (await fetch(`${API}/item/${parent}.json`)).json())?.kids ?? [];
  for (const k of kids.slice(0, 80)) {
    const it = await (await fetch(`${API}/item/${k}.json`)).json();
    if (it?.by !== user || !it.text || (it.time ?? 0) < since) continue;
    if (skeleton(words(it.text)) === want) return true;
  }
  return false;
}

async function post({ parent, story, text }) {
  const user = await whoami().catch(() => '');
  if (await already(parent, user, text).catch(() => false)) return { ok: true };
  // HN's own reply page for that comment carries the one-time token its form needs
  const page = await (await fetch(`${HN}/reply?id=${parent}&goto=${encodeURIComponent(`item?id=${story}#${parent}`)}`, { credentials: 'include' })).text();
  if (/name="acct"/.test(page)) return { ok: false, error: 'Log in to Hacker News in this browser first' };
  const hmac = /name="hmac" value="([^"]+)"/.exec(page)?.[1];
  if (!hmac) return { ok: false, error: 'Hacker News didn’t offer a reply form for that comment' };
  const body = new URLSearchParams({ parent: String(parent), goto: `item?id=${story}#${parent}`, hmac, text });
  let r = await fetch(`${HN}/comment`, { method: 'POST', credentials: 'include', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  let out = await r.text();
  // HN sometimes asks to confirm a resubmission (/x?fnop=commconfirm): its page carries the form again; send it once
  if (r.url.includes('fnop=commconfirm')) {
    const again = new URLSearchParams();
    for (const m of out.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) again.set(m[1], m[2].replace(/&amp;/g, '&'));
    if (again.has('hmac')) {
      again.set('text', text);
      r = await fetch(`${HN}/comment`, { method: 'POST', credentials: 'include', body: again, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      out = await r.text();
    }
  }
  // success lands on the thread (whatever the thread itself says); anything else is HN explaining why not, often as
  // a bare line of text: its own words, when they're short enough to be a message
  if (r.url.includes('item?id=')) return { ok: true };
  const said = words(out.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<(br|p|td|tr|div)\b[^>]*>/gi, ' '));
  const known = /You're posting too fast[^.]*\.(?: Please slow down\.)?(?: Thanks\.)?|Unknown or expired link\.|You have to be logged in to comment\.|Please try again\.|Validation required\.|Sorry, we're not able to serve your requests this quickly\.|No such item\./.exec(said);
  return { ok: false, error: known?.[0] ?? (said && said.length <= 160 ? said : 'Hacker News didn’t take it') };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.kind === 'whoami') { whoami().then((user) => reply({ user }), () => reply({ user: '' })); return true; }
  if (msg.kind === 'post') {
    const id = crypto.randomUUID();
    pending.set(id, { ...msg, reply });
    chrome.windows.create({ url: `confirm.html#${id}`, type: 'popup', width: 420, height: 380 }).then((w) => windowOf.set(w.id, id), () => {});
    return true;                                       // the answer comes when you decide (or close the window)
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
// closing the confirmation window without deciding is a no (the page is told, instead of waiting forever)
chrome.windows.onRemoved.addListener((wid) => {
  const id = windowOf.get(wid);
  windowOf.delete(wid);
  const p = id && pending.get(id);
  if (p) { pending.delete(id); p.reply({ ok: false, error: 'Not posted' }); }
});
