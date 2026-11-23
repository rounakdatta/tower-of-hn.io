// Local orchestrator: the production data plane, writing to a folder instead of R2.
// usage: node src/local.ts <out dir> [minutes to run]
//   <out>/live/head.json            1 s TTL in production: epoch, tower order, floor revs
//   <out>/live/e/<epoch>.json       immutable deltas
//   <out>/live/f/<story>/<rev>.json immutable floor snapshots
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { Live, type Item } from '../../../packages/core/src/live.ts';

const HN = 'https://hacker-news.firebaseio.com/v0';
const UA = { 'User-Agent': 'towerofhan-orchestrator/0.1 (local dev)' };
const out = process.argv[2] ?? 'out', minutes = Number(process.argv[3] ?? 10);
const FLOORS = 30;

async function get<T>(path: string): Promise<T> {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(`${HN}/${path}.json`, { headers: UA });
      return (await r.json()) as T;
    } catch (e) { if (a > 4) throw e; await new Promise((r) => setTimeout(r, 500 * 2 ** a)); }
  }
}
async function many(ids: number[], conc = 24): Promise<Item[]> {
  const res: Item[] = [];
  for (let i = 0; i < ids.length; i += conc) res.push(...(await Promise.all(ids.slice(i, i + conc).map((id) => get<Item>(`item/${id}`)))).filter(Boolean));
  return res;
}
function write(rel: string, data: unknown) {           // atomic: readers never see half a file
  const p = `${out}/live/${rel}`;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + '.tmp', JSON.stringify(data));
  renameSync(p + '.tmp', p);
}

const live = new Live();
const t0 = Date.now();

// Bootstrap: each front-page story's whole tree, breadth-first, in HN's ranked kid order.
const top = (await get<number[]>('topstories')).slice(0, FLOORS);
let frontier = top.slice(), fetched = 0;
while (frontier.length) {
  const items = await many(frontier);
  fetched += items.length;
  for (const it of items) live.upsert(it);
  frontier = items.flatMap((it) => (it.dead || it.deleted ? [] : it.kids ?? []));
}
live.setTower(top);
let maxitem = await get<number>('maxitem');
const first = live.tick(Date.now());
for (const s of first.snapshots) write(`f/${s.story.id}/${s.rev}.json`, s);
if (first.delta) write(`e/${first.delta.epoch}.json`, first.delta);
write('head.json', first.head);
console.log(JSON.stringify({ bootstrap: { stories: top.length, items: fetched, seconds: (Date.now() - t0) / 1000, snapshots: first.snapshots.length } }));

// Follow the firehose: new items by maxitem, changes via /updates, rank via topstories.
const stats = { ticks: 0, deltas: 0, newItems: 0, updated: 0, turns: 0, rankChanges: 0 };
const end = Date.now() + minutes * 60_000;
let lastTop = 0, lastUpdates = '';
while (Date.now() < end) {
  const loopStart = Date.now();
  const mx = await get<number>('maxitem');
  if (mx > maxitem) {
    const fresh = await many(Array.from({ length: mx - maxitem }, (_, i) => maxitem + 1 + i));
    for (const it of fresh) live.upsert(it);
    stats.newItems += fresh.length;
    // a new reply changes its parent's ranked kid list: refetch the parents we know
    const parents = [...new Set(fresh.map((it) => it.parent).filter((p): p is number => !!p && live.items.has(p)))];
    for (const it of await many(parents)) live.upsert(it);
    maxitem = mx;
  }
  // HN republishes /updates in ~34 s batches; only act when the batch actually changed
  const upd = await get<{ items: number[] }>('updates');
  const key = (upd.items ?? []).join();
  if (key !== lastUpdates) {
    lastUpdates = key;
    const known = (upd.items ?? []).filter((id) => live.items.has(id));
    for (const it of await many(known)) live.upsert(it);
    stats.updated += known.length;
  }
  if (Date.now() - lastTop > 30_000) {
    const order = (await get<number[]>('topstories')).slice(0, FLOORS);
    const newcomers = order.filter((id) => !live.items.has(id));
    let fr = newcomers;
    while (fr.length) { const its = await many(fr); its.forEach((it) => live.upsert(it)); fr = its.flatMap((it) => it.kids ?? []); }
    if (order.join() !== live.tower.join()) stats.rankChanges++;
    live.setTower(order);
    lastTop = Date.now();
  }
  const r = live.tick(Date.now());
  stats.ticks++;
  for (const s of r.snapshots) write(`f/${s.story.id}/${s.rev}.json`, s);
  if (r.delta) { write(`e/${r.delta.epoch}.json`, r.delta); stats.deltas++; stats.turns += r.delta.turns?.length ?? 0; }
  write('head.json', r.head);
  await new Promise((res) => setTimeout(res, Math.max(0, 2000 - (Date.now() - loopStart))));
}
console.log(JSON.stringify({ follow: { minutes, ...stats } }));
