// Speakability: HN comment HTML -> what we voice and what we show.
// The rule is "verbatim words": nothing a person wrote is paraphrased.
// Only things that cannot be spoken become objects in the scene
// (links -> placards, code -> chalk on the table) and quotes of the parent
// become references, so the client can replay the parent's own voice.

export type Segment =
  | { kind: 'say'; text: string; display: string }
  | { kind: 'quote'; text: string; display: string; of?: number }
  | { kind: 'link'; url: string; domain: string; text: string }
  | { kind: 'code'; code: string; lines: number; text: string };

export interface Speakable {
  segments: Segment[];
  /** plain text for subtitles and search, paragraphs separated by blank lines */
  display: string;
  /** characters that will be synthesised (cost driver) */
  spokenChars: number;
}

/** Pronunciation respellings for words TTS models get wrong. Grows over time; reviewed once, reused forever. */
export const LEXICON: Record<string, string> = {
  nginx: 'engine-x', Nginx: 'Engine-x', NGINX: 'Engine-x', kubectl: 'kube-control', k8s: 'kubernetes', K8s: 'Kubernetes',
  SQLite: 'S-Q-Lite', PostgreSQL: 'Postgres-Q-L', MySQL: 'My-S-Q-L', NoSQL: 'No-S-Q-L', GraphQL: 'Graph-Q-L', SQL: 'S-Q-L',
  UB: 'U.B.', CVE: 'C.V.E.', LLM: 'L.L.M.', LLMs: 'L.L.M.s', YC: 'Y.C.', HN: 'H.N.', SaaS: 'sass', OAuth: 'Oh-auth',
  JSON: 'Jason', YAML: 'yammel', TOML: 'tommel', GIF: 'gif', CLI: 'C.L.I.', GUI: 'gooey', IDE: 'I.D.E.', API: 'A.P.I.', APIs: 'A.P.I.s',
  ssh: 'S.S.H.', SSH: 'S.S.H.', sudo: 'soo-doo', vim: 'vim', Wasm: 'wazm', WASM: 'wazm', WebGPU: 'Web G.P.U.', GPU: 'G.P.U.', GPUs: 'G.P.U.s',
  CPU: 'C.P.U.', CPUs: 'C.P.U.s', eBPF: 'E.B.P.F.', CUDA: 'cooda', SIMD: 'sim-D', x86: 'x eighty-six', ARM64: 'arm sixty-four',
  'RISC-V': 'risk five', iOS: 'eye-O.S.', macOS: 'mac-O.S.', GNU: 'guh-new', LaTeX: 'lah-tek', TeX: 'tek', PyPI: 'pie-P.I.',
  npm: 'N.P.M.', pnpm: 'P.N.P.M.', uv: 'U.V.', Deno: 'dee-no', ffmpeg: 'F.F.mpeg', systemd: 'system-D', regex: 'rej-ex',
  'C++': 'C plus plus', 'C#': 'C sharp', 'F#': 'F sharp', '.NET': 'dot net', AWS: 'A.W.S.', GCP: 'G.C.P.', TLS: 'T.L.S.',
  IIRC: 'if I recall correctly', AFAIK: 'as far as I know', IMO: 'in my opinion', IMHO: 'in my humble opinion', TFA: 'the article',
  YMMV: 'your mileage may vary', FWIW: 'for what it\'s worth', TIL: 'today I learned', IANAL: 'I am not a lawyer', OP: 'O.P.',
  TBH: 'to be honest', LOL: 'L.O.L.', ICYMI: 'in case you missed it',
};

const ENTITIES: Record<string, string> = { '&gt;': '>', '&lt;': '<', '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&#x2F;': '/', '&nbsp;': ' ' };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m) => ENTITIES[m] ?? (m.startsWith('&#x') ? String.fromCodePoint(parseInt(m.slice(3, -1), 16)) : m.startsWith('&#') ? String.fromCodePoint(parseInt(m.slice(2, -1), 10)) : m));
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LEX_RE = new RegExp(`(?<![\\w-])(${Object.keys(LEXICON).sort((a, b) => b.length - a.length).map(esc).join('|')})(?![\\w+#-])`, 'g');

export function respell(text: string): string {
  return text
    .replace(/\bCVE-(\d{4})-(\d+)/g, 'C.V.E. $1, $2')
    .replace(LEX_RE, (w) => LEXICON[w] ?? w);
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'a link'; }
}

/** Inline HTML of one paragraph -> spoken text, display text, and link objects found in it. */
function inline(htmlPara: string, links: Segment[]): { spoken: string; display: string } {
  let spoken = '', display = '';
  const re = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<i>([\s\S]*?)<\/i>|<code>([\s\S]*?)<\/code>|<[^>]+>|([^<]+)/g;
  for (let m; (m = re.exec(htmlPara));) {
    if (m[1] !== undefined) {
      const url = decode(m[1]), d = domainOf(url);
      links.push({ kind: 'link', url, domain: d, text: decode(m[2].replace(/<[^>]+>/g, '')) });
      spoken += ` (link: ${d}) `; display += decode(m[2].replace(/<[^>]+>/g, ''));
    } else if (m[3] !== undefined) {                       // HN italics are how people emphasise
      const t = decode(m[3].replace(/<[^>]+>/g, ''));
      spoken += `(((${t})))`; display += t;
    } else if (m[4] !== undefined) {
      const t = decode(m[4]);
      spoken += t.split(/\s+/).length <= 4 ? t : ' this snippet '; display += t;
    } else if (m[5] !== undefined) {
      const t = decode(m[5]);
      spoken += t.replace(/`([^`]{1,40})`/g, '$1'); display += t;
    }
  }
  return { spoken: spoken.replace(/\s+/g, ' ').trim(), display: display.replace(/\s+/g, ' ').trim() };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Does `quote` come from `parentText`? Token-overlap containment, robust to small edits. */
export function quotes(quote: string, parentText: string): boolean {
  const q = norm(quote).split(' ').filter((w) => w.length > 2), p = new Set(norm(parentText).split(' '));
  if (q.length < 3) return norm(parentText).includes(norm(quote));
  return q.filter((w) => p.has(w)).length / q.length >= 0.8;
}

export function speakable(html: string, parent?: { id: number; text: string }): Speakable {
  const segments: Segment[] = [];
  const blocks = html.split(/(<pre><code>[\s\S]*?<\/code><\/pre>)/);
  const parentPlain = parent ? decode(parent.text.replace(/<[^>]+>/g, ' ')) : '';
  for (const block of blocks) {
    if (!block) continue;
    const pre = block.match(/^<pre><code>([\s\S]*?)<\/code><\/pre>$/);
    if (pre) {
      const code = decode(pre[1]).replace(/\n+$/, '');
      const lines = code.split('\n').length;
      segments.push({ kind: 'code', code, lines, text: lines === 1 ? 'one line of code' : `${lines} lines of code` });
      continue;
    }
    for (const para of block.split(/<p>/)) {
      const links: Segment[] = [];
      const { spoken, display } = inline(para, links);
      if (!display && !links.length) continue;
      const isQuote = /^(>|“|")/.test(display) && display.length > 3;
      if (isQuote && display.startsWith('>')) {
        const text = display.replace(/^>\s*/, '');
        const of = parent && quotes(text, parentPlain) ? parent.id : undefined;
        segments.push({ kind: 'quote', text: respell(spoken.replace(/^>\s*/, '')), display: text, of });
      } else if (spoken.replace(/\(link: [^)]+\)/g, '').trim() === '' && links.length) {
        segments.push(...links);                            // a bare link: just the placard
        continue;
      } else {
        segments.push({ kind: 'say', text: respell(spoken), display });
      }
      segments.push(...links);
    }
  }
  const display = segments.map((s) => (s.kind === 'say' || s.kind === 'quote' ? (s.kind === 'quote' ? '> ' : '') + s.display : s.kind === 'code' ? s.code : s.url)).join('\n\n');
  const spokenChars = segments.reduce((n, s) => n + (s.kind === 'say' || (s.kind === 'quote' && s.of === undefined) ? s.text.length : s.kind === 'code' ? s.text.length : 0), 0);
  return { segments, display, spokenChars };
}

/** Sentences of a 'say' segment, for per-sentence emotion tags. Conservative about abbreviations. */
export function sentences(text: string): string[] {
  const parts = text.replace(/\b(e\.g|i\.e|vs|etc|approx|cf|Mr|Ms|Dr|U\.S)\./g, (m) => m.replace(/\./g, '․')).split(/(?<=[.!?])\s+(?=[A-Z0-9("'])/);
  return parts.map((p) => p.replace(/․/g, '.').trim()).filter(Boolean);
}
