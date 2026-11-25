// Replying, end to end, against the HN mock: open the sheet, write, hand it to HN's own reply page, sign in there if
// HN asks, paste, reply; back in the room the sheet finds the reply on HN's API and says so. And every way it can go
// wrong on the way, each with the words kept and a way on.
import { test, expect, ALICE, BOB, replyUrl, signedIn, copied, paste, hnLogin } from './fixtures.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

const TEXT = 'The borrow checker is not the reason it compiles; it is the reason it is *correct*. See https://doc.rust-lang.org/nomicon/ for the details.';
const shots = process.env.SHOTS;                         // a folder: key screens for the QA report
const shot = async (page: import('@playwright/test').Page, name: string) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/${test.info().project.name}-${name}.png` }); } };
const tally: Record<string, unknown>[] = [];
test.afterAll(({}, info) => { if (tally.length) { mkdirSync('e2e/.results', { recursive: true }); writeFileSync(`e2e/.results/taps-${info.project.name}.json`, JSON.stringify(tally, null, 1)); } });

test.beforeEach(async ({ page, mock }) => { void mock; await page.goto('/'); });

test('first reply, signed out on HN: sign in there, paste, reply; the sheet finds it and links to it', async ({ page, context, mock, browserName }) => {
  const t0 = Date.now(); let taps = 0;
  await page.getByRole('button', { name: 'Reply' }).first().click(); taps++;
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('#reply-to')).toHaveText('Reply to bob');
  await expect(sheet.locator('.quote')).toContainText('borrow checker is the reason this compiles');   // HN's own words
  await sheet.getByRole('textbox').fill(TEXT); taps++;
  await shot(page, '1-compose');
  const opened = context.waitForEvent('page');
  await sheet.getByRole('button', { name: /Continue on Hacker News/ }).click(); taps++;
  const hn = await opened;
  await hn.waitForLoadState();
  expect(hn.url()).toBe(replyUrl(BOB.id, BOB.story));
  expect(await copied(page)).toBe(TEXT);
  await expect(sheet.locator('#reply-to')).toHaveText('Over to Hacker News');
  await expect(sheet.getByRole('status')).toHaveText(/Watching for your reply/);
  await shot(page, '2-handed');
  await expect(hn.locator('body')).toContainText('You have to be logged in to comment.');
  await hnLogin(hn, 'not-the-password');                  // a wrong password first: HN's own page says so
  await expect(hn.locator('body')).toContainText('Bad login.');
  await hnLogin(hn); taps += 3;                           // name, password, login (a password manager makes it 1)
  await expect(hn.locator('textarea[name=text]')).toBeVisible();   // HN's goto: back to its reply form
  await paste(hn, page, browserName); taps += 2;          // tap the box, paste
  await hn.locator('input[type=submit][value=reply]').click(); taps++;
  await hn.waitForURL(/\/item\?id=46100000/);
  expect(mock.posts.map((p) => [p.user, p.parent, p.text])).toEqual([['alice', BOB.id, TEXT]]);
  await page.bringToFront(); taps++;
  await expect(sheet.locator('#reply-to')).toHaveText('Posted', { timeout: 20_000 });
  await expect(sheet.getByRole('link', { name: /See it on Hacker News/ })).toHaveAttribute('href', `https://news.ycombinator.com/item?id=${mock.posts[0].id}`);
  await expect(sheet).toContainText('as alice');          // learned from your own words, kept in this browser only
  await expect(sheet).toContainText('edit or delete it there for two hours');
  await shot(page, '3-posted');
  expect(await page.evaluate(() => localStorage.getItem('tohn-me'))).toBe('alice');
  expect(await page.evaluate(() => localStorage.getItem('tohn-drafts'))).toBe('{}');   // the draft is done with
  tally.push({ path: 'typed, signing in on HN first', taps, ms: Date.now() - t0 });
});

test('already signed in on HN (most readers): Reply, write, Continue, paste, reply', async ({ page, context, mock, browserName }) => {
  await signedIn(context, mock);
  const t0 = Date.now(); let taps = 0;
  await page.getByRole('button', { name: 'Reply' }).first().click(); taps++;
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('textbox').fill('Short and to the point.'); taps++;
  const opened = context.waitForEvent('page');
  await sheet.getByRole('button', { name: /Continue on Hacker News/ }).click(); taps++;
  const hn = await opened;
  await paste(hn, page, browserName); taps += 2;
  await hn.locator('input[type=submit][value=reply]').click(); taps++;
  await hn.waitForURL(/\/item\?id=/);
  await page.bringToFront(); taps++;
  await expect(sheet.locator('#reply-to')).toHaveText('Posted', { timeout: 20_000 });
  tally.push({ path: 'typed, already signed in on HN', taps, ms: Date.now() - t0 });
});

test('a draft survives closing, Esc, another reply, and a reload', async ({ page }) => {
  const sheet = page.getByRole('dialog');
  await page.locator('[data-reply=bob]').click();
  await sheet.getByRole('textbox').fill('Half a thought');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();
  await page.locator('[data-reply=carol]').click();
  await expect(sheet.getByRole('textbox')).toHaveValue('');                     // carol's own (empty) box
  await sheet.getByRole('textbox').fill('For carol');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('[data-reply=bob]').click();
  await expect(sheet.getByRole('textbox')).toHaveValue('Half a thought');
  await expect(sheet.getByRole('status')).toContainText('Your draft is back');
  await page.locator('[data-reply=carol]').click();
  await expect(sheet.getByRole('textbox')).toHaveValue('For carol');
});

test('a reply handed to HN survives a reload (a phone dropping the tab): the note comes when it lands', async ({ page, context, mock }) => {
  await signedIn(context, mock);
  await page.locator('[data-reply=bob]').click();
  await page.getByRole('dialog').getByRole('textbox').fill('Posted while this tab was gone.');
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: /Continue on Hacker News/ }).click();
  const hn = await opened;
  await page.reload();                                                           // the room is gone, the hand-off isn't
  await hn.locator('textarea[name=text]').fill('Posted while this tab was gone.');
  await hn.locator('input[type=submit][value=reply]').click();
  await page.bringToFront();
  await expect(page.locator('#toast')).toContainText('Your reply to bob is on Hacker News', { timeout: 20_000 });
});

test('your words, exactly: long text, emoji and other scripts are not cut or changed', async ({ page, context, mock }) => {
  await signedIn(context, mock);
  const long = `Привет 👋 你好, naïve café — ${'all of this stays. '.repeat(420)}The end.`;   // > 8,000 characters
  await page.locator('[data-reply=bob]').click();
  const box = page.getByRole('dialog').getByRole('textbox');
  await box.fill(long);
  await expect(box).toHaveValue(long);                                           // (the old box cut at 6,000)
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: /Continue on Hacker News/ }).click();
  await opened;
  expect(await copied(page)).toBe(long);
});

test('the preview shows what HN will make of it', async ({ page }) => {
  await page.locator('[data-reply=bob]').click();
  const sheet = page.getByRole('dialog');
  const peek = sheet.getByRole('button', { name: 'Preview' });
  await sheet.getByRole('textbox').fill('Plain words');
  await expect(peek).toBeHidden();                                               // nothing HN would format
  await sheet.getByRole('textbox').fill('This is *really* it:\n\n  let x = a < b;\n\nhttps://example.com/x.');
  await peek.click();
  const pre = sheet.locator('.preview');
  await expect(pre.locator('i')).toHaveText('really');
  await expect(pre.locator('pre code')).toHaveText('  let x = a < b;');
  await expect(pre.locator('a')).toHaveAttribute('href', 'https://example.com/x');
  await shot(page, '4-preview');
  await sheet.getByRole('button', { name: 'Edit' }).click();
  await expect(sheet.getByRole('textbox')).toBeVisible();
});

test('a double tap opens one HN tab', async ({ page, context }) => {
  await page.locator('[data-reply=bob]').click();
  await page.getByRole('dialog').getByRole('textbox').fill('Once.');
  let tabs = 0;
  context.on('page', () => tabs++);
  await page.getByRole('button', { name: /Continue on Hacker News/ }).dblclick();
  await expect(page.locator('#reply-to')).toHaveText('Over to Hacker News');
  await page.waitForTimeout(800);
  expect(tabs).toBe(1);
});

test('offline: nothing opens, the words are kept, and it goes once you are back', async ({ page, context }) => {
  await page.locator('[data-reply=bob]').click();
  await page.getByRole('dialog').getByRole('textbox').fill('Written on a train.');
  await context.setOffline(true);
  let tabs = 0;
  context.on('page', () => tabs++);
  await page.getByRole('button', { name: /Continue on Hacker News/ }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('You’re offline');
  expect(tabs).toBe(0);
  await context.setOffline(false);
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: /Continue on Hacker News/ }).click();
  await opened;
});

test('a slow HN API never holds up writing; the sheet opens at once', async ({ page, mock }) => {
  mock.mode.slowMs = 4000;
  const t = Date.now();
  await page.locator('[data-reply=bob]').click();
  await expect(page.getByRole('dialog').getByRole('textbox')).toBeEditable();
  expect(Date.now() - t).toBeLessThan(2500);
  await expect(page.locator('.quote')).toContainText('borrow checker', { timeout: 15_000 });
});

test('HN says "posting too fast": your words stay, and the sheet says it hasn\'t seen it', async ({ page, context, mock }) => {
  await signedIn(context, mock);
  await page.clock.install();
  mock.mode.tooFastMs = 600_000;
  await page.locator('[data-reply=carol]').click();
  await page.getByRole('dialog').getByRole('textbox').fill('An earlier one.');
  let opened = context.waitForEvent('page');
  await page.getByRole('button', { name: /Continue on Hacker News/ }).click();
  let hn = await opened;
  await hn.locator('textarea[name=text]').fill('An earlier one.');
  await hn.locator('input[type=submit][value=reply]').click();
  await hn.waitForURL(/item/);
  await hn.close();
  await page.locator('[data-reply=bob]').click();
  await page.getByRole('dialog').getByRole('textbox').fill('Too soon after the last one.');
  opened = context.waitForEvent('page');
  await page.getByRole('button', { name: /Continue on Hacker News/ }).click();
  hn = await opened;
  await hn.locator('textarea[name=text]').fill('Too soon after the last one.');
  await hn.locator('input[type=submit][value=reply]').click();
  await expect(hn.locator('body')).toContainText("You're posting too fast. Please slow down. Thanks.");
  await page.bringToFront();
  await page.clock.fastForward('10:30');
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Not seen on Hacker News yet', { timeout: 20_000 });
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue('Too soon after the last one.');
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue('Too soon after the last one.');
});

test('HN asks to confirm (commconfirm): reply once more there, and it lands', async ({ page, context, mock }) => {
  await signedIn(context, mock);
  mock.mode.confirmNext = true;
  await page.locator('[data-reply=bob]').click();
  await page.getByRole('dialog').getByRole('textbox').fill('Confirmed, eventually.');
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: /Continue on Hacker News/ }).click();
  const hn = await opened;
  await hn.locator('textarea[name=text]').fill('Confirmed, eventually.');
  await hn.locator('input[type=submit][value=reply]').click();
  await expect(hn.locator('body')).toContainText('Please confirm that this is your comment');
  await expect(hn.locator('textarea[name=text]')).toHaveValue('Confirmed, eventually.');
  await hn.locator('input[type=submit][value=reply]').click();
  await page.bringToFront();
  await expect(page.locator('#reply-to')).toHaveText('Posted', { timeout: 20_000 });
  expect(mock.posts).toHaveLength(1);
});

test('an expired form, a captcha, or HN being down: HN\'s page says so; the words wait here', async ({ page, context, mock }) => {
  await signedIn(context, mock);
  await page.locator('[data-reply=bob]').click();
  await page.getByRole('dialog').getByRole('textbox').fill('Patient words.');
  mock.mode.hmacTtlMs = 0;                                                     // the form's token expires at once
  let opened = context.waitForEvent('page');
  await page.getByRole('button', { name: /Continue on Hacker News/ }).click();
  let hn = await opened;
  await hn.locator('textarea[name=text]').fill('Patient words.');
  await hn.locator('input[type=submit][value=reply]').click();
  await expect(hn.locator('body')).toHaveText('Unknown or expired link.');
  await hn.close();
  await page.bringToFront();
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue('Patient words.');
  await expect(page.getByRole('link', { name: /Open it again/ })).toHaveAttribute('href', replyUrl(BOB.id, BOB.story));
  await context.clearCookies();
  mock.mode.hmacTtlMs = 1_800_000; mock.mode.captchaLogin = true;            // signing in again meets a captcha
  opened = context.waitForEvent('page');
  await page.getByRole('link', { name: /Open it again/ }).click();
  hn = await opened;
  await hnLogin(hn);
  await expect(hn.locator('body')).toContainText('Validation required.');
  await hn.close();
  mock.mode.captchaLogin = false; mock.mode.siteDown = true;
  opened = context.waitForEvent('page');
  await page.getByRole('link', { name: /Open it again/ }).click();
  hn = await opened;
  await expect(hn.locator('body')).toHaveText('Sorry.');
  await page.bringToFront();
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue('Patient words.');
  await page.getByRole('button', { name: 'Copy again' }).click();
  expect(await copied(page)).toBe('Patient words.');
});

test('HN\'s API down: the sheet still opens, and finds your reply once the API is back', async ({ page, context, mock }) => {
  await signedIn(context, mock);
  mock.mode.apiDown = true;
  await page.locator('[data-reply=bob]').click();
  await page.getByRole('dialog').getByRole('textbox').fill('Through an outage.');
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: /Continue on Hacker News/ }).click();
  const hn = await opened;
  await hn.locator('textarea[name=text]').fill('Through an outage.');
  await hn.locator('input[type=submit][value=reply]').click();
  await page.bringToFront();
  await page.waitForTimeout(6000);
  await expect(page.locator('#reply-to')).toHaveText('Over to Hacker News');
  mock.mode.apiDown = false;
  await expect(page.locator('#reply-to')).toHaveText('Posted', { timeout: 20_000 });
});

test('a deleted comment, or a thread HN has closed, says so before you write', async ({ page }) => {
  await page.locator('[data-reply=gone]').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('status')).toContainText('That comment was deleted');
  await sheet.getByRole('textbox').fill('Too late.');
  await expect(sheet.getByRole('button', { name: /Continue on Hacker News/ })).toBeDisabled();
  await page.locator('[data-reply=dave]').click();
  await expect(sheet.getByRole('status')).toContainText('This thread is closed');
  await expect(sheet.getByRole('button', { name: /Continue on Hacker News/ })).toBeDisabled();
});

test('a reply from someone else under the same comment is never taken for yours', async ({ page, context, mock }) => {
  await signedIn(context, mock);
  await page.locator('[data-reply=bob]').click();
  await page.getByRole('dialog').getByRole('textbox').fill('My own careful words about lifetimes and borrowing here.');
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: /Continue on Hacker News/ }).click();
  const hn = await opened;
  await hn.close();                                                              // you didn't post, but someone did
  await mock.handle({ method: 'POST', url: 'https://news.ycombinator.com/comment', headers: {}, body: new URLSearchParams({ acct: 'carol', pw: 'x', parent: String(BOB.id), text: 'Something else entirely about compilers.' }).toString() });
  await page.waitForTimeout(12_000);
  await expect(page.locator('#reply-to')).toHaveText('Over to Hacker News');
  expect(await page.evaluate(() => localStorage.getItem('tohn-me'))).toBeNull();
});

test('signing in as someone the sheet doesn\'t know: "as alice" is learned; "Forget it" forgets', async ({ page, context, mock }) => {
  await signedIn(context, mock);
  await page.locator('[data-reply=bob]').click();
  await page.getByRole('dialog').getByRole('textbox').fill('Five words make a match.');
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: /Continue on Hacker News/ }).click();
  const hn = await opened;
  await hn.locator('textarea[name=text]').fill('Five words make a match!');                      // fixed on HN
  await hn.locator('input[type=submit][value=reply]').click();
  await page.bringToFront();
  await expect(page.locator('#reply-to')).toHaveText('Posted', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Forget it' }).click();
  expect(await page.evaluate(() => localStorage.getItem('tohn-me'))).toBeNull();
});
