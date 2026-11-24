// Run the speakability layer over every comment on the live front page.
import { speakable, LEXICON } from '../../packages/core/src/speakable.ts';
const UA = { 'User-Agent': 'towerofhn-survey/0.1' };
const top: number[] = (await (await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { headers: UA })).json()).slice(0, 30);
const trees = await Promise.all(top.map(async (id) => (await fetch(`https://hn.algolia.com/api/v1/items/${id}`, { headers: UA })).json()));
let n = 0, links = 0, code = 0, quotes = 0, quotesOfParent = 0, emph = 0, chars = 0, spoken = 0;
const jargon = new Map<string, number>();
const known = new Set(Object.keys(LEXICON));
function walk(c: any, parent?: any) {
  if (c.text && c.author) {
    n++;
    const s = speakable(c.text, parent?.text ? { id: parent.id, text: parent.text } : undefined);
    chars += c.text.length; spoken += s.spokenChars;
    if (s.segments.some((x) => x.kind === 'link')) links++;
    if (s.segments.some((x) => x.kind === 'code')) code++;
    const q = s.segments.filter((x) => x.kind === 'quote');
    if (q.length) quotes++;
    if (q.some((x: any) => x.of)) quotesOfParent++;
    if (s.segments.some((x: any) => x.kind === 'say' && x.text.includes('((('))) emph++;
    for (const w of s.display.match(/\b[A-Za-z][A-Za-z0-9+#.-]*[A-Za-z0-9+#]\b/g) ?? []) {
      const odd = /[A-Z].*[A-Z]|[a-z][A-Z]|\d|[+#]/.test(w) && w.length <= 14 && !/^(I|A)$/.test(w);
      if (odd && !known.has(w)) jargon.set(w, (jargon.get(w) ?? 0) + 1);
    }
  }
  for (const k of c.children ?? []) walk(k, c.text ? c : parent);
}
for (const t of trees) for (const k of t.children ?? []) walk(k);
const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`;
console.log(JSON.stringify({ comments: n, withLink: pct(links), withCodeBlock: pct(code), withQuote: pct(quotes), quotingParent: pct(quotesOfParent), withEmphasis: pct(emph), spokenVsRaw: (spoken / chars).toFixed(2) }));
console.log('top jargon not yet in the lexicon:', [...jargon].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([w, c]) => `${w}:${c}`).join(' '));
