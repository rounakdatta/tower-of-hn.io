// The voicing queue, in memory. towerd decides what is worth voicing (most urgent first); voice runners on any node
// claim one job at a time over HTTP and hold it with a lease, which every clip upload and a beat once a second
// renews. A lease that stops beating (a node dropped off, a runner died) lapses, and its job goes back to the queue,
// to resume from its last finished clip. towerd stays the only writer of files: runners only send what they made.
//
// Priority bands (lower is sooner), as towerd plans them:
//   0 someone sat at the table · 1 someone walked onto the floor · 2 a floor in focus on the tower · 3 background
import { randomBytes } from 'node:crypto';

export type Band = 0 | 1 | 2 | 3;
export const band = (prio: number): Band => (prio < 100 ? 0 : prio < 200 ? 1 : prio < 1000 ? 2 : 3);

export interface Lease { token: string; runner: string; patience: number; beat: number; since: number }
export interface Entry<J> { id: number; prio: number; upto: number; since: number; job: J; lease?: Lease }
interface Waiter<J> { runner: string; patience: number; at: number; done: (e: Entry<J> | null) => void }

export class VoiceQueue<J extends { rev: string }> {
  readonly entries = new Map<number, Entry<J>>();
  private byToken = new Map<string, number>();
  private waiters: Waiter<J>[] = [];

  private now: () => number;
  readonly leaseMs: number;
  constructor(now: () => number = Date.now, leaseMs = 20_000) { this.now = now; this.leaseMs = leaseMs; }

  /** The queue becomes `target` ([id, prio, upto], most urgent first). A job being voiced stays until it's done
   *  (it was wanted a moment ago, and what's voiced of it is kept), but takes its new urgency and depth. A job whose
   *  text changed is rebuilt, and whoever was voicing the old text loses it (their uploads are refused). */
  plan(target: [number, number, number][], make: (id: number, prio: number, upto: number) => J | undefined, revOf?: (id: number) => string | undefined) {
    const keep = new Set(target.map((t) => t[0]));
    for (const [id, e] of this.entries) {
      if (keep.has(id)) continue;
      if (!e.lease) this.entries.delete(id);
      else e.prio = Math.max(e.prio, 1000);          // its listener left: finish it, as background work
    }
    for (const [id, prio, upto] of target) {
      const e = this.entries.get(id);
      if (e && e.prio === prio && e.upto === upto && (!revOf || revOf(id) === e.job.rev)) continue;
      const job = make(id, prio, upto);
      if (!job) { if (e) this.revoke(id); continue; }
      if (!e) { this.entries.set(id, { id, prio, upto, since: this.now(), job }); continue; }
      if (e.job.rev !== job.rev) this.unlease(e);
      e.prio = prio; e.upto = upto; e.job = job;
    }
    this.dispatch();
  }

  /** The most urgent job nobody holds, for a runner that waits `patience` seconds before taking anything (a fallback
   *  that only helps when the others are busy or gone), or null when there's nothing for it right now. */
  private pick(patience: number, anyoneElse: boolean) {
    let best: Entry<J> | undefined;
    for (const e of this.entries.values()) {
      if (e.lease) continue;
      if (patience && anyoneElse && this.now() - e.since < patience * 1000) continue;
      if (!best || e.prio < best.prio || (e.prio === best.prio && e.since < best.since)) best = e;
    }
    return best;
  }

  private lease(e: Entry<J>, runner: string, patience: number) {
    const token = randomBytes(12).toString('hex'), t = this.now();
    e.lease = { token, runner, patience, beat: t, since: t };
    this.byToken.set(token, e.id);
    return e;
  }

  private unlease(e: Entry<J>) {
    if (e.lease) this.byToken.delete(e.lease.token);
    e.lease = undefined;
  }

  /** Runners other than `runner` that have asked for work lately: a patient runner only waits while one is around. */
  private seen = new Map<string, { at: number; patience: number }>();
  private othersAlive(runner: string) {
    for (const [r, s] of this.seen) if (r !== runner && !s.patience && this.now() - s.at < 60_000) return true;
    return false;
  }

  /** Long poll: resolves with a leased job, or null after `waitMs` with nothing to do. */
  claim(runner: string, patience = 0, waitMs = 25_000): { promise: Promise<Entry<J> | null>; cancel: () => void } {
    this.seen.set(runner, { at: this.now(), patience });
    const now = this.pick(patience, this.othersAlive(runner));
    if (now) return { promise: Promise.resolve(this.lease(now, runner, patience)), cancel: () => {} };
    let w!: Waiter<J>;
    const promise = new Promise<Entry<J> | null>((resolve) => {
      const timer = setTimeout(() => this.drop(w, null), waitMs);
      w = { runner, patience, at: this.now(), done: (e) => { clearTimeout(timer); resolve(e); } };
      this.waiters.push(w);
    });
    return { promise, cancel: () => this.drop(w, null) };
  }

  private drop(w: Waiter<J>, e: Entry<J> | null) {
    const i = this.waiters.indexOf(w);
    if (i < 0) return;
    this.waiters.splice(i, 1);
    w.done(e);
  }

  /** Hand waiting runners what they can take: impatient ones first, in the order they asked. */
  dispatch() {
    for (const w of [...this.waiters].sort((a, b) => a.patience - b.patience || a.at - b.at)) {
      this.seen.set(w.runner, { at: this.now(), patience: w.patience });
      const e = this.pick(w.patience, this.othersAlive(w.runner));
      if (!e) continue;
      this.drop(w, this.lease(e, w.runner, w.patience));
    }
  }

  get(token: string) {
    const id = this.byToken.get(token), e = id === undefined ? undefined : this.entries.get(id);
    return e?.lease?.token === token ? e : undefined;
  }

  /** A lease's heartbeat: still yours? should you give way? (and its current urgency and depth, which may change) */
  beat(token: string) {
    const e = this.get(token);
    if (!e) return null;
    e.lease!.beat = this.now();
    return { yield: this.shouldYield(e), prio: e.prio, upto: e.upto };
  }

  /** A patient runner (the fallback) can't take a young job, so it is never the one asked to make room for it. */
  private patientNow(l: Lease) { return l.patience > 0 && this.othersAlive(l.runner); }

  /** Give way when someone waits on something more urgent that nobody can take: the least urgent jobs being voiced
   *  yield first, one per urgent job (never every runner at once for one listener). */
  private shouldYield(e: Entry<J>) {
    if (this.patientNow(e.lease!)) return false;
    const mine = band(e.prio);
    let better = 0, top: Band = 3;
    for (const x of this.entries.values()) {
      if (x.lease || band(x.prio) >= mine) continue;
      better++; top = Math.min(top, band(x.prio)) as Band;
    }
    if (!better || this.waiters.some((w) => !w.patience)) return false;
    const held = [...this.entries.values()].filter((x) => x.lease && !this.patientNow(x.lease) && band(x.prio) > top)
      .sort((a, b) => b.prio - a.prio || b.lease!.since - a.lease!.since);
    return held.slice(0, better).includes(e);
  }

  /** The runner gave it back (it yielded, or failed): the job waits for the next taker, resuming where it stopped. */
  release(token: string) {
    const e = this.get(token);
    if (!e) return false;
    this.unlease(e);
    this.dispatch();
    return true;
  }

  /** Finished (or, for an opening, its first clips are in): it leaves the queue. If more of it is wanted by now,
   *  towerd's next plan puts it back, and whoever takes it resumes after the clips already made. */
  finish(token: string) {
    const e = this.get(token);
    if (!e) return false;
    this.unlease(e);
    this.entries.delete(e.id);
    return true;
  }

  /** Taken down (deleted on HN, an opt-out), or its text changed: drop it, and refuse its runner's uploads. */
  revoke(id: number) {
    const e = this.entries.get(id);
    if (!e) return;
    this.unlease(e);
    this.entries.delete(id);
  }

  /** Leases that stopped beating lapse (call about once a second); patient runners get another look. */
  sweep() {
    const t = this.now();
    for (const e of this.entries.values()) if (e.lease && t - e.lease.beat > this.leaseMs) this.unlease(e);
    this.dispatch();
  }

  /** Runners not heard from in an hour are forgotten (pods come and go with their names). */
  forget(maxAgeMs = 3_600_000) {
    for (const [r, s] of this.seen) if (this.now() - s.at > maxAgeMs) this.seen.delete(r);
  }

  stats() {
    let held = 0;
    for (const e of this.entries.values()) if (e.lease) held++;
    return { queued: this.entries.size, held, waiting: this.waiters.length };
  }
}
