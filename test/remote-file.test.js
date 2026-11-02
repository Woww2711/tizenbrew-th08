'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { loadService, waitFor, tempDir, preinstall, syntheticByte } = require('./harness');
const RemoteFile = require('../spike/remote-file.js');

const SERVICE = 'http://127.0.0.1:18780';
const SIZE = 1048576;
let svc, odd;

// A misbehaving server: /ok200 ignores Range, /hang never answers.
test.before(async () => {
  svc = loadService({ TH08_DATA_DIR: (() => { const d = tempDir(); preinstall(d); return d; })(), TH08_PORT: '18780' });
  await waitFor(() => svc.status.state === 'ready');
  odd = http.createServer((req, res) => {
    if (req.url === '/file/ok200') { res.writeHead(200, { 'Content-Length': 100 }); return res.end(Buffer.alloc(100)); }
  });
  await new Promise((r) => odd.listen(18781, '127.0.0.1', r));
});
test.after(() => { svc.onStop(); odd.closeAllConnections(); odd.close(); });

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
