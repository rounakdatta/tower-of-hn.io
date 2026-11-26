// A conversation's timeline: where every comment falls in the time it takes to hear it, when each person joins (their
// first word here), and the way back from a point on the line to a comment. The axis is the narration itself, in the
// order the table plays it (the thread as HN ranks it, each reply after the comment it answers), so a point on the
// line is a moment you can listen from, the playhead only ever moves forward while it plays, and the hours of quiet
// between comments on HN take no room. Pure: no DOM, no three.js.

/** what the timeline needs of a turn (sync.ts's Turn has all of it) */
export interface Said { id: number; by: string; depth: number; replyTo?: number; gapMs: number; v?: [string, number, ...unknown[]] }

export interface Moment {
  /** the turn's index in the table's play order */
  k: number;
  id: number; by: string; depth: number;
  /** seconds into the conversation: when it starts, and when it's said */
  start: number; end: number;
  /** people in the conversation once it has been said (the opener counts as the first) */
  joined: number;
  /** someone saying their first word here */
  first: boolean;
}

export interface Line {
  moments: Moment[];
  /** seconds, start to finish */
  total: number;
  /** the moments that start a new branch (a direct reply to the opening comment): where the conversation turns */
  branches: number[];
  /** different people in the conversation */
  people: number;
}

/** a turn not voiced yet lasts what the table's voiced turns last on average (or 16 s, a typical comment) */
const GUESS = 16;

/** The conversation laid on its own clock: each turn's start and end, who joins when. */
export function lineOf(turns: Said[]): Line {
  const voiced = turns.filter((u) => u.v && u.v[1] > 0);
  const guess = voiced.length ? voiced.reduce((a, u) => a + u.v![1], 0) / voiced.length : GUESS;
  const seen = new Set<string>(), moments: Moment[] = [], branches: number[] = [];
  let t = 0;
  turns.forEach((u, k) => {
    if (k) t += u.gapMs / 1000;
    const d = u.v && u.v[1] > 0 ? u.v[1] : guess, first = !seen.has(u.by);
    seen.add(u.by);
    moments.push({ k, id: u.id, by: u.by, depth: u.depth, start: t, end: t + d, joined: seen.size, first });
    if (u.depth === 1) branches.push(k);
    t += d;
  });
  return { moments, total: t, branches, people: seen.size };
}

/** The turn playing at `t` seconds in (the last one, past the end; the first, before the start). Binary search. */
export function turnAt(line: Line, t: number): number {
  const m = line.moments;
  if (!m.length) return -1;
  let lo = 0, hi = m.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (m[mid].start <= t) lo = mid; else hi = mid - 1; }
  return lo;
}

/** People in the conversation `t` seconds in: everyone who has started speaking by then. */
export function joinedAt(line: Line, t: number) {
  const k = turnAt(line, t);
  return k < 0 ? 0 : line.moments[k].joined;
}

/** How many people join in each of `n` equal stretches of the line (the histogram under it), and the busiest. */
export function joinsIn(line: Line, n: number): { bins: Uint16Array; max: number } {
  const bins = new Uint16Array(Math.max(1, n));
  if (line.total > 0) for (const m of line.moments) if (m.first) bins[Math.min(bins.length - 1, Math.floor((m.start / line.total) * bins.length))]++;
  let max = 0;
  for (const b of bins) if (b > max) max = b;
  return { bins, max };
}

/** "12 min in", "1 h 04 min in", "40 s in": how far in, as said aloud. Never rounded up (59.9 s is "59 s"). */
export function sayIn(t: number) {
  const s = Math.max(0, Math.floor(t));
  if (s < 60) return `${s} s in`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min in`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min in`;
}

/** the slider's value as a screen reader says it: "12 min in, 87 people, comment by tptacek" */
export function valueText(line: Line, t: number, others = 0) {
  const k = turnAt(line, t);
  if (k < 0) return 'Nothing said yet';
  const n = line.moments[k].joined + others;
  return `${sayIn(t)}, ${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}, comment by ${line.moments[k].by}`;
}

/** The moment `step` comments away from the one at `t` (arrow keys: one; with Shift: ten), clamped to the line. */
export function stepFrom(line: Line, t: number, step: number) {
  const k = turnAt(line, t);
  if (k < 0) return 0;
  const to = Math.max(0, Math.min(line.moments.length - 1, k + step));
  return line.moments[to].start;
}

/** ?t= as people write it: seconds ("750"), or "12m30s", "1h4m", "90s". Null if it isn't a time. */
export function parseT(s: string | null | undefined): number | null {
  if (!s) return null;
  const x = s.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(x)) return Number(x);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(x);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** ...and the other way, for a link to share: whole seconds, as "12m30s" (or "45s", "1h4m") */
export function formatT(t: number) {
  const s = Math.max(0, Math.floor(t)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${r || (!h && !m) ? `${r}s` : ''}`;
}
