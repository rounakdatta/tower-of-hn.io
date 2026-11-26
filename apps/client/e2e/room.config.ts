// The room itself (three.js, WebGL in SwiftShader): Chromium only, on a desktop and a Pixel, against the room fixtures
// (e2e/room). Run from apps/client: `npm run e2e:room` (builds the app into e2e/room/.dist first). Slow by nature (a
// GPU-less renderer): the tests step the scene's clock by hand (?record&manual) and draw only what they look at.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /room.*\.spec\.ts$/,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  outputDir: './.results/room-artifacts',
  reporter: [['list'], ['json', { outputFile: './.results/room-results.json' }]],
  use: { baseURL: 'http://127.0.0.1:5298', trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 60_000,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info', '--js-flags=--expose-gc'] } },
  webServer: { command: 'node e2e/room/serve.mjs', url: 'http://127.0.0.1:5298/fx/n5/live/head.json', reuseExistingServer: !process.env.CI, cwd: '..', timeout: 180_000 },
  projects: [
    { name: 'room-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 } },
    { name: 'room-pixel', use: { ...devices['Pixel 7'], deviceScaleFactor: 1 } },
  ],
});
