// End-to-end tests of replying (the reply sheet, against a local mock of Hacker News): Chromium, Firefox and WebKit on
// desktops, plus an iPhone and a Pixel. Run from apps/client: `npm run e2e` (builds the harness first).
// Nothing reaches the real HN: the fixtures route its hosts to e2e/hn-mock.ts and drop every other outside request.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // one browser at a time here (the dev box shares a node with the cluster); CI's runners can take two
  workers: process.env.CI ? 2 : 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  outputDir: './.results/artifacts',
  reporter: [['list'], ['json', { outputFile: './.results/results.json' }]],
  use: { baseURL: 'http://127.0.0.1:5299', trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 20_000 },
  webServer: { command: 'node e2e/serve.mjs', url: 'http://127.0.0.1:5299/', reuseExistingServer: !process.env.CI, cwd: '..' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], permissions: ['clipboard-read', 'clipboard-write'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
    { name: 'pixel', use: { ...devices['Pixel 7'], permissions: ['clipboard-read', 'clipboard-write'] } },
  ],
});
