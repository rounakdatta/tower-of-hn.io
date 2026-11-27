// The floor clock's promises, whatever the floor: people walk in with their first comment and go an hour after their
// last; a table opens with its first comment; every comment has its own moment; the line gives comments room and the
// clock some; and the room at a moment is the same however you got there. From 0 to 5,000 people, and 58 tables.
// Run with: node --test apps/client/src/floortime.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  floorClock, uOf, tOf, latest, presentAt, openAt, tableAt, talkingAt, floorAt, floorText, stepFloor, flowIn, seatFrom, sayIn, isHere,
  RoomAt, DWELL, GLOW, TALKING, type TFloor, type TTurn, type FloorClock,
} from './floortime.ts';

import { rng, hnFloor } from './floorgen.ts';

/** everything the room shows at t, straight from the definitions (no index, no binary search): the oracle */
function brute(f: TFloor, c: FloorClock, t: number) {
  const all = c.comments;
  const firstOf = new Map<string, number>(), lastOf = new Map<string, number>();
  for (const x of all) { if (!firstOf.has(x.by)) firstOf.set(x.by, x.at); lastOf.set(x.by, x.at); }
  let people = 0;
  for (const [n, a] of firstOf) if (a <= t && t < lastOf.get(n)! + DWELL) people++;
  const tables = f.tables.map((_, k) => {
    const mine = all.filter((x) => x.table === k && x.at <= t);
    const glow = mine.reduce((g, x) => g + Math.exp(-(t - x.at) / GLOW), 0);
    return { open: mine.length > 0, turns: mine.length, last: mine.length ? mine[mine.length - 1].i : -1, glow, talking: mine.length > 0 && t - mine[mine.length - 1].at < TALKING };
  });
  const said = all.filter((x) => x.at <= t).length - 1;
  return { people, tables, said, open: tables.filter((x) => x.open).length };
}

test('someone walks in with their first comment and goes an hour after their last, at whichever tables they spoke', () => {
  const f: TFloor = { tables: [
    { root: 1, turns: [{ id: 1, by: 'ann', at: 100 }, { id: 5, by: 'bob', at: 900, replyTo: 1 }] },
    { root: 2, turns: [{ id: 2, by: 'bob', at: 300 }, { id: 9, by: 'ann', at: 7200, replyTo: 2 }] },
  ] };
  const c = floorClock(f)!;
  const ann = c.people[c.byName.get('ann')!], bob = c.people[c.byName.get('bob')!];
  assert.deepEqual([ann.enter, ann.leave, ann.home, ann.comments, ann.tables], [100, 7200 + DWELL, 0, 2, 2]);
  assert.deepEqual([bob.enter, bob.leave, bob.home, bob.comments, bob.tables], [300, 900 + DWELL, 1, 2, 2]);
  assert.equal(c.people.length, 2, 'one person per name, however many tables they speak at');
  assert.equal(presentAt(c, 99), 0);
  assert.equal(presentAt(c, 100), 1, 'in the room from the moment of their first comment');
  assert.equal(presentAt(c, 300), 2);
  assert.equal(presentAt(c, 900 + DWELL - 1), 2);
  assert.equal(presentAt(c, 900 + DWELL), 1, 'bob goes an hour after his last comment');
  assert.equal(presentAt(c, 7200 + DWELL), 0);
  assert.equal(isHere(ann, 7199), true, 'a long gap between comments is not a leaving: ann was following it');
});

test('a table opens with its first comment, however the thread lists its turns', () => {
  // HN lists a table's turns in thread order: a reply written before an earlier-listed sibling comes later in the list
  const f: TFloor = { tables: [{ root: 10, turns: [{ id: 10, by: 'a', at: 50 }, { id: 30, by: 'b', at: 900 }, { id: 20, by: 'c', at: 400 }] }] };
  const c = floorClock(f)!;
  assert.equal(c.tables[0].open, 50);
  assert.deepEqual([...c.tables[0].times], [50, 400, 900], 'a table\'s comments in the order they were written');
  assert.equal(openAt(c, 49), 0);
  assert.equal(openAt(c, 50), 1);
  assert.deepEqual(c.comments.map((x) => x.by), ['a', 'c', 'b']);
  assert.deepEqual(c.comments.map((x) => x.k), [0, 1, 2]);
});

test('comments written in the same second each get their own moment, in id order, whatever order they arrive in', () => {
  const a: TFloor = { tables: [{ root: 1, turns: [{ id: 3, by: 'z', at: 60 }, { id: 1, by: 'x', at: 60 }] }, { root: 2, turns: [{ id: 2, by: 'y', at: 60 }] }] };
  const b: TFloor = { tables: [{ root: 2, turns: [{ id: 2, by: 'y', at: 60 }] }, { root: 1, turns: [{ id: 1, by: 'x', at: 60 }, { id: 3, by: 'z', at: 60 }] }] };
  const ca = floorClock(a)!, cb = floorClock(b)!;
  assert.deepEqual(ca.comments.map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(cb.comments.map((x) => x.id), [1, 2, 3], 'the same order, however the floor lists its tables');
  for (let k = 1; k < 3; k++) assert.ok(ca.comments[k].at > ca.comments[k - 1].at, 'strictly later');
  assert.ok(ca.comments[2].at - 60 < 0.01, 'a millisecond apart, not a second');
});

test('a comment with no time is placed by its id between those around it; a floor with no times has no clock', () => {
  const f: TFloor = { tables: [{ root: 100, turns: [{ id: 100, by: 'a', at: 1000 }, { id: 150, by: 'b' }, { id: 200, by: 'c', at: 2000 }, { id: 260, by: 'd' }] }] };
  const c = floorClock(f)!;
  const b = c.comments.find((x) => x.by === 'b')!, d = c.comments.find((x) => x.by === 'd')!;
  assert.equal(b.known, false);
  assert.equal(b.at, 1500, 'halfway by id is halfway in time');
  assert.ok(d.at > 2000 && d.at < 2001, 'past the last known: just after it');
  assert.equal(floorClock({ tables: [{ root: 1, turns: [{ id: 1, by: 'a' }] }] }), null);
  assert.equal(floorClock({ tables: [] }), null);
});

test('the line gives each comment equal room and the clock the rest: a burst is wide, a quiet night narrow, and the ends are the ends', () => {
  // ten comments in ten minutes, then one ten hours later
  const turns: TTurn[] = Array.from({ length: 10 }, (_, k) => ({ id: k + 1, by: `p${k}`, at: 600 + k * 60 }));
  turns.push({ id: 99, by: 'late', at: 600 + 10 * 3600 });
  const c = floorClock({ tables: [{ root: 1, turns }] })!;
  assert.equal(uOf(c, 0), 0);
  assert.equal(uOf(c, c.end), 1);
  const burst = uOf(c, 600 + 9 * 60) - uOf(c, 600), night = uOf(c, 600 + 10 * 3600) - uOf(c, 600 + 9 * 60);
  assert.ok(burst > 0.5, `nine minutes of burst take ${burst.toFixed(2)} of the line`);
  assert.ok(night < 0.45, `ten quiet hours take ${night.toFixed(2)}`);
  assert.ok(night > 0.2, 'the night still reads as time passing');
  // the line is one-to-one: there and back again
  for (let k = 0; k <= 200; k++) {
    const u = k / 200, t = tOf(c, u);
    assert.ok(Math.abs(uOf(c, t) - u) < 1e-9, `u ${u}`);
  }
  let prev = -1;
  for (let t = 0; t <= c.end; t += c.end / 997) { const u = uOf(c, t); assert.ok(u > prev, 'rising'); prev = u; }
});

test('the line ends now, but never more than an hour after the last comment (the room is empty by then)', () => {
  const f: TFloor = { tables: [{ root: 1, turns: [{ id: 1, by: 'a', at: 100 }, { id: 2, by: 'b', at: 5000 }] }] };
  assert.equal(floorClock(f, 6000)!.end, 6000);
  assert.equal(floorClock(f, 50_000)!.end, 5000 + DWELL);
  assert.equal(floorClock(f)!.end, 5000 + DWELL);
  const behind = floorClock(f, 1000)!.end;
  assert.ok(behind >= 5000 && behind < 5000.01, 'a clock behind HN\'s still shows every comment');
});

test('at any moment the counts, every table and the latest comment are exactly what the definitions say (random floors, random moments)', () => {
  for (const [people, tables, seed] of [[1, 1, 1], [5, 3, 2], [50, 12, 3], [356, 58, 4], [709, 58, 5], [800, 40, 6]] as const) {
    const f = hnFloor({ people, tables, seed });
    const c = floorClock(f)!;
    const r = rng(seed * 31);
    for (let s = 0; s < 40; s++) {
      const t = r() < 0.15 ? c.comments[Math.floor(r() * c.comments.length)].at : r() * c.end * 1.05;
      const o = brute(f, c, t);
      assert.equal(presentAt(c, t), o.people, `people at ${t} (${people}/${tables})`);
      assert.equal(openAt(c, t), o.open);
      assert.equal(latest(c, t), o.said);
      c.tables.forEach((_, k) => {
        const x = tableAt(c, k, t), y = o.tables[k];
        assert.equal(x.open, y.open); assert.equal(x.turns, y.turns); assert.equal(x.last, y.last); assert.equal(x.talking, y.talking);
        assert.ok(Math.abs(x.glow - y.glow) <= 1e-9 * Math.max(1, y.glow), `glow ${x.glow} vs ${y.glow}`);
      });
    }
  }
});

test('counts only ever say what has happened: people and tables never exceed the floor, and nobody is counted before their first word', () => {
  for (const people of [0, 1, 5, 50, 200, 800, 3000, 5000]) {
    const f = people ? hnFloor({ people, tables: Math.min(58, Math.max(1, Math.ceil(people / 6))), seed: people }) : { tables: [] };
    const c = floorClock(f);
    if (!people) { assert.equal(c, null); continue; }
    assert.ok(c);
    assert.equal(c.people.length <= people, true);
    let prevOpen = 0, prevSaid = -1;
    for (let k = 0; k <= 300; k++) {
      const t = (k / 300) * c.end;
      const now = floorAt(c, t);
      assert.ok(now.people >= 0 && now.people <= c.people.length);
      assert.ok(now.tables >= prevOpen, 'tables only open');
      assert.ok(now.said >= prevSaid, 'the latest comment only moves on');
      assert.ok(now.people <= now.comments, 'nobody here without a comment to their name');
      prevOpen = now.tables; prevSaid = now.said;
    }
    assert.equal(floorAt(c, c.end).tables, c.tables.length, 'by the end every table has opened');
    assert.equal(presentAt(c, c.last + DWELL), 0, 'an hour after the last comment, everyone has gone');
  }
});

test('5,000 people and 58 tables: the clock is built in well under a frame budget per question', () => {
  const f = hnFloor({ people: 5000, tables: 58, seed: 99 });
  const t0 = performance.now();
  const c = floorClock(f)!;
  const built = performance.now() - t0;
  const r = rng(5);
  const t1 = performance.now();
  for (let s = 0; s < 1000; s++) { const t = r() * c.end; presentAt(c, t); for (let k = 0; k < c.tables.length; k++) tableAt(c, k, t); }
  const per = (performance.now() - t1) / 1000;
  assert.ok(built < 400, `built in ${built.toFixed(1)} ms`);
  assert.ok(per < 0.2, `a moment's counts and 58 tables in ${per.toFixed(3)} ms`);
});

test('the keys step one comment (or ten), on the floor or at one table, and never past the ends', () => {
  const f = hnFloor({ people: 60, tables: 8, seed: 11 });
  const c = floorClock(f)!;
  const first = c.comments[0].at, lastAt = c.comments[c.comments.length - 1].at;
  assert.equal(stepFloor(c, 0, 1), first, 'from before the first comment, the first');
  assert.equal(stepFloor(c, first, 1), c.comments[1].at);
  assert.equal(stepFloor(c, c.comments[5].at + 0.5, -1), c.comments[4].at);
  assert.equal(stepFloor(c, c.comments[5].at, 10), c.comments[15].at);
  assert.equal(stepFloor(c, lastAt, 1), lastAt, 'no further than the last');
  const tb = c.tables[2];
  assert.equal(stepFloor(c, 0, 1, 2), tb.times[0]);
  assert.equal(stepFloor(c, tb.times[0], 1, 2), tb.times[1] ?? tb.times[0]);
  assert.equal(seatFrom(c, 2, 0), tb.said[0], 'a seat before its table opened plays from its first comment');
  assert.equal(seatFrom(c, 2, tb.times[tb.times.length - 1] + 99), tb.said[tb.said.length - 1]);
});

test('what the slider says aloud, and the line\'s histogram counts every arrival once', () => {
  const f: TFloor = { tables: [{ root: 1, turns: [{ id: 1, by: 'tptacek', at: 7800 }, { id: 2, by: 'ann', at: 7810, replyTo: 1 }] }] };
  const c = floorClock(f)!;
  assert.equal(floorText(c, 10), '10 s in, nobody here yet');
  assert.equal(floorText(c, 7810), '2 h 10 min in, 2 people, 1 table, comment by ann');
  assert.equal(sayIn(3599.9), '59 min in', 'never rounded up');
  const big = floorClock(hnFloor({ people: 356, tables: 58, seed: 4 }))!;
  for (const n of [1, 7, 120, 480]) {
    const h = flowIn(big, n);
    assert.equal(h.enters.reduce((a, b) => a + b, 0), big.people.length);
    assert.equal(h.leaves.reduce((a, b) => a + b, 0), big.people.filter((p) => p.leave <= big.end).length);
    assert.ok(h.max >= 1);
  }
});

test('talking tables are those with a comment in the last half hour', () => {
  const f: TFloor = { tables: [{ root: 1, turns: [{ id: 1, by: 'a', at: 100 }] }, { root: 2, turns: [{ id: 2, by: 'b', at: 1000 }] }] };
  const c = floorClock(f)!;
  assert.equal(talkingAt(c, 150), 1);
  assert.equal(talkingAt(c, 1000), 2);
  assert.equal(talkingAt(c, 100 + TALKING), 1);
  assert.equal(talkingAt(c, 1000 + TALKING), 0);
});

test('who is in the room after any path of moves is exactly who is there going straight to t (1,000 random seeks, 0 to 5,000 people)', () => {
  for (const [people, tables] of [[1, 1], [5, 2], [50, 9], [356, 58], [800, 58], [3000, 58], [5000, 58]] as const) {
    const f = hnFloor({ people, tables, seed: people + 1 });
    const c = floorClock(f)!;
    const room = new RoomAt(c), r = rng(people * 7 + 3);
    let flips = 0;
    const shadow = new Uint8Array(c.people.length);
    const moves = people >= 3000 ? 300 : 1000;
    for (let s = 0; s < moves; s++) {
      // drags (small steps either way), jumps, exact comment moments, the ends, and repeats
      const x = r();
      const t = x < 0.45 ? Math.max(0, Math.min(c.end, (Number.isNaN(room.t) ? 0 : room.t) + (r() - 0.5) * c.end * 0.02))
        : x < 0.7 ? r() * c.end : x < 0.85 ? c.comments[Math.floor(r() * c.comments.length)].at : x < 0.9 ? 0 : x < 0.95 ? c.end : room.t || 0;
      room.move(t, (i, on) => { assert.notEqual(shadow[i] === 1, on, 'a flip is a change'); shadow[i] = on ? 1 : 0; flips++; });
      const straight = new RoomAt(c);
      straight.move(t, () => {});
      assert.deepEqual(room.here, straight.here, `the room at ${t.toFixed(1)} s after ${s + 1} moves (${people} people)`);
      assert.deepEqual(room.here, shadow, 'the audience heard every change, and only changes');
      assert.equal(room.here.reduce((a, b) => a + b, 0), presentAt(c, t));
    }
    assert.ok(flips > 0 || people < 2);
  }
});

test('a drag costs what changed: a small step looks at a handful of people, however big the floor', () => {
  const c = floorClock(hnFloor({ people: 3000, tables: 58, seed: 77 }))!;
  const room = new RoomAt(c);
  room.move(c.end / 3, () => {});
  let most = 0;
  for (let k = 1; k <= 200; k++) most = Math.max(most, room.move(c.end / 3 + k * (c.end / 3) / 2000, () => {}));
  assert.ok(most < 60, `a step of a 2,000th of the line looked at ${most} of 3,000 people`);
});

test('a thread that runs for weeks still glows: no overflow, however long a table lives', () => {
  const turns: TTurn[] = Array.from({ length: 40 }, (_, k) => ({ id: k + 1, by: `p${k % 7}`, at: k * 86_400 }));   // a comment a day for 40 days
  const c = floorClock({ tables: [{ root: 1, turns }] })!;
  for (const t of [0, 10 * 86_400, 39 * 86_400, 39 * 86_400 + 60]) {
    const g = tableAt(c, 0, t).glow;
    assert.ok(Number.isFinite(g) && g >= 0 && g <= 2, `glow ${g} at day ${(t / 86_400).toFixed(1)}`);
  }
  assert.ok(tableAt(c, 0, 39 * 86_400).glow >= 1, 'a comment this moment lights its table fully');
});
