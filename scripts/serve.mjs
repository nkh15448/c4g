#!/usr/bin/env node
// Serves dist/ for local testing. `npm run dev` builds first, then serves.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.PORT) || 4500;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

createServer((req, res) => {
  let file;
  try {
    file = resolve(DIST, `.${decodeURIComponent(new URL(req.url, 'http://x').pathname)}`);
  } catch {
    return res.writeHead(400).end();
  }
  if (file !== DIST && !file.startsWith(DIST + sep)) return res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    const { size } = statSync(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': size,
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => console.log(`Serving dist/ at http://localhost:${PORT}`));
