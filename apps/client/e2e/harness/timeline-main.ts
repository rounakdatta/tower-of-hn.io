// The timeline on its own, mounted the way main.ts mounts it (the same host calls, over the app's own letterbox
// markup), for the e2e tests: no 3D room, so it runs the same in Chromium, Firefox and WebKit, on desktops and phones.
// A conversation as long as the 1Password thread (271 turns, 179 people, nearly two hours); the host records what it is
// told, stamped with the animation frame it came in, so a test can say what the timeline asked of it and when.
import { Scrubber, type ScrubberHost } from '../../src/scrubber.ts';
import { lineOf, valueText, type Said } from '../../src/timeline.ts';

const N = 271, PEOPLE = 179, OTHERS = 12;
/** the opener's replies and how many answers grew under each (270 in all; the biggest branch first) */
const BRANCHES = [88, 61, 47, 33, 24, 17];
const SAY = [
  'The borrow checker is not the reason it compiles; it is the reason it is correct, which is a different thing.',
  'I disagree: LLVM is why it is fast, and everything else is polish on top of that.',
  'We tried this at my last job and the migration took longer than the original build.',
  'Has anyone measured it, or are we all just telling stories about it again?',
  'This is the part where somebody says it is a solved problem and links a paper from 1998.',
  'Fair, but you are comparing a prototype to something that has had ten years of bug reports.',
  'I will take boring and correct over clever and fast every single time.',
  'The docs say one thing and the code does another, and the code is the one that ships.',
];

function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), seed | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 271 turns: tptacek opens; six branches under the opener; 179 different people, new ones early and the same voices back
 *  later; each voiced for 6 to 90 s (mostly short) but two not voiced yet; HN's turn-taking gaps (220, 480, 800 ms) */
function conversation(): Said[] {
  const r = rng(1337);
  const depths = [0];
  for (const size of BRANCHES) {
    depths.push(1);
    for (let i = 1; i < size; i++) {
      const prev = depths[depths.length - 1], x = r();
      depths.push(x < 0.5 ? Math.min(prev + 1, 6) : x < 0.7 ? Math.max(2, prev) : 2 + Math.floor(r() * (prev - 1)));
    }
  }
  const adj = ['quiet', 'rusty', 'lazy', 'null', 'old', 'tiny', 'late', 'plain', 'odd', 'warm', 'dry', 'blunt', 'kind', 'sleepy', 'mild', 'wry', 'terse', 'idle', 'brisk', 'calm', 'grim', 'lucid', 'sly', 'stoic'];
  const noun = ['monad', 'kernel', 'badger', 'compiler', 'otter', 'hashmap', 'sparrow', 'lambda', 'cobol', 'mutex', 'penguin', 'heap', 'ferret', 'daemon', 'pixel', 'walrus', 'router', 'tuple', 'gopher', 'trie', 'cipher', 'thunk', 'vim', 'sed'];
  const pool = adj.flatMap((a) => noun.map((n) => `${a}${n}`)).map((n) => [r(), n] as const).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  const by = ['tptacek'];
  let people = 1;
  for (let k = 1; k < N; k++) {
    const left = PEOPLE - people, turns = N - k;
    const fresh = left > 0 && (left >= turns || r() < (left / turns) * (1.7 - 1.4 * (k / N)));
    by.push(fresh ? pool[people++ - 1] : r() < 0.22 ? 'tptacek' : by[Math.floor(r() * by.length)]);
  }
  const ids: number[] = [];
  return depths.map((depth, k) => {
    ids[depth] = 46100000 + k;
    const d = Math.round((6 + 84 * r() ** 2.6) * 10) / 10, gapMs = k === 0 ? 0 : depth > depths[k - 1] ? 220 : depth === depths[k - 1] ? 480 : 800;
    return { id: ids[depth], by: by[k], depth, replyTo: depth ? ids[depth - 1] : undefined, gapMs, v: k === 57 || k === 203 ? undefined : [`v/${k}.opus`, d, 'neutral', 0.3] };
  });
}

const w = window as unknown as Record<string, unknown>;
const turns = conversation(), line = lineOf(turns);

// the animation frame the page is on, and an order across everything below: "at most once per frame" can then be counted
let frame = 0, seq = 0;
const tick = () => { w.__frames = ++frame; requestAnimationFrame(tick); };
requestAnimationFrame(tick);
const stamp = () => ({ n: ++seq, frame, at: performance.now() });

type Stamp = ReturnType<typeof stamp>;
const calls = { scrub: [] as (Stamp & { t: number; k: number })[], seek: [] as (Stamp & { t: number; k: number })[], scrubbing: [] as (Stamp & { on: boolean })[] };
/** how often the timeline asked for each comment's words */
const asked: Record<number, number> = {}, known = new Set<number>();
w.__snippetMs = 150;
const host: ScrubberHost = {
  onScrub: (t, k) => { calls.scrub.push({ t, k, ...stamp() }); },
  onSeek: (t, k) => { calls.seek.push({ t, k, ...stamp() }); },
  onScrubbing: (on) => { calls.scrubbing.push({ on, ...stamp() }); },
  // a comment's words are known at once for even k; for odd k they arrive a moment after they are first asked for
  snippet: (k) => {
    asked[k] = (asked[k] ?? 0) + 1;
    if (k % 2 && !known.has(k)) { if (asked[k] === 1) setTimeout(() => known.add(k), w.__snippetMs as number); return null; }
    return SAY[k % SAY.length];
  },
};

// what the app's window-level key handler would see (Space pauses, Esc stands up, N, R, M): whether it still arrives, and unprevented
const keys: { key: string; prevented: boolean; n: number }[] = [];
addEventListener('keydown', (e) => { keys.push({ key: e.key, prevented: e.defaultPrevented, n: ++seq }); });
// the last pointer the page saw, and how many moves it saw: the expected comment under a drag is worked out from where the
// pointer really was (an engine may round it), and "once per frame" means something only if there were more moves than frames
const pointer = { x: 0, y: 0, type: '', upAt: 0 };
w.__moves = 0;
for (const type of ['pointerdown', 'pointermove', 'pointerup']) addEventListener(type, (e) => {
  const p = e as PointerEvent;
  pointer.x = p.clientX; pointer.y = p.clientY; pointer.type = p.pointerType;
  if (type === 'pointermove') (w.__moves as number)++;
  if (type === 'pointerup') pointer.upAt = performance.now();
}, true);
// the pills in the bottom bar, and a speaker's name in the subtitles (a way in to their card): at rest the timeline must not be in front of them
const pills: Record<string, number> = { answer: 0, pause: 0, next: 0, leave: 0 };
for (const b of document.querySelectorAll<HTMLButtonElement>('#controls .pill')) b.onclick = () => { pills[b.id]++; };
w.__who = 0;
document.querySelector<HTMLElement>('#subs .who')!.onclick = () => { (w.__who as number)++; };

const scrubber = new Scrubber(host);
scrubber.show(line, OTHERS, 0);
document.body.classList.add('timeline');                  // (as main.ts does while it's shown: the subtitles make room on a phone)
Object.assign(w, {
  __scrubber: scrubber, __line: line, __turns: turns, __lineOf: lineOf, __valueText: valueText, __others: OTHERS,
  __calls: calls, __asked: asked, __keys: keys, __pointer: pointer, __pills: pills,
  __reset: () => { calls.scrub.length = calls.seek.length = calls.scrubbing.length = keys.length = 0; w.__moves = 0; },
});
