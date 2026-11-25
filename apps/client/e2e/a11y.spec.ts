// The reply sheet for everyone: keyboard only, a screen reader's view (roles, labels, live status, focus going back),
// contrast (axe), reduced motion, 200% zoom, and a phone keyboard taking half the screen.
import { test, expect, signedIn } from './fixtures.ts';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

const axe = async (page: Page) => {
  const r = await new AxeBuilder({ page }).include('#reply').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
};

test.beforeEach(async ({ page, mock, speech }) => { void mock; void speech; await page.goto('/'); });

test('no serious or critical axe findings in any state: writing, handed over, posted', async ({ page, context, mock }) => {
  await signedIn(context, mock);
  await page.locator('[data-reply=bob]').click();
  await page.getByRole('dialog').getByRole('textbox').fill('Checked by axe, all the way through.');
  await expect(page.locator('.quote')).toContainText('borrow');
  expect(await axe(page)).toEqual([]);
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: /Continue on Hacker News/ }).click();
  const hn = await opened;
  await expect(page.locator('#reply-to')).toHaveText('Over to Hacker News');
  expect(await axe(page)).toEqual([]);
  await hn.locator('textarea[name=text]').fill('Checked by axe, all the way through.');
  await hn.locator('input[type=submit][value=reply]').click();
  await page.bringToFront();
  await expect(page.locator('#reply-to')).toHaveText('Posted', { timeout: 20_000 });
  expect(await axe(page)).toEqual([]);
});

test('keyboard only: open, speak or type, send with ⌘/Ctrl+Enter, Esc out, and focus comes back', async ({ page, context }, info) => {
  test.skip(info.project.name === 'iphone' || info.project.name === 'pixel', 'a desk');
  const reply = page.locator('[data-reply=bob]');
  await reply.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('button', { name: 'Speak your reply' })).toBeFocused();   // Enter talks
  await page.keyboard.press('Tab');
  await expect(sheet.getByRole('textbox')).toBeFocused();
  await page.keyboard.type('Typed without a mouse.');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(reply).toBeFocused();                                              // back where you were
  await page.keyboard.press('Enter');
  await expect(sheet.getByRole('textbox')).toHaveValue('Typed without a mouse.');
  await sheet.getByRole('textbox').focus();
  const opened = context.waitForEvent('page');
  await page.keyboard.press('ControlOrMeta+Enter');
  await opened;
  await expect(page.locator('#reply-to')).toHaveText('Over to Hacker News');
  await expect(sheet.getByRole('button', { name: 'Copy again' })).toBeFocused();
});

test('what a screen reader gets: a labelled dialog, named controls, a live status line', async ({ page }) => {
  await page.locator('[data-reply=bob]').click();
  const sheet = page.getByRole('dialog', { name: 'Reply to bob' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Speak your reply' })).toHaveAttribute('aria-pressed', 'false');
  await expect(sheet.getByRole('textbox', { name: 'Your reply to bob' })).toBeVisible();
  await expect(sheet.getByRole('status')).toHaveText(/(Tap|Click) to speak/);
  await page.getByRole('button', { name: 'Speak your reply' }).click();
  await expect(sheet.getByRole('status')).toHaveText(/Listening/);
});

test('reduced motion: nothing pulses', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[data-reply=bob]').click();
  await page.getByRole('button', { name: 'Speak your reply' }).click();
  expect(await page.locator('#reply .ring').evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
  expect(await page.locator('#reply').evaluate((e) => getComputedStyle(e).transitionDuration)).toMatch(/^0s/);
});

test('200% zoom: the sheet fits, and every control can be reached', async ({ page }, info) => {
  test.skip(info.project.name === 'iphone' || info.project.name === 'pixel', 'a desk');
  await page.setViewportSize({ width: 640, height: 360 });                       // a 1280×720 window at 200%
  await page.locator('[data-reply=bob]').click();
  const box = await page.locator('#reply').boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(360);
  const post = page.getByRole('button', { name: /Continue on Hacker News/ });
  await post.scrollIntoViewIfNeeded();
  await expect(post).toBeInViewport();
});

test('a phone keyboard taking half the screen: the box and the button stay above it', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone' && info.project.name !== 'pixel', 'phones');
  await page.locator('[data-reply=bob]').click();
  await page.getByRole('dialog').getByRole('textbox').fill('Above the keyboard.');
  const h = await page.evaluate(() => innerHeight);
  const kb = Math.round(h * 0.45);
  // what the browser reports when its keyboard is up: a shorter visual viewport
  await page.evaluate((vh) => {
    const v = window.visualViewport!;
    Object.defineProperty(v, 'height', { configurable: true, get: () => vh });
    Object.defineProperty(v, 'offsetTop', { configurable: true, get: () => 0 });
    v.dispatchEvent(new Event('resize'));
  }, h - kb);
  await expect(page.locator('#reply')).toHaveClass(/\bkb\b/);
  const sheet = (await page.locator('#reply').boundingBox())!;
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(h - kb);
  expect(sheet.y).toBeGreaterThanOrEqual(0);
  const post = (await page.getByRole('button', { name: /Continue on Hacker News/ }).boundingBox())!;
  expect(post.y + post.height).toBeLessThanOrEqual(h - kb);
  await page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/${info.project.name}-5-keyboard.png` : test.info().outputPath('keyboard.png') });
});
