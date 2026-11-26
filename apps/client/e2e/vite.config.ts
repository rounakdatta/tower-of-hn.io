// Builds the test harnesses (e2e/harness: the reply sheet, the timeline) with the app's own stylesheet from index.html, so
// each looks and lays out exactly as in the app. Test-only: the app's build never sees it.
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: here('./harness'),
  // esnext, as the app builds (vite.config.ts): the CSS minifier's browser targets come from it, and what it does to a rule
  // (it drops one of a pair of prefixed and unprefixed declarations) is part of what ships, so it has to be part of what is tested
  build: { target: 'esnext', outDir: here('./.harness'), emptyOutDir: true, rollupOptions: { input: { index: here('./harness/index.html'), timeline: here('./harness/timeline.html') } } },
  logLevel: 'warn',
  plugins: [{
    name: 'app-style',
    transformIndexHtml: (html: string) => html.replace('<!-- app style -->', /<style>[\s\S]*?<\/style>/.exec(readFileSync(here('../index.html'), 'utf8'))![0]),
  }],
});
