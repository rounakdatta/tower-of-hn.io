// The director: plays a table as a scene. The audio clock is the master clock;
// lips, faces, gestures, subtitles and camera cuts all read from it.
import * as THREE from 'three/webgpu';
import type { LiveSync, Floor, Sidecar, Clip, Turn } from './sync.ts';
import { emoGain, type AudioEngine } from './audio.ts';
import type { Crowd } from './people.ts';
import { FACE, tone, RISE_LEAD, Performer, type Plan } from './performer.ts';
export { FACE };
import type { TableSpot } from './interior.ts';
import type { Rig } from './rig.ts';
import { R, FLOOR_H } from './world.ts';
import type { UI } from './ui.ts';
import type { Room } from './room.ts';

/** How a speaker's face sits for each delivery (the voice moves it from there, syllable by syllable). */

interface Subject { i: number; head: THREE.Vector3; face?: THREE.Vector3; w: number }
/** distance from point c to segment ab, and where along ab (0..1) it is closest */
function segPoint(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): [number, number] {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((c.x - a.x) * abx + (c.y - a.y) * aby + (c.z - a.z) * abz) / (abx * abx + aby * aby + abz * abz || 1)));
  return [Math.hypot(a.x + abx * t - c.x, a.y + aby * t - c.y, a.z + abz * t - c.z), t];
}
/** distance between segment ab and segment (cx,cy,cz)-(dx,dy,dz), and where along ab it is closest (Ericson 5.1.9) */
function segSeg(a: THREE.Vector3, b: THREE.Vector3, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number): [number, number] {
  const d1x = b.x - a.x, d1y = b.y - a.y, d1z = b.z - a.z, d2x = dx - cx, d2y = dy - cy, d2z = dz - cz;
  const rx = a.x - cx, ry = a.y - cy, rz = a.z - cz;
  const A = d1x * d1x + d1y * d1y + d1z * d1z, E = d2x * d2x + d2y * d2y + d2z * d2z, F = d2x * rx + d2y * ry + d2z * rz;
  const C = d1x * rx + d1y * ry + d1z * rz, B = d1x * d2x + d1y * d2y + d1z * d2z, den = A * E - B * B;
  const cl = (x: number) => Math.max(0, Math.min(1, x));
  let s = den > 1e-9 ? cl((B * F - C * E) / den) : 0, t = E > 1e-9 ? (B * s + F) / E : 0;
  if (t < 0) { t = 0; s = cl(-C / A); } else if (t > 1) { t = 1; s = cl((B - C) / A); }
  return [Math.hypot(a.x + d1x * s - cx - d2x * t, a.y + d1y * s - cy - d2y * t, a.z + d1z * s - cz - d2z * t), s];
}

const NO_PLANS = new Map<number, Plan>();
interface Scheduled { clip: Clip; side: Sidecar; turn: Turn; start: number; end: number; who: number; src: AudioScheduledSourceNode }

export class Director {
  floor: Floor | null = null;
  spot: TableSpot | null = null;
  private roomY = 0;
  private turnIdx = 0;
  private cursor = 0;
  private sched: Scheduled[] = [];
  private loading = new Map<string, Promise<{ side: Sidecar; bufs: AudioBuffer[] } | null>>();
  /** clips of turns[turnIdx] already scheduled: a long comment that is still being voiced plays as it arrives */
  private clipsDone = 0;
  private partialId = 0;
  private ready = new Map<number, { side: Sidecar; bufs: AudioBuffer[] }>();
  private asked = new Map<string, number>();       // want key -> when we last asked (demand lapses server-side; renew it)
  private current: Scheduled | null = null;
  private shotUntil = 0;
  private reactionAt = 0;
  /** how this table's people act what's said (shared with every other table in earshot: performer.ts) */
  private perf: Performer | null = null;
  private get plans(): Map<number, Plan> { return this.perf?.plans ?? NO_PLANS; }
  private heroAt = 0;
  private heroWho = -1;
  private heroA = -1;
  private staged = new Set<number>();
  private cutAt = 0;
  private clockNow = 0;
  private flip = 0;
  private flipSide = false;
  /** exposure for the current shot: stopped down when the lens looks up at someone standing under a lamp */
  exposure = 1;
  /** 0..1: how heated the table is right now (the frame closes in) */
  get tension() { return this.perf?.tension ?? 0; }
  /** what the camera is doing, for vibe tests */
  shot = '';
  pushChair: (chair: number, k: number) => void = () => {};
  playing = false;
  /** play the opener, then jump to this comment (deep links) */
  jumpTo = 0;
  /** demos: comments to leave out (?skip=id,id) */
  skipIds = new Set<number>();
  paused = false;
  others: { pos: THREE.Vector3; turns: Turn[] }[] = [];      // other tables on this floor, for the murmur
  private murmurAt = 0;
  onNewReply: (by: string) => void = () => {};
  /** the room's choreography: speakers walk over to this table before they speak (one person per commenter) */
  room: Room | null = null;
  /** the mixer plays the other tables for real: no random murmur on top */
  ambient = false;
  /** the turn the table has got to */
  get turnAt() { return this.turnIdx; }
  /** what's being said at this table right now (for its lamp) */
  get line() { return this.current; }
  /** what's been said at this table (ids): handed back to the room when we stand up */
  get said() { return this.spot ? this.spot.table.turns.slice(0, this.turnIdx).map((u) => u.id) : []; }
  /** comments that arrived live at this table, said next (ids, in the order they came) */
  private breaking: number[] = [];
  onEnd: () => void = () => {};

  constructor(private sync: LiveSync, private audio: AudioEngine, private crowd: Crowd, private rig: Rig, private ui: UI) {}

  /** Play a table from turn `from` (where the room had got to while we stood there). */
  start(floor: Floor, spot: TableSpot, roomY: number, now: number, from = 0) {
    this.stop();
    this.floor = floor; this.spot = spot; this.roomY = roomY;
    this.turnIdx = Math.max(0, Math.min(from, spot.table.turns.length)); this.playing = true; this.paused = false; this.clipsDone = 0; this.waitSince = 0; this.callingSince = 0; this.breaking = [];
    this.perf?.reset();
    this.perf = new Performer(this.crowd, spot, (n) => this.ix(n), (c, k) => this.pushChair(c, k));
    this.heroAt = 0; this.staged.clear();
    this.cursor = this.audio.now() + 1.6;           // let the establishing shot breathe
    for (const s of spot.seats) { const i = this.ix(s.name); if (i >= 0) this.crowd.active.add(i); }
    this.wide(now, true);
    this.shotUntil = now + 2.6;
    this.prefetch();
  }

  stop() {
    for (const s of this.sched) { try { s.src.stop(); } catch { /* already done */ } }
    this.sched = []; this.current = null; this.playing = false;
    this.glances = []; this.events = [];
    this.crowd.settle();
    this.perf?.reset();
    this.ui.subtitle(null); this.ui.placard(null); this.ui.code(null); this.ui.waiting(null);
  }

  /** A newer snapshot of this floor arrived (new turns, or audio became ready). */
  refresh(floor: Floor) {
    if (!this.spot || !this.floor) return;
    this.floor = floor;
    if (this.spot.tableOf) {                         // the bar: one remark from each of several tables
      for (const u of this.spot.table.turns) {
        const ti = this.spot.tableOf.get(u.id);
        const fresh = ti !== undefined ? floor.tables[ti]?.turns.find((x) => x.id === u.id) : undefined;
        if (fresh?.v) u.v = fresh.v;
      }
      this.prefetch();
      return;
    }
    const t = floor.tables.find((x) => x.root === this.spot!.table.root);
    if (!t) return;
    // our order: what we've played (as we played it), the comment in progress, comments that arrived live (said
    // next, as in a real room, in the order they came), then the rest in the thread's order. Taking the server's
    // order instead replayed comments when a late reply landed above them.
    const prev = this.spot.table.turns, playedList = prev.slice(0, this.turnIdx);
    const playedIds = new Set(playedList.map((u) => u.id)), known = new Set(prev.map((u) => u.id));
    const byId = new Map(t.turns.map((u) => [u.id, u]));
    for (const u of t.turns) if (!known.has(u.id)) { this.onNewReply(u.by); this.breaking.push(u.id); }
    const current = this.clipsDone ? byId.get(this.partialId) : undefined;
    if (this.clipsDone && !current) this.clipsDone = 0;
    const head = playedList.map((u) => byId.get(u.id) ?? u);
    const live = this.breaking.map((id) => byId.get(id)).filter((u): u is Turn => !!u && !playedIds.has(u.id) && u !== current);
    const liveIds = new Set(live.map((u) => u.id));
    const rest = t.turns.filter((u) => !playedIds.has(u.id) && !liveIds.has(u.id) && u !== current);
    this.spot.table = { ...t, turns: [...head, ...(current ? [current] : []), ...live, ...rest] };
    this.spot.index = floor.tables.indexOf(t);         // HN reorders threads: asks for voicing must name this one
    this.turnIdx = head.length;
    this.breaking = this.breaking.filter((id) => byId.has(id) && !playedIds.has(id));
    this.prefetch();
  }

  private load(turn: Turn) {
    if (!turn.v) return null;
    const path = turn.v[0];                       // a comment still being voiced gets a new path per clip
    let p = this.loading.get(path);
    if (!p) {
      this.loadingId.set(path, turn.id);
      p = this.sync.sidecar(path).then(async (side) => {
        const bufs = await Promise.all(side.clips.map((c) => this.audio.load(this.sync.url(c.u))));
        const r = { side, bufs }, have = this.ready.get(turn.id);
        if (!have || side.clips.length >= have.side.clips.length) this.ready.set(turn.id, r);
        return r;
      }).catch(() => { setTimeout(() => this.loading.delete(path), 5000); return null; });   // retry, but not every frame
      this.loading.set(path, p);
    }
    return p;
  }

  /** Fetch and decode the next few turns while the current one plays; ask for voicing where missing. */
  private prefetch() {
    if (!this.spot || !this.floor) return;
    const turns = this.spot.table.turns;
    for (let k = this.turnIdx; k < Math.min(turns.length, this.turnIdx + 4); k++) {
      const t = turns[k];
      if (this.skipIds.has(t.id)) continue;
      if (t.v) this.load(t);
      // not voiced yet, or still arriving clip by clip: ask, and keep asking (demand lapses server-side unless renewed)
      if (!t.v || /\.p\d+\.json$/.test(t.v[0])) {
        const server = this.floor.tables[this.spot.index]?.turns.findIndex((u) => u.id === t.id) ?? -1;
        const ti = this.spot.tableOf?.get(t.id) ?? this.spot.index, from = this.spot.tableOf ? 0 : Math.max(0, server);
        const key = `${this.floor.story.id}:${ti}:${from}`, last = this.asked.get(key) ?? -1e9, nowS = performance.now() / 1000;
        if (nowS - last > 30) {
          this.asked.set(key, nowS);
          // refused (the server is starting, or busy): ask again in ~5 s rather than 30
          this.sync.want(this.floor.story.id, ti, from).then((ok) => { if (!ok) this.asked.set(key, performance.now() / 1000 - 25); });
        }
      }
    }
  }

  private glances: { i: number; from: number; until: number; at: THREE.Vector3 }[] = [];
  private events: { at: number; fn: () => void }[] = [];
  private later(at: number, fn: () => void) { this.events.push({ at, fn }); }
  private waitSince = 0;
  private callingSince = 0;
  /** person index for a name, if they're at this table (one person per commenter; people come and go) */
  private ix(name: string) {
    if (!this.spot?.seats.some((s) => s.name === name)) return -1;
    return this.crowd.index(name);
  }

  private personFor(name: string, fallback: string) {
    const i = this.ix(name);
    return i >= 0 ? i : this.ix(fallback);
  }

  /** what a decoded comment is for: its turn (so the ones far behind or ahead can be let go) */
  private loadingId = new Map<string, number>();
  private prunedAt = -1;
  /** Let go of decoded audio away from where we are: a few turns back (gaps, glances), a few ahead (prefetch). */
  private prune() {
    if (!this.spot || this.prunedAt === this.turnIdx) return;
    this.prunedAt = this.turnIdx;
    const keep = new Set(this.spot.table.turns.slice(Math.max(0, this.turnIdx - 3), this.turnIdx + 8).map((u) => u.id));
    for (const id of this.ready.keys()) if (!keep.has(id)) this.ready.delete(id);
    for (const [path, id] of this.loadingId) if (!keep.has(id)) { this.loading.delete(path); this.loadingId.delete(path); }
  }

  private scheduleAhead(now: number) {
    if (!this.spot || this.paused) return;
    this.prune();
    const turns = this.spot.table.turns;
    const at = this.audio.now();
    while (this.cursor - at < 2.5 && this.turnIdx < turns.length) {
      const turn = turns[this.turnIdx];
      if (this.skipIds.has(turn.id)) { this.turnIdx++; this.clipsDone = 0; continue; }
      const r = this.ready.get(turn.id);
      // voicing finished with nothing more to say (its last clip failed, or it had none): the turn is over
      if (r && !r.side.partial && r.side.clips.length <= this.clipsDone) {
        this.clipsDone = 0; this.turnIdx++; this.waitSince = 0; this.ui.waiting(null);
        continue;
      }
      if (!r || r.side.clips.length <= this.clipsDone) {
        this.prefetch();
        if (this.cursor < at) {             // we've run dry: show who we're waiting for
          const i = this.ix(turn.by);
          this.ui.waiting(i >= 0 ? this.crowd.headPos(i) : null);
          // a line still being voiced: after a few seconds the table moves on without it (never mid-comment)
          if (!this.waitSince) this.waitSince = now;
          else if (!this.clipsDone && now - this.waitSince > 4 && turns.slice(this.turnIdx + 1, this.turnIdx + 4).some((u) => this.ready.has(u.id))) {
            this.turnIdx++; this.waitSince = 0; this.ui.waiting(null);
            continue;
          } else if (this.clipsDone && now - this.waitSince > 30) {   // the rest of a comment never came: move on
            this.clipsDone = 0; this.turnIdx++; this.waitSince = 0; this.ui.waiting(null);
            continue;
          }
        }
        return;
      }
      this.waitSince = 0;
      this.ui.waiting(null);
      const fresh = this.clipsDone === 0;
      if (fresh) {
        // audio voiced while HN still showed a placeholder ([delayed]): the real text is being re-voiced; skip it meanwhile
        if (r.side.clips.length === 1 && /^\s*\[(delayed|flagged|dead|deleted|removed)\]\s*$/i.test(r.side.clips[0].t)) {
          if (this.floor && !this.spot.tableOf) this.sync.want(this.floor.story.id, this.spot.index, this.turnIdx);
          this.turnIdx++;
          continue;
        }
        // whoever is about to talk comes to the table first (from another table, or out of the lift): the
        // table waits for them, the camera holding the room
        if (this.room && !this.spot.bar) {
          const here = this.room.callOver(turn.by, this.spot, at);
          if (here === 'coming' || here === 'busy') {
            // (its own timer: waitSince is reset every frame the audio is ready, which kept this escape from firing)
            if (!this.callingSince) this.callingSince = now;
            if (now - this.callingSince > 30) { this.turnIdx++; this.callingSince = 0; continue; }   // they never came
            return;
          }
          this.callingSince = 0;
        }
      }
      let t = fresh ? Math.max(this.cursor + (this.sched.length ? this.gapFor(turn, r.side) : 0), at + 0.08) : Math.max(this.cursor + 0.06, at + 0.08);
      r.side.clips.forEach((clip, k) => {
        if (k < this.clipsDone) return;
        const who = this.personFor(clip.who, turn.by);
        const pos = who >= 0 ? this.crowd.headPos(who) : new THREE.Vector3(this.spot!.pos.x, this.roomY + 1.1, this.spot!.pos.z);
        const src = this.audio.voice(r.bufs[k], t, pos, this.sync.url(clip.u), emoGain(r.side.emotion, r.side.intensity));
        this.sched.push({ clip, side: r.side, turn, start: t, end: t + clip.d, who, src });
        t += clip.d + (k < r.side.clips.length - 1 ? 0.06 : 0);
      });
      this.cursor = t;
      if (this.room) { const sp = this.ix(turn.by); if (sp >= 0) this.room.speaking(sp, t); }   // nobody calls them away mid-sentence
      if (r.side.partial) { this.clipsDone = r.side.clips.length; this.partialId = turn.id; continue; }   // the rest is on its way
      this.clipsDone = 0;
      this.turnIdx++;
      // a deep link into the middle of a long table: the opener for context, then straight to that reply
      if (this.jumpTo && this.turnIdx === 1) {
        const k = turns.findIndex((u) => u.id === this.jumpTo);
        if (k > 1) this.turnIdx = k;
        this.jumpTo = 0;
      }
      this.prefetch();
    }
    if (this.turnIdx >= turns.length && at > this.cursor + 1.2 && this.sched.every((s) => s.end < at)) {
      this.playing = false;
      this.onEnd();
    }
  }

  /** Every few seconds another table's real conversation drifts across the room. */
  private murmur(at: number) {
    if (at < this.murmurAt || !this.others.length) return;
    this.murmurAt = at + 4 + Math.random() * 5;
    const o = this.others[Math.floor(Math.random() * this.others.length)];
    if (Math.random() < 0.3) this.audio.sfxAt('clink', { x: o.pos.x, y: this.roomY + 0.8, z: o.pos.z }, at + 1 + Math.random() * 2);
    const voiced = o.turns.filter((t) => t.v);
    if (!voiced.length) return;
    const t = voiced[Math.floor(Math.random() * voiced.length)];
    this.sync.sidecar(t.v![0]).then((side) => {
      const c = side.clips[Math.floor(Math.random() * side.clips.length)];
      return this.audio.load(this.sync.url(c.u)).then((b) => this.audio.murmur(b, this.audio.now() + 0.05, { x: o.pos.x, y: this.roomY + 1.1, z: o.pos.z }));
    }).catch(() => {});
  }

  update(now: number, dt: number) {
    if (!this.spot || !this.playing) return;
    this.clockNow = now;
    this.scheduleAhead(now);
    if (!this.paused && !this.ambient) this.murmur(this.audio.now());
    const at = this.audio.now();
    this.sched = this.sched.filter((s) => s.end > at - 0.5);
    this.stage(at, now);
    const cur = this.sched.find((s) => at >= s.start && at < s.end) ?? null;
    if (cur !== this.current) {
      this.current = cur;
      if (cur) this.onClip(cur, now);
      else this.ui.subtitle(null);
    }
    // whoever speaks in the next few turns, and how: if they're about to push back, they already doubt it
    const upcoming = new Map<number, string>();
    for (let k = this.turnIdx; k < Math.min(this.turnIdx + 3, this.spot.table.turns.length); k++) {
      const t = this.spot.table.turns[k], r = this.ready.get(t.id), i = this.ix(t.by);
      if (r && i >= 0 && !upcoming.has(i)) upcoming.set(i, tone(r.side).ST);
    }
    this.perf!.animate(this.sched, cur, at, dt, { upcoming, onCamera: this.onCamera, cam: this.rig.pos });
    this.perf!.chairs();
    this.glancing(now);
    if (this.heroAt && now > this.heroAt) {
      this.heroAt = 0;
      this.hero(this.heroWho, this.heroA);
      // after a few seconds of the speaker on their feet, the one on the receiving end
      this.reactionAt = cur && cur.end - at > 5 ? now + 2.8 : 0;
      return;
    }
    // a cutaway to a listener in the middle of a long clip, then back
    if (cur && this.reactionAt && now > this.reactionAt) {
      this.reactionAt = 0;
      const listeners = this.spot.seats.map((s) => this.ix(s.name)).filter((i) => i >= 0 && i !== cur.who);
      if (listeners.length) {
        const replyTo = cur.turn.replyTo ? this.perf!.authorOf(cur.turn.replyTo) : undefined;
        const li = replyTo !== undefined && listeners.includes(replyTo) ? replyTo : listeners[Math.floor(Math.random() * listeners.length)];
        const standing = this.crowd.people[cur.who]?.expr.stand > 0.5;
        if (standing) this.overShoulder(cur.who, li, -0.22, 0.92);   // looking down at them, past the shoulder of the one standing over them
        else this.single(li);
        this.shotUntil = now + 2.2;
      }
    } else if (cur && this.shotUntil && now > this.shotUntil) {
      this.shotUntil = 0;
      const p = this.plans.get(cur.turn.id);
      this.speakerShot(cur.who, !!p?.gesture && at - p.start < p.gestureLen);
    }
  }

  /** Silence before a turn: a heated reply cuts straight in, a joke gets its laugh, a question its quick answer. */
  private gapFor(turn: Turn, side: Sidecar) {
    const base = turn.gapMs / 1000, me = tone(side);
    const prevId = this.spot!.table.turns[this.turnIdx - 1]?.id, prev = prevId !== undefined ? this.ready.get(prevId) : undefined;
    const before = prev ? tone(prev.side) : null;
    if ((me.E === 'angry' && me.I >= 0.45) || (me.I >= 0.82 && (me.ST === 'disagree' || me.ST === 'correct'))) return Math.min(base, 0.04);
    if (me.ST === 'retort') return Math.min(base, 0.12);                 // a comeback doesn't wait its turn
    if (before && (before.ST === 'joke' || before.C.includes('joke'))) return base + 0.5;
    if (before && (before.ST === 'question' || before.C.includes('question')) && turn.replyTo === prevId) return base * 0.6;
    return base;
  }

  /** A heated reply is coming: be on a two-shot before they rise, so the stand-up is seen; then the hero angle. */
  private stage(at: number, now: number) {
    const up = this.sched.find((x) => x.start > at && x.start - at < 1.05 && x.side.clips[0] === x.clip && !this.staged.has(x.turn.id));
    if (!up) return;
    this.staged.add(up.turn.id);
    const plan = this.perf!.plan(up, this.sched);
    if (!plan.stand) return;
    this.riseShot(plan.S, plan.A);
    this.heroAt = now + (up.start - at) + 1.25; this.heroWho = plan.S; this.heroA = plan.A;
    this.shotUntil = 0; this.reactionAt = 0;
    const seat = this.spot!.seats.find((x) => x.name === this.crowd.people[plan.S].name);
    if (seat) this.audio.sfxAt('chair', { x: seat.pos.x, y: this.roomY + 0.4, z: seat.pos.z }, up.start - RISE_LEAD + 0.05);
    // palms hit the table as they push up (a heavy one, if they're furious): sound, and the lens feels it
    const push = up.start - at - RISE_LEAD + 0.3;
    if (plan.I >= 0.6) {
      this.audio.sfxAt('thump', { x: this.spot!.pos.x, y: this.roomY + 0.76, z: this.spot!.pos.z }, up.start - RISE_LEAD + 0.3);
      this.later(now + push, () => this.rig.shake(0.006 + plan.I * 0.008, 0.4));
    }
    // and the room turns to look: nearest tables first, a ripple outwards
    const riser = this.crowd.headPos(plan.S).add(new THREE.Vector3(0, 0.3, 0));
    const here = new Set(this.spot!.seats.map((st) => this.ix(st.name)));
    for (let j = 0; j < this.crowd.people.length; j++) {
      if (here.has(j) || this.crowd.seed(j, 11) > 0.72 || this.glances.some((g) => g.i === j)) continue;
      const d = this.crowd.headPos(j).distanceTo(riser);
      if (d > 7) continue;
      const from = now + push + 0.15 + d * 0.11 + this.crowd.seed(j, 12) * 0.5;
      this.glances.push({ i: j, from, until: from + 2.4 + this.crowd.seed(j, 13) * 2.2, at: riser });
      this.crowd.active.add(j);
    }
  }


  private onClip(s: Scheduled, now: number) {
    const name = s.clip.who;
    const look = this.crowd.people[s.who]?.look;
    const to = s.clip.who === s.turn.by && s.turn.replyTo ? this.spot?.table.turns.find((u) => u.id === s.turn.replyTo)?.by : undefined;
    this.ui.subtitle({ name, to, text: s.clip.t, color: look ? `#${look.outfit.clone().lerp(new THREE.Color(1, 1, 1), 0.45).getHexString()}` : '#ff9a3c', emotion: s.side.emotion, stance: s.side.stance, intensity: s.side.intensity });
    const link = s.side.links.find((l) => l.url === s.clip.t);
    this.ui.placard(link ? { url: link.url, domain: link.domain, at: this.crowd.headPos(s.who) } : null);
    this.ui.code(s.side.code.find((c) => c.startsWith(s.clip.t.slice(0, 40))) ?? null);
    // pick a shot
    const first = s.side.clips[0] === s.clip;
    const plan = this.perf!.plan(s, this.sched);
    if (first && plan.stand) {
      if (!this.heroAt) {                       // staged too late (audio arrived just in time): stage it now
        this.riseShot(plan.S, plan.A);
        this.heroAt = now + 1.25; this.heroWho = plan.S; this.heroA = plan.A;
      }
      this.shotUntil = 0; this.reactionAt = 0;
      return;
    }
    if (this.heroAt) return;                    // the stand-up is still playing out
    if (now < this.shotUntil && first && this.sched.indexOf(s) === 0) return;          // the establishing shot is still running
    if (s.who < 0) {                            // said from the table by someone the full room couldn't let in: hold the table
      if (first) { this.wide(now); this.shotUntil = now + 2.4; }
      this.reactionAt = 0;
      return;
    }
    const replyTo = s.turn.replyTo ? this.perf!.authorOf(s.turn.replyTo) : undefined;
    const turnNo = this.spot!.table.turns.indexOf(s.turn);
    if (first && turnNo > 0 && turnNo % 5 === 0) { this.wide(now); this.shotUntil = now + 2.4; }
    else if (first && replyTo !== undefined && replyTo >= 0 && replyTo !== s.who && Math.random() < 0.6) { this.overShoulder(replyTo, s.who); this.shotUntil = 0; }
    else {
      const prev = this.sched[this.sched.indexOf(s) - 1];
      if (first || !prev || prev.who !== s.who) { this.speakerShot(s.who, first && !!plan.gesture); this.shotUntil = 0; }
      else if (now - this.cutAt > 6) {
        // a long monologue: a fresh angle on them, or a look at whoever they're talking to
        if (++this.flip % 2) { this.flipSide = !this.flipSide; this.speakerShot(s.who, this.flip % 4 === 1); }
        else { this.reactionAt = now + 0.01; return; }
      }
    }
    this.reactionAt = s.end - s.start > 7 ? now + (s.end - s.start) * 0.55 : 0;
  }

  // ---------------------------------------------------------------- performance: blocking, gestures, reactions
  /** Each turn gets a plan: who performs it, to whom, whether they stand, their signature gesture. */
  /** Everyone else in the room: heads turn toward a commotion, then drift back to their own table. */
  private glancing(now: number) {
    for (let k = this.events.length - 1; k >= 0; k--) if (this.events[k].at <= now) this.events.splice(k, 1)[0].fn();
    this.glances = this.glances.filter((g) => {
      const t = this.crowd.target(g.i);
      if (!t) return false;
      if (now >= g.from && now < g.until) {
        t.yaw = this.crowd.yawTo(g.i, g.at); t.nod = this.crowd.pitchTo(g.i, g.at); t.brow = 0.4; t.lid = 1.12;
        t.gaze = Math.max(-1, Math.min(1, t.yaw * 0.5)); t.gazeY = Math.max(-1, Math.min(1, -t.nod * 0.35));
      } else if (now >= g.until) { t.yaw = 0; t.nod = 0; t.brow = 0; t.lid = 1; t.gaze = 0; t.gazeY = 0; }
      if (now > g.until + 2) { this.crowd.release(g.i); return false; }
      return true;
    });
  }


  // ---------------------------------------------------------------- shots: a small virtual cinematographer
  private center() { return new THREE.Vector3(this.spot!.pos.x, this.roomY, this.spot!.pos.z); }

  /** Where person i's face is about to point (body turn plus head yaw), flat. */
  private faceDir(i: number) {
    const p = this.crowd.people[i], t = p.target;
    const a = p.pose.facing + t.turn + Math.max(-1.1, Math.min(1.1, t.yaw));
    return new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
  }

  /**
   * How good is a camera at p for these subjects? -Infinity if it sits inside someone, the table or the walls.
   * Everyone is a capsule (seat or floor to neck) plus a head; anything between the lens and a subject's face
   * costs, so does a big blurry head right in front of the lens, and so does seeing a subject from behind.
   */
  private score(p: THREE.Vector3, subjects: Subject[], near: Set<number>, fov: number) {
    const Y0 = this.roomY;
    if (p.x * p.x + p.z * p.z > (R - 0.35) ** 2 || p.y > Y0 + FLOOR_H * 0.88 || p.y < Y0 + 0.55) return -Infinity;
    const tp = this.spot!.pos, tr = this.spot!.bar ? 0 : this.spot!.radius;
    const tx = p.x - tp.x, tz = p.z - tp.z;
    if (tr && tx * tx + tz * tz < (tr + 0.1) ** 2 && p.y < Y0 + 0.88) return -Infinity;
    let sc = 0;
    const look = new THREE.Vector3();
    for (const s of subjects) look.add(s.head);
    look.divideScalar(subjects.length).sub(p).normalize();
    const half = this.rig.halfWidth(fov);                                 // half the horizontal field of view, as the rig will set it
    const h = this.tmp;
    for (const j of this.nearby) {
      this.crowd.headPos(j, h);
      const per = this.crowd.people[j];
      const bottom = Y0 + (per.pose.seated ? 0.42 * (1 - per.expr.stand) : 0), neck = h.y - 0.2;
      const dh = p.distanceTo(h);
      const ay = Math.max(bottom, Math.min(neck, p.y)), da = Math.hypot(p.x - h.x, p.y - ay, p.z - h.z);
      if (near.has(j)) {
        if (dh < 0.4 || da < 0.33) return -Infinity;
        const subj = subjects.some((s) => s.i === j);
        if (dh < 0.95 && subj) return -Infinity;     // too close to the subject: their hands fill the lens
        // an over-the-shoulder: the shoulder belongs at the edge of the frame, not across a third of it
        if (!subj && dh < 1.2) {
          const ang = Math.acos(Math.max(-1, Math.min(1, h.clone().sub(p).divideScalar(dh).dot(look)))), rad = Math.asin(Math.min(1, 0.27 / dh));
          sc -= (1.2 - dh) * 2.2 * Math.max(0, Math.min(1, (half * 0.75 + rad - ang) / (2 * rad)));
        }
      }
      else {
        if (dh < 0.5 || da < 0.45) return -Infinity;
        // a big out-of-focus head near the lens: how much of it is in the picture, and how close
        if (dh < 1.7) {
          const ang = Math.acos(Math.max(-1, Math.min(1, h.clone().sub(p).divideScalar(dh).dot(look)))), rad = Math.asin(Math.min(1, 0.27 / dh));
          const inFrame = Math.max(0, Math.min(1, (half + rad - ang) / (2 * rad)));
          if (inFrame > 0) sc -= (1.7 - dh) * 4.5 * inFrame;
        }
      }
      for (const s of subjects) {
        if (s.i === j) continue;
        const [d1, t1] = segPoint(p, s.head, h);
        if (t1 < 0.93 && d1 < 0.3) sc -= (0.3 - d1) * 14 * s.w;
        const [d2, t2] = segSeg(p, s.head, h.x, bottom, h.z, h.x, neck, h.z);
        if (t2 < 0.93 && d2 < 0.25) sc -= ((0.25 - d2) * 8 + 0.6) * s.w;
      }
    }
    for (const s of subjects) {
      // the sightline must clear the tabletop
      if (tr && p.y < Y0 + 0.8) {
        const k = (Y0 + 0.8 - p.y) / (s.head.y - p.y), x = p.x + (s.head.x - p.x) * k - tp.x, z = p.z + (s.head.z - p.z) * k - tp.z;
        if (k > 0 && k < 1 && x * x + z * z < tr * tr) sc -= 4 * s.w;
      }
      if (s.face) {
        // the face is small on a big round head: past ~55° it reads as a profile, so aim for ~22° off the nose.
        // the one in shot cheats toward the lens (see animate), so count their face as turned that much further
        const v = p.clone().sub(s.head).setY(0).normalize(), raw = Math.acos(Math.max(-1, Math.min(1, v.dot(s.face))));
        const d = Math.cos(s === subjects[0] && s.i >= 0 && raw < 1.5 ? raw - Math.min(0.5, raw * 0.4) : raw);
        if (d < 0.55) sc -= (0.55 - d) * 9 * s.w;
        sc -= Math.abs(d - 0.93) * 1.6 * s.w;
      }
    }
    return sc;
  }
  private tmp = new THREE.Vector3();
  private nearby: number[] = [];
  /** who the current shot is on (they cheat their face toward the lens) */
  private onCamera = -1;

  /** Try angles, distances and heights around a preferred direction; cut (or glide) to the best. */
  private frame(target: THREE.Vector3, dir: THREE.Vector3, dist: number, lift: number, fov: number, subjects: Subject[], near: Set<number>,
    o: { glide?: number; now?: number; dry?: boolean; name?: string; exposure?: number } = {}): number {
    let best: THREE.Vector3 | null = null, bestScore = -Infinity;
    const Y = new THREE.Vector3(0, 1, 0);
    // only people near the shot can block it or crowd the lens (a floor can hold 200): find them once per shot
    const reach = dist * 1.45 + 2, hp = new THREE.Vector3();
    this.nearby = [];
    for (let j = 0; j < this.crowd.people.length; j++) {
      this.crowd.headPos(j, hp);
      if (Math.hypot(hp.x - target.x, hp.z - target.z) < reach || subjects.some((s) => s.i === j)) this.nearby.push(j);
    }
    for (const a of [0, 0.3, -0.3, 0.6, -0.6, 0.95, -0.95, 1.3, -1.3]) {
      for (const m of [1, 0.85, 1.2, 0.7, 1.45]) {
        for (const h of [lift, lift + 0.22, lift - 0.12]) {
          const p = target.clone().add(dir.clone().applyAxisAngle(Y, a).multiplyScalar(dist * m)).setY(target.y + h);
          const sc = this.score(p, subjects, near, fov) - Math.abs(a) * 0.9 - Math.abs(m - 1) * 0.6 - Math.abs(h - lift) * 0.5;
          if (sc > bestScore) { bestScore = sc; best = p; }
        }
      }
    }
    if (o.dry) return bestScore;
    if (!best) best = target.clone().add(dir.clone().multiplyScalar(dist)).setY(target.y + lift);
    this.rig.fovTarget = fov;
    this.exposure = o.exposure ?? 1;
    this.onCamera = subjects[0]?.i ?? -1;
    if (o.glide) this.rig.glide(best, target, o.glide, o.now ?? 0, 0.2, 0); else this.rig.cut(best, target, 0.12);
    this.cutAt = this.clockNow;
    this.shot = `${o.name ?? 'shot'} ${bestScore.toFixed(1)}`;
    return bestScore;
  }

  private subject(i: number, w = 1): Subject { return { i, head: this.crowd.headPos(i), face: this.faceDir(i), w }; }
  /** portrait: no over-the-shoulder shots (the shoulder would fill a narrow frame), more singles */
  private get tall() { return this.rig.camera.aspect < 0.8; }

  private wide(now: number, glide = false) {
    if (!this.spot) return;
    const c = this.center();
    // stand between the table and the middle of the room, looking out: the city glows behind them
    const inward = new THREE.Vector3(-c.x, 0, -c.z);
    if (inward.lengthSq() < 0.04) inward.set(0, 0, 1);
    inward.normalize();
    const target = c.clone().setY(this.roomY + 0.95);
    this.frame(target, inward, this.spot.radius * 2 + 1.9, 0.85, 52, [{ i: -1, head: target, w: 0.3 }], new Set(), { glide: glide ? 2.2 : 0, now, name: 'wide' });
  }

  /** A close single on someone's face, from the open side of the table. */
  private single(i: number, medium = false) {
    if (!this.spot || i < 0) return;
    const s = this.subject(i), target = s.head.clone().add(new THREE.Vector3(0, medium ? -0.05 : -0.02, 0));
    // from the open middle of the table, a little toward where they look: a 3/4 face, never between them and
    // whoever they're talking to (that's where their hands go)
    const toC = this.spot.bar ? s.face!.clone() : this.center().sub(s.head).setY(0).normalize();
    const base = s.face!.clone().add(toC.multiplyScalar(0.4)).normalize();
    // a close-up for faces; a medium shot (head, hands, the table edge) when they're about to gesture
    const [dist, lift, fov, name] = medium ? [1.5, 0.06, 40, 'medium'] : [1.35, 0.04, 31, 'single'];
    const near = new Set([i]), Y = new THREE.Vector3(0, 1, 0);
    // the side we'd like (alternating, for variety), unless the other side is clearly the better picture
    const want = (i % 2 ? 0.22 : -0.22) * (this.flipSide ? -1 : 1);
    const a = this.frame(target, base.clone().applyAxisAngle(Y, want), dist, lift, fov, [s], near, { dry: true });
    const b = this.frame(target, base.clone().applyAxisAngle(Y, -want), dist, lift, fov, [s], near, { dry: true });
    this.frame(target, base.applyAxisAngle(Y, a >= b - 0.6 ? want : -want), dist, lift, fov, [s], near, { name: `${name} ${this.crowd.people[i].name}` });
  }

  /** Low and a little wide: someone stood up to make their point (at `a`, if anyone in particular). */
  private hero(i: number, a = -1) {
    if (!this.spot || i < 0 || !this.crowd.people[i]) return;
    const s = this.subject(i), name = `hero ${this.crowd.people[i].name}`;
    const toC = this.center().sub(s.head).setY(0).normalize();
    const target = s.head.clone().add(new THREE.Vector3(0, -0.15, 0));      // the face sits a little above centre, arms in shot
    if (a >= 0 && this.crowd.people[a]) {
      const sa = this.subject(a, 0.6), toA = sa.head.clone().sub(s.head).setY(0), dA = toA.length();
      toA.normalize();
      // best, when they're close: from just behind the one being told off, at their eye level, looking up at the one
      // standing over them (from across the table that would be a crowd shot: the POV below is better there)
      const lift = sa.head.y + 0.1 - target.y, near = new Set([i, a]);
      if (dA < 1.5 && !this.tall && this.frame(target, toA, dA + 0.6, lift, 42, [s], near, { dry: true }) > -1.6) {
        this.frame(target, toA, dA + 0.6, lift, 42, [s], near, { name: name + ' ots', exposure: 0.9 });
        return;
      }
      // glaring across the table: we sit nearly where they do, taking the heat
      if (dA >= 1.5 || toA.dot(toC) > 0.5) { this.frame(target, toA, Math.min(1.6, dA * 0.62), -0.3, 46, [s], new Set([i]), { name: name + ' pov', exposure: 0.9 }); return; }
      // glaring at a neighbour: both of them, low, from the middle of the table, the one standing bigger
      target.x += (sa.head.x - target.x) * 0.3; target.z += (sa.head.z - target.z) * 0.3;
      this.frame(target, toC, 1.6, -0.3, 50, [s, sa], new Set([i, a]), { name: name + ' two', exposure: 0.9 });
      return;
    }
    // between where they glare and the middle of the table: a 3/4 face
    this.frame(target, s.face!.clone().add(toC).normalize(), 1.6, -0.3, 46, [s], new Set([i]), { name, exposure: 0.9 });
  }

  /** Someone is about to get up: a medium shot from across the table, wide enough to see them rise, with the one they answer in frame. */
  private riseShot(a: number, b: number) {
    if (!this.spot || a < 0) return;
    const sa = this.subject(a), subjects = [sa];
    const toC = this.center().sub(sa.head).setY(0).normalize();
    const target = sa.head.clone();
    target.y += 0.14;                                    // where their head will be halfway up
    if (b >= 0) {
      const sb = this.subject(b, 0.4);
      subjects.push(sb);
      target.x += (sb.head.x - target.x) * 0.25; target.z += (sb.head.z - target.z) * 0.25;
    }
    const n = this.crowd.people[a].name + (b >= 0 ? '+' + this.crowd.people[b].name : '');
    const near = new Set(b >= 0 ? [a, b] : [a]);
    if (this.frame(target, toC, 1.55, 0.06, 54, subjects, near, { dry: true }) > -2) {
      this.frame(target, toC, 1.55, 0.06, 54, subjects, near, { name: `rise ${n}`, exposure: 0.94 });
      return;
    }
    // a crowded table: just them, framed high enough to watch them come up into it
    const solo = this.subject(a), up = solo.head.clone().add(new THREE.Vector3(0, 0.1, 0));
    const dir = solo.face!.clone().add(toC.multiplyScalar(0.4)).normalize();
    this.frame(up, dir, 1.6, 0.0, 48, [solo], new Set([a]), { name: `rise ${this.crowd.people[a].name} solo`, exposure: 0.94 });
  }

  /** Over the shoulder of `over`, onto `at`'s face. A blocked one is worse than a clean single. */
  private overShoulder(over: number, at: number, lift = 0.18, exposure = 1) {
    const ho = this.crowd.headPos(over), sa = this.subject(at);
    const back = ho.clone().sub(sa.head).setY(0);
    const d = back.length();
    back.normalize();
    const target = sa.head.clone().add(new THREE.Vector3(0, -0.04, 0));
    const dir = back.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.22), near = new Set([over, at]);
    const h = ho.y - target.y + lift;
    if (this.tall || this.frame(target, dir, d + 0.7, h, 34, [sa], near, { dry: true }) < -1.2) { this.single(at); return; }
    this.frame(target, dir, d + 0.7, h, 34, [sa], near, { name: `ots ${this.crowd.people[over].name}>${this.crowd.people[at].name}`, exposure });
  }

  /** Whoever is talking: a hero angle if they're on their feet, a single if not. */
  private speakerShot(i: number, medium = false) {
    if (i >= 0 && this.crowd.people[i]?.pose.seated && this.crowd.people[i].expr.stand > 0.5) {
      const p = this.current ? this.plans.get(this.current.turn.id) : undefined;
      this.hero(i, p && p.S === i ? p.A : -1);
      return;
    }
    // coming back to the same speaker: a different side and size each time, so a long comment never sits still
    const turn = this.current?.turn.id ?? -1;
    this.variant = turn === this.variantTurn ? this.variant + 1 : 0;
    this.variantTurn = turn;
    if (this.variant) this.flipSide = !this.flipSide;
    this.single(i, medium || this.variant % 2 === 1);
  }
  private variant = 0;
  private variantTurn = -1;

  /** the whole timeline so far, for muxing recorded videos */
  timeline() { return this.audio.log; }

  togglePause() {
    const ctx = this.audio.ctx;
    if (!ctx) return;
    this.paused = !this.paused;
    this.waitSince = 0;                              // a pause is not a wait: never skip a line because of one
    if (this.paused) ctx.suspend(); else ctx.resume();
  }
}
