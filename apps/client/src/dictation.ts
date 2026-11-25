// Dictation into the reply box: the recogniser's results as one stretch of text, and that text after what's already
// in the box. Pure functions (tested in dictation.test.ts); the words themselves are never changed, only spacing and a
// capital where a sentence starts.
export type Result = { isFinal: boolean; 0: { transcript: string } };
export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const SPACED = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{N}]/u;
/** two stretches of text as one: a space between words of a spaced script (none in Chinese or Japanese) */
export function glue(a: string, b: string) {
  if (!a || !b || /\s$/.test(a) || /^\s/.test(b)) return a + b;
  return (SPACED.test(a.slice(-1)) || /[.!?,;:]$/.test(a)) && SPACED.test(b[0]) ? `${a} ${b}` : a + b;
}
/** One listening round, as text. Each of the recogniser's results holds a stretch of what you said, except in Chrome on
 *  Android, whose continuous sessions repeat all the earlier words in each new result: there, a result that starts
 *  with everything before it replaces it, instead of saying it all twice. */
export function heard(results: ArrayLike<Result>, cumulative: boolean) {
  const add = (acc: string, w: string) => (acc && cumulative && norm(acc) && norm(w).startsWith(norm(acc)) ? w : glue(acc, w));
  let fin = '', mid = '';
  for (let i = 0; i < results.length; i++) {
    const r = results[i], w = r[0]?.transcript ?? '';
    if (r.isFinal) fin = add(fin, w); else mid = add(mid, w);
  }
  return add(fin, mid).replace(/\s+/g, ' ').trim();
}
/** What you said, after what's already in the box: a space between, and a capital only where a sentence starts.
 *  Nothing else changes: the words are yours. */
export function join(base: string, said: string) {
  const s = said.replace(/\s+/g, ' ').trim();
  if (!s) return base;
  const opens = !base.trim() || /[.!?]["'”’)\]]*\s*$/.test(base) || /\n\s*$/.test(base);
  return glue(base, opens && !/^\p{Ll}\p{Lu}/u.test(s) ? s[0].toUpperCase() + s.slice(1) : s);   // (not "IPhone")
}
