// Record a demo of the real client with deterministic frames; the director's audio log is saved for muxing.
// usage: node tools/record.cjs <frames dir> <seconds at the table> [fps] [WxH]
const { chromium } = require('/home/rounak/personal/Codeman/node_modules/playwright');
const fs = require('fs');
(async () => {
  const out = process.argv[2], tableSecs = Number(process.argv[3] || 70), fps = Number(process.argv[4] || 20);
  const [W, H] = (process.argv[5] || '960x540').split('x').map(Number);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/home/rounak/.local/state/nix/profiles/home-manager/home-path/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
      '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto('http://127.0.0.1:5288/?record');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  const dt = 1 / fps;
  let f = 0;
  const shoot = async () => {
    await page.evaluate((d) => window.__tohn.frame(d, true), dt);
    await page.waitForTimeout(120);
    await page.screenshot({ timeout: 120000, type: 'jpeg', quality: 90, path: `${out}/f${String(f++).padStart(5, '0')}.jpg` });
  };
  for (let i = 0; i < 4 * fps; i++) await page.evaluate((d) => window.__tohn.frame(d, false), dt);   // let the tower settle
  const clock0 = await page.evaluate(() => window.__tohn.clock()) + dt;
  for (let i = 0; i < 6 * fps; i++) { await page.evaluate((a) => window.__tohn.orbit(a), 0.5 + i * 0.0035); await shoot(); }
  await page.evaluate(() => window.__tohn.enter(0));
  const n = Math.round((5 + tableSecs) * fps);
  for (let i = 0; i < n; i++) { await shoot(); if (i % 200 === 0) console.log('frame', f, await page.evaluate(() => window.__tohn.mode())); }
  const timeline = await page.evaluate(() => window.__tohn.timeline());
  fs.writeFileSync(`${out}/timeline.json`, JSON.stringify({ fps, clock0, timeline }));
  await browser.close();
  console.log('frames', f, 'clips', timeline.length);
})();
