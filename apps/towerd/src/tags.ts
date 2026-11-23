// How each comment should be performed: delivery, stance, intensity and cues, judged by Claude Haiku in context, one
// call for up to eight comments of a table. towerd tags; voice runners only voice (they guess from the words when a
// comment has no tags, as when no model is reachable).
export const EMOTIONS = ['angry', 'contemplative', 'excited', 'joyful', 'mundane', 'nervous', 'sad', 'stern', 'surprised', 'tender'];
export const STANCES = ['agree', 'disagree', 'correct', 'question', 'joke', 'inform', 'expand', 'praise', 'retort'];
export const CUES = ['question', 'uncertain', 'joke', 'sarcasm', 'frustrated', 'insult', 'praise', 'list', 'story'];

export interface Tag { e: string; s: string; i: number; c: string[] }
export interface Taggable {
  id: number; by: string; parentBy?: string; parentSaid?: string; back?: boolean;
  segments: { kind: string; text?: string }[];
}

export function tagPrompt(batch: Taggable[]) {
  const lines = batch.map((j) => {
    const said = j.segments.filter((s) => s.kind === 'say' || s.kind === 'quote').map((s) => s.text ?? '').join(' ').slice(0, 600);
    const to = j.parentBy;
    const who = j.back && to ? `${j.by} replying back to ${to} (who had answered ${j.by})` : `${j.by} replying to ${to || 'the story'}`;
    const ctx = j.parentSaid ? ` [answering: "${j.parentSaid.slice(0, 200)}"]` : '';
    return `${j.id} | ${who}${ctx}: ${said}`;
  });
  return 'Consecutive comments from one Hacker News thread, about to be performed by actors seated at a table. For each comment, ' +
    `judge: e = how the actor should deliver it (one of: ${EMOTIONS.join(', ')}); ` +
    `s = its stance toward what it replies to (one of: ${STANCES.join(', ')}); ` +
    'i = intensity from 0.0 (flat, neutral) to 1.0 (heated, emphatic, shouting); ' +
    `c = any cues that apply (from: ${CUES.join(', ')}). ` +
    'Read each comment against what it answers. ' +
    'retort is a comeback: hitting back at someone who challenged, dismissed or criticised them, pointed or cutting ' +
    '(most often a reply back in a back-and-forth); a calm, friendly reply back is not a retort. ' +
    "joyful is happy, amused, delighted; excited is enthusiastic, eager, can't-wait; sad is disappointed, wistful, grieving; " +
    'tender is warm, kind, consoling; nervous is worried or unsure; surprised is astonished. ' +
    'Dry snark is stern or mundane with the sarcasm cue; a correction is stern; musing is contemplative; jokes are joyful. ' +
    'Use angry only when the writing is genuinely heated (insults, outrage, exasperation), and then give a high intensity. ' +
    'Most comments are calm: keep intensity low unless the words really carry feeling. ' +
    'Reply with JSON only: {"<id>": {"e": "...", "s": "...", "i": 0.0, "c": []}, ...}\n\n' + lines.join('\n');
}

/** The model's answer, checked: only known words survive, intensity is clamped, a bad entry is dropped. */
export function parseTags(text: string): Map<number, Tag> {
  const out = new Map<number, Tag>();
  let raw: unknown;
  try { raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return out; }
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(k), t = v as { e?: unknown; s?: unknown; i?: unknown; c?: unknown };
    if (!Number.isInteger(id) || !t || typeof t !== 'object' || !EMOTIONS.includes(String(t.e))) continue;
    const i = Number(t.i);
    out.set(id, {
      e: String(t.e),
      s: STANCES.includes(String(t.s)) ? String(t.s) : 'inform',
      i: Number.isFinite(i) ? Math.max(0, Math.min(1, i)) : 0.4,
      c: Array.isArray(t.c) ? t.c.filter((x): x is string => typeof x === 'string' && CUES.includes(x)) : [],
    });
  }
  return out;
}
