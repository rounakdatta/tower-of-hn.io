// The conversation's timeline, on its own harness page (the app's letterbox and chrome, no 3D room): the same in Chromium,
// Firefox and WebKit, on desktops and on an iPhone and a Pixel. At rest it is a hairline and nothing else; a pointer, a
// finger or the keyboard raises it; dragging and keys say where you went. Real input throughout (page.mouse, the
// touchscreen, the keyboard, and the debugging protocol's touch where a finger has to slide): nothing here dispatches an
// event on an element. The harness records what the timeline tells its host (window.__calls); every expected value below
// is found from the conversation's own data by a plain scan, never by the code under test.
import { test, expect } from './fixtures.ts';
import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';

type Call = { n: number; frame: number; at: number; t: number; k: number };
type Calls = { scrub: Call[]; seek: Call[]; scrubbing: { n: number; frame: number; at: number; on: boolean }[] };
type Moment = { k: number; by: string; start: number; end: number; joined: number };
/** what the harness page exposes (e2e/harness/timeline-main.ts) */
type Win = {
  __calls: Calls; __keys: { key: string; prevented: boolean }[]; __pointer: { x: number; y: number; type: string; upAt: number }; __states: [number, string][]; __pills: Record<string, number>; __who: number;
  __line: { moments: Moment[]; total: number }; __others: number; __turns: Record<string, unknown>[]; __asked: Record<number, number>; __snippetMs: number;
  __scrubber: { setTime(t: number, playing: boolean): void; show(l: unknown, others: number, t?: number): void; hide(): void; refresh(l: unknown, others?: number): void; scrubbing: boolean };
  __lineOf: (t: unknown[]) => { total: number }; __valueText: (l: unknown, t: number, o: number) => string; __reset(): void;
};
const phone = (info: TestInfo) => info.project.name === 'iphone' || info.project.name === 'pixel';
const debugTouch = (info: TestInfo) => info.project.name === 'chromium' || info.project.name === 'pixel';
const shots = process.env.SHOTS;                         // a folder: key screens, to look at
const shot = async (page: Page, name: string) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/${test.info().project.name}-timeline-${name}.png` }); } };

test.beforeEach(async ({ page }) => {
  await page.goto('/timeline.html');
  await expect(page.locator('.tl')).toHaveAttribute('data-state', 'rest');
  await settle(page);
});

// ---------------------------------------------------------------- what the tests read

/** every transition and animation on the page has finished (it comes in after the letterbox, and eases about) */
const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))).then(() => undefined));
/** two frames: a resize has been taken in, and what listens to it has run */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const box = (page: Page, sel: string) => page.evaluate((s) => { const r = document.querySelector(s)!.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }, sel);
/** the line on the screen: where it starts, how long it is, and the y of its middle */
async function geometry(page: Page) {
  const track = await box(page, '.tl-track'), rail = await box(page, '.tl-rail');
  return { left: track.left, width: track.width, y: rail.top + rail.height / 2 };
}
type Geo = Awaited<ReturnType<typeof geometry>>;
const at = (g: Geo, f: number) => g.left + f * g.width;
const calls = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as Win).__calls)) as Calls);
const reset = (page: Page) => page.evaluate(() => (window as unknown as Win).__reset());
const state = (page: Page) => page.locator('.tl').getAttribute('data-state');
const knob = (page: Page) => page.getByRole('slider', { name: 'Conversation timeline' });
const knobValue = (page: Page) => knob(page).evaluate((e) => ({ now: e.getAttribute('aria-valuenow'), text: e.getAttribute('aria-valuetext') }));
const moments = (page: Page) => page.evaluate(() => (window as unknown as Win).__line.moments.map((m) => ({ k: m.k, by: m.by, start: m.start, joined: m.joined })));
const peopleShown = async (page: Page) => Number(/([\d,]+) people?/.exec((await page.locator('.tl-when span').textContent()) ?? '')?.[1].replace(/,/g, ''));
/** the comment under a point of the line, and who is in the room by then: a plain scan of the conversation, not turnAt() */
const under = (page: Page, f: number) => page.evaluate((f) => {
  const W = window as unknown as Win, t = f * W.__line.total;
  let k = 0;
  for (const m of W.__line.moments) if (m.start <= t) k = m.k;
  const m = W.__line.moments[k];
  return { k, t, start: m.start, by: m.by, people: m.joined + W.__others };
}, f);
/** ...under wherever the pointer last was (an engine may round a coordinate: what is expected goes by where it really was) */
async function underPointer(page: Page) {
  const x = await page.evaluate(() => (window as unknown as Win).__pointer.x), g = await geometry(page);
  return under(page, Math.min(1, Math.max(0, (x - g.left) / g.width)));
}
/**
 * Where a pointer or a finger can land on the timeline at a fraction of the line: the lowest free stretch of the band, its middle,
 * kept 14 px off whatever is above it. On a desktop that is just above the line. On a phone the app's pills straddle the line (they
 * sit 7 px above it on a Pixel, more with a home indicator) and Chromium's touch adjustment gives a touch within about 12 px of a
 * pill to the pill, so what is left to aim at is the bottom of the bar and the margins.
 */
async function spot(page: Page, f: number, at_?: number) {
  const g = await geometry(page), x = at_ ?? at(g, f);
  const y = await page.evaluate(([x, top]) => {
    const free = (y: number) => !!document.elementFromPoint(x, y)?.classList.contains('tl-hit');
    let lo = innerHeight - 1;
    while (lo > top && !free(lo)) lo--;
    if (!free(lo)) return null;
    let hi = lo;
    while (hi - 1 > top && free(hi - 1)) hi--;
    return Math.max((hi + lo) / 2, Math.min(lo, hi + 14));
  }, [x, g.y - 20]);
  expect(y, `a place on the line (x = ${Math.round(x)}) that the timeline can be reached at`).not.toBeNull();
  return { x, y: y as number };
}
const perFrame = (c: { frame: number }[]) => Math.max(0, ...Object.values(c.reduce<Record<number, number>>((m, s) => { m[s.frame] = (m[s.frame] ?? 0) + 1; return m; }, {})));

// ---------------------------------------------------------------- real input

interface Pointer { down(x: number, y: number): Promise<void>; move(x: number, y: number): Promise<void>; up(): Promise<void> }
/** one finger's worth of the debugging protocol's touch (the events a screen sends; only Chromium has it); [x, y, id] per finger on the glass */
async function fingers(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  return { touch: (points: number[][], type: 'touchStart' | 'touchMove' | 'touchEnd') => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) }).then(() => undefined) };
}
/** taps: a phone's touchscreen, or on a desktop Chromium the debugging protocol's touch (a desktop context has no touchscreen); the touch layout is on before anything is measured */
async function tapper(page: Page, info: TestInfo) {
  if (phone(info)) return { tap: (x: number, y: number) => page.touchscreen.tap(x, y) };
  const f = await fingers(page);
  return { tap: async (x: number, y: number) => { await f.touch([[x, y, 1]], 'touchStart'); await f.touch([], 'touchEnd'); } };
}
const noTouch = (info: TestInfo) => !phone(info) && !debugTouch(info);
/** a mouse, or one finger */
async function pointerOf(page: Page, how: 'mouse' | 'finger'): Promise<Pointer> {
  if (how === 'mouse') return { down: async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); }, move: (x, y) => page.mouse.move(x, y), up: () => page.mouse.up() };
  const f = await fingers(page);
  return { down: (x, y) => f.touch([[x, y, 1]], 'touchStart'), move: (x, y) => f.touch([[x, y, 1]], 'touchMove'), up: () => f.touch([], 'touchEnd') };
}
/** slide along y in n steps, a frame or so apart, as a hand does (a burst of moves would be one move to the screen) */
async function glide(p: Pointer, x0: number, x1: number, y: number, n: number) { for (let i = 1; i <= n; i++) { await p.move(x0 + ((x1 - x0) * i) / n, y); await new Promise((r) => setTimeout(r, 20)); } }

// ---------------------------------------------------------------- at rest

test('at rest it is a hairline on the bar\'s top edge, and covers nothing', async ({ page }, info) => {
  type R = { left: number; top: number; right: number; bottom: number };
  const [rail, bar, subs, hint, hit] = await Promise.all(['.tl-rail', '#lbb', '#subs', '#hint', '.tl-hit'].map((s) => box(page, s)));
  const pills: R[] = await page.evaluate(() => [...document.querySelectorAll('#controls .pill')].map((p) => { const r = p.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }));
  const vw = await page.evaluate(() => innerWidth);
  expect(rail.height, 'a hairline').toBeGreaterThanOrEqual(1.5);
  expect(rail.height, 'a hairline').toBeLessThanOrEqual(2);
  expect([rail.left, rail.right], 'across the full width').toEqual([0, vw]);
  expect(Math.abs(rail.top - bar.top), 'on the top edge of the letterbox').toBeLessThan(1);
  expect(rail.bottom, 'inside the bar: not a pixel of the picture').toBeLessThanOrEqual(bar.top + 2.5);
  const over = (a: R, b: R) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  expect(pills).toHaveLength(4);
  expect(over(rail, subs), 'the hairline over the subtitles').toBe(false);
  expect(over(rail, hint), 'the hairline over the hint').toBe(false);
  expect(over(hit, subs), 'what takes a pointer, over the subtitles').toBe(false);
  expect(rail.top - hit.top, 'how near a pointer has to be to raise it (px above the line)').toBeGreaterThanOrEqual(18);
  // the pills straddle the line on a phone: where one does, it is on top of the hairline (not under it), whatever the boxes say
  const covered = await page.evaluate(() => [...document.querySelectorAll('#controls .pill')].map((p) => {
    const a = p.getBoundingClientRect(), b = document.querySelector('.tl-rail')!.getBoundingClientRect();
    const x0 = Math.max(a.left, b.left), x1 = Math.min(a.right, b.right, innerWidth), y0 = Math.max(a.top, b.top), y1 = Math.min(a.bottom, b.bottom);
    if (x0 >= x1 || y0 >= y1) return 'clear';
    const top = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
    return top && p.contains(top) ? 'pill on top' : `${top?.className} on top`;
  }));
  expect(covered.filter((c) => c !== 'clear' && c !== 'pill on top'), 'the hairline over a pill').toEqual([]);
  // (for whoever lays out the bottom bar: how far the pills reach above the line here, and across how much of its width)
  const reach = Math.max(0, ...pills.map((p) => rail.top - p.top)), span = pills.length ? Math.max(...pills.map((p) => p.right)) - Math.min(...pills.map((p) => p.left)) : 0;
  info.annotations.push({ type: 'pills', description: `${Math.round(reach * 10) / 10} px above the line, across ${Math.round(span)} of ${vw} px` });
  // what is raised later is not there now: no knob, no bars, no card
  for (const s of ['.tl-knob', '.tl-bars', '.tl-ticks', '.tl-total']) await expect(page.locator(s)).toHaveCSS('opacity', '0');
  await expect(page.locator('.tl-card')).toHaveCSS('visibility', 'hidden');
  // a tap or a click aimed at a pill or at the speaker's name lands on it (the timeline is under them, or out of their way)
  const wanted = await page.evaluate(() => [...document.querySelectorAll('#controls .pill, #subs .who')].map((e) => { const r = e.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return top === e || e.contains(top); }));
  expect(wanted).toEqual([true, true, true, true, true]);
  await shot(page, '1-rest');
});

test('the pills and the speaker\'s name keep their taps with the timeline mounted', async ({ page }, info) => {
  const press = (sel: string) => (phone(info) ? page.locator(sel).tap() : page.locator(sel).click());
  for (const id of ['#answer', '#pause', '#next', '#leave', '#subs .who']) await press(id);
  expect(await page.evaluate(() => { const W = window as unknown as Win; return [...Object.values(W.__pills), W.__who]; })).toEqual([1, 1, 1, 1, 1]);
  expect(await state(page), 'a tap meant for a pill is not a tap on the timeline').toBe('rest');
  expect((await calls(page)).seek).toHaveLength(0);
});

test('the played part of the line is brighter, and the knob goes where the playhead goes', async ({ page }) => {
  const total = await page.evaluate(() => (window as unknown as Win).__line.total);
  const played = () => page.locator('.tl-done').evaluate((e) => Number(/scaleX\(([\d.]+)\)/.exec((e as HTMLElement).style.transform)?.[1]));
  await page.evaluate(() => (window as unknown as Win).__scrubber.setTime(1725, true));
  expect(await played()).toBeCloseTo(1725 / total, 3);
  expect(await knobValue(page)).toMatchObject({ now: '1725' });
  await settle(page);
  // (the ink at about half strength, over a line that is almost nothing)
  const c = await page.evaluate(() => { const s = (q: string) => getComputedStyle(document.querySelector(q)!); return { done: s('.tl-done').backgroundColor, opacity: Number(s('.tl-done').opacity), rest: s('.tl-rail').backgroundColor }; });
  expect(c.opacity).toBeCloseTo(0.55, 2);
  expect(c.done).toBe('rgb(239, 233, 224)');
  expect(c.rest).toMatch(/^rgba\(255, 255, 255, 0\.09\d*\)$/);
  await page.evaluate(() => (window as unknown as Win).__scrubber.setTime(3450, false));
  expect(await played()).toBeCloseTo(3450 / total, 3);
  expect(await knobValue(page)).toMatchObject({ now: '3450' });
  expect(await page.locator('.tl').getAttribute('data-playing'), 'paused is said too').toBe('0');
});

test('following the playhead never touches layout, raised or not: only styles are written', async ({ page }) => {
  for (const raised of [false, true]) {
    if (raised) { await knob(page).focus(); await expect(page.locator('.tl')).toHaveAttribute('data-state', 'open'); }
    const reads = await page.evaluate((from) => {
      let n = 0;
      const count = (proto: object, name: string) => {
        const d = Object.getOwnPropertyDescriptor(proto, name)!;
        if (d.get) Object.defineProperty(proto, name, { ...d, get(this: unknown) { n++; return d.get!.call(this); } });
        else { const f = d.value; Object.defineProperty(proto, name, { ...d, value(this: unknown, ...a: unknown[]) { n++; return f.apply(this, a); } }); }
      };
      for (const p of ['getBoundingClientRect', 'getClientRects', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'clientLeft', 'clientTop']) count(Element.prototype, p);
      for (const p of ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft']) count(HTMLElement.prototype, p);
      const gcs = window.getComputedStyle; window.getComputedStyle = (...a: Parameters<typeof gcs>) => { n++; return gcs.apply(window, a); };
      const s = (window as unknown as Win).__scrubber, pos = document.querySelector('.tl-pos') as HTMLElement, before = pos.style.transform;
      for (let i = 1; i <= 300; i++) s.setTime(from + i * 7, true);                    // (a few times a second, for a minute and a half)
      return { n, moved: pos.style.transform !== before };
    }, raised ? 3000 : 10);
    expect(reads.moved, `the knob moved (raised: ${raised})`).toBe(true);
    expect(reads.n, `layout reads while following the playhead (raised: ${raised})`).toBe(0);
  }
});

// ---------------------------------------------------------------- raising it

test('a pointer near the line raises it; away from it, it goes back', async ({ page }) => {
  const g = await geometry(page), tl = page.locator('.tl');
  await page.mouse.move(at(g, 0.5), g.y - 45);                                   // well above the line
  await page.waitForTimeout(400);
  expect(await state(page), 'not near').toBe('rest');
  const near = await spot(page, 0.5);                                            // (a phone with a trackpad hovers too, past its pills)
  await page.mouse.move(near.x, near.y);
  await expect(tl).toHaveAttribute('data-state', 'open');
  await settle(page);
  for (const s of ['.tl-bars', '.tl-ticks', '.tl-total', '.tl-knob']) await expect(page.locator(s), s).toHaveCSS('opacity', '1');
  await expect(page.locator('.tl-card')).toHaveCSS('visibility', 'visible');
  const want = await underPointer(page);                                         // the card is about the moment under the pointer
  await expect(page.locator('.tl-by')).toHaveText(want.by);
  expect(await peopleShown(page)).toBe(want.people);
  await shot(page, '2-hover');
  await page.mouse.move(at(g, 0.5), 120);
  await expect(tl).toHaveAttribute('data-state', 'rest');
  await settle(page);
  await expect(page.locator('.tl-bars')).toHaveCSS('opacity', '0');
  expect((await calls(page)).scrub, 'looking is not scrubbing').toHaveLength(0);
});

test('a touch on the line raises it and seeks nothing; it goes back by itself, a couple of seconds after the finger has gone', async ({ page }, info) => {
  test.skip(noTouch(info), 'touch needs a phone profile or the debugging protocol\'s touch: this desktop engine has neither in Playwright');
  const touch = await tapper(page, info);
  await frames(page);
  info.annotations.push({ type: 'hover', description: `(hover: none) ${await page.evaluate(() => matchMedia('(hover: none)').matches)}` });   // (the band's reach over the bar follows it)
  const tl = page.locator('.tl'), s = await spot(page, 0.4);
  // when it changes state, by the page's own clock (the test's round trips are too slow to time a couple of seconds with)
  await page.evaluate(() => {
    const W = window as unknown as Win, el = document.querySelector('.tl') as HTMLElement;
    W.__states = [];
    new MutationObserver(() => W.__states.push([performance.now(), el.dataset.state ?? ''])).observe(el, { attributes: true, attributeFilter: ['data-state'] });
  });
  await touch.tap(s.x, s.y);
  await expect(tl).toHaveAttribute('data-state', 'open');
  await settle(page);
  await expect(page.locator('.tl-bars')).toHaveCSS('opacity', '1');
  await shot(page, '2-touched');
  const c = await calls(page);
  expect(c.seek, 'a first touch raises it: it is not a seek').toHaveLength(0);
  expect(c.scrub).toHaveLength(0);
  await expect(tl).toHaveAttribute('data-state', 'rest', { timeout: 8000 });
  const { up, states } = await page.evaluate(() => { const W = window as unknown as Win; return { up: W.__pointer.upAt, states: W.__states }; });
  expect(states.map((x) => x[1]), 'up, then down: nothing in between').toEqual(['open', 'rest']);
  expect(states[1][0] - up, 'ms between the finger going and the timeline lowering').toBeGreaterThan(2300);
  expect(states[1][0] - up).toBeLessThan(5000);
});

test('a short pull up from the bottom of the bar raises it too, and a pull is not a seek', async ({ page }, info) => {
  test.skip(!phone(info) || !debugTouch(info), 'a finger sliding up needs the debugging protocol\'s touch (Playwright\'s WebKit sends taps only), and the band over the whole bar is the phones\' layout');
  const g = await geometry(page), vw = await page.evaluate(() => innerWidth), vh = await page.evaluate(() => innerHeight);
  const f = await fingers(page);
  await f.touch([[vw / 2, vh - 8, 1]], 'touchStart');                           // the very bottom of the bar, under the pills
  await expect(page.locator('.tl')).toHaveAttribute('data-state', 'open');
  for (let i = 1; i <= 8; i++) await f.touch([[vw / 2, vh - 8 - ((vh - 8 - (g.y - 30)) * i) / 8, 1]], 'touchMove');
  await f.touch([], 'touchEnd');
  const c = await calls(page);
  expect(c.seek).toHaveLength(0);
  expect(c.scrubbing, 'a pull up is not a drag along the line').toHaveLength(0);
  await expect(page.locator('.tl')).toHaveAttribute('data-state', 'open');
});

// ---------------------------------------------------------------- dragging, tapping, clicking

for (const how of ['mouse', 'finger'] as const) {
  test(`dragging along the line with ${how === 'mouse' ? 'the mouse' : 'a finger'}: the card follows, the host hears once per frame, and the seek is where it was let go`, async ({ page }, info) => {
    test.skip(how === 'finger' && !debugTouch(info), 'a finger sliding needs the debugging protocol\'s touch: only Chromium has it (Playwright\'s WebKit and Firefox send taps only)');
    const p = await pointerOf(page, how);                                        // (a finger first: a touch screen has its own layout)
    await frames(page);
    const g = await geometry(page), { y, x: x20 } = await spot(page, 0.2);
    await p.down(x20, y);
    await glide(p, x20, at(g, 0.45), y, 15);
    await expect.poll(async () => (await peopleShown(page)) === (await underPointer(page)).people).toBe(true);
    const mid = await peopleShown(page);
    // under the finger or the button nothing eases (that is lag): the line, the knob and the warm bars follow at once
    for (const s of ['.tl-pos', '.tl-done', '.tl-lit']) await expect(page.locator(s), `${s} while held`).toHaveCSS('transition-duration', '0s');
    await shot(page, '3-dragging');
    await glide(p, at(g, 0.45), at(g, 0.7), y, 15);
    const end = await underPointer(page);
    await expect.poll(async () => (await calls(page)).scrub.slice(-1)[0]?.k, { message: 'the host has heard the comment under the pointer' }).toBe(end.k);
    await expect.poll(async () => await peopleShown(page), { message: 'the card says who is in the room there' }).toBe(end.people);
    const far = await peopleShown(page);
    expect(mid, 'people in the room 45% in, against 20% in').toBeGreaterThan((await under(page, 0.2)).people);
    expect(far, '70% in, against 45% in').toBeGreaterThan(mid);
    await p.up();
    await expect.poll(async () => (await calls(page)).seek.length).toBe(1);
    await page.waitForTimeout(500);
    const c = await calls(page);
    expect(c.seek, 'exactly one seek, on release').toHaveLength(1);
    expect(c.seek[0].k, 'the comment under the pointer when it was let go').toBe(end.k);
    expect(c.seek[0].t, '...from its start').toBe(end.start);
    expect(c.scrubbing.map((s) => s.on), 'a drag starts and ends once').toEqual([true, false]);
    expect(c.scrubbing[1].n, 'the drag has ended when the seek comes').toBeLessThan(c.seek[0].n);
    expect(c.scrub.length, 'it reported the way').toBeGreaterThanOrEqual(10);
    expect(c.scrub.every((s, i) => i === 0 || s.t > c.scrub[i - 1].t), 'moving right: each moment later than the last').toBe(true);
    expect(c.scrub[c.scrub.length - 1].k, 'the last thing the host heard while dragging is where it was let go').toBe(end.k);
    // (Chromium, and Firefox, hand a page one pointer move a frame themselves; the count is the guarantee where an engine does not)
    expect(perFrame(c.scrub), 'onScrub calls in one animation frame').toBe(1);
    expect((await knobValue(page)).now, 'the knob is at the comment\'s start now, and says so').toBe(String(Math.floor(end.start)));
    await expect(page.locator('.tl-pos')).toHaveCSS('transition-duration', '0.22s');   // (easing is for the release)
  });
}

test('a tap seeks once it is up: the comment under the finger, exactly once; the tap before it only raised it', async ({ page }, info) => {
  test.skip(noTouch(info), 'touch needs a phone profile or the debugging protocol\'s touch: this desktop engine has neither in Playwright');
  const touch = await tapper(page, info);
  await frames(page);
  const first = await spot(page, 0.3), second = await spot(page, 0.6);
  await touch.tap(first.x, first.y);                                           // the first touch raises it...
  await touch.tap(second.x, second.y);                                         // ...and now a tap is a seek (within the moment it stays up)
  await expect.poll(async () => (await calls(page)).seek.length).toBe(1);
  await page.waitForTimeout(400);
  const c = await calls(page), want = await underPointer(page);
  expect(c.seek, 'one seek: the first tap was not one').toHaveLength(1);
  expect([c.seek[0].k, c.seek[0].t]).toEqual([want.k, want.start]);
  expect(want.k, 'a comment in the middle of the thread').toBeGreaterThan(10);
  expect(c.scrubbing.map((s) => s.on), 'one drag: the second touch').toEqual([true, false]);
  expect(c.scrub, 'the host hears where, even from a tap').toHaveLength(1);
  expect((await knobValue(page)).now).toBe(String(Math.floor(want.start)));
});

test('a click on the line seeks to the comment under it', async ({ page }) => {
  const s = await spot(page, 0.33);
  await page.mouse.click(s.x, s.y);
  await expect.poll(async () => (await calls(page)).seek.length).toBe(1);
  const c = await calls(page), want = await underPointer(page);
  expect([c.seek[0].k, c.seek[0].t]).toEqual([want.k, want.start]);
  expect(want.k, 'a comment a third of the way into the thread').toBeGreaterThan(10);
  expect(c.scrubbing.map((s) => s.on)).toEqual([true, false]);
});

test('a second finger cancels the drag: nothing is sought and the knob goes back to the playhead', async ({ page }, info) => {
  test.skip(!debugTouch(info), 'two fingers need the debugging protocol\'s touch (Playwright\'s WebKit sends single taps only)');
  await page.evaluate(() => (window as unknown as Win).__scrubber.setTime(900, true));
  const f = await fingers(page);
  await frames(page);
  const g = await geometry(page), { x: x0, y } = await spot(page, 0.3);
  await f.touch([[x0, y, 1]], 'touchStart');
  for (let i = 1; i <= 6; i++) await f.touch([[x0 + i * 12, y, 1]], 'touchMove');
  await expect.poll(async () => (await calls(page)).scrubbing.map((s) => s.on)).toEqual([true]);
  await expect(page.locator('.tl')).toHaveAttribute('data-state', 'drag');
  await f.touch([[x0 + 72, y, 1], [at(g, 0.5), 200, 2]], 'touchStart');     // another finger lands on the picture: a pinch begins
  await expect.poll(async () => (await calls(page)).scrubbing.map((s) => s.on)).toEqual([true, false]);
  await f.touch([[at(g, 0.5), 200, 2]], 'touchEnd');                           // the first lifts...
  await f.touch([], 'touchEnd');                                              // ...and the second
  await page.waitForTimeout(500);
  expect((await calls(page)).seek, 'a pinch is not a seek').toHaveLength(0);
  expect((await knobValue(page)).now, 'back at the playhead').toBe('900');
});

test('stood up with the button down (the timeline goes away mid-drag): the drag ends and nothing is sought', async ({ page }) => {
  const g = await geometry(page), s = await spot(page, 0.3);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.move(at(g, 0.5), s.y, { steps: 6 });
  await expect.poll(async () => (await calls(page)).scrubbing.map((s) => s.on)).toEqual([true]);
  await page.evaluate(() => (window as unknown as Win).__scrubber.hide());
  await expect.poll(async () => (await calls(page)).scrubbing.map((s) => s.on)).toEqual([true, false]);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect((await calls(page)).seek, 'nothing is sought for a timeline that went away').toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as Win).__scrubber.scrubbing)).toBe(false);
});

// ---------------------------------------------------------------- the card

test('the card is inside a 390 px screen at both ends, and in the middle it is centred on the pointer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(390);
  await frames(page);
  const g = await geometry(page);
  const inside = async (x: number, label: string) => {
    const s = await spot(page, 0, x);
    await page.mouse.move(s.x, s.y);
    await expect(page.locator('.tl')).toHaveAttribute('data-state', 'open');
    await settle(page);
    await expect.poll(async () => (await box(page, '.tl-card')).width, { message: `${label}: the card is laid out` }).toBeGreaterThan(250);
    const r = await box(page, '.tl-card');
    expect(r.left, `${label}: the card's left edge`).toBeGreaterThanOrEqual(7.5);
    expect(r.right, `${label}: the card's right edge`).toBeLessThanOrEqual(390 - 7.5);
    for (const part of ['.tl-when', '.tl-by', '.tl-words']) { const q = await box(page, part); expect(q.left, `${label}: ${part}`).toBeGreaterThanOrEqual(r.left); expect(q.right, `${label}: ${part}`).toBeLessThanOrEqual(r.right + 0.5); }
    return r;
  };
  await inside(0, 'left end');
  await shot(page, '4-card-left');
  await inside(389, 'right end');
  await shot(page, '4-card-right');
  const mid = await inside(at(g, 0.5), 'middle'), px = await page.evaluate(() => (window as unknown as Win).__pointer.x);
  expect(Math.abs((mid.left + mid.right) / 2 - px), 'the ends are a clamp, not a rule: in the middle the card is centred on the pointer').toBeLessThan(1);
  await page.mouse.move(200, 120);
  await expect(page.locator('.tl')).toHaveAttribute('data-state', 'rest');
  await expect(page.locator('.tl-card')).toHaveCSS('visibility', 'hidden');
});

test('the card is inside a 390 px screen for the first comment and the last, under the keys', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(390);
  await frames(page);
  const ms = await moments(page);
  await knob(page).focus();
  for (const [key, who] of [['End', ms[ms.length - 1].by], ['Home', ms[0].by]] as const) {
    await page.keyboard.press(key);
    await expect(page.locator('.tl-by')).toHaveText(who);
    await settle(page);
    const r = await box(page, '.tl-card');
    expect(r.left, `${key}: left`).toBeGreaterThanOrEqual(7.5);
    expect(r.right, `${key}: right`).toBeLessThanOrEqual(390 - 7.5);
    expect(r.width, `${key}: the whole card`).toBeGreaterThan(250);
  }
});

test('the card is inside a 390 px screen at both ends under a finger', async ({ page }, info) => {
  test.skip(!debugTouch(info), 'a finger sliding needs the debugging protocol\'s touch: only Chromium has it');
  await page.setViewportSize({ width: 390, height: 780 });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(390);
  await frames(page);
  const p = await pointerOf(page, 'finger');
  await frames(page);
  const { x: x0, y } = await spot(page, 0.5);
  await p.down(x0, y);
  await glide(p, x0, 2, y, 14);
  await expect.poll(async () => (await box(page, '.tl-card')).left).toBeLessThan(10);
  expect((await box(page, '.tl-card')).left).toBeGreaterThanOrEqual(7.5);
  await glide(p, 2, 388, y, 24);
  await expect.poll(async () => (await box(page, '.tl-card')).right).toBeGreaterThan(380);
  expect((await box(page, '.tl-card')).right).toBeLessThanOrEqual(390 - 7.5);
  await p.up();
});

test('the card says who and when, and their words arrive after their name', async ({ page }) => {
  await page.evaluate(() => { (window as unknown as Win).__snippetMs = 1500; });       // odd comments' words take a moment
  await knob(page).focus();
  await page.keyboard.press('ArrowRight');                                       // comment 1: odd
  const m = (await moments(page))[1];
  await expect(page.locator('.tl-by')).toHaveText(m.by);
  await expect(page.locator('.tl-words'), 'the name alone, until the words are known').not.toHaveClass(/\bin\b/);
  await expect(page.locator('.tl-words')).toHaveText('');
  await expect(page.locator('.tl-words')).toHaveClass(/\bin\b/, { timeout: 8000 });
  await expect(page.locator('.tl-words')).toHaveText(/^I disagree: LLVM is why it is fast/);
  await expect(page.locator('.tl-words')).toHaveCSS('text-overflow', 'ellipsis');
  const asked = await page.evaluate(() => (window as unknown as Win).__asked[1]);
  expect(asked, 'it asked again, frame after frame, until it had them').toBeGreaterThan(2);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as Win).__asked[1]), 'and then stopped asking').toBe(asked);
  await page.keyboard.press('ArrowRight');                                       // comment 2: even, known at once
  await expect(page.locator('.tl-words')).toHaveText(/^We tried this at my last job/);
  await shot(page, '5-words');
});

test('people are counted with their thousands and never rounded up: 9,999 stays 9,999', async ({ page }) => {
  await page.evaluate(() => { const W = window as unknown as Win; W.__scrubber.refresh({ ...W.__line }, 9998); });   // the opener, and 9,998 others in the room
  await knob(page).focus();
  await expect(page.locator('.tl-when span')).toHaveText(' · 9,999 people');
  expect((await knobValue(page)).text).toBe('0 s in, 9,999 people, comment by tptacek');
  await page.keyboard.press('End');
  const last = (await moments(page)).slice(-1)[0].joined + 9998;
  await expect(page.locator('.tl-when span')).toHaveText(` · ${last.toLocaleString('en-US')} people`);
});

// ---------------------------------------------------------------- the keyboard

test('keyboard: Tab lands on the knob; arrows move by comments, Shift by ten, Home and End to the ends; it plays from there once the keys settle', async ({ page }) => {
  const L = await moments(page), tl = page.locator('.tl');
  const valueText = (k: number) => page.evaluate((t) => { const W = window as unknown as Win; return W.__valueText(W.__line, t, W.__others); }, L[k].start);
  for (let i = 0; i < 8 && !(await knob(page).evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(knob(page), 'Tab reaches the knob').toBeFocused();
  await expect(tl, 'focus raises it').toHaveAttribute('data-state', 'open');
  await expect(knob(page), 'a visible ring for the keyboard').toHaveCSS('outline-style', 'solid');
  await expect(knob(page)).toHaveCSS('outline-width', '2px');
  await expect(knob(page)).toHaveAttribute('aria-valuemin', '0');
  await expect(knob(page)).toHaveAttribute('aria-valuemax', String(Math.floor(await page.evaluate(() => (window as unknown as Win).__line.total))));
  expect(await knobValue(page)).toEqual({ now: '0', text: '0 s in, 13 people, comment by tptacek' });
  await shot(page, '6-keyboard');

  await reset(page);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');           // three comments on, in a burst
  let c = await calls(page);
  expect(c.scrub.map((s) => s.k), 'each key is heard at once').toEqual([1, 2, 3]);
  expect(c.scrub.map((s) => s.t)).toEqual([L[1].start, L[2].start, L[3].start]);
  expect(c.scrub[2].at - c.scrub[0].at, 'the keys came within one settle: a burst, to be taken as one').toBeLessThan(300);
  expect(c.seek, 'not played from yet: the keys have not settled').toHaveLength(0);
  expect(await knobValue(page)).toEqual({ now: String(Math.floor(L[3].start)), text: await valueText(3) });
  await expect(page.locator('.tl-by')).toHaveText(L[3].by);
  await expect.poll(async () => (await calls(page)).seek.length).toBe(1);
  await page.waitForTimeout(700);
  c = await calls(page);
  expect(c.seek, 'played from once').toHaveLength(1);
  expect([c.seek[0].k, c.seek[0].t]).toEqual([3, L[3].start]);

  const press = async (key: string, k: number) => {
    await reset(page);
    await page.keyboard.press(key);
    expect((await calls(page)).scrub.map((s) => s.k), `${key}: heard at once`).toEqual([k]);
    expect(await knobValue(page), key).toEqual({ now: String(Math.floor(L[k].start)), text: await valueText(k) });
    await expect.poll(async () => (await calls(page)).seek.length, { message: `${key}: settles` }).toBe(1);
    expect((await calls(page)).seek[0].k, `${key}: played from`).toBe(k);
  };
  const nowhere = async (key: string) => {                                       // a key with nowhere to go changes nothing, not even where you are
    await reset(page);
    await page.keyboard.press(key);
    await page.waitForTimeout(600);
    const n = await calls(page);
    expect([n.scrub.length, n.seek.length], `${key}: nowhere to go`).toEqual([0, 0]);
  };
  await press('Shift+ArrowRight', 13);
  await press('ArrowLeft', 12);
  await press('Shift+ArrowLeft', 2);
  await press('Shift+ArrowLeft', 0);                                             // (it stops at the first)
  await nowhere('ArrowLeft');
  await nowhere('Shift+ArrowLeft');
  await press('End', L.length - 1);
  await nowhere('ArrowRight');                                                   // (and at the last)
  await nowhere('Shift+ArrowRight');
  await press('ArrowLeft', L.length - 2);
  await press('Home', 0);
  await press('PageUp', 10);                                                     // the other keys a slider has: Up and Down as Right and Left, Page as ten
  await press('ArrowUp', 11);
  await press('ArrowDown', 10);
  await press('PageDown', 0);
});

test('keyboard: Space, Escape, N, R and M are the app\'s, and reach the window untouched; the keys the knob takes are prevented', async ({ page }) => {
  await knob(page).focus();
  await reset(page);
  for (const key of ['Space', 'Escape', 'n', 'r', 'm', 'N', 'R', 'M', 'Enter']) await page.keyboard.press(key);
  await page.keyboard.press('ArrowRight');
  const seen = await page.evaluate(() => (window as unknown as Win).__keys);
  expect(seen.map((k) => k.key)).toEqual([' ', 'Escape', 'n', 'r', 'm', 'N', 'R', 'M', 'Enter', 'ArrowRight']);
  expect(seen.slice(0, 9).map((k) => k.prevented), 'the app\'s keys').toEqual(Array(9).fill(false));
  expect(seen[9].prevented, 'a key the knob takes (so that "nothing was prevented" is not a dead handler)').toBe(true);
  expect((await calls(page)).scrub.map((s) => s.k), 'only the arrow moved it').toEqual([1]);
});

test('keyboard: Alt, Ctrl and Cmd with an arrow are the browser\'s (Back and Forward, tabs): the knob leaves them alone', async ({ page }) => {
  await knob(page).focus();
  await reset(page);
  for (const key of ['Alt+ArrowRight', 'Control+ArrowRight', 'Meta+ArrowRight']) await page.keyboard.press(key);
  expect((await page.evaluate(() => (window as unknown as Win).__keys)).filter((k) => k.key.startsWith('Arrow')).map((k) => k.prevented)).toEqual([false, false, false]);
  expect((await calls(page)).scrub).toHaveLength(0);
});

// ---------------------------------------------------------------- the conversation changes under it

test('a conversation that grows is redrawn, and the playhead keeps its place in time', async ({ page }) => {
  await page.evaluate(() => (window as unknown as Win).__scrubber.setTime(1500, true));
  const read = () => page.evaluate(() => ({
    total: document.querySelector('.tl-total')!.textContent, max: document.querySelector('.tl-knob')!.getAttribute('aria-valuemax'),
    d: document.querySelector('.tl-hist path')!.getAttribute('d'), played: (document.querySelector('.tl-done') as HTMLElement).style.transform,
  }));
  const before = await read();
  // forty more comments of a minute each, from people who have not spoken yet
  const grown = await page.evaluate(() => {
    const W = window as unknown as Win, more = Array.from({ length: 40 }, (_, i) => ({ id: 47000000 + i, by: `late${i}`, depth: 2, gapMs: 480, v: ['x.opus', 60, 'neutral', 0.3] }));
    const line = W.__lineOf([...W.__turns, ...more]);
    W.__scrubber.refresh(line, W.__others);
    return line.total;
  });
  const after = await read();
  expect(before.total).toMatch(/^1 h \d\d min$/);
  expect(after.total, 'a longer thread').toMatch(/^2 h \d\d min$/);
  expect(after.max).toBe(String(Math.floor(grown)));
  expect(after.d, 'the bars are drawn again').not.toBe(before.d);
  expect(Number(/scaleX\(([\d.]+)\)/.exec(after.played)![1]), 'the same second, a smaller part of a longer line').toBeCloseTo(1500 / grown, 3);
  expect((await knobValue(page)).now, 'the same second').toBe('1500');
});

test('seated at a new conversation it starts over; at one comment, or once you stand up, it is not there at all', async ({ page }) => {
  await page.evaluate(() => (window as unknown as Win).__scrubber.setTime(2000, true));
  const short = await page.evaluate(() => {
    const W = window as unknown as Win, line = W.__lineOf(W.__turns.slice(0, 20));
    W.__scrubber.show(line, 5, 0);
    return line.total;
  });
  expect((await knobValue(page)).now, 'at the start of the new one').toBe('0');
  await expect(knob(page)).toHaveAttribute('aria-valuemax', String(Math.floor(short)));
  expect(await state(page)).toBe('rest');
  await page.evaluate(() => { const W = window as unknown as Win; W.__scrubber.show(W.__lineOf(W.__turns.slice(0, 1)), 0, 0); });
  await expect(page.locator('.tl')).toHaveAttribute('data-state', 'hidden');
  await expect(knob(page), 'nothing to scrub: nothing to tab to').toBeHidden();
  await page.evaluate(() => { const W = window as unknown as Win; W.__scrubber.show(W.__line, 12, 600); });
  await expect(page.locator('.tl')).toHaveAttribute('data-state', 'rest');
  expect((await knobValue(page)).now).toBe('600');
  await page.evaluate(() => (window as unknown as Win).__scrubber.hide());
  await expect(page.locator('.tl')).toHaveAttribute('data-state', 'hidden');
  await expect(knob(page)).toBeHidden();
});

test('a sheet over the room (a reply, a commenter\'s card) puts the timeline out of reach', async ({ page }) => {
  const g = await geometry(page);
  await page.evaluate(() => document.body.classList.add('reply-open'));
  await expect(page.locator('.tl')).toHaveCSS('visibility', 'hidden');
  await expect(knob(page), 'not for Tab either').toBeHidden();
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className ?? '', [at(g, 0.5), g.y - 10])).not.toContain('tl-hit');
  await page.evaluate(() => document.body.classList.replace('reply-open', 'card-open'));
  await expect(page.locator('.tl')).toHaveCSS('visibility', 'hidden');
  await page.evaluate(() => document.body.classList.remove('card-open'));
  await expect(page.locator('.tl')).toHaveCSS('visibility', 'visible');
  await expect(knob(page)).toBeVisible();
});

// ---------------------------------------------------------------- for everyone

test('no axe findings at all (WCAG A and AA, any impact): at rest, raised by the keyboard, and in the middle of a drag', async ({ page }) => {
  const axe = async () => (await new AxeBuilder({ page }).include('.tl').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze())
    .violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(await axe(), 'at rest').toEqual([]);
  await knob(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tl-card')).toHaveCSS('visibility', 'visible');
  await settle(page);
  expect(await axe(), 'raised').toEqual([]);
  await page.keyboard.press('Shift+Tab');                                        // (leaves it)
  const g = await geometry(page), s = await spot(page, 0.3);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.move(at(g, 0.6), s.y, { steps: 8 });
  await expect(page.locator('.tl')).toHaveAttribute('data-state', 'drag');
  expect(await axe(), 'dragging').toEqual([]);
  await page.mouse.up();
});

test('what a screen reader gets: one named slider whose value says how far, how many and who; the preview is not read twice; playing does not make it chatter', async ({ page }) => {
  await expect(knob(page)).toHaveCount(1);
  await expect(knob(page)).toHaveAttribute('tabindex', '0');
  await expect(page.locator('.tl-card')).toHaveAttribute('aria-hidden', 'true');
  expect(await knobValue(page)).toEqual({ now: '0', text: '0 s in, 13 people, comment by tptacek' });
  await page.evaluate(() => (window as unknown as Win).__scrubber.setTime(2400, true));
  const v = await knobValue(page);
  expect(v.now).toBe('2400');
  expect(v.text).toMatch(/^40 min in, \d+ people, comment by \S+$/);
  // focused, it does not speak every second the playhead moves, but when the commenter changes
  await knob(page).focus();
  const k = (await moments(page)).filter((m) => m.start <= 2400).slice(-1)[0], next = (await moments(page))[k.k + 1];
  await page.evaluate((t) => (window as unknown as Win).__scrubber.setTime(t, true), (k.start + next.start) / 2);
  expect((await knobValue(page)).now, 'the same comment: the same words').toBe('2400');
  await page.evaluate((t) => (window as unknown as Win).__scrubber.setTime(t, true), next.start + 1);
  expect((await knobValue(page)).now, 'the next commenter: it speaks').toBe(String(Math.floor(next.start + 1)));
});

test('reduced motion: nothing eases, fades in or rises, and everything is still there', async ({ page }) => {
  const parts = ['.tl-pos', '.tl-done', '.tl-lit', '.tl-bars', '.tl-ticks', '.tl-knob', '.tl-card', '.tl-words'];
  const durations = () => page.evaluate((qs) => qs.map((q) => getComputedStyle(document.querySelector(q)!).transitionDuration), parts);
  const eased = await durations();
  expect(eased.every((d) => !/^0s(, 0s)*$/.test(d)), `with motion allowed these all ease: ${eased}`).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await durations()).toEqual(parts.map(() => expect.stringMatching(/^0s(, 0s)*$/)));
  await expect(page.locator('.tl')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.tl')).toHaveCSS('transition-duration', '0s');
  // the same information, at once: the bars at full height, the card there, the knob full size
  await knob(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tl')).toHaveAttribute('data-state', 'open');
  expect(await page.evaluate(() => { const s = (q: string) => getComputedStyle(document.querySelector(q)!); return [s('.tl-bars').opacity, s('.tl-bars').transform, s('.tl-knob').opacity, s('.tl-knob').transform, s('.tl-card').opacity, s('.tl-card').visibility]; }))
    .toEqual(['1', 'none', '1', 'none', '1', 'visible']);
  await shot(page, '7-reduced-motion');
});
