'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const { loadService, waitFor, tempDir, preinstall } = require('./harness');

const MODULE_PAGE = 'http://127.0.0.1:8081/module/gh%2FWoww2711%2Ftizenbrew-th08/app/index.html';

function textFrame(obj) {
  const p = Buffer.from(JSON.stringify(obj));
  return Buffer.concat([Buffer.from([0x81, p.length]), p]);
}

// A fake DevTools endpoint: /json/list plus a WebSocket. `mode` decides how it answers the
// first CDP call: 'ok' (an event first, then the reply split over two writes), 'navError',
// 'close' (drops the connection) or 'stall' (never answers).
function fakeDevtools(port, pageUrl, mode) {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.url !== '/json/list') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { type: 'service_worker', url: 'http://x/tizenbrew-th08', webSocketDebuggerUrl: 'ws://127.0.0.1:1/x' },
      { type: 'page', url: pageUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }
    ]));
  });
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('error', () => {});
    socket.once('data', (buf) => {
      let n = buf[1] & 0x7f, off = 2;
      if (n === 126) { n = buf.readUInt16BE(2); off = 4; }
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + n));
      for (let i = 0; i < n; i++) payload[i] ^= mask[i % 4];
      const msg = JSON.parse(payload.toString());
      calls.push(msg);
      if (mode === 'close') return socket.destroy();
      if (mode === 'stall') return;
      if (mode === 'navError') return socket.write(textFrame({ id: msg.id, result: { errorText: 'net::ERR_ACCESS_DENIED' } }));
      const reply = textFrame({ id: msg.id, result: { frameId: 'f1' } });
      socket.write(textFrame({ method: 'Page.frameStartedLoading', params: { frameId: 'f1' } }));
      socket.write(reply.subarray(0, 5));
      setTimeout(() => socket.write(reply.subarray(5)), 20);
    });
  });
  return { server, calls, listen: () => new Promise((r) => server.listen(port, '127.0.0.1', r)) };
}

// Starts a preinstalled service wired to a fake DevTools in `mode`, then POSTs /open.
async function openWith(mode, servicePort, devtoolsPort, pageUrl) {
  const dt = fakeDevtools(devtoolsPort, pageUrl || MODULE_PAGE, mode);
  await dt.listen();
  const dataDir = tempDir();
  preinstall(dataDir);
  const svc = loadService({ TH08_DATA_DIR: dataDir, TH08_PORT: String(servicePort),
    TH08_DEVTOOLS_PORTS: String(devtoolsPort), TH08_CDP_TIMEOUT_MS: '300' });
  try {
    await waitFor(() => svc.status.state === 'ready');
    const res = await fetch(`http://127.0.0.1:${servicePort}/open`, { method: 'POST' });
    assert.equal(res.status, 202);
    await waitFor(() => svc.status.openMethod === 'devtools' || svc.status.openError);
    return { svc, dt, stop: () => { svc.onStop(); dt.server.close(); } };
  } catch (e) { svc.onStop(); dt.server.close(); throw e; }
}

test('POST /open navigates the module page to the launcher url via DevTools', async () => {
  const { svc, dt, stop } = await openWith('ok', 18801, 18890);
  try {
    assert.equal(svc.status.openError, null);
    assert.equal(svc.status.openMethod, 'devtools');
    assert.equal(dt.calls.length, 1);
    assert.equal(dt.calls[0].method, 'Page.navigate');
    assert.deepEqual(dt.calls[0].params, { url: svc.status.launcherUrl });
  } finally { stop(); }
});

test('a navigation error from DevTools is reported on status', async () => {
  const { svc, stop } = await openWith('navError', 18802, 18891);
  try { assert.match(svc.status.openError, /Page\.navigate: net::ERR_ACCESS_DENIED/); } finally { stop(); }
});

test('a dropped DevTools connection is reported on status', async () => {
  const { svc, stop } = await openWith('close', 18803, 18892);
  try { assert.match(svc.status.openError, /DevTools closed the connection/); } finally { stop(); }
});

test('a DevTools that never answers times out', async () => {
  const { svc, stop } = await openWith('stall', 18804, 18893);
  try { assert.match(svc.status.openError, /no answer from DevTools after 300 ms/); } finally { stop(); }
});

test('without a matching page the open error is reported on status', async () => {
  const { svc, dt, stop } = await openWith('ok', 18805, 18894, 'http://127.0.0.1:8081/other/index.html');
  try {
    assert.match(svc.status.openError, /module page not found/);
    assert.equal(dt.calls.length, 0);
  } finally { stop(); }
});

test('POST /open before the launcher is installed answers 409', async () => {
  const svc = loadService({ TH08_DATA_DIR: tempDir(), TH08_PORT: '18806',
    TH08_BUILD_URL: 'http://127.0.0.1:9/never', TH08_DEVTOOLS_PORTS: '18895' });
  try {
    await waitFor(() => svc.status.state !== 'starting');
    const res = await fetch('http://127.0.0.1:18806/open', { method: 'POST' });
    assert.equal(res.status, 409);
  } finally { svc.onStop(); }
});

test('a slow or broken port does not stall the DevTools search', async () => {
  const slow = http.createServer((req, res) => {
    res.writeHead(200);
    const iv = setInterval(() => res.write('['), 100);
    res.on('close', () => clearInterval(iv));
    slow.ivs.push(iv);
  });
  slow.ivs = [];
  const broken = http.createServer((req) => { req.socket.destroy(); });
  await new Promise((r) => slow.listen(18896, '127.0.0.1', r));
  await new Promise((r) => broken.listen(18897, '127.0.0.1', r));
  const dt = fakeDevtools(18898, MODULE_PAGE, 'ok');
  await dt.listen();
  const dataDir = tempDir();
  preinstall(dataDir);
  const svc = loadService({ TH08_DATA_DIR: dataDir, TH08_PORT: '18807',
    TH08_DEVTOOLS_PORTS: '18896,18897,18898', TH08_CDP_TIMEOUT_MS: '300' });
  try {
    await waitFor(() => svc.status.state === 'ready');
    const res = await fetch('http://127.0.0.1:18807/open', { method: 'POST' });
    assert.equal(res.status, 202);
    await waitFor(() => svc.status.openMethod === 'devtools' || svc.status.openError, 5000);
    assert.equal(svc.status.openMethod, 'devtools');
    assert.equal(svc.status.openError, null);
  } finally {
    svc.onStop();
    dt.server.close();
    slow.ivs.forEach(clearInterval);
    slow.close();
    broken.close();
  }
});
