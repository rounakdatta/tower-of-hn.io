// What the spoken-forms tables don't know yet, from real comments: the hosts linked most that are said by the
// fallback (split into words or spelled), and the capitalised names read as written. Grow spoken-data.ts from the
// top of each list, checking each new form with the engine (espeak via kokoro-onnx).
//
//   node packages/core/tools/speech-report.ts                  # the 30 front-page threads, live from HN
//   node packages/core/tools/speech-report.ts comments.json    # [{ "html": "...", "story": 1 }, ...]
import { readFileSync } from 'node:fs';
import { speakable } from '../src/speakable.ts';
import { linkName, sayHost } from '../src/spoken.ts';
import { SITES, LABELS, SUFFIXES, ACRONYMS, SAY, SAY_CI, SAID_AS_WORDS, WORDS } from '../src/spoken-data.ts';

type Row = { html: string; story?: number };
async function live(): Promise<Row[]> {
  const get = async (u: string) => (await fetch(u, { headers: { 'user-agent': 'towerofhn-speech-report' } })).json();
  const top: number[] = (await get('https://hacker-news.firebaseio.com/v0/topstories.json')).slice(0, 30);
  const rows: Row[] = [];
  const walk = (c: any, story: number) => { if (c.text && c.type === 'comment') rows.push({ html: c.text, story }); for (const k of c.children ?? []) walk(k, story); };
  for (const id of top) walk(await get(`https://hn.algolia.com/api/v1/items/${id}`), id);
  return rows;
}
const rows: Row[] = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : await live();

const common = new Set(WORDS.split(' ').slice(0, 30000));
/** the name of a host's site: "nypost" of nypost.com, "bbc" of www.bbc.co.uk */
const siteName = (host: string) => { const l = host.split('.'); return l.at(l.length > 2 && SUFFIXES.has(l.slice(-2).join('.')) ? -3 : -2) ?? ''; };
const known = (host: string) => { const l = host.split('.'); for (let i = 0; i < l.length - 1; i++) if (SITES[l.slice(i).join('.')]) return true; return false; };
const kinds = new Map<string, number>(), unknownHosts = new Map<string, number>(), names = new Map<string, Set<number | undefined>>();
let links = 0;
for (const r of rows) {
  for (const s of speakable(r.html).segments) {
    if (s.kind === 'link') {
      links++;
      let host = '';
      try { host = new URL(s.url).hostname.toLowerCase().replace(/^(?:www\d?|m|mobile|amp|old|new|np)\./, ''); } catch { /* not a URL */ }
      const kind = !host || linkName(s.url).name === 'a link' ? 'a link' : host === 'news.ycombinator.com' ? 'Hacker News' : known(host) ? 'site table'
        : LABELS.has(siteName(host)) ? 'domain names' : 'fallback';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (kind === 'fallback') unknownHosts.set(host, (unknownHosts.get(host) ?? 0) + 1);
    } else if (s.kind === 'say' || s.kind === 'quote') {
      for (const w of s.display.match(/(?<![\w.@/'’-])(?:[A-Z][A-Za-z0-9]*[A-Z0-9][A-Za-z0-9]*|[A-Z][a-z]{2,})(?![\w@/'’-])/g) ?? []) {
        if (ACRONYMS[w] || SAY[w] || SAY_CI[w.toLowerCase()] || SAID_AS_WORDS.has(w) || common.has(w.toLowerCase())) continue;
        if (/^[A-Z]{2,5}s?$|^[A-Z][a-z][A-Z]s?$/.test(w)) continue;   // capitals and "MoE": espeak spells them, or the rules do
        (names.get(w) ?? names.set(w, new Set()).get(w)!).add(r.story);
      }
    }
  }
}
const pct = (n: number) => `${((100 * n) / Math.max(1, links)).toFixed(1)}%`;
console.log(`${rows.length} comments, ${links} links: ` + [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${pct(n)}`).join(', '));
console.log('\nHosts said by the fallback, most linked first (add the wrong ones to LABELS or SITES):');
for (const [h, n] of [...unknownHosts].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${String(n).padStart(5)}  ${h.padEnd(34)} ${sayHost(h)}`);
console.log('\nNames read as written, by how many threads use them (check each with espeak; add the wrong ones to SAY or ACRONYMS):');
console.log([...names].map(([w, s]) => [w, s.size] as const).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 120).map(([w, n]) => `${w} ${n}`).join(', '));
