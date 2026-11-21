// Live sync: everything the client knows comes from cached static files.
//   head.json (2 s) -> tower order, titles, activity, floor revisions, epoch
//   e/<n>.json      -> what changed (new turns pulse the beacon, voiced turns become playable)
//   f/<id>/<rev>    -> a floor's tables, play order, seats, voices, voiced clips
//   c/<id>.<rev>    -> a comment's sidecar: text, emotion, clips with loudness and mouth tracks

export interface Turn { id: number; by: string; depth: number; replyTo?: number; gapMs: number; voice: number; v?: [string, number] }
export interface Table { root: number; turns: Turn[]; seated: string[]; standing: string[] }
export interface Floor { story: { id: number; title: string; url?: string; by?: string; score: number; comments: number }; rev: number; epoch: number; tables: Table[] }
export interface Head {
  epoch: number; at: number; tower: number[]; floors: Record<number, number>;
  stories: Record<number, [string, number, number, string, string]>; act: Record<number, number>;
  /** different people talking on each floor (older servers: absent) */
  people?: Record<number, number>;
}
export interface Delta { epoch: number; tower?: number[]; turns?: { story: number; table: number; at: number; turn: Turn }[]; voiced?: { id: number; v: [string, number] }[]; gone?: number[] }
export interface Clip { u: string; d: number; t: string; who: string; env: number[]; shape: number[] }
export interface Sidecar { id: number; by: string; emotion: string; stance: string; intensity?: number; cues?: string[]; dur: number; clips: Clip[]; links: { url: string; domain: string; text: string }[]; code: string[]; /** still being voiced: more clips will follow at a new path */ partial?: boolean; of?: number }

export class LiveSync {
  head: Head | null = null;
  private floorCache = new Map<string, Floor>();
  private sideCache = new Map<string, Promise<Sidecar>>();
  private watchers = new Map<number, (f: Floor) => void>();
  onHead: (h: Head, prev: Head | null) => void = () => {};
  onDelta: (d: Delta) => void = () => {};

  constructor(public base: string) {}

  async start() {
    await this.poll();
    setInterval(() => this.poll().catch(() => {}), 2000);
  }

  private async poll() {
    const h: Head = await (await fetch(this.base + 'head.json', { cache: 'no-cache' })).json();
    const prev = this.head;
    if (prev && h.epoch === prev.epoch) return;
    this.head = h;
    if (prev) {
      for (let n = prev.epoch + 1; n <= h.epoch && n > h.epoch - 20; n++) {
        fetch(this.base + `e/${n}.json`).then((r) => (r.ok ? r.json() : null)).then((d) => d && this.onDelta(d)).catch(() => {});
      }
    }
    this.onHead(h, prev);
    for (const [sid, cb] of this.watchers) {
      const rev = h.floors[sid];
      if (rev && (!prev || prev.floors[sid] !== rev)) this.floor(sid).then((f) => f && cb(f));
    }
  }

  async floor(sid: number): Promise<Floor | null> {
    const rev = this.head?.floors[sid];
    if (!rev) return null;
    const key = `${sid}/${rev}`;
    const hit = this.floorCache.get(key);
    if (hit) return hit;
    const r = await fetch(this.base + `f/${key}.json`);
    if (!r.ok) return null;
    const f: Floor = await r.json();
    this.floorCache.set(key, f);
    if (this.floorCache.size > 40) this.floorCache.delete(this.floorCache.keys().next().value!);   // old revisions
    return f;
  }

  watch(sid: number, cb: (f: Floor) => void) { this.watchers.set(sid, cb); }
  unwatch(sid: number) { this.watchers.delete(sid); }

  sidecar(path: string): Promise<Sidecar> {
    let p = this.sideCache.get(path);
    if (!p) {
      p = fetch(this.base + path).then((r) => { if (!r.ok) throw new Error(path); return r.json(); });
      p.catch(() => this.sideCache.delete(path));
      this.sideCache.set(path, p);
    }
    return p;
  }

  url(path: string) { return this.base + path; }

  /** Ask for a table's voicing from a turn on. False when refused (starting up, too many asks) or unreachable. */
  want(story: number, table: number, from = 0): Promise<boolean> {
    return fetch(this.base.replace(/live\/$/, 'want'), { method: 'POST', body: JSON.stringify({ story, table, from }) }).then((r) => r.ok, () => false);
  }

  /** Ahead of anyone sitting: the first words of a floor's best tables. 1 = it's in focus, 2 = we're on it. */
  warm(story: number, level: 1 | 2) {
    fetch(this.base.replace(/live\/$/, 'want'), { method: 'POST', body: JSON.stringify({ story, warm: level }) }).catch(() => {});
  }
}
