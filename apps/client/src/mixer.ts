// The room's conversations: every table near you talks, each in its own order, from where its people stand, and
// acts it as the table you sit at does (performer.ts): faces, gestures, someone getting to their feet. The table
// you're at, or facing, comes forward; the others fall back into a muffled murmur you can still hear. The table you
// sit at is the director's; the mixer plays the rest. A speaker who isn't at their table is called over first
// (room.ts), and a comment that just arrived on Hacker News is said next, wherever its table had got to.
import * as THREE from 'three/webgpu';
import type { LiveSync, Floor, Sidecar, Turn } from './sync.ts';
import { emoGain, type AudioEngine, type Bus } from './audio.ts';
import type { Crowd } from './people.ts';
import type { TableSpot } from './interior.ts';
import type { Room } from './room.ts';
import { Performer, tone, RISE_LEAD, type Line } from './performer.ts';

const HEAR = 9;                                          // metres: tables farther than this fall quiet
const MAX_ON = 4;                                        // tables talking at once (the nearest)
const LEAD = 1.0;                                        // seconds of audio scheduled ahead
/** how a table sounds: the one you're with, the others while you're with one, all of them while you wander, and
 *  the rest of the room while you sit (level, low-pass Hz). Distance comes on top (the panner). */
const MIX = { focus: [1, 18000], others: [0.3, 1500], wander: [0.5, 2600], seated: [0.16, 1100] } as const;

interface Scheduled extends Line { src: AudioScheduledSourceNode }
interface Ready { side: Sidecar; bufs: AudioBuffer[] }
interface Player {
  spot: TableSpot;
  cursor: number;                                        // audio time the next clip may start
  done: number;                                          // clips of the current turn already scheduled (still being voiced)
  sched: Scheduled[];
  ready: Map<number, Ready>;
  loading: Set<string>;                                  // sidecar paths in flight
  /** what the table is waiting on (and for which comment), since waitFrom: each wait has its own clock */
  stage: string;
  waitFrom: number;
  /** the comment whose first `done` clips are scheduled (the rest still being voiced): it's finished first */
  doing: number;
  /** comments that arrived live (ids, resolved against the table's current turns): said next */
  breaking: number[];
  /** what's been said here (ids): the table's order shifts as replies land, so a position would replay things */
  played: Set<number>;
  resting: boolean;
  /** out of earshot: its people ease back to calm until then, and are let go */
  calmUntil: number;
  perf: Performer;
  bus: Bus | null;
  /** the level and low-pass this table should have now (a new channel starts there, not at full and then easing) */
  want: readonly [number, number];
}

export class Mixer {
  private players: Player[] = [];
  private bySpot = new Map<TableSpot, Player>();
  private story = 0;
  /** the table the director is playing (we're seated there): the mixer leaves it alone */
  exclude: TableSpot | null = null;
  /** chairs follow whoever stands up out of them (as at the director's table) */
  pushChair: (chair: number, k: number) => void = () => {};
  /** the table you're with (nearest, or the one you're facing): it's heard clearly */
  focus: TableSpot | null = null;
  private focused: Player | null = null;
  /** a table brought to your ears for a while, wherever you are on the floor (someone just answered you there) */
  private light: { p: Player; turn: number; until: number } | null = null;
  /** someone answered you at this table (comment `turn`): it's the table you hear until that reply has been said
   *  (waiting up to a minute for its voice) */
  spotlight(spot: TableSpot, turn: number) { const p = this.bySpot.get(spot); if (p) this.light = { p, turn, until: this.audio.now() + 60 }; }
  private asked = new Map<string, number>();
  private tmp = new THREE.Vector3();

  constructor(private sync: LiveSync, private audio: AudioEngine, private crowd: Crowd, private room: Room) {}

  start(floor: Floor, spots: TableSpot[]) {
    this.stop();
    this.story = floor.story.id;
    this.players = spots.filter((s) => !s.bar).map((spot) => ({
      spot, cursor: 0, done: 0, sched: [], ready: new Map(), loading: new Set(), stage: '', waitFrom: 0, doing: 0,
      breaking: [], played: new Set(), resting: true, calmUntil: 0, bus: null,
      // the people at this table: by name, among its seats (one person per commenter on the floor)
      perf: new Performer(this.crowd, spot, (n) => (spot.seats.some((st) => st.name === n) ? this.crowd.index(n) : -1), (c, k) => this.pushChair(c, k)),
      want: MIX.wander,
    }));
    this.bySpot = new Map(this.players.map((p) => [p.spot, p]));
  }

  stop() {
    for (const p of this.players) {
      this.hush(p);
      p.perf.reset();
      if (p.bus) { p.bus.gain.disconnect(); p.bus.lp.disconnect(); }
    }
    this.players = []; this.bySpot.clear(); this.focused = null; this.focus = null; this.light = null;
  }

  /** Where a table had got to: the director hands back the table we stood up from (what it had said there). */
  handBack(spot: TableSpot, said: number[]) {
    const p = this.players.find((x) => x.spot === spot);
    if (p) { for (const id of said) p.played.add(id); p.done = 0; p.stage = ''; p.cursor = this.audio.now() + 0.8; p.resting = false; }
  }
  /** We sit down at this table: it stops mid-word here and the director takes it from the comment in progress. */
  take(spot: TableSpot) {
    const p = this.players.find((x) => x.spot === spot);
    if (!p) return 0;
    const now = this.audio.now();
    const cut = p.sched.find((s) => s.end > now)?.turn.id;   // the comment we cut off: the director says it again, whole
    this.hush(p);
    p.perf.reset();
    if (cut !== undefined) p.played.delete(cut);
    p.done = 0; p.stage = '';
    const turns = p.spot.table.turns, at = turns.findIndex((u) => !p.played.has(u.id));
    return at < 0 ? turns.length : at;
  }

  /** A comment just landed on Hacker News at this table: its author comes over (or in) and says it next. */
  breaking(spot: TableSpot, turn: Turn) {
    const p = this.players.find((x) => x.spot === spot);
    if (p && !p.breaking.includes(turn.id) && !p.played.has(turn.id)) p.breaking.push(turn.id);
  }

  /** You walked up to this table: the two nearest of its people (not the one talking) look round at you, a moment. */
  greet(spot: TableSpot, at: THREE.Vector3) {
    const p = this.bySpot.get(spot), now = this.audio.now();
    if (!p) return;
    const talking = p.sched.find((s) => s.start <= now && s.end > now)?.who ?? -1;
    const near = spot.seats.map((st) => ({ i: this.crowd.index(st.name), d: Math.hypot(st.pos.x - at.x, st.pos.z - at.z) }))
      .filter((x) => x.i >= 0 && x.i !== talking && !this.crowd.isWalking(x.i)).sort((a, b) => a.d - b.d).slice(0, 2);
    near.forEach((x, k) => p.perf.glance(x.i, at, now + 1.1 + k * 0.35));
  }
  /** each table's plans (vibe tests): who performs what, when (against the audio clock) */
  plans() { const now = this.audio.now(); return this.players.map((p, k) => [...p.perf.plans.values()].filter((x) => x.end > now - 2).map((x) => ({ k, S: x.S, A: x.A, gesture: x.gesture, stand: x.stand, ST: x.ST, E: x.E, start: +(x.start - now).toFixed(2), end: +(x.end - now).toFixed(2) }))).flat(); }
  /** each table's channel (vibe tests): level and low-pass, or null before it has spoken */
  levels() { return this.players.map((p) => (p.bus ? { level: p.bus.level, hz: p.bus.hz } : null)); }
  /** what's being said at a table right now (the line, and whether it's the table you're with), for labels */
  speaking(spot: TableSpot): Line | null {
    const p = this.bySpot.get(spot), now = this.audio.now();
    if (!p || !p.sched.length) return null;
    for (const s of p.sched) if (s.start <= now && s.end > now) return s;
    return null;
  }

  private ranked: { p: Player; d: number }[] = [];
  private on = new Map<Player, number>();
  update(listener: THREE.Vector3, forward: THREE.Vector3, dt: number) {
    const now = this.audio.now();
    // the tables by distance (reusing last frame's list: this runs every frame)
    const ranked = this.ranked;
    ranked.length = 0;
    for (const p of this.players) if (p.spot !== this.exclude) ranked.push({ p, d: Math.hypot(p.spot.pos.x - listener.x, p.spot.pos.z - listener.z) });
    ranked.sort((a, b) => a.d - b.d);
    const on = this.on;
    on.clear();
    for (let k = 0; k < ranked.length && k < MAX_ON && ranked[k].d < HEAR; k++) on.set(ranked[k].p, k);
    const lit = this.light && this.light.until > now && this.light.p.spot !== this.exclude ? this.light.p : null;
    if (lit && !on.has(lit)) on.set(lit, 0);              // in earshot, however far
    const focus = this.exclude ? null : lit ?? this.pick(ranked, listener, forward);
    this.focus = focus?.spot ?? null;
    for (const p of this.players) {
      if (p.spot === this.exclude) continue;              // the director's table: its people are the director's
      p.sched = p.sched.filter((s) => s.end > now - 0.2);
      p.want = this.exclude ? MIX.seated : !focus ? MIX.wander : p === focus ? MIX.focus : MIX.others;
      if (p.bus) this.audio.setBus(p.bus, p.want[0], p.want[1]);
      const k = on.get(p);
      if (k === undefined) {                             // out of earshot: its last words finish, acted, then it calms down
        if (p.sched.length) {
          const cur = p.sched.find((s) => s.start <= now && s.end > now) ?? null;
          p.perf.animate(p.sched, cur, now, dt);
          p.perf.chairs();
          continue;
        }
        if (!p.resting) { p.resting = true; p.calmUntil = now + 1.6; }
        if (p.calmUntil) this.calm(p, now, dt);
        continue;
      }
      p.resting = false; p.calmUntil = 0;
      this.feed(p, now, k, p === focus, !focus, p === lit);
      const cur = p.sched.find((s) => s.start <= now && s.end > now) ?? null;
      p.perf.animate(p.sched, cur, now, dt, { upcoming: this.upcoming(p) });
      p.perf.chairs();
    }
  }

  /** The table you're with: the nearest, or the one you're facing (facing one counts like being 0.9 m nearer), and
   *  it stays yours until another is clearly more so (no flicking between two). */
  private pick(ranked: { p: Player; d: number }[], at: THREE.Vector3, fwd: THREE.Vector3): Player | null {
    const fl = Math.hypot(fwd.x, fwd.z) || 1;
    let best: Player | null = null, bestS = Infinity, curS = Infinity;
    for (const { p, d } of ranked) {
      if (d > 7) break;
      const edge = Math.max(0, d - p.spot.radius);
      if (edge > 3.2) continue;
      const facing = ((p.spot.pos.x - at.x) * fwd.x + (p.spot.pos.z - at.z) * fwd.z) / ((d || 1) * fl);
      const s = edge - 0.9 * Math.max(0, facing);
      if (s < bestS) { bestS = s; best = p; }
      if (p === this.focused) curS = s;
    }
    if (this.focused && curS < Infinity && curS <= bestS + 0.35) return this.focused;
    return (this.focused = best);
  }

  /** whoever speaks in the next few turns here, and how (someone about to push back already doubts it) */
  private upcoming(p: Player) {
    const up = new Map<number, string>();
    let n = 0;
    for (const u of p.spot.table.turns) {
      if (p.played.has(u.id)) continue;
      if (++n > 3) break;
      const r = p.ready.get(u.id), i = r ? this.room.who(u.by) : -1;
      if (r && i >= 0 && !up.has(i)) up.set(i, tone(r.side).ST);
    }
    return up;
  }

  /** Stop a table mid-word (we sat down at it, or left the floor). */
  private hush(p: Player) {
    for (const s of p.sched) { try { s.src.stop(); } catch { /* done */ } }
    p.sched = [];
    p.resting = true; p.calmUntil = this.audio.now() + 1.6;
  }
  /** Back to calm listening (and chairs pulled in), then let go: nobody is frozen mid-word or mid-gesture. */
  private calm(p: Player, now: number, dt: number) {
    p.perf.animate([], null, now, dt);
    p.perf.chairs();
    if (now < p.calmUntil) return;
    p.calmUntil = 0;
    for (const st of p.spot.seats) {
      const i = this.crowd.index(st.name);
      if (i >= 0 && !this.crowd.isWalking(i)) this.crowd.release(i);
    }
  }

  /** Keep a table's next words scheduled: fetch them, bring their speaker over, then line them up. */
  private feed(p: Player, now: number, rank: number, focus: boolean, wandering: boolean, lit = false) {
    if (p.cursor - now > LEAD) return;
    const turns = p.spot.table.turns;
    p.breaking = p.breaking.filter((id) => !p.played.has(id) && turns.some((u) => u.id === id));
    // a comment half said (the rest still being voiced) is finished first; then whatever just arrived; then the rest
    const going = p.done ? turns.find((u) => u.id === p.doing && !p.played.has(u.id)) : undefined;
    if (!going) p.done = 0;                              // (it went: deleted, or hidden)
    const turn = going ?? (p.breaking.length ? turns.find((u) => u.id === p.breaking[0]) : undefined) ?? turns.find((u) => !p.played.has(u.id));
    if (!turn) {                                         // the whole thread said: a pause, then round again
      // (its plans go too: a plan keeps the earliest start it has seen, so a second lap would act everything late)
      if (turns.length) {
        p.played.clear(); p.done = 0; p.stage = ''; p.cursor = Math.max(p.cursor, now) + 6;
        for (const id of p.perf.plans.keys()) if (!p.sched.some((s) => s.turn.id === id)) p.perf.plans.delete(id);
      }
      return;
    }
    // the table you're with asks for its voices (or, while you wander, the nearest)
    const ask = focus || (wandering && rank === 0);
    const live = p.breaking.includes(turn.id), at = turns.indexOf(turn);
    if (!turn.v) {
      if (ask || live) this.want(p, at);
      // not voiced yet: the table moves on (sooner on a busy evening, when it would wait in vain)
      if (this.waited(p, `voice:${turn.id}`, now) > (live ? 40 : (this.sync.head?.load ?? 0) > 12 ? 1.5 : 4)) this.next(p, turn);
      return;
    }
    const r = this.load(p, turn);
    if (!r) {                                            // fetching: or failing to, which must not stall the table
      if (this.waited(p, `load:${turn.id}`, now) > 15) this.next(p, turn);
      return;
    }
    // nobody speaks from across the room: the speaker comes to the table first (or, if the room is full, speaks
    // from the table without a body)
    const here = this.room.callOver(turn.by, p.spot, now);
    if (here === 'coming' || here === 'busy') {
      if (this.waited(p, `call:${turn.id}`, now) > 30) this.next(p, turn);
      return;
    }
    if (r.side.clips.length <= p.done) {                // nothing new yet (still being voiced), or nothing at all
      if (!r.side.partial) { this.next(p, turn); return; }
      if (ask) this.want(p, at);
      if (this.waited(p, `more:${turn.id}`, now) > 30) this.next(p, turn);
      return;
    }
    p.stage = '';
    p.bus ??= this.audio.bus(p.want[0], p.want[1]);
    const i = here === 'here' ? this.room.who(turn.by) : -1;
    const gain = emoGain(r.side.emotion, r.side.intensity);
    // the pause before a turn: a comeback or a heated line barely waits; after a joke, a beat for the laugh
    const st = tone(r.side), heated = (st.E === 'angry' && st.I >= 0.45) || st.ST === 'retort';
    const gap = p.done ? 0 : heated ? Math.min(0.12, (turn.gapMs ?? 500) / 1000) : (turn.gapMs ?? 500) / 1000;
    let t = Math.max(p.cursor, now + 0.05) + gap;
    r.side.clips.forEach((c, k) => {
      if (k < p.done) return;
      // a quote of someone at this table is said by them; anyone else's words, by the speaker
      const q = c.who !== turn.by ? this.room.who(c.who) : -1;
      const who = q >= 0 && this.room.tableOf(q) === p.spot ? q : i;
      const pos = who >= 0 ? this.crowd.headPos(who, this.tmp) : this.tmp.set(p.spot.pos.x, this.crowd.group.position.y + 1.2, p.spot.pos.z);
      // (a table brought to your ears carries across the room)
      const src = this.audio.voice(r.bufs[k], t, pos, this.sync.url(c.u), gain, { hrtf: focus || rank < 2, ref: lit ? 4 : 1.1, rolloff: 1.35, bus: p.bus });
      p.sched.push({ clip: c, side: r.side, turn, start: t, end: t + c.d, who, src });
      t += c.d + 0.06;
    });
    if (i >= 0) this.room.speaking(i, t);
    if (lit && this.light?.turn === turn.id) this.light.until = t + 2;   // the reply is said now: hold until it's done
    // someone at the table you're with getting to their feet: the chair scrapes back, palms on the table
    const first = p.sched.find((s) => s.turn.id === turn.id && s.clip === r.side.clips[0]);
    if (focus && first && !p.done && i >= 0) {
      const plan = p.perf.plan(first, p.sched);
      if (plan.stand) {
        const at = this.crowd.people[i].pose.pos, y = this.crowd.group.position.y;
        this.audio.sfxAt('chair', { x: at.x, y: y + 0.4, z: at.z }, first.start - RISE_LEAD + 0.05);
        this.audio.sfxAt('thump', { x: p.spot.pos.x, y: y + 0.76, z: p.spot.pos.z }, first.start - RISE_LEAD + 0.3);
      }
    }
    p.cursor = t;
    if (r.side.partial) { p.done = r.side.clips.length; p.doing = turn.id; return; }   // the rest is on its way: stay on this turn
    this.next(p, turn);
    // fetch the next turn while this one plays
    const nt = turns.find((u) => !p.played.has(u.id));
    if (nt?.v) this.load(p, nt);
  }

  /** How long the table has waited on this (a new wait starts its own clock). */
  private waited(p: Player, stage: string, now: number) {
    if (p.stage !== stage) { p.stage = stage; p.waitFrom = now; }
    return now - p.waitFrom;
  }

  private next(p: Player, turn: Turn) {
    p.played.add(turn.id);
    p.breaking = p.breaking.filter((id) => id !== turn.id);
    p.done = 0; p.stage = '';
    p.ready.delete(turn.id);                             // decoded audio goes once it's been said
  }

  /** The turn's sidecar and decoded clips, once both are in (null until then). */
  private load(p: Player, turn: Turn): Ready | null {
    const r = p.ready.get(turn.id);
    const path = turn.v![0];
    if (r && (r.side.clips.length > p.done || !r.side.partial || p.loading.has(path))) return r;
    if (!p.loading.has(path)) {
      p.loading.add(path);
      this.sync.sidecar(path)
        .then(async (side) => ({ side, bufs: await Promise.all(side.clips.map((c) => this.audio.load(this.sync.url(c.u)))) }))
        .then((x) => { const have = p.ready.get(turn.id); if (!have || x.side.clips.length >= have.side.clips.length) p.ready.set(turn.id, x); })
        .catch(() => { /* tried again when asked again */ })
        .finally(() => setTimeout(() => p.loading.delete(path), 3000));
    }
    return r ?? null;
  }

  /** Ask for a table's voicing from a turn on, every 30 s while you're there. */
  private want(p: Player, from: number) {
    if (from < 0) return;
    const key = `${this.story}:${p.spot.table.root}:${from}`, t = performance.now() / 1000;
    if (t - (this.asked.get(key) ?? -1e9) < 30) return;
    this.asked.set(key, t);
    this.sync.want(this.story, p.spot.index, from).then((ok) => { if (!ok) this.asked.set(key, t - 25); });
  }
}
