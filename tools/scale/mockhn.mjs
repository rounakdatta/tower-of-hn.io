#!/usr/bin/env node
// A stand-in for Hacker News's Firebase API, for staging and load tests (towerd's HN_API points here; nothing reaches
// the real HN). It serves a snapshot (capture.mjs) and makes it live: the newest comments are held back and released
// over time, at a set rate, as new comments arrive on HN (maxitem advances, the parent's kids grow).
//
// usage: node mockhn.mjs SNAPSHOT.json [PORT=8080]
// env:   HOLD (share of the newest comments held back, 0.15), PER_HOUR (released an hour, 400),
//        LATENCY_MS (added to every answer, 40: HN's API is not instant)
// GET /v0/topstories.json /v0/maxitem.json /v0/updates.json /v0/item/<id>.json /v0/user/<name>.json, /stats, /snapshot
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const [, , SNAP, PORT = '8080'] = process.argv;
const HOLD = Number(process.env.HOLD ?? 0.15), PER_HOUR = Number(process.env.PER_HOUR ?? 400), LATENCY = Number(process.env.LATENCY_MS ?? 40);
const snap = JSON.parse(readFileSync(SNAP, 'utf8'));
const items = new Map(snap.items.map((it) => [it.id, it]));
const comments = snap.items.filter((it) => it.type === 'comment').map((it) => it.id).sort((a, b) => a - b);
const held = comments.slice(Math.floor(comments.length * (1 - HOLD)));
const hidden = new Set(held);
// the kids a client sees: without the held-back replies, which come back (at the end, as new replies) on release
const kids = new Map();
for (const it of items.values()) if (it.kids) kids.set(it.id, it.kids.filter((k) => !hidden.has(k)));
let maxitem = Math.max(...[...items.keys()].filter((id) => !hidden.has(id)));
const recent = [];                                    // parents changed lately (updates.json)
const stats = { requests: 0, items: 0, released: 0, held: held.length, since: Date.now() };

function release() {
  const id = held.shift();
  if (id === undefined) return;
  hidden.delete(id);
  const it = items.get(id);
  if (it.parent !== undefined && kids.has(it.parent)) kids.get(it.parent).push(id);
  else if (it.parent !== undefined) kids.set(it.parent, [id]);
  maxitem = Math.max(maxitem, id);
  recent.unshift(it.parent); recent.length = Math.min(recent.length, 40);
  stats.released++;
}
if (PER_HOUR > 0) setInterval(release, 3_600_000 / PER_HOUR).unref();

const view = (id) => {
  const it = items.get(id);
  if (!it || hidden.has(id)) return null;
  return kids.has(id) ? { ...it, kids: kids.get(id) } : it;
};

createServer((req, res) => {
  stats.requests++;
  const u = new URL(req.url ?? '/', 'http://x');
  const answer = (body, code = 200) => setTimeout(() => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(JSON.stringify(body));
  }, LATENCY);
  if (u.pathname === '/stats') return answer({ ...stats, maxitem, items: items.size - hidden.size });
  if (u.pathname === '/snapshot') return answer({ top: snap.top, items: [...items.keys()].map(view).filter(Boolean) });   // seed.mjs
  let m;
  if (u.pathname === '/v0/topstories.json') return answer(snap.top);
  if (u.pathname === '/v0/maxitem.json') return answer(maxitem);
  if (u.pathname === '/v0/updates.json') return answer({ items: [...new Set(recent)].slice(0, 20), profiles: [] });
  if ((m = /^\/v0\/item\/(\d+)\.json$/.exec(u.pathname))) { stats.items++; return answer(view(Number(m[1]))); }
  if ((m = /^\/v0\/user\/([\w-]+)\.json$/.exec(u.pathname))) return answer({ id: m[1], created: 1_500_000_000, karma: 1, about: '', submitted: [] });
  answer(null, 404);
}).listen(Number(PORT), () => console.log(JSON.stringify({ mockhn: { port: Number(PORT), items: items.size, top: snap.top.length, held: held.length, perHour: PER_HOUR } })));
