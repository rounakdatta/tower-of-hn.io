#!/usr/bin/env node
// A listening plan from the live tower: for each of the top N floors, a table at a few positions in its ranking
// (the best, the middle, the deep end), labelled with what was voiced when the plan was made.
// usage: node plan.mjs BASE N [positions=0,5,14] > plan.json
const [, , BASE, N = '30', POS = '0,5,14'] = process.argv;
const head = await (await fetch(`${BASE}/live/head.json`)).json();
const out = [];
for (const sid of head.tower.slice(0, Number(N))) {
  const f = await (await fetch(`${BASE}/live/f/${sid}/${head.floors[sid]}.json`)).json();
  const convo = f.tables.filter((t) => t.turns.length >= 2);
  for (const pos of POS.split(',').map(Number)) {
    const t = convo[pos];
    if (!t) continue;
    const v = t.turns[0].v;
    out.push({ story: sid, table: t.root, from: 0, pos, turns: t.turns.length,
      label: `r${head.tower.indexOf(sid) + 1}t${pos}:${!v ? 'unvoiced' : /\.p\d+\.json$/.test(v[0]) ? 'opening' : 'voiced'}` });
  }
}
console.log(JSON.stringify(out, null, 1));
