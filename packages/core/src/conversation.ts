// A table = one top-level thread. This module turns a comment tree into
// a play order with human turn-taking gaps, and seats its people.

export interface Node { id: number; by?: string; text?: string; dead?: boolean; deleted?: boolean; kids?: Node[] }

export interface Turn {
  id: number;
  by: string;
  depth: number;
  /** the comment this one answers (undefined for the table's opening comment) */
  replyTo?: number;
  /** silence before this turn, ms: a reply comes quickly; returning to an older branch takes a beat */
  gapMs: number;
}

const GAP = { reply: 220, sibling: 480, backtrack: 800 };   // brisk, like people who know each other

/**
 * Depth-first in HN's own order (kids arrive ranked best-first from the API),
 * which is exactly how people read the thread. Dead/deleted comments are skipped,
 * but their replies still play, since the conversation continued.
 */
export function playOrder(root: Node): Turn[] {
  const out: Turn[] = [];
  let prevDepth = -1;
  const walk = (n: Node, depth: number, parent?: Node) => {
    const speakable = n.by && n.text && !n.dead && !n.deleted;
    if (speakable) {
      const gapMs = out.length === 0 ? 0 : depth > prevDepth ? GAP.reply : depth === prevDepth ? GAP.sibling : GAP.backtrack;
      out.push({ id: n.id, by: n.by!, depth, replyTo: parent?.id, gapMs });
      prevDepth = depth;
    }
    for (const k of n.kids ?? []) walk(k, speakable ? depth + 1 : depth, speakable ? n : parent);
  };
  walk(root, 0);
  return out;
}

export interface Seating { seated: string[]; standing: string[] }

/** Seats go to people in order of first appearance; a big table grows a standing crowd. */
export function seat(turns: Turn[], seats = 8): Seating {
  const people: string[] = [];
  for (const t of turns) if (!people.includes(t.by)) people.push(t.by);
  return { seated: people.slice(0, seats), standing: people.slice(seats) };
}

/** Voice for a user at a table: their own first choice unless someone seated earlier already has it. */
export function voiceFor(user: string, taken: Set<number>, poolSize: number): number {
  let h = 2166136261;
  for (let i = 0; i < user.length; i++) { h ^= user.charCodeAt(i); h = Math.imul(h, 16777619); }
  const first = (h >>> 0) % poolSize;
  for (let i = 0; i < poolSize; i++) if (!taken.has((first + i) % poolSize)) return (first + i) % poolSize;
  return first;
}

/** Minutes of speech for a run of turns, at a conversational 160 words per minute plus gaps. */
export function minutes(turns: Turn[], wordsOf: (id: number) => number): number {
  const words = turns.reduce((n, t) => n + wordsOf(t.id), 0);
  return words / 160 + turns.reduce((n, t) => n + t.gapMs, 0) / 60000;
}
