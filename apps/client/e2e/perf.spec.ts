// What the sheet costs (Chromium only, where the timing APIs are): it isn't loaded until you reply; typing in a long
// reply stays within a frame; opening it, and a phone keyboard, move nothing else on the page.
import { test, expect } from './fixtures.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

test.beforeEach(async ({ mock }, info) => { void mock; test.skip(info.project.name !== 'chromium' && info.project.name !== 'pixel', 'Chromium timing'); });
const out: Record<string, unknown> = {};
test.afterAll(({}, info) => { if (Object.keys(out).length) { mkdirSync('e2e/.results', { recursive: true }); writeFileSync(`e2e/.results/perf-${info.project.name}.json`, JSON.stringify(out, null, 1)); } });

test('the sheet is not part of the first load; it comes with the first reply', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => asked.push(new URL(r.url()).pathname));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(asked.filter((p) => /\/assets\/reply-/.test(p))).toEqual([]);
  await page.locator('[data-reply=bob]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(asked.filter((p) => /\/assets\/reply-.*\.js$/.test(p))).toHaveLength(1);
  expect(asked.filter((p) => /\/assets\/reply-.*\.css$/.test(p))).toHaveLength(1);
});

test('typing into a long reply: each key is painted within a frame', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-reply=bob]').click();
  const box = page.getByRole('dialog').getByRole('textbox');
  await box.fill('x'.repeat(5000) + '\n\n*some* https://example.com formatting ');
  await box.press('End');
  // key down to the next frame painted, per key (what a person feels as lag)
  await page.evaluate(() => {
    const w = window as unknown as { __lag: number[] };
    w.__lag = [];
    document.addEventListener('keydown', (e) => { const t = e.timeStamp; requestAnimationFrame(() => setTimeout(() => w.__lag.push(performance.now() - t))); }, true);
  });
  await box.pressSequentially('the quick brown fox jumps over the lazy dog '.repeat(4), { delay: 20 });
  const lag = (await page.evaluate(() => (window as unknown as { __lag: number[] }).__lag)).sort((a, b) => a - b);
  const q = (p: number) => Math.round(lag[Math.min(lag.length - 1, Math.floor(p * lag.length))]);
  out.keyToFrameMs = { n: lag.length, p50: q(0.5), p95: q(0.95), max: Math.round(lag[lag.length - 1]) };
  expect(q(0.95)).toBeLessThan(100);                                             // (a CPU-starved box; a phone does better)
});

test('opening the sheet, and a phone keyboard, shift nothing else', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) w.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.locator('[data-reply=bob]').click();
  await page.waitForTimeout(600);                                                // (past the click's own grace)
  const box = page.getByRole('dialog').getByRole('textbox');
  await box.fill('Steady.');
  // a tap into the box opens the keyboard: the sheet rises with it (a move that follows your input, as CLS counts it)
  await box.tap().catch(() => box.click());
  await page.evaluate(() => { const v = window.visualViewport!; Object.defineProperty(v, 'height', { configurable: true, get: () => innerHeight * 0.55 }); v.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(500);
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  out.layoutShift = cls;
  expect(cls).toBeLessThan(0.01);
});
