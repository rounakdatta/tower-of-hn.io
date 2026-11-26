// Builds the test harnesses (e2e/harness: the reply sheet, the timeline) with the app's own stylesheet from index.html, so
// each looks and lays out exactly as in the app. Test-only: the app's build never sees it.
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: here('./harness'),
  // (Vite's default target, as the reply harness has always been built; the app builds esnext, which the CSS minifier reads
  // differently: with either, a prefixed and an unprefixed declaration in one rule lose one of the two, so scrubber.css keeps
  // them apart)
  build: { outDir: here('./.harness'), emptyOutDir: true, rollupOptions: { input: { index: here('./harness/index.html'), timeline: here('./harness/timeline.html') } } },
  logLevel: 'warn',
  plugins: [{
    name: 'app-style',
    transformIndexHtml: (html: string) => html.replace('<!-- app style -->', /<style>[\s\S]*?<\/style>/.exec(readFileSync(here('../index.html'), 'utf8'))![0]),
  }],
});
