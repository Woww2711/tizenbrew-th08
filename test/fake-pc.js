'use strict';
// A stand-in for pc/serve-th08-data.ps1 (same routes, token rule and manifest) with switches
// for the failures the service must survive. Options:
//   port, token, data ({ name: Buffer })
//   manifest   object served instead of the real manifest (may be changed between runs)
//   cut        { name: n }  the first n bodies of `name` stop half way (connection dropped)
//   corrupt    { name: n }  the first n bodies of `name` have their first byte flipped
//   slow       name         sent 64 KiB every 50 ms
//   stall      name         the first 1000 bytes, then silence (the connection stays open)
//   trickle    name         100 bytes every 20 ms, never idle long enough for the idle timeout
const http = require('node:http');
const { manifestOf } = require('./harness');

function startFakePc(opts) {
  const seen = [];      // "GET /route" of every request
  const closed = [];    // routes whose response was closed before it was complete
  const sockets = new Set();
  const cut = Object.assign({}, opts.cut), corrupt = Object.assign({}, opts.corrupt);
  const server = http.createServer((req, res) => {
    const [route, query] = req.url.split('?');
    seen.push(req.method + ' ' + route);
    res.on('close', () => { if (!res.writableFinished) closed.push(route); });
    const send = (code, type, text) => {
      const body = Buffer.from(text);
      res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length, Connection: 'close' });
      res.end(body);
    };
    const name = route.slice(1);
    if (req.method !== 'GET') return send(405, 'text/plain', 'GET only\n');
    if (route !== '/manifest.json' && !Object.hasOwn(opts.data, name)) return send(404, 'text/plain', 'not found\n');
    if (new URLSearchParams(query || '').get('t') !== opts.token) return send(403, 'text/plain', 'wrong token\n');
    if (route === '/manifest.json') {
      return send(200, 'application/json', JSON.stringify(opts.manifest || { files: manifestOf(opts.data) }));
    }
    let buf = opts.data[name];
    if (corrupt[name] > 0) { corrupt[name]--; buf = Buffer.from(buf); buf[0] ^= 0xff; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, Connection: 'close' });
    if (cut[name] > 0) {
      cut[name]--;
      res.write(buf.subarray(0, buf.length >> 1));
      return setTimeout(() => res.destroy(), 20);
    }
    if (opts.stall === name) return res.write(buf.subarray(0, 1000));
    if (opts.trickle === name) {
      let off = 0;
      const drip = () => { if (!res.destroyed && off < buf.length) { res.write(buf.subarray(off, off += 100)); setTimeout(drip, 20); } };
      return drip();
    }
    if (opts.slow === name) {
      let off = 0;
      const tick = () => {
        if (res.destroyed) return;
        res.write(buf.subarray(off, off += 65536));
        if (off < buf.length) setTimeout(tick, 50); else res.end();
      };
      return tick();
    }
    res.end(buf);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => server.listen(opts.port, '127.0.0.1', () => resolve({
    seen, closed, opts,
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(r));
    }
  })));
}

module.exports = { startFakePc };
