// Record the e2e demo: orbit the live tower, fly into floor #1, sit at table 1
// while its people speak in their own voices. Frames are deterministic (fixed
// steps); the page's timeline is saved so mux.py can lay the real clips under them.
// usage: node record.cjs <frames dir> <seconds at the table>
const { chromium } = require('/home/rounak/personal/Codeman/node_modules/playwright');
const fs = require('fs');
(async () => {
  const out = process.argv[2], tableSecs = Number(process.argv[3] || 40);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/home/rounak/.local/state/nix/profiles/home-manager/home-path/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
      '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto('http://127.0.0.1:5179/?record');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  const fps = Number(process.env.FPS || 24), dt = 1 / fps;
  let f = 0;
  const shoot = async () => {
    await page.evaluate((d) => window.__frame(d), dt);
    await page.waitForTimeout(200);
    await page.screenshot({ timeout: 120000, type: 'jpeg', quality: 88, path: `${out}/f${String(f++).padStart(5, '0')}.jpg` });
  };
  for (let i = 0; i < 120; i++) await page.evaluate((d) => window.__frame(d, false), dt);
  const clock0 = await page.evaluate(() => window.__clock());
  for (let i = 0; i < 72; i++) { await page.evaluate((a) => window.__orbit(a), 0.55 + i * 0.008); await shoot(); }
  await page.evaluate(() => window.__enter(0));
  const n = Math.round((3.2 + tableSecs) * fps);
  for (let i = 0; i < n; i++) await shoot();
  const timeline = await page.evaluate(() => window.__timeline || []);
  fs.writeFileSync(`${out}/timeline.json`, JSON.stringify({ fps, clock0, timeline }));
  await browser.close();
  console.log('frames', f, 'cues', timeline.length);
})();
