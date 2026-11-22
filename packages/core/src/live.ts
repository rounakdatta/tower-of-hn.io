// The live state of the tower, as pure data in, files out.
//
//   items + tower order  ──►  Live  ──tick()──►  head.json        (1 s TTL: what's current)
//                                              epoch/<n>.json    (immutable: what changed)
//                                              floor/<id>/<rev>  (immutable: full snapshot)
//
// The orchestrator (a Durable Object in production, a script locally) feeds it
// and uploads what tick() returns. Clients never talk to it, only to the CDN.
import { playOrder, seat, voiceFor, type Node } from './conversation.ts';
import { speakable } from './speakable.ts';

export interface Item {
  id: number; type?: string; by?: string; text?: string; title?: string; url?: string;
  score?: number; descendants?: number; kids?: number[]; parent?: number; time?: number;
  dead?: boolean; deleted?: boolean;
}
export interface StoryMeta { id: number; title: string; url?: string; by?: string; score: number; comments: number }
/** voiced: [sidecar path, seconds, how it's delivered (emotion), how strongly (0..1)] */
export type Voiced = [string, number, string?, number?];
export interface TurnOut { id: number; by: string; depth: number; replyTo?: number; gapMs: number; voice: number; v?: Voiced }
/** gist: the first words of the comment that started the table (what it's about, on its sign) */
export interface TableOut { root: number; turns: TurnOut[]; seated: string[]; standing: string[]; gist?: string }
export interface FloorSnapshot { story: StoryMeta; rev: number; epoch: number; tables: TableOut[] }
export interface Delta {
  epoch: number;
  tower?: number[];                                    // new order, only when it changed
  stories?: StoryMeta[];                               // changed titles/scores/counts
  turns?: { story: number; table: number; at: number; turn: TurnOut }[];  // new or re-voiced turns, with their index
  gone?: number[];                                     // comments to drop (deleted, dead, flagged)
  floors?: Record<number, number>;                     // story -> latest snapshot rev
  /** a revision where only audio changed (the same turns, in the same order, the same people): the voicing that
   *  moved, so a listener holding revision `from` can make `to` without fetching the whole floor again */
  patches?: { s: number; from: number; to: number; v: [number, Voiced | null][] }[];
  voiced?: { id: number; v: Voiced }[];                // turns whose audio just became ready
}
export interface Head {
  epoch: number; at: number; tower: number[]; floors: Record<number, number>; snapshotEvery: number;
  /** id -> [title, score, comments, by, url] for every floor, so the tower renders from head alone */
  stories: Record<number, [string, number, number, string, string]>;
  /** id -> comments in the last 15 minutes (lights the windows) */
  act: Record<number, number>;
  /** id -> how many different people are talking on that floor (its crowd, seen through the windows) */
  people: Record<number, number>;
  /** comments listeners are waiting on that aren't voiced yet (set by the server; clients wait less when it's long) */
  load?: number;
}

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
  /** comment -> its voiced sidecar, filled in by the voice worker */
  voiced = new Map<number, Voiced>();
  /** HN users who asked not to be voiced: their comments are left out like dead ones (their replies still play) */
  optOut = new Set<string>();

  /** epochs and revisions are one sequence each, seeded from boot time (ms): every URL they name (immutable,
   *  cached for a year) is new, across restarts and for a story that leaves and comes back */
  private revSeq = 0;
  private opts: { snapshotEvery: number; base?: number };
  constructor(opts: { snapshotEvery: number; base?: number } = { snapshotEvery: 30 }) {
    this.opts = opts;
    this.epoch = this.revSeq = opts.base ?? 0;
  }

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

  /** Forget a story and everything under it (it left the front page long ago), so memory stays flat for months. */
  forget(sid: number): number {
    let n = 0;
    for (const stack = [sid]; stack.length;) {
      const id = stack.pop()!, it = this.items.get(id);
      if (!it) continue;
      this.items.delete(id); this.voiced.delete(id); this.storyCache.delete(id); n++;
      for (const k of it.kids ?? []) stack.push(k);
    }
    this.floors.delete(sid); this.revs.delete(sid); this.sinceSnapshot.delete(sid); this.dirtyStories.delete(sid);
    return n;
  }

  /** Rebuild every floor on the next tick (the opt-out list changed). */
  touchAll(): void { for (const sid of this.tower) this.dirtyStories.add(sid); }

  /** The voice worker finished a comment: its audio is ready for everyone. */
  markVoiced(id: number, path: string, dur: number, emotion?: string, intensity?: number): void {
    const prev = this.voiced.get(id);
    if (prev && prev[0] === path) return;
    const v: Voiced = emotion ? [path, dur, emotion, Math.round((intensity ?? 0.4) * 100) / 100] : [path, dur];
    this.voiced.set(id, v);
    (this.pending.voiced ??= []).push({ id, v });
    const story = this.storyOf(id);
    if (story !== undefined) this.dirtyStories.add(story);
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
      // any change a listener can hear: a turn added, removed or moved, or new audio (a first clip, more clips, the final)
      if (!prev || signature(prev) !== signature(next)) {
        const rev = ++this.revSeq;
        this.revs.set(sid, rev);
        if (prev && shape(prev) === shape(next)) {
          const before = new Map(prev.tables.flatMap((t) => t.turns.map((u) => [u.id, u.v?.[0]] as const)));
          const v = next.tables.flatMap((t) => t.turns.filter((u) => before.get(u.id) !== u.v?.[0]).map((u) => [u.id, u.v ?? null] as [number, [string, number] | null]));
          (this.pending.patches ??= []).push({ s: sid, from: prev.rev, to: rev, v });
        }
        next.rev = rev;
        next.epoch = this.epoch + 1;
        this.floors.set(sid, next);
        (this.pending.turns ??= []).push(...added.map((a) => ({ story: sid, ...a })));
        (this.pending.floors ??= {})[sid] = rev;
        const n = (this.sinceSnapshot.get(sid) ?? Infinity) + Math.max(1, added.length);
        if (!prev || n >= this.opts.snapshotEvery) { snapshots.push(next); this.sinceSnapshot.set(sid, 0); }
        else this.sinceSnapshot.set(sid, n);
      }
    }
    this.dirtyStories.clear();
    const p = this.pending;
    const changed = p.tower || p.stories?.length || p.turns?.length || p.gone?.length || p.floors || p.voiced?.length || p.patches?.length;
    let delta: Delta | undefined;
    if (changed) {
      delta = { ...p, epoch: ++this.epoch };
      this.pending = { epoch: 0 };
    }
    const floors: Record<number, number> = {}, stories: Head['stories'] = {}, act: Record<number, number> = {}, people: Record<number, number> = {};
    const since = now / 1000 - 900;
    for (const id of this.tower) {
      if (this.revs.has(id)) floors[id] = this.revs.get(id)!;
      const st = this.items.get(id);
      if (st) stories[id] = [st.title ?? '', st.score ?? 0, st.descendants ?? 0, st.by ?? '', st.url ?? ''];
      act[id] = 0;
    }
    const who = new Map<number, Set<string>>();
    for (const it of this.items.values()) {
      if (it.type !== 'comment' || it.dead || it.deleted || !it.by || this.optOut.has(it.by)) continue;
      const sid = this.storyOf(it.id);
      if (sid === undefined || !(sid in act)) continue;
      if ((it.time ?? 0) >= since) act[sid]++;
      let set = who.get(sid);
      if (!set) who.set(sid, (set = new Set()));
      set.add(it.by);
    }
    for (const id of this.tower) people[id] = who.get(id)?.size ?? 0;
    return { delta, head: { epoch: this.epoch, at: now, tower: this.tower.slice(), floors, snapshotEvery: this.opts.snapshotEvery, stories, act, people }, snapshots };
  }

  /** The story a comment belongs to: walk parents until a story (remembered: it never changes, and the head
   *  asks for every comment's story every tick). */
  storyOf(id: number): number | undefined {
    const hit = this.storyCache.get(id);
    if (hit !== undefined) return hit;
    for (let cur = this.items.get(id), hops = 0; cur && hops < 200; hops++) {
      if (cur.type === 'story' || cur.parent === undefined) { this.storyCache.set(id, cur.id); return cur.id; }
      cur = this.items.get(cur.parent);
    }
    return undefined;
  }
  private storyCache = new Map<number, number>();

  voiceOf(user: string): number {
    let v = this.voices.get(user);
    if (v === undefined) { v = voiceFor(user, new Set(), VOICE_POOL); this.voices.set(user, v); }
    return v;
  }

  private gists = new Map<number, { text: string; gist: string }>();
  /** The first words of a comment, for a table's sign: its own words (not a quote, not code), cut at a word. */
  private gistOf(id: number): string | undefined {
    const text = this.items.get(id)?.text;
    if (!text) return undefined;
    const hit = this.gists.get(id);
    if (hit && hit.text === text) return hit.gist;
    const said = speakable(text).segments.find((s) => s.kind === 'say') as { display: string } | undefined;
    let g = (said?.display ?? '').replace(/\s+/g, ' ').trim();
    if (g.length > 72) g = g.slice(0, 72).replace(/[\s,;:.!?-]+\S*$/, '') + '…';
    if (this.gists.size > 4000) this.gists.clear();
    this.gists.set(id, { text, gist: g });
    return g || undefined;
  }

  private buildFloor(sid: number): FloorSnapshot | undefined {
    const st = this.items.get(sid);
    if (!st) return undefined;
    const toNode = (id: number): Node | undefined => {
      const it = this.items.get(id);
      if (!it) return undefined;
      const out = it.by !== undefined && this.optOut.has(it.by);
      return { id, by: it.by, text: it.text, dead: it.dead || out, deleted: it.deleted, kids: (it.kids ?? []).map(toNode).filter(Boolean) as Node[] };
    };
    const tables: TableOut[] = [];
    for (const rootId of (st.kids ?? []).slice(0, MAX_TABLES)) {
      const root = toNode(rootId);
      if (!root) continue;
      const turns = playOrder(root);
      if (!turns.length) continue;
      const { seated, standing } = seat(turns);
      tables.push({ root: rootId, seated, standing, gist: this.gistOf(turns[0].id), turns: turns.map((t) => ({ ...t, voice: this.voiceOf(t.by), v: this.voiced.get(t.id) })) });
    }
    return { story: meta(st), rev: 0, epoch: 0, tables };
  }
}

function meta(it: Item): StoryMeta {
  return { id: it.id, title: it.title ?? '', url: it.url, by: it.by, score: it.score ?? 0, comments: it.descendants ?? 0 };
}

/** a floor's structure without its audio: the same shape means a revision changed only voicing */
function shape(f: FloorSnapshot): string {
  return f.tables.map((t) => `${t.root}:${t.turns.map((u) => u.id).join(',')}|${t.seated.join(',')}|${t.standing.join(',')}`).join(';');
}

function signature(f: FloorSnapshot): string {
  return f.tables.map((t) => t.root + ':' + t.turns.map((u) => u.id + (u.v ? '@' + u.v[0] : '')).join(',')).join('|');
}

function voicedCount(f: FloorSnapshot): number {
  let n = 0;
  for (const t of f.tables) for (const u of t.turns) if (u.v) n++;
  return n;
}

/** Turns present in `next` but not in `prev`, with their table and position (late replies land mid-table). */
export function diffTurns(prev: FloorSnapshot | undefined, next: FloorSnapshot): { table: number; at: number; turn: TurnOut }[] {
  const seen = new Set<number>();
  for (const t of prev?.tables ?? []) for (const u of t.turns) seen.add(u.id);
  const out: { table: number; at: number; turn: TurnOut }[] = [];
  next.tables.forEach((t, ti) => t.turns.forEach((u, i) => { if (!seen.has(u.id)) out.push({ table: ti, at: i, turn: u }); }));
  return out;
}
