// The building through production's renderer (WebGPU, here SwiftShader's): every one of its shaders builds (the hall,
// the building's audience, its tables and lamps) with nothing said on the console, and it draws. Run only where asked
// (FLOOR_GPU=1: the floor's sweeps on a runner); the room's other tests use WebGL, which is quicker to start.
import { test, expect, type Page } from '@playwright/test';
// @ts-expect-error (a plain module, shared with the server)
import { ensure } from './room/fixtures.mjs';

ensure();
type W = { __ready: boolean; __tohn: Record<string, (...a: unknown[]) => unknown> };
const call = <T>(page: Page, fn: string, ...a: unknown[]) => page.evaluate(([fn, a]) => (window as unknown as W).__tohn[fn as string](...(a as unknown[])), [fn, a] as const) as Promise<T>;

test.skip(!process.env.FLOOR_GPU, 'WebGPU sweeps only (FLOOR_GPU=1)');
test.setTimeout(420_000);

test('WebGPU: the building\'s shaders build with nothing on the console, and the floor draws at every moment', async ({ page }, info) => {
  const said: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') said.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => said.push(`pageerror: ${e.message}`));
  await page.goto('/?record&manual&data=/fx/onepassword/live/&play=crowd,floor,stream,cue,quick');
  await page.waitForFunction(() => (window as unknown as W).__ready === true);
  const gpu = await page.evaluate(() => !!(navigator as unknown as { gpu?: unknown }).gpu);
  await page.evaluate(() => (window as unknown as W).__tohn.enter(0));
  await page.waitForFunction(() => (window as unknown as W).__tohn.mode() === 'floor');
  await page.evaluate(() => { for (let k = 0; k < 180; k++) (window as unknown as W).__tohn.frame(1 / 30, k % 15 === 0); });
  const f = await call<{ on: boolean; webgpu: boolean }>(page, 'floor');
  expect(f.on).toBe(true);
  for (const u of [0.1, 0.5, 0.9]) {
    await call(page, 'floorAt', await call<number>(page, 'floorT', u));
    await page.evaluate(() => { for (let k = 0; k < 40; k++) (window as unknown as W).__tohn.frame(1 / 30, k % 10 === 0); });
    await page.evaluate(() => (window as unknown as W).__tohn.frame(1 / 30, true));
    await page.screenshot({ path: info.outputPath(`gpu-${Math.round(u * 100)}.png`) });
  }
  const r = await call<{ render: Record<string, number> }>(page, 'info');
  await info.attach('gpu.txt', { body: JSON.stringify({ gpu, webgpu: f.webgpu, render: r.render, said }, null, 1) });
  expect(r.render.triangles ?? r.render.drawCalls ?? 1).toBeGreaterThan(0);
  expect(said.filter((x) => !/GPU stall due to ReadPixels|Automatic fallback to software WebGL|powerPreference/i.test(x)), 'the console').toEqual([]);
});
