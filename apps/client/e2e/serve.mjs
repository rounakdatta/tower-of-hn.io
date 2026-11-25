// Serves the built harness on 127.0.0.1:5299 under the production Content-Security-Policy (read from towerd, so a
// change there is tested here too). Test-only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./.harness/', import.meta.url));
const towerd = readFileSync(fileURLToPath(new URL('../../towerd/src/main.ts', import.meta.url)), 'utf8');
const lit = /const CSP = ((?:"[^"]*"\s*\+?\s*)+);/.exec(towerd);
if (!lit) throw new Error('no CSP in towerd/src/main.ts');
const CSP = [...lit[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const port = Number(process.env.PORT ?? 5299);
createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, path.endsWith('/') ? `${path}index.html` : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404, { 'content-security-policy': CSP }); res.end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`harness on http://127.0.0.1:${port}  (CSP from towerd)`));
