// How a table feels, from how its comments are delivered (the voice worker's tags: emotion and intensity, carried in
// each voiced turn). One palette for the signs, the map, the lamps and the subtitles, so a colour means one thing
// everywhere: red is a row, yellow is laughter, blue is people thinking aloud.
import type { Turn } from './sync.ts';

export type Mood = 'heated' | 'tense' | 'playful' | 'upbeat' | 'thoughtful' | 'somber' | 'warm' | 'calm';

export const MOOD: Record<Mood, { color: string; word: string; rgb: [number, number, number] }> = {
  heated: { color: '#ff5a4e', word: 'heated', rgb: [1, 0.35, 0.3] },
  tense: { color: '#ff9b4a', word: 'tense', rgb: [1, 0.6, 0.3] },
  playful: { color: '#f7d154', word: 'laughing', rgb: [1, 0.85, 0.4] },
  upbeat: { color: '#7fdc8c', word: 'excited', rgb: [0.55, 0.95, 0.6] },
  thoughtful: { color: '#8ab4ff', word: 'thoughtful', rgb: [0.6, 0.75, 1] },
  somber: { color: '#a78bfa', word: 'sombre', rgb: [0.7, 0.6, 1] },
  warm: { color: '#ff9ecb', word: 'warm', rgb: [1, 0.65, 0.82] },
  calm: { color: '#cdbfb1', word: 'calm', rgb: [1, 0.9, 0.8] },
};

/** the mood a single delivery belongs to */
export function moodOf(emotion?: string, stance?: string): Mood {
  if (stance === 'retort') return 'heated';
  switch (emotion) {
    case 'angry': return 'heated';
    case 'stern': case 'nervous': return 'tense';
    case 'joyful': return 'playful';
    case 'excited': case 'surprised': return 'upbeat';
    case 'contemplative': return 'thoughtful';
    case 'sad': return 'somber';
    case 'tender': return 'warm';
    default: return 'calm';
  }
}

/** a word for how a line is being said, for a sign or a subtitle (a retort is a comeback, whatever its tone) */
export function deliveryWord(emotion?: string, stance?: string, intensity = 0.4) {
  if (stance === 'retort') return 'comeback';
  const w: Record<string, string> = { angry: intensity >= 0.7 ? 'furious' : 'angry', stern: 'firm', nervous: 'unsure', joyful: 'amused', excited: 'excited',
    surprised: 'surprised', contemplative: 'thinking aloud', sad: 'sad', tender: 'kind', mundane: '' };
  return w[emotion ?? ''] ?? '';
}

/** A table's mood from what's been voiced there: the strongest feeling, if it's more than a passing one. */
export function tableMood(turns: Turn[]): { mood: Mood; heat: number } {
  const score: Partial<Record<Mood, number>> = {};
  let total = 0;
  for (const u of turns) {
    const e = u.v?.[2];
    if (!e) continue;
    const w = 0.5 + (u.v?.[3] ?? 0.4);
    total += w;
    const m = moodOf(e);
    score[m] = (score[m] ?? 0) + w;
  }
  if (!total) return { mood: 'calm', heat: 0 };
  let best: Mood = 'calm', bs = 0;
  for (const [m, s] of Object.entries(score) as [Mood, number][]) if (m !== 'calm' && s > bs) { best = m; bs = s; }
  const heat = ((score.heated ?? 0) + 0.5 * (score.tense ?? 0)) / total;
  // a feeling has to carry a fair share of the table to name it (one sharp line in a calm thread doesn't)
  return { mood: bs >= total * 0.28 || (best === 'heated' && bs >= 1.2) ? best : 'calm', heat };
}

/** Two people going back and forth (at least three turns between them, each answering the other): a row. */
export function rowOf(turns: Turn[]): [string, string] | null {
  const byId = new Map(turns.map((u) => [u.id, u]));
  const pairs = new Map<string, number>();
  for (const u of turns) {
    const p = u.replyTo !== undefined ? byId.get(u.replyTo) : undefined;
    if (!p || p.by === u.by) continue;
    const k = [u.by, p.by].sort().join('\u0000');
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  let best: string | null = null, n = 0;
  for (const [k, c] of pairs) if (c > n) { best = k; n = c; }
  return best && n >= 3 ? best.split('\u0000') as [string, string] : null;
}
