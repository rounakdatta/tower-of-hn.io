// Floors for the room's tests, written once into e2e/room/.fx/<name>/live/ (head.json, the floor, every comment's
// sidecar): the 1Password thread as it stood on 26 Nov 2026 (its structure, voices' lengths and moods, when each comment
// was written, from HN's public Algolia index; no words), and
// synthetic threads of 5, 50, 200, 800 and 3,000 commenters, shaped like HN's: one thread with about 40% of the
// people, a long tail of small ones, 1-3 comments each, replies a few levels deep, comments thick in the first hours.
// Every clip is the same short tone (tone.ogg): the tests hear when audio starts, not what it says.
//   node e2e/room/fixtures.mjs            (from apps/client; idempotent)
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '.fx');
const SIZES = [5, 50, 200, 800, 3000];

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const EMO = ['contemplative', 'contemplative', 'contemplative', 'mundane', 'mundane', 'stern', 'excited', 'joyful', 'angry', 'nervous', 'sad', 'surprised', 'tender'];
const NAMES = ['tptacek', 'patio11', 'pg', 'dang', 'jacquesm', 'rayiner', 'pjc50', 'kragen', 'nostrademons', 'walterbell', 'simonw', 'jerf', 'Animats', 'dragontamer', 'zokier', 'kccqzy', 'throwaway', 'mike_hearn', 'jart', 'gwern'];
const STANCES = ['inform', 'inform', 'inform', 'agree', 'disagree', 'question', 'inform', 'correct', 'agree', 'joke', 'inform', 'question', 'praise'];
const nameOf = (k) => (k < NAMES.length ? NAMES[k] : `${NAMES[k % NAMES.length]}_${((k * 2654435761) >>> 0).toString(36).slice(0, 4)}`);

/** A thread with n commenters (deterministic: the same n always gives the same floor). */
export function synthetic(n) {
  const r = rng(7919 + n), S = 50700000 + n;
  const people = Array.from({ length: n }, (_, k) => nameOf(k));
  const nt = Math.max(1, Math.min(58, Math.round(n / 10)));
  const w = Array.from({ length: nt }, (_, k) => 1 / Math.pow(k + 1, 1.15)), W = w.reduce((a, b) => a + b, 0);
  const home = people.map(() => { let x = r() * W; for (let k = 0; k < nt; k++) { x -= w[k]; if (x <= 0) return k; } return nt - 1; });
  const byTable = Array.from({ length: nt }, () => []);
  let clock = 0;
  for (const k of people.map((_, k) => k).sort(() => r() - 0.5)) {
    const m = 1 + (r() < 0.35 ? 1 : 0) + (r() < 0.12 ? 1 : 0);
    for (let j = 0; j < m; j++) {
      clock += -Math.log(1 - r()) * (20 + clock / 40);
      byTable[j > 0 && r() < 0.15 ? Math.floor(r() * nt) : home[k]].push({ by: people[k], at: Math.round(clock) });
    }
  }
  let id = S + 1;
  const tables = [];
  for (const cs of byTable) {
    if (!cs.length) continue;
    cs.sort((a, b) => a.at - b.at);
    const nodes = cs.map((c, k) => ({ ...c, id: id++, parent: k === 0 ? null : r() < 0.3 ? 0 : Math.max(0, k - 1 - Math.floor(r() * Math.min(k, 6))), kids: [] }));
    nodes.forEach((nd, k) => { if (k) nodes[nd.parent].kids.push(k); });
    const turns = [];
    let prev = -1;
    const walk = (k, depth) => {
      const nd = nodes[k], gapMs = turns.length === 0 ? 0 : depth > prev ? 220 : depth === prev ? 480 : 800;
      // (one comment in eleven not voiced yet, as on a live floor: the table asks the server for it when it's near)
      const dur = Math.round((6 + -Math.log(1 - r()) * 18) * 100) / 100, emo = EMO[Math.floor(r() * EMO.length)], amp = Math.round(r() * 10) / 10;
      turns.push({ id: nd.id, by: nd.by, depth, ...(nd.parent !== null ? { replyTo: nodes[nd.parent].id } : {}), gapMs, voice: Math.floor(r() * 110), at: nd.at,
        ...(turns.length % 11 === 7 ? {} : { v: [`c/${nd.id}.f1.json`, dur, emo, amp] }) });
      prev = depth;
      for (const c of nd.kids) walk(c, depth + 1);
    };
    walk(0, 0);
    const seen = [];
    for (const u of turns) if (!seen.includes(u.by)) seen.push(u.by);
    tables.push({ root: turns[0].id, seated: seen.slice(0, 8), standing: seen.slice(8), gist: `What ${turns[0].by} said first`, turns });
  }
  tables.sort((a, b) => b.turns.length - a.turns.length);
  return { story: { id: S, title: `A thread of ${n.toLocaleString('en-US')} people`, url: 'https://example.com/', by: 'fixture', score: 100 + n, comments: tables.reduce((a, t) => a + t.turns.length, 0), time: 1795000000 }, rev: 1, epoch: 1, tables };
}

/** Write a floor's live files: head.json (this floor alone on the tower), the floor, a sidecar per voiced comment. */
export function write(name, floor) {
  const dir = join(OUT, name, 'live'), sid = floor.story.id, rev = floor.rev || 1;
  mkdirSync(join(dir, 'f', String(sid)), { recursive: true });
  mkdirSync(join(dir, 'c'), { recursive: true });
  writeFileSync(join(dir, 'f', String(sid), `${rev}.json`), JSON.stringify({ ...floor, rev }));
  copyFileSync(join(here, 'tone.ogg'), join(dir, 'tone.ogg'));
  const people = new Set(floor.tables.flatMap((t) => t.turns.map((u) => u.by)));
  writeFileSync(join(dir, 'head.json'), JSON.stringify({ epoch: 1, at: Date.now(), tower: [sid], floors: { [sid]: rev },
    stories: { [sid]: [floor.story.title, floor.story.score, floor.story.comments, floor.story.by ?? 'x', floor.story.url ?? ''] },
    act: { [sid]: 0 }, people: { [sid]: people.size }, heat: { [sid]: 0.2 }, load: 0, play: ['stream', 'cue', 'quick'] }));
  for (const t of floor.tables) for (const u of t.turns) {
    if (!u.v) continue;
    const dur = u.v[1], k = Math.max(1, Math.ceil(dur / 9)), clips = [];
    for (let c = 0; c < k; c++) {
      const d = Math.round((dur / k) * 100) / 100, frames = Math.ceil(d * 30);
      clips.push({ u: 'tone.ogg', d, t: `${u.by}, point ${c + 1} of ${k}.`, who: u.by,
        env: Array.from({ length: frames }, (_, f) => Math.round(255 * Math.max(0, Math.sin((f / 30) * Math.PI * 4.2 + c)) * (0.55 + 0.45 * Math.sin(f / 7.3)))),
        shape: Array.from({ length: frames }, (_, f) => Math.round(127 + 120 * Math.sin(f / 5.1 + u.id))) });
    }
    // how it's said (the floor files carry the mood; the stance is the sidecar's): spread the way the tagger spreads
    // real threads, by the comment's id, so the room has questions, agreement, pushback and the odd joke to act
    const st = STANCES[u.id % STANCES.length];
    writeFileSync(join(dir, u.v[0]), JSON.stringify({ id: u.id, by: u.by, emotion: u.v[2] ?? 'mundane', stance: st, intensity: u.v[3] ?? 0.4,
      cues: st === 'joke' ? ['joke'] : st === 'question' ? ['question'] : [], dur, clips, links: [], code: [] }));
  }
  return { name, sid, root: floor.tables.reduce((a, t) => (new Set(t.turns.map((u) => u.by)).size > new Set(a.turns.map((u) => u.by)).size ? t : a)).root, people: people.size };
}

/** Every fixture, written if missing; returns what the tests need to know about each. */
export function ensure() {
  const out = {};
  const mark = join(OUT, 'index.json');
  if (existsSync(mark)) return JSON.parse(readFileSync(mark, 'utf8'));
  out.onepassword = write('onepassword', JSON.parse(readFileSync(join(here, 'onepassword-floor.json'), 'utf8')));
  for (const n of SIZES) out[`n${n}`] = write(`n${n}`, synthetic(n));
  // (FLOOR_TIMELINE) a floor from a server that doesn't say when comments were written: the room as it always was
  const untimed = synthetic(50);
  for (const t of untimed.tables) for (const u of t.turns) delete u.at;
  delete untimed.story.time;
  out['n50-untimed'] = write('n50-untimed', untimed);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(mark, JSON.stringify(out, null, 1));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(ensure(), null, 1));
