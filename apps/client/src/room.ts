// The room's choreography: one person per commenter on a floor, and where each of them is. A commenter who joined
// several threads is one person who walks between those tables, going where they're due to speak next; someone
// who just commented on Hacker News arrives by the lift and joins their table. Tables ask for a speaker with
// callOver(); everything else (who walks where, around what, to which free place) happens here.
import * as THREE from 'three/webgpu';
import type { Crowd } from './people.ts';
import type { TableSpot } from './interior.ts';
import { R } from './world.ts';

const RING = 0.95;                                       // where people stand round a table, past its edge
const BODY = 0.24;                                       // half a person's width (shoulders or head, the wider)

/** here: go ahead. coming: on their way. busy: talking elsewhere, or heading to another table. absent: the room is
 *  full and they can't come in (speak from the table without a body) */
export type Presence = 'here' | 'coming' | 'busy' | 'absent';

export class Room {
  spots: TableSpot[] = [];
  /** where newcomers appear (the lift), in world space on this floor */
  door = new THREE.Vector3();
  private going = new Map<number, TableSpot>();          // person -> the table they're walking to
  private dest = new Map<number, THREE.Vector3>();       // person -> the place they'll stand (reserved)
  private busyUntil = new Map<number, number>();         // person -> audio time they're speaking until
  onArrive: (i: number, spot: TableSpot) => void = () => {};
  /** a new person is needed in the room (they came by lift): returns their index in the crowd */
  spawn: (name: string, at: THREE.Vector3, facing: number) => number = () => -1;

  constructor(private crowd: Crowd) {}

  reset(spots: TableSpot[], door: THREE.Vector3) {
    this.spots = spots; this.door.copy(door);
    this.going.clear(); this.dest.clear(); this.busyUntil.clear();
  }

  /** The table person i is at now (not on the way somewhere), or null. */
  tableOf(i: number): TableSpot | null {
    const p = this.crowd.people[i];
    if (!p || this.going.has(i)) return null;
    for (const s of this.spots) if (s.seats.some((st) => st.pos === p.pose.pos)) return s;
    return null;
  }

  /** person index for a name on this floor (one person per commenter) */
  who(name: string) { return this.crowd.index(name); }

  /** They're speaking (somewhere) until `until`: nobody calls them away mid-sentence. */
  speaking(i: number, until: number) { this.busyUntil.set(i, Math.max(this.busyUntil.get(i) ?? 0, until)); }

  /**
   * Make sure `name` is at `spot` to speak. 'here': go ahead. 'coming': they're on their way (from another table,
   * or out of the lift); ask again next frame. 'busy': they're talking somewhere else right now; try later.
   */
  callOver(name: string, spot: TableSpot, now: number): Presence {
    if (!name || !spot) return 'busy';
    let i = this.who(name);
    if (i >= 0 && this.going.get(i) === spot) return 'coming';
    if (i >= 0 && this.going.has(i)) return 'busy';         // on their way to another table: never yanked back and forth
    if (i >= 0 && this.tableOf(i) === spot) return 'here';
    if (i >= 0 && (this.busyUntil.get(i) ?? 0) > now) return 'busy';
    let from: THREE.Vector3;
    if (i < 0) {                                         // not in the room yet: out of the lift
      i = this.spawn(name, this.door.clone(), Math.atan2(-this.door.x, -this.door.z));
      if (i < 0) return 'absent';
      from = this.door.clone();
    } else {
      from = this.crowd.people[i].pose.pos.clone();
      this.leave(i);
    }
    const place = this.freePlace(spot, from);
    const path = this.route(from, place, spot);
    const face = Math.atan2(spot.pos.x - place.x, spot.pos.z - place.z);
    this.going.set(i, spot); this.dest.set(i, place);
    this.crowd.walkTo(i, path, face, () => {
      this.going.delete(i); this.dest.delete(i);
      const p = this.crowd.people[i];
      if (!p) return;
      // they join the table: their place is a seat in its list from now on (the director and the mixer read it)
      spot.seats.push({ name, pos: p.pose.pos, facing: p.pose.facing, seated: false });
      this.onArrive(i, spot);
    });
    return 'coming';
  }

  /** Person i leaves whatever table they're at (their place there is free again). */
  private leave(i: number) {
    const p = this.crowd.people[i];
    if (!p) return;
    for (const s of this.spots) {
      const k = s.seats.findIndex((st) => st.pos === p.pose.pos);
      if (k >= 0) s.seats.splice(k, 1);
    }
    // the walk mutates pose.pos: give them their own vector so no table's seat moves with them
    p.pose.pos = p.pose.pos.clone();
  }

  /** A free place to stand at a table, nearest the one coming: the first ring, then wider ones (behind those already
   *  standing, as a crowd does). Never on top of anyone: a full table gets its listener at the back. */
  private freePlace(spot: TableSpot, from: THREE.Vector3) {
    // a place is taken by anyone there, or reserved by someone on their way to it (two bodies and a little air)
    const taken = (q: THREE.Vector3) => this.crowd.people.some((p, j) => !this.going.has(j) && Math.hypot(p.pose.pos.x - q.x, p.pose.pos.z - q.z) < 2 * BODY + 0.08)
      || [...this.dest.values()].some((d) => Math.hypot(d.x - q.x, d.z - q.z) < 2 * BODY + 0.08);
    const ok = (q: THREE.Vector3) => Math.hypot(q.x, q.z) < R - 0.65
      && this.spots.every((s) => s === spot || s.bar || Math.hypot(q.x - s.pos.x, q.z - s.pos.z) > s.radius + 0.55);
    for (const ring of [RING, RING + 0.5, RING + 1.0, RING + 1.5]) {
      let best: THREE.Vector3 | null = null, bestD = Infinity;
      const r = spot.radius + ring, n = Math.max(16, Math.round((2 * Math.PI * r) / 0.3));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const q = new THREE.Vector3(spot.pos.x + Math.cos(a) * r, 0, spot.pos.z + Math.sin(a) * r);
        if (!ok(q) || taken(q)) continue;
        const d = Math.hypot(q.x - from.x, q.z - from.z);
        if (d < bestD) { bestD = d; best = q; }
      }
      if (best) return best;
    }
    // nowhere free near it (a packed floor): where they are, which nobody else occupies
    return from.clone();
  }

  /** How far a table's people reach from its centre (the chairs, anyone standing round it): a walker goes round
   *  all of them, not just the tabletop. */
  private reach(s: TableSpot) {
    let r = s.radius + 0.3 + BODY + 0.06;                   // the chairs, even empty ones
    // (no further than the outermost ring a place is ever given in: someone who stopped short of the table in a jam
    // is gone round on their own, not by every route swinging wide of the whole table)
    for (const st of s.seats) r = Math.max(r, Math.min(Math.hypot(st.pos.x - s.pos.x, st.pos.z - s.pos.z), s.radius + RING + 1.5) + BODY);
    return r;
  }

  /** A walking line from a to b that goes round the tables in between, and round the people at them: a detour beside
   *  each one it would cross. The table they're going to is passed close (they're joining it): just its chairs. */
  route(a: THREE.Vector3, b: THREE.Vector3, to?: TableSpot, depth = 0): THREE.Vector3[] {
    const tables = this.spots.filter((s) => !s.bar);
    // someone leaving a table (out of a chair, or from among those standing round it) for somewhere past it steps back
    // from it first, as people do: setting off along its edge traps them between the tabletop and the next chair
    if (depth === 0) for (const s of tables) {
      if (s === to) continue;
      const dx = a.x - s.pos.x, dz = a.z - s.pos.z, d = Math.hypot(dx, dz), out = this.reach(s) + 0.1;
      if (d >= out - 0.15 || d < 1e-3 || (b.x - a.x) * -dx + (b.z - a.z) * -dz <= 0) continue;   // clear of it, or heading away
      const o = new THREE.Vector3(s.pos.x + (dx / d) * out, 0, s.pos.z + (dz / d) * out);
      const or = Math.hypot(o.x, o.z);
      if (or > R - 0.6) o.multiplyScalar((R - 0.6) / or);   // inside the glass
      return [o, ...this.route(o, b, to, depth + 1)];
    }
    for (const s of tables) {
      const r = s === to ? s.radius + 0.3 + BODY + 0.06 : this.reach(s) + BODY;
      // closest point on segment ab to the table's centre
      const abx = b.x - a.x, abz = b.z - a.z, len2 = abx * abx + abz * abz || 1;
      const t = Math.max(0, Math.min(1, ((s.pos.x - a.x) * abx + (s.pos.z - a.z) * abz) / len2));
      const cx = a.x + abx * t, cz = a.z + abz * t, d = Math.hypot(cx - s.pos.x, cz - s.pos.z);
      if (d >= r || t <= 0.02 || t >= 0.98 || depth > 3) continue;
      // step round on the side the line already leans to
      let nx = cx - s.pos.x, nz = cz - s.pos.z;
      const n = Math.hypot(nx, nz);
      if (n < 1e-3) { nx = -abz; nz = abx; } else { nx /= n; nz /= n; }
      const nl = Math.hypot(nx, nz) || 1;
      const beside = (sg: number) => {
        const w = new THREE.Vector3(s.pos.x + sg * (nx / nl) * (r + 0.18), 0, s.pos.z + sg * (nz / nl) * (r + 0.18));
        const wr = Math.hypot(w.x, w.z);
        if (wr > R - 0.6) w.multiplyScalar((R - 0.6) / wr);   // inside the glass
        return w;
      };
      // a table by the glass leaves no room on that side (the glass pulls the detour back into its crowd): the other
      const clear = (w: THREE.Vector3) => Math.hypot(w.x - s.pos.x, w.z - s.pos.z);
      let w = beside(1);
      if (clear(w) < r) { const o = beside(-1); if (clear(o) > clear(w)) w = o; }
      return [...this.route(a, w, to, depth + 1), ...this.route(w, b, to, depth + 1)];
    }
    return [b.clone()];
  }
}
