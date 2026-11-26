// The room at every size (CROWD_V2): everyone on the floor is in it, nobody stands in anybody, nobody gets stuck, the
// lens is never inside a head and nobody stands between it and the face it's on, whoever speaks steps forward to the
// table and back, the front of a table never turns into a crowd again, the audience hears what's said, and a small
// room is the room it always was. Chromium in SwiftShader, the scene's clock stepped by hand (?record&manual): the
// conversation runs in simulated time, minutes of it in seconds, and only what a test looks at is drawn.
import { test, expect, type Page } from '@playwright/test';
// @ts-expect-error (a plain module, shared with the server)
import { ensure } from './room/fixtures.mjs';

type Fx = { name: string; sid: number; root: number; people: number };
const FX: Record<string, Fx> = ensure();
const V2 = 'crowd,stream,cue,quick', TODAY = 'stream,cue,quick';
type W = { __ready: boolean; __tohn: Record<string, (...a: unknown[]) => unknown> };

async function open(page: Page, fx: string, play = V2) {
  await page.goto(`/?record&manual&webgl&data=/fx/${fx}/live/&play=${play}&table=${FX[fx].root}`);
  await page.waitForFunction(() => (window as unknown as W).__ready === true);
  await page.evaluate(() => (window as unknown as W).__tohn.enter(0));
  await page.waitForFunction(() => (window as unknown as W).__tohn.mode() === 'floor');
  await step(page, 150);
}
/** n frames of 1/30 s, not drawn (the conversation goes on; nothing is rendered) */
const step = (page: Page, n: number) => page.evaluate((n) => { const t = performance.now(); for (let k = 0; k < n; k++) (window as unknown as W).__tohn.frame(1 / 30, false); return performance.now() - t; }, n);
const call = <T>(page: Page, fn: string, ...a: unknown[]) => page.evaluate(([fn, a]) => (window as unknown as W).__tohn[fn as string](...(a as unknown[])), [fn, a] as const) as Promise<T>;
interface Hall { on: boolean; tiers: number; people: number; audience: number; present: number; crowd: number; slots: number; drawn: number[]; triangles: { audience: number; crowd: number } }
interface Head { name: string; x: number; y: number; z: number; table: boolean }
interface Plan { tables: [number, number, number][]; crowd: [number, number, number, number, number, number][]; cam: [number, number, number] }

test('everyone on the floor is in the room, from 5 people to 3,000: at a table, or in a place of their own', async ({ page }) => {
  const tiers: number[] = [];
  for (const fx of ['n5', 'n50', 'n200', 'n800', 'n3000', 'onepassword']) {
    await open(page, fx);
    const h = await call<Hall>(page, 'hall');
    expect(h.on).toBe(true);
    expect(h.people, `${fx}: the room counts everyone who commented`).toBe(FX[fx].people);
    // at a table (drawn by the crowd) or present in the audience: each person exactly once
    expect(h.present + h.crowd, `${fx}: present ${h.present} + at tables ${h.crowd}`).toBe(h.people);
    // and those in the audience stand at a real place (standing room or a gallery, never the middle of the room), and are drawn
    const p = await call<Plan & { audience: [number, number, number, number][] }>(page, 'plan');
    for (const [x, z, , here] of p.audience) if (here) expect(Math.hypot(x, z), `${fx}: someone in the audience stands ${Math.hypot(x, z).toFixed(2)} m from the middle`).toBeGreaterThan(4);
    if (h.present > 20) { expect(h.drawn.reduce((a, b) => a + b, 0), `${fx}: audience drawn`).toBeGreaterThan(0); expect(h.triangles.audience).toBeGreaterThan(0); }
    tiers.push(h.tiers);
  }
  // galleries only when a floor needs them, and more of them for more people
  expect(tiers[0]).toBe(0); expect(tiers[1]).toBe(0);
  expect(tiers[2]).toBeGreaterThan(0);
  expect(tiers[3]).toBeGreaterThan(tiers[2]); expect(tiers[4]).toBeGreaterThan(tiers[3]);
  expect(tiers[4]).toBeLessThanOrEqual(20);
});

/** Sit at the biggest table and let the conversation run, checking the room every `every` frames. (Minutes of a
 *  conversation: on the desktop project only; a phone runs the same code, and its own checks are the quick ones.) */
async function listen(page: Page, fx: string, seconds: number, every: number, check: (k: number) => Promise<void>) {
  test.skip(test.info().project.name === 'room-pixel', 'the long simulations run once, on the desktop project');
  await open(page, fx);
  await call(page, 'sit');
  for (let k = 0; k < Math.round((seconds * 30) / every); k++) { await step(page, every); await check(k); }
}

for (const fx of ['onepassword', 'n800']) {
  test(`${fx}: while the conversation goes on, nobody stands in anybody and nobody is stuck`, async ({ page }) => {
    let samples = 0, changes = 0;
    const last = new Map<string, { x: number; z: number; walking: boolean }>();
    await listen(page, fx, 150, 150, async () => {
      const p = await call<Plan>(page, 'plan');
      const live = p.crowd.filter((c) => !c[4]);
      for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) {
        const d = Math.hypot(live[a][0] - live[b][0], live[a][1] - live[b][1]);
        // (two walkers can graze for a frame while they pass; nobody stands inside anyone)
        expect(d, `two people ${d.toFixed(2)} m apart`).toBeGreaterThan(live[a][5] + live[b][5] - 0.06);
      }
      // nor in the audience standing along the glass (the hall's own places never overlap: hall.test.ts)
      const ground = (p as Plan & { audience: [number, number, number, number][] }).audience.filter((q) => q[2] === 0 && q[3]);
      for (const c of live) for (const q of ground) {
        const d = Math.hypot(c[0] - q[0], c[1] - q[1]);
        expect(d, `someone at ${c[0]},${c[1]} inside the standing room`).toBeGreaterThan(c[5] + 0.24 - 0.06);
      }
      // someone still walking who hasn't got 10 cm further in 5 s (of the conversation) is stuck
      const now = await call<{ name: string; x: number; z: number; walking: boolean }[]>(page, 'people'), here = new Set(now.map((q) => q.name));
      for (const q of now) {
        const prev = last.get(q.name);
        if (prev?.walking && q.walking) expect(Math.hypot(prev.x - q.x, prev.z - q.z), `${q.name} is stuck`).toBeGreaterThan(0.1);
        // the room changing: someone who walked, or stepped up from the audience since the last look
        if (samples && (!prev || Math.hypot(prev.x - q.x, prev.z - q.z) > 0.3)) changes++;
      }
      for (const name of last.keys()) if (!here.has(name)) { changes++; last.delete(name); }   // (went back to their place)
      for (const q of now) last.set(q.name, { x: q.x, z: q.z, walking: q.walking });
      samples++;
    });
    expect(samples).toBeGreaterThan(25);
    // people did come and go (a room where nobody moves passes the overlap check trivially); a step up or back unseen
    // is instant, so arrivals and departures count, not only walks caught between two looks
    test.info().annotations.push({ type: 'changes', description: String(changes) });
    expect(changes, 'people stepped forward and back').toBeGreaterThan(5);
  });
}

test('the lens is never inside a head, and nobody stands between it and the face it is on', async ({ page }) => {
  let shots = 0;
  const blocked: string[] = [];
  await listen(page, 'onepassword', 200, 45, async () => {
    const sp = await call<{ name: string } | null>(page, 'speaking');
    const sc = await call<{ cam: [number, number, number] }>(page, 'scene');
    const heads = await call<Head[]>(page, 'heads'), [cx, cy, cz] = sc.cam;
    for (const h of heads) expect(Math.hypot(h.x - cx, h.y - cy, h.z - cz), `the lens is inside ${h.name}'s head`).toBeGreaterThan(0.42);
    const shot = await call<string>(page, 'shot');
    const on = /^(single|medium) (\S+)/.exec(shot)?.[2];
    if (!sp || !on || on !== sp.name) return;
    const s = heads.find((h) => h.name === on && h.table);
    if (!s) return;
    shots++;
    // anyone else's head within 18 cm of the line from the lens to the speaker's face (short of the face itself)
    const dx = s.x - cx, dy = s.y - cy, dz = s.z - cz, L = Math.hypot(dx, dy, dz);
    for (const h of heads) {
      if (h.name === on) continue;
      const t = ((h.x - cx) * dx + (h.y - cy) * dy + (h.z - cz) * dz) / (L * L);
      if (t <= 0.05 || t >= 0.9) continue;
      const d = Math.hypot(cx + dx * t - h.x, cy + dy * t - h.y, cz + dz * t - h.z);
      if (d < 0.18) blocked.push(`${h.name} in front of ${on} (${d.toFixed(2)} m off the line)`);
    }
  });
  expect(shots, 'shots on whoever was speaking').toBeGreaterThan(10);
  expect(blocked).toEqual([]);
});

test('whoever speaks has stepped up to the table, and its front never turns into a crowd again', async ({ page }) => {
  let heard = 0;
  await listen(page, 'onepassword', 200, 60, async () => {
    const p = await call<Plan>(page, 'plan'), sp = await call<{ name: string; i: number } | null>(page, 'speaking');
    // the table we sit at (the director's), not whichever is nearest the lens
    const tb = (await call<{ table: { pos: number[]; r: number } }>(page, 'scene')).table;
    const tx = tb.pos[0], tz = tb.pos[2], tr = tb.r;
    const standing = p.crowd.filter((c) => !c[4] && !c[2] && !c[3] && Math.hypot(c[0] - tx, c[1] - tz) < tr + 1.7).length;
    expect(standing, 'people standing at the front of the table').toBeLessThanOrEqual(8);
    // whoever stepped back is in their own place again (a place in the standing room or a gallery: never the middle)
    for (const [x, z, , here] of (p as Plan & { audience: [number, number, number, number][] }).audience) if (here) expect(Math.hypot(x, z)).toBeGreaterThan(4);
    if (!sp) return;
    const c = p.crowd[sp.i];
    expect(c[4], `${sp.name} speaks from the room, not from nowhere`).toBe(0);
    expect(Math.hypot(c[0] - tx, c[1] - tz), `${sp.name} is at the table`).toBeLessThan(tr + 1.75);
    heard++;
  });
  expect(heard).toBeGreaterThan(10);
});

test('the audience hears it: heads turn to each new speaker, and how it was said ripples out from the table', async ({ page }) => {
  const turned = new Set<string>(), reactions = new Set<number>();
  await listen(page, 'onepassword', 300, 30, async () => {
    const st = await call<{ focus: number[]; react: number[] }>(page, 'audienceState'), sp = await call<{ name: string } | null>(page, 'speaking');
    if (sp) {
      const h = (await call<Head[]>(page, 'heads')).find((x) => x.name === sp.name && x.table);
      // the audience looks where the speaker's head is (room space: the floor at 0)
      if (h && Math.hypot(h.x - st.focus[0], h.z - st.focus[2]) < 0.05) turned.add(sp.name);
    }
    if (st.react[3] > 0) reactions.add(st.react[2]);
  });
  expect(turned.size, 'speakers the audience turned to').toBeGreaterThan(4);
  expect(reactions.size, 'reactions that rippled through the room').toBeGreaterThan(1);
});

test('a small room is the room it always was', async ({ page }) => {
  const at = async (play: string) => { await open(page, 'n5', play); return (await call<Plan>(page, 'plan')).crowd.map((c) => c.slice(0, 3)); };
  const before = await at(TODAY), after = await at(V2);
  expect(after).toEqual(before);
  const h = await call<Hall>(page, 'hall');
  expect(h.tiers).toBe(0); expect(h.audience - h.present).toBe(5);
});

test('a frame of a 3,000-person room costs the CPU no more than today\'s room of 220 did', async ({ page }) => {
  test.skip(test.info().project.name === 'room-pixel', 'timed once, on the desktop project');
  // (the median of three runs each: a shared runner's noise is not a regression, and this test stands between a tag and its images)
  const cost = async (play: string) => {
    await open(page, 'n3000', play); await call(page, 'sit'); await step(page, 300);
    const runs = [await step(page, 600), await step(page, 600), await step(page, 600)].sort((a, b) => a - b);
    return runs[1] / 600;
  };
  const today = await cost(TODAY), v2 = await cost(V2);
  test.info().annotations.push({ type: 'cpu', description: `per frame: today ${today.toFixed(2)} ms, v2 ${v2.toFixed(2)} ms` });
  expect(v2).toBeLessThan(today * 1.5 + 0.3);
});

test('an hour at a big table: the heap and the room\'s people stay flat', async ({ page }) => {
  test.skip(test.info().project.name === 'room-pixel', 'the long session runs once, on the desktop project');
  await open(page, 'onepassword');
  await call(page, 'sit');
  const heap: number[] = [], slots: number[] = [];
  for (let m = 0; m < 12; m++) {
    await step(page, 9000);                                               // 5 minutes of conversation
    await page.evaluate(() => (window as unknown as { gc?: () => void }).gc?.());
    heap.push(await page.evaluate(() => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576));
    slots.push((await call<Hall>(page, 'hall')).slots);
  }
  test.info().annotations.push({ type: 'heap', description: heap.map((x) => x.toFixed(1)).join(' ') });
  test.info().annotations.push({ type: 'slots', description: slots.join(' ') });
  // after the first ten minutes (caches filling), no climb: the last sample within 20% of the third
  expect(heap[11]).toBeLessThan(heap[2] * 1.2 + 2);
  // the crowd stays the size of who is here (slots someone left are reused past 72), not of everyone who ever spoke:
  // after five minutes it has what it needs, and an hour adds next to nothing (the table's 179 voices would add ~150)
  expect(Math.max(...slots)).toBeLessThanOrEqual(slots[0] + 25);
});

for (const fx of ['n5', 'n200', 'n3000', 'onepassword']) {
  test(`${fx}: the room on foot and the hall from its table, for the record`, async ({ page }, info) => {
    await open(page, fx);
    const draw = async (name: string) => {
      await page.evaluate(() => { const t = (window as unknown as W).__tohn; t.frame(1 / 30, true); t.frame(1 / 30, true); });
      const png = await page.screenshot({ timeout: 180_000 });
      await info.attach(`${fx}-${name}`, { body: png, contentType: 'image/png' });
      // a picture, not a blank (a flat frame compresses to almost nothing), and on a crowded floor, the crowd in it
      expect(png.length).toBeGreaterThan(20_000);
      const h = await call<Hall>(page, 'hall');
      expect(h.triangles.crowd + h.triangles.audience, 'triangles drawn').toBeGreaterThan(0);
      if (fx !== 'n5') expect(h.drawn.reduce((a, b) => a + b, 0), 'the audience in the picture').toBeGreaterThan(0);
    };
    await draw('floor');
    await call(page, 'sit');
    await step(page, 75);
    await page.waitForTimeout(1500);
    await draw('table');
  });
}
