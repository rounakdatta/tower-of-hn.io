// The live state of the tower, as pure data in, files out.
//
//   items + tower order  ──►  Live  ──tick()──►  head.json        (1 s TTL: what's current)
//                                              epoch/<n>.json    (immutable: what changed)
//                                              floor/<id>/<rev>  (immutable: full snapshot)
//
// The orchestrator (a Durable Object in production, a script locally) feeds it
// and uploads what tick() returns. Clients never talk to it, only to the CDN.
import { playOrder, seat, voiceFor, type Node } from './conversation.ts';

export interface Item {
  id: number; type?: string; by?: string; text?: string; title?: string; url?: string;
  score?: number; descendants?: number; kids?: number[]; parent?: number; time?: number;
  dead?: boolean; deleted?: boolean;
}
export interface StoryMeta { id: number; title: string; url?: string; by?: string; score: number; comments: number }
export interface TurnOut { id: number; by: string; depth: number; replyTo?: number; gapMs: number; voice: number }
export interface TableOut { root: number; turns: TurnOut[]; seated: string[]; standing: string[] }
export interface FloorSnapshot { story: StoryMeta; rev: number; tables: TableOut[] }
export interface Delta {
  epoch: number;
  tower?: number[];                                    // new order, only when it changed
  stories?: StoryMeta[];                               // changed titles/scores/counts
  turns?: { story: number; table: number; at: number; turn: TurnOut }[];  // new or re-voiced turns, with their index
  gone?: number[];                                     // comments to drop (deleted, dead, flagged)
  floors?: Record<number, number>;                     // story -> latest snapshot rev
}
export interface Head { epoch: number; at: number; tower: number[]; floors: Record<number, number>; snapshotEvery: number }

export const VOICE_POOL = 115;
const MAX_TABLES = 60;

export class Live {
  items = new Map<number, Item>();
  tower: number[] = [];
  private floors = new Map<number, FloorSnapshot>();
  private revs = new Map<number, number>();
  private epoch = 0;
  private pending: Delta = { epoch: 0 };
  private dirtyStories = new Set<number>();
  private sinceSnapshot = new Map<number, number>();
  /** user -> voice, assigned the first time we ever see them and never changed (their packs depend on it) */
  voices = new Map<string, number>();

  private opts: { snapshotEvery: number };
  constructor(opts = { snapshotEvery: 30 }) { this.opts = opts; }

  /** A new or changed item from HN (new comment, edit, death, score change). */
  upsert(it: Item): void {
    const prev = this.items.get(it.id);
    this.items.set(it.id, { ...prev, ...it });
    const story = this.storyOf(it.id);
    if (story !== undefined) this.dirtyStories.add(story);
    if ((it.dead || it.deleted) && !(prev?.dead || prev?.deleted)) (this.pending.gone ??= []).push(it.id);
    if (it.type === 'story' && this.tower.includes(it.id) && prev && (prev.title !== it.title || prev.score !== it.score || prev.descendants !== it.descendants)) {
      (this.pending.stories ??= []).push(meta(it));
    }
  }

  /** HN's current front page, best first. */
  setTower(order: number[]): void {
    if (order.join() === this.tower.join()) return;
    this.tower = order.slice();
    this.pending.tower = this.tower.slice();
    for (const id of order) if (!this.floors.has(id)) this.dirtyStories.add(id);
  }

  /** Called every ~2 s: rebuild dirty floors, emit one delta (or nothing), the head, and any due snapshots. */
  tick(now: number): { delta?: Delta; head: Head; snapshots: FloorSnapshot[] } {
    const snapshots: FloorSnapshot[] = [];
    for (const sid of this.dirtyStories) {
      if (!this.tower.includes(sid)) continue;
      const next = this.buildFloor(sid);
      if (!next) continue;
      const prev = this.floors.get(sid);
      const added = diffTurns(prev, next);
      if (added.length || !prev) {
        const rev = (this.revs.get(sid) ?? 0) + 1;
        this.revs.set(sid, rev);
        next.rev = rev;
        this.floors.set(sid, next);
        (this.pending.turns ??= []).push(...added.map((a) => ({ story: sid, ...a })));
        (this.pending.floors ??= {})[sid] = rev;
        const n = (this.sinceSnapshot.get(sid) ?? Infinity) + added.length;
        if (!prev || n >= this.opts.snapshotEvery) { snapshots.push(next); this.sinceSnapshot.set(sid, 0); }
        else this.sinceSnapshot.set(sid, n);
      }
    }
    this.dirtyStories.clear();
    const p = this.pending;
    const changed = p.tower || p.stories?.length || p.turns?.length || p.gone?.length || p.floors;
    let delta: Delta | undefined;
    if (changed) {
      delta = { ...p, epoch: ++this.epoch };
      this.pending = { epoch: 0 };
    }
    const floors: Record<number, number> = {};
    for (const id of this.tower) if (this.revs.has(id)) floors[id] = this.revs.get(id)!;
    return { delta, head: { epoch: this.epoch, at: now, tower: this.tower.slice(), floors, snapshotEvery: this.opts.snapshotEvery }, snapshots };
  }

  /** The story a comment belongs to: walk parents until a story. */
  storyOf(id: number): number | undefined {
    for (let cur = this.items.get(id), hops = 0; cur && hops < 200; hops++) {
      if (cur.type === 'story' || cur.parent === undefined) return cur.id;
      cur = this.items.get(cur.parent);
    }
    return undefined;
  }

  voiceOf(user: string): number {
    let v = this.voices.get(user);
    if (v === undefined) { v = voiceFor(user, new Set(), VOICE_POOL); this.voices.set(user, v); }
    return v;
  }

  private buildFloor(sid: number): FloorSnapshot | undefined {
    const st = this.items.get(sid);
    if (!st) return undefined;
    const toNode = (id: number): Node | undefined => {
      const it = this.items.get(id);
      if (!it) return undefined;
      return { id, by: it.by, text: it.text, dead: it.dead, deleted: it.deleted, kids: (it.kids ?? []).map(toNode).filter(Boolean) as Node[] };
    };
    const tables: TableOut[] = [];
    for (const rootId of (st.kids ?? []).slice(0, MAX_TABLES)) {
      const root = toNode(rootId);
      if (!root) continue;
      const turns = playOrder(root);
      if (!turns.length) continue;
      const { seated, standing } = seat(turns);
      tables.push({ root: rootId, seated, standing, turns: turns.map((t) => ({ ...t, voice: this.voiceOf(t.by) })) });
    }
    return { story: meta(st), rev: 0, tables };
  }
}

function meta(it: Item): StoryMeta {
  return { id: it.id, title: it.title ?? '', url: it.url, by: it.by, score: it.score ?? 0, comments: it.descendants ?? 0 };
}

/** Turns present in `next` but not in `prev`, with their table and position (late replies land mid-table). */
export function diffTurns(prev: FloorSnapshot | undefined, next: FloorSnapshot): { table: number; at: number; turn: TurnOut }[] {
  const seen = new Set<number>();
  for (const t of prev?.tables ?? []) for (const u of t.turns) seen.add(u.id);
  const out: { table: number; at: number; turn: TurnOut }[] = [];
  next.tables.forEach((t, ti) => t.turns.forEach((u, i) => { if (!seen.has(u.id)) out.push({ table: ti, at: i, turn: u }); }));
  return out;
}
