// The hall: a place for everyone in a room, however many came. Each conversation keeps its table, its chairs and a
// ring at the front where whoever has the floor stands (the fishbowl); everyone else is the audience: standing room
// along the glass first, then galleries above the room, as many as it takes, raked so each row sees over the one in
// front. Places are a lattice fixed by the room alone (never by who came), handed out in the order people joined,
// each to the free place nearest their own conversation: adding someone never moves anyone, nobody overlaps anybody
// (the lattice is spaced wider than any shoulders or hair), and there is always a place, because a full lattice grows
// another gallery. Pure numbers: no three.js, so it is tested and timed without a browser.

/** room space: metres, y up, the floor at 0 */
export interface HallTable { x: number; z: number; r: number }
export interface Keep { x: number; z: number; r: number }
export interface Place { x: number; z: number; y: number; level: number; facing: number }

/** the shape of the hall: the same constants draw it (interior.ts) and fill it */
export const HALL = {
  /** between neighbours on a row, and between rows: wider than the widest shoulders (0.48 m) or hair (0.49 m) */
  SPACING: 0.6,
  ROW: 0.58,
  /** a table's chairs are at its edge + 0.3; whoever stands to speak, at its edge + FRONT; then a clear lane all round
   *  (walking, and the camera behind someone's shoulder) before the audience begins */
  FRONT: 0.95,
  LANE: 1.0,
  /** standing room along the glass: rows from this far in from the room's edge */
  GLASS: 0.62,
  BAND_ROWS: 3,
  /** galleries: the rail (the front of each one) and its rows behind, each a step higher than the one in front */
  RAIL: 4.15,
  TIER_ROWS: 4,
  RAKE: 0.2,
  /** the first gallery's floor, and from one gallery's floor to the next */
  TIER_Y: 2.75,
  TIER_H: 2.6,
  /** a gallery place costs as much as walking this much further on the ground, a gallery higher up this much more */
  UP: 3.5,
  /** a ceiling on galleries (9,000 people): past it nobody new gets a place, and the count still says so */
  MAX_TIERS: 40,
} as const;

/** the floor height of gallery t (1-based), room space */
export const tierFloor = (t: number) => HALL.TIER_Y + (t - 1) * HALL.TIER_H;

interface Cell { x: number; z: number; y: number; level: number; a: number; r: number }

/** A row of places round the room's centre at radius r, from angle a0: as many as fit at SPACING (those `ok` keeps). */
function row(out: Cell[], r: number, y: number, level: number, a0: number, ok: (x: number, z: number) => boolean) {
  const n = Math.floor((2 * Math.PI * r) / HALL.SPACING);
  for (let k = 0; k < n; k++) {
    const a = a0 + (k / n) * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (ok(x, z)) out.push({ x, z, y, level, a: Math.atan2(z, x), r });
  }
}

/** The ground's standing room: rows along the glass, clear of every table's fishbowl and of whatever must stay free. */
function groundCells(R: number, tables: HallTable[], keep: Keep[]): Cell[] {
  const out: Cell[] = [];
  const ok = (x: number, z: number) => tables.every((t) => Math.hypot(x - t.x, z - t.z) > t.r + HALL.FRONT + HALL.LANE + HALL.SPACING / 2)
    && keep.every((k) => Math.hypot(x - k.x, z - k.z) > k.r);
  for (let k = 0; k < HALL.BAND_ROWS; k++) {
    const r = R - HALL.GLASS - k * HALL.ROW;
    row(out, r, 0, 0, (k % 2) * 0.5 * (HALL.SPACING / r), ok);
  }
  return out;
}

/** Gallery t's places (t >= 1): rows from the rail back toward the glass, each RAKE higher than the one in front. */
function tierCells(R: number, t: number): Cell[] {
  const out: Cell[] = [];
  for (let k = 0; k < HALL.TIER_ROWS; k++) {
    const r = HALL.RAIL + 0.3 + k * HALL.SPACING;
    if (r > R - 0.5) break;
    // each gallery turned a little from the one below, so faces up the hall don't line up in columns
    row(out, r, tierFloor(t) + k * HALL.RAKE, t, ((k + t) % 2) * 0.5 * (HALL.SPACING / r) + t * 0.13, () => true);
  }
  return out;
}

/** How many galleries `people` need over a ground that holds `ground` (and a gallery `perTier`). */
export function tiersFor(people: number, ground: number, perTier: number) {
  return Math.min(HALL.MAX_TIERS, Math.max(0, Math.ceil((people - ground) / Math.max(1, perTier))));
}

/**
 * Places, handed out one person at a time (`add`), in the order people joined. The lattice is laid for `expected`
 * people (the room's whole crowd, known when we walk in): galleries enough for all of them. More than that (people
 * arriving live) adds a gallery when it's full; nobody already placed ever moves.
 */
export class Hall {
  readonly R: number;
  readonly tables: HallTable[];
  /** places on the ground, and in one gallery */
  readonly ground: number;
  readonly perTier: number;
  /** galleries laid so far (0: the room as it always was) */
  tiers = 0;
  private cells: Cell[];
  private taken: Uint8Array;
  private order = new Map<number, Int32Array>();
  private next = new Map<number, number>();
  /** galleries in use: the highest level anyone stands on */
  used = 0;

  constructor(R: number, tables: HallTable[], keep: Keep[], expected: number) {
    this.R = R; this.tables = tables;
    this.cells = groundCells(R, tables, keep);
    this.ground = this.cells.length;
    this.perTier = tierCells(R, 1).length;
    this.taken = new Uint8Array(0);
    this.grow(tiersFor(expected, this.ground, this.perTier));
  }

  private grow(tiers: number) {
    for (let t = this.tiers + 1; t <= Math.min(tiers, HALL.MAX_TIERS); t++) this.cells.push(...tierCells(this.R, t));
    this.tiers = Math.max(this.tiers, Math.min(tiers, HALL.MAX_TIERS));
    const taken = new Uint8Array(this.cells.length);
    taken.set(this.taken);
    this.taken = taken;
    this.order.clear(); this.next.clear();             // every table's order includes the new places from now on
  }

  /** the order table h's people take the places in: nearest first on the ground; in the galleries, the nearest round
   *  the hall (by angle) on the lowest gallery that has room, each gallery up costing a walk of UP */
  private orderFor(h: number) {
    let o = this.order.get(h);
    if (o) return o;
    const t = this.tables[h], cells = this.cells;
    const tx = t ? t.x : 0, tz = t ? t.z : 0, ta = t && Math.hypot(t.x, t.z) > 0.3 ? Math.atan2(t.z, t.x) : 0;
    const cost = new Float64Array(cells.length);
    for (let c = 0; c < cells.length; c++) {
      const e = cells[c];
      if (e.level === 0) cost[c] = Math.hypot(e.x - tx, e.z - tz);
      else {
        const da = Math.abs(Math.atan2(Math.sin(e.a - ta), Math.cos(e.a - ta)));
        cost[c] = HALL.UP * e.level + da * e.r * 0.5 + (e.r - HALL.RAIL) * 0.4;   // the rail first: they lean over it
      }
    }
    o = Int32Array.from(cells.keys()).sort((a, b) => cost[a] - cost[b] || a - b);
    this.order.set(h, o);
    return o;
  }

  /** The next person's place: `home` is their table (an index into `tables`; -1: no table here). Null only past
   *  MAX_TIERS galleries. */
  add(home: number): Place | null {
    const h = home >= 0 && home < this.tables.length ? home : -1;
    let o = this.orderFor(h), k = this.next.get(h) ?? 0;
    while (k < o.length && this.taken[o[k]]) k++;
    if (k >= o.length) {
      if (this.tiers >= HALL.MAX_TIERS) return null;
      this.grow(this.tiers + 1);
      o = this.orderFor(h); k = 0;
      while (k < o.length && this.taken[o[k]]) k++;
      if (k >= o.length) return null;
    }
    this.next.set(h, k + 1);
    const c = this.cells[o[k]];
    this.taken[o[k]] = 1;
    if (c.level > this.used) this.used = c.level;
    const t = this.tables[h];
    // on the ground they face their own conversation; up in a gallery, the middle of the hall
    const facing = c.level === 0 && t ? Math.atan2(t.x - c.x, t.z - c.z) : Math.atan2(-c.x, -c.z);
    return { x: c.x, z: c.z, y: c.y, level: c.level, facing };
  }
}

/** The places at the front of a table, where whoever has the floor stands: a ring at its edge + FRONT, as many as fit
 *  with room to spare (a speaker, the one they answer, whoever speaks next), inside the glass, clear of the others. */
export function frontPlaces(R: number, t: HallTable, others: HallTable[], keep: Keep[]): { x: number; z: number; facing: number }[] {
  const r = t.r + HALL.FRONT, n = Math.max(6, Math.floor((2 * Math.PI * r) / 0.7)), out: { x: number; z: number; facing: number }[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + 0.2, x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
    if (Math.hypot(x, z) > R - 0.65) continue;
    if (others.some((o) => o !== t && Math.hypot(x - o.x, z - o.z) < o.r + 0.55)) continue;
    if (keep.some((q) => Math.hypot(x - q.x, z - q.z) < q.r)) continue;
    out.push({ x, z, facing: Math.atan2(t.x - x, t.z - z) });
  }
  return out;
}
