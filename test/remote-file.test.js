'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { loadService, waitFor, tempDir, preinstall, syntheticByte } = require('./harness');
const RemoteFile = require('../spike/remote-file.js');

const SERVICE = 'http://127.0.0.1:18780';
const SIZE = 1048576;
let svc, odd;
const seenRanges = [];

// A misbehaving server: /ok200 ignores Range, /hang never answers.
test.before(async () => {
  svc = loadService({ TH08_DATA_DIR: (() => { const d = tempDir(); preinstall(d); return d; })(), TH08_PORT: '18780' });
  await waitFor(() => svc.status.state === 'ready');
  odd = http.createServer((req, res) => {
    if (req.url === '/file/ok200') { res.writeHead(200, { 'Content-Length': 100 }); return res.end(Buffer.alloc(100)); }
    if (req.url === '/file/stall') {
      res.writeHead(206, { 'Content-Range': 'bytes 0-9/100', 'Content-Length': 10 });
      return res.write(Buffer.alloc(3)); // then silence
    }
    if (req.url === '/file/short') {
      res.writeHead(206, { 'Content-Range': 'bytes 0-9/100', 'Content-Length': 10 });
      res.write(Buffer.alloc(3));
      return setTimeout(() => res.socket.destroy(), 20);
    }
    if (req.url === '/file/badrange') {
      res.writeHead(206, { 'Content-Range': 'bytes 5-14/100', 'Content-Length': 10 });
      return res.end(Buffer.alloc(10));
    }
    if (req.url === '/file/echo') {
      seenRanges.push(req.headers.range);
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      const n = Number(m[2]) - Number(m[1]) + 1;
      res.writeHead(206, { 'Content-Range': `bytes ${m[1]}-${m[2]}/5000000000`, 'Content-Length': n });
      return res.end(Buffer.alloc(n));
    }
  });
  await new Promise((r) => odd.listen(18781, '127.0.0.1', r));
});
test.after(() => {
  if (svc) svc.onStop();
  if (odd) { odd.closeAllConnections(); odd.close(); }
});

test('slice reads exact bytes at a nonzero offset', async () => {
  const buf = await new RemoteFile(SERVICE, 'synthetic.bin', SIZE).slice(300000, 300000 + 65536).arrayBuffer();
  const bytes = new Uint8Array(buf);
  assert.equal(bytes.length, 65536);
  for (let i = 0; i < bytes.length; i++) assert.equal(bytes[i], syntheticByte(300000 + i));
});

test('slice past the end is clamped like File.slice; empty slices need no request', async () => {
  const f = new RemoteFile(SERVICE, 'synthetic.bin', SIZE);
  assert.equal((await f.slice(SIZE - 10, SIZE + 50).arrayBuffer()).byteLength, 10);
  assert.equal((await f.slice(SIZE, SIZE + 5).arrayBuffer()).byteLength, 0);
});

test('arrayBuffer reads the whole file', async () => {
  assert.equal((await new RemoteFile(SERVICE, 'synthetic.bin', SIZE).arrayBuffer()).byteLength, SIZE);
});

test('a missing file rejects with the HTTP status', async () => {
  await assert.rejects(new RemoteFile(SERVICE, 'missing.bin', SIZE).slice(0, 16).arrayBuffer(), /expected HTTP 206, got 404/);
});

test('a wrong size is caught by the Content-Range check', async () => {
  await assert.rejects(new RemoteFile(SERVICE, 'synthetic.bin', 2000000).slice(0, 16).arrayBuffer(),
    /expected Content-Range "bytes 0-15\/2000000", got "bytes 0-15\/1048576"/);
});

test('a 200 answer to a range request is refused', async () => {
  await assert.rejects(new RemoteFile('http://127.0.0.1:18781', 'ok200', 100).slice(0, 10).arrayBuffer(), /expected HTTP 206, got 200/);
});

test('a server that never answers rejects after timeoutMs', async () => {
  RemoteFile.timeoutMs = 200;
  try {
    await assert.rejects(new RemoteFile('http://127.0.0.1:18781', 'hang', 100).slice(0, 10).arrayBuffer(), /no answer after 200 ms/);
  } finally { RemoteFile.timeoutMs = 10000; }
});

const ODD = 'http://127.0.0.1:18781';

test('a body that stalls mid-way rejects after timeoutMs', async () => {
  RemoteFile.timeoutMs = 200;
  try {
    await assert.rejects(new RemoteFile(ODD, 'stall', 100).slice(0, 10).arrayBuffer(), /no answer after 200 ms/);
  } finally { RemoteFile.timeoutMs = 10000; }
});

test('a connection closed before the body completes rejects', async () => {
  await assert.rejects(new RemoteFile(ODD, 'short', 100).slice(0, 10).arrayBuffer());
});

test('a Content-Range for different bytes is refused', async () => {
  await assert.rejects(new RemoteFile(ODD, 'badrange', 100).slice(0, 10).arrayBuffer(), /expected Content-Range "bytes 0-9\/100"/);
});

test('offsets beyond 2^32 are sent exactly', async () => {
  seenRanges.length = 0;
  const buf = await new RemoteFile(ODD, 'echo', 5e9).slice(3e9, 3e9 + 16).arrayBuffer();
  assert.equal(buf.byteLength, 16);
  assert.deepEqual(seenRanges, ['bytes=3000000000-3000000015']);
});

test('whole-file arrayBuffer rejects on a wrong size or a missing file', async () => {
  await assert.rejects(new RemoteFile(SERVICE, 'synthetic.bin', 100).arrayBuffer(), /expected 100 bytes/);
  await assert.rejects(new RemoteFile(SERVICE, 'missing.bin', SIZE).arrayBuffer(), /expected HTTP 200, got 404/);
});

test('negative and NaN indices follow File.slice', async () => {
  const f = new RemoteFile(SERVICE, 'synthetic.bin', SIZE);
  const tail = new Uint8Array(await f.slice(-10).arrayBuffer());
  assert.equal(tail.length, 10);
  for (let i = 0; i < 10; i++) assert.equal(tail[i], syntheticByte(SIZE - 10 + i));
  assert.equal((await f.slice(0, -1048566).arrayBuffer()).byteLength, 10);
  assert.equal((await f.slice(0, NaN).arrayBuffer()).byteLength, 0);
});
