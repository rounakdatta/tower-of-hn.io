// The building's promises, for any floor from one person to 5,000 and up to 58 tables (and the real 1Password and "Holy
// shit" floors' shapes): every table and every person has a place; nobody stands within half a metre of anybody; no
// one stands in another table's lane (where its speakers stand and the camera works); everyone is inside the glass; no
// two tables' footprints touch; the same floor always makes the same building; and it's quick enough to make on the
// way in. Run with: node --test apps/client/src/building.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFloor, audit, frontOf, PLAN, type PlanIn } from './building.ts';
import { floorClock } from './floortime.ts';
import { hnFloor } from './floorgen.ts';

const planOf = (people: number, tables: number, seed = people) => {
  const c = floorClock(hnFloor({ people, tables, seed }))!;
  return { c, plan: planFloor(c) };
};

test('every table and every person on the floor has a place, from one person to 5,000', () => {
  for (const [people, tables] of [[1, 1], [2, 1], [5, 2], [50, 9], [200, 34], [356, 58], [709, 58], [800, 58], [3000, 58], [5000, 58]] as const) {
    const { c, plan } = planOf(people, tables);
    assert.equal(plan.tables.length, c.tables.length, 'every table');
    assert.equal(plan.people.length, c.people.length, 'every person');
    for (const p of plan.people) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), `${p.name} placed`);
    for (const t of plan.tables) assert.ok(t.seats.length >= 1 && t.seats.length <= PLAN.SEATS);
    // the seated are the first at each table who started there; every chair has its person
    for (const t of plan.tables) for (const s of t.seats) assert.ok(s.who >= 0 && plan.people[s.who].seated && plan.people[s.who].home === t.index);
  }
});

test('nobody stands within half a metre of anybody, nobody in another table\'s lane, nobody outside the glass, no two tables touching', () => {
  for (const [people, tables] of [[5, 2], [50, 9], [200, 34], [356, 58], [800, 58], [3000, 58], [5000, 58]] as const) {
    const { plan } = planOf(people, tables);
    const a = audit(plan);
    assert.ok(a.closest >= 0.5, `${people}: the closest two are ${a.closest.toFixed(2)} m apart`);
    assert.equal(a.inLane, 0, `${people}: people in a lane`);
    assert.equal(a.outside, 0, `${people}: people outside the glass`);
    assert.equal(a.tableOverlap, 0, `${people}: tables touching`);
    // a table's front (where whoever speaks there stands) is clear of every other table's people and chairs
    for (const t of plan.tables) for (const f of frontOf(t)) for (const o of plan.tables) {
      if (o === t) continue;
      assert.ok(Math.hypot(f.x - o.x, f.z - o.z) > o.foot, 'a front inside another table\'s footprint');
    }
  }
});

test('the same floor always makes the same building, whatever order its tables are listed in', () => {
  const f = hnFloor({ people: 356, tables: 58, seed: 4 });
  const a = planFloor(floorClock(f)!), b = planFloor(floorClock(f)!);
  assert.deepEqual(a, b);
  // HN re-ranks a story's threads all day: the building is laid in the order they opened, not their rank
  const shuffled = { tables: [...f.tables].reverse() };
  const c1 = floorClock(f)!, c2 = floorClock(shuffled)!;
  const p1 = planFloor(c1), p2 = planFloor(c2);
  const where = (c: typeof c1, p: typeof p1) => new Map(c.tables.map((t, k) => [t.root, `${p.tables[k].x.toFixed(3)},${p.tables[k].z.toFixed(3)}`]));
  assert.deepEqual(where(c1, p1), where(c2, p2));
});

test('the first conversation is in the middle and later ones further out: the floor lights from the centre', () => {
  const { c, plan } = planOf(356, 58, 4);
  const order = c.tables.map((t, k) => k).sort((a, b) => c.tables[a].open - c.tables[b].open);
  const r = (k: number) => Math.hypot(plan.tables[k].x, plan.tables[k].z);
  assert.equal(r(order[0]), 0);
  const early = order.slice(0, 10).reduce((s, k) => s + r(k), 0) / 10, late = order.slice(-10).reduce((s, k) => s + r(k), 0) / 10;
  assert.ok(late > early * 1.5, `the last ten tables average ${late.toFixed(1)} m out, the first ten ${early.toFixed(1)} m`);
});

test('one table is the tower\'s own room, two small ones a little more; a big one is as wide as it needs, and no wider than it must', () => {
  assert.equal(planOf(1, 1).plan.R, PLAN.MIN_R);
  assert.ok(planOf(5, 2).plan.R < 9.5, 'two small tables: a little wider than the tower');
  const big = planOf(356, 58, 4).plan, huge = planOf(5000, 58, 9).plan;
  assert.ok(big.R > PLAN.MIN_R && big.R < 34, `356 people, 58 tables: ${big.R.toFixed(1)} m`);
  assert.ok(huge.R < 60, `5,000 people: ${huge.R.toFixed(1)} m`);
});

test('a big crowd stands round its own table, ring behind ring, nearest first; the seated are its first few', () => {
  // one table: a hundred people start there
  const f: PlanIn = { tables: [{ open: 0, people: Array.from({ length: 100 }, (_, i) => i) }], people: Array.from({ length: 100 }, (_, i) => ({ name: `p${i}`, home: 0 })) };
  const p = planFloor(f);
  assert.deepEqual(p.people.slice(0, 8).map((x) => x.seated), Array(8).fill(true));
  assert.ok(p.people.slice(8).every((x) => !x.seated));
  const d = p.people.map((x) => Math.hypot(x.x - p.tables[0].x, x.z - p.tables[0].z));
  for (let i = 9; i < 100; i++) assert.ok(d[i] >= d[i - 1] - 1e-9 || i === 8, 'whoever came earlier stands no further back');
  // a partly filled ring is spread all the way round, not bunched on one side
  const ring0 = p.people.slice(8, 20).map((x) => Math.atan2(x.z - p.tables[0].z, x.x - p.tables[0].x));
  const quadrants = new Set(ring0.map((a) => Math.floor(((a + Math.PI) / (Math.PI / 2)) % 4)));
  assert.equal(quadrants.size, 4);
});

test('58 tables and 5,000 people are planned in well under a second', () => {
  const c = floorClock(hnFloor({ people: 5000, tables: 58, seed: 31 }))!;
  const t0 = performance.now();
  planFloor(c);
  const ms = performance.now() - t0;
  assert.ok(ms < 900, `${ms.toFixed(0)} ms`);
});
