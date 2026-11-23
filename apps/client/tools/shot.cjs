// Cheap vibe test: render a few moments of the real client headlessly (software WebGPU) and screenshot them.
// usage: node tools/shot.cjs <out dir> [url]
const { chromium } = require('/home/rounak/personal/Codeman/node_modules/playwright');
(async () => {
  const out = process.argv[2] || '/tmp/tohn/shots';
  const url = process.argv[3] || 'http://127.0.0.1:5288/?record';
  require('fs').mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/home/rounak/.local/state/nix/profiles/home-manager/home-path/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
      '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text().slice(0, 300)); });
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message.slice(0, 300)));
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 }).catch((e) => { console.log('WAIT FAILED', String(e).slice(0, 300)); });
  console.log('STATE', JSON.stringify(await page.evaluate(() => ({ ready: window.__ready, tohn: typeof window.__tohn, keys: Object.keys(window.__tohn || {}) }))), logs.slice(0, 5));
  const step = async (secs, draw = false) => {
    const n = Math.round(secs * 24);
    for (let i = 0; i < n; i++) await page.evaluate(([d, dr]) => window.__tohn.frame(d, dr), [1 / 24, draw && i === n - 1]);
  };
  const snap = async (name) => { await page.waitForTimeout(1200); await page.screenshot({ timeout: 120000, path: `${out}/${name}.png` }); };
  await step(4);
  await page.evaluate(() => window.__tohn.orbit(0.7, 105, 44));
  await step(1 / 24, true); await snap('1-tower');
  await page.evaluate(() => window.__tohn.enter(0));
  await page.waitForTimeout(1500);
  await step(3.2, true); await snap('2-arriving');
  await page.waitForTimeout(2500);                     // let sidecars load
  await step(3, true); await snap('3-table-wide');
  await page.waitForTimeout(1500);
  await step(5, true); await snap('4-speaking');
  await step(6, true); await snap('5-later');
  const info = await page.evaluate(() => ({ mode: window.__tohn.mode(), timeline: window.__tohn.timeline().length, subs: document.getElementById('subs').textContent.slice(0, 160) }));
  console.log(JSON.stringify({ info, logs: logs.slice(0, 15) }, null, 1));
  await browser.close();
})();
