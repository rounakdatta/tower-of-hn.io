// Builds the reply-sheet harness (e2e/harness) with the app's own stylesheet from index.html, so the sheet looks and
// lays out exactly as in the app. Test-only: the app's build never sees it.
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: here('./harness'),
  build: { outDir: here('./.harness'), emptyOutDir: true },
  logLevel: 'warn',
  plugins: [{
    name: 'app-style',
    transformIndexHtml: (html: string) => html.replace('<!-- app style -->', /<style>[\s\S]*?<\/style>/.exec(readFileSync(here('../index.html'), 'utf8'))![0]),
  }],
});
