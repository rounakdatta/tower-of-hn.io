// Contact sheet: what the director shows over time. Steps the scene deterministically and grabs a small frame
// every few seconds, with the camera's choice and the subtitle, then tiles them (tools/tile.py).
// usage: node tools/sheet.cjs <out dir> <url> [seconds at the table] [every] [WxH] [floor rank] [skip seconds first]
const { chromium } = require('/home/rounak/personal/Codeman/node_modules/playwright');
const fs = require('fs');
(async () => {
  const [out, url = 'http://127.0.0.1:5288/?record'] = process.argv.slice(2);
  const secs = Number(process.argv[4] || 30), every = Number(process.argv[5] || 1.5), rank = Number(process.argv[7] || 0), skip = Number(process.argv[8] || 0);
  const [W, H] = (process.argv[6] || '640x360').split('x').map(Number);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/home/rounak/.local/state/nix/profiles/home-manager/home-path/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
      '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  const fps = 24, step = async (s) => { for (let i = 0, n = Math.round(s * fps); i < n; i++) await page.evaluate((d) => window.__tohn.frame(d, false), 1 / fps); };
  await step(3);
  await page.evaluate((r) => window.__tohn.enter(r), rank);
  await page.waitForTimeout(2500);                                         // floor + sidecars load
  for (let i = 0; i < 3; i++) { await page.evaluate(() => window.__tohn.frame(1 / 24, true)); await page.waitForTimeout(400); }   // compile the room's shaders
  const meta = [];
  await step(skip);
  // REALTIME=1: never let scene time outrun the wall clock (the voice worker runs in real time)
  const t0 = Date.now(), v0 = await page.evaluate(() => window.__tohn.clock());
  const pace = async () => { if (!process.env.REALTIME) return; const ahead = (await page.evaluate(() => window.__tohn.clock())) - v0 - (Date.now() - t0) / 1000; if (ahead > 0) await page.waitForTimeout(ahead * 1000); };
  for (let t = 0, k = 0; t < secs; t += every, k++) {
    await step(every);
    await pace();
    await page.evaluate(() => window.__tohn.frame(1 / 24, true));
    await page.waitForTimeout(150);
    const info = await page.evaluate(() => ({ clock: window.__tohn.clock(), shot: window.__tohn.shot(), mode: window.__tohn.mode(), sub: (document.getElementById('subs')?.textContent || '').slice(0, 70), scene: window.__tohn.scene() }));
    const file = `${out}/s${String(k).padStart(3, '0')}.jpg`;
    await page.screenshot({ timeout: 120000, type: 'jpeg', quality: 85, path: file });
    meta.push({ file, ...info });
  }
  const timeline = await page.evaluate(() => window.__tohn.timeline());
  fs.writeFileSync(`${out}/sheet.json`, JSON.stringify({ meta, errs, timeline }, null, 1));
  console.log(JSON.stringify({ frames: meta.length, errs: errs.slice(0, 5) }));
  await browser.close();
})();
