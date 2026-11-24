import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spoken, sayHost, segment, linkName, LinkVoice, yearWords } from './spoken.ts';
import { speakable } from './speakable.ts';
import { letters } from './spoken-data.ts';

const says = (pairs: [string, string][]) => { for (const [a, b] of pairs) assert.equal(spoken(a), b, a); };

test('money: magnitudes, cents, ranges, rates, and a price before its noun', () => {
  says([
    ['OpenAI is now valued at $1.2T, up from $300B.', 'OpenAI is now valued at 1.2 trillion dollars, up from 300 billion dollars.'],
    ['$5, $1, $0.99, ~$5, $5/mo, $5-10, $1-2B', '5 dollars, 1 dollar, 99 cents, about 5 dollars, 5 dollars a month, 5 to 10 dollars, 1 to 2 billion dollars'],
    ['$300k then $5M then $2.5B', '300 thousand dollars then 5 million dollars then 2.5 billion dollars'],
    ['a $3T company bought a $5 coffee for the $10 plan', 'a 3 trillion dollar company bought a 5 dollar coffee for the 10 dollar plan'],
    ['it cost $11B today', 'it cost 11 billion dollars today'],
    ['€20, £5, ₹500, $12.99 and $1,000', '20 euros, 5 pounds, 500 rupees, 12 dollars 99 and 1,000 dollars'],
    ['$20/month', '20 dollars a month'],
  ]);
});

test('counts, multipliers, comparisons, ranges and units', () => {
  says([
    ['10M users and 3.5B parameters', '10 million users and 3.5 billion parameters'],
    ['a 27B model with 64K context', 'a 27B model with 64K context'],           // said as letters, the way people do
    ['10x faster, ~5% cheaper, >= 10 and < 2', '10 times faster, about 5% cheaper, at least 10 and less than 2'],
    ['from 2020-2024, 5-10 times, 20-30% of 3-4GB', 'from twenty twenty to twenty twenty-four, 5 to 10 times, 20 to 30 percent of 3 to 4 gigabytes'],
    ['16GB of RAM, a 600W PSU, 14nm, 1GW, 2 ms, 3.5GHz', '16 gigabytes of RAM, a 600 watt PSU, 14 nanometer, 1 gigawatt, 2 milliseconds, 3.5 gigahertz'],
    ['I <3 this', 'I love this'],
    ['10 <3 9', '10 less than 3 9'],
  ]);
});

test('dates, times, years and model numbers', () => {
  says([
    ['Released 2026-11-24 at 3:30pm', 'Released November 24th, twenty twenty-six at 3 30 P-M'],
    ['back in the 1990s, in 1984 and 2026', 'back in the nineteen nineties, in nineteen eighty-four and twenty twenty-six'],
    ['the RTX 4090 and 1080p video', 'the RTX forty ninety and ten eighty p video'],
    ['on Nov. 24 at 9am', 'on November 24th at 9am'],                     // espeak says "nine A M" itself
    ['it has 2048 entries', 'it has 2048 entries'],                        // a count, not a year
  ]);
  assert.equal(yearWords(2005), 'two thousand five');
});

test('abbreviations and net shorthand are said in full', () => {
  says([
    ['e.g. this, i.e. that, etc. vs w/ w/o b/c.', 'for example this, that is that, et cetera versus with without because.'],
    ['IMO, IIRC, AFAIK, FWIW, TL;DR, TIL, ELI5, YMMV.', "in my opinion, if I recall correctly, as far as I know, for what it's worth, T-L-D-R, today I learned, explain like I'm five, your mileage may vary."],
    ['imo and Imo and IME', 'in my opinion and in my opinion and in my experience'],
    ['and so on, etc...', 'and so on, et cetera...'],
  ]);
});

test('capitals: spelled as one word, plurals with their s, words left as words', () => {
  says([
    ['LLMs and GPUs, the OP said; PR\'s, CVEs', 'L-L-Ems and G-P-Yous, the O-P said; P-Ars, C-V-Ees'],
    ['GUIs, ROMs. ARM\'s and NASA\'s.', 'gooeys, roms. arm\'s and nasa\'s.'],
    ['The NYC ROI, an AGI, MoE, PoC, QA and the U.S.A.', 'The N-Y-C R-O-I, an A-G-I, M-O-E, P-O-C, Q-Eh and the U-S-Eh.'],
    ['World War II and A.I. at 3 a.m.', 'World War two and A-I at 3 A-M.'],
    ['It DOES work and WoW is fun', 'It DOES work and WoW is fun'],
    ['Qwen on Postgres with kubectl, in Clojure', 'Kwen on Post-gress with kube control, in Closure'],
  ]);
  assert.equal(letters('the F A A'), 'the F-Eh-Eh');                         // espeak reads a lone A as "uh"
});

test('symbols, footnotes and markdown leftovers', () => {
  says([
    ['See [1] and #1 on the list.', 'See and number 1 on the list.'],
    ['Paris -> London', 'Paris to London'],
    ['**bold** and *this*', 'bold and this'],
    ['10, <3, ok', '10, ok'],                                                // nothing doubled where a mark was dropped
    ['10²⁰ operations, 10² and the study¹', '10 to the twentieth operations, 10 squared and the study'],
  ]);
});

test('domains: said the way people say the site', () => {
  assert.equal(sayHost('nypost.com'), 'N-Y Post dot com');
  assert.equal(sayHost('www.nytimes.com'), 'N-Y Times dot com');
  assert.equal(sayHost('wsj.com'), 'W-S-J dot com');
  assert.equal(sayHost('arstechnica.com'), 'Ars Technica dot com');
  assert.equal(sayHost('techcrunch.com'), 'TechCrunch dot com');
  assert.equal(sayHost('bbc.co.uk'), 'BBC dot co dot U-K');
  assert.equal(sayHost('fly.io'), 'fly dot I-O');
  assert.equal(sayHost('epoch.ai'), 'Epoch dot A-I');
  assert.equal(segment('nyt'), 'N-Y-T');
  assert.equal(spoken('Formaviva.com did it, in Next.js'), 'formaviva dot com did it, in Next J-S');
  assert.equal(segment('thedailybeast'), 'the daily beast');
  assert.equal(segment('quantumcomputingreport'), 'quantum computing report');
  assert.equal(segment('mathisfun'), 'mathisfun');                          // no confident split: left whole
  assert.equal(segment('wsws'), 'W-S-W-S');                                 // no vowels: spelled
});

test('links: a platform by its brand, a site by its domain, never the path', () => {
  assert.equal(linkName('https://github.com/foo/bar').phrase, 'a GitHub link');
  assert.equal(linkName('https://en.wikipedia.org/wiki/X').phrase, 'a Wikipedia link');
  assert.equal(linkName('https://arxiv.org/abs/2401.1').phrase, 'an archive paper');
  assert.equal(linkName('https://news.ycombinator.com/item?id=1').phrase, 'another Hacker News thread');
  assert.equal(linkName('https://nypost.com/2026/11/24/business/x/?utm=y#z').phrase, 'N-Y Post dot com');
  assert.equal(linkName('https://192.168.1.1/admin').phrase, 'a link');
  assert.equal(linkName('not a url').phrase, 'a link');
  const v = new LinkVoice();
  assert.equal(v.inline('https://github.com/a'), 'a GitHub link');
  assert.equal(v.inline('https://github.com/b'), 'another GitHub link');
  assert.equal(new LinkVoice().alone(['https://nypost.com/x']), 'A link to N-Y Post dot com.');
  assert.equal(new LinkVoice().alone(['https://en.wikipedia.org/a', 'https://youtube.com/watch?v=1', 'https://nypost.com/x']), 'Three links: Wikipedia, YouTube and N-Y Post dot com.');
});

test('in a comment: links said where they stand, or once for a list of them', () => {
  const s = speakable('See <a href="https://github.com/foo/bar">https://github.com/foo/bar</a> for details.<p><a href="https://nypost.com/x">https://nypost.com/x</a>');
  assert.deepEqual(s.segments.map((x: any) => x.kind === 'link' ? x.say : x.text), ['See a GitHub link for details.', '', 'A link to N-Y Post dot com.']);
  const e = speakable('I tell the story. <a href="https://youtube.com/watch?v=1">https://youtube.com/watch?v=1</a>');
  assert.equal((e.segments[0] as any).text, 'I tell the story. A YouTube link');
  const q = speakable('&gt; It costs $5.<p>Not $1.2T.');
  assert.equal((q.segments[0] as any).text, 'Quote: It costs 5 dollars. End quote.');
  assert.equal((q.segments[1] as any).text, 'Not 1.2 trillion dollars.');
});

test('one spoken line per written sentence, so the voice and the subtitles stay in step', () => {
  const s = speakable('It is $5. Mr. Smith agreed, e.g. with $1.2T. Done!') as any;
  assert.equal(s.segments[0].text, 'It is 5 dollars.\nMister Smith agreed, for example with 1.2 trillion dollars.\nDone!');
});

test('pure and deterministic', () => {
  const t = 'LLMs cost $1.2T at nypost.com, e.g. 10x.';
  assert.equal(spoken(t), spoken(t));
  assert.equal(spoken('Plain words stay exactly as they are.'), 'Plain words stay exactly as they are.');
  assert.equal(spoken('Привет, мир — 你好'), 'Привет, мир — 你好');            // other scripts untouched
});

test('linear on hostile input: long runs of digits, capitals, dots, symbols and links', () => {
  const nasty = [
    '9'.repeat(200_000), '$'.repeat(100_000) + '1', '1.'.repeat(100_000), 'A'.repeat(200_000), 'a.'.repeat(100_000),
    '<'.repeat(100_000) + '3', '-'.repeat(100_000) + '>', '1-'.repeat(100_000), '$1-'.repeat(60_000), 'LLMs '.repeat(40_000),
    'x'.repeat(100_000) + '.com', ('ab'.repeat(30) + '.').repeat(3000) + 'com', '[1]'.repeat(60_000), '~'.repeat(100_000) + '5',
    ''.repeat(50_000) + 'x' + '', 'e.g.'.repeat(50_000), '1,'.repeat(100_000) + '000', 'w/'.repeat(100_000),
  ];
  for (const n of nasty) {
    const t0 = performance.now();
    spoken(n);
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${JSON.stringify(n.slice(0, 12))}… (${n.length} chars) took ${ms.toFixed(0)} ms`);
  }
  const html = ('<a href="https://x' + 'a'.repeat(50) + '.com/">link</a> ').repeat(2000);
  const t0 = performance.now();
  speakable(html);
  assert.ok(performance.now() - t0 < 1500);
});
