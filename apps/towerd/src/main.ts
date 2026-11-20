// towerd: the local stand-in for the edge + CDN.
//   - follows the HN firehose into the shared Live state (packages/core)
//   - writes head.json / e/<n>.json / f/<story>/<rev>.json under var/live
//   - queues voicing jobs for the Python worker (prewarm the best tables, and any table someone sits at)
//   - serves var/live over HTTP with production-like cache headers
//   - in production also serves the built client, and keeps var/ tidy (old deltas, floor revisions, audio)
// usage: node src/main.ts
// env: PORT, VAR, STATIC (the client's dist), RETENTION_DAYS (audio, default 14), OPTOUT (comma-separated HN
//      users never voiced; also var/optout.txt, one per line, re-read every minute),
//      PREWARM_FLOORS, PREWARM_TABLES, PREWARM_TURNS, PREWARM_BAR, VOICE_VERSION
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, readdirSync, unlinkSync, statSync, openSync, readSync, closeSync, rmdirSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { Live, type Item, type FloorSnapshot } from '../../../packages/core/src/live.ts';
import { speakable } from '../../../packages/core/src/speakable.ts';

const HN = 'https://hacker-news.firebaseio.com/v0';
const UA = { 'User-Agent': 'towerofhan-towerd/0.1' };
const PORT = Number(process.env.PORT ?? 8787);
const VAR = resolve(process.env.VAR ?? join(import.meta.dirname, '../../../var'));
const LIVE = join(VAR, 'live'), JOBS = join(VAR, 'jobs'), VOICED = join(VAR, 'voiced.jsonl');
const FLOORS = 30;
const PRE = { floors: Number(process.env.PREWARM_FLOORS ?? 6), tables: Number(process.env.PREWARM_TABLES ?? 4), turns: Number(process.env.PREWARM_TURNS ?? 14), bar: Number(process.env.PREWARM_BAR ?? 6) };
const MAX_QUEUED = 12;
/** bump to re-voice everything (new pace, new model): old audio keeps playing until its replacement lands */
const VOICE_VERSION = process.env.VOICE_VERSION ?? 'v2';
const STATIC = resolve(process.env.STATIC ?? join(import.meta.dirname, '../../client/dist'));
const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS) || 14);
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
async function many(ids: number[], lenient = false, conc = 24): Promise<Item[]> {
  const res: Item[] = [];
  for (let i = 0; i < ids.length; i += conc) {
    const one = (id: number) => (lenient ? get<Item>(`item/${id}`).catch(() => { skipped++; return null as unknown as Item; }) : get<Item>(`item/${id}`));
    res.push(...(await Promise.all(ids.slice(i, i + conc).map(one))).filter(Boolean));
    heartbeat = Date.now();                            // progress, even in a long bootstrap
  }
  return res;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function write(rel: string, data: unknown) {
  const p = join(LIVE, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + '.tmp', JSON.stringify(data));
  renameSync(p + '.tmp', p);
}

// ---------------------------------------------------------------- state
const live = new Live({ snapshotEvery: 1, base: Date.now() });
let heartbeat = Date.now();                          // /livez: the ingest loop (or the bootstrap) is making progress
process.on('SIGTERM', () => process.exit(0));        // PID 1 in a container: exit at once on a rollout
const floors = new Map<number, FloorSnapshot>();
const demand = new Map<number, number>();            // comment id -> priority (lower = sooner)
const demandAt = new Map<number, number>();          // when a listener last asked: demand lapses unless renewed
const DEMAND_TTL = 90_000;
const queued = new Map<number, string>();            // comment id -> job file name
const stale = new Set<number>();                     // voiced with an older VOICE_VERSION: re-voice in the background
const partial = new Set<number>();                   // playable, but the worker is still voicing the rest of it
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
      if (!v.by || !v.voices) {
        try {
          const side = JSON.parse(readFileSync(join(LIVE, v.path), 'utf8'));
          v.by ??= side.by;
          v.voices ??= [...new Set((side.clips ?? []).map((c: { who: string }) => c.who))];
          v.of ??= side.of ?? (side.clips ?? []).length;
        } catch { /* gone: nothing to remember */ }
      }
      remember(v.id, v.path, v.by, v.of, v.voices);
      const it = live.items.get(v.id), by = v.by ?? it?.by;
      const hushed = (by && live.optOut.has(by)) || (v.voices ?? []).some((w: string) => live.optOut.has(w));
      if ((it && (it.dead || it.deleted)) || hushed) { unvoice(v.id); continue; }
      const prev = live.voiced.get(v.id);
      const want = revOf(v.id), got = String(v.path).split('.')[1];
      if (want && got !== want) {                   // an older version: use it until the new one lands
        if (!prev) live.markVoiced(v.id, v.path, v.dur);
        stale.add(v.id);
        continue;
      }
      if (v.partial) {                              // a long comment arriving clip by clip: playable already
        const done = prev && !partial.has(v.id) && String(prev[0]).split('.')[1] === got;
        if (!done && (!prev || !partial.has(v.id) || v.dur > prev[1])) { live.markVoiced(v.id, v.path, v.dur); partial.add(v.id); }
        continue;                                   // the job is still running: keep it queued
      }
      live.markVoiced(v.id, v.path, v.dur);
      partial.delete(v.id);
      stale.delete(v.id);
      queued.delete(v.id);
      demand.delete(v.id); demandAt.delete(v.id);
    } catch { /* partial line */ }
  }
}

// ---------------------------------------------------------------- voicing queue
function wanted(): [number, number][] {
  // listeners who left stop costing anyone else: their requests lapse after DEMAND_TTL unless renewed
  for (const [id, at] of demandAt) if (Date.now() - at > DEMAND_TTL) { demand.delete(id); demandAt.delete(id); }
  const out = new Map<number, number>(demand);
  live.tower.slice(0, PRE.floors).forEach((sid, fi) => {
    const f = floors.get(sid);
    if (!f) return;
    f.tables.filter((t) => t.turns.length >= 2).slice(0, PRE.tables).forEach((t, ti) => {
      t.turns.slice(0, PRE.turns).forEach((u, k) => { if (!out.has(u.id)) out.set(u.id, 1000 + fi * 100 + ti * 15 + k); });
    });
    // the bar's one-liners too, after the conversations
    f.tables.filter((t) => t.turns.length === 1).slice(0, PRE.bar).forEach((t, k) => {
      if (!out.has(t.turns[0].id)) out.set(t.turns[0].id, 1000 + fi * 100 + 80 + k);
    });
  });
  return [...out].filter(([id]) => needsVoice(id) || stale.has(id)).sort((a, b) => a[1] - b[1]);
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

function jobFor(id: number, prio: number) {
  const it = live.items.get(id);
  if (!it?.text || !it.by || it.dead || it.deleted || live.optOut.has(it.by)) return undefined;
  const parent = it.parent !== undefined ? live.items.get(it.parent) : undefined;
  const sp = speakable(it.text, parent?.text ? { id: parent.id, text: parent.text } : undefined);
  const sid = live.storyOf(id)!;
  const f = floors.get(sid);
  const table = f ? f.tables.findIndex((t) => t.turns.some((u) => u.id === id)) : -1;
  return {
    id, prio, story: sid, table, by: it.by,
    parentBy: parent?.type === 'comment' && parent.by && !live.optOut.has(parent.by) ? parent.by : undefined,
    rev: revOf(id)!,
    segments: sp.segments,
  };
}

function syncJobs() {
  const target = wanted().slice(0, MAX_QUEUED);
  // jobs nobody wants any more (a listener left, demand lapsed) leave the queue, so the worker voices what's needed now
  const keep = new Set(target.map(([id]) => id));
  for (const [id, name] of queued) {
    if (keep.has(id)) continue;
    try { unlinkSync(join(JOBS, name)); } catch { /* the worker has it already */ }
    queued.delete(id);
  }
  for (const [id, prio] of target) {
    const name = `${String(prio).padStart(6, '0')}-${id}.json`;
    const cur = queued.get(id);
    if (cur === name) continue;
    const job = jobFor(id, prio);
    if (!job) continue;
    if (cur && existsSync(join(JOBS, cur))) { try { unlinkSync(join(JOBS, cur)); } catch { /* worker took it */ } }
    writeFileSync(join(JOBS, name + '.tmp'), JSON.stringify(job));
    renameSync(join(JOBS, name + '.tmp'), join(JOBS, name));
    queued.set(id, name);
  }
}

// ---------------------------------------------------------------- HTTP: the CDN, the client, one write endpoint
const TYPES: Record<string, string> = {
  '.json': 'application/json', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
// The page loads nothing from anywhere else; comments are text, and links in them are plain http(s) anchors.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "media-src 'self' blob:; connect-src 'self'; font-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'";
// POST /want only ever queues voicing of real comments on the current front page, but bound it anyway:
// per client (a seated listener renews about once every 30 s per table) and overall.
type Bucket = { n: number; at: number };
const take = (b: Bucket, rate: number, burst: number) => {
  b.n = Math.min(burst, b.n + ((Date.now() - b.at) / 1000) * rate); b.at = Date.now();
  if (b.n < 1) return false;
  b.n--; return true;
};
const everyone: Bucket = { n: 120, at: Date.now() }, clients = new Map<string, Bucket>();
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
  // Traefik replaces X-Real-Ip with the address it saw (and the NetworkPolicy admits only Traefik and agentfest);
  // when that address is a Cloudflare edge, the edge names the visitor
  const peer = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
  const cf = req.headers['cf-connecting-ip'];
  const ip = (typeof cf === 'string' && cloudflare(peer) ? cf : peer).replace(/%.*$/, '').slice(0, 64);
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
  return take(b, 1, 20) && take(everyone, 30, 120);
}
createServer((req, res) => {
  try { handle(req, res); } catch (e) {
    console.error('http', String(e).slice(0, 160));
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
}).listen(PORT, () => console.log(`towerd on http://localhost:${PORT}  (var: ${VAR})`));

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
        const { story, table, from = 0 } = JSON.parse(body);
        if (![story, table, from].every((n) => Number.isInteger(n) && n >= 0)) throw new Error('bad request');
        const f = floors.get(story);
        const turns = f?.tables[table]?.turns.slice(from, from + 24) ?? [];
        const fresh = (id: number) => Date.now() - (demandAt.get(id) ?? 0) < DEMAND_TTL;
        turns.forEach((u, k) => {
          if (!needsVoice(u.id)) return;
          demand.set(u.id, fresh(u.id) ? Math.min(demand.get(u.id) ?? 999, k) : k);
          demandAt.set(u.id, Date.now());
        });
        syncJobs();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ queued: turns.filter((u) => needsVoice(u.id)).length }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }
  if (url.pathname === '/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ items: live.items.size, voiced: live.voiced.size, queued: queued.size, demand: demand.size, tower: live.tower.length }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  if (!url.pathname.startsWith('/live/')) {
    // the client: index.html is always revalidated; everything under /assets/ is content-hashed, so forever
    let p = resolve(STATIC, '.' + decodeURIComponent(url.pathname));
    if (!p.startsWith(STATIC + '/') && p !== STATIC) { res.writeHead(404); res.end(); return; }
    const missing = !existsSync(p) || statSync(p).isDirectory();
    if (missing && url.pathname.startsWith('/assets/')) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
    if (missing) p = join(STATIC, 'index.html');
    if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
    const forever = url.pathname.startsWith('/assets/');
    const body = readOr503(p, res);
    if (!body) return;
    res.writeHead(200, {
      'content-type': TYPES[extname(p)] ?? 'application/octet-stream',
      'cache-control': forever ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(extname(p) === '.html' ? { 'content-security-policy': CSP, 'referrer-policy': 'strict-origin-when-cross-origin' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  const p = resolve(LIVE, '.' + url.pathname.slice(5));
  if (!p.startsWith(LIVE + '/') || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
  const isHead = url.pathname === '/live/head.json';
  const body = readOr503(p, res);
  if (!body) return;
  res.writeHead(200, {
    'content-type': TYPES[extname(p)] ?? 'application/octet-stream',
    'cache-control': isHead ? 'public, max-age=1, stale-while-revalidate=10' : 'public, max-age=31536000, immutable',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** A file's bytes, or a 503 nobody caches: a read error must never become an empty response cached for a year. */
function readOr503(p: string, res: import('node:http').ServerResponse) {
  try { return readFileSync(p); } catch {
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
  const v = live.voiced.get(id), k = known.get(id);
  if (!v && !k) return;
  if (v) live.voiced.delete(id);
  stale.delete(id); partial.delete(id);
  const stems = new Map(k?.stems ?? []);
  if (v && !stems.has(stemOf(String(v[0])))) stems.set(stemOf(String(v[0])), 120);
  for (const [stem, of] of stems) {
    if (!stem.startsWith(`c/${id}.`)) continue;
    // a clip per planned chunk (c/<id>.<rev>.<k>.ogg), a snapshot per clip count (.p<n>.json), the sidecar
    for (let n = 0; n <= of; n++) for (const f of [`${stem}.${n}.ogg`, `${stem}.p${n}.json`]) { try { unlinkSync(join(LIVE, f)); } catch { /* none */ } }
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
  console.log(JSON.stringify({ optout: names.size }));
}

/** var/ only grows otherwise: deltas every tick, a floor revision per change, audio forever. Runs in slices,
 *  letting the server and the ingest loop breathe between them. */
async function prune() {
  const now = Date.now();
  let removed = 0, seen = 0;
  const breathe = async () => { if (++seen % 400 === 0) await new Promise((r) => setImmediate(r)); };
  // deltas: clients catch up from at most the last 20 epochs
  const gone = (f: string) => { try { unlinkSync(f); removed++; } catch { /* already gone, or mid-write */ } };
  const epochs = readdirSync(join(LIVE, 'e')).map((n) => parseInt(n)).filter(Number.isFinite);
  const latest = epochs.reduce((a, b) => Math.max(a, b), 0);
  for (const n of readdirSync(join(LIVE, 'e'))) if (parseInt(n) < latest - 600) gone(join(LIVE, 'e', n));
  // floor revisions: keep the newest few per story (a client may be fetching the previous one); drop old stories
  const head = existsSync(join(LIVE, 'head.json')) ? JSON.parse(readFileSync(join(LIVE, 'head.json'), 'utf8')) : { floors: {} };
  for (const sid of readdirSync(join(LIVE, 'f'))) {
    const dir = join(LIVE, 'f', sid);
    const revs = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).map((n) => parseInt(n)).sort((a, b) => b - a);
    const onTower = head.floors?.[sid] !== undefined;
    for (const [k, r] of revs.entries()) {
      await breathe();
      if ((onTower && k < 4) || r === head.floors?.[sid]) continue;
      try { if (!onTower && k === 0 && now - statSync(join(dir, `${r}.json`)).mtimeMs < 3 * 86400_000) continue; } catch { continue; }   // a story that just left
      gone(join(dir, `${r}.json`));
    }
    try { if (!readdirSync(dir).length) rmdirSync(dir); } catch { /* not empty after all */ }
  }
  // audio: older than RETENTION_DAYS goes (it is voiced again if it is ever wanted), partial snapshots after a day
  const dir = join(LIVE, 'c');
  for (const n of readdirSync(dir)) {
    await breathe();
    let age = 0;
    try { age = now - statSync(join(dir, n)).mtimeMs; } catch { continue; }
    const id = parseInt(n), snap = /\.p\d+\.json$/.test(n);
    if (snap && live.voiced.get(id)?.[0] === `c/${n}`) continue;   // still what its floor plays: kept until finished
    if (age > RETENTION_DAYS * 86400_000 || (snap && age > 86400_000)) {
      if (!snap && n.endsWith('.json')) {
        if (live.voiced.get(id)?.[0] === `c/${n}`) live.voiced.delete(id);
        const k = known.get(id);
        if (k) { k.stems.delete(`c/${n.replace(/\.json$/, '')}`); if (!k.stems.size) known.delete(id); }   // voices kept with the id
      }
      gone(join(dir, n));
    }
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
for (const n of readdirSync(JOBS)) if (n.endsWith('.json')) { try { unlinkSync(join(JOBS, n)); } catch { /* the worker took it */ } }
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
    if (Date.now() - lastChores > 60_000) { lastChores = Date.now(); readOptOut(); }
    if (Date.now() - lastPrune > 600_000 && !pruning) {
      lastPrune = Date.now(); pruning = true;
      prune().catch((e) => console.error('prune', String(e).slice(0, 200))).finally(() => { pruning = false; });
    }
    const r = live.tick(Date.now());
    for (const s of r.snapshots) { floors.set(s.story.id, s); write(`f/${s.story.id}/${s.rev}.json`, s); }
    if (r.delta) write(`e/${r.delta.epoch}.json`, r.delta);
    write('head.json', r.head);
    syncJobs();
  } catch (e) { console.error('tick', String(e).slice(0, 200)); }      // a full disk, say: keep serving, keep trying
  heartbeat = Date.now();
  await sleep(Math.max(0, 2000 - (Date.now() - loopStart)));
}
