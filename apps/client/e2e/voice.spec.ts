// Dictation, through a stand-in for the browser's speech recogniser (window.__sr, see fixtures.ts): the sheet's side of
// it, the same in every engine. How well real recognisers hear HN's vocabulary is measured separately (docs/QA).
import { test, expect } from './fixtures.ts';
import type { Page } from '@playwright/test';

const sr = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as unknown as { __sr: Record<string, (...x: unknown[]) => unknown> }).__sr[f as string](...(a as unknown[])), [fn, args] as const);
const ctl = (page: Page) => page.evaluate(() => { const c = (window as unknown as { __sr: Record<string, unknown> }).__sr; return { started: c.started, stopped: c.stopped, aborted: c.aborted, active: !!c.active, continuous: c.continuous, interim: c.interim }; });

test.beforeEach(async ({ page, mock, speech }) => { void mock; void speech; await page.goto('/'); await page.locator('[data-reply=bob]').click(); });

test('speak, see it live, stop; the room goes quiet while you speak; your words, unchanged', async ({ page }) => {
  const sheet = page.getByRole('dialog'), mic = sheet.getByRole('button', { name: 'Speak your reply' }), box = sheet.getByRole('textbox');
  await expect(sheet).toContainText(/Speech becomes text in your browser, by (Google|Apple|Microsoft)’s service: we never get your voice/);
  await mic.click();
  await expect(sheet.getByRole('button', { name: 'Stop listening' })).toBeVisible();
  await expect(sheet.getByRole('status')).toContainText('Listening');
  expect(await page.evaluate(() => (window as unknown as { __ducked: boolean }).__ducked)).toBe(true);
  expect(await ctl(page)).toMatchObject({ started: 1, continuous: true, interim: true });
  await sr(page, 'hear', 'i think');
  await expect(box).toHaveValue('I think');                                       // live, as it's heard
  await sr(page, 'hear', 'i think the borrow checker', true);
  await sr(page, 'hear', ' is right about this');
  await expect(box).toHaveValue('I think the borrow checker is right about this');
  await sheet.getByRole('button', { name: 'Stop listening' }).click();
  await expect(mic).toBeVisible();
  await expect(sheet.getByRole('status')).toContainText('Read it over');
  expect(await page.evaluate(() => (window as unknown as { __ducked: boolean }).__ducked)).toBe(false);
  await expect(box).toHaveValue('I think the borrow checker is right about this');
  // a second round goes after it: a space, and no capital in the middle of a sentence
  await mic.click();
  await sr(page, 'hear', 'in most cases', true);
  await sr(page, 'end');
  await expect(box).toHaveValue('I think the borrow checker is right about this in most cases');
  // and a new sentence after a full stop starts with one
  await box.fill(`${await box.inputValue()}.`);
  await mic.click();
  await sr(page, 'hear', 'not all of them though', true);
  await sr(page, 'end');
  await expect(box).toHaveValue('I think the borrow checker is right about this in most cases. Not all of them though');
});

test('typing while it listens: your typing wins, and late words don\'t overwrite it', async ({ page }) => {
  const sheet = page.getByRole('dialog'), box = sheet.getByRole('textbox');
  await sheet.getByRole('button', { name: 'Speak your reply' }).click();
  await sr(page, 'hear', 'hello there');
  await expect(box).toHaveValue('Hello there');
  await box.press('End');
  await box.pressSequentially(', friend');
  expect((await ctl(page)).aborted).toBe(1);
  await sr(page, 'hear', 'hello there and something late', true);              // after the cut: ignored
  await expect(box).toHaveValue('Hello there, friend');
  await expect(sheet.getByRole('button', { name: 'Speak your reply' })).toBeVisible();
});

test('microphone blocked (or the prompt dismissed): a reason, a way on, and it stays on screen', async ({ page }) => {
  await page.evaluate(() => { (window as unknown as { __sr: { deny: string } }).__sr.deny = 'not-allowed'; });
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Speak your reply' }).click();
  const status = sheet.getByRole('status');
  await expect(status).toHaveText('The microphone is blocked for this site: allow it in your browser’s site settings, or type');
  await page.waitForTimeout(400);                                                // (after the session's end, too)
  await expect(status).toHaveText(/The microphone is blocked/);
  await expect(status).toHaveClass(/error/);
  await expect(sheet.getByRole('textbox')).toBeEditable();
});

for (const [code, words] of [['no-speech', 'Didn’t catch that'], ['network', 'The dictation service didn’t answer'], ['audio-capture', 'No microphone found'],
  ['service-not-allowed', 'Dictation is off on this device'], ['language-not-supported', 'Dictation doesn’t know']] as const) {
  test(`recogniser error "${code}" is said plainly`, async ({ page }) => {
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'Speak your reply' }).click();
    await sr(page, 'fail', code);
    await expect(sheet.getByRole('status')).toContainText(words);
    await expect(sheet.getByRole('button', { name: 'Speak your reply' })).toBeVisible();
  });
}

test('Esc stops listening first; a second Esc closes, and what was said is kept as a draft', async ({ page }) => {
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Speak your reply' }).click();
  await sr(page, 'hear', 'kept for later', true);
  await page.keyboard.press('Escape');
  await expect(sheet.getByRole('button', { name: 'Speak your reply' })).toBeVisible();
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await page.locator('[data-reply=bob]').click();
  await expect(sheet.getByRole('textbox')).toHaveValue('Kept for later');
});

test('closing while it listens cuts the microphone at once', async ({ page }) => {
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Speak your reply' }).click();
  await sr(page, 'hear', 'half a sentence');
  await sheet.getByRole('button', { name: 'Close' }).click();
  expect((await ctl(page)).aborted).toBe(1);
  await expect.poll(() => ctl(page).then((c) => c.active)).toBe(false);
});

test('a long dictation: every word, once', async ({ page }) => {
  const sheet = page.getByRole('dialog'), box = sheet.getByRole('textbox');
  await sheet.getByRole('button', { name: 'Speak your reply' }).click();
  const words: string[] = [];
  for (let i = 0; i < 60; i++) { const w = `word${i}`; words.push(w); await sr(page, 'push', ` ${w}`, true); }
  await sr(page, 'end');
  await expect(box).toHaveValue(['Word0', ...words.slice(1)].join(' '));
});

test('Chrome on Android repeats earlier words in each result: said once (Pixel only)', async ({ page }, info) => {
  test.skip(info.project.name !== 'pixel', 'Android only');
  const box = page.getByRole('dialog').getByRole('textbox');
  await page.getByRole('button', { name: 'Speak your reply' }).click();
  await sr(page, 'push', 'hello', true);
  await sr(page, 'push', 'hello world', true);
  await sr(page, 'push', 'hello world how are you', true);
  await sr(page, 'end');
  await expect(box).toHaveValue('Hello world how are you');
});

test.describe('Brave: the speech API is there but nothing answers it (brave-browser#2802)', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => { Object.defineProperty(navigator, 'brave', { value: { isBrave: () => Promise.resolve(true) }, configurable: true }); });
  });
  test('no microphone that can only fail; it says to type, or use the keyboard\'s own mic', async ({ page }) => {
    await page.reload();
    await page.locator('[data-reply=bob]').click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('button', { name: 'Speak your reply' })).toHaveCount(0);
    await expect(sheet.getByRole('status')).toHaveText('This browser can’t take dictation: type, or use your keyboard’s mic');
  });
});

test.describe('a browser that can\'t take dictation', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => { for (const k of ['SpeechRecognition', 'webkitSpeechRecognition']) Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true }); });
  });
  test('no microphone button; it says to type, or use the keyboard\'s own mic', async ({ page }) => {
    await page.reload();
    await page.locator('[data-reply=bob]').click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('button', { name: 'Speak your reply' })).toHaveCount(0);
    await expect(sheet.getByRole('status')).toHaveText('This browser can’t take dictation: type, or use your keyboard’s mic');
    await expect(sheet).not.toContainText('Speech becomes text');
  });
});
