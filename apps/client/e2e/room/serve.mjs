// Serves the built app (e2e/room/.dist) with the room fixtures as its live data (e2e/room/.fx/<name>/live/, picked by
// the page's ?data=/fx/<name>/live/), on 127.0.0.1:5298, under towerd's own Content-Security-Policy. POST /want is
// answered as towerd answers it, and remembered: GET /__wants lists what the page asked for (and clears the list).
// Test-only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensure } from './fixtures.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const towerd = readFileSync(here('../../../towerd/src/main.ts'), 'utf8');
const lit = /const CSP = ((?:"[^"]*"\s*\+?\s*)+);/.exec(towerd);
if (!lit) throw new Error('no CSP in towerd/src/main.ts');
const CSP = [...lit[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ogg': 'audio/ogg', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };
ensure();
let wants = [];
const port = Number(process.env.PORT ?? 5298);
createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    try { wants.push({ at: Date.now(), ...JSON.parse(body) }); } catch { /* a want the server would refuse */ }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    return;
  }
  if (url.pathname === '/__wants') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(wants)); wants = []; return; }
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = path.startsWith('/fx/') ? join(here('.fx'), path.slice(4)) : join(here('.dist'), path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP, 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404, { 'content-security-policy': CSP }); res.end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`room on http://127.0.0.1:${port}  (CSP from towerd)`));
