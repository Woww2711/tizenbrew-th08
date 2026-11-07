'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { loadService, waitFor, tempDir, preinstall, VERSION } = require('./harness');

function ready(port, extra) {
  const dataDir = tempDir();
  preinstall(dataDir);
  return loadService(Object.assign({ TH08_DATA_DIR: dataDir, TH08_PORT: String(port),
    TH08_TAKEOVER_DELAY_MS: '50', TH08_BLOCKED_RETRY_MS: '200' }, extra));
}

test('POST /shutdown answers 202 with the version, then frees the port', async () => {
  const svc = ready(18820);
  try {
    await waitFor(() => svc.status.state === 'ready');
    const res = await fetch('http://127.0.0.1:18820/shutdown', { method: 'POST', body: '{}' });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { version: VERSION, stopping: true });
    await waitFor(() => svc.status.state === 'stopped');
    await assert.rejects(fetch('http://127.0.0.1:18820/status'));
  } finally { svc.onStop(); }
});

test('a newer service takes the port from a running one that has /shutdown', async () => {
  const oldSvc = ready(18821);
  let newSvc;
  try {
    await waitFor(() => oldSvc.status.state === 'ready');
    newSvc = ready(18821);
    await waitFor(() => newSvc.status.state === 'ready' || newSvc.status.state === 'blocked');
    assert.equal(newSvc.status.state, 'ready', newSvc.status.error);
    assert.equal(oldSvc.status.state, 'stopped');
    assert.equal(newSvc.status.takeover.from, VERSION);
    assert.equal(newSvc.status.takeover.result, 'stopped');
    const s = await (await fetch('http://127.0.0.1:18821/status')).json();
    assert.equal(s.startedAt, newSvc.status.startedAt);
  } finally { oldSvc.onStop(); if (newSvc) newSvc.onStop(); }
});

// Like 0.0.1: answers /status and /report, but has no /shutdown.
function fakeOldService(port) {
  const reports = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ version: '0.0.1', state: 'ready' }));
      }
      if (req.method === 'POST' && req.url === '/report') { reports.push(JSON.parse(body)); res.writeHead(204); return res.end(); }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return { server, reports, listen: () => new Promise((r) => server.listen(port, '127.0.0.1', r)) };
}

test('an old service without /shutdown leaves the new one blocked, told and retrying', async () => {
  const old = fakeOldService(18822);
  await old.listen();
  const svc = ready(18822);
  try {
    await waitFor(() => svc.status.state === 'blocked' && old.reports.length > 0);
    assert.match(svc.status.error, /port 18822 is held by service 0\.0\.1 \(\/shutdown answered HTTP 404\); unplug the TV/);
    assert.equal(svc.status.takeover.from, '0.0.1');
    assert.equal(svc.status.dataDir, null, 'nothing installed while blocked');
    assert.equal(old.reports[0].source, 'service');
    assert.equal(old.reports[0].version, VERSION);
    assert.equal(old.reports[0].message, svc.status.error);
    old.server.closeAllConnections();
    old.server.close();
    await waitFor(() => svc.status.state === 'ready', 3000);
    assert.match(svc.status.takeover.result, /^\/shutdown answered HTTP 404; port free at /);
    assert.equal(svc.status.error, null);
  } finally { svc.onStop(); old.server.close(); }
});

test('a port held by a program that does not speak HTTP leaves the service blocked', async () => {
  const other = net.createServer((sock) => sock.destroy());
  await new Promise((r) => other.listen(18823, '127.0.0.1', r));
  const svc = ready(18823);
  try {
    await waitFor(() => svc.status.state === 'blocked');
    assert.equal(svc.status.takeover.from, null);
    assert.match(svc.status.error, /held by another program \(no answer to \/shutdown\)/);
  } finally { svc.onStop(); other.close(); }
});

test('onStop during the takeover sends no /shutdown and never listens later', async () => {
  const seen = [];
  const old = http.createServer((req, res) => {
    seen.push(req.method + ' ' + req.url);
    const answer = () => {
      res.writeHead(req.url === '/status' ? 200 : 202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.0.9-old' }));
    };
    if (req.url === '/status') setTimeout(answer, 200); else answer();
  });
  await new Promise((r) => old.listen(18824, '127.0.0.1', r));
  const svc = ready(18824);
  try {
    await waitFor(() => seen.length === 1);
    svc.onStop();
    await new Promise((r) => setTimeout(r, 400));          // /status answers at 200 ms
    assert.deepEqual(seen, ['GET /status']);
    old.closeAllConnections();
    old.close();
    await new Promise((r) => setTimeout(r, 400));          // longer than the retry delays
    assert.equal(svc.status.state, 'stopped');
    await assert.rejects(fetch('http://127.0.0.1:18824/status'), 'nothing listens on the port');
  } finally { svc.onStop(); old.close(); }
});
