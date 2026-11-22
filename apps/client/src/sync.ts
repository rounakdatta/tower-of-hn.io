// Live sync: everything the client knows comes from cached static files.
//   head.json (2 s) -> tower order, titles, activity, floor revisions, epoch
//   e/<n>.json      -> what changed (new turns pulse the beacon, voiced turns become playable)
//   f/<id>/<rev>    -> a floor's tables, play order, seats, voices, voiced clips
//   c/<id>.<rev>    -> a comment's sidecar: text, emotion, clips with loudness and mouth tracks

/** voiced: [sidecar path, seconds, emotion, intensity 0..1] (older servers: just the first two) */
export interface Turn { id: number; by: string; depth: number; replyTo?: number; gapMs: number; voice: number; v?: [string, number, string?, number?] }
/** gist: the first words of the comment that started it (older servers: absent) */
export interface Table { root: number; turns: Turn[]; seated: string[]; standing: string[]; gist?: string }
export interface Floor { story: { id: number; title: string; url?: string; by?: string; score: number; comments: number }; rev: number; epoch: number; tables: Table[] }
export interface Head {
  epoch: number; at: number; tower: number[]; floors: Record<number, number>;
  stories: Record<number, [string, number, number, string, string]>; act: Record<number, number>;
  /** different people talking on each floor (older servers: absent) */
  people?: Record<number, number>;
  /** comments listeners are waiting on that aren't voiced yet: a busy evening (older servers: absent) */
  load?: number;
  /** how heated each floor is, 0..1 (older servers: absent) */
  heat?: Record<number, number>;
}
export interface Delta {
  epoch: number; tower?: number[]; turns?: { story: number; table: number; at: number; turn: Turn }[]; voiced?: { id: number; v: [string, number, string?, number?] }[]; gone?: number[];
  floors?: Record<number, number>;
  /** audio-only revisions of a floor: apply to revision `from` to get `to` (no refetch) */
  patches?: { s: number; from: number; to: number; v: [number, [string, number, string?, number?] | null][] }[];
}
export interface Clip { u: string; d: number; t: string; who: string; env: number[]; shape: number[] }
export interface Sidecar { id: number; by: string; emotion: string; stance: string; intensity?: number; cues?: string[]; dur: number; clips: Clip[]; links: { url: string; domain: string; text: string }[]; code: string[]; /** still being voiced: more clips will follow at a new path */ partial?: boolean; of?: number }

export class LiveSync {
  head: Head | null = null;
  private floorCache = new Map<string, Floor>();
  private sideCache = new Map<string, Promise<Sidecar>>();
  private watchers = new Map<number, (f: Floor) => void>();
  onHead: (h: Head, prev: Head | null) => void = () => {};
  onDelta: (d: Delta) => void = () => {};
  /** on the tower, not in a room: polling can be half as often */
  relaxed = false;

  constructor(public base: string) {}

  async start() {
    await this.poll();
    // every 2 s on a floor (someone may walk in with a new comment); every 4 s on the tower (a window lighting a
    // moment later is the same window); every 10 s from a tab in the background (often left open for hours), which
    // still keeps a conversation you're listening to with the screen off current
    let quiet = 0;
    setInterval(() => {
      ++quiet;
      if (document.hidden ? quiet % 5 : this.relaxed && quiet % 2) return;
      this.poll().catch(() => {});
    }, 2000);
    document.addEventListener('visibilitychange', () => { quiet = 0; if (!document.hidden) this.poll().catch(() => {}); });
  }

  private polling = false;
  private async poll() {
    if (this.polling) return;                              // a slow network: never two polls racing over one head
    this.polling = true;
    try { await this.step(); } finally { this.polling = false; }
  }
  private async step() {
    const h: Head = await (await fetch(this.base + 'head.json', { cache: 'no-cache' })).json();
    const prev = this.head;
    if (prev && h.epoch === prev.epoch) return;
    // what changed, in order. A floor is ~17 KB even compressed and revises every few seconds while its comments
    // are being voiced; most of those revisions are audio only, and arrive here as a few bytes of patch
    const gap = prev ? h.epoch - prev.epoch : 0;
    const deltas: (Delta | null)[] = prev && gap > 0 && gap <= 20
      ? await Promise.all(Array.from({ length: gap }, (_, k) => fetch(this.base + `e/${prev.epoch + 1 + k}.json`)
        .then((r) => (r.ok ? r.json().catch(() => null) : null), () => null)))
      : [];
    this.head = h;
    for (const d of deltas) if (d) this.onDelta(d);
    this.onHead(h, prev);
    for (const [sid, cb] of this.watchers) {
      const rev = h.floors[sid];
      if (!rev || (prev && prev.floors[sid] === rev)) continue;
      const patched = prev && gap > 0 && gap <= 20 ? this.patched(sid, prev.floors[sid], rev, deltas, h) : null;
      if (patched) cb(patched);
      else this.floor(sid).then((f) => f && cb(f));
    }
  }

  /** Floor `sid` at revision `to`, made from the one we hold if every change since was audio only (else null). */
  private patched(sid: number, from: number | undefined, to: number, deltas: (Delta | null)[], h: Head): Floor | null {
    let f = from ? this.floorCache.get(`${sid}/${from}`) : undefined;
    if (!f) return null;
    for (const d of deltas) {
      if (!d) return null;                                 // a gap: we can't know what changed
      if (d.floors?.[sid] === undefined) continue;
      const p = d.patches?.find((x) => x.s === sid && x.from === f!.rev);
      if (!p) return null;                                 // turns came, went or moved: fetch it whole
      const v = new Map(p.v);
      f = { ...f, rev: p.to, tables: f.tables.map((t) => (t.turns.some((u) => v.has(u.id))
        ? { ...t, turns: t.turns.map((u) => { if (!v.has(u.id)) return u; const x = v.get(u.id); const w = { ...u }; if (x) w.v = x; else delete w.v; return w; }) }
        : t)) };
      this.keep(`${sid}/${p.to}`, f);
    }
    if (f.rev !== to) return null;
    // the title, points and count move without the tables changing: take them from the head
    const s = h.stories[sid];
    if (s) { f = { ...f, story: { ...f.story, title: s[0] || f.story.title, score: s[1], comments: s[2] } }; this.keep(`${sid}/${to}`, f); }
    return f;
  }

  async floor(sid: number): Promise<Floor | null> {
    const rev = this.head?.floors[sid];
    if (!rev) return null;
    const key = `${sid}/${rev}`;
    const hit = this.floorCache.get(key);
    if (hit) return hit;
    const r = await fetch(this.base + `f/${key}.json`);
    if (!r.ok) return null;
    const f: Floor | null = await r.json().catch(() => null);
    if (f) this.keep(key, f);
    return f;
  }
  private keep(key: string, f: Floor) {
    this.floorCache.set(key, f);
    if (this.floorCache.size > 40) this.floorCache.delete(this.floorCache.keys().next().value!);   // old revisions
  }

  watch(sid: number, cb: (f: Floor) => void) { this.watchers.set(sid, cb); }
  unwatch(sid: number) { this.watchers.delete(sid); }

  sidecar(path: string): Promise<Sidecar> {
    let p = this.sideCache.get(path);
    if (!p) {
      p = fetch(this.base + path).then((r) => { if (!r.ok) throw new Error(path); return r.json(); });
      p.catch(() => this.sideCache.delete(path));
      this.sideCache.set(path, p);
      if (this.sideCache.size > 800) this.sideCache.delete(this.sideCache.keys().next().value!);   // an evening's listening stays small
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
