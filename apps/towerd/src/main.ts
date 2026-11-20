// towerd: the local stand-in for the edge + CDN.
//   - follows the HN firehose into the shared Live state (packages/core)
//   - writes head.json / e/<n>.json / f/<story>/<rev>.json under var/live
//   - queues voicing jobs for the Python worker (prewarm the best tables, and any table someone sits at)
//   - serves var/live over HTTP with production-like cache headers
//   - in production also serves the built client, and keeps var/ tidy (old deltas, floor revisions, audio)
// usage: node src/main.ts
// env: PORT, VAR, STATIC (the client's dist), RETENTION_DAYS (audio, default 30), OPTOUT (comma-separated HN
//      users never voiced; also var/optout.txt, one per line, re-read every minute),
//      PREWARM_FLOORS, PREWARM_TABLES, PREWARM_TURNS, PREWARM_BAR, VOICE_VERSION
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, readdirSync, unlinkSync, statSync, openSync, readSync, closeSync, rmdirSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { Live, type Item, type FloorSnapshot } from '../../../packages/core/src/live.ts';
import { speakable } from '../../../packages/core/src/speakable.ts';

const HN = 'https://hacker-news.firebaseio.com/v0';
const UA = { 'User-Agent': 'towerofhan-towerd/0.1 (local dev)' };
const PORT = Number(process.env.PORT ?? 8787);
const VAR = resolve(process.env.VAR ?? join(import.meta.dirname, '../../../var'));
const LIVE = join(VAR, 'live'), JOBS = join(VAR, 'jobs'), VOICED = join(VAR, 'voiced.jsonl');
const FLOORS = 30;
const PRE = { floors: Number(process.env.PREWARM_FLOORS ?? 6), tables: Number(process.env.PREWARM_TABLES ?? 4), turns: Number(process.env.PREWARM_TURNS ?? 14), bar: Number(process.env.PREWARM_BAR ?? 6) };
const MAX_QUEUED = 12;
/** bump to re-voice everything (new pace, new model): old audio keeps playing until its replacement lands */
const VOICE_VERSION = process.env.VOICE_VERSION ?? 'v2';
const STATIC = resolve(process.env.STATIC ?? join(import.meta.dirname, '../../client/dist'));
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 30);
for (const d of [LIVE, JOBS]) mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- HN access
async function get<T>(path: string): Promise<T> {
  for (let a = 0; ; a++) {
    try { return (await (await fetch(`${HN}/${path}.json`, { headers: UA })).json()) as T; }
    catch (e) { if (a > 4) throw e; await sleep(500 * 2 ** a); }
  }
}
async function many(ids: number[], conc = 24): Promise<Item[]> {
  const res: Item[] = [];
  for (let i = 0; i < ids.length; i += conc) res.push(...(await Promise.all(ids.slice(i, i + conc).map((id) => get<Item>(`item/${id}`)))).filter(Boolean));
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
const live = new Live({ snapshotEvery: 1 });
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
  const t = live.items.get(id)?.text;
  return t ? createHash('sha1').update(VOICE_VERSION + ':' + t).digest('hex').slice(0, 8) : undefined;
}

function jobFor(id: number, prio: number) {
  const it = live.items.get(id);
  if (!it?.text || !it.by) return undefined;
  const parent = it.parent !== undefined ? live.items.get(it.parent) : undefined;
  const sp = speakable(it.text, parent?.text ? { id: parent.id, text: parent.text } : undefined);
  const sid = live.storyOf(id)!;
  const f = floors.get(sid);
  const table = f ? f.tables.findIndex((t) => t.turns.some((u) => u.id === id)) : -1;
  return {
    id, prio, story: sid, table, by: it.by, parentBy: parent?.type === 'comment' ? parent.by : undefined,
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
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "media-src 'self' blob:; connect-src 'self'; font-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'";
// POST /want only ever queues voicing of real comments on the current front page, but bound it anyway:
// every client renews its requests while seated, so 6/s with a burst of 60 is far above honest use.
let bucket = 60, bucketAt = Date.now();
const allow = () => { bucket = Math.min(60, bucket + ((Date.now() - bucketAt) / 1000) * 6); bucketAt = Date.now(); return bucket >= 1 && bucket-- >= 1; };
createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/livez') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"ok":true}'); return; }
  if (req.method === 'POST' && url.pathname === '/want') {
    if (!allow()) { res.writeHead(429, { 'retry-after': '2' }); res.end(); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        if (body.length > 200) throw new Error('too big');
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
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(STATIC, 'index.html');
    if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
    const forever = url.pathname.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': TYPES[extname(p)] ?? 'application/octet-stream',
      'cache-control': forever ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(extname(p) === '.html' ? { 'content-security-policy': CSP, 'referrer-policy': 'strict-origin-when-cross-origin' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(p));
    return;
  }
  const p = resolve(LIVE, '.' + url.pathname.slice(5));
  if (!p.startsWith(LIVE) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
  const isHead = url.pathname === '/live/head.json';
  res.writeHead(200, {
    'content-type': TYPES[extname(p)] ?? 'application/octet-stream',
    'cache-control': isHead ? 'public, max-age=1, stale-while-revalidate=10' : 'public, max-age=31536000, immutable',
  });
  res.end(readFileSync(p));
}).listen(PORT, () => console.log(`towerd on http://localhost:${PORT}  (var: ${VAR})`));

// ---------------------------------------------------------------- housekeeping
/** Remove a comment's audio (HN deleted or killed it, or its author opted out). */
function unvoice(id: number) {
  if (!live.voiced.has(id)) return;
  live.voiced.delete(id);
  stale.delete(id); partial.delete(id);
  // every version of it: c/<id>.<rev>.json, its clips, its partial snapshots
  const dir = join(LIVE, 'c');
  for (const n of readdirSync(dir)) if (n.startsWith(id + '.')) { try { unlinkSync(join(dir, n)); } catch { /* gone */ } }
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
  for (const id of [...live.voiced.keys()]) { const by = live.items.get(id)?.by; if (by && names.has(by)) unvoice(id); }
  console.log(JSON.stringify({ optout: names.size }));
}

/** var/ only grows otherwise: deltas every tick, a floor revision per change, audio forever. */
function prune() {
  const now = Date.now();
  let removed = 0;
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
    revs.forEach((r, k) => {
      if ((onTower && k < 4) || r === head.floors?.[sid]) return;
      if (!onTower && k === 0 && now - statSync(join(dir, `${r}.json`)).mtimeMs < 3 * 86400_000) return;   // a story that just left
      gone(join(dir, `${r}.json`));
    });
    try { if (!readdirSync(dir).length) rmdirSync(dir); } catch { /* not empty after all */ }
  }
  // audio: older than RETENTION_DAYS goes (it is voiced again if it is ever wanted), partial snapshots after a day
  const dir = join(LIVE, 'c');
  for (const n of readdirSync(dir)) {
    const age = now - statSync(join(dir, n)).mtimeMs;
    if (age > RETENTION_DAYS * 86400_000 || (/\.p\d+\.json$/.test(n) && age > 86400_000)) {
      const id = parseInt(n);
      if (!/\.p\d+\.json$/.test(n) && live.voiced.has(id)) live.voiced.delete(id);
      gone(join(dir, n));
    }
  }
  if (removed) console.log(JSON.stringify({ pruned: removed }));
}

// ---------------------------------------------------------------- bootstrap, then follow the firehose
const t0 = Date.now();
const top = (await get<number[]>('topstories')).slice(0, FLOORS);
let frontier = top.slice();
while (frontier.length) {
  const items = await many(frontier);
  for (const it of items) live.upsert(it);
  frontier = items.flatMap((it) => (it.dead || it.deleted ? [] : it.kids ?? []));
}
live.setTower(top);
readOptOut();
readVoiced();
booting = false;
// clear stale job files from a previous run; they are re-planned from current state
for (const n of readdirSync(JOBS)) if (n.endsWith('.json')) unlinkSync(join(JOBS, n));
let maxitem = await get<number>('maxitem');
console.log(JSON.stringify({ bootstrap: { items: live.items.size, voiced: live.voiced.size, seconds: (Date.now() - t0) / 1000 } }));

let lastTop = Date.now(), lastUpdates = '', lastChores = 0;
for (;;) {
  const loopStart = Date.now();
  try {
    const mx = await get<number>('maxitem');
    if (mx > maxitem) {
      const fresh = await many(Array.from({ length: Math.min(200, mx - maxitem) }, (_, i) => maxitem + 1 + i));
      for (const it of fresh) live.upsert(it);
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
      while (fr.length) { const its = await many(fr); its.forEach((it) => live.upsert(it)); fr = its.flatMap((it) => it.kids ?? []); }
      live.setTower(order);
      lastTop = Date.now();
    }
  } catch (e) { console.error('ingest', String(e).slice(0, 200)); }
  readVoiced();
  if (Date.now() - lastChores > 60_000) {
    lastChores = Date.now();
    try { readOptOut(); if (new Date().getMinutes() % 10 === 0) prune(); } catch (e) { console.error('chores', String(e).slice(0, 200)); }
  }
  const r = live.tick(Date.now());
  for (const s of r.snapshots) { floors.set(s.story.id, s); write(`f/${s.story.id}/${s.rev}.json`, s); }
  if (r.delta) write(`e/${r.delta.epoch}.json`, r.delta);
  write('head.json', r.head);
  syncJobs();
  await sleep(Math.max(0, 2000 - (Date.now() - loopStart)));
}
