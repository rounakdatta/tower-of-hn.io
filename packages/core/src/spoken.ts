// Spoken forms: a comment's text as someone who knows the subject would read it aloud. "$1.2T" is "1.2 trillion
// dollars", "e.g." is "for example", "~5%" is "about 5%", and a link is where it goes ("a GitHub link", "N-Y Post dot
// com", "nin dot fan"), never its path. docs/SPEECH.md has the design and the evidence.
//
// Why the text, not the engine: Kokoro reads through espeak-ng, and kokoro-onnx hands it plain text (no SSML, no
// lexicon). espeak reads a written form literally ("dollar one point two T") and takes a dot inside a name for a
// full stop ("nypost. com"). So what the engine gets is already the spoken form, which also suits any other engine.
//
// Pure and deterministic, no I/O. One regex pass over a sentence: every pattern is linear (no nested quantifiers,
// bounded look-arounds), so whatever a commenter types costs time in proportion to its length. Conservative: a form
// is rewritten only when how to say it is clear; anything else is left as written, for the engine to read.
import { letters, SITES, LABELS, SAY, SAY_CI, ACRONYMS, SAID_AS_WORDS, TLDS, SUFFIXES, UNITS, UNIT_SPACED, COUNT_NOUNS, WORDS } from './spoken-data.ts';

// ---------------------------------------------------------------- numbers as words (where digits won't do)
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const under100 = (n: number) => (n < 20 ? ONES[n] : TENS[(n / 10) | 0] + (n % 10 ? '-' + ONES[n % 10] : ''));
/** 1984 "nineteen eighty-four", 2026 "twenty twenty-six", 2005 "two thousand five", 1900 "nineteen hundred" */
export function yearWords(y: number): string {
  if (y >= 2000 && y < 2010) return y === 2000 ? 'two thousand' : `two thousand ${ONES[y - 2000]}`;
  const hi = (y / 100) | 0, lo = y % 100;
  return `${under100(hi)} ${lo === 0 ? 'hundred' : lo < 10 ? `oh ${ONES[lo]}` : under100(lo)}`;
}
/** 4090 "forty ninety", 1080 "ten eighty": how model numbers are said */
const pairs = (n: number) => (n % 100 === 0 ? `${under100((n / 100) | 0)} hundred` : `${under100((n / 100) | 0)} ${n % 100 < 10 ? 'oh ' + ONES[n % 100] : under100(n % 100)}`);
const plural = (w: string) => (w.endsWith('y') ? w.slice(0, -1) + 'ies' : w + 's');
/** the 1990s "nineteen nineties", the 2000s "two thousands", the 90s "nineties" */
function decadeWords(d: string): string {
  const n = Number(d);
  if (d.length === 2) return n === 0 ? 'two thousands' : plural(under100(n));
  if (n % 100 === 0) return n === 2000 ? 'two thousands' : `${under100(n / 100)} hundreds`;
  return `${under100((n / 100) | 0)} ${plural(under100(n % 100))}`;
}
const ORD: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
const ordinal = (n: number) => { const w = under100(n), last = w.split('-').pop()!; return w.slice(0, w.length - last.length) + (ORD[last] ?? (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th')); };
const th = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_OF: Record<string, number> = { Sept: 9 };
MONTHS.forEach((m, i) => { MONTH_OF[m] = MONTH_OF[m.slice(0, 3)] = i + 1; });

// ---------------------------------------------------------------- context: a word either side (a bounded look)
const before = (s: string, i: number) => /([A-Za-z][A-Za-z'’]*)\W{0,3}$/.exec(s.slice(Math.max(0, i - 32), i))?.[1] ?? '';
const after = (s: string, i: number) => /^[^A-Za-z.!?;:]{0,3}([A-Za-z][A-Za-z'’]*)/.exec(s.slice(i, i + 32))?.[1] ?? '';
const counts = (w: string) => COUNT_NOUNS.has(w.toLowerCase());
/** only closing marks to the end: a full stop here ends the sentence, and stays */
const ends = (s: string, i: number) => s.length - i <= 6 && /^["'”’)\]\uE001\uE003\uE005\s]*$/.test(s.slice(i));

// ---------------------------------------------------------------- money
const MAG: Record<string, string> = { k: 'thousand', K: 'thousand', thousand: 'thousand', Thousand: 'thousand', Million: 'million', Billion: 'billion',
  Trillion: 'trillion', lakh: 'lakh', lakhs: 'lakh', Lakh: 'lakh', crore: 'crore', crores: 'crore', Crore: 'crore', m: 'million', M: 'million', mm: 'million', MM: 'million',
  mn: 'million', mil: 'million', million: 'million', b: 'billion', B: 'billion', bn: 'billion', billion: 'billion', t: 'trillion', T: 'trillion',
  tn: 'trillion', tr: 'trillion', trillion: 'trillion' };
const CUR: Record<string, [string, string, string?, string?]> = { $: ['dollar', 'dollars', 'cent', 'cents'], '€': ['euro', 'euros', 'cent', 'cents'],
  '£': ['pound', 'pounds', 'penny', 'pence'], '¥': ['yen', 'yen'], '₹': ['rupee', 'rupees'], '¢': ['cent', 'cents'] };
const CODE: Record<string, string> = { US: 'US ', C: 'Canadian ', CA: 'Canadian ', A: 'Australian ', AU: 'Australian ', NZ: 'New Zealand ',
  HK: 'Hong Kong ', S: 'Singapore ', SG: 'Singapore ' };
const PER: Record<string, string> = { mo: 'a month', month: 'a month', mth: 'a month', yr: 'a year', year: 'a year', y: 'a year', annum: 'a year',
  hr: 'an hour', hour: 'an hour', h: 'an hour', day: 'a day', d: 'a day', wk: 'a week', week: 'a week', min: 'a minute', user: 'per user',
  seat: 'per seat', person: 'per person', head: 'per head', unit: 'per unit', share: 'a share', ea: 'each', GB: 'per gigabyte', TB: 'per terabyte',
  kWh: 'per kilowatt hour', MWh: 'per megawatt hour', lb: 'a pound', kg: 'a kilo', gal: 'a gallon', M: 'per million', Mtok: 'per million tokens',
  MTok: 'per million tokens', mtok: 'per million tokens', 'M tokens': 'per million tokens', 'MM tokens': 'per million tokens' };
const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d\d)+,\d{3}|\d+)(?:\.\d+)?`;   // 1,000,000 and India's 10,00,000
const MAGS = String.raw`k|K|mm|MM|mn|mil|m|M|bn|b|B|tn|tr|t|T`;
const MAGW = String.raw`${MAGS}|[Tt]housand|[Mm]illion|[Bb]illion|[Tt]rillion|[Ll]akhs?|[Cc]rores?`;
const CODES = String.raw`US|CA|AU|NZ|HK|SG|C|A|S`;
const MONEY = new RegExp(String.raw`^(${CODES})?([$€£¥₹])(${NUM})(?:\s?(${MAGW})(?![a-z]))?` +
  String.raw`(?:\s?(?:-|–|—|to)\s?(?:${CODES})?[$€£¥₹]?(${NUM})(?:\s?(${MAGW})(?![a-z]))?)?(?:\s?(?:\/|per\s)\s?(\w+(?: tokens)?))?(\+)?$`);
const MONEY_AFTER = new RegExp(String.raw`^(${NUM})(${MAGS})?([$€£¥₹¢])$`);

const DETERMINER = /^(a|an|the|this|that|these|those|its|their|his|her|our|your|my|another|every|each|one|any|no|some)$/i;
/** attributive: before the noun it describes, the currency is singular ("a 5 dollar coffee") */
function money(code: string | undefined, sym: string, a: string, am?: string, b?: string, bm?: string, per?: string, plus?: string, attributive = false): string | undefined {
  const [one, plural, cent, cents] = CUR[sym], many = attributive && !per && !plus ? one : plural;
  let v = Number(a.replace(/,/g, ''));
  if (sym === '₹' && !am && /^\d{1,2}(?:,\d\d)+,\d{3}$/.test(a) && v % 1000 === 0) {                     // ₹1,00,000: 1 lakh rupees
    [a, am] = v >= 1e7 ? [String(+(v / 1e7).toFixed(2)), 'crore'] : [String(+(v / 1e5).toFixed(2)), 'lakh'];
    v = Number(a);
  }
  const amount = (n: string, m?: string) => n + (m ? ' ' + MAG[m] : '');
  let out: string;
  if (!b && !am && cents && v > 0 && v < 1 && /^0?\.\d{1,2}$/.test(a)) {                                    // $0.99: 99 cents
    const c = Math.round(v * 100);
    out = `${c} ${c === 1 ? cent : cents}`;
  } else if (!b && !am && cents && /\.\d\d$/.test(a)) {                                                    // $12.99: 12 dollars 99
    const [whole, c] = a.split('.');
    out = `${whole} ${whole === '1' ? one : many}${c === '00' ? '' : ' ' + Number(c)}`;
  } else if (b) {                                                                                          // $5-10, $1-2B: 5 to 10 dollars, 1 to 2 billion
    out = am && bm && am !== bm ? `${amount(a, am)} to ${amount(b, bm)} ${many}` : `${a} to ${amount(b, bm ?? am)} ${many}`;
  } else {
    out = `${amount(a, am)} ${!am && v === 1 && !a.includes('.') ? one : many}`;
  }
  if (code) out = out.replace(/(dollars?)$/, CODE[code] + '$1');
  if (per) {
    const p = PER[per] ?? (/^[A-Za-z]{2,12}$/.test(per) ? 'per ' + (UNITS[per]?.[0] ?? per) : undefined);
    if (!p) return undefined;
    out += ' ' + p;
  }
  return (plus ? 'more than ' : '') + out;
}

// ---------------------------------------------------------------- numbers, money, dates, units
const esc = (u: string) => u.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const UNIT_ALT = Object.keys(UNITS).sort((a, b) => b.length - a.length).map(esc).join('|');
const UNIT_SPACED_ALT = [...UNIT_SPACED].sort((a, b) => b.length - a.length).map(esc).join('|');
const UNIT_RE = new RegExp(`^(${NUM})(?:(${UNIT_ALT})|\\s(${UNIT_SPACED_ALT}))$`);
const RANGE = new RegExp(`^(${NUM})(${MAGS}|%|x|×|s)?\\s?[-–—]\\s?(${NUM})(${MAGS}|%|x|×|s|(?:${UNIT_ALT})|\\s(?:${UNIT_SPACED_ALT}))?$`);
const MAGNITUDE = new RegExp(`^(${NUM})(${MAGS})(\\+)?$`);
const TIMES = new RegExp(`^(${NUM})[x×]$`);
const NOT_A_THING = /^(of|per|in|on|at|to|and|or|for|is|are|was|were|be|been|each|total|more|less|than|a|an|the|with|from|by|into|vs|versus|over|under|which|that|so|but|if|when|while|it|its|i|you|we|they|he|she|free|left|available|used|remaining|max|maximum|min|minimum|only|instead|ago|later|earlier|away|apart|long|wide|high|tall|deep|thick|old|ahead|behind|faster|slower|smaller|bigger|larger|too|now|then|here|there|just|already|still|yet|either|both|maybe|plus|or|vs|apiece|tops|total|overall|combined|altogether|respectively)$/i;
/** a unit after a number: singular when it's one, or when the pair describes what follows ("a 600W PSU") */
function withUnit(n: string, u: string, next: string): string {
  const [one, many] = UNITS[u];
  return `${n} ${n === '1' || (next && /^[A-Za-z]/.test(next) && !NOT_A_THING.test(next)) ? one : many}`;
}
const YEAR_BEFORE = /^(in|since|by|until|till|til|from|before|after|during|around|circa|ca|c|of|year|early|late|mid|spring|summer|fall|autumn|winter|christmas|the|this|that|last|next|a|an|every|between|and|or|to|through|thru|vs|versus|fy|q[1-4]|h[12]|ad|bc|on|for|than|back|like)$/i;
const YEAR_NOT_AFTER = /^(bytes?|bits?|times|items?|lines?|people|users|words|characters|chars|rows|pixels|px|ms|kb|mb|gb|hz|mhz|rpm|calories|kcal|points?|km|miles|meters|feet|dollars|euros)$/i;
const PRODUCT_BEFORE = /^(RTX|GTX|RX|GT|HD|Radeon|Ryzen|EPYC|Xeon|Threadripper|Snapdragon|Dimensity|Exynos|Helio|Kirin|Core|Pentium|Celeron|Athlon|Phenom|Opteron|ThinkPad|Quadro|Titan|Boeing|Airbus|Cessna|PDP|VAX|Commodore|Amiga|Atari|Motorola|Zilog|Galaxy|Lumia|Nokia|Porsche)$/;

function numeric(tok: string, s: string, at: number): string {
  if (tok.length > 48) return tok;                                                                       // nothing that long is one number
  const t = /^(.*?)([.,:;'’"!?)]*)$/s.exec(tok)!;
  let core = t[1];
  const trail = t[2];
  if (!core) return tok;
  let pre = '';
  const p = /^((?:<=|>=|[<>≤≥])\s?)?([~≈]\s?)?/.exec(core)!;
  const end = at + core.length;
  if (p[0]) {
    core = core.slice(p[0].length);
    const cmp = p[1]?.trim();
    if (p[1] === '<' && core === '3' && (at === 0 || /\s/.test(s[at - 1]))) {                    // <3: a heart, unless numbers compare
      if (/^(I|we|you|they|i)$/.test(before(s, at))) return 'love' + trail;                          // I <3 this
      if (!/^\s*[A-Za-z0-9]/.test(s.slice(end, end + 3))) return trail;                                 // "Thanks <3": a heart, unsaid
    }
    const art = before(s, at).toLowerCase(), glued = at > 0 && /\w/.test(s[at - 1]);
    pre = (glued ? ' ' : '') + (cmp ? { '<': 'less than ', '>': 'more than ', '<=': 'at most ', '>=': 'at least ', '≤': 'at most ', '≥': 'at least ' }[cmp] : '') +
      (p[2] ? (cmp ? 'about ' : art === 'an' ? 'approximately ' : DETERMINER.test(art) ? 'roughly ' : 'about ') : '');
  }
  const said = sayNumber(core, before(s, at), after(s, at + tok.length - trail.length), s, at + p[0].length, end);
  return said === undefined ? (p[0] ? pre + core + trail : tok) : pre + said + trail;
}

function sayNumber(core: string, prev: string, next: string, s: string, at: number, end: number): string | undefined {
  let m: RegExpExecArray | null;
  if (/^\$\d$/.test(core) && (/[{'"(=]/.test(s[at - 1] ?? '') || /[}'"]/.test(s[end] ?? ''))) return undefined;   // awk's $1
  if ((m = MONEY.exec(core))) return money(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], DETERMINER.test(prev) && /^[a-z]/i.test(next) && !NOT_A_THING.test(next) && !PER[next]);
  if ((m = MONEY_AFTER.exec(core))) return money(undefined, m[3], m[1], m[2]);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(core) && core.split('.').every((x) => +x < 256)) return core.split('.').join(' dot ');   // an IP address
  if (/^\d+(?:\.\d+){2,}$/.test(core)) return undefined;                                                  // 1.2.3: a version, the engine reads it
  if ((m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(core))) {                                                       // 2026-11-24
    const y = +m[1], mo = +m[2], d = +m[3];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1000 ? `${MONTHS[mo - 1]} ${d}${th(d)}, ${yearWords(y)}` : undefined;
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d\d)$/.exec(core))) {                                          // 11/24/2026 or 24/11/2026 (not 10/09/2026)
    const a = +m[1], b = +m[2], y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const [mo, d] = a > 12 && b <= 12 ? [b, a] : b > 12 && a <= 12 ? [a, b] : [0, 0];
    return mo && d <= 31 ? `${MONTHS[mo - 1]} ${d}${th(d)}, ${yearWords(y)}` : undefined;
  }
  if ((m = /^(\d{4})-(\d\d)$/.exec(core)) && +m[2] >= 1 && +m[2] <= 12 && +m[2] <= +m[1].slice(2) && +m[1] > 1900) return `${MONTHS[+m[2] - 1]} ${yearWords(+m[1])}`;
  if ((m = RANGE.exec(core))) {
    const sum = /[=+*/×÷]\s*$/.test(s.slice(Math.max(0, at - 3), at)) || /^\s*[=+*/×÷]/.test(s.slice(end, end + 3));
    if (/\d\s[-–—]|[-–—]\s\d/.test(core) && (sum || Number(m[3].replace(/,/g, '')) < Number(m[1].replace(/,/g, '')))) return sum && !m[2] && !m[4] ? `${m[1]} minus ${m[3]}` : undefined;
    return range(m[1], m[2], m[3], (m[4] ?? '').trim(), next);
  }
  if ((m = /^(\d{1,2}):(\d\d)(?::(\d\d))?\s?([AaPp])?\.?(?:[Mm]\.?)?$/.exec(core)) && +m[1] < 24 && +m[2] < 60 && (!m[4] || /[mM]/.test(core.slice(-2)))) {
    const mm = +m[2], ampm = m[4] ? ` ${m[4].toUpperCase()}-M` : '';
    const later = /^(am|pm|a|p)$/i.test(next) || /^\s?[ap]\.?m\b/i.test(s.slice(end, end + 5));
    if (mm === 0 && !m[3] && !ampm && !later && +m[1] === 0) return 'midnight';
    const min = mm === 0 ? (m[3] || (+m[1] >= 13 && !ampm) ? 'hundred' : ampm || later ? '' : "o'clock") : mm < 10 ? `oh ${mm}` : String(mm);
    return `${+m[1]} ${min}`.trim() + (m[3] ? ` ${+m[3] < 10 ? 'oh ' + +m[3] : +m[3]}` : '') + ampm;
  }
  if ((m = /^(\d+):(\d+)$/.exec(core))) return `${m[1]} to ${m[2]}`;                                     // 16:9, 3:1
  if ((m = /^(\d+)\/(\d+)$/.exec(core))) return fraction(+m[1], +m[2], m[1], m[2]);
  if ((m = /^(\d+(?:\.\d+)?)[x×](\d+(?:\.\d+)?)(?:[x×](\d+(?:\.\d+)?))?$/.exec(core))) return `${m[1]} by ${m[2]}${m[3] ? ' by ' + m[3] : ''}`;   // 1920x1080
  if ((m = TIMES.exec(core))) {                                                                           // 10x faster; but "a 10x engineer"
    return /^(a|an)$/i.test(prev) && /^[a-z]/i.test(next) && !/^(more|less|faster|slower|better|worse|cheaper|bigger|smaller|larger|the|as|than|over|of|in|on|at|to|increase|improvement|speedup|reduction|difference)$/i.test(next) ? undefined : `${m[1]} times`;
  }
  if ((m = MAGNITUDE.exec(core))) {                                                                       // 10M users, 250k, 3.5B parameters
    if (/^\d{4}$/.test(m[1]) && /^[kK]$/.test(m[2])) return `${pairs(+m[1])} K`;                         // i5 2500K: a model number
    const w = magWord(m[2], next, m[1]);
    return w ? (m[3] ? 'more than ' : '') + `${m[1]} ${w}` : undefined;
  }
  if ((m = UNIT_RE.exec(core))) return withUnit(m[1], m[2] ?? m[3], next);
  if ((m = /^['’]?(\d\d|\d{4})['’]?s$/.exec(core))) {                                                    // the 1990s, the 90s, '90s, 90's; 45s
    const n = +m[1], apos = /['’]/.test(core);
    if (m[1].length === 4) return n >= 1100 && n < 2100 && n % 10 === 0 ? decadeWords(m[1]) : undefined;
    if (n % 10 === 0 && (apos || !/^(a|an|every|took|takes|take|within|after|under|over|in|for|about|than|only|just|wait|waiting|lasts?|of)$/i.test(prev))) return decadeWords(m[1]);
    return apos ? undefined : `${n} seconds`;
  }
  if ((m = /^(\d{3,4})p$/.exec(core)) && [360, 480, 540, 720, 1080, 1440, 2160, 4320].includes(+m[1])) {   // 1080p: ten eighty p
    const n = +m[1];
    return `${n < 1000 ? `${ONES[(n / 100) | 0]} ${under100(n % 100)}` : pairs(n)} p`;
  }
  if ((m = /^(\d+)\^(\d+)$/.exec(core))) return `${m[1]} to the ${+m[2] < 100 ? ordinal(+m[2]) : m[2] + th(+m[2])}`;   // 2^32
  if ((m = /^\.(\d+)$/.exec(core))) return `point ${m[1].split('').join(' ')}`;                          // .5
  if (/^\d{1,2}$/.test(core) && MONTH_OF[prev] && +core >= 1 && +core <= 31 && !/^\s*\d/.test(s.slice(end))) return `${core}${th(+core)}`;   // Nov 24
  if (/^\d{4}$/.test(core)) {
    const n = +core;
    if (PRODUCT_BEFORE.test(prev)) return pairs(n);                                                       // RTX 4090: forty ninety
    if (n < 1100 || n >= 2100 || /[$#€£@]/.test(s[at - 1] ?? '')) return undefined;
    if (YEAR_NOT_AFTER.test(next) || (counts(next) && !/^years?$/i.test(next))) return undefined;
    const paren = s[at - 1] === '(' && s[end] === ')';
    const dated = MONTH_OF[prev] !== undefined || /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s\d{1,2}(?:st|nd|rd|th)?,\s*$/.test(s.slice(Math.max(0, at - 18), at));
    const owned = /['’]s\s*$/.test(s.slice(Math.max(0, at - 4), at));                                     // the EU's 2018 push
    if (paren || dated || owned || YEAR_BEFORE.test(prev) || (n >= 1900 && /^[A-Z]/.test(prev) && prev !== 'I')) return yearWords(n);
  }
  return undefined;
}
/** 2-3, 5–10%, 2020-2024, 1990-95, 10-20k, 3-4x, 2-3GB, 20-30s */
function range(a: string, as: string | undefined, b: string, bs: string, next: string): string | undefined {
  const A = Number(a.replace(/,/g, '')), B = Number(b.replace(/,/g, ''));
  if (/^0\d/.test(b) && !/^\d{4}$/.test(a)) return undefined;                                            // a code: 555-0100
  if (/^\d{4}$/.test(a) && A >= 1100 && A < 2100 && !as && (!bs || bs === 's')) {
    if (/^\d{4}$/.test(b) && B >= A && B < 2100) return bs === 's' ? `${decadeWords(a)} to ${decadeWords(b)}` : `${yearWords(A)} to ${yearWords(B)}`;
    if (/^\d\d$/.test(b) && B > A % 100 && !bs) return `${yearWords(A)} to ${under100(B)}`;
    return undefined;
  }
  if (bs === 's' || as === 's') return /0$/.test(a) && /0$/.test(b) && A < B ? `${decadeWords(a)} to ${decadeWords(b)}` : undefined;
  if (B < A && (as || bs)) return undefined;                                                              // 3-2 is a score: "3 to 2"
  const word = (x: string) => (x === '%' ? 'percent' : x === 'x' || x === '×' ? 'times' : MAG[x] ? magWord(x, next) : UNITS[x] ? UNITS[x][1] : undefined);
  const wa = as && as !== bs ? word(as) : '', wb = bs ? word(bs) : '';
  if (wa === undefined || wb === undefined) return undefined;
  return `${a}${wa ? ' ' + wa : ''} to ${b}${wb ? ' ' + wb : bs ? ' ' + bs : ''}`;
}
/** K and B are said as letters ("64K context", "a 27B model") unless what's counted follows; M and T as words */
function magWord(mag: string, next: string, n = ''): string | undefined {
  if (mag === 'K' && /^\d$/.test(n)) return undefined;                                                 // 4K video, 2K Games
  if (/^(K|k|B|b|m|t)$/.test(mag)) return counts(next) ? MAG[mag] : undefined;
  if (/^(M|T)$/.test(mag) && /^(model|models|MoE|dense|instruct|base|checkpoint|context|ctx|window)$/i.test(next)) return undefined;
  return MAG[mag];
}
const FRACTION: Record<string, string> = { '1/2': 'one half', '1/3': 'one third', '2/3': 'two thirds', '1/4': 'one quarter', '3/4': 'three quarters',
  '1/5': 'one fifth', '1/8': 'one eighth', '24/7': 'twenty-four seven', '50/50': 'fifty-fifty', '20/20': 'twenty-twenty', '9/11': 'nine eleven', '7/11': 'seven eleven' };
function fraction(a: number, b: number, as: string, bs: string): string | undefined {
  const f = FRACTION[`${as}/${bs}`];
  if (f) return f;
  if ((b === 5 || b === 10 || b === 100) && a <= b) return `${as} out of ${bs}`;                         // 7/10, 100/100
  if (a === 1 && b >= 100) return `1 in ${bs}`;                                                           // 1/1000 odds
  if (as.length === 4 && bs.length === 4 && a >= 1900 && b === a + 1) return `${yearWords(a)} to ${yearWords(b)}`;   // 2008/2009
  return undefined;
}

// ---------------------------------------------------------------- words: abbreviations, names, domains, files
const lettered = <T extends Record<string, string>>(o: T) => { for (const k in o) (o as Record<string, string>)[k] = letters(o[k]); return o; };
const FILE_EXT: Record<string, string> = lettered({ js: 'J S', ts: 'T S', mjs: 'M J S', jsx: 'J S X', tsx: 'T S X', py: 'pie', rs: 'R S', go: 'go', c: 'C',
  h: 'H', cpp: 'C P P', cc: 'C C', hpp: 'H P P', java: 'java', rb: 'R B', md: 'M D', txt: 'text', json: 'jason', yaml: 'yammel', yml: 'yammel',
  toml: 'tommel', html: 'H T M L', css: 'C S S', sh: 'S H', exe: 'E X E', dll: 'D L L', so: 'S O', pdf: 'P D F', png: 'P N G', jpg: 'J peg',
  jpeg: 'J peg', gif: 'gif', svg: 'S V G', mp3: 'M P 3', mp4: 'M P 4', zip: 'zip', tar: 'tar', gz: 'G Z', csv: 'C S V', xml: 'X M L', sql: 'S Q L',
  db: 'D B', lock: 'lock', ini: 'I N I', cfg: 'config', conf: 'conf', env: 'env', log: 'log', wasm: 'wazm', ipynb: 'notebook', nix: 'nix',
  lua: 'lua', zig: 'zig', swift: 'swift', kt: 'K T', dart: 'dart', php: 'P H P', pl: 'P L', ex: 'E X', exs: 'E X S', hs: 'H S', ml: 'M L',
  el: 'E L', clj: 'C L J', vim: 'vim', asm: 'A S M', wav: 'wave', ogg: 'ogg', webp: 'web P', epub: 'E pub', docx: 'doc X', xlsx: 'X L S X',
  pptx: 'P P T X', apk: 'A P K', dmg: 'D M G', iso: 'I S O', deb: 'deb', rpm: 'R P M', onnx: 'onyx', gguf: 'G G U F', safetensors: 'safe tensors' });
const DOTTED: Record<string, string> = lettered({ 'e.g.': 'for example', 'i.e.': 'that is', 'a.m.': 'A M', 'p.m.': 'P M', 'a.k.a.': 'also known as',
  'w.r.t.': 'with respect to', 'n.b.': 'note', 'N.B.': 'note', 'p.s.': 'P S', 'P.S.': 'P S', 'e.g': 'for example', 'i.e': 'that is',
  'Ph.D.': 'P H D', 'Ph.D': 'P H D', 'et al.': 'et al', 'et al': 'et al' });
const TITLES: Record<string, string> = { Mr: 'Mister', Mrs: 'Missus', Ms: 'Miz', Dr: 'Doctor', Prof: 'Professor', Jr: 'Junior', Sr: 'Senior', St: 'Saint',
  Gen: 'General', Sen: 'Senator', Rep: 'Representative', Gov: 'Governor', Pres: 'President', Capt: 'Captain', Lt: 'Lieutenant', Sgt: 'Sergeant' };
const ABBR_DOT: Record<string, string> = { etc: 'et cetera', vs: 'versus', v: 'versus', approx: 'approximately', cf: 'compare', viz: 'namely',
  resp: 'respectively', incl: 'including', esp: 'especially', eg: 'for example', ie: 'that is', ca: 'circa', No: 'number', no: 'number', Fig: 'figure',
  fig: 'figure', Sec: 'section', Ch: 'chapter', Vol: 'volume', vol: 'volume', pp: 'pages', Eq: 'equation', eq: 'equation' };
const NEEDS_NUMBER = new Set(['No', 'no', 'ca', 'Fig', 'fig', 'Sec', 'Ch', 'Vol', 'vol', 'pp', 'Eq', 'eq', 'v']);

/** every whole word with a spoken form, as written: names, acronyms, and abbreviations in each casing ("imo", "IMO", "Imo") */
const LEX = new Map<string, string>([...Object.entries(SAY), ...Object.entries(ACRONYMS),
  ...Object.entries(SAY_CI).flatMap(([k, v]) => [[k, v], [k.toUpperCase(), v], [k.charAt(0).toUpperCase() + k.slice(1), v]] as [string, string][])]);
LEX.delete('VS');                                                                                       // Visual Studio, not "versus"
const LOWER = [...LEX.keys()].filter((k) => /^[a-z][a-z]*$/.test(k)).sort((a, b) => b.length - a.length).join('|');

/** a word without dots, if it's said differently: a month before its day, a CVE, capitals' plurals, "MoE" */
function plain(w: string, s: string, end: number): string | undefined {
  if (w.length <= 4 && MONTH_OF[w] && w !== 'May' && /^\s+\d/.test(s.slice(end, end + 3))) return MONTHS[MONTH_OF[w] - 1];   // Nov 24
  if (w.length > 9 && w.startsWith('CVE-')) { const c = /^CVE-(\d{4})-(\d+)$/.exec(w); if (c) return `C-V-E ${yearWords(+c[1])}, ${c[2]}`; }
  if (w.length > 7) return undefined;
  if (w === 'IV') return /^[A-Z]/.test(before(s, end - 2)) ? 'four' : 'I-V';                         // Part IV, an IV drip
  const pl = /^([A-Z]{2,5})(?:s|['’]s)$/.exec(w);                                                       // LLMs, GPUs, PR's: espeak drops the s
  if (pl) return PLURAL_WORDS[pl[1]] ?? (SAID_AS_WORDS.has(pl[1]) ? pl[1].toLowerCase() + w.slice(pl[1].length) : spelledPlural(ACRONYMS[pl[1]] ?? spell(pl[1])));
  const mixed = /^([A-Z][a-z][A-Z])(s?)$/.exec(w);                                                      // MoE, PoC, SoCs: letters, not "moe"
  if (mixed && mixed[1] !== 'WoW') return mixed[2] ? spelledPlural(spell(mixed[1])) : spell(mixed[1]);
  return undefined;
}

function word(tok: string, s: string, at: number): string {
  const said = LEX.get(tok);
  if (said !== undefined) return said;
  const end = at + tok.length;
  if (tok.indexOf('.') < 0) return plain(tok, s, end) ?? tok;                                           // the common case: a plain word
  const dot = tok.endsWith('.') ? '.' : '';
  const w = dot ? tok.slice(0, -1) : tok;
  const stop = dot && (ends(s, end) || s[end] === '.') ? '.' : '';                                      // an abbreviation's full stop, kept if it ends the sentence
  if (w.includes('.')) {
    if (DOTTED[tok]) return DOTTED[tok] + stop;
    if (DOTTED[w]) return DOTTED[w] + dot;
    if (LEX.has(w)) return LEX.get(w)! + stop;
    const host = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,})$/i.exec(w);
    const lower = w.toLowerCase();
    if (host && TLDS[host[1].toLowerCase()] !== undefined && !/\.(?:js|ts|py|rs|md|sh|so|pl|go|cc|ai|in)$/i.test(w) && (w === lower || SITES[lower] || /^[A-Z][a-z0-9-]*\.(?:com|org|net|io|dev|app|co|gov|edu)$/.test(w))) return sayHost(w) + dot;
    const file = /^([\w-]+)\.([A-Za-z0-9]{1,11})$/.exec(w);
    if (file && FILE_EXT[file[2]] !== undefined && !/^\d+$/.test(file[1])) {
      if (file[2] === 'js' && /^[A-Z]/.test(file[1])) return `${LEX.get(file[1]) ?? file[1]} J-S${dot}`;   // Three.js
      return `${LEX.get(file[1]) ?? file[1]} dot ${FILE_EXT[file[2]]}${dot}`;
    }
    if (host && w === lower && /\.(?:ai|in)$/.test(w)) return sayHost(w) + dot;                       // x.ai, but not a file
    return tok;
  }
  if (LEX.has(w)) return LEX.get(w)! + stop;
  if (TITLES[w] && /^\s+[A-Z]/.test(s.slice(end, end + 2))) return TITLES[w];                        // Dr. Smith, St. Louis
  if (ABBR_DOT[w] && (!NEEDS_NUMBER.has(w) || /^\s*\d/.test(s.slice(end, end + 3)) || (w === 'v' && /^\s+[A-Z]/.test(s.slice(end, end + 2))))) return ABBR_DOT[w] + stop;
  const p = plain(w, s, end);
  return p === undefined ? tok : p + (MONTH_OF[w] ? '' : dot);
}

// ---------------------------------------------------------------- domains: how people say a site's name
const hostCache = new Map<string, string>();
/** "nypost.com" "N-Y Post dot com", "techcrunch.com" "TechCrunch dot com", "bbc.co.uk" "BBC dot co dot U-K" */
export function sayHost(host: string, site = false): string {
  host = host.toLowerCase().replace(/^(?:www\d?|m|mobile|amp)\./, '');
  const key = site ? '@' + host : host;
  let said = hostCache.get(key);
  if (said !== undefined) return said;
  if (/^(?:en|de|fr|es|it|ja|ru|pt|nl|sv|pl|zh|ko|uk|cs|fi|da|no|tr|he|ar|hi)\.[^.]+\.[^.]+/.test(host)) host = host.slice(3);   // en.sedaily.com
  const labels = host.split('.');
  // a two-part ending: a known one ("co.uk", "github.io"), or a country's "ac.be", "com.tr", "gov.pl"
  const k = labels.length > 2 && (SUFFIXES.has(labels.slice(-2).join('.')) || (labels[labels.length - 1].length === 2 && /^(?:co|com|org|net|gov|govt|edu|ac|or|ne|go|mil|nic)$/.test(labels[labels.length - 2]))) ? 2 : 1;
  const name = labels.slice(0, labels.length - k), end = labels.slice(labels.length - k);
  // a link: its site's name ("static-assets-1.truthsocial.com" is truth social dot com); written in a sentence, the
  // two names nearest its ending ("scholarship.law.cornell.edu" is law dot cornell dot E-D-U)
  said = [...(site ? name.slice(-1) : name.length > 2 ? name.slice(-2) : name).map(sayLabel), ...end.map((t) => TLDS[t] ?? sayLabel(t))].join(' dot ');
  if (hostCache.size > 4096) hostCache.clear();
  hostCache.set(key, said);
  return said;
}
/** "wsj" "W-S-J": letters as one hyphenated word, which espeak spells (an A after the first is "Eh": see spoken-data) */
const spell = (w: string) => w.toUpperCase().split('').map((l, i) => (i && l === 'A' ? 'Eh' : l)).join('-');
/** a spelled name's plural: its last letter's ("L-L-M" "L-L-Ems"); anything else is left to the engine */
const PLURAL_NAME: Record<string, string> = { A: 'Ehz', Eh: 'Ehz', B: 'Bees', C: 'Sees', D: 'Dees', E: 'Ees', F: 'Effs', G: 'Gees', H: 'Aitches', I: 'Eyes',
  J: 'Jays', K: 'Kays', L: 'Ells', M: 'Ems', N: 'Ens', O: 'Ohs', P: 'Pees', Q: 'Cues', R: 'Ars', S: 'Esses', T: 'Tees', U: 'Yous', V: 'Vees',
  W: 'Double-yous', X: 'Exes', Y: 'Whys', Z: 'Zees' };
const spelledPlural = (said: string) => { const m = /^((?:[A-Z]|Eh)(?:-(?:[A-Z]|Eh))*-)([A-Z]|Eh)$/.exec(said); return m ? m[1] + PLURAL_NAME[m[2]] : said + 's'; };
/** capitals said as a word, so their plural is too */
const PLURAL_WORDS: Record<string, string> = { GUI: 'gooeys', ROM: 'roms', SKU: 'skews', GIF: 'gifs', JPEG: 'jay-pegs', SIM: 'sims', NIC: 'nicks',
  LAN: 'lans', DAW: 'daws', RAID: 'raids', ASIC: 'A-sicks', MOOC: 'mooks', NAS: 'nasses', DAC: 'dacks', CAD: 'cads', DOM: 'doms', REPL: 'repples' };
/** One label of a host: a word, words run together (segmented), or letters to spell */
export function sayLabel(label: string): string {
  if (/^\d+$/.test(label)) return label;
  return LABELS.get(label) ?? label.split('-').filter(Boolean).map(segment).join(' ');
}

// A small word segmenter for names run together ("techcrunch" "tech crunch", "nypost" "N Y post"): words from a
// frequency list (the vocabulary of Hacker News comments), cheapest split by -log(frequency), each piece paying a
// toll so fewer, longer words win. Letters that aren't a word are spelled ("ny", "wsj"), but only at either end of
// a name; a short name that isn't a word is an acronym ("epa"). Anything without a confident split is left whole,
// for the engine to read as one word: a wrong split ("bro ok in G S") is worse than none.
let rank: Map<string, number> | undefined;
const vocab = () => (rank ??= new Map(WORDS.split(' ').map((w, i) => [w, i])));
const NAMES = new Map(Object.entries(SAY).map(([k, v]) => [k.toLowerCase(), v]));
const segCache = new Map<string, string>();
const SHORT_WORDS = /^(my|go|on|in|of|to|up|me|we|is|it|at|be|do|no|so|an|or|as|by|if|hi|ok|un|re)$/;
const LEADING = new Set(['ny', 'nyc', 'sf', 'la', 'dc', 'uk', 'us', 'eu', 'ai', 'ml', 'pc', 'tv', 'hn', 'yc', 'bbc', 'cnn', 'cbs', 'nbc', 'abc', 'sql', 'esg', 'url', 'cnbc',
  'npr', 'pbs', 'wsj', 'ft', 'nyt', 'wp', 'gh', 'js', 'db', 'api', 'llm', 'gpu', 'cpu', 'os', 'id', 'hq', 'vr', 'xr', 'ev', 'ip', 'xx', 'usa']);
const vowels = (w: string) => (w.match(/[aeiouy]/g) ?? []).length;
export function segment(label: string): string {
  const w = label.toLowerCase();
  let out = segCache.get(w);
  if (out === undefined) {
    out = split(w);
    if (segCache.size > 8192) segCache.clear();
    segCache.set(w, out);
  }
  return out;
}
const known = (piece: string, r: number | undefined) => r !== undefined && (piece.length >= 5 ? r < 30000 : piece.length === 4 ? r < 15000 : piece.length === 3 ? r < 9000 : SHORT_WORDS.test(piece));
const PREFIX = /^(the|my|get|try|use|go|i|a)$/;
function split(w: string): string {
  const V = vocab(), n = w.length;
  if (!/^[a-z0-9]+$/.test(w) || n > 40) return w;
  const named = LABELS.get(w) ?? NAMES.get(w);
  if (named) return named;
  const r = V.get(w);
  if (r !== undefined && (n > 3 || r < 9000)) return w;                                               // a word as it is
  if (!/\d/.test(w) && (n <= 3 || (r === undefined && ((n <= 8 && vowels(w) === 0) || (n <= 4 && /[^aeiouy]{3}/.test(w)))))) return spell(w);   // epa, wsj, ecfr, hntrbrk
  if (n <= 4) return w;
  const cost = new Float64Array(n + 1).fill(Infinity), from = new Int32Array(n + 1), kind = new Int8Array(n + 1);
  cost[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - 18); j < i; j++) {
      if (cost[j] === Infinity) continue;
      const piece = w.slice(j, i), pr = V.get(piece);
      let c = Infinity, k = 0;
      if (/^\d+$/.test(piece)) { c = 2; k = 2; }
      else if (known(piece, pr) || (j === 0 && PREFIX.test(piece))) { c = 4 + Math.log((pr ?? 0) + 2) * 0.6 + (piece.length <= 3 && !PREFIX.test(piece) && !((pr ?? 1e9) < 300) ? 3 : 0); k = 1; }
      else if (/^[a-z]{1,4}$/.test(piece) && ((j === 0 && (piece.length === 1 || LEADING.has(piece))) || (i === n && piece.length >= 2 && LEADING.has(piece)) || (piece.length >= 2 && piece.length <= 3 && vowels(piece) === 0 && (j === 0 || i === n)))) { c = 8 + piece.length; k = 3; }
      if (cost[j] + c < cost[i]) { cost[i] = cost[j] + c; from[i] = j; kind[i] = k; }
    }
  }
  if (cost[n] === Infinity) return w;
  const pieces: string[] = [];
  let spelled = 0, words = 0, short = 0;
  for (let i = n; i > 0; i = from[i]) {
    const piece = w.slice(from[i], i);
    if (kind[i] === 3) spelled++;
    if (kind[i] === 1) { words++; if (piece.length <= 3 && !(from[i] === 0 && PREFIX.test(piece))) short++; }
    pieces.unshift(kind[i] === 3 ? spell(piece) : kind[i] === 1 ? NAMES.get(piece) ?? piece : piece);
  }
  // a confident split only: real words, few of them, at most one short word and one spelled piece
  return pieces.length < 2 || words === 0 || pieces.length > 4 || spelled > 1 || short > 1 || (/^[A-Z]$/.test(pieces[0]) && pieces.length > 2) ? w : pieces.join(' ');
}

// ---------------------------------------------------------------- links
const AN = /^(?:[AEIOaeio]|U(?!ber|S\b|N\b|nix|niversity)|Nvidia|NVIDIA|X\b|R\b|F\b|H\b|L\b|M\b|N\b|S\b|[FHLMNRSX] [A-Z]\b|[FHLMNRSX][A-Z]+\b|8|11|18)/;
const article = (name: string) => (AN.test(name) ? 'an' : 'a');
/** What a link is called aloud. A platform is "a GitHub link"; a known site by its name ("the New York Times"); a
 *  Hacker News item is "another Hacker News thread"; any other site by its spoken host. */
export function linkName(url: string): { phrase: string; name: string; platform: boolean } {
  let u: URL;
  try { u = new URL(url); } catch { return { phrase: 'a link', name: 'a link', platform: true }; }
  if (u.protocol === 'mailto:') return { phrase: 'an email address', name: 'an email address', platform: true };
  if (!/^https?:$/.test(u.protocol)) return { phrase: 'a link', name: 'a link', platform: true };
  const host = u.hostname.toLowerCase().replace(/^(?:www\d?|m|mobile|amp|old|new|np)\./, '').replace(/\.$/, '');
  if (host === 'news.ycombinator.com') {
    if (u.pathname === '/item') return { phrase: 'another Hacker News thread', name: 'another Hacker News thread', platform: true };
    if (u.pathname === '/newsguidelines.html') return { phrase: 'the Hacker News guidelines', name: 'the Hacker News guidelines', platform: true };
    return { phrase: 'a Hacker News link', name: 'Hacker News', platform: true };
  }
  if (/^\d+\.\d+\.\d+\.\d+$|^\[/.test(host) || !host.includes('.')) return { phrase: 'a link', name: 'a link', platform: true };
  const labels = host.split('.');
  let site;
  for (let i = 0; i < labels.length - 1 && !site; i++) site = SITES[labels.slice(i).join('.')];   // en.wikipedia.org: wikipedia.org
  if (site) {
    if (site.phrase) return { phrase: site.phrase, name: site.phrase, platform: true };
    if (site.platform) return { phrase: `${article(site.name)} ${site.name} link`, name: site.name, platform: true };
    return { phrase: site.name, name: site.name, platform: false };
  }
  if (host.length > 40 || labels.length > 5) return { phrase: 'a link', name: 'a link', platform: true };
  const said = sayHost(host, true);
  return { phrase: said, name: said, platform: false };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The links of one comment, in order: each one's phrase, a repeat said as "another…" */
export class LinkVoice {
  private seen = new Map<string, number>();
  inline(url: string): string {
    const l = linkName(url), n = this.seen.get(l.name) ?? 0;
    this.seen.set(l.name, n + 1);
    return n && l.platform && /^an? /.test(l.phrase) && l.name !== 'a link' ? l.phrase.replace(/^an? /, 'another ') : l.phrase;
  }
  /** Links standing alone (a paragraph of nothing else), said together as one sentence, one piece per link so each
   *  placard rises while its name is said: "A GitHub link." / "Two links: Wikipedia," "and N-Y Post dot com." /
   *  "A GitHub link," "another," "and another." Past six, the rest are counted: "and four more." */
  alone(urls: string[]): string[] {
    const ls = urls.map(linkName);
    const said = (l: ReturnType<typeof linkName>, again: boolean) => (!l.platform ? `${again ? 'another link' : 'a link'} to ${l.phrase}`
      : again && /^an? /.test(l.phrase) && l.name !== 'a link' ? l.phrase.replace(/^an? /, 'another ') : l.phrase);
    if (ls.length === 1) {
      const l = ls[0], again = (this.seen.get(l.name) ?? 0) > 0;
      this.seen.set(l.name, (this.seen.get(l.name) ?? 0) + 1);
      return [cap(said(l, again)) + '.'];
    }
    const same = ls.every((l) => l.name === ls[0].name), n = ls.length, out: string[] = [];
    const named = new Set<string>();
    for (let i = 0; i < n; i++) {
      const l = ls[i], last = i === n - 1 || i === 6;
      if (i > 6) { out.push(''); continue; }
      let piece: string;
      if (i === 6) piece = `${n - 6 < 13 ? ONES[n - 6] : n - 6} more`;
      else if (same) piece = i === 0 ? said(l, (this.seen.get(l.name) ?? 0) > 0) : 'another';
      else {
        const name = l.phrase === `${article(l.name)} ${l.name} link` ? l.name : l.phrase;
        piece = named.has(l.name) ? said(l, true) : name;
        if (i === 0) piece = `${n < 13 ? ONES[n] : n} links: ${piece}`;
      }
      named.add(l.name);
      out.push(last && i > 0 ? `and ${piece}.` : `${piece},`);
    }
    for (const l of ls) this.seen.set(l.name, (this.seen.get(l.name) ?? 0) + 1);
    return out.map((p, i) => (i === 0 ? cap(p) : p));
  }
}

// ---------------------------------------------------------------- the pass
// Markers (private-use characters, never in a comment) carry what the paragraph knows: a link and its anchor text
// (\uE000…\uE001), emphasis (\uE002…\uE003) and code (\uE004…\uE005). Code is read as written.
const SLASH: Record<string, string> = lettered({ 'w/o': 'without', 'w/': 'with', 'b/c': 'because', 'and/or': 'and or', 'n/a': 'N A', 'N/A': 'N A', 'y/o': 'year old',
  'c/o': 'care of', 'w/e': 'whatever', 'I/O': 'I O', 'TCP/IP': 'T C P I P', 'A/B': 'A B', 'A/C': 'A C', 'tok/s': 'tokens a second', 'tokens/s': 'tokens a second' });
const RE = new RegExp([
  String.raw`\uE000[^\uE001]*\uE001`,                                                                     // 1 a link
  String.raw`\uE004[^\uE005]*\uE005`,                                                                     // 2 code
  // 3 numbers: a comparison or "about", a currency, the number and what's glued to it, a spaced range or unit
  String.raw`(?:(?:<=|>=|(?<![-=<])<|(?<![-=])>|[≤≥])\s?)?(?:[~≈]\s?)?(?:(?:${CODES})?[$€£¥₹]\s?)?(?:(?<![\w])['’](?=\d\ds\b))?(?<![\w.,\-–—])(?:\d[\d,]*(?:\.\d+)?|\.\d+)[\w.,:/^%°'’+×$€£¥₹¢]*` +
    String.raw`(?:\s?[-–—]\s?(?=[$€£¥₹]?\d)[$€£¥₹]?\d[\w.,:/^%°+×]*){0,2}(?:\s(?:${UNIT_SPACED_ALT}|${MAGW}|bn|mn)(?![\w/]))?`,
  String.raw`(?:w\/o|w\/(?=[\sA-Za-z])|b\/c|and\/or|n\/a|N\/A|y\/o|c\/o|w\/e|I\/O|TCP\/IP|A\/B|A\/C|tok\/s|tokens\/s)(?![\w/])`,   // 4 slash words
  String.raw`(?<![\w.])(?:[A-Za-z]\.){2,}(?:[A-Za-z]\.?)?(?![A-Za-z])|(?<![\w.])Ph\.D\.?|\bet al\.?`,                                // 5 U.S., e.g., a.m.
  // 6 a word that may need saying differently (and its full stop): one with a capital, a digit, a dot or a mark in it,
  // or an abbreviation in lower case. A plain lower-case word ("the") never matches, so most words cost nothing.
  String.raw`\b(?:(?=[a-z'’-]{0,63}[A-Z0-9._#+;])|(?=(?:${LOWER})\b))[A-Za-z][\w'’]*(?:-[\w'’]+)*(?:\.[A-Za-z0-9][\w-]*)*(?:\+\+|#|;DR|;dr|\.(?![A-Za-z0-9]))?`,
  String.raw`\s?(?:<-{1,9}>|<=>|↔|⇔)\s?|\s?(?:-{1,9}>|={1,9}>|→|⟶|⇒|➡|➔)\s?|\s?(?:<-{1,9}(?![\d>-])|←|⟵|⇐)\s?`,                      // 7 arrows
  String.raw`\s?\[\d{1,3}\]:?|⁻?[¹²³⁴⁵⁶⁷⁸⁹⁰]+`,                                                                                // 8 footnote marks, superscripts
  String.raw`#\d{1,6}\b`,                                                                                                         // 9 #1
  String.raw`\s–\s|–|[™®†‡•]|(?<!\S)\/s(?=$|[\s.!?,)])|\.NET\b|(?:^|(?<=\s))\*\s|\*\*?(?=\S)|(?<=\S)\*\*?`,                         // 10 symbols
].map((r) => `(${r})`).join('|'), 'g');

// every lookup table without a prototype: a commenter's "constructor" or "toString" is just a word
for (const t of [MONTH_OF, MAG, CUR, CODE, PER, ORD, FILE_EXT, DOTTED, TITLES, ABBR_DOT, FRACTION, SLASH, PLURAL_NAME, PLURAL_WORDS] as object[]) Object.setPrototypeOf(t, null);
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹', SUP_MINUS = '⁻';
const ABBR_END = /(?:^|[\s(])(?:e\.g|i\.e|eg|ie|vs|etc|cf|esp|incl|al|approx|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|U\.S|a\.m|p\.m)\.\s+$/i;
/** "[1]" and "¹" are footnote marks, dropped; "argv[1]" is code, kept; "10²⁰" is "10 to the twentieth", "km²" "km squared" */
function footnote(m: string, s: string, at: number): string {
  const prev = s.slice(Math.max(0, at - 12), at), next = s.slice(at + m.length, at + m.length + 2);
  if (m.indexOf('[') >= 0) {
    const w = /([\w\]]+)$/.exec(prev)?.[1] ?? '';
    const code = m[0] === '[' && w && (w.endsWith(']') || /[_\d]/.test(w) || w.length <= 4 || /^(?:\[|\.\w|\(|\s?=[^=>])/.test(next));
    return code ? m : '';
  }
  const neg = m[0] === SUP_MINUS, e = +[...(neg ? m.slice(1) : m)].map((c) => SUP.indexOf(c)).join('');
  if (/\d$/.test(prev)) {                                                                          // after a number: an exponent,
    if (!neg && (m === '¹' || /(?:^|\D)(?:19|20)\d\d$/.test(prev))) return '';                    // but "2020¹" and "x1¹" are marks
    return !neg && e === 2 ? ' squared' : !neg && e === 3 ? ' cubed' : ` to the ${neg ? 'minus ' : ''}${e < 100 ? ordinal(e) : e + th(e)}`;
  }
  if (/[A-Za-z)]$/.test(prev) && !neg && (e === 2 || e === 3)) return e === 2 ? ' squared' : ' cubed';   // x², km³
  return '';
}
export interface Voicing { link?: () => string }
/** One sentence (or any run of text), as it should be said. */
export function spoken(text: string, o: Voicing = {}): string {
  let changed = false;
  const out = text.replace(RE, (m, link, code, num, slash, dotted, w, arrow, foot, hash, sym, at: number, s: string) => {
    const r = say1(m, link, code, num, slash, dotted, w, arrow, foot, hash, sym, at, s, o);
    if (r !== m) changed = true;
    return r;
  });
  return changed ? out.replace(/ {2,}/g, ' ').replace(/ ([,.!?;:])(?![A-Za-z0-9])/g, '$1').replace(/[,;:](?= ?[,;.!?]| :)/g, '').replace(/^[\s,;:]+/, '').replace(/ +$/, '') : out;
}
function say1(m: string, link: string, code: string, num: string, slash: string, dotted: string, w: string, arrow: string, foot: string, hash: string, sym: string, at: number, s: string, o: Voicing): string {
  {
    if (link !== undefined) {
      let l = o.link ? o.link() : m.slice(1, -1);
      // after "this", "the", "my"…, the link's own article goes: "this GitHub link", "the other GitHub link"
      if (/^(?:the|this|that|these|those|my|our|your|their|his|her|its)$/i.test(before(s, at))) l = l.replace(/^an? /, '').replace(/^another /, 'other ');
      const opens = at === 0 || (/[.!?]["'”’)\]]?\s+$/.test(s.slice(Math.max(0, at - 4), at)) && !ABBR_END.test(s.slice(Math.max(0, at - 10), at)));
      return opens ? l.charAt(0).toUpperCase() + l.slice(1) : l;
    }
    if (code !== undefined) return m.slice(1, -1).replace(/^`|`$/g, '');
    if (num !== undefined) return numeric(m, s, at);
    if (slash !== undefined) return SLASH[m];
    if (dotted !== undefined) {
      const said = DOTTED[m] ?? (/^(?:[A-Z]\.)+[A-Z]?\.?$/.test(m) ? spell(m.replace(/\./g, '')) : undefined);
      if (said === undefined) return m;
      return said + (m.endsWith('.') && ends(s, at + m.length) ? '.' : '');
    }
    if (w !== undefined) return word(m, s, at);
    if (arrow !== undefined) return /(?:<-+>|<=>|↔|⇔)/.test(m) ? ' and ' : /(?:<-|←|⟵|⇐)/.test(m) ? ' from ' : ' to ';
    if (foot !== undefined) return footnote(m, s, at);
    if (hash !== undefined) return `number ${m.slice(1)}`;
    if (sym !== undefined) {
      if (m.trim()[0] === '*' && /\d\s?$/.test(s.slice(Math.max(0, at - 2), at)) && /^\s?\d/.test(s.slice(at + m.length, at + m.length + 2))) return ' times ';
      return m === ' – ' ? ' — ' : m === '–' ? '-' : m === '.NET' ? 'dot net' : '';
    }
    return m;
  }
}
