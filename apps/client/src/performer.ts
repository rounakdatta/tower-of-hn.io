// Acting: how the people at one table perform what's said there, every table alike. The director (the table you
// sit at, with a camera) and the mixer (every other table in earshot, as you walk the floor) each give a performer
// what is scheduled, and it turns that into faces, glances, gestures, stand-ups and reactions.
import * as THREE from 'three/webgpu';
import type { Sidecar, Clip, Turn } from './sync.ts';
import type { Crowd, Expr } from './people.ts';
import type { TableSpot } from './interior.ts';

export const FACE: Record<string, Partial<Expr>> = {
  angry: { brow: -0.25, browIn: -1, smile: -0.45, lid: 0.92, lidTilt: 0.8, flush: 0.55, teeth: 0.35, lean: 0.6 },
  stern: { brow: -0.15, browIn: -0.55, smile: -0.15, lid: 0.9, lidTilt: 0.3, lean: 0.35 },
  contemplative: { brow: 0.1, browAsym: 0.55, smile: 0.05, smileAsym: 0.2, lid: 0.84 },
  excited: { brow: 0.6, smile: 0.75, lid: 1.15, blush: 0.35, teeth: 0.55, lean: 0.4 },
  joyful: { brow: 0.3, smile: 0.9, lid: 0.95, blush: 0.3, teeth: 0.45, happy: 0.35 },
  mundane: { brow: 0, smile: 0.15, lid: 1 },
  nervous: { brow: 0.3, browIn: 0.6, smile: -0.05, smileAsym: 0.25, lid: 1.12, blinkRate: 2.2 },
  sad: { brow: 0.05, browIn: 0.9, smile: -0.55, lid: 0.78 },
  surprised: { brow: 1, browIn: 0.15, smile: 0.1, lid: 1.32 },
  tender: { brow: 0.15, browIn: 0.35, smile: 0.5, lid: 0.88, blush: 0.25 },
};

/** a line scheduled at a table: a clip of a comment, when it plays, who says it */
export interface Line { clip: Clip; side: Sidecar; turn: Turn; start: number; end: number; who: number }
export type Gesture = 'point' | 'palms' | 'shrug' | 'chin' | 'cross' | 'arms-up' | 'facepalm';
export interface Plan { S: number; A: number; start: number; end: number; stand: boolean; gesture: Gesture | null; gestureLen: number; laughEnd: boolean; E: string; I: number; ST: string; C: string[] }

/** vibe-testing only: ?force=angry|joke|question|uncertain|excited|sad|list|sarcasm makes every turn play that way */
const FORCE = new URLSearchParams(location.search).get('force');
export function tone(side: Sidecar) {
  if (!FORCE) return { E: side.emotion, I: side.intensity ?? 0.4, ST: side.stance, C: side.cues ?? [] };
  const m: Record<string, [string, string, number, string[]]> = {
    angry: ['angry', 'disagree', 0.9, ['frustrated']], joke: ['joyful', 'joke', 0.6, ['joke']], question: ['contemplative', 'question', 0.5, ['question']],
    uncertain: ['contemplative', 'inform', 0.4, ['uncertain']], excited: ['excited', 'agree', 0.85, []], sad: ['sad', 'inform', 0.6, ['frustrated']],
    list: ['mundane', 'inform', 0.4, ['list']], sarcasm: ['stern', 'disagree', 0.45, ['sarcasm']], retort: ['stern', 'retort', 0.7, []],
  };
  const [E, ST, I, C] = m[FORCE] ?? m.angry;
  return { E, I, ST, C };
}
/** a heated speaker starts getting up this long before their first word */
export const RISE_LEAD = 0.6;
export const smooth01 = (x: number) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };
/** A gesture as arm/head targets at phase k (0..1): it eases in, holds, and eases out. */
export function pose(g: Gesture, t: Expr, k: number, aim: number, flip: boolean) {
  const w = smooth01(k / 0.16) * (1 - smooth01((k - 0.84) / 0.16));
  switch (g) {
    case 'point': t.armR = 1.32 * w; t.spreadR = 0.06 * w; t.aimR = aim * w; t.armL = 0.12 * w; break;
    case 'palms': t.armL = t.armR = 0.62 * w; t.spreadL = t.spreadR = 0.38 * w; t.tilt = (flip ? -0.35 : 0.35) * w; break;
    case 'shrug': t.armL = t.armR = 0.38 * w; t.spreadL = t.spreadR = 0.95 * w; t.tilt = (flip ? -0.5 : 0.5) * w; t.brow = Math.max(t.brow, 0.6 * w); t.nod = -0.18 * w; break;
    case 'chin': t.armR = 2.25 * w; t.spreadR = -0.5 * w; t.tilt = 0.25 * w; t.lid = Math.min(t.lid, 0.85); t.nod = 0.12 * w; break;
    case 'cross': t.armL = t.armR = 0.8 * w; t.spreadL = t.spreadR = -0.62 * w; break;
    case 'arms-up': t.armL = t.armR = 2.65 * w; t.spreadL = t.spreadR = 0.3 * w; t.smile = Math.max(t.smile, 0.7); break;
    case 'facepalm': t.armR = 2.4 * w; t.spreadR = -0.34 * w; t.nod = 0.45 * w; break;
  }
}

const NONE = new Map<number, string>();

export class Performer {
  plans = new Map<number, Plan>();
  /** 0..1: how heated the table is right now (the director's frame closes in) */
  tension = 0;
  private gesture = new Map<number, number>();
  /** brows that flash up on a stressed syllable, per person (decays) */
  private flash = new Map<number, number>();
  private chairK = new Map<number, number>();
  /** heads looked at this frame (kept: acting runs every frame at every table in earshot) */
  private hFocus = new THREE.Vector3();
  private hTmp = new THREE.Vector3();

  constructor(private crowd: Crowd, public spot: TableSpot, private ix: (name: string) => number,
    private pushChair: (chair: number, k: number) => void = () => {}) {}

  /** Chairs back in, plans forgotten (we stopped watching this table). */
  reset() {
    for (const c of this.chairK.keys()) this.pushChair(c, 0);
    this.chairK.clear(); this.plans.clear(); this.gesture.clear(); this.flash.clear(); this.tension = 0;
  }

  authorOf(id: number) {
    const t = this.spot.table.turns.find((u) => u.id === id);
    return t ? this.ix(t.by) : undefined;
  }

  /** Each turn gets a plan once: who performs it, to whom, whether they stand, their signature gesture. */
  plan(s: Line, lines: Line[]): Plan {
    const clips = lines.filter((x) => x.turn.id === s.turn.id);
    const start = Math.min(s.start, ...clips.map((x) => x.start)), end = Math.max(s.end, ...clips.map((x) => x.end));
    let p = this.plans.get(s.turn.id);
    if (p) { p.start = Math.min(p.start, start); p.end = Math.max(p.end, end); return p; }
    const S = this.ix(s.turn.by);
    let A = s.turn.replyTo ? this.authorOf(s.turn.replyTo) ?? -1 : -1;
    if (A === S) A = -1;
    if (A < 0) {                                         // nobody to answer here: address whoever spoke last
      const prev = [...lines].reverse().find((x) => x.start < start && x.who !== S && x.who >= 0);
      A = prev?.who ?? -1;
    }
    const { E, I, ST, C } = tone(s.side);
    // a comeback that really stings gets them out of their chair, as a heated line does
    const heated = (E === 'angry' && I >= 0.45) || (I >= 0.82 && (ST === 'disagree' || ST === 'correct')) || (ST === 'retort' && I >= 0.62);
    let gesture: Gesture | null = null, len = 2.4;
    if (heated || ST === 'retort' || ((ST === 'disagree' || ST === 'correct') && I >= 0.5)) gesture = 'point';
    else if (C.includes('uncertain')) gesture = 'shrug';
    else if (C.includes('question') || ST === 'question') gesture = 'palms';
    else if (E === 'excited' && I >= 0.45) { gesture = 'arms-up'; len = 1.4; }
    else if (C.includes('frustrated') || E === 'sad') gesture = 'facepalm';
    else if (E === 'contemplative') { gesture = 'chin'; len = Math.max(2.4, Math.min(6, end - start - 0.4)); }
    else if (ST === 'agree' || ST === 'praise') gesture = 'palms';
    p = { S, A, start, end, stand: heated && S >= 0 && !!this.crowd.people[S]?.pose.seated, gesture, gestureLen: len,
      laughEnd: ST === 'joke' || C.includes('joke'), E, I, ST, C };
    this.plans.set(s.turn.id, p);
    return p;
  }

  /**
   * One frame of acting at this table: `lines` are what's scheduled here, `cur` the one being said. `upcoming`: the
   * stances of whoever speaks next (they foreshadow); `onCamera`/`cam`: the director's shot (whoever is in it cheats out).
   */
  animate(lines: Line[], cur: Line | null, at: number, dt: number, o: { upcoming?: Map<number, string>; onCamera?: number; cam?: THREE.Vector3 } = {}) {
    if (!this.spot) return;
    // the turn in play: the current clip's, or the next one about to start (people turn before they speak)
    const next = cur ? null : lines.find((x) => x.start > at && x.start - at < 0.7) ?? null;
    const live = cur ?? next;
    const plan = live ? this.plan(live, lines) : null;
    const inTurn = !!plan && at >= plan.start - 0.7 && at <= plan.end + 0.6;
    const speaking = cur?.who ?? -1;
    const env = cur ? (cur.clip.env[Math.floor((at - cur.start) * 30)] ?? 0) / 255 : 0;
    const shape = cur ? ((cur.clip.shape[Math.floor((at - cur.start) * 30)] ?? 127) / 127.5 - 1) : 0;
    const focus = speaking >= 0 ? speaking : plan?.S ?? -1;
    const focusHead = focus >= 0 ? this.crowd.headPos(focus, this.hFocus) : null;
    const voice = cur ? FACE[tone(cur.side).E] ?? FACE.mundane : FACE.mundane;
    this.tension = plan && inTurn && (plan.stand || (plan.E === 'angry' && plan.I >= 0.45)) ? Math.min(1, 0.5 + plan.I * 0.6) : 0;
    const clipNo = cur ? cur.side.clips.indexOf(cur.clip) : -1, clipT = cur ? at - cur.start : 0;
    // a heated reply about to start: its speaker is already getting up while the other one finishes
    const nextUp = lines.find((x) => x.start > at && x.start - at < RISE_LEAD + 0.1 && x.side.clips[0] === x.clip && x.turn.id !== live?.turn.id);
    const riser = nextUp ? this.plan(nextUp, lines) : null;
    // who speaks next? if their reply pushes back, they're already narrowing their eyes
    const upcoming = o.upcoming ?? NONE;
    for (const seat of this.spot.seats) {
      const i = this.ix(seat.name), t = this.crowd.target(i);
      if (!t || i < 0 || this.crowd.isWalking(i)) continue;
      this.crowd.active.add(i);                         // (someone who just walked over joins in)
      // everyone starts the frame as a calm listener, turned to whoever has the floor
      t.open = 0; t.shape = 0; t.turn = 0; t.stand = 0; t.bounce = 0;
      t.armL = 0; t.armR = 0; t.spreadL = 0; t.spreadR = 0; t.aimR = 0;
      t.lean = 0.05; t.brow = 0; t.smile = 0.15; t.lid = 1;
      t.browIn = 0; t.browAsym = 0; t.smileAsym = 0; t.happy = 0; t.lidTilt = 0; t.blinkRate = 0; t.blush = 0; t.teeth = 0; t.flush = 0;
      // idle life: now and then a small private smile, a brow that lifts at something, never in step with anyone
      if (Math.sin(at * 0.13 + i * 1.7) > 0.93) { t.smile = 0.42; t.smileAsym = (i % 2 ? 0.25 : -0.25); }
      if (Math.sin(at * 0.19 + i * 2.9) > 0.96) t.browAsym = i % 3 ? 0.35 : -0.35;
      t.tilt = Math.sin(at * 0.4 + i) * 0.08;
      t.nod = Math.sin(at * 0.9 + i * 1.7) * 0.03;
      t.yaw = focusHead && focus !== i ? this.crowd.yawTo(i, focusHead) : Math.sin(at * 0.3 + i) * 0.3;
      if (focusHead && focus !== i) t.nod += this.crowd.pitchTo(i, focusHead);              // eye-lines: look up at someone standing
      const performing = !!plan && inTurn && i === plan.S;
      if (performing) {
        // square up to the person being answered: shoulders part of the way, the head the rest
        const aHead = plan.A >= 0 ? this.crowd.headPos(plan.A, this.hTmp) : null;
        const total = aHead ? this.crowd.yawTo(i, aHead) : Math.sin(at * 0.35 + i) * 0.45;
        t.turn = Math.max(-0.85, Math.min(0.85, total * 0.55));
        t.yaw = total - t.turn;
        if (aHead) t.nod += this.crowd.pitchTo(i, aHead);
        const em = FACE[plan.E] ?? FACE.mundane;
        t.lean = (em.lean ?? 0.15) + (plan.stand ? 0.22 : 0);
        if (plan.stand) {
          // getting up: lean over the table, push off it with both hands, rise, straighten
          const rise = (at - (plan.start - RISE_LEAD)) / 0.85;
          t.stand = smooth01(rise);
          const push = rise > 0 && rise < 1 ? Math.sin(Math.PI * Math.min(1, rise * 1.15)) : 0;
          t.lean += push * 0.55; t.armL = t.armR = push * 0.55; t.spreadL = t.spreadR = push * 0.12;
        }
        if (at < plan.start) { t.lean += 0.08; t.brow = 0.15; }                           // the breath before speaking
        const gk = (at - plan.start - 0.25) / plan.gestureLen;
        if (plan.gesture && gk >= 0 && gk <= 1) pose(plan.gesture, t, gk, t.yaw, this.crowd.seed(i, 3) > 0.5);
        else if (i === speaking) {
          // beats on loud syllables, bigger when heated
          const g = this.gesture.get(i) ?? 0;
          if (env > 0.7 && g < 0.15) this.gesture.set(i, 1);
          const gv = Math.max(0, g - dt * 1.8);
          this.gesture.set(i, gv);
          const amp = 0.55 + plan.I * 0.6 + (plan.E === 'angry' ? 0.3 : 0);
          const right = this.crowd.seed(i, Math.floor(at * 0.5)) > 0.5;
          t.armR = (right ? gv : gv * 0.3) * amp; t.armL = (right ? gv * 0.3 : gv) * amp;
          t.spreadR = t.spreadL = gv * 0.15;
        }
        // a list: a hand comes up on each new point, alternating
        if (plan.C.includes('list') && i === speaking && clipT < 0.7 && !(plan.gesture && gk >= 0 && gk <= 1)) {
          const w = Math.sin(Math.PI * clipT / 0.7);
          if (clipNo % 2) { t.armL = 0.85 * w; t.spreadL = 0.3 * w; } else { t.armR = 0.85 * w; t.spreadR = 0.3 * w; }
        }
        if (plan.E === 'sad') { t.lean -= 0.2; t.nod += 0.22; t.lid = Math.min(t.lid, 0.8); }          // slumped
        if (plan.laughEnd && at > plan.end - 1.1) { t.bounce = 1; t.smile = 1; t.lid = 0.6; t.happy = 1; t.teeth = 1; }
      }
      if (riser?.stand && i === riser.S && !performing && i !== speaking) {
        const aHead = riser.A >= 0 ? this.crowd.headPos(riser.A, this.hTmp) : null;
        const total = aHead ? this.crowd.yawTo(i, aHead) : t.yaw;
        t.turn = Math.max(-0.85, Math.min(0.85, total * 0.55));
        t.yaw = total - t.turn;
        if (aHead) t.nod = this.crowd.pitchTo(i, aHead);
        const rise = (at - (riser.start - RISE_LEAD)) / 0.85;
        t.stand = smooth01(rise);
        const push = rise > 0 && rise < 1 ? Math.sin(Math.PI * Math.min(1, rise * 1.15)) : 0;
        t.lean = 0.3 + push * 0.55; t.armL = t.armR = push * 0.55; t.spreadL = t.spreadR = push * 0.12;
        t.brow = -0.2; t.browIn = -0.95; t.lidTilt = 0.75; t.lid = 0.9; t.smile = -0.3; t.flush = 0.45; t.teeth = 0.4;
        continue;
      }
      if (i === speaking) {
        t.open = Math.min(1, env * 1.15);
        t.shape = shape;
        // stressed syllables flash the brows up (a beat, not a held look)
        const f0 = this.flash.get(i) ?? 0;
        const f = env > 0.74 && f0 < 0.2 ? 1 : Math.max(0, f0 - dt * 2.8);
        this.flash.set(i, f);
        t.brow = (voice.brow ?? 0) + env * 0.15 + f * 0.32 + (t.brow > 0.3 ? t.brow * 0.5 : 0);
        t.browIn = voice.browIn ?? 0; t.browAsym = voice.browAsym ?? 0; t.smileAsym = voice.smileAsym ?? 0;
        t.lidTilt = voice.lidTilt ?? 0; t.blush = voice.blush ?? 0; t.blinkRate = voice.blinkRate ?? 0;
        t.flush = (voice.flush ?? 0) * (0.5 + (plan?.I ?? 0.5) * 0.7);
        // teeth on loud syllables: a grin when pleased, a snarl when angry
        t.teeth = (voice.teeth ?? 0) * Math.min(1, env * 1.8);
        t.happy = (voice.happy ?? 0) * Math.min(1, env * 2);
        t.smile = plan?.laughEnd && plan && at > plan.end - 1.1 ? 1 : voice.smile ?? 0.15;
        t.lid = voice.lid ?? 1;
        t.nod += Math.sin(at * 7.3) * env * 0.18;
        if (plan) {
          const flip = this.crowd.seed(i, 5) > 0.5 ? 1 : -1, last = cur!.side.clips.indexOf(cur!.clip) === cur!.side.clips.length - 1;
          // sarcasm: a smirk and one doubting brow; a question rises at its end; a joke breaks into a grin
          if (plan.C.includes('sarcasm')) { t.smileAsym = 0.75 * flip; t.browAsym = 0.65 * flip; t.smile = Math.max(t.smile, 0.25); }
          // a comeback: eyes narrowed, a half smile that isn't friendly, leaning in at the one they're answering
          if (plan.ST === 'retort') { t.lidTilt = Math.max(t.lidTilt, 0.55); t.lid = Math.min(t.lid, 0.88); t.smileAsym = 0.6 * flip; t.smile = Math.max(t.smile, 0.12); t.browIn = Math.min(t.browIn, -0.45); t.lean += 0.14; }
          if ((plan.ST === 'question' || plan.C.includes('question')) && last && at > cur!.end - 1.3) { t.brow += 0.45; t.browAsym += 0.25 * flip; t.tilt += 0.22 * flip; }
          if (plan.laughEnd && at > plan.end - 1.1) { t.happy = 1; t.teeth = 1; t.open = Math.max(t.open, 0.35); t.blush = 0.5; }
          if (plan.E === 'angry' && env > 0.55) t.teeth = Math.max(t.teeth, 0.85);
        }
        if (!performing && plan && plan.S >= 0) t.yaw = this.crowd.yawTo(i, this.crowd.headPos(plan.S, this.hTmp));   // a quoted line, said to its quoter
        continue;
      }
      if (performing) continue;
      // listeners react to what's being said, and to whom
      if (plan && inTurn) {
        const strong = plan.I >= 0.6, pushback = plan.ST === 'disagree' || plan.ST === 'correct' || plan.ST === 'retort' || plan.E === 'angry';
        if (plan.ST === 'retort' && at > plan.start + 0.4) {
          // a comeback lands: its target is stung; everyone else goes "oooh" (brows up, a half smile, back in their seats)
          if (i === plan.A) { t.brow = -0.1; t.browIn = -0.75; t.lidTilt = 0.5; t.flush = 0.35; t.smile = -0.25; t.lean = -0.18; }
          else { t.brow = 0.55; t.lid = 1.16; t.smile = 0.22; t.smileAsym = this.crowd.seed(i, 6) > 0.5 ? 0.35 : -0.35; t.lean = -0.14; }
        } else if (i === plan.A) {
          if (pushback && plan.E === 'angry' && strong) { t.brow = 0.55; t.browIn = 0.35; t.lid = 1.22; t.lean = -0.3; t.smile = -0.1; t.flush = 0.2; }  // taken aback
          else if (pushback) { t.brow = -0.15; t.browIn = -0.6; t.lidTilt = 0.3; t.smile = -0.15; t.smileAsym = -0.2; t.lean = -0.12; if (plan.ST === 'correct' && !strong) pose('cross', t, 0.5, 0, false); }
          else if (plan.ST === 'agree' || plan.ST === 'praise') { t.smile = 0.65; t.happy = 0.3; t.blush = 0.25; t.nod += Math.max(0, Math.sin(at * 2.4 + i)) * 0.14; }
          else if (plan.ST === 'question' || plan.C.includes('question')) {
            t.tilt = 0.35; t.brow = 0.25;
            const w = smooth01((at - (plan.end - 1.6)) / 0.45);                        // the question lands: they start thinking
            if (w > 0) { t.armR = 2.2 * w; t.spreadR = -0.5 * w; t.nod += 0.1 * w; t.gazeY = 0; }
          }
        } else if (plan.E === 'angry' && strong) { t.brow = 0.45; t.browIn = 0.3; t.lid = 1.15; t.lean = -0.2; }                // whoa
        else if (plan.ST === 'joke' || plan.E === 'joyful') { t.smile = 0.6; t.happy = this.crowd.seed(i, 9) < 0.5 ? 0.35 : 0; }
        else if (plan.E === 'sad' || plan.E === 'tender') { t.browIn = 0.5; t.smile = plan.E === 'tender' ? 0.3 : -0.05; t.tilt += 0.12; }   // sympathy
        else if (plan.ST === 'question') { t.tilt = 0.18; t.browAsym = this.crowd.seed(i, 4) > 0.5 ? 0.3 : -0.3; }
        else if (plan.ST === 'agree') t.nod += Math.max(0, Math.sin(at * 1.8 + i)) * 0.08;
        else if (plan.I >= 0.6 || plan.C.includes('story')) { t.lean = 0.24; t.brow = Math.max(t.brow, 0.12); }           // leaning in
        // an insult lands: the table gasps; its target goes stony
        const k = at - plan.start;
        if (plan.C.includes('insult') && k > 0.6 && k < 2.6) {
          const w = smooth01((k - 0.6) / 0.25) * (1 - smooth01((k - 2.2) / 0.4));
          if (i === plan.A) { t.brow = -0.2 * w; t.browIn = -0.9 * w; t.lidTilt = 0.6 * w; t.flush = 0.4 * w; t.smile = -0.35 * w; t.lid = 1 - 0.1 * w; }
          else { t.brow = Math.max(t.brow, 0.85 * w); t.open = 0.32 * w; t.shape = 0.9 * w; t.lean = -0.25 * w; t.lid = 1 + 0.25 * w; }
        }
        // praise: the one praised lights up, a hand to the chest
        if ((plan.ST === 'praise' || plan.C.includes('praise')) && i === plan.A && k > 0.4) { t.smile = 0.85; t.blush = 0.6; t.happy = 0.5; t.armR = 1.25; t.spreadR = -0.62; t.nod += 0.12; }
        if (plan.laughEnd && at > plan.end - 1.1 && this.crowd.seed(i, 7) < 0.65) { t.bounce = 1; t.smile = 1; t.happy = 1; t.teeth = 0.8; t.open = Math.max(t.open, 0.3); t.blush = 0.4; }
      }
      const coming = upcoming.get(i);
      if ((coming === 'disagree' || coming === 'correct') && t.brow >= 0 && i !== plan?.A) {
        // foreshadowing: whoever is about to push back already doubts it, one brow up, the mouth pulled aside
        const flip = this.crowd.seed(i, 5) > 0.5 ? 1 : -1;
        t.browAsym = 0.55 * flip; t.browIn = -0.3; t.lid = 0.85; t.smileAsym = -0.2 * flip;
        if (Math.sin(at * 0.8 + i * 2.1) > 0.93) t.yaw += Math.sin(at * 11) * 0.14;                     // a small head shake
      }
    }
    // whoever is in shot "cheats out", as actors do: the face angles toward the lens, the eyes stay on whoever
    // they're talking to (a toy head seen side-on has no face to read)
    let cheat = 0;
    const ci = o.onCamera ?? -1, ct = ci >= 0 && o.cam ? this.crowd.target(ci) : undefined;
    if (ct && o.cam && this.crowd.people[ci]?.pose.seated !== undefined) {
      const h = this.crowd.headPos(ci, this.hTmp), cam = o.cam, pose = this.crowd.people[ci].pose;
      let d = Math.atan2(cam.x - h.x, cam.z - h.z) - (pose.facing + ct.turn + Math.max(-1.1, Math.min(1.1, ct.yaw)));
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) < 1.5) { cheat = Math.max(-0.5, Math.min(0.5, d * 0.4)); ct.yaw += cheat; }
    }
    // eyes: they get there before the head does (and cover what the neck can't), with small darts now and then
    for (const seat of this.spot.seats) {
      const i = this.ix(seat.name), t = this.crowd.target(i);
      if (!t || i < 0 || this.crowd.isWalking(i)) continue;
      const excess = t.yaw - Math.max(-1.1, Math.min(1.1, t.yaw));
      const dart = Math.sin(Math.floor(at * 0.8 + i * 0.37) * 12.9898 + i) * 0.16;
      t.gaze = Math.max(-1, Math.min(1, t.yaw * 0.4 + excess * 1.6 + dart - (i === ci ? cheat * 2.2 : 0)));
      t.gazeY = Math.max(-1, Math.min(1, -t.nod * 0.35 + dart * 0.4));
      if (!plan || i !== plan.S) continue;
      const k = at - plan.start, flip = this.crowd.seed(i, 5) > 0.5 ? 1 : -1;
      // uncertain: they look up and off to find the words
      if (plan.C.includes('uncertain') && k > -0.35 && k < 0.75) { const w = Math.sin(Math.PI * (k + 0.35) / 1.1); t.gaze = 0.65 * flip * w; t.gazeY = 0.85 * w; t.tilt += 0.2 * w * flip; }
      // sarcasm: an eye-roll, once, early on
      if (plan.C.includes('sarcasm') && k > 1.1 && k < 1.8) { const u = (k - 1.1) / 0.7; t.gazeY = Math.sin(Math.PI * u); t.gaze = Math.cos(Math.PI * u) * 0.8 * flip; t.nod -= 0.15 * Math.sin(Math.PI * u); }
    }
  }

  /** Chairs follow whoever stands up out of them. */
  chairs() {
    for (const seat of this.spot.seats ?? []) {
      if (seat.chair === undefined) continue;
      const i = this.ix(seat.name), k = i >= 0 ? this.crowd.people[i].expr.stand : 0;
      const last = this.chairK.get(seat.chair) ?? 0;
      if (Math.abs(k - last) < 0.004) continue;
      this.chairK.set(seat.chair, k);
      this.pushChair(seat.chair, k);
    }
  }
}
