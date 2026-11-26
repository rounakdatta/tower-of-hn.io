// The timeline in the room (TIMELINE, with CROWD_V2): scrubbing shows the room as of then (people who hadn't joined
// the conversation yet aren't there), letting go plays from that comment at once with its caption, a drag across the
// whole conversation fetches only where the finger rested and asks the server for nothing until it's let go, the
// playhead follows the voice, keys step a comment (or ten) at a time, and a shared ?t= starts there. Chromium, the
// scene's clock stepped by hand; the scrubber is driven with the real mouse and touch input.
import { test, expect, type Page } from '@playwright/test';
// @ts-expect-error (a plain module, shared with the server)
import { ensure } from './room/fixtures.mjs';

type Fx = { name: string; sid: number; root: number; people: number };
const FX: Record<string, Fx> = ensure();
const PLAY = 'crowd,timeline,stream,cue,quick';
type W = { __ready: boolean; __tohn: Record<string, (...a: unknown[]) => unknown> };
const step = (page: Page, n: number) => page.evaluate((n) => { for (let k = 0; k < n; k++) (window as unknown as W).__tohn.frame(1 / 30, false); }, n);
const call = <T>(page: Page, fn: string, ...a: unknown[]) => page.evaluate(([fn, a]) => (window as unknown as W).__tohn[fn as string](...(a as unknown[])), [fn, a] as const) as Promise<T>;
interface Hall { present: number; people: number }
interface Pos { k: number; into: number }

async function seat(page: Page, fx: string, extra = '') {
  await page.goto(`/?record&manual&webgl&data=/fx/${fx}/live/&play=${PLAY}&table=${FX[fx].root}${extra}`);
  await page.waitForFunction(() => (window as unknown as W).__ready === true);
  await page.evaluate(() => (window as unknown as W).__tohn.enter(0));
  await page.waitForFunction(() => (window as unknown as W).__tohn.mode() === 'floor');
  await step(page, 150);
  await call(page, 'sit');
  await step(page, 90);
}
const slider = (page: Page) => page.getByRole('slider', { name: 'Conversation timeline' });
/** the scrubber's line: where x% of the conversation is on screen (across its track, on its hit strip) */
async function at(page: Page, f: number) {
  const track = (await page.locator('#timeline .tl-track').boundingBox())!, hit = (await page.locator('#timeline .tl-hit').boundingBox())!;
  return { x: track.x + track.width * f, y: hit.y + hit.height / 2 };
}
/** drag the playhead from one fraction of the line to another with the real mouse, stepping the scene while it moves */
async function drag(page: Page, from: number, to: number, steps = 12) {
  const a = await at(page, from), b = await at(page, to);
  await page.mouse.move(a.x, a.y - 30); await page.mouse.move(a.x, a.y);      // (hover reveals it)
  await page.mouse.down();
  for (let s = 1; s <= steps; s++) { await page.mouse.move(a.x + ((b.x - a.x) * s) / steps, a.y); await step(page, 3); }
}

test('scrubbing back empties the room of everyone who hadn\'t joined yet; forward, they\'re back', async ({ page }) => {
  await seat(page, 'onepassword');
  await drag(page, 0.5, 0.02);
  await step(page, 60);
  const early = await call<Hall>(page, 'hall');
  await page.mouse.move((await at(page, 0.98)).x, (await at(page, 0.98)).y);
  await step(page, 60);
  const late = await call<Hall>(page, 'hall');
  await page.mouse.up();
  // the 1Password table's 179 people: most of them only ever spoke there
  expect(late.present - early.present, `present early ${early.present}, late ${late.present}`).toBeGreaterThan(100);
  expect(late.present).toBeLessThanOrEqual(late.people);
});

test('letting go plays from that comment at once, with its caption', async ({ page }) => {
  await seat(page, 'onepassword');
  await drag(page, 0.1, 0.6);
  const k = (await call<Pos>(page, 'position'))?.k;
  await page.mouse.up();
  await step(page, 6);                                                       // 0.2 s
  const pos = await call<Pos>(page, 'position'), sp = await call<{ name: string } | null>(page, 'speaking');
  const turns = await page.evaluate(() => (window as unknown as W).__tohn.turns() as { by: string }[]);
  expect(pos.k).toBeGreaterThan(turns.length * 0.4);
  expect(sp?.name, 'the voice is the commenter at the moment you let go').toBe(turns[pos.k].by);
  await expect(page.locator('#subs')).toHaveClass(/show/);
  // (the name leads the caption; "→ whoever they answer" may follow it)
  await expect(page.locator('#subs .who')).toHaveText(new RegExp(`^${turns[pos.k].by.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
  void k;
});

test('a drag across the whole conversation fetches only where it rested, and asks the server for nothing until let go', async ({ page }) => {
  await seat(page, 'n800');
  await page.request.get('/__wants');                                        // (clear)
  const sidecars: string[] = [];
  page.on('request', (r) => { if (/\/c\/\d+\.f1\.json$/.test(r.url())) sidecars.push(r.url()); });
  // their own table's sidecars only (the rest of the room's tables talk on, quietly, and fetch their own)
  const own = new Set((await page.evaluate(() => (window as unknown as W).__tohn.turns() as { id: number }[])).map((u) => u.id));
  const ofTable = () => sidecars.filter((u) => own.has(Number(/\/c\/(\d+)\./.exec(u)?.[1]))).length;
  const before = ofTable();
  // a fast drag, as a hand makes one: no rest anywhere until the end
  const a = await at(page, 0.05), b = await at(page, 0.95);
  await page.mouse.move(a.x, a.y - 30); await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let s = 1; s <= 40; s++) await page.mouse.move(a.x + ((b.x - a.x) * s) / 40, a.y);
  const during = (await (await page.request.get('/__wants')).json()) as unknown[];
  expect(during, 'voicing asked for while dragging').toEqual([]);
  // resting at the end: its words (and the next comment's) are fetched once the finger has been still 150 ms
  await page.waitForTimeout(400);
  await page.mouse.up();
  await step(page, 30);
  // the comment it rested on and the next one (and nothing for the forty it passed)
  expect(ofTable() - before, 'sidecars fetched for a 40-step drag').toBeLessThanOrEqual(4);
  const wants = (await (await page.request.get('/__wants')).json()) as { table: number; from: number }[];
  for (const w of wants) expect(w.from, 'asks start where the conversation now is').toBeGreaterThan(0);
});

test('the playhead follows the voice, and pausing stops it', async ({ page }) => {
  await seat(page, 'onepassword');
  const v = async () => Number(await slider(page).getAttribute('aria-valuenow'));
  const a = await v();
  await step(page, 600);
  const b = await v();
  expect(b).toBeGreaterThan(a + 10);
  await page.locator('#pause').click();
  await step(page, 300);
  const c = await v();
  await step(page, 300);
  expect(await v()).toBe(c);
});

test('arrows step one comment, Shift ten; the conversation follows once the keys settle', async ({ page }) => {
  await seat(page, 'onepassword');
  const k0 = (await call<Pos>(page, 'position')).k;
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(500);                                            // (the keys settle in 350 ms)
  await step(page, 6);
  expect((await call<Pos>(page, 'position')).k).toBe(k0 + 11);
  await page.keyboard.press('Home');
  await page.waitForTimeout(500); await step(page, 6);
  expect((await call<Pos>(page, 'position')).k).toBe(0);
});

test('a shared moment (?t=) starts there', async ({ page }) => {
  await seat(page, 'onepassword', '&t=20m');
  const want = await page.evaluate(() => (window as unknown as W).__tohn.lineAt(20 * 60) as number);
  expect((await call<Pos>(page, 'position')).k).toBe(want);
  expect(want).toBeGreaterThan(10);
});

test('the slider says where you are, in words', async ({ page }) => {
  await seat(page, 'onepassword');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /^\d+ (s|min) in, [\d,]+ people?, comment by \S+$|^\d+ h \d\d min in, [\d,]+ people?, comment by \S+$/);
});
