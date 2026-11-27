// The floor's own clock (FLOOR_TIMELINE). A floor is a story's whole conversation: every table, every comment,
// everyone who wrote one. This module says when each of those things happened and what the room looked like at any
// moment t (seconds since the story went up): who has walked in and who has gone, which tables have opened, how far
// each has got and how lively it is, whose comment is the latest. Every answer is a pure function of the floor and
// t, so however anyone gets to t (dragging forward, back, a jump, a crawl, a deep link) the room is the same.
//
// What Hacker News says, and what we decided where it says nothing:
// - Someone walks in with their first comment on the floor, at whichever table it is (one person per name: someone
//   at three tables is one person, with one place, at the table they joined first).
// - A table opens with its top-level comment.
// - HN never says when anyone stops reading, so the rule is ours and it is said where it shows (the line's card): a
//   person leaves an hour after their last comment on the floor. Someone who comes back four hours later to answer
//   a reply has been in the room the whole time (they were following it).
// - Dead and deleted comments are not on the floor (towerd leaves them out; their replies stay, as on HN).
// - Comments written in the same second are put in id order, a millisecond apart (HN ids rise with time), so every
//   comment has its own moment and the order never depends on how the list arrived.
// - A comment whose time we were not told (an older server, a line that arrived live without one) is placed by its
//   id between the comments around it: ids rise with time across all of HN.
//
// The line to scrub on is not the wall clock: a thread says most of what it says in its first hours, and a night of
// three comments would take most of a 20-hour line. Each comment gets an equal share of 70% of the line and the
// clock the other 30%, so a burst gets room to scrub through and a quiet night still reads as time passing. The
// labels are always the wall clock ("3 h 12 min in").
//
// Pure: no DOM, no three.js. Built once per floor revision in O(n log n); every question after that is a binary
// search (O(log n)) or, for a table, a prefix sum.

/** what the clock needs of a turn (sync.ts's Turn has it all) */
export interface TTurn { id: number; by: string; at?: number; replyTo?: number }
export interface TTable { root: number; turns: readonly TTurn[] }
export interface TFloor { tables: readonly TTable[] }

/** someone stays this long after their last comment (s) */
export const DWELL = 3600;
/** the clock's share of the line (the rest is shared by the comments, equally) */
export const CLOCK_SHARE = 0.3;
/** a comment lights its table, and the light fades by e over this long (s of the floor's clock) */
export const GLOW = 25 * 60;
/** a table is "talking" at t if a comment landed there in this long before t (s) */
export const TALKING = 30 * 60;

export interface Comment {
  /** its place in the floor's time order */
  i: number;
  id: number;
  by: string;
  /** its table (an index into floor.tables) */
  table: number;
  /** its place in its table's time order */
  k: number;
  /** seconds since the story went up: strictly increasing along `comments` */
  at: number;
  /** false: HN's time wasn't given; placed by its id */
  known: boolean;
  /** an index into `people` */
  person: number;
  /** the person's first comment on the floor (they walk in with it) */
  first: boolean;
  /** the comment it answers (undefined: the table's opener) */
  replyTo?: number;
}

export interface Person {
  name: string;
  /** walks in: their first comment */
  enter: number;
  /** goes: DWELL after their last comment */
  leave: number;
  /** the table they first spoke at (an index into floor.tables): their place in the room is there */
  home: number;
  comments: number;
  /** different tables they spoke at */
  tables: number;
}

export interface TableClock {
  root: number;
  /** its index in floor.tables */
  index: number;
  /** its top-level comment's moment (Infinity: none of its turns has a time) */
  open: number;
  /** its last comment's moment */
  last: number;
  /** its comments (indices into `comments`), in time order */
  said: Int32Array;
  /** their moments */
  times: Float64Array;
  /** prefix sums of exp((at - open) / GLOW) (for the glow at any t) */
  glow: Float64Array;
  /** the people at the table, in the order they first spoke there (indices into `people`) */
  people: Int32Array;
  /** when each of them first spoke there (sorted): the table's people at t is how many of these are ≤ t */
  firsts: Float64Array;
}

export interface FloorClock {
  comments: Comment[];
  people: Person[];
  tables: TableClock[];
  byName: Map<string, number>;
  /** the floor's last comment */
  last: number;
  /** where the line ends: now, but never more than DWELL after the last comment (the room is empty by then) */
  end: number;
  /** sorted, for counting at any t */
  enters: Float64Array;
  leaves: Float64Array;
  opens: Float64Array;
  /** the line: piecewise linear, breakpoints at each comment (t → u, both strictly increasing) */
  axisT: Float64Array;
  axisU: Float64Array;
  /** comment id → its index in `comments` */
  byId: Map<number, number>;
}

/** the moment a run of turns happened, from the ones whose time we know: by id, between the known ones around them */
function placeByIds(known: { id: number; at: number }[], id: number): number {
  if (!known.length) return 0;
  let lo = 0, hi = known.length - 1;
  if (id <= known[0].id) return known[0].at;
  if (id >= known[hi].id) return known[hi].at;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (known[mid].id <= id) lo = mid; else hi = mid; }
  const a = known[lo], b = known[hi];
  return a.at + ((id - a.id) / (b.id - a.id)) * (b.at - a.at);
}

/**
 * The floor on its own clock. `now`: seconds since the story went up, right now (the line runs to it, but no more than
 * DWELL past the last comment); leave it out and the line ends when the last person has gone. Null when no turn on
 * the floor carries a time (an older server): there is no clock to show.
 */
export function floorClock(floor: TFloor, now?: number): FloorClock | null {
  const raw: { id: number; by: string; table: number; at?: number; replyTo?: number }[] = [];
  floor.tables.forEach((t, table) => { for (const u of t.turns) raw.push({ id: u.id, by: u.by, table, at: u.at, replyTo: u.replyTo }); });
  const known = raw.filter((r) => typeof r.at === 'number' && Number.isFinite(r.at)).map((r) => ({ id: r.id, at: Math.max(0, r.at!) }));
  if (!known.length) return null;
  known.sort((a, b) => a.id - b.id);
  // (ids rise with time on HN, but a time we were given is the truth: placement only fills the gaps)
  const timed = raw.map((r) => ({ ...r, known: typeof r.at === 'number' && Number.isFinite(r.at), t: typeof r.at === 'number' && Number.isFinite(r.at) ? Math.max(0, r.at) : placeByIds(known, r.id) }));
  timed.sort((a, b) => a.t - b.t || a.id - b.id);
  // every comment its own moment: the same second keeps id order, a millisecond apart
  const comments: Comment[] = [];
  const byName = new Map<string, number>(), people: Person[] = [], byId = new Map<number, number>();
  const tableCount = floor.tables.length;
  const perTable: number[][] = Array.from({ length: tableCount }, () => []);
  const seenAt: Set<number>[] = Array.from({ length: tableCount }, () => new Set());
  let prev = -Infinity;
  for (const r of timed) {
    if (byId.has(r.id)) continue;                                  // (the same comment twice: HN moved it between tables mid-poll)
    const at = r.t > prev ? r.t : prev + 0.001;
    prev = at;
    let p = byName.get(r.by), first = false;
    if (p === undefined) {
      p = people.length; byName.set(r.by, p); first = true;
      people.push({ name: r.by, enter: at, leave: at + DWELL, home: r.table, comments: 0, tables: 0 });
    }
    const person = people[p];
    person.comments++; person.leave = at + DWELL;
    if (!seenAt[r.table].has(p)) { seenAt[r.table].add(p); person.tables++; }
    const i = comments.length;
    byId.set(r.id, i);
    comments.push({ i, id: r.id, by: r.by, table: r.table, k: perTable[r.table].length, at, known: r.known, person: p, first, replyTo: r.replyTo });
    perTable[r.table].push(i);
  }
  const tables: TableClock[] = floor.tables.map((t, index) => {
    const said = Int32Array.from(perTable[index]), times = Float64Array.from(said, (i) => comments[i].at);
    const open = times.length ? times[0] : Infinity, glow = new Float64Array(said.length);
    let acc = 0;
    for (let k = 0; k < said.length; k++) { acc += Math.exp((times[k] - open) / GLOW); glow[k] = acc; }
    const order: number[] = [], firsts: number[] = [], here = new Set<number>();
    for (const i of said) { const p = comments[i].person; if (!here.has(p)) { here.add(p); order.push(p); firsts.push(comments[i].at); } }
    return { root: t.root, index, open, last: times.length ? times[times.length - 1] : -Infinity, said, times, glow, people: Int32Array.from(order), firsts: Float64Array.from(firsts) };
  });
  const last = comments.length ? comments[comments.length - 1].at : 0;
  const end = Math.max(last, now === undefined ? last + DWELL : Math.min(now, last + DWELL));
  const enters = Float64Array.from(people, (p) => p.enter).sort();
  const leaves = Float64Array.from(people, (p) => p.leave).sort();
  const opens = Float64Array.from(tables.filter((t) => Number.isFinite(t.open)), (t) => t.open).sort();
  // the line: u(t) = CLOCK_SHARE·t/end + (1 - CLOCK_SHARE)·c(t), c rising by 1/N across each comment's own slot
  const N = comments.length, n = N + 2, axisT = new Float64Array(n), axisU = new Float64Array(n);
  const span = end > 0 ? end : 1;
  axisT[0] = 0; axisU[0] = 0;
  for (let k = 0; k < N; k++) {
    const t = comments[k].at;
    axisT[k + 1] = t;
    axisU[k + 1] = CLOCK_SHARE * (t / span) + (1 - CLOCK_SHARE) * ((k + 0.5) / N);
  }
  axisT[n - 1] = Math.max(span, last + 0.001); axisU[n - 1] = 1;
  // (a first comment at 0 s, or a last at the end: the breakpoints must still rise strictly)
  for (let k = 1; k < n; k++) {
    if (axisT[k] <= axisT[k - 1]) axisT[k] = axisT[k - 1] + 0.0005;
    if (axisU[k] <= axisU[k - 1]) axisU[k] = Math.min(1, axisU[k - 1] + 1e-9);
  }
  return { comments, people, tables, byName, last, end: axisT[n - 1], enters, leaves, opens, axisT, axisU, byId };
}

/** how many of the sorted `xs` are ≤ x */
export function countUpTo(xs: ArrayLike<number>, x: number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** where moment t sits on the line, 0..1 */
export function uOf(c: FloorClock, t: number): number {
  const T = c.axisT, U = c.axisU;
  if (t <= T[0]) return 0;
  if (t >= T[T.length - 1]) return 1;
  const k = countUpTo(T, t) - 1, a = T[k], b = T[k + 1];
  return U[k] + ((t - a) / (b - a)) * (U[k + 1] - U[k]);
}
/** the moment at u on the line (0..1) */
export function tOf(c: FloorClock, u: number): number {
  const T = c.axisT, U = c.axisU;
  if (u <= 0) return 0;
  if (u >= 1) return T[T.length - 1];
  const k = countUpTo(U, u) - 1, a = U[k], b = U[k + 1];
  return T[k] + ((u - a) / (b - a)) * (T[k + 1] - T[k]);
}

/** the latest comment at or before t (an index into comments; -1 before the first) */
export function latest(c: FloorClock, t: number): number {
  let lo = 0, hi = c.comments.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (c.comments[mid].at <= t) lo = mid + 1; else hi = mid; }
  return lo - 1;
}

/** people in the room at t */
export const presentAt = (c: FloorClock, t: number) => countUpTo(c.enters, t) - countUpTo(c.leaves, t);
/** is person p in the room at t */
export const isHere = (p: Person, t: number) => p.enter <= t && t < p.leave;
/** tables open at t */
export const openAt = (c: FloorClock, t: number) => countUpTo(c.opens, t);

export interface TableNow {
  open: boolean;
  /** its comments written by t */
  turns: number;
  /** the latest of them (an index into comments; -1: none yet) */
  last: number;
  /** how lit it is: 1 for a comment this moment, fading by e over GLOW; a busy stretch adds up (not capped here) */
  glow: number;
  /** a comment landed here within TALKING before t */
  talking: boolean;
}

/** table k as of t */
export function tableAt(c: FloorClock, k: number, t: number, out?: TableNow): TableNow {
  const tb = c.tables[k], n = countUpTo(tb.times, t), o = out ?? { open: false, turns: 0, last: -1, glow: 0, talking: false };
  o.open = n > 0; o.turns = n; o.last = n ? tb.said[n - 1] : -1;
  o.glow = n ? tb.glow[n - 1] * Math.exp(-(t - tb.open) / GLOW) : 0;
  o.talking = n > 0 && t - tb.times[n - 1] < TALKING;
  return o;
}

/** tables where a comment landed within TALKING before t */
export function talkingAt(c: FloorClock, t: number): number {
  let n = 0;
  for (const tb of c.tables) { const k = countUpTo(tb.times, t); if (k && t - tb.times[k - 1] < TALKING) n++; }
  return n;
}

export interface FloorNow {
  t: number;
  /** the comment that is the latest at t (-1: none yet), and whose it is */
  said: number;
  by: string | null;
  people: number;
  tables: number;
  talking: number;
  /** comments written by t */
  comments: number;
}

/** the floor at t, in the numbers the line's card and a screen reader say */
export function floorAt(c: FloorClock, t: number): FloorNow {
  const said = latest(c, t);
  return { t, said, by: said >= 0 ? c.comments[said].by : null, people: presentAt(c, t), tables: openAt(c, t), talking: talkingAt(c, t), comments: said + 1 };
}

/** "12 min in", "1 h 04 min in", "40 s in": as said aloud, never rounded up (59.9 s is "59 s") */
export function sayIn(t: number) {
  const s = Math.max(0, Math.floor(t));
  if (s < 60) return `${s} s in`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min in`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min in`;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** the slider's value as a screen reader says it: "2 h 10 min in, 187 people, 23 tables, comment by tptacek" */
export function floorText(c: FloorClock, t: number) {
  const f = floorAt(c, t);
  if (f.said < 0) return `${sayIn(t)}, nobody here yet`;
  return `${sayIn(t)}, ${plural(f.people, 'person', 'people')}, ${plural(f.tables, 'table', 'tables')}, comment by ${f.by}`;
}

/** The comment `step` comments from the one at t (arrow keys: one; Shift: ten), clamped to the floor: its moment.
 *  `only`: just this table's comments (seated). */
export function stepFloor(c: FloorClock, t: number, step: number, only?: number) {
  if (only !== undefined) {
    const tb = c.tables[only];
    if (!tb.said.length) return t;
    const k = countUpTo(tb.times, t) - 1;
    const to = Math.max(0, Math.min(tb.said.length - 1, (k < 0 ? (step > 0 ? -1 : 0) : k) + step));
    return tb.times[to];
  }
  if (!c.comments.length) return t;
  const k = latest(c, t);
  const to = Math.max(0, Math.min(c.comments.length - 1, (k < 0 ? (step > 0 ? -1 : 0) : k) + step));
  return c.comments[to].at;
}

/** How many people walk in (and go) in each of `n` equal stretches of the LINE (not the clock): the histogram under
 *  it, and the busiest bin of each. */
export function flowIn(c: FloorClock, n: number): { enters: Uint16Array; leaves: Uint16Array; max: number } {
  const enters = new Uint16Array(Math.max(1, n)), leaves = new Uint16Array(Math.max(1, n)), last = enters.length - 1;
  for (const p of c.people) {
    enters[Math.min(last, Math.floor(uOf(c, p.enter) * enters.length))]++;
    if (p.leave <= c.end) leaves[Math.min(last, Math.floor(uOf(c, p.leave) * leaves.length))]++;
  }
  let max = 0;
  for (let k = 0; k < enters.length; k++) max = Math.max(max, enters[k], leaves[k]);
  return { enters, leaves, max };
}

/** The moment a seat at table `only` would play from, for a moment t on the floor: its comment at t, or (before it
 *  opened) its first; the comment's index in `comments`. -1: the table has nothing to say. */
export function seatFrom(c: FloorClock, only: number, t: number): number {
  const tb = c.tables[only];
  if (!tb.said.length) return -1;
  const k = countUpTo(tb.times, t) - 1;
  return tb.said[Math.max(0, k)];
}

/**
 * Who is in the room, kept up to date as the moment moves (the room's view of the floor: its audience is told only
 * about people whose presence changed). move(t) re-derives presence from t itself for everyone whose state can differ
 * from the last moment (an arrival or a departure between the two; for a long jump, everyone), so the flags after any
 * path of moves are exactly those of going straight to t, and a drag costs what changed, not the size of the floor.
 */
export class RoomAt {
  /** 1: in the room at t, per person */
  readonly here: Uint8Array;
  t = NaN;
  private byEnter: Int32Array; private byLeave: Int32Array;
  private enterAt: Float64Array; private leaveAt: Float64Array;
  private c: FloorClock;
  constructor(c: FloorClock) {
    this.c = c;
    const P = c.people;
    this.here = new Uint8Array(P.length);
    this.byEnter = Int32Array.from(P.keys()).sort((a, b) => P[a].enter - P[b].enter || a - b);
    this.byLeave = Int32Array.from(P.keys()).sort((a, b) => P[a].leave - P[b].leave || a - b);
    this.enterAt = Float64Array.from(this.byEnter, (i) => P[i].enter);
    this.leaveAt = Float64Array.from(this.byLeave, (i) => P[i].leave);
  }
  /** Go to t: `flip` hears each person whose presence changed. Returns how many people it looked at (for checks). */
  move(t: number, flip: (i: number, on: boolean) => void): number {
    const P = this.c.people, prev = this.t;
    let looked = 0;
    const apply = (i: number) => {
      looked++;
      const on = P[i].enter <= t && t < P[i].leave;
      if ((this.here[i] === 1) === on) return;
      this.here[i] = on ? 1 : 0;
      flip(i, on);
    };
    if (Number.isNaN(prev)) for (let i = 0; i < P.length; i++) apply(i);
    else {
      const lo = Math.min(prev, t), hi = Math.max(prev, t);
      const e0 = countUpTo(this.enterAt, lo), e1 = countUpTo(this.enterAt, hi), l0 = countUpTo(this.leaveAt, lo), l1 = countUpTo(this.leaveAt, hi);
      if ((e1 - e0) + (l1 - l0) > P.length / 2) for (let i = 0; i < P.length; i++) apply(i);
      else { for (let k = e0; k < e1; k++) apply(this.byEnter[k]); for (let k = l0; k < l1; k++) apply(this.byLeave[k]); }
    }
    this.t = t;
    return looked;
  }
}
