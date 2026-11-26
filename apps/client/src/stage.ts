// The stage (CROWD_V2): who is where in a room of any size. A table keeps its chairs and a few people standing at
// its front; everyone else on the floor is in the audience, at the place the hall gave them (hall.ts), drawn by
// audience.ts at no cost per frame. Whoever is about to speak steps out of the audience at the edge of the clear lane
// round their table (or, when nobody is looking, is simply there) and walks the last metre or two to a place at the
// front; whoever has been quiet longest goes back to their place when the front is needed. Nobody ever walks
// through the crowd: the lane is always clear, by construction, so nobody gets stuck.
import * as THREE from 'three/webgpu';
import type { Crowd, Pose } from './people.ts';
import type { Audience } from './audience.ts';
import type { Interior, TableSpot } from './interior.ts';
import type { Room } from './room.ts';
import type { Floor } from './sync.ts';
import { Hall, HALL, frontPlaces, type Keep, type HallTable } from './hall.ts';
import { R } from './world.ts';

/** people standing at a table's front when the room is laid (the rest of its crowd is in the audience) */
const FRONT_START = 4;
/** at most this many stand at a front (besides the chairs): the speaker, the one they answer, the next two, a couple
 *  who just spoke. More, and the front is a crowd again, which is the thing this replaces */
const FRONT_MAX = 6;
/** someone at a front who hasn't spoken for this long (s) goes back to their place, when the front has others */
const QUIET = 40;
/** a front's second ring (inside the lane) is only for a moment when everyone at the first has the floor */
interface Front { x: number; z: number; facing: number; who: number; ring: number }

export class Stage {
  hall: Hall | null = null;
  /** audience index of each name on the floor (the order they joined: earliest comment first) */
  ix = new Map<string, number>();
  private homes: number[] = [];
  private spots: TableSpot[] = [];
  private fronts = new Map<TableSpot, Front[]>();
  private tables: HallTable[] = [];
  /** people walking home (crowd index -> audience index) */
  private homing = new Map<number, number>();
  /** is a point (world) in view now? (main.ts: the camera's frustum) */
  seen: (p: THREE.Vector3) => boolean = () => true;
  /** everyone on the floor (the honest count) */
  people = 0;

  constructor(private crowd: Crowd, private audience: Audience, private interior: Interior, private room: Room) {}

  /**
   * Lay the floor's people out: the room (interior.layout) has placed its tables, chairs, front standers and the bar;
   * here the front keeps its first few standers (who the crowd draws: returned), and then (fill) everyone else, every
   * commenter on the floor in the order they first commented, gets a place in the hall.
   */
  trim(spots: TableSpot[], people: { name: string; pose: Pose }[]) {
    this.spots = spots; this.fronts.clear(); this.homing.clear();
    const convo = spots.filter((s) => !s.bar);
    this.tables = convo.map((s) => ({ x: s.pos.x, z: s.pos.z, r: s.radius }));
    // the front keeps its first few standing; the rest of each table's standers go to the audience
    const atTable = this.atTable = new Set<string>();
    for (const sp of convo) {
      let standing = 0;
      sp.seats = sp.seats.filter((st) => st.seated || standing++ < FRONT_START);
      for (const st of sp.seats) atTable.add(st.name);
    }
    for (const sp of spots) if (sp.bar) for (const st of sp.seats) atTable.add(st.name);
    return people.filter((p) => atTable.has(p.name));
  }
  private atTable = new Set<string>();

  /** After the crowd is set (and the spot where you land is known, in `keep`): everyone else gets a place in the hall,
   *  and each table's front its places. */
  fill(floor: Floor, keep: Keep[], roomY: number) {
    const convo = this.spots.filter((s) => !s.bar), atTable = this.atTable;
    // everyone on the floor, by their earliest comment (HN ids rise with time): the first to come stand nearest
    const first = new Map<string, { id: number; table: number }>();
    floor.tables.forEach((t) => {
      const k = convo.findIndex((s) => s.table.root === t.root);
      for (const u of t.turns) { const f = first.get(u.by); if (!f || u.id < f.id) first.set(u.by, { id: u.id, table: k }); }
    });
    const order = [...first.entries()].sort((a, b) => a[1].id - b[1].id || (a[0] < b[0] ? -1 : 1));
    this.people = order.length;
    const names: string[] = [];
    this.homes = []; this.ix.clear();
    for (const [name, f] of order) { this.ix.set(name, names.length); names.push(name); this.homes.push(f.table); }
    // (?hall=crowd: the standing-crowd direction, prototyped for comparison: rows fill the floor, no galleries)
    const proto = typeof location !== 'undefined' && new URLSearchParams(location.search).get('hall') === 'crowd';
    const hall = this.hall = new Hall(R, this.tables, keep, names.length - atTable.size, proto ? { rows: 14, tiers: false } : {});
    const places = names.map((n, i) => (atTable.has(n) ? null : hall.add(this.homes[i])));
    this.audience.set(names, places);
    for (let i = 0; i < names.length; i++) if (atTable.has(names[i])) this.audience.away(i, true, 0, false);
    this.audience.group.position.y = roomY;
    this.interior.galleries(hall.used);
    // the places at each table's front: a ring at its edge, and a second one inside the lane for a busy moment
    convo.forEach((sp, k) => {
      const t = this.tables[k], ring = frontPlaces(R, t, this.tables, keep), wide = frontPlaces(R, { ...t, r: t.r + 0.58 }, this.tables, keep);
      const fr: Front[] = [...ring.map((p) => ({ ...p, who: -1, ring: 0 })), ...wide.map((p) => ({ ...p, who: -1, ring: 1 }))];
      // whoever already stands there holds the nearest place
      for (const st of sp.seats) if (!st.seated) {
        const f = nearestFree(fr, st.pos.x, st.pos.z);
        if (f) f.who = this.crowd.index(st.name);
      }
      this.fronts.set(sp, fr);
    });
  }

  /**
   * Bring someone from the audience into the room's crowd, standing where they'll walk from: the edge of the lane round
   * `spot` nearest their place (or the front place itself, when neither end is in view). Null: not in the hall.
   */
  bring(name: string, spot: TableSpot, now: number): { i: number; from: THREE.Vector3 } | null {
    const a = this.ix.get(name);
    if (a === undefined || !this.hall) return null;
    const home = this.audience.places[a], t = spot.pos;
    const dx = home.x - t.x, dz = home.z - t.z, d = Math.hypot(dx, dz) || 1;
    const edge = spot.radius + HALL.FRONT + HALL.LANE - 0.15;
    const from = new THREE.Vector3(t.x + (dx / d) * edge, 0, t.z + (dz / d) * edge);
    const r = Math.hypot(from.x, from.z);
    if (r > R - 0.7) from.multiplyScalar((R - 0.7) / r);
    const y = this.crowd.group.position.y;
    const homeW = new THREE.Vector3(home.x, y + home.y + 1.5, home.z);
    const quiet = !this.seen(homeW) && !this.seen(new THREE.Vector3(from.x, y + 1.4, from.z));
    const i = this.crowd.show(name, { pos: from, facing: Math.atan2(t.x - from.x, t.z - from.z), seated: false });
    if (i < 0) return null;
    this.audience.away(a, true, this.clock(), !quiet);
    void now;
    this.homing.delete(i);
    return { i, from };
  }

  /** A place at the front of `spot` for crowd person i, nearest `from`: a free one, or one made free (whoever there has
   *  been quiet longest goes back to their place). Null: the front is full of people who all have the floor. */
  place(spot: TableSpot, from: THREE.Vector3, i: number, now: number): THREE.Vector3 | null {
    const fr = this.fronts.get(spot);
    if (!fr) return null;
    for (const f of fr) if (f.who === i) f.who = -1;
    // a full front (or a crowded one) makes room: whoever there has been quiet longest goes back to their place
    const standing = fr.reduce((n, g) => n + (g.who >= 0 ? 1 : 0), 0);
    let f = standing < FRONT_MAX ? nearestFree(fr, from.x, from.z, 0) : null;
    if (!f) {
      const worst = this.quietest(fr, now);
      if (worst) { this.sendHome(worst.who, now); f = worst; }
    }
    f ??= nearestFree(fr, from.x, from.z, 0) ?? nearestFree(fr, from.x, from.z, 1);
    if (!f) return null;
    f.who = i;
    return new THREE.Vector3(f.x, 0, f.z);
  }

  /** whoever at this front has been quiet longest (and has nowhere to be) */
  private quietest(fr: Front[], now: number) {
    let worst: Front | null = null, quiet = Infinity;
    for (const g of fr) {
      if (g.who < 0) continue;
      const until = this.room.quietSince(g.who);
      if (until !== null && until < now && until < quiet) { quiet = until; worst = g; }
    }
    return worst;
  }

  /** Every few seconds: anyone at a front who said their piece a while ago (and isn't due again) goes back to their
   *  place, one at a time, so a front stays the few people the conversation is about right now. */
  private tidyAt = 0;
  tidy(now: number) {
    if (now < this.tidyAt) return;
    this.tidyAt = now + 3;
    for (const fr of this.fronts.values()) {
      let standing = 0;
      for (const g of fr) if (g.who >= 0) standing++;
      if (standing <= 2) continue;
      const w = this.quietest(fr, now);
      if (w && now - (this.room.quietSince(w.who) ?? now) > QUIET) this.sendHome(w.who, now);
    }
  }

  /** Person i (crowd) leaves wherever they stand at a front (they're going somewhere else). */
  free(i: number) { for (const fr of this.fronts.values()) for (const f of fr) if (f.who === i) f.who = -1; }

  /** Crowd person i walks back toward their place in the audience, and takes it again (they fade back in there). */
  sendHome(i: number, now: number) {
    const p = this.crowd.people[i], a = p ? this.ix.get(p.name) : undefined;
    if (!p || a === undefined) return;
    this.room.leave(i);
    this.free(i);
    const home = this.audience.places[a], pos = p.pose.pos;
    const sp = this.spots.find((s) => !s.bar && Math.hypot(s.pos.x - pos.x, s.pos.z - pos.z) < s.radius + HALL.FRONT + HALL.LANE);
    const t = sp?.pos ?? pos, dx = home.x - t.x, dz = home.z - t.z, d = Math.hypot(dx, dz) || 1;
    const edge = (sp?.radius ?? 0) + HALL.FRONT + HALL.LANE - 0.15;
    const to = new THREE.Vector3(t.x + (dx / d) * edge, 0, t.z + (dz / d) * edge);
    this.homing.set(i, a);
    this.crowd.walkTo(i, [to], Math.atan2(dx, dz), () => {
      if (this.homing.get(i) !== a) return;
      this.homing.delete(i);
      this.crowd.hide(i);
      this.audience.away(a, false, this.clock());
    }, 1.1);
    void now;
  }
  clock: () => number = () => 0;

  /** where crowd person i's audience place is (world), for a glance home */
  placeOf(name: string) { const a = this.ix.get(name); return a === undefined ? null : this.audience.places[a]; }
}

function nearestFree(fr: Front[], x: number, z: number, ring = 0) {
  let best: Front | null = null, bd = Infinity;
  for (const f of fr) { if (f.who !== -1 || f.ring !== ring) continue; const d = Math.hypot(f.x - x, f.z - z); if (d < bd) { bd = d; best = f; } }
  return best;
}
