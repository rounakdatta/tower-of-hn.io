// The director: plays a table as a scene. The audio clock is the master clock;
// lips, faces, gestures, subtitles and camera cuts all read from it.
import * as THREE from 'three/webgpu';
import type { LiveSync, Floor, Sidecar, Clip, Turn } from './sync.ts';
import type { AudioEngine } from './audio.ts';
import type { Crowd, Expr } from './people.ts';
import type { TableSpot } from './interior.ts';
import type { Rig } from './rig.ts';
import { R, FLOOR_H } from './world.ts';
import type { UI } from './ui.ts';

const FACE: Record<string, Partial<Expr>> = {
  angry: { brow: -0.85, smile: -0.45, lid: 0.82, lean: 0.6 },
  stern: { brow: -0.5, smile: -0.15, lid: 0.9, lean: 0.35 },
  contemplative: { brow: 0.18, smile: 0.05, lid: 0.82 },
  excited: { brow: 0.55, smile: 0.65, lid: 1.15, lean: 0.4 },
  joyful: { brow: 0.3, smile: 0.9, lid: 0.95 },
  mundane: { brow: 0, smile: 0.15, lid: 1 },
  nervous: { brow: 0.4, smile: -0.05, lid: 1.12 },
  sad: { brow: 0.3, smile: -0.55, lid: 0.8 },
  surprised: { brow: 0.95, smile: 0.1, lid: 1.32 },
  tender: { brow: 0.2, smile: 0.5, lid: 0.9 },
};

interface Scheduled { clip: Clip; side: Sidecar; turn: Turn; start: number; end: number; who: number; src: AudioScheduledSourceNode }

export class Director {
  floor: Floor | null = null;
  spot: TableSpot | null = null;
  private roomY = 0;
  private turnIdx = 0;
  private cursor = 0;
  private sched: Scheduled[] = [];
  private loading = new Map<number, Promise<{ side: Sidecar; bufs: AudioBuffer[] } | null>>();
  private ready = new Map<number, { side: Sidecar; bufs: AudioBuffer[] }>();
  private asked = new Set<string>();
  private current: Scheduled | null = null;
  private shotUntil = 0;
  private reactionAt = 0;
  private gesture = new Map<number, number>();
  playing = false;
  paused = false;
  others: { pos: THREE.Vector3; turns: Turn[] }[] = [];      // other tables on this floor, for the murmur
  private murmurAt = 0;
  onNewReply: (by: string) => void = () => {};
  onEnd: () => void = () => {};

  constructor(private sync: LiveSync, private audio: AudioEngine, private crowd: Crowd, private rig: Rig, private ui: UI) {}

  start(floor: Floor, spot: TableSpot, roomY: number, now: number) {
    this.stop();
    this.floor = floor; this.spot = spot; this.roomY = roomY;
    this.turnIdx = 0; this.playing = true; this.paused = false;
    this.cursor = this.audio.now() + 1.6;           // let the establishing shot breathe
    for (const s of spot.seats) { const i = this.crowd.index(s.name); if (i >= 0) this.crowd.active.add(i); }
    this.wide(now, true);
    this.shotUntil = now + 2.6;
    this.prefetch();
  }

  stop() {
    for (const s of this.sched) { try { s.src.stop(); } catch { /* already done */ } }
    this.sched = []; this.current = null; this.playing = false;
    this.crowd.settle();
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
    const played = new Set(this.spot.table.turns.slice(0, this.turnIdx).map((u) => u.id));
    this.spot.table = t;
    // keep our place: the first turn we haven't scheduled yet (late replies slot in here)
    const known = new Set(this.spot.table.turns.map((u) => u.id));
    for (const u of t.turns) if (!known.has(u.id)) this.onNewReply(u.by);
    this.turnIdx = t.turns.findIndex((u) => !played.has(u.id));
    if (this.turnIdx < 0) this.turnIdx = t.turns.length;
    this.prefetch();
  }

  private load(turn: Turn) {
    if (!turn.v) return null;
    let p = this.loading.get(turn.id);
    if (!p) {
      p = this.sync.sidecar(turn.v[0]).then(async (side) => {
        const bufs = await Promise.all(side.clips.map((c) => this.audio.load(this.sync.url(c.u))));
        const r = { side, bufs };
        this.ready.set(turn.id, r);
        return r;
      }).catch(() => null);
      this.loading.set(turn.id, p);
    }
    return p;
  }

  /** Fetch and decode the next few turns while the current one plays; ask for voicing where missing. */
  private prefetch() {
    if (!this.spot || !this.floor) return;
    const turns = this.spot.table.turns;
    for (let k = this.turnIdx; k < Math.min(turns.length, this.turnIdx + 4); k++) {
      const t = turns[k];
      if (t.v) this.load(t);
      else {
        const ti = this.spot.tableOf?.get(t.id) ?? this.spot.index, from = this.spot.tableOf ? 0 : k;
        const key = `${this.floor.story.id}:${ti}:${from}`;
        if (!this.asked.has(key)) { this.asked.add(key); this.sync.want(this.floor.story.id, ti, from); }
      }
    }
  }

  private personFor(name: string, fallback: string) {
    const i = this.crowd.index(name);
    return i >= 0 ? i : this.crowd.index(fallback);
  }

  private scheduleAhead(now: number) {
    if (!this.spot || this.paused) return;
    const turns = this.spot.table.turns;
    const at = this.audio.now();
    while (this.cursor - at < 2.5 && this.turnIdx < turns.length) {
      const turn = turns[this.turnIdx];
      const r = this.ready.get(turn.id);
      if (!r) {
        this.prefetch();
        if (this.cursor < at) {             // we've run dry: show who we're waiting for
          const i = this.crowd.index(turn.by);
          this.ui.waiting(i >= 0 ? this.crowd.headPos(i) : null);
        }
        return;
      }
      this.ui.waiting(null);
      let t = Math.max(this.cursor + (this.sched.length ? turn.gapMs / 1000 : 0), at + 0.08);
      r.side.clips.forEach((clip, k) => {
        const who = this.personFor(clip.who, turn.by);
        const pos = who >= 0 ? this.crowd.headPos(who) : new THREE.Vector3(this.spot!.pos.x, this.roomY + 1.1, this.spot!.pos.z);
        const src = this.audio.voice(r.bufs[k], t, pos, this.sync.url(clip.u));
        this.sched.push({ clip, side: r.side, turn, start: t, end: t + clip.d, who, src });
        t += clip.d + (k < r.side.clips.length - 1 ? 0.12 : 0);
      });
      this.cursor = t;
      this.turnIdx++;
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
    this.scheduleAhead(now);
    if (!this.paused) this.murmur(this.audio.now());
    const at = this.audio.now();
    this.sched = this.sched.filter((s) => s.end > at - 0.5);
    const cur = this.sched.find((s) => at >= s.start && at < s.end) ?? null;
    if (cur !== this.current) {
      this.current = cur;
      if (cur) this.onClip(cur, now);
      else this.ui.subtitle(null);
    }
    this.animate(cur, at, now, dt);
    // a cutaway to a listener in the middle of a long clip, then back
    if (cur && this.reactionAt && now > this.reactionAt) {
      this.reactionAt = 0;
      const listeners = this.spot.seats.map((s) => this.crowd.index(s.name)).filter((i) => i >= 0 && i !== cur.who);
      if (listeners.length) {
        const replyTo = cur.turn.replyTo ? this.authorOf(cur.turn.replyTo) : undefined;
        const li = replyTo !== undefined && listeners.includes(replyTo) ? replyTo : listeners[Math.floor(Math.random() * listeners.length)];
        this.single(li, cur.who, now);
        this.shotUntil = now + 2.2;
      }
    } else if (cur && this.shotUntil && now > this.shotUntil) {
      this.shotUntil = 0;
      this.single(cur.who, -1, now);
    }
  }

  private authorOf(id: number) {
    const t = this.spot?.table.turns.find((u) => u.id === id);
    return t ? this.crowd.index(t.by) : undefined;
  }

  private onClip(s: Scheduled, now: number) {
    const name = s.clip.who;
    const look = this.crowd.people[s.who]?.look;
    const to = s.clip.who === s.turn.by && s.turn.replyTo ? this.spot?.table.turns.find((u) => u.id === s.turn.replyTo)?.by : undefined;
    this.ui.subtitle({ name, to, text: s.clip.t, color: look ? `#${look.outfit.clone().lerp(new THREE.Color(1, 1, 1), 0.45).getHexString()}` : '#ff9a3c', emotion: s.side.emotion });
    const link = s.side.links.find((l) => l.url === s.clip.t);
    this.ui.placard(link ? { url: link.url, domain: link.domain, at: this.crowd.headPos(s.who) } : null);
    this.ui.code(s.side.code.find((c) => c.startsWith(s.clip.t.slice(0, 40))) ?? null);
    // pick a shot
    const first = s.side.clips[0] === s.clip;
    if (now < this.shotUntil && first && this.sched.indexOf(s) === 0) return;          // the establishing shot is still running
    const replyTo = s.turn.replyTo ? this.authorOf(s.turn.replyTo) : undefined;
    const turnNo = this.spot!.table.turns.indexOf(s.turn);
    if (first && turnNo > 0 && turnNo % 5 === 0) { this.wide(now); this.shotUntil = now + 2.4; }
    else if (first && replyTo !== undefined && replyTo >= 0 && replyTo !== s.who && Math.random() < 0.6) { this.overShoulder(replyTo, s.who, now); this.shotUntil = 0; }
    else {
      const prev = this.sched[this.sched.indexOf(s) - 1];
      if (first || !prev || prev.who !== s.who) { this.single(s.who, -1, now); this.shotUntil = 0; }
    }
    this.reactionAt = s.end - s.start > 7 ? now + (s.end - s.start) * 0.55 : 0;
  }

  // ---------------------------------------------------------------- performance
  private animate(cur: Scheduled | null, at: number, now: number, dt: number) {
    if (!this.spot) return;
    const speaker = cur?.who ?? -1;
    const sp = speaker >= 0 ? this.crowd.headPos(speaker) : null;
    const env = cur ? (cur.clip.env[Math.floor((at - cur.start) * 30)] ?? 0) / 255 : 0;
    const shape = cur ? ((cur.clip.shape[Math.floor((at - cur.start) * 30)] ?? 127) / 127.5 - 1) : 0;
    const emo = FACE[cur?.side.emotion ?? 'mundane'] ?? FACE.mundane;
    const stance = cur?.side.stance ?? 'inform';
    const replyTo = cur?.turn.replyTo ? this.authorOf(cur.turn.replyTo) : undefined;
    // who speaks next? if their reply disagrees, they're already frowning
    const upcoming = new Map<number, string>();
    for (let k = this.turnIdx; k < Math.min(this.turnIdx + 3, this.spot.table.turns.length); k++) {
      const t = this.spot.table.turns[k], r = this.ready.get(t.id), i = this.crowd.index(t.by);
      if (r && i >= 0 && !upcoming.has(i)) upcoming.set(i, r.side.stance);
    }
    for (const seat of this.spot.seats) {
      const i = this.crowd.index(seat.name);
      const t = this.crowd.target(i);
      if (!t) continue;
      if (i === speaker) {
        t.open = Math.min(1, env * 1.15);
        t.shape = shape;
        t.brow = (emo.brow ?? 0) + env * 0.15;
        t.smile = emo.smile ?? 0.15;
        t.lid = emo.lid ?? 1;
        t.lean = (emo.lean ?? 0.15) + env * 0.1;
        t.nod = Math.sin(at * 7.3) * env * 0.18;
        // look at whoever they are answering, otherwise around the table
        const look = replyTo !== undefined && replyTo >= 0 && replyTo !== i ? this.crowd.headPos(replyTo) : null;
        t.yaw = look ? this.crowd.yawTo(i, look) : Math.sin(at * 0.35 + i) * 0.45;
        // beat gestures on loud syllables
        const g = this.gesture.get(i) ?? 0;
        if (env > 0.72 && g < 0.15) this.gesture.set(i, 1);
        const gv = Math.max(0, g - dt * 1.8);
        this.gesture.set(i, gv);
        const side = this.crowd.seed(i, Math.floor(at * 0.5)) > 0.5;
        t.armR = side ? gv * 0.9 : gv * 0.25; t.armL = side ? gv * 0.25 : gv * 0.9;
      } else {
        t.open = 0; t.shape = 0;
        t.yaw = sp ? this.crowd.yawTo(i, sp) : 0;
        t.lean = 0.05; t.armL = 0; t.armR = 0;
        let brow = 0, smile = 0.15, lid = 1;
        if (stance === 'joke' || cur?.side.emotion === 'joyful') { smile = 0.75; lid = 0.9; }
        if (stance === 'question') brow = 0.3;
        if (i === replyTo && (stance === 'disagree' || stance === 'correct')) { brow = -0.45; smile = -0.1; }
        const next = upcoming.get(i);
        if (next === 'disagree' || next === 'correct') { brow = -0.35; lid = 0.85; }   // foreshadowing
        if (stance === 'agree' || stance === 'praise') t.nod = Math.max(0, Math.sin(at * 2.2 + i)) * 0.12;
        else t.nod = Math.sin(at * 0.9 + i * 1.7) * 0.03;
        t.brow = brow; t.smile = smile; t.lid = lid;
      }
    }
  }

  // ---------------------------------------------------------------- shots: a small virtual cinematographer
  private center() { return new THREE.Vector3(this.spot!.pos.x, this.roomY, this.spot!.pos.z); }

  /** How good is a camera at p looking at `target`? -Infinity if it sits inside someone or outside the room. */
  private score(p: THREE.Vector3, target: THREE.Vector3, skip: Set<number>) {
    if (p.x * p.x + p.z * p.z > (R - 0.35) ** 2 || p.y > this.roomY + FLOOR_H * 0.88 || p.y < this.roomY + 0.6) return -Infinity;
    let sc = 0;
    const seg = new THREE.Line3(p, target), q = new THREE.Vector3();
    for (let j = 0; j < this.crowd.people.length; j++) {
      const head = this.crowd.headPos(j), pose = this.crowd.people[j].pose;
      const body = new THREE.Vector3(pose.pos.x, this.roomY + 0.75, pose.pos.z);
      const near = Math.min(p.distanceTo(head), p.distanceTo(body));
      if (skip.has(j)) { if (near < 0.32) return -Infinity; continue; }
      if (near < 0.55) return -Infinity;
      seg.closestPointToPoint(head, true, q);
      const d = q.distanceTo(head);
      if (d < 0.3 && q.distanceTo(target) > 0.35) sc -= (0.3 - d) * 12;
    }
    return sc;
  }

  /** Try angles, distances and heights around a preferred direction; cut to the best. */
  private frame(target: THREE.Vector3, dir: THREE.Vector3, dist: number, lift: number, fov: number, skip: Set<number>, glide = 0, now = 0) {
    let best: THREE.Vector3 | null = null, bestScore = -Infinity;
    const Y = new THREE.Vector3(0, 1, 0);
    for (const a of [0, 0.3, -0.3, 0.6, -0.6, 0.95, -0.95, 1.3, -1.3]) {
      for (const m of [1, 0.85, 1.2, 0.7, 1.45]) {
        for (const h of [lift, lift + 0.22, lift - 0.12]) {
          const p = target.clone().add(dir.clone().applyAxisAngle(Y, a).multiplyScalar(dist * m)).setY(target.y + h);
          const sc = this.score(p, target, skip) - Math.abs(a) * 0.9 - Math.abs(m - 1) * 0.6 - Math.abs(h - lift) * 0.5;
          if (sc > bestScore) { bestScore = sc; best = p; }
        }
      }
    }
    if (!best) best = target.clone().add(dir.clone().multiplyScalar(dist)).setY(target.y + lift);
    this.rig.fovTarget = fov;
    if (glide) this.rig.glide(best, target, glide, now, 0.2, 0); else this.rig.cut(best, target, 0.12);
  }

  private wide(now: number, glide = false) {
    if (!this.spot) return;
    const c = this.center();
    // stand between the table and the middle of the room, looking out: the city glows behind them
    const inward = new THREE.Vector3(-c.x, 0, -c.z);
    if (inward.lengthSq() < 0.04) inward.set(0, 0, 1);
    inward.normalize();
    const target = c.clone().setY(this.roomY + 0.95);
    this.frame(target, inward, this.spot.radius * 2 + 1.9, 0.85, 52, new Set(), glide ? 2.2 : 0, now);
  }

  private single(i: number, _from: number, now: number) {
    if (!this.spot || i < 0) return;
    const head = this.crowd.headPos(i);
    const f = this.crowd.people[i].pose.facing;
    const face = new THREE.Vector3(Math.sin(f), 0, Math.cos(f));   // the way they face
    const target = head.clone().add(new THREE.Vector3(0, -0.05, 0));
    this.frame(target, face.applyAxisAngle(new THREE.Vector3(0, 1, 0), i % 2 ? 0.3 : -0.3), 1.3, 0.06, 30, new Set([i]));
    void now;
  }

  private overShoulder(listener: number, speaker: number, now: number) {
    const lh = this.crowd.headPos(listener), sh = this.crowd.headPos(speaker);
    const back = lh.clone().sub(sh).setY(0);
    const d = back.length();
    back.normalize();
    const target = sh.clone().add(new THREE.Vector3(0, -0.04, 0));
    this.frame(target, back.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.22), d + 0.55, 0.14, 34, new Set([speaker, listener]));
    void now;
  }

  /** the whole timeline so far, for muxing recorded videos */
  timeline() { return this.audio.log; }

  togglePause() {
    const ctx = this.audio.ctx;
    if (!ctx) return;
    this.paused = !this.paused;
    if (this.paused) ctx.suspend(); else ctx.resume();
  }
}
