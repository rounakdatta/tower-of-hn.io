// Speakability: HN comment HTML -> what we voice and what we show.
// The rule is "verbatim words": nothing a person wrote is paraphrased. What is written but not said that way is said
// the way a person would say it (spoken.ts: "$1.2T" is "1.2 trillion dollars", a link is the site it goes to).
// Code becomes an object in the scene (chalk on the table), and quotes of the parent become references, so the
// client can replay the parent's own voice.

import { spoken, LinkVoice } from './spoken.ts';

export type Segment =
  /** text: what is said, one line per sentence of `display` (the voice and the subtitles stay in step) */
  | { kind: 'say'; text: string; display: string }
  | { kind: 'quote'; text: string; display: string; of?: number }
  /** say: what is said for it where it stands alone ('' when it was said where it stood, or with the links before it) */
  | { kind: 'link'; url: string; domain: string; text: string; say?: string }
  | { kind: 'code'; code: string; lines: number; text: string };

export interface Speakable {
  segments: Segment[];
  /** plain text for subtitles and search, paragraphs separated by blank lines */
  display: string;
  /** characters that will be synthesised (cost driver) */
  spokenChars: number;
}

const ENTITIES: Record<string, string> = { '&gt;': '>', '&lt;': '<', '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&#x2F;': '/', '&nbsp;': ' ' };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m) => ENTITIES[m] ?? (m.startsWith('&#x') ? String.fromCodePoint(parseInt(m.slice(3, -1), 16)) : m.startsWith('&#') ? String.fromCodePoint(parseInt(m.slice(2, -1), 10)) : m));

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'a link'; }
}

/**
 * Sentences as the voice runner splits a segment's display text (worker.py `sentences`, kept identical): a full
 * stop, question or exclamation mark, then a space and a capital, digit, bracket or quote. Common abbreviations
 * don't end one.
 */
const PROTECT = /\b(e\.g|i\.e|eg|ie|vs|etc|cf|esp|incl|al|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|approx|U\.S|a\.m|p\.m)\./g;
const SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9("'])/;
export function sentences(text: string): string[] {
  return text.replace(PROTECT, (m) => m.replace(/\./g, '․')).split(SPLIT).map((p) => p.replace(/․/g, '.').trim()).filter(Boolean);
}
/** [start, end) of each sentence of `d` (as `sentences` splits it) */
function spans(d: string): [number, number][] {
  const out: [number, number][] = [];
  const t = d.replace(PROTECT, (m) => m.replace(/\./g, '․')), re = new RegExp(SPLIT.source, 'g');
  let a = 0;
  for (let m; (m = re.exec(t));) { out.push([a, m.index]); a = m.index + m[0].length; }
  out.push([a, d.length]);
  return out.filter(([x, y]) => d.slice(x, y).trim());
}

// Markers (private-use characters) carry what a paragraph knows into its text: a link and its anchor text, emphasis,
// code. The display is the text without them; the spoken form is made from the text with them.
const LINK = '\uE000', LINK_END = '\uE001', EM = '\uE002', EM_END = '\uE003', CODE = '\uE004', CODE_END = '\uE005';

/** Inline HTML of one paragraph -> its text with markers, the display text, and the links found in it. */
function inline(htmlPara: string, links: Extract<Segment, { kind: 'link' }>[]) {
  let raw = '';
  const re = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<i>([\s\S]*?)<\/i>|<code>([\s\S]*?)<\/code>|<[^>]+>|([^<]+)/g;
  const clean = (t: string) => t.replace(/[\uE000-\uE005]/g, '');
  for (let m; (m = re.exec(htmlPara));) {
    if (m[1] !== undefined) {
      const url = decode(m[1]), text = decode(m[2].replace(/<[^>]+>/g, ''));
      links.push({ kind: 'link', url, domain: domainOf(url), text });
      raw += LINK + clean(text) + LINK_END;
    } else if (m[3] !== undefined) {                       // HN italics are how people emphasise
      raw += EM + clean(decode(m[3].replace(/<[^>]+>/g, ''))) + EM_END;
    } else if (m[4] !== undefined) {
      raw += CODE + clean(decode(m[4])) + CODE_END;
    } else if (m[5] !== undefined) {
      raw += clean(decode(m[5])).replace(/`([^`\n]{1,40})`/g, `${CODE}\`$1\`${CODE_END}`);
    }
  }
  // whitespace (as JavaScript or Python reads it: the runner splits sentences in Python) becomes single spaces, and
  // where markers meet a space, what closes goes before it and what opens after it ("(((ever))) helped"), so the
  // display (the text without them) never has two spaces in a row
  const marked = raw.replace(/[\s\x1c-\x1f\x85]+/g, ' ').replace(/ ?((?:[\uE000-\uE005] ?)*[\uE000-\uE005]) ?/g, (m, k: string) => {
    if (!m.includes(' ') || /[\uE000\uE002\uE004][^\uE001\uE003\uE005]*[\uE001\uE003\uE005]/.test(k)) return m;
    return k.replace(/[ \uE000\uE002\uE004]/g, '') + ' ' + k.replace(/[ \uE001\uE003\uE005]/g, '');
  }).replace(/^ /, '').replace(/ $/, '');
  return { marked, display: marked.replace(/[\uE000-\uE005]/g, '') };
}

const isMark = (c: number) => c >= 0xe000 && c <= 0xe005;
const opens = (c: number) => c === 0xe000 || c === 0xe002 || c === 0xe004;
const closes = (c: number) => c === 0xe001 || c === 0xe003 || c === 0xe005;
/** A paragraph's sentences, said: one line per sentence of its display (from `from`, past a quote's "> "). */
function say(marked: string, display: string, from: number, voice: LinkVoice, urls: string[]): string {
  const lines: string[] = [];
  let mi = 0, di = 0;                                       // a cursor through the marked text and the display together
  const pos = (d: number) => {                               // where display[d] sits in the marked text (d only grows)
    for (;;) {
      while (mi < marked.length && isMark(marked.charCodeAt(mi))) mi++;
      if (di === d) return mi;
      mi++; di++;
    }
  };
  for (const [a, b] of spans(display.slice(from))) {
    let x = pos(from + a);
    const last = pos(from + b - 1);
    let y = last + 1;
    while (x > 0 && opens(marked.charCodeAt(x - 1))) x--;  // a link or emphasis opening right before goes with it
    while (y < marked.length && closes(marked.charCodeAt(y))) y++;
    let m = marked.slice(x, y);
    if (m.indexOf(EM) >= 0 || m.indexOf(EM_END) >= 0) {     // emphasis a sentence break cut in two: closed and reopened
      const o = m.split(EM).length - 1, c = m.split(EM_END).length - 1;
      if (c > o || (c === o && m.indexOf(EM_END) < m.indexOf(EM))) m = EM + m;
      if (m.split(EM).length > m.split(EM_END).length) m += EM_END;
    }
    const t = spoken(m, { link: () => voice.inline(urls.shift() ?? '') });
    const u = t.indexOf(EM) < 0 && t.indexOf(EM_END) < 0 ? t : t.replaceAll(EM, '(((').replaceAll(EM_END, ')))');
    lines.push((/[\uE000-\uE005]|\s\s/.test(u) ? u.replace(/[\uE000-\uE005]/g, '').replace(/\s+/g, ' ') : u).trim() || '…');
  }
  return lines.join('\n');
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Does `quote` come from `parentText`? Token-overlap containment, robust to small edits. */
export function quotes(quote: string, parentText: string): boolean {
  const q = norm(quote).split(' ').filter((w) => w.length > 2), p = new Set(norm(parentText).split(' '));
  if (q.length < 3) return norm(parentText).includes(norm(quote));
  return q.filter((w) => p.has(w)).length / q.length >= 0.8;
}

/** a paragraph that is nothing but links (and footnote marks, bullets, numbering): its links stand alone */
const bare = (marked: string) => !marked.replace(/\uE000[^\uE001]*\uE001/g, '').replace(/[\uE002-\uE005]/g, '')
  .replace(/\[\d{1,3}\]|^\s*(?:\d{1,2}[.):]|[-*•])/g, '').replace(/[\s()<>\[\]:;,.\-–—*•|^]+/g, '');

export function speakable(html: string, parent?: { id: number; text: string }): Speakable {
  const segments: Segment[] = [];
  const voice = new LinkVoice();
  let alone: Extract<Segment, { kind: 'link' }>[] = [];
  const flush = () => {                                     // links standing alone in a row: said together, once
    if (!alone.length) return;
    alone[0].say = voice.alone(alone.map((l) => l.url));
    for (const l of alone.slice(1)) l.say = '';
    alone = [];
  };
  const blocks = html.split(/(<pre><code>[\s\S]*?<\/code><\/pre>)/);
  const parentPlain = parent ? decode(parent.text.replace(/<[^>]+>/g, ' ')) : '';
  for (const block of blocks) {
    if (!block) continue;
    const pre = block.match(/^<pre><code>([\s\S]*?)<\/code><\/pre>$/);
    if (pre) {
      flush();
      const code = decode(pre[1]).replace(/\n+$/, '');
      const lines = code.split('\n').length;
      segments.push({ kind: 'code', code, lines, text: lines === 1 ? 'one line of code' : `${lines} lines of code` });
      continue;
    }
    for (const para of block.split(/<p>/)) {
      const links: Extract<Segment, { kind: 'link' }>[] = [];
      const { marked, display } = inline(para, links);
      if (!display && !links.length) continue;
      if (links.length && bare(marked)) { alone.push(...links); segments.push(...links); continue; }
      flush();
      const urls = links.map((l) => l.url);
      const isQuote = /^(>|“|")/.test(display) && display.length > 3;
      if (isQuote && display.startsWith('>')) {
        const from = /^>\s*/.exec(display)![0].length, text = display.slice(from);
        const of = parent && quotes(text, parentPlain) ? parent.id : undefined;
        let said = say(marked, display, from, voice, urls);
        if (of === undefined) {                             // in their own voice: say it's a quote, and where it ends
          const prev = segments[segments.length - 1];
          if (prev?.kind === 'quote' && prev.of === undefined) prev.text = prev.text.replace(/ End quote\.$/, '');
          else said = 'Quote: ' + said;
          said += ' End quote.';
        }
        segments.push({ kind: 'quote', text: said, display: text, of });
      } else {
        segments.push({ kind: 'say', text: say(marked, display, 0, voice, urls), display });
      }
      for (const l of links) l.say = '';                    // said where it stood
      segments.push(...links);
    }
  }
  flush();
  const display = segments.map((s) => (s.kind === 'say' || s.kind === 'quote' ? (s.kind === 'quote' ? '> ' : '') + s.display : s.kind === 'code' ? s.code : s.url)).join('\n\n');
  const spokenChars = segments.reduce((n, s) => n + (s.kind === 'say' || (s.kind === 'quote' && s.of === undefined) ? s.text.length : s.kind === 'code' ? s.text.length : s.kind === 'link' ? (s.say ?? '').length : 0), 0);
  return { segments, display, spokenChars };
}
