// Local orchestrator v0: live HN story -> floor manifest + voice jobs.
// Production runs the same logic at the edge; this is the dev harness.
// usage: node src/floor.ts <rank 0-based> <out dir> [maxTables] [maxTurnsPerTable]
import { mkdirSync, writeFileSync } from 'node:fs';
import { speakable, type Segment } from '../../../packages/core/src/speakable.ts';
import { playOrder, seat, voiceFor, type Node } from '../../../packages/core/src/conversation.ts';

const HN = 'https://hacker-news.firebaseio.com/v0';
const UA = { 'User-Agent': 'towerofhn-orchestrator/0.1' };
const VOICE_POOL = 115;

interface Item { id: number; type: string; by?: string; text?: string; title?: string; url?: string; score?: number; descendants?: number; kids?: number[]; dead?: boolean; deleted?: boolean; parent?: number; time: number }

async function item(id: number): Promise<Item> {
  for (let a = 0; ; a++) {
    try { return await (await fetch(`${HN}/item/${id}.json`, { headers: UA })).json(); } catch (e) { if (a > 3) throw e; }
  }
}

/** Fetch a whole thread in HN's ranked kid order, 16 requests in flight. */
async function tree(rootId: number): Promise<Node & { item: Item }> {
  const byId = new Map<number, Item>();
  let frontier = [rootId];
  while (frontier.length) {
    const batch: Item[] = [];
    for (let i = 0; i < frontier.length; i += 16) batch.push(...(await Promise.all(frontier.slice(i, i + 16).map(item))));
    for (const it of batch) if (it) byId.set(it.id, it);
    frontier = batch.flatMap((it) => it?.kids ?? []);
  }
  const build = (id: number): any => { const it = byId.get(id)!; return { id, by: it.by, text: it.text, dead: it.dead, deleted: it.deleted, item: it, kids: (it.kids ?? []).filter((k) => byId.has(k)).map(build) }; };
  return build(rootId);
}

const rank = Number(process.argv[2] ?? 0), out = process.argv[3] ?? 'out';
const maxTables = Number(process.argv[4] ?? 6), maxTurns = Number(process.argv[5] ?? 14);
const top: number[] = await (await fetch(`${HN}/topstories.json`, { headers: UA })).json();
const t0 = Date.now();
const story = await tree(top[rank]);
const st = story.item;
const textOf = new Map<number, string>();
(function index(n: any) { if (n.text) textOf.set(n.id, n.text); n.kids.forEach(index); })(story);

const jobs: any[] = [];
const tables = (story.kids ?? []).slice(0, maxTables).map((root, ti) => {
  const turns = playOrder(root).slice(0, maxTurns);
  const { seated, standing } = seat(turns);
  const taken = new Set<number>(), voices: Record<string, number> = {};
  for (const who of [...seated, ...standing]) { voices[who] = voiceFor(who, taken, VOICE_POOL); taken.add(voices[who]); }
  return {
    root: root.id, seated, standing,
    turns: turns.map((t) => {
      const parent = t.replyTo ? { id: t.replyTo, text: textOf.get(t.replyTo) ?? '' } : undefined;
      const sp = speakable(textOf.get(t.id) ?? '', parent);
      jobs.push({ id: t.id, by: t.by, voice: voices[t.by], table: ti, segments: sp.segments, chars: sp.spokenChars });
      return { ...t, voice: voices[t.by], segments: sp.segments.map((s: Segment) => s.kind), display: sp.display };
    }),
  };
});

const floor = { v: 0, story: { id: st.id, title: st.title, url: st.url, by: st.by, score: st.score, comments: st.descendants }, rank, builtAt: new Date().toISOString(), tables };
mkdirSync(`${out}/floors`, { recursive: true });
writeFileSync(`${out}/floors/${st.id}.json`, JSON.stringify(floor, null, 1));
writeFileSync(`${out}/jobs.jsonl`, jobs.map((j) => JSON.stringify({ ...j, story: st.id })).join('\n') + '\n');
const chars = jobs.reduce((n, j) => n + j.chars, 0);
console.log(JSON.stringify({ story: st.title, comments: st.descendants, tables: tables.length, turns: jobs.length, spokenChars: chars, estMinutes: +(chars / 5.6 / 160).toFixed(1), fetchMs: Date.now() - t0 }));
