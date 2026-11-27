// The floor's narration on foot (FLOOR_TIMELINE): every comment on the floor, one voice at a time, in the order they
// were written, each said at its own table by whoever wrote it (they step forward to the table's front), heard from
// where that table is in the hall. It keeps the floor's clock: while a comment is said, the room's moment glides from
// it toward the next one, so what you see keeps time with what you hear (people come and go, tables light up as their
// comments land). Let the line go anywhere and it plays from the comment there; sit down and the director takes your
// table, on the same clock.
//
// Its way of fetching and scheduling is the mixer's (mixer.ts), for one sequence that moves between tables: the next
// few comments' words fetched and decoded ahead, the server asked to voice what isn't voiced yet (once per stretch,
// renewed while it's still wanted), a comment that has no voice yet waited for briefly, then passed (its table still
// lights: it was written).
import * as THREE from 'three/webgpu';
import type { LiveSync, Sidecar, Turn, Floor } from './sync.ts';
import { emoGain, type AudioEngine } from './audio.ts';
import type { Crowd } from './people.ts';
import type { TableSpot } from './interior.ts';
import type { Room } from './room.ts';
import type { Stage } from './stage.ts';
import { Performer, type Line } from './performer.ts';
import type { FloorClock } from './floortime.ts';

/** seconds of audio scheduled ahead */
const LEAD = 1.0;
/** a comment with no voice yet is waited for this long (s), then passed */
const WAIT = 4;
/** comments fetched and decoded ahead of the one playing */
const AHEAD = 3;
/** after their comment, a speaker stays at the table's front this long (s), unless they speak again */
const LINGER = 7;

interface Ready { side: Sidecar; bufs: AudioBuffer[] }
interface Said extends Line { src: AudioScheduledSourceNode; i: number; spot: TableSpot }

export class FloorVoice {
  private c: FloorClock | null = null;
  private floor: Floor | null = null;
  private spots: TableSpot[] = [];
  private turnOf = new Map<number, Turn>();
  /** the next comment to schedule (an index into the clock's comments) */
  private k = 0;
  private done = 0;
  private cursor = 0;
  private sched: Said[] = [];
  private ready = new Map<number, Ready>();
  private loading = new Set<string>();
  private perfs = new Map<TableSpot, Performer>();
  private asked = new Map<string, number>();
  private stage = '';
  private waitFrom = 0;
  /** speakers at a front, and when they last finished (they go home LINGER after) */
  private fronts = new Map<number, number>();
  private tmp = new THREE.Vector3();
  playing = false;
  paused = false;
  /** where the narration was started (a comment index): the clock before its first word */
  private from = 0;

  constructor(private sync: LiveSync, private audio: AudioEngine, private crowd: Crowd, private room: Room, private stageOf: () => Stage) {}
  /** where a comment is on the server's floor now (its table and its place there: [-1, -1] gone): the building keeps
   *  its own table order, and a voicing request must name the server's */
  live: (table: number, id: number) => [number, number] = () => [-1, -1];

  /** The floor to narrate (its clock and its tables), and the comment to start from. */
  start(floor: Floor, c: FloorClock, spots: TableSpot[], from: number) {
    this.stop();
    this.floor = floor; this.c = c; this.spots = spots;
    // (the spots' tables, not the floor's: they carry every voice that has landed since the building was made)
    this.turnOf.clear();
    for (const sp of spots) for (const u of sp.table.turns) this.turnOf.set(u.id, u);
    for (const t of floor.tables) for (const u of t.turns) if (!this.turnOf.has(u.id)) this.turnOf.set(u.id, u);
    // (a pause anywhere, at a table or here, suspended the sound: what starts now is heard)
    if (this.audio.ctx?.state === 'suspended' && !document.hidden) this.audio.ctx.resume().catch(() => {});
    this.k = this.from = Math.max(0, Math.min(c.comments.length, from));
    this.done = 0; this.cursor = this.audio.now() + 0.05; this.stage = ''; this.spans = []; this.announced = -1;
    this.playing = c.comments.length > 0; this.paused = false;
    this.prefetch();
  }

  /** the people at fronts the narration brought (crowd indices) */
  speakers() { return this.fronts.keys(); }
  /** Voices that landed since (comment id → its voicing): the comments still to come play them. */
  voices(v: Map<number, Turn['v']>) {
    for (const [id, x] of v) { const u = this.turnOf.get(id); if (u && x && (!u.v || u.v[0] !== x[0])) this.turnOf.set(id, { ...u, v: x }); }
  }

  /** Stop at once: every scheduled word, every performance, every speaker back to their place. */
  stop() {
    // (a pause of ours suspended the sound: whatever plays next, here or at a table or on the tower, has it back)
    if (this.paused) { this.paused = false; this.audio.ctx?.resume().catch(() => {}); }
    for (const s of this.sched) { try { s.src.stop(); } catch { /* done */ } }
    this.sched = [];
    for (const p of this.perfs.values()) p.reset();
    this.perfs.clear();
    const now = this.audio.now();
    for (const i of this.fronts.keys()) this.stageOf().sendHome(i, now);
    this.fronts.clear();
    this.playing = false;
  }

  /** The moment on the floor's clock that goes with what's being said: the comment's own moment, gliding toward the
   *  next comment's as it's said (and held just short of it until that one starts). Before a word: where it started. */
  time(): number {
    const c = this.c;
    if (!c || !c.comments.length) return 0;
    const now = this.audio.now(), at = (i: number) => c.comments[Math.min(c.comments.length - 1, i)].at;
    let span: { i: number; s0: number; s1: number; partial: boolean } | null = null;
    for (const x of this.spans) if (x.s0 <= now && (!span || x.s0 >= span.s0)) span = x;
    const lead = this.announced >= 0 ? at(this.announced) : -Infinity;
    if (!span) return Math.max(at(this.from), lead);
    const next = span.i + 1 < c.comments.length ? at(span.i + 1) : c.end;
    const f = Math.min(span.partial ? 0.5 : 1, Math.max(0, (now - span.s0) / Math.max(0.5, span.s1 - span.s0)));
    // (the next comment, once it's on its way, has happened: the room is at its moment until it's said)
    return Math.max(lead, Math.min(next - 0.001, at(span.i) + f * (next - at(span.i))));
  }
  /** the comment whose moment the room has moved to (about to be said, or being said), and who hears of it */
  private announced = -1;
  onComment: (i: number) => void = () => {};
  /** the floor's last comment has been said */
  onEnd: () => void = () => {};
  /** each comment said lately: when its words start and end (audio time) */
  private spans: { i: number; s0: number; s1: number; partial: boolean }[] = [];

  /** (main.ts, the camera following) how long the camera needs to get to a table, s (0: it isn't following) */
  travel: (spot: TableSpot) => number = () => 0;
  /** The comment that's next (its table, and its writer as an actor, -1 if not one yet), once what's being said now has
   *  less than `lead` s to go: the camera sets off for it, so it's there as it starts. Null: nothing's next yet. */
  ahead(lead: number): { spot: TableSpot; who: number } | null {
    const c = this.c, a = this.announced;
    if (!c || a < 0 || !this.playing) return null;
    const now = this.audio.now();
    let end = -Infinity;
    for (const s of this.sched) {
      if (s.i === a && s.start <= now) return null;     // (being said already: current() has it)
      if (s.i !== a) end = Math.max(end, s.end);
    }
    if (end - now > lead) return null;
    const said = c.comments[a], spot = this.spots[said.table], by = this.turnOf.get(said.id)?.by;
    return spot ? { spot, who: by ? this.room.who(by) : -1 } : null;
  }

  /** what's being said right now (for the caption), or null */
  current(): (Line & { spot: TableSpot; i: number }) | null {
    const now = this.audio.now();
    for (const s of this.sched) if (s.start <= now && s.end > now) return s;
    return null;
  }
  /** the comment index being said (or about to be) */
  get at() { return this.current()?.i ?? this.k; }

  togglePause() {
    this.paused = !this.paused;
    const ctx = this.audio.ctx;
    if (this.paused) ctx?.suspend(); else ctx?.resume().catch(() => {});
  }

  update(now: number, dt: number) {
    const c = this.c;
    if (!c || !this.floor) return;
    this.sched = this.sched.filter((s) => s.end > now - 0.25);
    if (this.playing && !this.paused) this.feed(now);
    // each table someone is speaking at acts it (mouths, hands, someone on their feet)
    for (const [spot, perf] of this.perfs) {
      const lines = this.sched.filter((s) => s.spot === spot), cur = lines.find((s) => s.start <= now && s.end > now) ?? null;
      perf.animate(lines, cur, now, dt);
      if (!lines.length && !this.speakingAt(spot)) { perf.reset(); this.perfs.delete(spot); }
    }
    // speakers who have had their say go back to their places (not while they're due again)
    for (const [i, until] of this.fronts) {
      if (now - until < LINGER || this.sched.some((s) => s.who === i)) continue;
      this.fronts.delete(i);
      this.stageOf().sendHome(i, now);
    }
  }

  private speakingAt(spot: TableSpot) { return this.sched.some((s) => s.spot === spot); }

  /** Keep the next comment scheduled: fetch it, bring its writer to its table, line its words up. */
  private feed(now: number) {
    const c = this.c!;
    if (this.cursor - now > LEAD) return;
    if (this.k >= c.comments.length) { if (!this.sched.length && this.playing) { this.playing = false; this.onEnd(); } return; }
    const said = c.comments[this.k], turn = this.turnOf.get(said.id), spot = this.spots[said.table];
    if (!turn || !spot) { this.next(); return; }
    if (!turn.v) {
      this.want(said.table, turn);
      if (this.waited(`voice:${turn.id}`, now) > ((this.sync.head?.load ?? 0) > 12 ? 1.5 : WAIT)) this.next();
      return;
    }
    const r = this.load(turn);
    if (!r) { if (this.waited(`load:${turn.id}`, now) > 12) this.next(); return; }
    // (its moment comes first: the room moves to it, so whoever writes it is in the room to say it)
    if (this.announced !== said.i) { this.announced = said.i; this.onComment(said.i); }
    const here = this.room.callOver(turn.by, spot, now);
    if ((here === 'coming' || here === 'busy') && !this.done) {
      const w = this.waited(`call:${turn.id}`, now);
      if (w > 20) { this.next(); return; }
      if (w < (here === 'coming' ? 0.8 : 2)) return;    // (cue: they speak as they come, from the table)
    }
    if (r.side.clips.length <= this.done) {
      if (!r.side.partial) { this.next(); return; }
      this.want(said.table, turn);
      if (this.waited(`more:${turn.id}`, now) > 30) this.next();
      return;
    }
    this.stage = '';
    const i = here === 'here' ? this.room.who(turn.by) : -1;
    const perf = this.perfs.get(spot) ?? this.perfs.set(spot, new Performer(this.crowd, spot, (n) => (spot.seats.some((st) => st.name === n) ? this.crowd.index(n) : -1), () => {})).get(spot)!;
    const gain = emoGain(r.side.emotion, r.side.intensity);
    // (between comments, a breath; longer if the camera is crossing the hall to this one: it gets there as it starts)
    let t = Math.max(this.cursor, now + 0.05) + (this.done || !this.sched.length ? 0 : Math.max(0.45, Math.min(1.8, this.travel(spot) - 0.9)));
    r.side.clips.forEach((clip, k) => {
      if (k < this.done) return;
      const pos = i >= 0 ? this.crowd.headPos(i, this.tmp) : this.tmp.set(spot.pos.x, this.crowd.group.position.y + 1.2, spot.pos.z);
      // (the floor's one voice: heard across the hall, from where it is)
      const src = this.audio.voice(r.bufs[k], t, pos, this.sync.url(clip.u), gain, { hrtf: true, ref: 3.5, rolloff: 0.7 });
      this.sched.push({ clip, side: r.side, turn, start: t, end: t + clip.d, who: i, src, i: said.i, spot });
      t += clip.d + 0.06;
    });
    void perf;
    // (someone still walking over is at the front too, as far as going home goes)
    const at = i >= 0 ? i : this.room.who(turn.by);
    if (at >= 0) { this.room.speaking(at, t); this.fronts.set(at, t); }
    const first = this.sched.find((x) => x.i === said.i)?.start ?? t;
    const sp = this.spans.find((x) => x.i === said.i);
    if (sp) { sp.s1 = t; sp.partial = !!r.side.partial; } else this.spans.push({ i: said.i, s0: first, s1: t, partial: !!r.side.partial });
    if (this.spans.length > 8) this.spans.shift();
    this.cursor = t;
    if (r.side.partial) { this.done = r.side.clips.length; return; }
    this.next();
  }

  private next() {
    const c = this.c!, said = c.comments[this.k];
    if (said) this.ready.delete(said.id);
    this.k++; this.done = 0; this.stage = '';
    this.prefetch();
  }

  /** the next few comments' words, fetched and decoded while this one plays */
  private prefetch() {
    const c = this.c;
    if (!c) return;
    for (let k = this.k; k < Math.min(c.comments.length, this.k + AHEAD); k++) {
      const turn = this.turnOf.get(c.comments[k].id);
      if (turn?.v) this.load(turn);
    }
  }
  /** (scrubbing) comment k is where the finger rests: its words and the next one's, ready for a release there */
  prefetchAt(k: number) {
    const c = this.c;
    if (!c) return;
    for (let j = Math.max(0, k); j < Math.min(c.comments.length, k + 2); j++) {
      const turn = this.turnOf.get(c.comments[j].id);
      if (turn?.v) this.load(turn);
    }
  }
  /** what we know of comment k's words right now (fetched): for the line's card */
  snippet(k: number): string | null {
    const id = this.c?.comments[k]?.id;
    const r = id === undefined ? undefined : this.ready.get(id) ?? this.kept.get(id);
    return r ? r.side.clips.map((x) => x.t).join(' ') : null;
  }
  /** comment k's first words and who says them, if they're here already (the caption on a release, at once) */
  first(k: number): { who: string; text: string; side: Sidecar } | null {
    const id = this.c?.comments[k]?.id;
    const r = id === undefined ? undefined : this.ready.get(id) ?? this.kept.get(id);
    const clip = r?.side.clips[0];
    return clip ? { who: clip.who, text: clip.t, side: r!.side } : null;
  }
  /** (the card's words outlive the playing: a few dozen sidecars, kept by id) */
  private kept = new Map<number, Ready>();

  private waited(stage: string, now: number) {
    if (this.stage !== stage) { this.stage = stage; this.waitFrom = now; }
    return now - this.waitFrom;
  }

  private load(turn: Turn): Ready | null {
    const r = this.ready.get(turn.id), path = turn.v![0];
    if (r && (r.side.clips.length > this.done || !r.side.partial || this.loading.has(path))) return r;
    if (!this.loading.has(path)) {
      this.loading.add(path);
      const keep = (x: Ready) => {
        const have = this.ready.get(turn.id);
        if (!have || x.side.clips.length >= have.side.clips.length) this.ready.set(turn.id, x);
        this.kept.set(turn.id, x);
        if (this.kept.size > 48) this.kept.delete(this.kept.keys().next().value!);
      };
      this.sync.sidecar(path)
        .then(async (side) => {
          const loads = side.clips.map((cl) => this.audio.load(this.sync.url(cl.u)));
          if (!this.sync.play('stream') || loads.length < 2) return keep({ side, bufs: await Promise.all(loads) });
          const bufs: AudioBuffer[] = [];
          for (let k = 0; k < loads.length; k++) {
            try { bufs.push(await loads[k]); } catch (e) {
              if (k) keep({ side: { ...side, clips: side.clips.slice(0, k), partial: false }, bufs: bufs.slice() });
              throw e;
            }
            keep({ side: k < loads.length - 1 ? { ...side, clips: side.clips.slice(0, k + 1), partial: true } : side, bufs: bufs.slice() });
          }
        })
        .catch(() => { /* asked again when wanted again */ })
        .finally(() => setTimeout(() => this.loading.delete(path), 3000));
    }
    return r ?? null;
  }

  /** Ask the server to voice a table from this comment on (once per table and comment, renewed every 30 s while wanted). */
  private want(table: number, turn: Turn) {
    const f = this.floor;
    if (!f) return;
    const [ti, from] = this.live(table, turn.id);
    if (ti < 0 || from < 0) return;
    const key = `${f.story.id}:${ti}:${from}`, t = performance.now() / 1000;
    if (t - (this.asked.get(key) ?? -1e9) < 30) return;
    this.asked.set(key, t);
    this.sync.want(f.story.id, ti, from).then((ok) => { if (!ok) this.asked.set(key, t - 25); });
  }
}
