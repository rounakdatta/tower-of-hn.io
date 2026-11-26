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
    // (their place is near the conversation they first joined among those in the room: the floor's lower threads
    // aren't laid out, and someone who commented there first is still nearest the one here they joined)
    const first = new Map<string, { id: number; table: number; at: number }>();
    floor.tables.forEach((t) => {
      const k = convo.findIndex((s) => s.table.root === t.root);
      for (const u of t.turns) {
        const f = first.get(u.by) ?? { id: Infinity, table: -1, at: Infinity };
        if (u.id < f.id) f.id = u.id;
        if (k >= 0 && u.id < f.at) { f.at = u.id; f.table = k; }
        first.set(u.by, f);
      }
    });
    const order = [...first.entries()].sort((a, b) => a[1].id - b[1].id || (a[0] < b[0] ? -1 : 1));
    this.people = order.length;
    const names: string[] = [];
    this.homes = []; this.ix.clear();
    for (const [name, f] of order) { this.ix.set(name, names.length); names.push(name); this.homes.push(f.table); }
    // (?hall=crowd: the standing-crowd direction, prototyped for comparison: rows fill the floor, no galleries)
    const proto = typeof location !== 'undefined' && new URLSearchParams(location.search).get('hall') === 'crowd';
    // (everyone has a place, those at a table now too: it's where they go when they step back)
    const hall = this.hall = new Hall(R, this.tables, keep, names.length, proto ? { rows: 14, tiers: false } : {});
    const places = names.map((_, i) => hall.add(this.homes[i]));
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
   * Where someone steps out of the audience (or back into it): for the standing room along the glass, just in front of
   * its rows, straight in from their place (they come out between the people in front of them); for a gallery, the edge
   * of the clear lane round the table, on their side (they came down).
   */
  private door(a: number, spot: TableSpot | undefined) {
    const home = this.audience.places[a];
    // never among a table's chairs or the people standing at its front (whichever table: they're packed close)
    const clear = (x: number, z: number) => this.tables.every((t) => Math.hypot(x - t.x, z - t.z) > t.r + HALL.FRONT + 0.4) && Math.hypot(x, z) < R - 0.65;
    if (home.level === 0 || !spot) {
      const r = Math.hypot(home.x, home.z) || 1, inner = R - HALL.GLASS - (HALL.BAND_ROWS - 1) * HALL.ROW - 0.5;
      // from just inside the standing rows, back toward their place until clear
      for (let k = Math.min(1, inner / r); k < 1; k += 0.1 / r) if (clear(home.x * k, home.z * k)) return new THREE.Vector3(home.x * k, 0, home.z * k);
      return new THREE.Vector3(home.x, 0, home.z);
    }
    // from a gallery: the edge of the lane round the table they're going to, on their side (or the nearest clear point
    // round it, turning either way)
    const t = spot.pos, base = Math.atan2(home.z - t.z, home.x - t.x), edge = spot.radius + HALL.FRONT + HALL.LANE - 0.15;
    for (let s = 0; s <= 12; s++) {
      const a = base + (s % 2 ? 1 : -1) * Math.ceil(s / 2) * 0.26, x = t.x + Math.cos(a) * edge, z = t.z + Math.sin(a) * edge;
      if (clear(x, z)) return new THREE.Vector3(x, 0, z);
    }
    const out = new THREE.Vector3(t.x + Math.cos(base) * edge, 0, t.z + Math.sin(base) * edge), r = Math.hypot(out.x, out.z);
    if (r > R - 0.7) out.multiplyScalar((R - 0.7) / r);
    return out;
  }

  /**
   * Bring someone from the audience into the room's crowd, standing where they'll walk from (door()), or, when neither
   * their place nor that door is in view, already at the front place they'll be given. Null: not in the hall.
   */
  bring(name: string, spot: TableSpot, now: number): { i: number; from: THREE.Vector3; quiet: boolean } | null {
    const a = this.ix.get(name);
    if (a === undefined || !this.hall) return null;
    const home = this.audience.places[a], t = spot.pos, y = this.crowd.group.position.y;
    const from = this.door(a, spot);
    const quiet = this.clock() < this.instantUntil
      || (!this.seen(new THREE.Vector3(home.x, y + home.y + 1.5, home.z)) && !this.seen(new THREE.Vector3(from.x, y + 1.4, from.z)));
    const had = this.crowd.hasSlot(name);
    const i = this.crowd.show(name, { pos: from, facing: Math.atan2(t.x - from.x, t.z - from.z), seated: false });
    if (i < 0) return null;
    if (!had) this.room.forget(i);                            // (a slot someone else had: nothing of theirs carries over)
    this.audience.away(a, true, this.clock(), !quiet);
    this.homing.delete(i);
    void now;
    return { i, from, quiet };
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

  /** until this moment (scene clock) whoever steps forward is simply there: a seek cuts to them (TIMELINE) */
  instantUntil = -1;

  /**
   * A table's front as of a moment (TIMELINE: a seek): everyone standing there who isn't in `keep` (who says this
   * comment, the next two, the one answered) goes straight back to their place, with no walk: the camera is cutting.
   */
  reset(spot: TableSpot, keep: Set<string>) {
    const fr = this.fronts.get(spot);
    if (!fr) return;
    for (const f of fr) {
      if (f.who < 0) continue;
      const p = this.crowd.people[f.who];
      if (!p || keep.has(p.name)) continue;
      const a = this.ix.get(p.name);
      const i = f.who;
      this.room.leave(i);
      f.who = -1;
      this.homing.delete(i);
      this.crowd.hide(i);
      if (a !== undefined) this.audience.away(a, false, this.clock(), false);
    }
  }

  /** Person i (crowd) leaves wherever they stand at a front (they're going somewhere else). */
  free(i: number) { for (const fr of this.fronts.values()) for (const f of fr) if (f.who === i) f.who = -1; }

  /** Someone new on the floor (they came by the lift: their first comment here just landed) gets a place in the hall,
   *  near the table they spoke at, for when they step back. Their audience index. */
  private join(name: string, near: THREE.Vector3) {
    if (!this.hall) return undefined;
    let home = -1, bd = Infinity;
    this.tables.forEach((t, k) => { const d = Math.hypot(t.x - near.x, t.z - near.z); if (d < bd) { bd = d; home = k; } });
    const place = this.hall.add(home);
    if (!place) return undefined;
    const a = this.audience.append(name, place);
    this.ix.set(name, a); this.people++;
    if (this.hall.used > this.interior.galleryCount) this.interior.galleries(this.hall.used);
    this.audience.away(a, true, 0, false);                 // (they're at a table now: their place waits for them)
    return a;
  }

  /** Crowd person i walks back toward their place in the audience, and takes it again (they fade back in there). */
  sendHome(i: number, now: number) {
    const p = this.crowd.people[i];
    if (!p) return;
    const a = this.ix.get(p.name) ?? this.join(p.name, p.pose.pos);
    if (a === undefined) return;
    const pos = p.pose.pos.clone();
    this.room.leave(i);
    this.free(i);
    const home = this.audience.places[a];
    const sp = this.spots.find((s) => !s.bar && Math.hypot(s.pos.x - pos.x, s.pos.z - pos.z) < s.radius + HALL.FRONT + HALL.LANE);
    const to = this.door(a, sp);
    this.homing.set(i, a);
    this.crowd.walkTo(i, this.room.route(pos, to), Math.atan2(home.x - to.x, home.z - to.z), () => {
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
