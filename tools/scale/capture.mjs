#!/usr/bin/env node
// One snapshot of the front page for mockhn.mjs: the top N stories and every comment under them, read once from
// HN's public API, gently (a few requests at a time: about what one towerd start-up reads). Never a load test.
// usage: node capture.mjs OUT.json [N=30 | id,id,...] [CONCURRENCY=6]
import { writeFileSync } from 'node:fs';
const [, , OUT, N = '30', CONC = '6'] = process.argv;
const HN = 'https://hacker-news.firebaseio.com/v0';
const get = async (p) => {
  for (let a = 0; ; a++) {
    try { return await (await fetch(`${HN}/${p}.json`, { headers: { 'User-Agent': 'towerofhn-staging-capture/1' }, signal: AbortSignal.timeout(15_000) })).json(); }
    catch (e) { if (a > 3) throw e; await new Promise((r) => setTimeout(r, 1000 * 2 ** a)); }
  }
};
const top = /,|^\d{5,}$/.test(N) ? N.split(',').map(Number) : (await get('topstories')).slice(0, Number(N));
const items = [];
let frontier = top.slice();
while (frontier.length) {
  const next = [];
  for (let i = 0; i < frontier.length; i += Number(CONC)) {
    const got = await Promise.all(frontier.slice(i, i + Number(CONC)).map((id) => get(`item/${id}`).catch(() => null)));
    for (const it of got) if (it) { items.push(it); if (!it.dead && !it.deleted) next.push(...(it.kids ?? [])); }
  }
  frontier = next;
}
writeFileSync(OUT, JSON.stringify({ at: Date.now(), top, items }));
console.log(JSON.stringify({ top: top.length, items: items.length, comments: items.filter((x) => x.type === 'comment').length }));
