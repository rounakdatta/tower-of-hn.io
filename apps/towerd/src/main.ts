// towerd: the local stand-in for the edge + CDN.
//   - follows the HN firehose into the shared Live state (packages/core)
//   - writes head.json / e/<n>.json / f/<story>/<rev>.json under var/live
//   - plans voicing (prewarm the best tables, and any table someone sits at) and hands it to voice runners on any
//     node over an internal port (VOICE_PORT): they claim a job, send each clip as it's voiced, towerd writes it
//   - serves var/live over HTTP with production-like cache headers
//   - in production also serves the built client, and keeps var/ tidy (old deltas, floor revisions, audio)
// usage: node src/main.ts
// env: PORT, VAR, STATIC (the client's dist), RETENTION_DAYS (audio, default 14), OPTOUT (comma-separated HN
//      users never voiced; also var/optout.txt, one per line, re-read every minute),
//      PREWARM_FLOORS, PREWARM_TABLES, PREWARM_TURNS, PREWARM_BAR, VOICE_AHEAD (audience, the default, or all: voice
//      everything on the tower ahead of listeners), VOICE_VERSION, VOICE_PORT (default 8788),
//      VOICE_TOKEN (runners must send it, if set), HN_API (a stand-in for HN's API, for staging), CLIENT_FLAGS
//      (stream,cue,quick,crowd,timeline,floor: how the room plays), AUDIO_POLICY (how audio is kept, see store.ts: age, the default,
//      deletes it after RETENTION_DAYS; tower keeps only what a floor can still play, AUDIO_GRACE_HOURS (24) after,
//      at most AUDIO_MAX_MB (1024), and voices nothing new below DISK_FREE_MIN_PCT (15) free; tower-dry only says
//      what tower would do), PRUNE_EVERY_S (housekeeping, 600), SPONSOR_URL (the maker's GitHub Sponsors page: a
//      quiet line on the door, a credit at a table, /support; unset, none of it exists) and SPONSOR_UPI (a UPI ID for
//      /support; see support.ts), EDGE_PORT (a second HTTP port for a CDN's tunnel connector, cloudflared: there
//      CF-Connecting-IP names the visitor and /status is private; the NetworkPolicy must admit the connector alone)
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync, brotliCompressSync, constants as zlibc } from 'node:zlib';
import { homedir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, readdirSync, unlinkSync, statSync, statfsSync, openSync, readSync, closeSync, rmdirSync, appendFileSync, promises as fsp } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { Live, type Item, type FloorSnapshot } from '../../../packages/core/src/live.ts';
import { speakable } from '../../../packages/core/src/speakable.ts';
import { VoiceQueue, band, type Entry } from './queue.ts';
import { tagPrompt, parseTags, type Tag } from './tags.ts';
import { versionOf, sweep, liveLines, type Version } from './store.ts';
import { readSupport, supportSite, missingMarks } from './support.ts';
import { playFlags } from './play.ts';

// HN_API: a stand-in for HN's Firebase API (staging and load tests run against a mock, never against HN)
const HN = (process.env.HN_API || 'https://hacker-news.firebaseio.com/v0').replace(/\/$/, '');   // (empty: unset)
const UA = { 'User-Agent': 'towerofhn-towerd/0.1' };
const PORT = Number(process.env.PORT ?? 8787);
// The edge's way in (a Cloudflare Tunnel's connector, cloudflared): only the connector can reach it (the NetworkPolicy),
// so the edge's CF-Connecting-IP names the visitor there, and towerd's internals (/status) are not served on it
const EDGE_PORT = Number(process.env.EDGE_PORT) || 0;
const viaEdge = (req: import('node:http').IncomingMessage) => EDGE_PORT > 0 && req.socket.localPort === EDGE_PORT;
const VAR = resolve(process.env.VAR ?? join(import.meta.dirname, '../../../var'));
const LIVE = join(VAR, 'live'), JOBS = join(VAR, 'jobs'), VOICED = join(VAR, 'voiced.jsonl');
const FLOORS = 30;
const PRE = { floors: Number(process.env.PREWARM_FLOORS ?? 6), tables: Number(process.env.PREWARM_TABLES ?? 4), turns: Number(process.env.PREWARM_TURNS ?? 14), bar: Number(process.env.PREWARM_BAR ?? 6) };
const MAX_QUEUED = 48;                               // the most urgent of what's wanted, for runners to claim
/** How far ahead of listeners voicing goes. audience (the default): the first words of every table always, whole turns
 *  of the best tables only while someone has the page open. all: everything on the tower, always, as it arrives (every
 *  table's first turn before any table's second, top floors first), so a listener finds it voiced: voicing then scales
 *  with new comments, not with listeners. The runners' spare cores pay for it; the standby beside the data never does. */
const VOICE_AHEAD = (process.env.VOICE_AHEAD ?? '').trim().toLowerCase() === 'all' ? 'all' : 'audience';
/** CLIENT_FLAGS: how the room plays, switched here and carried to every client in head.json (play); unset, the client
 *  plays as it always has. stream: a turn starts on its first decoded clip, the rest join as they decode. cue: whoever
 *  speaks next is called over while the turn before is said, and nobody is waited on for long. quick: a shorter pause
 *  when you sit down. crowd: a room that fits any crowd (an audience in a hall, galleries when a floor needs them).
 *  timeline: at a table, a line to scrub through the conversation and listen from any point (it needs crowd).
 *  (A page can try them without the server: ?play=stream,cue,quick, or ?play= for none.) */
const { on: PLAY, unknown: PLAY_UNKNOWN } = playFlags(process.env.CLIENT_FLAGS);
console.log(JSON.stringify({ play: { on: PLAY, ...(PLAY_UNKNOWN.length ? { unknown: PLAY_UNKNOWN } : {}) } }));
/** bump to re-voice everything (new pace, new model): old audio keeps playing until its replacement lands */
// v3: comments are said the way people read them aloud (packages/core spoken.ts); older audio plays until re-voiced
const VOICE_VERSION = process.env.VOICE_VERSION ?? 'v3';
const STATIC = resolve(process.env.STATIC ?? join(import.meta.dirname, '../../client/dist')), INDEX = join(STATIC, 'index.html');
const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS) || 14);
const AUDIO_POLICY = ['tower', 'tower-dry'].includes(process.env.AUDIO_POLICY ?? '') ? process.env.AUDIO_POLICY! : 'age';
const AUDIO = { grace: Math.max(1, Number(process.env.AUDIO_GRACE_HOURS) || 24) * 3_600_000,
  maxBytes: Math.max(64, Number(process.env.AUDIO_MAX_MB) || 1024) * 1_048_576, freeMin: Number(process.env.DISK_FREE_MIN_PCT) || 15 };
const PRUNE_MS = Math.max(10, Number(process.env.PRUNE_EVERY_S) || 600) * 1000;   // housekeeping (tests run it faster)
console.log(JSON.stringify({ audio: { policy: AUDIO_POLICY, asked: process.env.AUDIO_POLICY ?? null, grace_h: AUDIO.grace / 3_600_000, max_mb: AUDIO.maxBytes / 1_048_576, free_min_pct: AUDIO.freeMin, retention_days: RETENTION_DAYS } }));
const { support: SUPPORT, problems: supportProblems } = readSupport(process.env);
console.log(JSON.stringify({ support: { on: !!SUPPORT, upi: !!SUPPORT?.upi, ...(supportProblems.length ? { refused: supportProblems } : {}) } }));
const support = supportSite(SUPPORT);
// the page must carry its markers, or nothing would point to /support: say so at boot, not to a visitor
if (SUPPORT) { try { const missing = missingMarks(readFileSync(INDEX, 'utf8')); if (missing.length) console.warn(JSON.stringify({ support: { missing } })); } catch { /* no page to read: / answers as it always has */ } }
for (const d of [LIVE, JOBS]) mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- HN access
async function get<T>(path: string): Promise<T> {
  for (let a = 0; ; a++) {
    try { return (await (await fetch(`${HN}/${path}.json`, { headers: UA, signal: AbortSignal.timeout(15_000) })).json()) as T; }
    catch (e) { if (a > 4) throw e; await sleep(500 * 2 ** a); }
  }
}
/** Items in parallel batches. lenient: an item that can't be fetched is skipped (bootstrap; it comes back with
 *  the next update or tower refresh) instead of failing the batch (the live loop retries the whole step). */
let skipped = 0;                                     // items the bootstrap couldn't fetch (the tower refresh repairs them)
async function many(ids: number[], lenient = false, conc = 24, beat = true): Promise<Item[]> {
  const res: Item[] = [];
  for (let i = 0; i < ids.length; i += conc) {
    const one = (id: number) => (lenient ? get<Item>(`item/${id}`).catch(() => { skipped++; return null as unknown as Item; }) : get<Item>(`item/${id}`));
    res.push(...(await Promise.all(ids.slice(i, i + conc).map(one))).filter(Boolean));
    if (beat) heartbeat = Date.now();                  // progress, even in a long bootstrap (a card's fetch isn't ingest)
  }
  return res;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function write(rel: string, data: unknown) {
  const p = join(LIVE, rel);
  writeAt(p, data);
  try { hotPut(p, readFileSync(p), statSync(p).mtimeMs); } catch { /* served from disk then */ }
}
function writeAt(p: string, data: unknown) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + '.tmp', JSON.stringify(data));
  renameSync(p + '.tmp', p);
}

// ---------------------------------------------------------------- state
const live = new Live({ snapshotEvery: 1, base: Date.now() });
let heartbeat = Date.now();                          // /livez: the ingest loop (or the bootstrap) is making progress
process.on('SIGTERM', () => process.exit(0));        // PID 1 in a container: exit at once on a rollout
const floors = new Map<number, FloorSnapshot>();
/** What listeners asked for: comment id -> priority (lower = sooner), how much of it (upto: first clips only,
 *  0 = all of it) and when (demand lapses unless renewed). Priority bands, which the worker also reads:
 *    0-99 someone sat at the table · 100-199 someone walked onto the floor · 200-999 a floor in focus on the tower
 *    1000+ background: first words of every table first, then (only while anyone is around) whole turns */
const demand = new Map<string, { id: number; prio: number; upto: number; at: number; who: Map<string, number> }>();   // key: id/upto (one ask per depth)
const DEMAND_TTL = 90_000;
/** someone has the page open (head.json is polled every 2 s): background voicing goes deep only then */
let lastViewerAt = 0;
const audience = () => Date.now() - lastViewerAt < 20 * 60_000;
function ask(id: number, prio: number, upto = 0, client = '') {
  const key = `${id}/${upto}`, d = demand.get(key), now = Date.now(), fresh = d && now - d.at < DEMAND_TTL;
  if (!fresh) { demand.set(key, { id, prio, upto, at: now, who: new Map(client ? [[client, now]] : []) }); return; }
  if (prio < d.prio) d.prio = prio;
  d.at = now;
  if (client) d.who.set(client, now);
}
/** How many listeners are waiting on it lowers its number (sooner): eight places a listener, up to thirty, never out
 *  of its band (the worker reads urgency from the band; job files sort by it). A seated table's numbers are its turn
 *  order, so they're left alone. With a hundred people on a few floors, the worker's seconds go where most ears are. */
const crowdPrio = (d: { prio: number; who: Map<string, number> }) => {
  if (d.prio < 100 || d.prio >= 1000) return d.prio;
  return Math.max(d.prio < 200 ? 100 : 200, d.prio - Math.min(30, 8 * Math.max(0, d.who.size - 1)));
};
/** listener-driven voicing still waiting (head.load): clients stop waiting on unvoiced lines when it runs long */
let backlog = 0;
/** how much of the tower a listener would find voiced (/status), measured each time the queue is planned: whole turns
 *  in the current voice, openings (first clips only), stale (an older VOICE_VERSION's, playing until re-voiced) */
const cover = { turns: 0, voiced: 0, openings: 0, stale: 0 };
type Job = NonNullable<ReturnType<typeof jobFor>>;
/** what runners may claim (in memory: towerd plans it every couple of seconds; runners hold leases) */
const vq = new VoiceQueue<Job>();
if (VOICE_AHEAD === 'all') vq.standbyBelow = 2000;   // the standby: listeners and first words only, never the whole tower
console.log(JSON.stringify({ voicing: { ahead: VOICE_AHEAD, asked: process.env.VOICE_AHEAD ?? null, hn: process.env.HN_API ? 'stand-in' : 'hacker-news' } }));
if (VOICE_AHEAD === 'all' && AUDIO_POLICY === 'age') console.warn(JSON.stringify({ voicing: { warn: 'VOICE_AHEAD=all keeps the whole tower voiced: with AUDIO_POLICY=age that is ~0.3 GB a day kept RETENTION_DAYS; tower keeps ~0.5 GB in all' } }));
const stale = new Set<number>();                     // voiced with an older VOICE_VERSION: re-voice in the background
const partial = new Set<number>();                   // playable, but the worker is still voicing the rest of it
/** clips voiced so far of a partial comment (a whole one counts as all of them): openings are measured in clips */
const clipsOf = new Map<number, number>();
let voicedOffset = 0;
let booting = true;

function readVoiced() {
  if (!existsSync(VOICED)) return;
  const size = statSync(VOICED).size;
  if (size <= voicedOffset) return;
  const fd = openSync(VOICED, 'r'), buf = Buffer.alloc(size - voicedOffset);
  readSync(fd, buf, 0, buf.length, voicedOffset);
  closeSync(fd);
  const text = buf.toString('utf8'), lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return;
  voicedOffset += Buffer.byteLength(text.slice(0, lastNl + 1));
  for (const line of text.slice(0, lastNl).split('\n')) {
    try {
      const v = JSON.parse(line);
      if (booting && !existsSync(join(LIVE, v.path))) continue;   // pruned or lost: it will be voiced again if wanted
      if (!v.by || !v.voices || v.e === undefined) {
        try {
          const side = JSON.parse(readFileSync(join(LIVE, v.path), 'utf8'));
          v.by ??= side.by;
          v.voices ??= [...new Set((side.clips ?? []).map((c: { who: string }) => c.who))];
          v.of ??= side.of ?? (side.clips ?? []).length;
          v.e ??= side.emotion; v.i ??= side.intensity;
        } catch { /* gone: nothing to remember */ }
      }
      remember(v.id, v.path, v.by, v.of, v.voices);
      const it = live.items.get(v.id), by = v.by ?? it?.by;
      const hushed = (by && live.optOut.has(by)) || (v.voices ?? []).some((w: string) => live.optOut.has(w));
      if ((it && (it.dead || it.deleted)) || hushed) { unvoice(v.id); continue; }
      const prev = live.voiced.get(v.id);
      const want = revOf(v.id), got = String(v.path).split('.')[1];
      if (want && got !== want) {                   // an older version: use it until the new one lands
        if (!prev) live.markVoiced(v.id, v.path, v.dur, v.e, v.i);
        stale.add(v.id);
        continue;
      }
      if (v.partial) {                              // a long comment arriving clip by clip: playable already
        const done = prev && !partial.has(v.id) && String(prev[0]).split('.')[1] === got;
        if (!done && (!prev || !partial.has(v.id) || v.dur > prev[1])) {
          live.markVoiced(v.id, v.path, v.dur, v.e, v.i); partial.add(v.id);
          clipsOf.set(v.id, Math.max(clipsOf.get(v.id) ?? 0, Number(/\.p(\d+)\.json$/.exec(v.path)?.[1] ?? 1)));
        }
        continue;                                   // the job is still running: keep it queued
      }
      live.markVoiced(v.id, v.path, v.dur, v.e, v.i);
      partial.delete(v.id); clipsOf.set(v.id, Infinity);
      stale.delete(v.id);
      for (const u of [0, 1, 2]) demand.delete(`${v.id}/${u}`);
    } catch { /* partial line */ }
  }
}

// ---------------------------------------------------------------- voicing queue
/** Everything worth voicing now, most urgent first: [comment id, priority, upto]. */
function wanted(): [number, number, number][] {
  // listeners who left stop costing anyone else: their requests lapse after DEMAND_TTL unless renewed
  for (const [k, d] of demand) if (Date.now() - d.at > DEMAND_TTL) demand.delete(k);
  const out = new Map<number, [number, number]>();
  const add = (id: number, prio: number, upto: number) => {
    // an opening is done once its comment has any voice at all; a whole turn once it's whole (or, after a
    // VOICE_VERSION bump, re-voiced: the old version plays until then)
    // (a stale comment, voiced whole by an older VOICE_VERSION, is re-voiced whole: an opening would swap its
    // complete old audio for one or two new clips)
    if (upto && stale.has(id)) return;
    if (!(upto ? !live.voiced.has(id) || (clipsOf.get(id) ?? 0) < upto : needsVoice(id) || stale.has(id))) return;
    const o = out.get(id);
    if (!o || prio < o[0]) out.set(id, [prio, upto]);
  };
  for (const d of demand.values()) {
    for (const [c, t] of d.who) if (Date.now() - t > DEMAND_TTL) d.who.delete(c);   // listeners who left
    add(d.id, crowdPrio(d), d.upto);
  }
  const convo = (f: FloorSnapshot) => f.tables.filter((t) => t.turns.length >= 2);
  cover.turns = cover.voiced = cover.openings = cover.stale = 0;
  live.tower.forEach((sid, rank) => {
    const f = floors.get(sid);
    if (!f) return;
    for (const t of f.tables) for (const u of t.turns) {
      cover.turns++;
      if (live.voiced.has(u.id)) { if (stale.has(u.id)) cover.stale++; else if (partial.has(u.id)) cover.openings++; else cover.voiced++; }
    }
    // first words of every table on every floor, so whoever sits down anywhere hears someone at once: two clips
    // (about twenty seconds) at the best tables of the top floors, which covers voicing the rest on three cores
    convo(f).slice(0, 6).forEach((t, ti) => add(t.turns[0].id, 1000 + rank * 20 + ti, rank < 10 && ti < 4 ? 2 : 1));
    if (VOICE_AHEAD === 'all') {
      // everything else, breadth first: every table's first turn (top floors first) before any table's second, and
      // so on down; the tiers below come first where they overlap (add keeps an id's most urgent ask)
      f.tables.forEach((t, ti) => t.turns.forEach((u, k) => add(u.id, 7000 + Math.min(k, 60) * 400 + rank * 12 + Math.min(ti, 11), 0)));
    }
    if (!audience()) return;                         // nobody around: that's all (a core saved, steal spared)
    if (rank < 10) convo(f).slice(0, 4).forEach((t, ti) => t.turns.slice(0, 2).forEach((u, k) => add(u.id, 3000 + rank * 50 + ti * 10 + k, 0)));
    if (rank < PRE.floors) {
      convo(f).slice(0, PRE.tables).forEach((t, ti) => t.turns.slice(0, PRE.turns).forEach((u, k) => add(u.id, 5000 + rank * 200 + ti * 20 + k, 0)));
      f.tables.filter((t) => t.turns.length === 1).slice(0, PRE.bar).forEach((t, k) => add(t.turns[0].id, 5000 + rank * 200 + 150 + k, 0));
    }
  });
  const list = [...out].map(([id, [prio, upto]]) => [id, prio, upto] as [number, number, number]).sort((a, b) => a[1] - b[1]);
  backlog = list.reduce((n, x) => n + (x[1] < 1000 ? 1 : 0), 0);
  return list;
}

/** audio voiced while HN still showed a moderation placeholder: the client skips it, so a listener needs the real thing */
const PLACEHOLDER_REVS = new Set(['delayed', 'flagged', 'dead', 'deleted', 'removed']
  .map((w) => createHash('sha1').update(`${VOICE_VERSION}:[${w}]`).digest('hex').slice(0, 8)));
function needsVoice(id: number) {
  const v = live.voiced.get(id);
  return !v || partial.has(id) || (stale.has(id) && PLACEHOLDER_REVS.has(String(v[0]).split('.')[1]));
}

function revOf(id: number): string | undefined {
  const it = live.items.get(id), t = it?.text;
  if (!t) return undefined;
  const parent = it.parent !== undefined ? live.items.get(it.parent) : undefined;
  const hush = parent?.by && live.optOut.has(parent.by) ? ':hush' : '';   // its quotes of them, in the replier's voice
  return createHash('sha1').update(VOICE_VERSION + ':' + t + hush).digest('hex').slice(0, 8);
}

function jobFor(id: number, prio: number, upto = 0) {
  const it = live.items.get(id);
  if (!it?.text || !it.by || it.dead || it.deleted || live.optOut.has(it.by)) return undefined;
  const parent = it.parent !== undefined ? live.items.get(it.parent) : undefined;
  const sp = speakable(it.text, parent?.text ? { id: parent.id, text: parent.text } : undefined);
  const sid = live.storyOf(id)!;
  const f = floors.get(sid);
  const table = f ? f.tables.findIndex((t) => t.turns.some((u) => u.id === id)) : -1;
  // for the tagger: what they're answering (a few words of it), and whether they're answering someone who had
  // answered them (a back-and-forth: where comebacks happen)
  const asked = parent?.type === 'comment' && parent.by && parent.text && !live.optOut.has(parent.by);
  const grand = asked && parent!.parent !== undefined ? live.items.get(parent!.parent) : undefined;
  return {
    id, prio, story: sid, table, by: it.by,
    parentBy: parent?.type === 'comment' && parent.by && !live.optOut.has(parent.by) ? parent.by : undefined,
    ...(asked ? { parentSaid: speakable(parent!.text!).segments.filter((s) => s.kind === 'say').map((s) => (s as { display: string }).display).join(' ').slice(0, 240) } : {}),
    ...(grand?.type === 'comment' && grand.by === it.by ? { back: true } : {}),
    rev: revOf(id)!,
    segments: sp.segments,
    ...(upto ? { upto } : {}),                       // an opening: only its first clips, the rest on demand
  };
}

/** The queue becomes what's wanted now: jobs nobody wants any more (a listener left, demand lapsed) leave it, so
 *  runners voice what's needed now; a runner waiting for work gets the new most urgent job at once. */
function syncJobs() {
  vq.plan(wanted().slice(0, MAX_QUEUED), jobFor, revOf);
  // taken down, edited, or its author (or the one it quotes) opted out since it was queued: gone before anyone voices
  // it, or sends it to the model
  for (const e of [...vq.entries.values()]) if (!stillWanted(e.job)) vq.revoke(e.id);
  prefetchTags();
}

let headKey = '';
/** a burst of /want requests rebuilds the job queue once, a moment later (each rebuild walks every floor and writes files) */
let soonTimer: ReturnType<typeof setTimeout> | null = null;
function soon() { soonTimer ??= setTimeout(() => { soonTimer = null; try { syncJobs(); } catch (e) { console.error('jobs', String(e).slice(0, 160)); } }, 250); }

/**
 * The hot files, in memory: everything under /live/ is immutable except head.json, so once read (or written) it can
 * be served without touching the disk again. Bounded by bytes, least recently used out first; a takedown (unvoice)
 * or a prune drops what it deletes. head.json is held as written.
 */
const hot = new Map<string, { body: Buffer; mtime: number; size: number }>();
let hotBytes = 0;
const HOT_BYTES = Math.max(8, Number(process.env.HOT_MB) || 48) * 1e6;   // HOT_MB: the hot set's size (48 MB)
/** LIVE_READS: async (the default) reads a file that isn't in memory without blocking the server; sync is the old way */
const LIVE_READS = process.env.LIVE_READS === 'sync' ? 'sync' : 'async';
function hotPut(p: string, body: Buffer, mtime: number) {
  const had = hot.get(p);
  if (had) { hotBytes -= had.body.length; hot.delete(p); }
  if (body.length > 2e6) return;
  const own = Buffer.allocUnsafeSlow(body.length);         // its own memory, not a view into a pooled slab
  body.copy(own);
  hot.set(p, { body: own, mtime, size: own.length });
  hotBytes += body.length;
  for (const [k, v] of hot) { if (hotBytes <= HOT_BYTES) break; hot.delete(k); hotBytes -= v.body.length; }
}
function hotDrop(p: string) { const had = hot.get(p); if (had) { hotBytes -= had.body.length; hot.delete(p); } }
/** Clip requests since start: served from memory or from disk, and how old the clip was (what its grace has to
 *  cover); missing: any audio file asked for that is gone, sidecars included (what the store must never cause). */
const clipGets = { memory: 0, disk: 0, missing: 0, age: { h1: 0, h6: 0, d1: 0, d2: 0, older: 0 } };

// ---------------------------------------------------------------- HTTP: the CDN, the client, one write endpoint
const TYPES: Record<string, string> = {
  '.json': 'application/json', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};
// The page loads nothing from anywhere else; comments are text, and links in them are plain http(s) anchors. It reads
// one other place: HN's own public API, for the words of a comment you're answering and for replies to you (straight
// from your browser: nothing of yours passes through us).
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "media-src 'self' blob:; connect-src 'self' https://hacker-news.firebaseio.com; font-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'";
// POST /want only ever queues voicing of real comments on the current front page, but bound it anyway:
// per client (a seated listener renews about once every 30 s per table) and overall.
type Bucket = { n: number; at: number };
const take = (b: Bucket, rate: number, burst: number) => {
  b.n = Math.min(burst, b.n + ((Date.now() - b.at) / 1000) * rate); b.at = Date.now();
  if (b.n < 1) return false;
  b.n--; return true;
};
const everyone: Bucket = { n: 240, at: Date.now() }, clients = new Map<string, Bucket>();
// https://www.cloudflare.com/ips-v4 and ips-v6 (20 Nov 2026)
const CF4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'].map((c) => { const [a, m] = c.split('/'); return [v4(a), Number(m)] as const; });
const CF6 = ['2400:cb00:', '2606:4700:', '2803:f800:', '2405:b500:', '2405:8100:', '2c0f:f248:'];
function v4(a: string) { return a.split('.').reduce((n, o) => n * 256 + Number(o), 0); }
function cloudflare(ip: string) {
  if (ip.includes(':')) return CF6.some((p) => ip.startsWith(p)) || /^2a06:98c[0-7]:/.test(ip);
  const n = v4(ip);
  return CF4.some(([base, m]) => Math.floor(n / 2 ** (32 - m)) === Math.floor(base / 2 ** (32 - m)));
}
function clientOf(req: import('node:http').IncomingMessage) {
  // Through the tunnel (the edge port) the edge names the visitor, always; X-Real-Ip is ignored there (a visitor could
  // send one). Otherwise Traefik replaces X-Real-Ip with the address it saw (and the NetworkPolicy admits only Traefik
  // and agentfest); when that address is a Cloudflare edge, the edge names the visitor
  const cf = req.headers['cf-connecting-ip'], edge = viaEdge(req);
  const peer = String((edge ? undefined : req.headers['x-real-ip']) ?? req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
  const ip = (typeof cf === 'string' && (edge || cloudflare(peer)) ? cf : peer).replace(/%.*$/, '').slice(0, 64);
  return ip.includes(':') ? v6net(ip) : ip;
}
function v6net(ip: string) {
  const [head, tail] = ip.split('::'), h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
function allow(req: import('node:http').IncomingMessage) {
  const ip = clientOf(req);
  let b = clients.get(ip);
  if (!b) {
    if (clients.size > 5000) {                       // forget the idle first (a full bucket is no state), then the oldest
      for (const [k, x] of clients) if (Date.now() - x.at > 60_000) clients.delete(k);
      for (const k of clients.keys()) { if (clients.size <= 2500) break; clients.delete(k); }
    }
    b = { n: 20, at: Date.now() };
    clients.set(ip, b);
  }
  return take(b, 1, 20) && take(everyone, 60, 240);
}
function serve(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  try { handle(req, res); } catch (e) {
    console.error('http', String(e).slice(0, 160));
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
}
// The proxies in front (Traefik, cloudflared) keep idle connections to towerd for 90 s. Node's default of 5 s would
// close one under a request now and then, and the proxy answers that request 502: so hold them longer than they do
function server() {
  const s = createServer(serve);
  s.keepAliveTimeout = 120_000; s.headersTimeout = 125_000;
  return s;
}
server().listen(PORT, () => console.log(`towerd on http://localhost:${PORT}  (var: ${VAR})`));
if (EDGE_PORT) server().listen(EDGE_PORT, () => console.log(`edge (tunnel) on :${EDGE_PORT}`));

function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/livez') {
    // alive = the ingest loop has gone round lately (a hung loop gets the container restarted)
    const ok = Date.now() - heartbeat < 120_000;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/want') {
    if (!floors.size) { res.writeHead(503, { 'retry-after': '5' }); res.end(); return; }   // still starting up
    if (!allow(req)) { res.writeHead(429, { 'retry-after': '5' }); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 200 && !res.writableEnded) { res.writeHead(413); res.end(); req.destroy(); } });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const { story, table = 0, from = 0, warm = 0 } = JSON.parse(body);
        if (![story, table, from, warm].every((n) => Number.isInteger(n) && n >= 0) || warm > 2) throw new Error('bad request');
        const f = floors.get(story);
        if (!f) throw new Error('not on the tower');
        lastViewerAt = Date.now();
        let turns: FloorSnapshot['tables'][number]['turns'] = [];
        const who = clientOf(req);
        if (warm) {
          // ahead of anyone sitting down: 1 = the floor is in focus on the tower, 2 = they're standing in the room
          const convo = f.tables.filter((t) => t.turns.length >= 2);
          if (warm === 2) {
            // first words at every table before second words at any: whichever table they pick can start
            convo.slice(0, 6).forEach((t, ti) => ask(t.turns[0].id, 100 + ti, 1, who));
            convo.slice(0, 6).forEach((t, ti) => ask(t.turns[0].id, 120 + ti, 2, who));
            convo.slice(0, 3).forEach((t, ti) => { ask(t.turns[0].id, 150 + ti * 3, 0, who); if (t.turns[1]) ask(t.turns[1].id, 151 + ti * 3, 1, who); });
          } else {
            // the floor in focus now goes ahead of floors glanced at before (the queue holds twelve)
            for (const d of demand.values()) if (d.prio >= 200 && d.prio < 1000) d.prio = Math.min(999, d.prio + 10);
            convo.slice(0, 3).forEach((t, ti) => ask(t.turns[0].id, 200 + ti, 1, who));
          }
          turns = convo.slice(0, warm === 2 ? 6 : 3).map((t) => t.turns[0]);
        } else {
          turns = f.tables[table]?.turns.slice(from, from + 24) ?? [];
          turns.forEach((u, k) => { if (needsVoice(u.id)) ask(u.id, k, 0, who); });
        }
        soon();                                         // the queue is rebuilt shortly (once for a burst of asks)
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ queued: turns.filter((u) => needsVoice(u.id)).length }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }
  if (url.pathname.startsWith('/profile/')) {
    // a commenter's card: only for someone on the tower now, never for someone who opted out
    let name = '';
    try { name = decodeURIComponent(url.pathname.slice(9)); } catch { /* malformed: 404 below */ }
    if (!/^[A-Za-z0-9_-]{2,15}$/.test(name) || live.optOut.has(name) || !onTowerNow(name)) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
    const send = (d: unknown) => {
      if (res.writableEnded) return;
      if (!d) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' });   // ~1 KB: not worth compressing
      res.end(JSON.stringify(d));
    };
    const hit = cachedProfile(name);
    if (hit) { send(hit); return; }                        // a card already written costs nothing: no limiter
    if (!allow(req)) { res.writeHead(429, { 'retry-after': '5' }); res.end(); return; }
    if (!building.has(name) && building.size >= 2) { res.writeHead(503, { 'retry-after': '3', 'cache-control': 'no-store' }); res.end(); return; }
    profileOf(name).then(send, () => { if (!res.writableEnded) { res.writeHead(503, { 'retry-after': '10', 'cache-control': 'no-store' }); res.end(); } });
    return;
  }
  if (url.pathname === '/status' && viaEdge(req)) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
  if (url.pathname === '/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    const ears = new Set<string>();
    for (const d of demand.values()) for (const c of d.who.keys()) ears.add(c);
    held();
    res.end(JSON.stringify({ items: live.items.size, voiced: live.voiced.size, queued: vq.entries.size, demand: demand.size, backlog, listeners: ears.size, tower: live.tower.length, audience: audience(), cover, voicing: voicingSummary(),
      audio: { policy: AUDIO_POLICY, held: heldFor || null, free_pct: Math.round(freePct * 10) / 10, ...audio.last, dropped: audio.dropped, gets: clipGets },
      ...support.status() }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  const sup = support.answer(req.method!, url.pathname, req.headers['if-none-match']);
  if (sup) {
    if (sup.status === 304) { res.writeHead(304, sup.headers); res.end(); return; }
    const out = squeeze(req, '/support.html', { body: support.page!, mtime: 0 }, false);
    res.writeHead(200, { ...sup.headers, ...(out.enc ? { 'content-encoding': out.enc } : {}) });
    res.end(req.method === 'HEAD' ? undefined : out.body);
    return;
  }
  if (!url.pathname.startsWith('/live/')) {
    // the client: index.html is always revalidated; everything under /assets/ is content-hashed, so forever
    let p = resolve(STATIC, '.' + decodeURIComponent(url.pathname));
    if (!p.startsWith(STATIC + '/') && p !== STATIC) { res.writeHead(404); res.end(); return; }
    const missing = !existsSync(p) || statSync(p).isDirectory();
    if (missing && url.pathname.startsWith('/assets/')) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
    if (missing) p = join(STATIC, 'index.html');
    if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
    const forever = url.pathname.startsWith('/assets/');
    const file = readOr503(p, res);
    if (!file) return;
    if (p === INDEX) file.body = support.index(file);
    const out = squeeze(req, p, file, forever);
    res.writeHead(200, {
      'content-type': TYPES[extname(p)] ?? 'application/octet-stream',
      'cache-control': forever ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(out.enc ? { 'content-encoding': out.enc } : {}), vary: 'accept-encoding',
      ...(extname(p) === '.html' ? { 'content-security-policy': CSP, 'referrer-policy': 'strict-origin-when-cross-origin' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : out.body);
    return;
  }
  const p = resolve(LIVE, '.' + url.pathname.slice(5));
  if (!p.startsWith(LIVE + '/')) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
  const isHead = url.pathname === '/live/head.json', clip = p.endsWith('.ogg');
  if (isHead) lastViewerAt = Date.now();
  let h = hot.get(p);
  if (!h && LIVE_READS === 'async') {
    // not in memory: read without holding up anyone else (on a busy node a slow disk read stalled every request behind
    // it), and once, however many ask for the same file at the same moment
    readLive(p).then((f) => {
      if (!f) { if (url.pathname.startsWith('/live/c/')) clipGets.missing++; } else if (clip) clipGets.disk++;
      if (res.writableEnded || res.destroyed) return;            // (counted anyway: they asked)
      if (!f) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
      sendLive(req, res, p, isHead, clip, f);
    }, () => { if (!res.headersSent) { res.writeHead(503, { 'cache-control': 'no-store', 'retry-after': '2' }); res.end(); } })
      .catch((e) => { console.error('live', String(e).slice(0, 160)); if (!res.headersSent) { res.writeHead(500); res.end(); } });
    return;
  }
  if (!h) {
    const st = statOr(p);
    if (!st || st.isDirectory()) { if (url.pathname.startsWith('/live/c/')) clipGets.missing++; res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
    const f = readOr503(p, res, st.mtimeMs);
    if (!f) return;
    hotPut(p, f.body, f.mtime);
    h = { body: f.body, mtime: f.mtime, size: f.body.length };
    if (clip) clipGets.disk++;
  } else { hot.delete(p); hot.set(p, h); if (clip) clipGets.memory++; }   // recently used
  sendLive(req, res, p, isHead, clip, h);
}

/** A file under /live/ from disk, into the hot set: one read per file however many ask for it at once (null: not there). */
const reading = new Map<string, Promise<{ body: Buffer; mtime: number; size: number } | null>>();
function readLive(p: string) {
  let r = reading.get(p);
  if (!r) {
    r = (async () => {
      const st = await fsp.stat(p).catch(() => null);
      if (!st || st.isDirectory()) return null;
      // (gone between the two: taken down or pruned mid-read, which is a 404, as it always was)
      const body = await fsp.readFile(p).catch((e) => { if (e?.code === 'ENOENT') return null; throw e; });
      if (!body) return null;
      const cur = hot.get(p);                         // written (and kept) meanwhile: that copy is the newest
      if (cur) return cur;
      // taken down or pruned while we read (deletes drop the hot copy and unlink together, in one step): never put it
      // back. This check and the hotPut below run in one step too, so no delete can fall between them.
      if (!existsSync(p)) return null;
      hotPut(p, body, st.mtimeMs);
      return hot.get(p) ?? { body, mtime: st.mtimeMs, size: body.length };
    })().finally(() => reading.delete(p));
    reading.set(p, r);
  }
  return r;
}

/** The answer for a file under /live/ in hand: its age noted, a 304 for a client that has it, else the bytes. */
function sendLive(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, p: string, isHead: boolean, clip: boolean, h: { body: Buffer; mtime: number; size: number }) {
  if (clip) { const a = Date.now() - h.mtime; clipGets.age[a < 3_600_000 ? 'h1' : a < 6 * 3_600_000 ? 'h6' : a < 86_400_000 ? 'd1' : a < 2 * 86_400_000 ? 'd2' : 'older']++; }
  const cache = isHead ? 'public, max-age=1, stale-while-revalidate=10' : 'public, max-age=31536000, immutable';
  // a poll that finds nothing new costs a header, not a body
  const tag = `W/"${Math.round(h.mtime).toString(36)}-${h.size.toString(36)}"`;
  if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag, 'cache-control': cache, vary: 'accept-encoding' }); res.end(); return; }
  const file = { body: h.body, mtime: h.mtime };
  const out = squeeze(req, p, file, false);
  res.writeHead(200, {
    'content-type': TYPES[extname(p)] ?? 'application/octet-stream', 'cache-control': cache, etag: tag,
    ...(out.enc ? { 'content-encoding': out.enc } : {}), vary: 'accept-encoding',
  });
  res.end(req.method === 'HEAD' ? undefined : out.body);
}

/**
 * Compressed bodies, cached: JSON shrinks ~4.5x (a floor is 75 KB raw, 17 KB gzipped, and a listener fetches every
 * revision) and the client's script 3.7x. Brotli for the content-hashed assets (compressed once, served forever),
 * gzip for the rest. Audio is already compressed: never touched.
 */
const squeezed = new Map<string, { mtime: number; enc: string; body: Buffer }>();
let squeezedBytes = 0;
function squeeze(req: import('node:http').IncomingMessage, p: string, f: { body: Buffer; mtime: number }, asset: boolean) {
  const accept = String(req.headers['accept-encoding'] ?? '');
  const ext = extname(p);
  if (f.body.length < 1024 || !['.json', '.js', '.css', '.html', '.svg', '.txt'].includes(ext)) return { body: f.body };
  const enc = asset && /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : '';
  if (!enc) return { body: f.body };
  const key = `${enc}:${p}`, hit = squeezed.get(key);
  if (hit && hit.mtime === f.mtime) { squeezed.delete(key); squeezed.set(key, hit); return { body: hit.body, enc }; }
  const body = enc === 'br'
    ? brotliCompressSync(f.body, { params: { [zlibc.BROTLI_PARAM_QUALITY]: 9, [zlibc.BROTLI_PARAM_SIZE_HINT]: f.body.length } })
    : gzipSync(f.body, { level: 6 });
  if (hit) squeezedBytes -= hit.body.length;
  squeezed.set(key, { mtime: f.mtime, enc, body });
  squeezedBytes += body.length;
  for (const [k, v] of squeezed) { if (squeezedBytes < 24e6) break; squeezed.delete(k); squeezedBytes -= v.body.length; }
  return { body, enc };
}

/** A file's bytes, or a 503 nobody caches: a read error must never become an empty response cached for a year. */
function statOr(p: string) { try { return statSync(p); } catch { return null; } }
function readOr503(p: string, res: import('node:http').ServerResponse, mtime?: number) {
  try { return { body: readFileSync(p), mtime: mtime ?? statSync(p).mtimeMs }; } catch {
    res.writeHead(503, { 'cache-control': 'no-store', 'retry-after': '2' });
    res.end();
    return null;
  }
}

// ---------------------------------------------------------------- housekeeping
/** Every version of every comment voiced (c/<id>.<rev> stems) and its author, from the voiced log: a takedown
 *  removes all of them, even for stories long off the front page whose items aren't loaded any more. */
const known = new Map<number, { by?: string; stems: Map<string, number>; voices: Set<string> }>();   // stem -> clips planned
const stemOf = (path: string) => String(path).replace(/\.(p\d+\.)?json$/, '');
function remember(id: number, path: string, by?: string, of?: number, voices?: string[]) {
  let k = known.get(id);
  if (!k) known.set(id, (k = { stems: new Map(), voices: new Set() }));
  const stem = stemOf(path);
  k.stems.set(stem, Math.max(k.stems.get(stem) ?? 0, Math.min(200, Number(of) || 120)));
  if (by) k.by = by;
  for (const w of voices ?? []) k.voices.add(w);
}

/** Remove a comment's audio, every version of it (HN deleted or killed it, or its author opted out). */
function unvoice(id: number) {
  vq.revoke(id);                                     // whoever is voicing it stops: their uploads are refused
  const v = live.voiced.get(id), k = known.get(id);
  if (!v && !k) return;
  if (v) live.voiced.delete(id);
  stale.delete(id); partial.delete(id);
  const stems = new Map(k?.stems ?? []);
  if (v && !stems.has(stemOf(String(v[0])))) stems.set(stemOf(String(v[0])), 120);
  for (const [stem, of] of stems) {
    if (!stem.startsWith(`c/${id}.`)) continue;
    // a clip per planned chunk (c/<id>.<rev>.<k>.ogg), a snapshot per clip count (.p<n>.json), the sidecar
    for (let n = 0; n <= of; n++) for (const f of [`${stem}.${n}.ogg`, `${stem}.p${n}.json`]) { hotDrop(join(LIVE, f)); try { unlinkSync(join(LIVE, f)); } catch { /* none */ } }
    hotDrop(join(LIVE, `${stem}.json`));
    try { unlinkSync(join(LIVE, `${stem}.json`)); } catch { /* none */ }
  }
  known.delete(id);
}

let optOutKey = '';
function readOptOut() {
  const names = new Set<string>(String(process.env.OPTOUT ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  if (existsSync(join(VAR, 'optout.txt'))) {
    for (const l of readFileSync(join(VAR, 'optout.txt'), 'utf8').split('\n')) { const x = l.trim(); if (x && !x.startsWith('#')) names.add(x); }
  }
  const key = [...names].sort().join(',');
  if (key === optOutKey) return;
  optOutKey = key;
  live.optOut = names;
  live.touchAll();
  // their own comments, and replies voiced with a quote of them in their voice
  for (const [id, k] of [...known]) { const by = k.by ?? live.items.get(id)?.by; if ((by && names.has(by)) || [...k.voices].some((w) => names.has(w))) unvoice(id); }
  for (const id of [...live.voiced.keys()]) { const by = live.items.get(id)?.by; if (by && names.has(by)) unvoice(id); }
  for (const n of names) { try { unlinkSync(join(PROFILES, `${n}.json`)); } catch { /* none */ } }   // and their card
  console.log(JSON.stringify({ optout: names.size }));
}

/** var/ only grows otherwise: deltas every tick, a floor revision per change, audio forever. Runs in slices,
 *  letting the server and the ingest loop breathe between them. */
async function prune() {
  const now = Date.now();
  let removed = 0, seen = 0;
  const breathe = async () => { if (++seen % 400 === 0) await new Promise((r) => setImmediate(r)); };
  // deltas: clients catch up from at most the last 20 epochs
  const gone = (f: string) => { hotDrop(f); try { unlinkSync(f); removed++; } catch { /* already gone, or mid-write */ } };
  const epochs = readdirSync(join(LIVE, 'e')).map((n) => parseInt(n)).filter(Number.isFinite);
  const latest = epochs.reduce((a, b) => Math.max(a, b), 0);
  for (const n of readdirSync(join(LIVE, 'e'))) if (parseInt(n) < latest - 600) gone(join(LIVE, 'e', n));
  // the audio a floor can play (AUDIO_POLICY tower): the tower's now, and what the last floor of a story that left it
  // named, as of that floor (on disk, so it outlives a restart)
  const bounded = AUDIO_POLICY !== 'age', playing = new Set<string>();
  if (bounded) for (const sid of live.tower) for (const t of floors.get(sid)?.tables ?? []) for (const u of t.turns) if (u.v) playing.add(stemOf(String(u.v[0])));
  for (const s of playing) reach.set(s, now);
  // floor revisions: keep the newest few per story (a client may be fetching the previous one); drop old stories
  const head = existsSync(join(LIVE, 'head.json')) ? JSON.parse(readFileSync(join(LIVE, 'head.json'), 'utf8')) : { floors: {} };
  for (const sid of readdirSync(join(LIVE, 'f'))) {
    const dir = join(LIVE, 'f', sid);
    const revs = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).map((n) => parseInt(n)).sort((a, b) => b - a);
    const onTower = head.floors?.[sid] !== undefined;
    if (bounded && !onTower && revs.length) {
      await new Promise((ok) => setImmediate(ok));     // a floor is ~75 KB of JSON: one at a time
      try {
        const p = join(dir, `${revs[0]}.json`), at = statSync(p).mtimeMs;
        if (now - at <= AUDIO.grace) {
          for (const t of JSON.parse(readFileSync(p, 'utf8')).tables ?? []) for (const u of t.turns ?? []) {
            if (u.v) { const s = stemOf(String(u.v[0])); if ((reach.get(s) ?? 0) < at) reach.set(s, at); }
          }
        }
      } catch { /* unreadable: its audio ages out */ }
    }
    for (const [k, r] of revs.entries()) {
      await breathe();
      if ((onTower && k < 4) || r === head.floors?.[sid]) continue;
      try { if (!onTower && k === 0 && now - statSync(join(dir, `${r}.json`)).mtimeMs < 3 * 86400_000) continue; } catch { continue; }   // a story that just left
      gone(join(dir, `${r}.json`));
    }
    try { if (!readdirSync(dir).length) rmdirSync(dir); } catch { /* not empty after all */ }
  }
  // audio: older than RETENTION_DAYS goes (it is voiced again if it is ever wanted), partial snapshots after a day
  // (unless still what its floor plays: kept until finished)
  const dir = join(LIVE, 'c'), versions = new Map<string, Version>();
  const logged = bounded ? statOr(VOICED)?.size ?? 0 : 0;        // the voiced log up to here names only files listed below
  for (const n of readdirSync(dir)) {
    await breathe();
    let age = 0, size = 0, mtime = 0;
    try { const st = statSync(join(dir, n)); mtime = st.mtimeMs; age = now - mtime; size = st.size; } catch { continue; }
    const id = parseInt(n), snap = /\.p\d+\.json$/.test(n);
    if (!(snap && live.voiced.get(id)?.[0] === `c/${n}`) && (age > RETENTION_DAYS * 86400_000 || (snap && age > 86400_000))) {
      if (!snap && n.endsWith('.json')) {
        if (live.voiced.get(id)?.[0] === `c/${n}`) live.voiced.delete(id);
        const k = known.get(id);
        if (k) { k.stems.delete(`c/${n.replace(/\.json$/, '')}`); if (!k.stems.size) known.delete(id); }   // voices kept with the id
      }
      gone(join(dir, n));
      continue;
    }
    const stem = bounded ? versionOf(n) : null;
    if (!stem) continue;
    let v = versions.get(stem);
    if (!v) versions.set(stem, (v = { stem, files: [], bytes: 0, mtime: 0, reach: reach.get(stem) ?? 0, tower: playing.has(stem) }));
    v.files.push(n); v.bytes += size; v.mtime = Math.max(v.mtime, mtime);
  }
  // (not before the tower's floors are built, the first pass after a start: until then nothing looks playable)
  if (bounded && playing.size) {
    try { await keepPlayable([...versions.values()], now, dir, gone, logged); } catch (e) { console.error('audio', String(e).slice(0, 200)); }
  }
  // stories off the front page for two days: forgotten, comments and all
  let forgot = 0;
  const onTower = new Set(live.tower);
  for (const [id, it] of live.items) {
    if (it.type !== 'story' || onTower.has(id)) { offSince.delete(id); continue; }
    if (!offSince.has(id)) offSince.set(id, now);
    else if (now - offSince.get(id)! > 2 * 86400_000) { forgot += live.forget(id); offSince.delete(id); floors.delete(id); }
  }
  if (removed || forgot) console.log(JSON.stringify({ pruned: removed, forgot }));
}
const offSince = new Map<number, number>();
const tries = new Map<number, number>();

/** AUDIO_POLICY tower (store.ts): version -> the last time a floor could play it; what the last pass found */
const reach = new Map<string, number>();
const audio = { marked: new Set<string>(), full: false, dropped: 0, last: {} as Record<string, number | boolean> };
async function keepPlayable(versions: Version[], now: number, dir: string, gone: (f: string) => void, logged: number) {
  held();                                                // a fresh reading of the disk
  const t0 = performance.now();
  const real = AUDIO_POLICY === 'tower', MB = 1_048_576, mb = (b: number) => Math.round(b / MB);
  // the disk nearly full: whatever nobody can play goes now, grace or not
  const r = sweep(versions, { now, grace: freePct < AUDIO.freeMin ? 0 : AUDIO.grace, maxBytes: AUDIO.maxBytes, marked: audio.marked });
  // (tower-dry deletes nothing, so what it would delete stays marked: each pass reports all of it)
  audio.marked = real ? r.marked : new Set([...r.marked, ...r.drop.map((v) => v.stem)]); audio.full = r.full;
  const dropped = new Set<string>();
  if (real) {
    let n = 0;
    for (const v of r.drop) {
      for (const f of v.files) {
        gone(join(dir, f)); dropped.add(`c/${f}`);
        if (++n % 200 === 0) await new Promise((ok) => setImmediate(ok));   // the first pass deletes thousands: in slices
      }
      const id = parseInt(v.stem.slice(2)), cur = live.voiced.get(id), k = known.get(id);
      if (cur && stemOf(String(cur[0])) === v.stem) { live.voiced.delete(id); partial.delete(id); stale.delete(id); clipsOf.delete(id); }
      if (k) { k.stems.delete(v.stem); if (!k.stems.size) known.delete(id); }
      reach.delete(v.stem);
    }
    audio.dropped += r.drop.length;
  }
  const onDisk = new Set(versions.map((v) => v.stem));
  for (const s of reach.keys()) if (!onDisk.has(s)) reach.delete(s);   // memory stays flat
  // the voiced log, read whole at start-up, loses the lines of audio that's gone, once half of it is dead. Its first
  // `logged` bytes were written before the listing (a file is written before its line), so they name only files the
  // listing saw: one listed and not dropped is alive, anything else is gone. Those bytes never change, so they're
  // sifted in slices; lines since are kept as they are.
  if (real && r.drop.length && logged) {
    const listed = new Set(versions.flatMap((v) => v.files.map((f) => `c/${f}`)));
    const lines = readFileSync(VOICED).subarray(0, logged).toString('utf8').split('\n').filter(Boolean), kept: string[] = [];
    for (let i = 0; i < lines.length; i += 2000) {
      kept.push(...liveLines(lines.slice(i, i + 2000), (p) => listed.has(p) && !dropped.has(p)));
      await new Promise((ok) => setImmediate(ok));
    }
    readVoiced();                                         // (synchronous from here: nothing appends in between)
    if (kept.length * 2 <= lines.length && voicedOffset >= logged) {
      const all = readFileSync(VOICED), head = Buffer.from(kept.map((l) => l + '\n').join(''));
      writeFileSync(VOICED + '.tmp', Buffer.concat([head, all.subarray(logged)])); renameSync(VOICED + '.tmp', VOICED);
      voicedOffset = head.length + (voicedOffset - logged);
    }
  }
  const bytes = (f: (v: Version) => boolean) => versions.reduce((n, v) => n + (f(v) ? v.bytes : 0), 0);
  audio.last = { at: now, versions: versions.length, mb: mb(bytes(() => true)), tower_mb: mb(bytes((v) => v.tower)), kept_mb: mb(r.bytes),
    drop: r.drop.length, drop_mb: mb(r.drop.reduce((n, v) => n + v.bytes, 0)), marked: r.marked.size, full: r.full, ms: Math.round(performance.now() - t0) };
  console.log(JSON.stringify({ audio: { ...audio.last, dry: !real } }));
}

/** Nothing new is voiced while the node's disk is nearly full (whatever filled it), or the audio is over its cap with
 *  nothing left to drop: towerd is never what fills the disk. The disk is read every 5 s at most; tower-dry only
 *  logs what it would hold. */
let freeAt = 0, freePct = 100, heldFor = '';
function held() {
  if (Date.now() - freeAt > 5_000) {
    freeAt = Date.now();
    try { const s = statfsSync(LIVE); freePct = (100 * s.bavail) / s.blocks; } catch { /* the last reading stands */ }
  }
  const why = AUDIO_POLICY === 'age' ? '' : freePct < AUDIO.freeMin ? 'disk' : audio.full ? 'full' : '';
  if (why !== heldFor) { heldFor = why; console.log(JSON.stringify({ audio: { held: why || null, free_pct: Math.round(freePct * 10) / 10, dry: AUDIO_POLICY !== 'tower' } })); }
  return AUDIO_POLICY === 'tower' ? why : '';
}

// ---------------------------------------------------------------- commenters: a card each
// Their public Hacker News profile and a sample of their recent comments, summarised by Claude Haiku: what they
// tend to talk about and how they take part, never anything personal they haven't written themselves. Cached for
// three days, and only for people on the tower now (see /profile/ above).
const onTower = new Set<string>();
const PROFILES = join(VAR, 'profiles');
mkdirSync(PROFILES, { recursive: true });
const profileBudget: Bucket = { n: 20, at: Date.now() };          // model calls: about twenty a minute at most
const building = new Map<string, Promise<unknown>>();
let claude: Anthropic | null = null, lookedAt = 0;
/** The Anthropic API with its own key, else the in-cluster auth2api gateway (as the voice worker does). No key
 *  yet: looked for again every five minutes (a secret can arrive after the pod starts). */
function anthropic() {
  if (claude || Date.now() - lookedAt < 300_000) return claude;
  lookedAt = Date.now();
  const own = process.env.ANTHROPIC_API_KEY;
  let gateway = process.env.AUTH2API_KEY;
  if (!own && !gateway) { try { gateway = readFileSync(join(homedir(), '.cache/tohn-auth2api.key'), 'utf8').trim(); } catch { /* none here */ } }
  claude = own ? new Anthropic({ apiKey: own, timeout: 25_000, maxRetries: 1 })
    : gateway ? new Anthropic({ apiKey: gateway, baseURL: process.env.AUTH2API_URL ?? 'http://auth2api.apps.svc.cluster.local:8317', timeout: 25_000, maxRetries: 1 })
    : null;
  return claude;
}
/** HN's HTML (paragraphs, links, entities) as plain text */
function plain(html: string) {
  return html.replace(/<p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#x2F;/g, '/').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}
function cachedProfile(name: string): unknown {
  try {
    const c = JSON.parse(readFileSync(join(PROFILES, `${name}.json`), 'utf8'));
    if (Date.now() - c.at < c.ttl) return c.data;
  } catch { /* none yet */ }
  return null;
}
function profileOf(name: string): Promise<unknown> {
  const hit = cachedProfile(name);
  if (hit) return Promise.resolve(hit);
  let p = building.get(name);
  if (!p) { p = buildProfile(name).finally(() => building.delete(name)); building.set(name, p); }
  return p;
}
let onTowerAt = 0;
function refreshOnTower() {
  onTowerAt = Date.now();
  onTower.clear();
  for (const it of live.items.values()) if (it.by && !it.dead && !it.deleted) onTower.add(it.by);
}
/** someone who commented a moment ago is on the tower too: a miss looks again (at most every five seconds) */
function onTowerNow(name: string) {
  if (!onTower.has(name) && Date.now() - onTowerAt > 5000) refreshOnTower();
  return onTower.has(name);
}
async function buildProfile(name: string) {
  const u = await get<{ id: string; created: number; karma: number; about?: string; submitted?: number[] } | null>(`user/${name}`);
  if (!u) return null;
  const recent = await many((u.submitted ?? []).slice(0, 30), true, 24, false);
  const comments = recent.filter((it) => it.type === 'comment' && it.text && !it.dead && !it.deleted).slice(0, 20).map((it) => plain(it.text!).slice(0, 360));
  const titles = recent.filter((it) => it.type === 'story' && it.title).slice(0, 8).map((it) => it.title!);
  const about = plain(u.about ?? '').slice(0, 600);
  let ai: { brief?: string; interests?: string[]; role?: string } = {};
  let ok = false;
  const c = anthropic();
  if (c && (comments.length || about) && take(profileBudget, 20 / 60, 20)) {
    const prompt = 'You write a short, fair, factual card about a Hacker News commenter for a site where their public comments are read aloud. '
      + 'From their profile text and a sample of their recent comments, reply with JSON only: {"brief": "...", "interests": ["..."], "role": "..."}.\n'
      + '- brief: one sentence of at most 22 words on what they tend to discuss and how they take part (explaining, asking, arguing, sharing experience). Present tense, third person, no name.\n'
      + '- interests: 3 to 6 topics, 1 to 3 words each, lower case unless a proper noun.\n'
      + '- role: their work or project only if their profile text states it plainly, else "".\n'
      + 'Never guess or mention age, gender, nationality, location, ethnicity, religion, politics, health, or anything personal they have not written in their profile. No judgements of character, no quotes.\n\n'
      + `Profile text: ${about || '(empty)'}\n\nRecent comments:\n${comments.map((t) => '- ' + t.replace(/\s+/g, ' ')).join('\n') || '(none)'}\n\nStories they submitted: ${titles.join(' | ') || '(none)'}`;
    try {
      const msg = await c.messages.create({ model: process.env.TAG_MODEL ?? 'claude-haiku-5-5', max_tokens: 400, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] });
      if (msg.stop_reason !== 'refusal') {
        let text = '';
        for (const b of msg.content) if (b.type === 'text') text += b.text;
        const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        ai = {
          brief: typeof j.brief === 'string' ? j.brief.slice(0, 200) : undefined,
          interests: Array.isArray(j.interests) ? j.interests.filter((x: unknown) => typeof x === 'string').map((x: string) => x.slice(0, 32)).slice(0, 6) : undefined,
          role: typeof j.role === 'string' ? j.role.slice(0, 80) : undefined,
        };
        ok = true;
      }
    } catch (e) { console.error('profile', name, String(e).slice(0, 160)); }
  }
  const data = { name, karma: u.karma, created: u.created, about: about.slice(0, 420), ...ai };
  // a summary keeps three days; without one (no budget, model down), try again within the hour
  if (live.optOut.has(name)) return null;                // they opted out while it was being written
  writeAt(join(PROFILES, `${name}.json`), { at: Date.now(), ttl: ok || (!comments.length && !about) ? 3 * 86400_000 : 3600_000, data });
  return data;
}

// ---------------------------------------------------------------- voice runners (an internal port: never the ingress)
// Voice runners (apps/voice-worker) on any node: they claim a job (a long poll), beat while voicing it, send each clip
// as it is voiced (towerd writes it and the floor hears of it at once) and say when they're done. towerd stays the
// only writer of /data, so a runner needs no volume, no keys and no internet: only this port.
const VOICE_PORT = Number(process.env.VOICE_PORT ?? 8788);
const VOICE_TOKEN = process.env.VOICE_TOKEN ?? '';
setInterval(() => vq.sweep(), 1000).unref();
setInterval(() => {                                  // runner lanes come and go with their pods' names
  vq.forget();
  for (const [r, x] of runners) if (Date.now() - x.seen > 3_600_000) runners.delete(r);
}, 60_000).unref();

/** How to perform each comment, by `${id}.${rev}` (null: no model to ask; the runner judges from the words). The most
 *  recent few thousand are kept, queued or not: a table's later turns are tagged ahead, with its opening, so whoever
 *  sits down there never waits on the model. */
const tagsOf = new Map<string, Tag | null>();
const TAGS_KEPT = 5000;
function keepTag(k: string, t: Tag | null) {
  tagsOf.delete(k); tagsOf.set(k, t);
  if (tagsOf.size > TAGS_KEPT) tagsOf.delete(tagsOf.keys().next().value!);
}
const tagging = new Map<string, Promise<void>>();
const tagBudget: Bucket = { n: 30, at: Date.now() };              // model calls: about thirty a minute at most
let tagPauseUntil = 0;                               // the model failed (or the budget ran out): don't ask, or wait, until then
const tagStats = { calls: 0, comments: 0, failed: 0, claims: 0, waited: 0 };    // for /voice/status: is anyone waiting on the model?
const keyOf = (j: Job) => `${j.id}.${j.rev}`;
const tagKey = (e: Entry<Job>) => keyOf(e.job);
/** One call, in context, for a comment and more of its thread (up to `cap` in all): other queued comments (most
 *  urgent first, at most half), then the turns that follow it at its table, which nobody has asked for yet. A seat's
 *  call is kept small, so it comes back sooner. */
function tagBatch(first: Job, cap = 12): Promise<void> {
  const batch: Job[] = [first], have = new Set([keyOf(first)]);
  const add = (j: Job | undefined) => {
    if (!j || have.has(keyOf(j)) || tagsOf.has(keyOf(j)) || tagging.has(keyOf(j)) || !stillWanted(j)) return;
    have.add(keyOf(j)); batch.push(j);
  };
  for (const x of [...vq.entries.values()].sort((a, b) => a.prio - b.prio)) {
    if (batch.length >= cap / 2) break;
    if (x.job.story === first.story) add(x.job);
  }
  const turns = floors.get(first.story)?.tables.find((t) => t.turns.some((u) => u.id === first.id))?.turns ?? [];
  for (const u of turns.slice(turns.findIndex((u) => u.id === first.id) + 1)) {
    if (batch.length >= cap) break;
    if (needsVoice(u.id)) add(jobFor(u.id, 9999, 0));
  }
  const p = (async () => {
    const c = anthropic();
    if (!c) { for (const j of batch) keepTag(keyOf(j), null); return; }
    if (!take(tagBudget, 0.5, 30)) { tagPauseUntil = Date.now() + 5_000; return; }   // busy: runners judge from the words meanwhile
    tagStats.calls++; tagStats.comments += batch.length;
    const msg = await c.messages.create({ model: process.env.TAG_MODEL ?? 'claude-haiku-5-5', max_tokens: 2000, thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: tagPrompt(batch) }] });
    let text = '';
    for (const b of msg.content) if (b.type === 'text') text += b.text;
    const got = parseTags(text);
    for (const j of batch) keepTag(keyOf(j), got.get(j.id) ?? null);
  })().catch((e) => { tagStats.failed++; tagPauseUntil = Date.now() + 30_000; console.error('tags', String(e).slice(0, 160)); })
    .finally(() => { for (const j of batch) tagging.delete(keyOf(j)); setImmediate(prefetchTags); });
  for (const j of batch) tagging.set(keyOf(j), p);
  return p;
}
/** Tags ahead of need, one call at a time, most urgent first: a runner that claims a job rarely waits for them. */
function prefetchTags() {
  if (tagging.size || Date.now() < tagPauseUntil) return;
  let next: Entry<Job> | undefined;
  for (const x of vq.entries.values()) if (!tagsOf.has(tagKey(x)) && (!next || x.prio < next.prio)) next = x;
  if (next) tagBatch(next.job);
}
/** A seat or a floor someone is on waits at most a couple of seconds for its tags (then the words decide); background
 *  work can wait for the model. */
async function tagsFor(e: Entry<Job>) {
  const k = tagKey(e);
  tagStats.claims++;
  if (!tagsOf.has(k) && Date.now() >= tagPauseUntil) {
    tagStats.waited++;
    const seat = band(e.prio) < 2;
    await Promise.race([tagging.get(k) ?? tagBatch(e.job, seat ? 6 : 12), sleep(seat ? 2_500 : 15_000)]);
  }
  return tagsOf.get(k) ?? null;
}

/** A comment that was given back (it yielded, or its runner died) part-way carries on from its newest snapshot: the
 *  same tags and clips, so a listener who heard the start hears the rest in the same voice. */
function resumeOf(job: Job) {
  const n0 = clipsOf.get(job.id);
  if (!n0 || !Number.isFinite(n0)) return null;
  for (let n = Math.min(n0, 400); n >= 1; n--) {
    try {
      const snap = JSON.parse(readFileSync(join(LIVE, `c/${job.id}.${job.rev}.p${n}.json`), 'utf8'));
      if (snap.next && snap.clips.every((c: { u: string }) => existsSync(join(LIVE, c.u)))) return snap;
    } catch { /* not this one */ }
  }
  return null;
}

/** Still worth voicing as planned: not taken down, nobody opted out, the text unchanged. */
function stillWanted(job: Job) {
  const it = live.items.get(job.id);
  return !!it && !it.dead && !it.deleted && !!it.by && !live.optOut.has(it.by) && revOf(job.id) === job.rev;
}

type Side = { id: number; rev: string; by: string; dur: number; of?: number; emotion?: string; intensity?: number; clips: { u: string; d: number; who: string }[] };
/** A runner's sidecar, checked: it is this comment's, and every clip it lists is one of this comment's, already here. */
function sideOk(side: Side | undefined, job: Job): side is Side {
  const clip = new RegExp(`^c/${job.id}\\.${job.rev}\\.\\d{1,3}\\.ogg$`);
  return !!side && side.id === job.id && side.rev === job.rev && side.by === job.by && Number.isFinite(side.dur)
    && Array.isArray(side.clips) && side.clips.length <= 400                     // (none: nothing in it can be said)
    && side.clips.every((c) => c && typeof c.u === 'string' && clip.test(c.u) && Number.isFinite(c.d) && typeof c.who === 'string' && existsSync(join(LIVE, c.u)));
}
function putLive(rel: string, body: Buffer) {
  const p = join(LIVE, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + '.tmp', body);
  renameSync(p + '.tmp', p);
  try { hotPut(p, body, statSync(p).mtimeMs); } catch { /* served from disk then */ }
}
/** voiced.jsonl is the record (read back at start-up). The floor hears of it on the next tick, or, when someone is
 *  waiting on it (a seat, a floor someone stands on), within a moment: a second sooner on average. Background clips
 *  wait for the tick, so a busy hour of voicing doesn't rewrite floor files many times a second. */
function announce(job: Job, rel: string, side: Side, part: boolean, waited = false) {
  appendFileSync(VOICED, JSON.stringify({ id: job.id, by: job.by, path: rel, dur: Math.round(side.dur * 100) / 100, ...(part ? { partial: true } : {}),
    of: part ? side.of : side.clips.length, voices: [...new Set(side.clips.map((c) => c.who))].sort(), e: side.emotion, i: side.intensity }) + '\n');
  readVoiced();
  if (waited) publishSoon();
}

/** Who is voicing: per runner lane, where it runs and how fast it is (audio seconds per second of work). */
const runners = new Map<string, { node: string; cpus: number; threads: number; seen: number; clips: number; audio: number; work: number; up: number; ups: number; recv: number; serve: number }>();
function voicingSummary() {
  const now = Date.now(), nodes = new Set<string>();
  let lanes = 0, audio = 0, work = 0;
  for (const r of runners.values()) {
    if (now - r.seen > 60_000) continue;
    lanes++; nodes.add(r.node); audio += r.audio; work += r.work;
  }
  return { lanes, nodes: nodes.size, rtf: work ? Math.round((audio / work) * 100) / 100 : null, ahead: VOICE_AHEAD, ...vq.stats() };
}

function readBody(req: import('node:http').IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, bad) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > limit) { bad(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', bad);
  });
}
/** A request body: JSON, or a clip as runners send it (no base64): a 4-byte length, the gzipped JSON, the Ogg bytes. */
async function readVoice(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req, 4e6);
  if (req.headers['content-type'] !== 'application/x-tohn-clip') return buf.length ? JSON.parse(buf.toString('utf8')) : {};
  const n = buf.readUInt32BE(0);
  if (n > buf.length - 4) throw new Error('bad clip frame');
  return { ...JSON.parse(gunzipSync(buf.subarray(4, 4 + n)).toString('utf8')), ogg: buf.subarray(4 + n) };
}

async function voiceApi(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const send = (code: number, body?: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  if (VOICE_TOKEN && req.headers.authorization !== `Bearer ${VOICE_TOKEN}`) return send(401);
  if (req.method === 'GET' && url.pathname === '/voice/status') {
    const now = Date.now(), lanes = [...runners].filter(([, r]) => now - r.seen < 60_000)
      .map(([id, r]) => ({ lane: id, node: r.node, cpus: r.cpus, threads: r.threads, clips: r.clips, rtf: r.work ? Math.round((r.audio / r.work) * 100) / 100 : null,
        // a clip's trip as the runner sees it, and towerd's part of it: receiving the body, then handling it
        upload_ms: r.ups ? Math.round((r.up / r.ups) * 1000) : null,
        recv_ms: r.clips ? Math.round(r.recv / r.clips) : null, serve_ms: r.clips ? Math.round((r.serve / r.clips) * 10) / 10 : null }));
    return send(200, { ...voicingSummary(), tags: { kept: tagsOf.size, ...tagStats }, lanes });
  }
  if (req.method !== 'POST') return send(405);
  const t0 = performance.now();
  const b = await readVoice(req);
  const t1 = performance.now();
  if (url.pathname === '/voice/claim') {
    const runner = String(b.runner ?? '').slice(0, 120);
    if (!runner) return send(400);
    const r = runners.get(runner) ?? { node: '', cpus: 0, threads: 0, seen: 0, clips: 0, audio: 0, work: 0, up: 0, ups: 0, recv: 0, serve: 0 };
    runners.set(runner, { ...r, node: String(b.node ?? '').slice(0, 60), cpus: Number(b.cpus) || 0, threads: Number(b.threads) || 0, seen: Date.now() });
    const patience = Math.max(0, Math.min(120, Number(b.patience) || 0));
    vq.hear(runner, patience);                       // heard, even while starting up: a standby stays out of the way
    if (booting || !floors.size || held()) { await sleep(2000); return send(204); }
    const c = vq.claim(runner, patience, 25_000);
    let gone = false;
    res.on('close', () => { if (!res.writableEnded) { gone = true; c.cancel(); } });
    const e = await c.promise;
    if (!e) return send(204);
    const token = e.lease!.token;
    if (gone) { vq.release(token); return; }
    const final = `c/${e.id}.${e.job.rev}.json`;
    if (existsSync(join(LIVE, final))) {
      // voiced already (say, towerd restarted before it was announced): say so again, don't redo it
      try { announce(e.job, final, JSON.parse(readFileSync(join(LIVE, final), 'utf8')), false); } catch { /* unreadable: voiced again below */ }
      if (live.voiced.get(e.id)?.[0] === final) { vq.finish(token); return send(200, { again: true }); }
    }
    if (!stillWanted(e.job)) { vq.revoke(e.id); return send(200, { again: true }); }   // taken down or edited since it was planned
    const resume = resumeOf(e.job);
    const tags = resume ? null : await tagsFor(e);
    vq.hear(runner, patience);                       // waiting on the model, it was still here
    if (gone || !vq.get(token)) { vq.release(token); return send(204); }
    return send(200, { lease: token, job: e.job, tags, resume, leaseMs: vq.leaseMs });
  }
  const token = String(b.lease ?? ''), e = vq.get(token);
  if (!e) return send(409);
  if (!stillWanted(e.job)) { vq.revoke(e.id); return send(409); }   // taken down, opted out or edited: stop
  if (url.pathname === '/voice/beat') return send(200, vq.beat(token));
  if (url.pathname === '/voice/release') { vq.release(token); return send(200, {}); }
  if (url.pathname === '/voice/clip') {
    const k = b.k, ogg = Buffer.isBuffer(b.ogg) ? b.ogg : typeof b.ogg === 'string' ? Buffer.from(b.ogg, 'base64') : null;
    if (!Number.isInteger(k) || (k as number) < 0 || (k as number) > 400 || !ogg || ogg.length < 64 || ogg.subarray(0, 4).toString('latin1') !== 'OggS') return send(400);
    if (held() === 'disk') return send(507);         // the runner gives the job back; claims wait until there's room
    putLive(`c/${e.id}.${e.job.rev}.${k}.ogg`, ogg);
    const r = runners.get(String(b.runner ?? ''));
    if (r && Number(b.audio_s) > 0 && Number(b.work_s) > 0) { r.clips++; r.audio += Number(b.audio_s); r.work += Number(b.work_s); r.seen = Date.now(); }
    if (r && Number(b.up_s) > 0) { r.up += Number(b.up_s); r.ups++; }       // the previous clip's trip here, as the runner timed it
    const side = b.side as Side | undefined;
    if (side) {
      // playable so far: an immutable snapshot per clip count, so caches never need busting
      if (!sideOk(side, e.job)) return send(400);
      const rel = `c/${e.id}.${e.job.rev}.p${side.clips.length}.json`;
      putLive(rel, Buffer.from(JSON.stringify(side)));
      announce(e.job, rel, side, true, band(e.prio) < 2);
    }
    const now = vq.beat(token);
    if (r) { r.recv += t1 - t0; r.serve += performance.now() - t1; }
    return now ? send(200, now) : send(409);         // taken down while this clip was on its way
  }
  if (url.pathname === '/voice/done') {
    if (!b.opened) {
      const side = b.side as Side | undefined;
      if (!sideOk(side, e.job)) return send(400);
      const rel = `c/${e.id}.${e.job.rev}.json`;
      putLive(rel, Buffer.from(JSON.stringify(side)));
      announce(e.job, rel, side, false, band(e.prio) < 2);
    }
    tagsOf.delete(tagKey(e));
    vq.finish(token);
    return send(200, {});
  }
  send(404);
}
if (VOICE_PORT) {
  const vs = createServer((req, res) => {
    voiceApi(req, res).catch((e) => {
      console.error('voice', String(e).slice(0, 160));
      if (!res.headersSent && !res.destroyed) { res.writeHead(400); res.end(); }
    });
  });
  vs.keepAliveTimeout = 65_000; vs.headersTimeout = 70_000; vs.requestTimeout = 60_000;   // long polls, kept-alive runners
  vs.listen(VOICE_PORT, () => console.log(`voice runners on :${VOICE_PORT}${VOICE_TOKEN ? ' (token)' : ''}`));
}

/** What changed, written out: floors that changed (as snapshots, or patches in the delta), the delta, the queue, the
 *  head. Every loop, and a moment after a clip lands (at most every 150 ms, after the bootstrap). */
function publish() {
  const r = live.tick(Date.now());
  for (const s of r.snapshots) { floors.set(s.story.id, s); write(`f/${s.story.id}/${s.rev}.json`, s); }
  if (r.delta) write(`e/${r.delta.epoch}.json`, r.delta);
  syncJobs();
  const head = { ...r.head, load: backlog, ...(PLAY.length ? { play: PLAY } : {}) }, key = JSON.stringify({ ...head, at: 0 });
  if (key !== headKey) { write('head.json', head); headKey = key; }
}
let publishTimer: ReturnType<typeof setTimeout> | null = null, publishedAt = 0;
function publishSoon() {
  if (booting || publishTimer) return;
  const wait = Math.max(150, publishedAt + 500 - Date.now());       // at most twice a second
  publishTimer = setTimeout(() => {
    publishTimer = null; publishedAt = Date.now();
    try { publish(); } catch (e) { console.error('publish', String(e).slice(0, 160)); }
  }, wait);
}

// ---------------------------------------------------------------- bootstrap, then follow the firehose
const t0 = Date.now();
async function forever<T>(what: string, f: () => Promise<T>): Promise<T> {
  for (let a = 0; ; a++) {
    try { return await f(); } catch (e) { console.error(what, String(e).slice(0, 160)); await sleep(Math.min(60_000, 2000 * 2 ** a)); heartbeat = Date.now(); }
  }
}
const top = (await forever('topstories', () => get<number[]>('topstories'))).slice(0, FLOORS);
let frontier = top.slice();
while (frontier.length) {
  const items = await many(frontier, true);
  for (const it of items) live.upsert(it);
  frontier = items.flatMap((it) => (it.dead || it.deleted ? [] : it.kids ?? []));
}
live.setTower(top);
readOptOut();
readVoiced();
booting = false;
// clear stale job files from a previous run; they are re-planned from current state
// job files from before voice runners (0.4.6 and older): the queue lives in memory now
for (const n of readdirSync(JOBS)) if (n.endsWith('.json')) { try { unlinkSync(join(JOBS, n)); } catch { /* gone already */ } }
let maxitem = await forever('maxitem', () => get<number>('maxitem'));
console.log(JSON.stringify({ bootstrap: { items: live.items.size, voiced: live.voiced.size, skipped, seconds: (Date.now() - t0) / 1000 } }));

let lastTop = Date.now(), lastUpdates = '', lastChores = 0, lastPrune = 0, pruning = false;
for (;;) {
  const loopStart = Date.now();
  try {
    const mx = await get<number>('maxitem');
    if (mx > maxitem) {
      const fresh = await many(Array.from({ length: Math.min(200, mx - maxitem) }, (_, i) => maxitem + 1 + i));
      // only replies inside threads we follow (new stories come in through topstories): the rest of HN is
      // ~13k items a day that would otherwise pile up in memory
      for (const it of fresh) if (it.parent !== undefined && live.items.has(it.parent)) live.upsert(it);
      const parents = [...new Set(fresh.map((it) => it.parent).filter((p): p is number => !!p && live.items.has(p)))];
      for (const it of await many(parents)) live.upsert(it);
      maxitem = mx;
    }
    const upd = await get<{ items: number[] }>('updates');
    const key = (upd.items ?? []).join();
    if (key !== lastUpdates) {
      lastUpdates = key;
      for (const it of await many((upd.items ?? []).filter((id) => live.items.has(id)))) {
        live.upsert(it);
        if (it.dead || it.deleted) unvoice(it.id);                  // HN took it down: so do we
      }
    }
    if (Date.now() - lastTop > 30_000) {
      const order = (await get<number[]>('topstories')).slice(0, FLOORS);
      let fr = order.filter((id) => !live.items.has(id));
      // replies never fetched (a failure at start-up, or mid-walk): a few tries each
      for (const it of live.items.values()) {
        if (it.dead || it.deleted) continue;
        for (const k of it.kids ?? []) if (!live.items.has(k) && (tries.get(k) ?? 0) < 3) { fr.push(k); tries.set(k, (tries.get(k) ?? 0) + 1); }
      }
      if (fr.length > order.length) console.log(JSON.stringify({ repair: fr.length }));
      while (fr.length) { const its = await many(fr); its.forEach((it) => live.upsert(it)); fr = its.flatMap((it) => it.kids ?? []); }
      live.setTower(order);
      lastTop = Date.now();
    }
  } catch (e) { console.error('ingest', String(e).slice(0, 200)); }
  try {
    readVoiced();
    if (Date.now() - lastChores > 60_000 || !onTower.size) {
      lastChores = Date.now(); readOptOut();
      refreshOnTower();
    }
    if (Date.now() - lastPrune > PRUNE_MS && !pruning) {
      lastPrune = Date.now(); pruning = true;
      prune().catch((e) => console.error('prune', String(e).slice(0, 200))).finally(() => { pruning = false; });
    }
    publish();
  } catch (e) { console.error('tick', String(e).slice(0, 200)); }      // a full disk, say: keep serving, keep trying
  heartbeat = Date.now();
  await sleep(Math.max(0, 2000 - (Date.now() - loopStart)));
}
