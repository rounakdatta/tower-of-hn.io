// Floors shaped like Hacker News's, for the floor timeline's tests and benches (not part of the app): deterministic,
// any size. Pure.
import type { TFloor, TTurn } from './floortime.ts';

/** a deterministic random source (xorshift) */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * A floor shaped like Hacker News: `tables` top-level threads opening over the first hours, comments arriving in a
 * burst that decays over `hours`, people who mostly say one thing and a few regulars at several tables. Ids rise with
 * time (as on HN), except that a table's turns are listed in thread order (a reply after its parent, not by time).
 */
export function hnFloor(o: { people: number; tables: number; comments?: number; hours?: number; seed?: number; untimed?: number }): TFloor {
  const r = rng(o.seed ?? 7), hours = o.hours ?? 18, N = o.comments ?? Math.max(o.tables, Math.round(o.people * 1.6));
  const span = hours * 3600;
  // moments: a burst early (most comments in the first few hours), a long tail
  const moments = Array.from({ length: N }, () => 600 + span * Math.pow(r(), 2.2)).sort((a, b) => a - b);
  // the first `tables` comments (in time) open the tables; later ones join a table, the busy ones more often
  const weights = Array.from({ length: o.tables }, (_, k) => 1 / Math.pow(k + 1, 1.1));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const pick = () => { let x = r() * wsum; for (let k = 0; k < weights.length; k++) { x -= weights[k]; if (x <= 0) return k; } return weights.length - 1; };
  const turns: TTurn[][] = Array.from({ length: o.tables }, () => []);
  let id = 1_000_000, nextNew = 0;
  const regulars = Math.max(1, Math.floor(o.people * 0.08));
  for (let k = 0; k < N; k++) {
    id += 1 + Math.floor(r() * 3);
    const table = k < o.tables ? k : pick();
    // a new face while there are people left to meet, else someone back (a regular, mostly)
    const who = nextNew < o.people && (k < o.tables || r() < o.people / N + 0.15) ? `u${nextNew++}` : `u${Math.floor(r() * Math.min(nextNew || 1, regulars))}`;
    const at = o.untimed && r() < o.untimed ? undefined : Math.floor(moments[k]);
    const tt = turns[table];
    turns[table].push({ id, by: who, at, replyTo: tt.length ? tt[Math.floor(r() * tt.length)].id : undefined });
  }
  // thread order: a table lists replies after their parents (here: shuffled within the table, the opener first)
  return { tables: turns.map((tt, k) => ({ root: tt[0]?.id ?? k, turns: tt.length > 2 ? [tt[0], ...tt.slice(1).sort(() => r() - 0.5)] : tt })).filter((t) => t.turns.length) };
}

