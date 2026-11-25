// What Hacker News will make of a comment, before you post it: its own formatting rules
// (https://news.ycombinator.com/formatdoc), applied the way HN's renderer applies them (Arc's `markdown`, plus the
// literal-asterisk and angle-bracket rules formatdoc adds). Used for the preview, and to recognise your reply when it
// lands (HN's API gives back its HTML, not your text).
//
//   blank lines separate paragraphs          → `<p>` (HN sends the first paragraph without one)
//   *text*                                   → italics; `\*` or `**` is a literal asterisk
//   after a blank line, indented 2+ spaces   → verbatim (code), until a line that starts with a non-space
//   http:// and https:// urls                → links, shown cut to 60 characters with "..."
//   <url>                                    → the url exactly as bracketed
//
// The output is built from escaped text only: nothing you type can become markup of ours.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]!));
const MAXURL = 60;
const PUNC = '.,;:!?\'"';

/** Where a url that starts at `i` ends (exclusive): at whitespace, or before trailing punctuation and an unmatched
 *  closing bracket (so "(see https://x.y/z)." links x.y/z). */
function urlEnd(s: string, i: number) {
  let j = i;
  while (j < s.length && !/\s/.test(s[j]) && s[j] !== '<' && s[j] !== '>') j++;
  for (;;) {
    const c = s[j - 1];
    if (PUNC.includes(c)) { j--; continue; }
    if (c === ')' || c === ']') {
      const u = s.slice(i, j), open = c === ')' ? '(' : '[';
      if (u.split(open).length < u.split(c).length) { j--; continue; }
    }
    return j;
  }
}
function link(url: string) {
  const shown = url.length > MAXURL ? url.slice(0, MAXURL) + '...' : url;
  return `<a href="${esc(url)}" rel="nofollow noopener noreferrer" target="_blank">${esc(shown)}</a>`;
}

/** One paragraph's inline formatting: italics, literal asterisks, links. */
function inline(s: string) {
  let out = '', ital = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '*') { out += '*'; i++; continue; }
    if (c === '*' && s[i + 1] === '*') { out += '*'; i++; continue; }
    if (c === '*' && (ital || (s[i + 1] !== undefined && !/\s/.test(s[i + 1]) && s.indexOf('*', i + 1) > 0))) {
      out += ital ? '</i>' : '<i>'; ital = !ital; continue;
    }
    if (c === '<' && /^<https?:\/\/[^\s<>]+>/.test(s.slice(i))) {
      const end = s.indexOf('>', i);
      out += '&lt;' + link(s.slice(i + 1, end)) + '&gt;'; i = end; continue;
    }
    if ((c === 'h') && /^https?:\/\//.test(s.slice(i, i + 8))) {
      const end = urlEnd(s, i);
      if (end > i + 8) { out += link(s.slice(i, end)); i = end - 1; continue; }
    }
    out += esc(c);
  }
  return ital ? out + '</i>' : out;
}

/** The comment as HN will show it, as HTML that is safe to put in our page. */
export function hnHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
  const out: string[] = [];
  let para: string[] = [], code: string[] | null = null, afterBlank = true;
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join('\n').trim())}</p>`); para = []; };
  const shut = () => { if (code) out.push(`<pre><code>${esc(code.join('\n').replace(/\n+$/, ''))}</code></pre>`); code = null; };
  for (const line of lines) {
    const blank = !line.trim();
    if (code) {
      if (blank || /^\s/.test(line)) { code.push(line); continue; }
      shut();
    }
    if (blank) { flush(); afterBlank = true; continue; }
    if (afterBlank && /^ {2,}|^\t/.test(line)) { flush(); code = [line]; afterBlank = false; continue; }
    para.push(line);
    afterBlank = false;
  }
  flush(); shut();
  return out.join('');
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** HN's comment HTML (as its API returns it) as plain text: paragraphs kept, tags out, entities decoded. */
export function hnPlain(html: string): string {
  return html.replace(/<p>/gi, '\n\n').replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ENT[e.toLowerCase()] ?? m)
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** The words of a comment, for recognising it: letters and digits only, urls left out (HN shortens them). */
export function skeleton(plain: string): string {
  return plain.replace(/https?:\/\/\S+/g, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
/** Your words, as they will read once HN has formatted them (for comparing with what its API returns). */
export const asPosted = (text: string) => skeleton(hnPlain(hnHtml(text)));

/** words in common, as a share of both (a typo fixed on HN still matches; someone else's reply doesn't) */
function overlap(a: string[], b: string[]) {
  const n = new Map<string, number>();
  for (const w of a) n.set(w, (n.get(w) ?? 0) + 1);
  let same = 0;
  for (const w of b) { const k = n.get(w); if (k) { same++; n.set(w, k - 1); } }
  return (2 * same) / (a.length + b.length || 1);
}
/** Yours? By name, if we know it; else by your words (HN formats them, and its API gives back its HTML). */
export function yours(c: { by?: string; text?: string }, text: string, me: string): 'name' | 'words' | 'exact' | '' {
  if (me && c.by === me) return 'name';
  if (!c.text || c.text === '[delayed]') return '';
  const a = asPosted(text), b = skeleton(hnPlain(c.text));
  if (a && a === b) return 'exact';
  const wa = a.split(' '), wb = b.split(' ');
  return wa.length >= 5 && wb.length >= 5 && overlap(wa, wb) >= 0.8 ? 'words' : '';
}
