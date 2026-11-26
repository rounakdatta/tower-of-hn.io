#!/usr/bin/env node
// Simulated listeners for a staging towerd: each does what the real client does, at the client's own pace.
//   - opens the page (index.html and its assets, once), then polls head.json every 2 s with its ETag (304s mostly);
//     on a new epoch, fetches the deltas in between (as sync.ts does) and its floor when it changed
//   - sits at a table (floors and tables chosen as people do: the top of the tower, the best tables, more often),
//     asks for its voicing (POST /want, renewed every 30 s), and plays it turn by turn in real time: each turn's
//     sidecar and clips, fetched a few turns ahead; an unvoiced turn is waited on 4 s, then skipped
//   - hears the room: the three nearest other tables play on at the same time (the client's mixer), and every 4-9 s a
//     clip from another table drifts across (the director's murmur); all from its own cache when it has them
//   - after a few minutes, another table (60%) or another floor (40%)
// Each listener has its own connections (keep-alive) and its own address (X-Real-Ip, as Traefik would set it), and
// its own HTTP cache for immutable files (a browser never fetches a clip twice).
//
// usage: node load.mjs BASE LISTENERS SECONDS [--ramp PER_SECOND=5] [--seed 1] [--tag name]
// prints one JSON line every 10 s (requests by kind: count, errors, p50/p95/p99 ms, bytes) and a summary at the end.
import { Agent, request } from 'undici';

const [, , BASE, N = '100', SECS = '120', ...rest] = process.argv;
// staging only: never the live site (its names, its in-cluster Service), which this would make voice for fake listeners
if (/towerof(hn|han)|taptappers\.club/i.test(new URL(BASE).hostname)) { console.error('load.mjs: that is the live site; load tests run against a staging copy only'); process.exit(2); }
const opt = (k, d) => { const i = rest.indexOf(k); return i < 0 ? d : rest[i + 1]; };
const RAMP = Number(opt('--ramp', 5)), TAG = opt('--tag', 'load');
let seed = Number(opt('--seed', 1));
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (n, bias = 1.6) => Math.min(n - 1, Math.floor(n * Math.pow(rnd(), bias)));   // favours the top
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const end = Date.now() + Number(SECS) * 1000;

// ---------------------------------------------------------------- measuring
const stats = new Map();                              // kind -> { n, err, ms: [], bytes }
const window_ = new Map();
function note(kind, ms, bytes, ok) {
  for (const m of [stats, window_]) {
    let s = m.get(kind);
    if (!s) m.set(kind, (s = { n: 0, err: 0, ms: [], bytes: 0 }));
    s.n++; s.bytes += bytes; if (!ok) s.err++; s.ms.push(ms);
  }
}
const q = (xs, p) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10; };
const summary = (m) => Object.fromEntries([...m].map(([k, s]) => [k, { n: s.n, err: s.err, p50: q(s.ms, 0.5), p95: q(s.ms, 0.95), p99: q(s.ms, 0.99), mb: Math.round(s.bytes / 1e5) / 10 }]));
let active = 0;
const t0 = Date.now();
const tick = setInterval(() => {
  const all = [...window_.values()].reduce((a, s) => ({ n: a.n + s.n, err: a.err + s.err, bytes: a.bytes + s.bytes }), { n: 0, err: 0, bytes: 0 });
  console.log(JSON.stringify({ tag: TAG, t: Math.round((Date.now() - t0) / 1000), listeners: active, rps: Math.round(all.n / 10), errors: all.err, mbit: Math.round((all.bytes * 8) / 10 / 1e5) / 10, by: summary(window_) }));
  window_.clear();
}, 10_000);

// ---------------------------------------------------------------- one listener
async function listener(k) {
  const ip = `10.${(k >> 16) & 255}.${(k >> 8) & 255}.${k & 255}`;
  const agent = new Agent({ connections: 4, keepAliveTimeout: 60_000, pipelining: 1 });
  const cache = new Set();                            // immutable URLs this listener already has
  let etag = '', head = null;
  const floors = new Map();                           // sid -> floor snapshot (as of its rev)
  async function get(path, kind, { json = false, immutable = false, headers = {} } = {}) {
    if (immutable && cache.has(path)) return json ? null : true;
    const t = performance.now();
    try {
      const r = await request(BASE + path, { dispatcher: agent, headers: { 'x-real-ip': ip, 'accept-encoding': 'gzip, br', ...headers } });
      const body = await r.body.arrayBuffer();
      note(kind, performance.now() - t, body.byteLength, r.statusCode < 400);
      if (r.statusCode >= 400) return null;
      if (immutable) cache.add(path);
      if (r.statusCode === 304) return 304;
      if (!json) return true;
      const enc = r.headers['content-encoding'];
      const buf = Buffer.from(body);
      const { gunzipSync, brotliDecompressSync } = await import('node:zlib');
      const text = (enc === 'br' ? brotliDecompressSync(buf) : enc === 'gzip' ? gunzipSync(buf) : buf).toString('utf8');
      if (path.endsWith('head.json')) etag = r.headers.etag ?? etag;
      return JSON.parse(text);
    } catch {
      note(kind, performance.now() - t, 0, false);
      return null;
    }
  }
  async function post(path, body) {
    const t = performance.now();
    try {
      const r = await request(BASE + path, { method: 'POST', dispatcher: agent, headers: { 'x-real-ip': ip, 'content-type': 'text/plain' }, body: JSON.stringify(body) });
      await r.body.arrayBuffer();
      note(r.statusCode === 429 ? 'want-429' : 'want', performance.now() - t, 0, r.statusCode < 400 || r.statusCode === 429);   // (a 429 is towerd's limiter working: counted apart)
    } catch { note('want', performance.now() - t, 0, false); }
  }
  // the page, once (index.html names its assets)
  const page = await (async () => {
    const t = performance.now();
    try {
      const r = await request(BASE + '/', { dispatcher: agent, headers: { 'x-real-ip': ip, 'accept-encoding': 'gzip, br' } });
      const b = Buffer.from(await r.body.arrayBuffer());
      note('page', performance.now() - t, b.length, r.statusCode < 400);
      const enc = r.headers['content-encoding'], { gunzipSync, brotliDecompressSync } = await import('node:zlib');
      return (enc === 'br' ? brotliDecompressSync(b) : enc === 'gzip' ? gunzipSync(b) : b).toString('utf8');
    } catch { note('page', performance.now() - t, 0, false); return ''; }
  })();
  for (const m of page.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) await get(m[1], 'asset', { immutable: true });
  active++;
  // poll head.json every 2 s (the client at a table); deltas and floors as they change
  let stop = false;
  const poller = (async () => {
    while (!stop && Date.now() < end) {
      const h = await get('/live/head.json', 'head', { json: true, headers: etag ? { 'if-none-match': etag } : {} });
      if (h && h !== 304) {
        if (head && h.epoch > head.epoch && h.epoch - head.epoch <= 20) {
          for (let e = head.epoch + 1; e <= h.epoch; e++) await get(`/live/e/${e}.json`, 'delta', { json: true, immutable: true });
        }
        head = h;
        for (const [sid, f] of floors) if (h.floors[sid] && h.floors[sid] !== f.rev && rnd() < 0.3) await loadFloor(sid);   // most changes are patches
      }
      await sleep(2000);
    }
  })();
  async function loadFloor(sid) {
    const rev = head?.floors[sid];
    if (!rev) return null;
    const f = await get(`/live/f/${sid}/${rev}.json`, 'floor', { json: true, immutable: true });
    if (f) floors.set(sid, f);
    return f ?? floors.get(sid);
  }
  while (!head && Date.now() < end) await sleep(200);
  let sid = null, table = null, ti = 0;
  while (Date.now() < end) {
    let entered = false;
    if (!sid || rnd() < 0.4) { sid = head.tower[pick(head.tower.length, 1.4)]; table = null; entered = true; }
    const f = floors.get(sid) ?? await loadFloor(sid);
    if (!f) { sid = null; await sleep(1000); continue; }
    const convo = f.tables.map((t, i) => [t, i]).filter(([t]) => t.turns.length >= 2);
    if (entered) {                                   // walking onto a floor: the first words of its best six tables (prewarm)
      for (const [t] of convo.slice(0, 6)) {
        const v = t.turns[0].v;
        if (!v) continue;
        const side = await get('/live/' + v[0], 'sidecar', { json: true, immutable: true });
        if (side?.clips) for (const c of side.clips.slice(0, 2)) await get('/live/' + c.u, 'clip', { immutable: true });
      }
    }
    if (!convo.length) { sid = null; await sleep(500); continue; }
    [table, ti] = convo[pick(convo.length, 1.8)];
    await post('/want', { story: sid, table: ti, from: 0 });
    let asked = Date.now(), murmurAt = Date.now() + 4000;
    const stay = Date.now() + (90 + rnd() * 240) * 1000;
    // the room: the three nearest other tables play on (the client's mixer), each turn's sidecar and clips fetched as
    // it starts, in real time, while this listener stays
    const room = convo.filter(([t]) => t !== table).sort(() => rnd() - 0.5).slice(0, 3).map(([t]) => (async () => {
      for (let j = 0; j < t.turns.length && Date.now() < Math.min(stay, end); j++) {
        const u = t.turns[j];
        if (u.v) { const side = await get('/live/' + u.v[0], 'sidecar', { json: true, immutable: true }); if (side?.clips) for (const c of side.clips) await get('/live/' + c.u, 'clip', { immutable: true }); }
        await sleep(Math.min(Math.min(stay, end) - Date.now(), ((u.v ? Number(u.v[1]) || 5 : 4) * 1000) + (u.gapMs ?? 300)));
      }
    })());
    for (let k = 0; k < table.turns.length && Date.now() < Math.min(stay, end); k++) {
      // prefetch: this turn and the next three, as the director does
      for (const u of table.turns.slice(k, k + 4)) if (u.v) {
        const side = await get('/live/' + u.v[0], 'sidecar', { json: true, immutable: true });
        if (side?.clips) for (const c of side.clips) await get('/live/' + c.u, 'clip', { immutable: true });
      }
      const u = table.turns[k];
      const dur = u.v ? Number(u.v[1]) || 5 : 4;      // an unvoiced turn: waited on 4 s, then skipped
      const until = Date.now() + dur * 1000 + (u.gapMs ?? 300);
      while (Date.now() < until && Date.now() < end) {
        if (Date.now() - asked > 30_000) { asked = Date.now(); await post('/want', { story: sid, table: ti, from: k }); }
        if (Date.now() > murmurAt) {                   // another table's voice across the room
          murmurAt = Date.now() + 4000 + rnd() * 5000;
          const [o] = convo[Math.floor(rnd() * convo.length)];
          const v = o.turns[Math.floor(rnd() * Math.min(4, o.turns.length))].v;
          if (v) { const side = await get('/live/' + v[0], 'sidecar', { json: true, immutable: true }); const c = side?.clips?.[0]; if (c) await get('/live/' + c.u, 'clip', { immutable: true }); }
        }
        await sleep(Math.min(1000, until - Date.now()));
      }
    }
    await Promise.all(room);
  }
  stop = true;
  await poller;
  active--;
  await agent.close();
}

const runs = [];
for (let k = 0; k < Number(N) && Date.now() < end; k++) {
  runs.push(listener(k + 1));
  await sleep(1000 / RAMP);
}
await Promise.all(runs);
clearInterval(tick);
console.log(JSON.stringify({ tag: TAG, done: true, seconds: Math.round((Date.now() - t0) / 1000), listeners: Number(N), total: summary(stats) }));
