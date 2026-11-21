// The room's conversations: every table near you talks, each in its own order, from where its people stand. Walk
// up to one and it's louder; walk away and it falls back into the room. The table you sit at is the director's;
// the mixer plays the rest. A speaker who isn't at their table is called over first (room.ts), and a comment that
// just arrived on Hacker News is said next, wherever its table had got to.
import * as THREE from 'three/webgpu';
import type { LiveSync, Floor, Sidecar, Turn } from './sync.ts';
import type { AudioEngine } from './audio.ts';
import type { Crowd } from './people.ts';
import type { TableSpot } from './interior.ts';
import type { Room } from './room.ts';
import { FACE } from './director.ts';

const HEAR = 9;                                          // metres: tables farther than this fall quiet
const MAX_ON = 4;                                        // tables talking at once (the nearest)
const LEAD = 1.0;                                        // seconds of audio scheduled ahead

interface Scheduled { start: number; end: number; who: number; env: number[]; shape: number[]; src: AudioScheduledSourceNode; emotion: string }
interface Ready { side: Sidecar; bufs: AudioBuffer[] }
interface Player {
  spot: TableSpot;
  idx: number;                                           // the next turn of the table's order
  cursor: number;                                        // audio time the next clip may start
  done: number;                                          // clips of the current turn already scheduled (still being voiced)
  sched: Scheduled[];
  ready: Map<number, Ready>;
  loading: Set<string>;                                  // sidecar paths in flight
  waitFrom: number;
  breaking: Turn[];                                      // comments that arrived live: said next
}

export class Mixer {
  private players: Player[] = [];
  private story = 0;
  /** the table the director is playing (we're seated there): the mixer leaves it alone */
  exclude: TableSpot | null = null;
  private asked = new Map<string, number>();
  private tmp = new THREE.Vector3();

  constructor(private sync: LiveSync, private audio: AudioEngine, private crowd: Crowd, private room: Room) {}

  start(floor: Floor, spots: TableSpot[]) {
    this.stop();
    this.story = floor.story.id;
    this.players = spots.filter((s) => !s.bar).map((spot) => ({ spot, idx: 0, cursor: 0, done: 0, sched: [], ready: new Map(), loading: new Set(), waitFrom: 0, breaking: [] }));
  }

  stop() {
    for (const p of this.players) this.hush(p);
    this.players = [];
  }

  /** Where a table had got to: the director hands back the table we just stood up from. */
  handBack(spot: TableSpot, idx: number) {
    const p = this.players.find((x) => x.spot === spot);
    if (p) { p.idx = idx; p.done = 0; p.cursor = this.audio.now() + 0.8; }
  }
  /** We sit down at this table: it stops mid-word here and the director takes it from the comment in progress. */
  take(spot: TableSpot) {
    const p = this.players.find((x) => x.spot === spot);
    if (!p) return 0;
    const now = this.audio.now(), playing = p.sched.some((s) => s.end > now);
    this.hush(p);
    const at = playing && !p.breaking.length ? Math.max(0, p.idx - 1) : p.idx;
    p.done = 0;
    return at;
  }

  /** A comment just landed on Hacker News at this table: its author comes over (or in) and says it next. */
  breaking(spot: TableSpot, turn: Turn) {
    const p = this.players.find((x) => x.spot === spot);
    if (p && !p.breaking.some((t) => t.id === turn.id)) p.breaking.push(turn);
  }

  update(listener: THREE.Vector3) {
    const now = this.audio.now();
    const ranked = this.players
      .filter((p) => p.spot !== this.exclude)
      .map((p) => ({ p, d: Math.hypot(p.spot.pos.x - listener.x, p.spot.pos.z - listener.z) }))
      .sort((a, b) => a.d - b.d);
    const on = new Map(ranked.filter((x) => x.d < HEAR).slice(0, MAX_ON).map((x, k) => [x.p, k]));
    for (const p of this.players) {
      p.sched = p.sched.filter((s) => s.end > now - 0.2);
      const k = on.get(p);
      if (k === undefined || p.spot === this.exclude) { if (!p.sched.length) this.rest(p); continue; }
      this.feed(p, now, k);
      this.act(p, now);
    }
  }

  /** Stop a table mid-word (we sat down at it, or left the floor). */
  private hush(p: Player) {
    for (const s of p.sched) { try { s.src.stop(); } catch { /* done */ } }
    p.sched = [];
    this.rest(p);
  }
  private rest(p: Player) {
    for (const st of p.spot.seats) {
      const i = this.crowd.people.findIndex((x) => x.pose.pos === st.pos);
      const t = i >= 0 ? this.crowd.target(i) : undefined;
      if (t && !this.crowd.isWalking(i)) { t.open = 0; this.crowd.release(i); }
    }
  }

  /** Keep a table's next words scheduled: fetch them, bring their speaker over, then line them up. */
  private feed(p: Player, now: number, rank: number) {
    if (p.cursor - now > LEAD) return;
    const turns = p.spot.table.turns;
    const turn = p.breaking[0] ?? turns[p.idx];
    if (!turn) {                                         // the end of the thread: a pause, then round again
      if (turns.length && p.idx >= turns.length) { p.idx = 0; p.done = 0; p.cursor = Math.max(p.cursor, now) + 6; }
      return;
    }
    if (!turn.v) {
      this.want(p, p.breaking.length ? 0 : rank, p.breaking.length ? turns.indexOf(turn) : p.idx);
      if (!p.waitFrom) p.waitFrom = now;
      if (now - p.waitFrom > (p.breaking.length ? 40 : 4)) this.next(p);   // not voiced yet: the table moves on
      return;
    }
    const r = this.load(p, turn);
    if (!r) return;
    // nobody speaks from across the room: the speaker comes to the table first
    const here = this.room.callOver(turn.by, p.spot, now);
    if (here !== 'here') {
      if (!p.waitFrom) p.waitFrom = now;
      if (now - p.waitFrom > 30) this.next(p);
      return;
    }
    if (r.side.clips.length <= p.done) {                // nothing new yet (still being voiced), or nothing at all
      if (!r.side.partial) { this.next(p); return; }
      this.want(p, rank, p.idx);
      if (!p.waitFrom) p.waitFrom = now;
      if (now - p.waitFrom > 30) this.next(p);
      return;
    }
    p.waitFrom = 0;
    const i = this.room.who(turn.by);
    let t = Math.max(p.cursor, now + 0.05) + (p.done ? 0 : (turn.gapMs ?? 500) / 1000);
    r.side.clips.forEach((c, k) => {
      if (k < p.done) return;
      // a quote of someone at this table is said by them; anyone else's words, by the speaker
      const q = c.who !== turn.by ? this.room.who(c.who) : -1;
      const who = q >= 0 && this.room.tableOf(q) === p.spot ? q : i;
      const pos = this.crowd.headPos(who, this.tmp);
      const src = this.audio.voice(r.bufs[k], t, pos, this.sync.url(c.u), 1, { hrtf: rank < 2, ref: 1.1, rolloff: 1.35 });
      p.sched.push({ start: t, end: t + c.d, who, env: c.env, shape: c.shape, src, emotion: r.side.emotion });
      t += c.d + 0.06;
    });
    this.room.speaking(i, t);
    p.cursor = t;
    if (r.side.partial) { p.done = r.side.clips.length; return; }   // the rest is on its way: stay on this turn
    this.next(p);
    // fetch the next turn while this one plays
    const nt = p.breaking[0] ?? turns[p.idx];
    if (nt?.v) this.load(p, nt);
  }

  private next(p: Player) {
    const turns = p.spot.table.turns;
    const played = p.breaking.length ? p.breaking.shift()! : turns[p.idx++];
    p.done = 0; p.waitFrom = 0;
    if (played) p.ready.delete(played.id);               // decoded audio goes once it's been said
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

  /** Ask for a table's voicing from a turn on: the table you're nearest, every 30 s while you're there. */
  private want(p: Player, rank: number, from: number) {
    if (rank > 0 || from < 0) return;
    const key = `${p.spot.index}:${from}`, t = performance.now() / 1000;
    if (t - (this.asked.get(key) ?? -1e9) < 30) return;
    this.asked.set(key, t);
    this.sync.want(this.story, p.spot.index, from).then((ok) => { if (!ok) this.asked.set(key, t - 25); });
  }

  /** Faces: the one speaking moves their mouth (and wears the comment's mood); the table turns to them. */
  private act(p: Player, now: number) {
    const cur = p.sched.find((s) => s.start <= now && s.end > now);
    const seats = p.spot.seats;
    for (const st of seats) {
      const i = this.crowd.people.findIndex((x) => x.pose.pos === st.pos);
      const t = i >= 0 ? this.crowd.target(i) : undefined;
      if (!t || this.crowd.isWalking(i)) continue;
      this.crowd.active.add(i);
      if (cur && i === cur.who) {
        const f = Math.floor((now - cur.start) * 30);
        t.open = Math.min(1, ((cur.env[f] ?? 0) / 255) * 1.15);
        t.shape = (cur.shape[f] ?? 127) / 127.5 - 1;
        const face = FACE[cur.emotion] ?? FACE.mundane;
        t.brow = face.brow ?? 0; t.browIn = face.browIn ?? 0; t.smile = face.smile ?? 0.15; t.lid = face.lid ?? 1;
      } else {
        t.open = 0;
        if (cur) {                                       // everyone else looks at whoever is talking
          const h = this.crowd.headPos(cur.who, this.tmp);
          t.yaw = this.crowd.yawTo(i, h);
          t.nod = this.crowd.pitchTo(i, h);
        }
      }
    }
  }
}
