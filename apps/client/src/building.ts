// The building (FLOOR_TIMELINE): one hall that holds a floor's whole conversation, every table and every person on it,
// at places that never move however the floor is scrubbed. A table seats the first few who spoke there (whose first
// comment on the floor was there); everyone else who started at that table stands round it, ring behind ring, beyond a
// clear lane (where whoever has the floor stands, and the camera works). Tables go down in the order they opened,
// each at the free spot nearest the middle: the first conversation in the centre, the later ones further out, so a
// floor lights up from the middle outward as its thread ages. The hall is as big as that takes: a floor of five
// people is the tower's own room; the 1Password thread's 58 tables and 356 people need a hall several times as wide.
//
// The plan is a pure function of the floor's structure (who spoke first where, in what order the tables opened):
// the same floor always gets the same building, and nothing in it depends on the moment being shown. People and tables
// that arrive while you're there are added (add*) without moving anyone already placed. Pure numbers, no three.js.

/** room space: metres, y up, the floor at 0, the middle of the hall at x = z = 0 */
export const PLAN = {
  /** the tower's own room: no hall is smaller */
  MIN_R: 7,
  /** chairs: as many as there are people who start at the table (at least one), up to EIGHT */
  SEATS: 8,
  /** a table's top: radius for its chairs */
  TOP: (seats: number) => 0.42 + Math.min(8, Math.max(1, seats)) * 0.055,
  /** chairs at the table's edge + CHAIR; whoever has the floor stands at the edge + FRONT; then a clear LANE */
  CHAIR: 0.3,
  FRONT: 0.95,
  LANE: 0.8,
  /** the standing rings round a table: the first just past the lane, then a row apart, people a SPACING apart */
  RING0: 0.3,
  ROW: 0.58,
  SPACING: 0.6,
  /** between two tables' outermost people: room to walk */
  AISLE: 1.0,
  /** from the outermost table to the glass */
  GLASS: 1.6,
  /** candidates for a table's spot: rings this far apart, points this far apart on each */
  STEP: 0.3,
} as const;

export interface PlanIn {
  /** each table: when it opened (any number that orders them; Infinity: never), and its people in the order they first
   *  spoke there (indices into `people`) */
  tables: readonly { open: number; people: ArrayLike<number> }[];
  /** each person, and the table they first spoke at (an index into `tables`) */
  people: readonly { name: string; home: number }[];
}

export interface Spot { x: number; z: number; facing: number }
export interface PlanTable {
  index: number;
  x: number; z: number;
  /** the top's radius */
  r: number;
  /** the radius everything of this table's stays inside (its people, its lane) */
  foot: number;
  /** its chairs, and who sits in each (an index into people; every chair has someone: a table has as many chairs as
   *  people who start there, up to eight) */
  seats: (Spot & { who: number })[];
  /** standing rings used */
  rings: number;
}
export interface PlanPerson {
  name: string;
  home: number;
  /** where they are when they're in the room: a chair at their table, or a place in a ring round it */
  x: number; z: number; facing: number;
  seated: boolean;
}
export interface Plan {
  /** the glass */
  R: number;
  tables: PlanTable[];
  people: PlanPerson[];
}

const TAU = Math.PI * 2;
/** an even spread of k things over n slots, whatever k: the golden ratio's sequence (each new one in the widest gap) */
function spread(n: number): Int32Array {
  const out = new Int32Array(n), used = new Uint8Array(n);
  let m = 0;
  for (let j = 0; m < n; j++) {
    let s = Math.floor(((j * 0.6180339887498949) % 1) * n);
    while (used[s]) s = (s + 1) % n;
    used[s] = 1; out[m++] = s;
  }
  return out;
}

/** ring j round a table of top radius r: its radius and how many people it holds */
const ringR = (r: number, j: number) => r + PLAN.FRONT + PLAN.LANE + PLAN.RING0 + j * PLAN.ROW;
const ringN = (r: number, j: number) => Math.floor((TAU * ringR(r, j)) / PLAN.SPACING);

/** how many standing rings `standing` people need round a table of top radius r */
function ringsFor(r: number, standing: number) {
  let j = 0, room = 0;
  while (room < standing) room += ringN(r, j++);
  return j;
}

/** the radius a table's things stay inside: its outermost ring and a person's half-width, or (nobody standing round
 *  it) whoever stands at its front */
const footOf = (r: number, rings: number) => (rings ? ringR(r, rings - 1) + 0.3 : r + PLAN.FRONT + 0.35);

/**
 * Where the tables go: each at the free candidate nearest the middle (in the order given), never closer to another
 * than both their feet and an aisle. Candidates are rings STEP apart, points STEP apart on each, each ring's first
 * point turned a little (so tables don't line up along one ray). A candidate too close to a placed table for even the
 * smallest table still to come is dead for good (tables are only ever added), so each search skips what earlier ones
 * ruled out: placing all 58 tables of a floor looks at each candidate about once.
 */
class Packer {
  private discs: { x: number; z: number; f: number }[] = [];
  private cells = new Map<number, number[]>();
  private maxF = 0;
  private static C = 4;
  /** candidates: (x, z) pairs, ring by ring; where each ring starts; how many of each ring are still alive */
  private xz: number[] = [];
  private start: number[] = [];
  private alive: number[] = [];
  private dead: Uint8Array = new Uint8Array(0);
  /** the first ring with anyone alive */
  private from = 0;
  private fmin: number;
  constructor(fmin: number) { this.fmin = fmin; }
  private key(i: number, j: number) { return (i + 4096) * 8192 + (j + 4096); }
  /** the nearest placed table's clearance at (x, z) for a disc of radius f: < 0 means it doesn't fit */
  private clear(x: number, z: number, f: number) {
    const C = Packer.C, reach = f + this.maxF + PLAN.AISLE;
    const i0 = Math.floor((x - reach) / C), i1 = Math.floor((x + reach) / C), j0 = Math.floor((z - reach) / C), j1 = Math.floor((z + reach) / C);
    let worst = Infinity;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const list = this.cells.get(this.key(i, j));
      if (list) for (const d of list) { const o = this.discs[d]; worst = Math.min(worst, Math.hypot(o.x - x, o.z - z) - o.f - PLAN.AISLE); }
    }
    return worst - f;
  }
  add(x: number, z: number, f: number) {
    const d = this.discs.length;
    this.discs.push({ x, z, f });
    const C = Packer.C, k = this.key(Math.floor(x / C), Math.floor(z / C));
    (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(d);
    this.maxF = Math.max(this.maxF, f);
  }
  private ring(q: number) {
    while (this.start.length <= q) {
      const ring = this.start.length, r = ring * PLAN.STEP, n = ring ? Math.max(6, Math.floor((TAU * r) / PLAN.STEP)) : 1, a0 = ring * 0.37;
      this.start.push(this.xz.length / 2);
      for (let k = 0; k < n; k++) { const a = a0 + (k / n) * TAU; this.xz.push(Math.cos(a) * r, Math.sin(a) * r); }
      this.alive.push(n);
      if (this.dead.length < this.xz.length / 2) { const d = new Uint8Array(Math.max(1024, this.xz.length)); d.set(this.dead); this.dead = d; }
    }
  }
  /** the free spot nearest the middle for a disc of radius f */
  place(f: number): { x: number; z: number } {
    for (let q = this.from; ; q++) {
      this.ring(q + 1);
      if (!this.alive[q]) { if (q === this.from) this.from++; continue; }
      for (let c = this.start[q], e = this.start[q + 1]; c < e; c++) {
        if (this.dead[c]) continue;
        const x = this.xz[2 * c], z = this.xz[2 * c + 1], room = this.clear(x, z, f);
        if (room >= 0) return { x, z };
        if (room + f - this.fmin < 0) { this.dead[c] = 1; this.alive[q]--; }    // not even the smallest table fits here
      }
    }
  }
}

/** The building for a floor: every table and every person placed, and the hall round them. */
export function planFloor(f: PlanIn): Plan {
  const plan: Plan = { R: PLAN.MIN_R, tables: [], people: f.people.map((p) => ({ name: p.name, home: p.home, x: 0, z: 0, facing: 0, seated: false })) };
  // the tables in the order they opened (ties: the floor's own order)
  const order = f.tables.map((t, k) => k).sort((a, b) => (f.tables[a].open - f.tables[b].open) || a - b);
  // each table's own people: those whose first comment on the floor was there, in the order they first spoke there
  const own: number[][] = f.tables.map(() => []);
  f.tables.forEach((t, k) => { for (let m = 0; m < t.people.length; m++) { const p = t.people[m]; if (f.people[p]?.home === k) own[k].push(p); } });
  // (someone whose home table doesn't list them: theirs anyway, at the end)
  f.people.forEach((p, i) => { if (p.home >= 0 && p.home < own.length && !own[p.home].includes(i)) own[p.home].push(i); });
  const tables: PlanTable[] = new Array(f.tables.length);
  const shape = own.map((people) => {
    const seats = Math.min(PLAN.SEATS, Math.max(1, people.length)), r = PLAN.TOP(seats), rings = ringsFor(r, Math.max(0, people.length - seats));
    return { r, rings, foot: footOf(r, rings) };
  });
  const packer = new Packer(shape.reduce((m, s) => Math.min(m, s.foot), Infinity));
  for (const k of order) {
    const { r, rings, foot } = shape[k], at = packer.place(foot);
    packer.add(at.x, at.z, foot);
    tables[k] = { index: k, x: at.x, z: at.z, r, foot, seats: [], rings };
  }
  plan.tables = tables;
  for (let k = 0; k < tables.length; k++) seatTable(plan, tables[k], own[k]);
  plan.R = hallR(plan);
  return plan;
}

/** chairs round the table for its first few, rings for the rest */
function seatTable(plan: Plan, t: PlanTable, people: number[]) {
  const seats = Math.min(PLAN.SEATS, Math.max(1, people.length));
  const turn = (t.index * 0.7) % TAU;
  for (let j = 0; j < seats; j++) {
    const a = turn + (j / seats) * TAU, x = t.x + Math.cos(a) * (t.r + PLAN.CHAIR), z = t.z + Math.sin(a) * (t.r + PLAN.CHAIR);
    const who = people[j] ?? -1;
    t.seats.push({ x, z, facing: Math.atan2(t.x - x, t.z - z), who });
    if (who >= 0) Object.assign(plan.people[who], { x, z, facing: Math.atan2(t.x - x, t.z - z), seated: true });
  }
  let m = seats;
  for (let j = 0; m < people.length; j++) {
    const n = ringN(t.r, j), rr = ringR(t.r, j), order = spread(n), a0 = turn + (j % 2) * (Math.PI / n);
    for (let s = 0; s < n && m < people.length; s++, m++) {
      const a = a0 + (order[s] / n) * TAU, x = t.x + Math.cos(a) * rr, z = t.z + Math.sin(a) * rr;
      Object.assign(plan.people[people[m]], { x, z, facing: Math.atan2(t.x - x, t.z - z), seated: false });
    }
    t.rings = Math.max(t.rings, j + 1);
  }
}

/** the glass: past the outermost table's people and an aisle; never smaller than the tower's room */
function hallR(plan: Plan) {
  let R: number = PLAN.MIN_R;
  for (const t of plan.tables) if (t) R = Math.max(R, Math.hypot(t.x, t.z) + t.foot + PLAN.GLASS);
  return R;
}

/** the places at a table's front where whoever has the floor stands: a ring at its edge + FRONT */
export function frontOf(t: PlanTable): Spot[] {
  const r = t.r + PLAN.FRONT, n = Math.max(6, Math.floor((TAU * r) / 0.7)), out: Spot[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU + 0.2, x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
    out.push({ x, z, facing: Math.atan2(t.x - x, t.z - z) });
  }
  return out;
}

/** What could break, measured: the closest two people (and who), anyone inside another table's lane, anyone
 *  outside the glass. For tests and for ?plan checks in the browser. */
export function audit(plan: Plan) {
  let closest = Infinity, pair: [number, number] = [-1, -1];
  const cell = new Map<number, number[]>(), key = (x: number, z: number) => (Math.floor(x) + 4096) * 8192 + (Math.floor(z) + 4096);
  plan.people.forEach((p, i) => { const k = key(p.x, p.z); (cell.get(k) ?? cell.set(k, []).get(k)!).push(i); });
  plan.people.forEach((p, i) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of cell.get(key(p.x + a, p.z + b)) ?? []) {
      if (j <= i) continue;
      const d = Math.hypot(p.x - plan.people[j].x, p.z - plan.people[j].z);
      if (d < closest) { closest = d; pair = [i, j]; }
    }
  });
  let inLane = 0, outside = 0;
  for (const p of plan.people) {
    if (Math.hypot(p.x, p.z) > plan.R - 0.5) outside++;
    for (const t of plan.tables) {
      if (!t) continue;
      const d = Math.hypot(p.x - t.x, p.z - t.z);
      // a person's own chair is at the table's edge; anyone else this close is in the way of whoever speaks there
      if (d < t.r + PLAN.FRONT + PLAN.LANE && !(p.seated && p.home === t.index)) inLane++;
    }
  }
  let tableOverlap = 0;
  for (let a = 0; a < plan.tables.length; a++) for (let b = a + 1; b < plan.tables.length; b++) {
    const A = plan.tables[a], B = plan.tables[b];
    if (Math.hypot(A.x - B.x, A.z - B.z) < A.foot + B.foot + PLAN.AISLE - 1e-6) tableOverlap++;
  }
  return { closest, pair, inLane, outside, tableOverlap };
}
