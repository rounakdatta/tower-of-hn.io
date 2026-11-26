// The timeline's promises, whatever the conversation: every turn lasts what it says, nobody is counted before they
// speak, the playhead never lands on a turn that has not started, a link's ?t= and the number mean the same moment, and
// no number is rounded up. Run with: node --test apps/client/src/timeline.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOf, turnAt, joinedAt, joinsIn, sayIn, valueText, stepFrom, parseT, formatT, type Said, type Line } from './timeline.ts';

/** a turn, voiced for `secs` (or not voiced yet), after a gap of `gap` ms */
const turn = (by: string, secs: number | null, o: Partial<Said> = {}): Said => ({ id: 1, by, depth: 1, gapMs: 0, ...(secs === null ? {} : { v: ['x.opus', secs] as [string, number] }), ...o });
/** n turns of the same length, a second apart, said by people[k % people.length] */
const talk = (n: number, secs = 10, people = n): Said[] => Array.from({ length: n }, (_, k) => turn(`p${k % people}`, secs, { id: k, gapMs: k ? 1000 : 0 }));
/** the 1Password thread's shape, in miniature: an opener, six branches, a crowd that thins into regulars, a few turns not voiced yet */
function thread(): Said[] {
  let s = 7;
  const r = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  return Array.from({ length: 271 }, (_, k) => turn(k < 180 ? `new${k}` : `new${Math.floor(r() * 180)}`, k % 40 === 39 ? null : 6 + Math.floor(r() * 85), { id: k, depth: k === 0 ? 0 : k % 45 === 1 ? 1 : 2, gapMs: k ? 220 + Math.floor(r() * 600) : 0 }));
}

test('a voiced turn lasts what it says; an unvoiced one what the table\'s voiced turns average', () => {
  const l = lineOf([turn('a', 12), turn('b', 7), turn('c', null), turn('d', 5)]);
  const len = (k: number) => l.moments[k].end - l.moments[k].start;
  assert.equal(len(0), 12);
  assert.equal(len(1), 7);
  assert.equal(len(3), 5);
  assert.equal(len(2), (12 + 7 + 5) / 3);
});

test('an unvoiced turn is a guess that follows the table: it has no say in the average, and a table with no voice at all gets a typical 16 s', () => {
  // a voice of 0 s is no voice (nothing was said): it is guessed at, and it does not drag the average down
  const l = lineOf([turn('a', 30), turn('b', 0), turn('c', null)]);
  assert.equal(l.moments[1].end - l.moments[1].start, 30);
  assert.equal(l.moments[2].end - l.moments[2].start, 30);
  const none = lineOf([turn('a', null), turn('b', null)]);
  assert.equal(none.moments[0].end, 16);
  assert.equal(none.total, 32);
});

test('hours of quiet on HN take no room: only the gaps between turns are on the clock, and the first turn starts at 0', () => {
  const l = lineOf([turn('a', 10, { gapMs: 3_600_000 }), turn('b', 10, { gapMs: 500 }), turn('c', 10, { gapMs: 800 })]);
  assert.equal(l.moments[0].start, 0);
  assert.equal(l.moments[1].start, 10.5);
  assert.equal(l.moments[2].start, 21.3);
  assert.equal(l.total, l.moments[2].end);
  assert.equal(l.total, 31.3);
});

test('who has joined: the opener is the first, a name counts once, and the count only ever goes up', () => {
  const l = lineOf([turn('a', 5), turn('b', 5), turn('a', 5), turn('c', 5), turn('b', 5)]);
  assert.deepEqual(l.moments.map((m) => m.joined), [1, 2, 2, 3, 3]);
  assert.deepEqual(l.moments.map((m) => m.first), [true, true, false, true, false]);
  assert.equal(l.people, 3);
  const big = lineOf(thread());
  for (let k = 1; k < big.moments.length; k++) assert.ok(big.moments[k].joined >= big.moments[k - 1].joined);
  assert.equal(big.moments[big.moments.length - 1].joined, big.people);
  assert.equal(big.moments.filter((m) => m.first).length, big.people);
});

test('branches are the direct replies to the opener: where the conversation turns', () => {
  const l = lineOf([turn('a', 5, { depth: 0 }), turn('b', 5, { depth: 1 }), turn('c', 5, { depth: 2 }), turn('d', 5, { depth: 2 }), turn('e', 5, { depth: 1 }), turn('f', 5, { depth: 3 })]);
  assert.deepEqual(l.branches, [1, 4]);
});

test('the playhead never maps to a turn that has not started, nor skips one that has', () => {
  const l = lineOf(thread());
  for (let t = -5; t < l.total + 20; t += 0.37) {
    const k = turnAt(l, t), m = l.moments;
    assert.ok(k >= 0 && k < m.length);
    if (t >= m[0].start) assert.ok(m[k].start <= t, `${t} s lands on turn ${k}, which starts at ${m[k].start}`);
    if (k + 1 < m.length) assert.ok(m[k + 1].start > t, `${t} s skips turn ${k + 1}, which has started (at ${m[k + 1].start})`);
  }
});

test('turnAt at the edges: exactly when a turn starts is that turn; before the start the first; past the end the last; nothing at all is -1', () => {
  const l = lineOf(talk(5));
  for (const m of l.moments) {
    assert.equal(turnAt(l, m.start), m.k);
    if (m.k) assert.equal(turnAt(l, m.start - 1e-9), m.k - 1);
  }
  assert.equal(turnAt(l, -100), 0);
  assert.equal(turnAt(l, l.total), 4);
  assert.equal(turnAt(l, l.total + 1e6), 4);
  assert.equal(turnAt(lineOf([]), 3), -1);
});

test('who is in the room at a moment: everyone who has started speaking by then, and nobody before anyone has', () => {
  const l = lineOf([turn('a', 5), turn('b', 5), turn('a', 5), turn('c', 5)]);
  assert.equal(joinedAt(l, 0), 1);
  assert.equal(joinedAt(l, l.moments[1].start), 2);
  assert.equal(joinedAt(l, l.moments[1].start - 0.001), 1);
  assert.equal(joinedAt(l, l.moments[3].start), 3);
  assert.equal(joinedAt(l, 1e9), 3);
  assert.equal(joinedAt(lineOf([]), 5), 0);
});

test('the histogram counts every joiner once, in the stretch of the line where they started, however it is cut', () => {
  const l = lineOf(thread());
  for (const n of [1, 2, 7, 64, 130, 1000]) {
    const { bins, max } = joinsIn(l, n);
    assert.equal(bins.length, n);
    assert.equal(bins.reduce((a, b) => a + b, 0), l.people, `${n} bins`);
    assert.equal(max, Math.max(...bins));
  }
  // the joiners really are where it says: the first stretch of a ten-way cut holds exactly those who started in its tenth
  const { bins } = joinsIn(l, 10);
  for (let i = 0; i < 10; i++) assert.equal(bins[i], l.moments.filter((m) => m.first && Math.floor((m.start / l.total) * 10) === i).length);
  // (a crowd at the start and regulars after: the first stretches are busier than the last)
  assert.ok(bins[0] > bins[9]);
});

test('a last comment too short to move the total still joins the last stretch of the line', () => {
  // 2^-60 s is lost against a total of 1 s: the comment starts exactly at the end, which no stretch ends after
  const l = lineOf([turn('a', 1), turn('b', 2 ** -60)]);
  assert.equal(l.moments[1].start, l.total);
  for (const n of [1, 5, 7]) assert.equal(joinsIn(l, n).bins.reduce((a, b) => a + b, 0), 2, `${n} bins`);
});

test('an empty conversation draws an empty histogram, not an error', () => {
  const { bins, max } = joinsIn(lineOf([]), 8);
  assert.equal(bins.length, 8);
  assert.equal(max, 0);
  assert.equal(joinsIn(lineOf(talk(3)), 0).bins.length, 1);
});

test('sayIn never rounds up: 59.9 s is 59 s in, and 59 min 59.9 s is 59 min in', () => {
  assert.equal(sayIn(0), '0 s in');
  assert.equal(sayIn(0.99), '0 s in');
  assert.equal(sayIn(40), '40 s in');
  assert.equal(sayIn(59.9), '59 s in');
  assert.equal(sayIn(60), '1 min in');
  assert.equal(sayIn(119.99), '1 min in');
  assert.equal(sayIn(750), '12 min in');
  assert.equal(sayIn(3599.9), '59 min in');
  assert.equal(sayIn(3600), '1 h 00 min in');
  assert.equal(sayIn(3600 + 4 * 60 + 59.9), '1 h 04 min in');
  assert.equal(sayIn(7 * 3600 + 30 * 60), '7 h 30 min in');
  assert.equal(sayIn(-5), '0 s in');
});

test('what a screen reader says of the knob: how far in, how many people, and who is speaking; 1 is a person; 9,999 is not 10k', () => {
  const l = lineOf(talk(3, 10, 3));
  assert.equal(valueText(l, 0), '0 s in, 1 person, comment by p0');
  assert.equal(valueText(l, l.moments[1].start + 3), `${Math.floor(l.moments[1].start + 3)} s in, 2 people, comment by p1`);
  assert.equal(valueText(l, 0, 9), '0 s in, 10 people, comment by p0');          // the others in the room count too
  const many = lineOf(talk(40, 10, 40));
  assert.equal(valueText(many, many.moments[0].start, 9998), '0 s in, 9,999 people, comment by p0');
  assert.equal(valueText(many, many.moments[39].start, 9960), `${Math.floor(many.moments[39].start / 60)} min in, 10,000 people, comment by p39`);
  assert.equal(valueText(lineOf([]), 5), 'Nothing said yet');
});

test('the arrow keys move by comments, the way back is the way there, and the ends hold', () => {
  const l = lineOf(talk(30));
  const at = (k: number) => l.moments[k].start;
  assert.equal(stepFrom(l, at(5), 1), at(6));
  assert.equal(stepFrom(l, at(5), -1), at(4));
  assert.equal(stepFrom(l, at(5), 10), at(15));
  assert.equal(stepFrom(l, at(5), -10), at(0));                           // (it stops at the first)
  assert.equal(stepFrom(l, at(25), 10), at(29));                          // (and at the last)
  assert.equal(stepFrom(l, at(29), 1), at(29));
  assert.equal(stepFrom(l, at(0), -1), at(0));
  // from the middle of a comment, next is the next comment's start, and every answer is a start the line can map back to itself
  assert.equal(stepFrom(l, at(5) + 4, 1), at(6));
  for (let k = 0; k < 30; k++) assert.equal(turnAt(l, stepFrom(l, at(k) + 1, 1)), Math.min(29, k + 1));
  assert.equal(stepFrom(lineOf([]), 5, 1), 0);
});

test('?t=12m30s and 750 are the same moment, and what is not a time is not one', () => {
  assert.equal(parseT('12m30s'), 750);
  assert.equal(parseT('750'), 750);
  assert.equal(parseT('12m30s'), parseT('750'));
  assert.equal(parseT('1h4m'), 3840);
  assert.equal(parseT('1h'), 3600);
  assert.equal(parseT('90s'), 90);
  assert.equal(parseT('2m'), 120);
  assert.equal(parseT('12M30S'), 750);
  assert.equal(parseT(' 45 '), 45);
  assert.equal(parseT('0'), 0);
  assert.equal(parseT('1.5'), 1.5);
  for (const bad of ['', '  ', null, undefined, 'abc', 'm', 'h', '12m30', '1h 4m', '-5', '12:30', '1e3', 's30', '30s12m']) assert.equal(parseT(bad as string), null, `${bad}`);
});

test('a link to share says whole seconds, never more than were played, and reads back as the same moment', () => {
  assert.equal(formatT(750), '12m30s');
  assert.equal(formatT(45), '45s');
  assert.equal(formatT(60), '1m');
  assert.equal(formatT(3600), '1h');
  assert.equal(formatT(3840), '1h4m');
  assert.equal(formatT(3601), '1h1s');
  assert.equal(formatT(0), '0s');
  assert.equal(formatT(-3), '0s');
  assert.equal(formatT(59.9), '59s');
  for (const t of [0, 1, 59, 60, 61, 599, 750, 3599, 3600, 3661, 7325, 86399]) assert.equal(parseT(formatT(t)), t, `${t}`);
  for (let t = 0; t < 4000; t += 13.7) assert.equal(parseT(formatT(t)), Math.floor(t));
});

test('a long conversation lays out in order, and its total is where the last turn ends', () => {
  const l: Line = lineOf(thread());
  assert.equal(l.moments.length, 271);
  for (let k = 1; k < l.moments.length; k++) assert.ok(l.moments[k].start >= l.moments[k - 1].end, `turn ${k} starts before the one before ends`);
  assert.equal(l.total, l.moments[270].end);
  assert.ok(l.total > 3600, 'a big one runs for hours');
});
