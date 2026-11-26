#!/usr/bin/env node
// Seed a staging towerd's /data as if every comment on the mock's tower were voiced (VOICE_AHEAD=all, caught up):
// sidecars, clips and voiced.jsonl, with the real files' shapes and sizes (Opus at ~27 kbps, a first clip of <= 110
// characters then <= 220, loudness and mouth tracks at 30 fps) but synthetic bytes. Load tests then serve what a
// listener really fetches, with no voicing at all. Comment versions are towerd's own (revOf: sha1 of VOICE_VERSION and
// the text), so towerd takes these files as current.
// usage: node seed.mjs MOCK_URL VAR_DIR [VOICE_VERSION=v3]
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , MOCK, VAR, VV = 'v3'] = process.argv;
// a fresh, empty staging volume only: these names are towerd's own, so on a real /data they would replace real clips
import { existsSync, readdirSync } from 'node:fs';
if (existsSync(join(VAR, 'voiced.jsonl')) || (existsSync(join(VAR, 'live/c')) && readdirSync(join(VAR, 'live/c')).length)) {
  console.error('seed.mjs: VAR already holds voicing; seed only an empty staging volume'); process.exit(2);
}
const snap = await (await fetch(`${MOCK.replace(/\/$/, '')}/snapshot`)).json();
const live = join(VAR, 'live'), cdir = join(live, 'c');
mkdirSync(cdir, { recursive: true });
const KBPS = 27, CPS = 15;                             // bytes of Opus a second; characters said a second
const ogg = (sec) => { const b = randomBytes(Math.max(200, Math.round((sec * KBPS * 1000) / 8))); b.write('OggS', 0, 'latin1'); return b; };
const track = (sec) => Array.from({ length: Math.max(1, Math.round(sec * 30)) }, () => Math.floor(Math.random() * 256));
let n = 0, clips = 0, bytes = 0;
for (const it of snap.items) {
  if (it.type !== 'comment' || !it.text || !it.by || it.dead || it.deleted) continue;
  const rev = createHash('sha1').update(`${VV}:${it.text}`).digest('hex').slice(0, 8);
  const plain = it.text.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = [];
  for (let i = 0, lim = 110; i < plain.length; i += lim, lim = 220) parts.push(plain.slice(i, i + lim));
  if (!parts.length) parts.push('…');
  const side = { id: it.id, rev, by: it.by, emotion: 'mundane', stance: 'inform', intensity: 0.3, cues: [], dur: 0, clips: [], links: [], code: [] };
  parts.forEach((t, k) => {
    const d = Math.max(0.6, t.length / CPS);
    const u = `c/${it.id}.${rev}.${k}.ogg`, body = ogg(d);
    writeFileSync(join(live, u), body);
    side.clips.push({ u, d: Math.round(d * 1000) / 1000, t, who: it.by, env: track(d), shape: track(d) });
    side.dur += d; clips++; bytes += body.length;
  });
  side.dur = Math.round(side.dur * 1000) / 1000;
  const path = `c/${it.id}.${rev}.json`, sj = JSON.stringify(side);
  writeFileSync(join(live, path), sj); bytes += sj.length;
  appendFileSync(join(VAR, 'voiced.jsonl'), JSON.stringify({ id: it.id, by: it.by, path, dur: side.dur, of: side.clips.length, voices: [it.by], e: 'mundane', i: 0.3 }) + '\n');
  n++;
}
console.log(JSON.stringify({ seeded: n, clips, mb: Math.round(bytes / 1e5) / 10 }));
