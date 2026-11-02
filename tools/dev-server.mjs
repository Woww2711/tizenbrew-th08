// Static server for trying pages in a desktop browser: serves <dir> on 127.0.0.1:<port>
// with COOP/COEP so the page is cross-origin isolated like a file:// page on the TV.
// Usage: node tools/dev-server.mjs <dir> <port>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const [dir, port] = [process.argv[2], Number(process.argv[3])];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm' };

createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  let rel;
  try {
    rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  try {
    const body = await readFile(join(dir, rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`serving ${dir} on http://127.0.0.1:${port}/`));
