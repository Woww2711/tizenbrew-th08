'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadService, waitFor, tempDir, preinstall, syntheticByte, VERSION } = require('./harness');

const BASE = 'http://127.0.0.1:18790';
let svc, dataDir;

test.before(async () => {
  dataDir = tempDir();
  preinstall(dataDir);
  svc = loadService({ TH08_DATA_DIR: dataDir, TH08_PORT: '18790' });
  await waitFor(() => svc.status.state === 'ready');
});
test.after(() => svc.onStop());

test('status reports the version, data dir and file:// launcher url', async () => {
  const s = await (await fetch(BASE + '/status')).json();
  assert.equal(s.version, VERSION);
  assert.equal(s.state, 'ready');
  assert.equal(s.dataDir, dataDir);
  assert.equal(s.launcherUrl, 'file://' + path.join(dataDir, 'th08', 'spike', 'spike.html'));
});

test('every response carries CORS and CORP headers; OPTIONS is a 204 preflight', async () => {
  const res = await fetch(BASE + '/report', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type, Range');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
});

test('POST /report stores the report with a timestamp', async () => {
  const res = await fetch(BASE + '/report', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'test', check: 'x', ok: true })
  });
  assert.equal(res.status, 204);
  const last = svc.status.reports[svc.status.reports.length - 1];
  assert.equal(last.source, 'test');
  assert.ok(last.at);
});

test('POST /report rejects invalid JSON and non-objects', async () => {
  for (const body of ['{', 'null', '[1]', '3']) {
    const res = await fetch(BASE + '/report', { method: 'POST', body });
    assert.equal(res.status, 400, body);
  }
});

test('a malformed percent escape in a file name answers 400 and the service keeps running', async () => {
  assert.equal((await fetch(BASE + '/file/%E0%A4%A')).status, 400);
  assert.equal((await fetch(BASE + '/status')).status, 200);
});

test('range read answers 206 with exact bytes and Content-Range', async () => {
  const res = await fetch(BASE + '/file/synthetic.bin', { headers: { Range: 'bytes=300000-300009' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 300000-300009/1048576');
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes], Array.from({ length: 10 }, (_, i) => syntheticByte(300000 + i)));
});

test('read without Range answers 200 with the whole file', async () => {
  const res = await fetch(BASE + '/file/synthetic.bin');
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, 1048576);
});

test('unsatisfiable range answers 416', async () => {
  const res = await fetch(BASE + '/file/synthetic.bin', { headers: { Range: 'bytes=2000000-' } });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), 'bytes */1048576');
});

test('names outside the allow-list answer 404', async () => {
  for (const name of ['missing.bin', '..%2Fspike.html', '.complete']) {
    assert.equal((await fetch(BASE + '/file/' + name)).status, 404, name);
  }
});

test('launchUrl returns the launcher url once ready and records the method', () => {
  assert.equal(svc.launchUrl(), svc.status.launcherUrl);
  assert.equal(svc.status.openMethod, 'launchUrl');
});

test('parseRange handles open-ended and clamped ranges', () => {
  const { parseRange } = svc._test;
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=90-200', 100), { start: 90, end: 99 });
  assert.equal(parseRange('bytes=5-1', 100), null);
  assert.equal(parseRange('bytes=-5', 100), null);
});
