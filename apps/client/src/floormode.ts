// FLOOR_TIMELINE's host in the room: the floor's clock (floortime.ts), its building (building.ts, drawn by
// hallview.ts and the building's audience), and the one moment t they all show. show(t) is the only way the room's
// moment changes, and what it leaves behind depends on t alone: who is in the room is re-derived from t for exactly the
// people whose state can differ from the last moment shown (those with an arrival or a departure in between; for a
// long jump, everyone), so a drag costs what changed, and no path through the line can leave anyone where they
// wouldn't be had we gone straight there. Everything that moves in the scene's own time (fades, a lamp warming) eases
// toward that state and settles on it.
import * as THREE from 'three/webgpu';
import { floorClock, tableAt, latest, uOf, RoomAt, type FloorClock, type TableNow } from './floortime.ts';
import { planFloor, type Plan } from './building.ts';
import type { HallView, TableLook } from './hallview.ts';
import type { Audience } from './audience.ts';
import type { Floor } from './sync.ts';
import type { TableSpot } from './interior.ts';

/** a crowd's ripple: someone this far from their table's middle comes in this much later (s per m), up to RIPPLE_MAX */
const RIPPLE = 0.045, RIPPLE_MAX = 0.35;

export interface FloorState {
  t: number;
  /** who is in the room (1) per person */
  here: Uint8Array;
  /** per table: opened, its comments so far, its latest comment */
  tables: { open: boolean; turns: number; last: number }[];
  /** the latest comment on the floor (-1: none yet) */
  said: number;
}

export class FloorMode {
  clock: FloorClock | null = null;
  plan: Plan | null = null;
  /** every table as a spot (world space), in the floor's table order */
  spots: TableSpot[] = [];
  /** the moment shown (seconds since the story went up) */
  t = 0;
  private room: RoomAt | null = null;
  private delays: Float32Array = new Float32Array(0);
  /** per table: what it is at t (targets), and what's drawn (eased toward them) */
  private now: TableNow[] = [];
  private looks: TableLook[] = [];
  private said = -1;
  /** the floor's story and when it went up (unix s): the clock's zero */
  storyTime = 0;
  yaw = 0;
  roomY = 0;
  /** people whose presence was flipped by the last show(), and how many it looked at (for checks) */
  flipped = 0;
  looked = 0;

  constructor(private hall: HallView, private audience: Audience) {}

  /**
   * A floor to show: its clock and its building (once per floor: never while scrubbing), turned to face the way we
   * came in. Null when the floor carries no times (an older server): the room then is the room it always was.
   */
  build(floor: Floor, yaw: number, roomY: number, nowUnix: number): TableSpot[] | null {
    const time = floor.story.time;
    const clock = floorClock(floor, time ? nowUnix - time : undefined);
    if (!clock) return null;
    this.clock = clock; this.storyTime = time ?? 0; this.yaw = yaw; this.roomY = roomY;
    const plan = this.plan = planFloor(clock);
    // room space → world: the room turned to face the way we came in (as the tower's own room is)
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const world = (x: number, z: number) => ({ x: x * c + z * s, z: -x * s + z * c });
    for (const t of plan.tables) { const w = world(t.x, t.z); t.x = w.x; t.z = w.z; for (const st of t.seats) { const q = world(st.x, st.z); st.x = q.x; st.z = q.z; st.facing += yaw; } }
    for (const p of plan.people) { const w = world(p.x, p.z); p.x = w.x; p.z = w.z; p.facing += yaw; }
    this.spots = plan.tables.map((t) => ({ index: t.index, table: floor.tables[t.index], pos: new THREE.Vector3(t.x, 0, t.z), radius: t.r, seats: [], bar: false }));
    this.room = new RoomAt(clock);
    this.delays = Float32Array.from(plan.people, (p) => {
      const t = plan.tables[p.home];
      return p.seated || !t ? 0 : Math.min(RIPPLE_MAX, Math.hypot(p.x - t.x, p.z - t.z) * RIPPLE - (t.r + 2) * RIPPLE);
    });
    this.now = clock.tables.map(() => ({ open: false, turns: 0, last: -1, glow: 0, talking: false }));
    this.looks = clock.tables.map(() => ({ lit: 0, glow: 0, focus: 0 }));
    this.hall.build(plan, roomY);
    return this.spots;
  }

  /**
   * Where you stand when you come in: just inside the tower's glass where you came through (dx, dz: that way, from the
   * middle), in an aisle (clear of every table's people), a little either side if that's taken.
   */
  landing(dx: number, dz: number): { x: number; z: number } {
    const plan = this.plan, base = Math.atan2(dx, dz);
    if (!plan) return { x: dx * 5.3, z: dz * 5.3 };
    const clear = (x: number, z: number) => plan.tables.reduce((m, t) => Math.min(m, Math.hypot(x - t.x, z - t.z) - t.foot), Infinity);
    let best = { x: Math.sin(base) * 5.3, z: Math.cos(base) * 5.3 }, room = -Infinity;
    for (let k = 0; k < 120; k++) {
      const a = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.05, r = 5.6 - (Math.floor(k / 40)) * 0.6;
      const x = Math.sin(a) * r, z = Math.cos(a) * r, c = clear(x, z);
      if (c >= 0.45) return { x, z };
      if (c > room) { room = c; best = { x, z }; }
    }
    return best;
  }

  /** where the line starts a visit: the floor's first comment (a moment before it, so its writer is seen walking in) */
  get start() { return this.clock?.comments.length ? Math.max(0, this.clock.comments[0].at - 0.5) : 0; }
  get end() { return this.clock?.end ?? 0; }

  /**
   * Show moment t. Everyone whose presence can differ from the moment shown last (an arrival or a departure between
   * the two) is re-derived from t itself; a long jump re-derives everyone. `now`: the scene clock (fades start then).
   */
  show(t: number, now: number) {
    const c = this.clock, room = this.room;
    if (!c || !room) return;
    this.t = t;
    let flips = 0;
    this.looked = room.move(t, (i, on) => { this.audience.presence(i, on, now, this.delays[i]); flips++; });
    this.flipped = flips;
    for (let k = 0; k < c.tables.length; k++) tableAt(c, k, t, this.now[k]);
    this.said = latest(c, t);
  }

  /** Per frame: the tables ease toward the moment's (a lamp warms with its first comment, brightens with each one,
   *  cools as the table goes quiet), the light follows the liveliest, the walls draw back if they're moving. */
  frame(now: number, dt: number) {
    const c = this.clock, plan = this.plan;
    if (!c || !plan) return;
    this.hall.update(now);
    const fast = 1 - Math.exp(-dt * 5), slow = 1 - Math.exp(-dt * 3);
    const focusTable = this.said >= 0 ? c.comments[this.said].table : -1;
    for (let k = 0; k < this.looks.length; k++) {
      const l = this.looks[k], n = this.now[k];
      l.lit += ((n.open ? 1 : 0) - l.lit) * fast;
      l.glow += (n.glow - l.glow) * slow;
      l.focus += ((k === focusTable ? 1 : 0) - l.focus) * fast;
      if (Math.abs(l.lit - (n.open ? 1 : 0)) < 0.002) l.lit = n.open ? 1 : 0;
    }
    this.hall.setTables(this.looks);
    // the room's three warm lights, over the three liveliest tables now (ties: the floor's order)
    let a = -1, b = -1, d = -1;
    for (let k = 0; k < this.now.length; k++) {
      const g = this.now[k].glow;
      if (!this.now[k].open) continue;
      if (a < 0 || g > this.now[a].glow) { d = b; b = a; a = k; } else if (b < 0 || g > this.now[b].glow) { d = b; b = k; } else if (d < 0 || g > this.now[d].glow) d = k;
    }
    this.hall.light(plan, [a, b, d].filter((k) => k >= 0), 1);
  }

  /** is person i in the room at the moment shown */
  here(i: number) { return !!this.room && this.room.here[i] === 1; }
  /** the floor at the moment shown, as the line's card and a screen reader say it */
  get latest() { return this.said; }
  table(k: number) { return this.now[k]; }
  /** how table k looks right now (eased toward the moment's) */
  look(k: number) { return this.looks[k]; }
  /** where moment t is on the line (0..1) */
  u(t = this.t) { return this.clock ? uOf(this.clock, t) : 0; }

  /** Everything the room shows at the moment, as numbers (for the path-independence checks: hash it). */
  state(): FloorState {
    return { t: this.t, here: this.room ? this.room.here.slice() : new Uint8Array(0), tables: this.now.map((x) => ({ open: x.open, turns: x.turns, last: x.last })), said: this.said };
  }

  leave() { this.clock = null; this.plan = null; this.room = null; this.spots = []; this.hall.hide(); }
}
