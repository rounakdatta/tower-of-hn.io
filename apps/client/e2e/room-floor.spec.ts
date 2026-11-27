// The floor timeline (FLOOR_TIMELINE, with CROWD_V2): the whole floor in one building, every table and every person of
// it, and one line for the floor's own clock. Dragging the line moves the whole room to that moment: people come and go,
// tables open and light, every count is the clock's; any path through the line lands on the same room as going there
// directly; letting go plays the floor's narration from there, in the order the comments were written. Chromium, the
// scene's clock stepped by hand; the line is driven with the real mouse, keys and touch input.
import { test, expect, type Page } from '@playwright/test';
// @ts-expect-error (a plain module, shared with the server)
import { ensure } from './room/fixtures.mjs';

type Fx = { name: string; sid: number; root: number; people: number };
const FX: Record<string, Fx> = ensure();
const PLAY = 'crowd,floor,stream,cue,quick';
type W = { __ready: boolean; __tohn: Record<string, (...a: unknown[]) => unknown> };
const step = (page: Page, n: number, dt = 1 / 30) => page.evaluate(([n, dt]) => { for (let k = 0; k < n; k++) (window as unknown as W).__tohn.frame(dt, false); }, [n, dt] as const);
const call = <T>(page: Page, fn: string, ...a: unknown[]) => page.evaluate(([fn, a]) => (window as unknown as W).__tohn[fn as string](...(a as unknown[])), [fn, a] as const) as Promise<T>;
interface Floor { on: boolean; R: number; height: number; clip: number; revealed: boolean; t: number; end: number; u: number; tables: number; people: number; here: number; said: number; by: string | null; playing: boolean; mode: string; line: boolean; band: [number, number] | null; valuetext: string }

async function enter(page: Page, fx: string, extra = '') {
  await page.goto(`/?record&manual&webgl&data=/fx/${fx}/live/&play=${PLAY}${extra}`);
  await page.waitForFunction(() => (window as unknown as W).__ready === true);
  await page.evaluate(() => (window as unknown as W).__tohn.enter(0));
  await page.waitForFunction(() => (window as unknown as W).__tohn.mode() === 'floor');
  await step(page, 180);                                   // the flight in, through the glass, and the walls drawing back
}
const floor = (page: Page) => call<Floor>(page, 'floor');
const slider = (page: Page) => page.getByRole('slider', { name: /^Floor timeline/ });
/** where x% of the line is on screen (just above it: on a phone the strip reaches down over the pills) */
async function at(page: Page, f: number) {
  const track = (await page.locator('#timeline .tl-track').boundingBox())!;
  return { x: track.x + track.width * f, y: track.y - 8 };
}
/** A drag along the line as the device makes one: the mouse on a desktop; on a phone, a finger through the browser's own
 *  touch input (CDP), which takes the path a real one does (touch-action, capture, the pointer events it makes). */
async function drag(page: Page, from: number, to: number, steps = 12, frames = 3) {
  const a = await at(page, from), b = await at(page, to), touch = !!test.info().project.use.hasTouch;
  const pts = Array.from({ length: steps }, (_, s) => ({ x: a.x + ((b.x - a.x) * (s + 1)) / steps, y: a.y }));
  if (!touch) {
    await page.mouse.move(a.x, a.y - 30); await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (const p of pts) { await page.mouse.move(p.x, p.y); if (frames) await step(page, frames); }
    return { up: () => page.mouse.up(), to: async (f: number) => { const c = await at(page, f); await page.mouse.move(c.x, c.y); } };
  }
  const cdp = await page.context().newCDPSession(page);
  const touchAt = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  // (a first touch on the bare line only raises it: lift, then take hold)
  await touchAt('touchStart', a.x, a.y); await touchAt('touchEnd', a.x, a.y); await page.waitForTimeout(60);
  await touchAt('touchStart', a.x, a.y);
  for (const p of pts) { await touchAt('touchMove', p.x, p.y); if (frames) await step(page, frames); }
  let last = pts[pts.length - 1];
  return { up: () => touchAt('touchEnd', last.x, last.y), to: async (f: number) => { const c = await at(page, f); last = c; await touchAt('touchMove', c.x, c.y); } };
}
/** the room settled on its moment: fades and lamps done easing */
const settle = (page: Page) => step(page, 75);
/** the room as shown against the room the clock gives for the same moment, from scratch (settled: the lamps too, once
 *  they've finished easing) */
const same = async (page: Page, why: string, settled = true) => {
  const [live, fresh] = await page.evaluate((s) => { const t = (window as unknown as W).__tohn; return [t.floorHash(false, s), t.floorHash(true, s)] as string[]; }, settled);
  expect(live, why).toBe(fresh);
  return live;
};

test('the whole 1Password floor is one building: 58 tables, 356 people, every one placed, the walls drawn back to hold them', async ({ page }) => {
  await enter(page, 'onepassword');
  const f = await floor(page);
  expect(f.on).toBe(true);
  expect(f.tables).toBe(58);
  expect(f.people).toBe(356);
  expect(f.R, 'a hall several times the tower\'s room').toBeGreaterThan(15);
  expect(f.R).toBeLessThan(34);
  expect(f.revealed).toBe(true);
  expect(f.clip, 'the walls have drawn back past the outermost table').toBeGreaterThan(f.R);
  expect(f.line, 'the floor\'s line is along the bottom').toBe(true);
  await expect(slider(page)).toBeAttached();
  // a visit starts with the floor's first comment: one person in the room, one table open
  expect(f.here).toBe(1);
  await same(page, 'the room on arrival');
});

test('dragging the line moves the whole floor: the room fills and empties as people come and go, tables open, and every count is the clock\'s', async ({ page }) => {
  await enter(page, 'onepassword');
  const d = await drag(page, 0.01, 0.01, 1, 2);
  const seen: Floor[] = [];
  for (let s = 1; s <= 24; s++) {
    await d.to(0.01 + (0.98 * s) / 24);
    await page.waitForTimeout(40); await step(page, 3);
    seen.push(await floor(page));
    await same(page, `step ${s}`, false);
  }
  await d.up();
  const here = seen.map((f) => f.here), opened = seen.map((f) => f.said);
  expect(Math.max(...here), `the room at its fullest (${Math.max(...here)}) and near the end (${here[here.length - 1]})`).toBeGreaterThan(here[here.length - 1] + 20);
  expect(Math.max(...here)).toBeGreaterThan(30);
  for (let k = 1; k < opened.length; k++) expect(opened[k], 'forward is forward: the latest comment only moves on').toBeGreaterThanOrEqual(opened[k - 1]);
});

test('any path through the line lands on the same room as going straight there (1,000 random seeks, real drags and keys, a shared link)', async ({ page, browser }) => {
  await enter(page, 'onepassword');
  // 1,000 seeks as a drag makes them (no drawing), every one's room checked against the clock's from scratch
  const bad = await page.evaluate(() => {
    const t = (window as unknown as W).__tohn, end = (t.floor() as { end: number }).end;
    let s = 7, wrong = 0;
    const r = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    let x = 0;
    for (let k = 0; k < 1000; k++) {
      const m = r();
      x = m < 0.5 ? Math.max(0, Math.min(end, x + (r() - 0.5) * end * 0.03)) : m < 0.8 ? r() * end : m < 0.9 ? 0 : end * (0.9 + r() * 0.1);
      t.floorAt(x); t.frame(1 / 60, false);
      if (t.floorHash(false, false) !== t.floorHash(true, false)) wrong++;
    }
    return wrong;
  });
  expect(bad, 'seeks whose room differed from the clock\'s').toBe(0);
  // real input: drags back and forth, the keys, Home and End; settled, the room is the moment's
  const d = await drag(page, 0.2, 0.7, 8, 2);
  await d.to(0.1); await step(page, 2); await d.to(0.85); await step(page, 2); await d.to(0.4); await step(page, 2);
  await d.up(); await settle(page);
  await same(page, 'after a drag back and forth');
  await slider(page).focus();
  for (const k of ['ArrowRight', 'ArrowRight', 'Shift+ArrowRight', 'ArrowLeft', 'End', 'Home', 'Shift+ArrowRight', 'Shift+ArrowRight']) { await page.keyboard.press(k); await step(page, 2); }
  await page.waitForTimeout(450); await settle(page);
  const h = await same(page, 'after the keys');
  // the same moment from a shared link, in another tab: the same room
  const f = await floor(page), other = await browser.newPage({ viewport: page.viewportSize()! });
  await enter(other, 'onepassword', `&t=${Math.floor(f.t)}`);
  await call(other, 'floorAt', f.t); await settle(other);
  expect(await call<string>(other, 'floorHash', false, true), 'a link to the moment opens on the same room').toBe(h);
  await other.close();
});

test('letting go plays the floor from that moment at once, in the order its comments were written, across tables', async ({ page }) => {
  await enter(page, 'onepassword', '&narrate');
  const d = await drag(page, 0.15, 0.55);
  await page.waitForTimeout(300); await step(page, 2);       // (the finger rests: that comment's words are fetched)
  await d.up();
  await page.waitForTimeout(250); await step(page, 8);
  const f = await floor(page), comments = await call<{ i: number; id: number; at: number; table: number; by: string }[]>(page, 'floorComments');
  const sp = await call<{ by: string; id: number; table: number } | null>(page, 'floorSpeaking');
  expect(sp, 'someone is speaking a moment after the release').not.toBeNull();
  expect(sp!.id, 'the comment at the moment you let go').toBe(comments[f.said].id);
  // the next voice is the next comment written on the floor, wherever it was
  let next: { id: number } | null = null, tPrev = f.t, steps = 0;
  while (steps++ < 2400) {
    await step(page, 15);
    const g = await floor(page);
    expect(g.t, 'while it plays, the floor\'s moment only moves on').toBeGreaterThanOrEqual(tPrev - 1e-6);
    tPrev = g.t;
    const s = await call<{ id: number } | null>(page, 'floorSpeaking');
    if (s && s.id !== sp!.id) { next = s; break; }
  }
  expect(next?.id, 'the comment written next').toBe(comments[f.said + 1].id);
});

test('a drag asks the voice server for nothing; letting go asks once at most', async ({ page }) => {
  await enter(page, 'onepassword', '&narrate');
  await page.request.get('/__wants');
  const d = await drag(page, 0.05, 0.95, 30, 2);
  const during = await (await page.request.get('/__wants')).json();
  expect(during, 'nothing asked while dragging').toEqual([]);
  await d.up(); await step(page, 30);
  const after = await (await page.request.get('/__wants')).json();
  expect(after.length).toBeLessThanOrEqual(2);
});

test('the line says what the floor does: arrivals rise, departures hang, tables open as notches; the card and the slider say the moment, the room and the speaker', async ({ page }) => {
  await enter(page, 'onepassword');
  const d = await drag(page, 0.3, 0.42, 6, 2);
  const tl = page.locator('#timeline');
  await expect(tl).toHaveAttribute('data-state', 'drag');
  const peak = Number(await tl.locator('.tl-bars .tl-hist').first().getAttribute('data-peak'));
  expect(peak).toBeGreaterThan(0);
  expect((await tl.locator('.tl-gone path').getAttribute('d'))?.length ?? 0, 'departures drawn under the line').toBeGreaterThan(10);
  const notches = ((await tl.locator('.tl-tick path').getAttribute('d')) ?? '').split('M').length - 1;
  expect(notches, 'a notch per table opening (some share a pixel)').toBeGreaterThan(20);
  expect(notches).toBeLessThanOrEqual(58);
  const card = await tl.locator('.tl-card').innerText();
  expect(card).toMatch(/\d+ (h \d\d min|min|s) in/);
  expect(card).toMatch(/\d+ (person|people) · \d+ tables? talking/);
  await expect(tl.locator('.tl-note'), 'the rule for leaving is said the first time anyone scrubs').toContainText('leave an hour after their last');
  await d.up(); await step(page, 4);
  const v = await slider(page).getAttribute('aria-valuetext');
  expect(v).toMatch(/^\d+ (h \d\d min|min|s) in, (nobody here yet|\d+ (person|people), \d+ tables?, comment by \S+)$/);
});

test('the keys step one comment (Shift: ten), Home and End go to the ends, each time the whole room with them', async ({ page }) => {
  await enter(page, 'onepassword');
  const comments = await call<{ at: number }[]>(page, 'floorComments');
  await slider(page).focus();
  await page.keyboard.press('Home'); await page.waitForTimeout(420); await step(page, 3);
  expect((await floor(page)).said).toBe(0);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(420); await step(page, 3);
  expect((await floor(page)).said).toBe(1);
  await page.keyboard.press('Shift+ArrowRight'); await page.waitForTimeout(420); await step(page, 3);
  expect((await floor(page)).said).toBe(11);
  await page.keyboard.press('End'); await page.waitForTimeout(420); await step(page, 3);
  const f = await floor(page);
  expect(f.said).toBe(comments.length - 1);
  await same(page, 'after End');
});

test('a shared moment opens there: ?t= on a floor', async ({ page }) => {
  await enter(page, 'onepassword', '&t=2h10m');
  const f = await floor(page);
  expect(Math.round(f.t)).toBe(7800);
  expect(f.here).toBeGreaterThan(10);
  expect(new URL(page.url()).searchParams.get('t') ?? '2h10m').toBe('2h10m');
});

test('seated, your table\'s stretch is lit on the floor\'s line, and the room keeps the one clock with your table', async ({ page }) => {
  await enter(page, 'onepassword', '&t=1h');
  await call(page, 'sit'); await step(page, 90);
  const f = await floor(page);
  expect(f.mode).toBe('table');
  expect(f.band, 'the table\'s stretch of the floor').not.toBeNull();
  await expect(page.locator('#timeline .tl-band')).toBeVisible();
  // a release anywhere plays your table's comment there (before it opened: its first)
  const d = await drag(page, 0.05, 0.02, 3, 2);
  await d.up(); await page.waitForTimeout(250); await step(page, 10);
  const g = await floor(page), pos = await call<{ k: number } | null>(page, 'position');
  const turns = await call<{ id: number }[]>(page, 'turns'), comments = await call<{ id: number; at: number }[]>(page, 'floorComments');
  expect(pos).not.toBeNull();
  const said = comments.find((x) => x.id === turns[pos!.k].id)!;
  expect(Math.abs(g.t - said.at), 'the floor is at your table\'s comment').toBeLessThan(120);
  await same(page, 'seated');
});

test('a small floor is still a room; a floor whose comments carry no times is the room as it always was', async ({ page }) => {
  await enter(page, 'n5');
  const f = await floor(page);
  expect(f.on).toBe(true);
  expect(f.R).toBeLessThan(10);
  await page.goto(`/?record&manual&webgl&data=/fx/n50-untimed/live/&play=${PLAY}`);
  await page.waitForFunction(() => (window as unknown as W).__ready === true);
  await page.evaluate(() => (window as unknown as W).__tohn.enter(0));
  await page.waitForFunction(() => (window as unknown as W).__tohn.mode() === 'floor');
  await step(page, 120);
  expect((await floor(page)).on, 'no times, no clock: the room as it was').toBe(false);
});

test('reduced motion: the same room at every moment, without the growing and the ripple', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enter(page, 'onepassword');
  await call(page, 'floorAt', 7800); await settle(page);
  await same(page, 'reduced motion');
  expect((await floor(page)).here).toBeGreaterThan(10);
});

test('cheap at any size: a scrub costs the CPU well under a millisecond a frame (800 people, and the 1Password floor), and 1,000 seeks leave the heap where it was', async ({ page }, info) => {
  const rows: string[] = [];
  for (const fx of ['onepassword', 'n800']) {
    await enter(page, fx);
    const ms = await page.evaluate(() => {
      const t = (window as unknown as W).__tohn, end = (t.floor() as { end: number }).end, out: number[] = [];
      for (let k = 0; k <= 240; k++) {
        const a = performance.now();
        t.floorAt((end * k) / 240); t.frame(1 / 60, false);
        out.push(performance.now() - a);
      }
      out.sort((a, b) => a - b);
      return { med: out[out.length >> 1], p95: out[Math.floor(out.length * 0.95)] };
    });
    rows.push(`${fx}: frame (scrubbing, no draw) median ${ms.med.toFixed(3)} ms, p95 ${ms.p95.toFixed(3)} ms`);
    expect(ms.med, `${fx}: a scrubbed frame's JavaScript`).toBeLessThan(1.0);
  }
  const heap = await page.evaluate(async () => {
    const t = (window as unknown as W).__tohn, end = (t.floor() as { end: number }).end, gc = (window as unknown as { gc?: () => void }).gc;
    const used = () => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize;
    for (let k = 0; k < 200; k++) { t.floorAt(Math.random() * end); t.frame(1 / 60, false); }
    gc?.(); await new Promise((r) => setTimeout(r, 50)); gc?.();
    const a = used();
    for (let k = 0; k < 1000; k++) { t.floorAt(Math.random() * end); t.frame(1 / 60, false); }
    gc?.(); await new Promise((r) => setTimeout(r, 50)); gc?.();
    return { a, b: used() };
  });
  rows.push(`heap before ${(heap.a / 1e6).toFixed(2)} MB, after 1,000 seeks ${(heap.b / 1e6).toFixed(2)} MB`);
  await info.attach('floor-perf.txt', { body: rows.join('\n') });
  expect(heap.b - heap.a, 'heap growth over 1,000 seeks (bytes)').toBeLessThan(1.5e6);
});

test('pictures: the floor at 0, 10, 50, 90 and 100% of its line, and in the middle of a drag', async ({ page }, info) => {
  test.setTimeout(600_000);
  await enter(page, 'onepassword');
  const shot = async (name: string) => { await page.evaluate(() => (window as unknown as W).__tohn.frame(1 / 30, true)); await page.waitForTimeout(50); await page.screenshot({ path: info.outputPath(`${name}.png`) }); };
  for (const f of [0, 0.1, 0.5, 0.9, 1]) {
    await call(page, 'floorAt', await call<number>(page, 'floorT', f)); await settle(page);
    await shot(`floor-${Math.round(f * 100)}`);
  }
  const d = await drag(page, 0.2, 0.55, 6, 2);
  await page.waitForTimeout(60); await step(page, 30);
  await shot('floor-drag');
  await d.up();
});
