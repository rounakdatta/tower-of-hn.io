// The hall's promises, for any crowd from nobody to 5,000: everyone has a place, nobody stands in anybody, the same
// room always fills the same way, and people arriving never move the people already there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hall, HALL, frontPlaces, tiersFor, type HallTable, type Place } from './hall.ts';

const R = 7;
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
/** rooms as the interior lays them out: one table, a full room of ten, the 1Password floor's eight, none at all */
const ROOMS: Record<string, HallTable[]> = {
  none: [],
  one: [{ x: 0, z: 1.2, r: 0.86 }],
  eight: [{ x: 0, z: 1.2, r: 0.86 }, { x: -2.9, z: -0.4, r: 0.86 }, { x: 2.9, z: -0.6, r: 0.86 }, { x: 0.2, z: -2.7, r: 0.75 }, { x: -2.4, z: 3.6, r: 0.53 }, { x: 2.5, z: 3.5, r: 0.64 }, { x: -3.2, z: -3.4, r: 0.53 }, { x: 3.4, z: -3.3, r: 0.53 }],
  ten: Array.from({ length: 10 }, (_, k) => { const a = k * 0.63 + 0.3, r = k ? 2.2 + (k % 3) * 1.1 : 0; return { x: Math.cos(a) * r, z: Math.sin(a) * r, r: 0.5 }; }),
};
const KEEP = [{ x: 0, z: R - 1.7, r: 1.1 }, { x: -(R - 0.6), z: 0, r: 0.9 }];
const SIZES = [0, 1, 2, 5, 13, 50, 120, 200, 499, 800, 1500, 3000, 5000];

function fill(room: HallTable[], n: number, seed = 7, expected = n) {
  const r = rng(seed), hall = new Hall(R, room, KEEP, expected), places: (Place | null)[] = [];
  for (let i = 0; i < n; i++) places.push(hall.add(room.length ? Math.floor(Math.pow(r(), 2.2) * room.length) : -1));
  return { hall, places };
}

/** the closest two places on one level, by a grid (5,000 people is 12 million pairs otherwise) */
function closest(places: Place[]) {
  let best = Infinity;
  const cells = new Map<string, Place[]>();
  const key = (p: Place, dx = 0, dz = 0) => `${p.level}:${Math.floor(p.x) + dx}:${Math.floor(p.z) + dz}`;
  for (const p of places) { const k = key(p); (cells.get(k) ?? cells.set(k, []).get(k)!).push(p); }
  for (const p of places) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const q of cells.get(key(p, dx, dz)) ?? []) if (q !== p) best = Math.min(best, Math.hypot(p.x - q.x, p.z - q.z));
  }
  return best;
}

for (const [name, room] of Object.entries(ROOMS)) {
  test(`${name} table(s): from nobody to 5,000 people, everyone has a place and nobody stands in anybody`, () => {
    for (const n of SIZES) {
      const { hall, places } = fill(room, n);
      assert.equal(places.filter((p) => !p).length, 0, `${n} people: someone has no place`);
      const ps = places as Place[];
      // the widest head with hair is 0.49 m across, the widest shoulders 0.48 m
      if (ps.length > 1) assert.ok(closest(ps) >= 0.5, `${n} people: two places ${closest(ps).toFixed(3)} m apart`);
      for (const p of ps) {
        assert.ok(Math.hypot(p.x, p.z) <= R - 0.5, `${n}: a place outside the glass`);
        if (p.level === 0) {
          for (const t of room) assert.ok(Math.hypot(p.x - t.x, p.z - t.z) > t.r + HALL.FRONT + HALL.LANE, `${n}: someone stands in a table's fishbowl`);
          for (const k of KEEP) assert.ok(Math.hypot(p.x - k.x, p.z - k.z) > k.r, `${n}: someone stands where the room keeps clear`);
        } else assert.ok(Math.hypot(p.x, p.z) > HALL.RAIL, `${n}: someone stands in the air past a gallery's rail`);
      }
      // the galleries are exactly as many as it takes
      assert.equal(hall.tiers, tiersFor(n, hall.ground, hall.perTier), `${n}: galleries`);
      assert.ok(hall.used <= hall.tiers);
    }
  });
}

test('the same room fills the same way, every time', () => {
  for (const n of [50, 800, 3000]) {
    const a = fill(ROOMS.eight, n, 3).places, b = fill(ROOMS.eight, n, 3).places;
    assert.deepEqual(a, b);
  }
});

test('people arriving never move the people already there', () => {
  for (const n of [0, 30, 200, 900]) {
    // the whole crowd known up front (what scrubbing a timeline shows): the first n are placed alike either way
    const all = fill(ROOMS.eight, n + 400, 5).places;
    const some = fill(ROOMS.eight, n, 5, n + 400).places;
    assert.deepEqual(all.slice(0, n), some);
    // and live arrivals past what the room was laid for: a gallery grows, and nobody already placed moves
    const live = fill(ROOMS.eight, n + 400, 5, n).places;
    assert.deepEqual(live.slice(0, n), fill(ROOMS.eight, n, 5, n).places);
    assert.equal(live.filter((p) => !p).length, 0);
  }
});

test('a small room stays the room it always was: no galleries until the standing room is full', () => {
  const { hall } = fill(ROOMS.eight, 30);
  assert.equal(hall.tiers, 0);
  assert.ok(hall.ground >= 30, `standing room for ${hall.ground}`);
});

test('a crowd stands near its own conversation: the first of a table\'s audience are closer to it than the last', () => {
  const room = ROOMS.one, hall = new Hall(R, room, KEEP, 400);
  const ps = Array.from({ length: 400 }, () => hall.add(0)!);
  const near = ps.slice(0, 40).filter((p) => p.level === 0), late = ps.slice(-40);
  const d = (p: Place) => Math.hypot(p.x - room[0].x, p.z - room[0].z) + p.level * 10;
  assert.ok(near.length > 0);
  assert.ok(near.reduce((a, p) => a + d(p), 0) / near.length < late.reduce((a, p) => a + d(p), 0) / late.length);
});

test('a gallery face looks into the hall; a ground face looks at its own table', () => {
  const room = ROOMS.one, hall = new Hall(R, room, KEEP, 600);
  for (let i = 0; i < 600; i++) {
    const p = hall.add(0)!;
    const to = p.level ? { x: 0, z: 0 } : room[0];
    const want = Math.atan2(to.x - p.x, to.z - p.z);
    assert.ok(Math.abs(Math.atan2(Math.sin(p.facing - want), Math.cos(p.facing - want))) < 1e-9);
  }
});

test('the front of a table has places for whoever speaks, clear of the glass and of other tables', () => {
  for (const t of ROOMS.eight) {
    const f = frontPlaces(R, t, ROOMS.eight, KEEP);
    assert.ok(f.length >= 3, `a table at (${t.x}, ${t.z}) has ${f.length} front places`);
    for (const p of f) {
      assert.ok(Math.hypot(p.x, p.z) <= R - 0.65);
      for (const o of ROOMS.eight) if (o !== t) assert.ok(Math.hypot(p.x - o.x, p.z - o.z) >= o.r + 0.55);
    }
  }
});

test('3,000 people are placed in well under a frame budget\'s worth of a second', () => {
  const t0 = performance.now();
  fill(ROOMS.eight, 3000);
  const ms = performance.now() - t0;
  assert.ok(ms < 400, `${ms.toFixed(0)} ms`);   // (CI and a starved VPS: generous; ~15 ms on a laptop)
});
