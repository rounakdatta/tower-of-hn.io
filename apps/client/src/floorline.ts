// The floor's line, to the scrubber (FLOOR_TIMELINE): positions are the floor clock's compressed axis (0..1, a burst of
// comments wide, a quiet night narrow: floortime.ts); the comments are the floor's, in the order they were written;
// the card says how far in on the wall clock, who is in the room, how many tables are talking, whose comment it is.
// Under the line, arrivals rise and departures hang; warm notches across it are tables opening. Seated, the line is
// still the whole floor's (one clock for the room), with your table's stretch lit, and the keys and a release go to
// your table's comments.
import { uOf, tOf, latest, floorAt, sayIn, flowIn, stepFloor, seatFrom, floorText, type FloorClock } from './floortime.ts';
import type { ScrubModel } from './scrubber.ts';

export interface FloorModel extends ScrubModel {
  clock: FloorClock;
  /** the table it's tied to (seated), or undefined */
  only?: number;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function floorModel(c: FloorClock, only?: number): FloorModel {
  const N = c.comments.length;
  const starts = Float64Array.from(c.comments, (x) => uOf(c, x.at));
  const opens = Float64Array.from(c.opens, (t) => uOf(c, t));                  // (sorted: the clock keeps them so)
  const tb = only !== undefined ? c.tables[only] : undefined;
  let flows: { n: number; v: ReturnType<typeof flowIn> } | null = null;
  const at = (u: number) => (tb ? seatFrom(c, only!, tOf(c, u)) : Math.max(0, latest(c, tOf(c, u))));
  return {
    clock: c, only, total: 1, count: N, label: tb ? 'Floor timeline, at your table' : 'Floor timeline',
    about: 'The whole floor over time. People arrive with their first comment and leave an hour after their last: Hacker News doesn’t say when anyone stops reading.',
    at, start: (k) => starts[k] ?? 0,
    step: (u, n) => uOf(c, stepFloor(c, tOf(c, u), n, only)),
    home: () => (tb && tb.said.length ? uOf(c, tb.open) : starts[0] ?? 0),
    end: () => (tb && tb.said.length ? uOf(c, tb.last) : starts[N - 1] ?? 1),
    flow: (n) => {
      if (!flows || flows.n !== n) flows = { n, v: flowIn(c, n) };
      return { up: flows.v.enters, down: flows.v.leaves, max: flows.v.max };
    },
    ticks: () => opens,
    length: () => sayIn(c.end).replace(/ in$/, ''),
    aria: (u) => { const t = tOf(c, u); return { now: Math.floor(t), max: Math.floor(c.end), text: floorText(c, t) }; },
    card: (u) => {
      const t = tOf(c, u), f = floorAt(c, t), k = at(u);
      return { when: sayIn(t), around: ` · ${plural(f.people, 'person', 'people')} · ${plural(f.talking, 'table', 'tables')} talking`, k, by: c.comments[k]?.by ?? '' };
    },
    band: () => (tb && tb.said.length ? [uOf(c, tb.open), uOf(c, tb.last)] : null),
  };
}
