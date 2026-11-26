#!/usr/bin/env node
// Tower of HN listening probe (launch readiness, phase 1b): one headless browser, one listener at a time, sits at real
// tables of the live tower and records when each voice is heard, with every fetch, decode and audio start timestamped
// (probe-init.js). The client runs in its frame-stepped mode (?record&realaudio&manual): the real code, a real audio
// clock and real network, but frames are stepped without drawing, so a GPU-less machine measures the network, the
// server and the decoding, not software rendering.
//
// usage: node listen.mjs BASE PLAN.json OUT.jsonl [--mobile] [--listen 45] [--warm 25]
//   PLAN.json: [{ "story": sid, "table": rootId, "from": 0, "label": "...", "arm": "A", "q": "play=" }, ...]
//   (see plan.mjs; q is added to the page's query: an A/B arm, e.g. play=stream,cue,quick)
//   BASE: https://towerofhn.taptappers.club (the tailnet door) or http://towerofhan.apps.svc.cluster.local:8787
// env: CHROME (executable), PW (playwright-core module path), RESOLVE (host=ip[,host=ip]: Chrome's resolver rules)
import { readFileSync, appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';

const [, , BASE, PLAN, OUT, ...rest] = process.argv;
const opt = (name, def) => { const i = rest.indexOf(name); return i < 0 ? def : rest[i + 1]; };
const MOBILE = rest.includes('--mobile');
const LISTEN = Number(opt('--listen', 45)), WARM = Number(opt('--warm', 25));
const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PW ?? 'playwright-core');
const init = readFileSync(new URL('./probe-init.js', import.meta.url), 'utf8');
const plan = JSON.parse(readFileSync(PLAN, 'utf8'));

const args = ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-gpu', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
if (process.env.RESOLVE) args.push(`--host-resolver-rules=${process.env.RESOLVE.split(',').map((x) => `MAP ${x.split('=')[0]} ${x.split('=')[1]}`).join(', ')}`);
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args });
const ctxOpts = MOBILE ? { ...devices['Pixel 7'] } : { viewport: { width: 1280, height: 800 } };

async function headOf() {
  const r = await fetch(`${BASE}/live/head.json`, { cache: 'no-store' });
  return r.json();
}

let n = 0;
for (const c of plan) {
  n++;
  const head = await headOf().catch(() => null);
  const rank = head ? head.tower.indexOf(c.story) : -1;
  if (rank < 0) { appendFileSync(OUT, JSON.stringify({ ...c, skipped: 'not on the tower now' }) + '\n'); continue; }
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript(init);
  const page = await ctx.newPage();
  let cdp = null;
  if (MOBILE) { cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const rec = { ...c, mobile: MOBILE, rank, at: Date.now() };
  try {
    const q = `?record&realaudio&manual&story=${c.story}&table=${c.table}${c.from ? `&from=${c.from}` : ''}${c.q ? `&${c.q}` : ''}`;
    rec.tLoad = Date.now();
    await page.goto(`${BASE}/${q}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => window.__ready && window.__tohn, null, { timeout: 60_000 });
    rec.tReady = await page.evaluate(() => window.__probeT());
    // frames at 30 Hz without drawing: the app's logic, timers and director run in real time
    await page.evaluate(() => { window.__tohn.ensureAudio(); window.__step = setInterval(() => { try { window.__tohn.frame(1 / 30, false); } catch (e) { window.__stepErr = String(e); } }, 1000 / 30); });
    // enter the floor (retry until the head has arrived), then wait for its room
    const t = Date.now();
    while (Date.now() - t < 30_000) {
      const m = await page.evaluate((r) => { try { if (window.__tohn.mode() === 'tower') window.__tohn.enter(r); } catch { /* no head yet */ } return window.__tohn.mode(); }, rank);
      if (m === 'floor') break;
      await sleep(250);
    }
    await page.waitForFunction(() => window.__tohn.mode() === 'floor' && window.__tohn.tables().length > 0, null, { timeout: 30_000 });
    rec.tFloor = await page.evaluate(() => window.__probeT());
    await sleep(Number(c.linger ?? 2) * 1000);      // a moment on the floor, as a person looks around before sitting
    rec.tSit = await page.evaluate(() => { const t = window.__probeT(); window.__tohn.sit(); return t; });
    await sleep(LISTEN * 1000);
    if (WARM > 0) {
      rec.tNext = await page.evaluate(() => { const t = window.__probeT(); dispatchEvent(new KeyboardEvent('keydown', { key: 'n' })); return t; });
      await sleep(WARM * 1000);
    }
    rec.tEnd = await page.evaluate(() => window.__probeT());
    rec.ctx = await page.evaluate(() => ({ rate: window.__tohn.info().audioRate, mode: window.__tohn.mode(), stepErr: window.__stepErr ?? null }));
    rec.log = await page.evaluate(() => window.__probeLog);
  } catch (e) {
    rec.error = String(e).slice(0, 300);
    try { rec.log = await page.evaluate(() => window.__probeLog); } catch { /* page gone */ }
  }
  rec.errors = errors;
  appendFileSync(OUT, JSON.stringify(rec) + '\n');
  console.log(JSON.stringify({ n, of: plan.length, story: c.story, table: c.table, label: c.label, error: rec.error ?? null, events: rec.log?.length ?? 0 }));
  await ctx.close();
}
await browser.close();
