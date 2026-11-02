'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { loadService, waitFor, tempDir, makeTarGz, syntheticByte, VERSION } = require('./harness');

const BUILD = makeTarGz({
  'th08-web.html': Buffer.from('<html>'),
  'th08-web.js': Buffer.from('// runtime'),
  'th08-web.wasm': Buffer.from([0, 97, 115, 109])
});
const BUILD_SHA = crypto.createHash('sha256').update(BUILD).digest('hex');
const ASSETS = ['spike.html', 'spike.js', 'remote-file.js', 'worker.js'];

// Serves /build.tar.gz (also via a redirect) and /spike/<asset>.
let fixture;
test.before(async () => {
  fixture = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/build.tar.gz' }); return res.end(); }
    if (req.url === '/broken302') { res.writeHead(302, { Location: '/build.tar.gz', 'Content-Length': 100 }); res.write('xxxxx'); return setTimeout(() => res.destroy(), 20); }
    if (req.url === '/broken404') { res.writeHead(404, { 'Content-Length': 100 }); res.write('xxxxx'); return setTimeout(() => res.destroy(), 20); }
    if (req.url === '/build.tar.gz') { res.writeHead(200); return res.end(BUILD); }
    const name = req.url.replace('/spike/', '');
    if (ASSETS.includes(name)) { res.writeHead(200); return res.end('asset ' + name); }
    if (req.url.indexOf('/empty/') === 0) { res.writeHead(200); return res.end(); }
    if (req.url.indexOf('/short/') === 0) { res.writeHead(200, { 'Content-Length': 100 }); res.write('0123456789'); return setTimeout(() => res.destroy(), 20); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => fixture.listen(18799, '127.0.0.1', r));
});
test.after(() => fixture.close());

function envFor(dataDir, port, overrides) {
  return Object.assign({
    TH08_DATA_DIR: dataDir, TH08_PORT: String(port),
    TH08_BUILD_URL: 'http://127.0.0.1:18799/redirect', TH08_BUILD_SHA256: BUILD_SHA,
    TH08_ASSET_BASE: 'http://127.0.0.1:18799/spike/'
  }, overrides);
}

test('installs build files, spike pages, synthetic file and version marker', async () => {
  const dataDir = tempDir();
  const svc = loadService(envFor(dataDir, 18791));
  try {
    await waitFor(() => svc.status.state === 'ready' || svc.status.state === 'error');
    assert.equal(svc.status.state, 'ready', svc.status.error);
    const dir = path.join(dataDir, 'th08', 'spike');
    assert.equal(fs.readFileSync(path.join(dir, 'th08-web.js'), 'utf8'), '// runtime');
    assert.deepEqual([...fs.readFileSync(path.join(dir, 'th08-web.wasm'))], [0, 97, 115, 109]);
    assert.ok(!fs.existsSync(path.join(dir, 'th08-web.html')), 'upstream launcher is not installed');
    for (const name of ASSETS) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'asset ' + name);
    const syn = fs.readFileSync(path.join(dir, 'synthetic.bin'));
    assert.equal(syn.length, 1048576);
    assert.equal(syn[300123], syntheticByte(300123));
    assert.equal(fs.readFileSync(path.join(dir, '.complete'), 'utf8'), VERSION);
  } finally { svc.onStop(); }
});

test('a missing file makes the service reinstall everything', async () => {
  const dataDir = tempDir();
  let svc = loadService(envFor(dataDir, 18788));
  try { await waitFor(() => svc.status.state === 'ready'); } finally { svc.onStop(); }
  const dir = path.join(dataDir, 'th08', 'spike');
  fs.unlinkSync(path.join(dir, 'worker.js'));
  fs.writeFileSync(path.join(dir, 'spike.js'), 'stale');
  svc = loadService(envFor(dataDir, 18789));
  try {
    await waitFor(() => svc.status.state === 'ready' || svc.status.state === 'error');
    assert.equal(svc.status.state, 'ready', svc.status.error);
    assert.equal(fs.readFileSync(path.join(dir, 'worker.js'), 'utf8'), 'asset worker.js');
    assert.equal(fs.readFileSync(path.join(dir, 'spike.js'), 'utf8'), 'asset spike.js');
    assert.ok(svc.status.log.some((l) => l.indexOf('download') >= 0), 'downloads again');
  } finally { svc.onStop(); }
});

test('an empty asset download fails the install instead of marking it complete', async () => {
  const dataDir = tempDir();
  const svc = loadService(envFor(dataDir, 18786, { TH08_ASSET_BASE: 'http://127.0.0.1:18799/empty/' }));
  try {
    await waitFor(() => svc.status.state === 'error');
    assert.match(svc.status.error, /empty download: http:\/\/127\.0\.0\.1:18799\/empty\/spike\.html/);
    assert.ok(!fs.existsSync(path.join(dataDir, 'th08', 'spike', '.complete')));
  } finally { svc.onStop(); }
});

test('a download cut short fails the install instead of marking it complete', async () => {
  const dataDir = tempDir();
  const svc = loadService(envFor(dataDir, 18785, { TH08_ASSET_BASE: 'http://127.0.0.1:18799/short/' }));
  try {
    await waitFor(() => svc.status.state === 'error');
    assert.match(svc.status.error, /cut short|got 10 of 100|aborted|socket hang up/);
    assert.ok(!fs.existsSync(path.join(dataDir, 'th08', 'spike', '.complete')));
  } finally { svc.onStop(); }
});

test('a redirect whose body is cut still follows the redirect', async () => {
  const svc = loadService(envFor(tempDir(), 18810, { TH08_BUILD_URL: 'http://127.0.0.1:18799/broken302' }));
  try {
    await waitFor(() => svc.status.state === 'ready');
  } finally { svc.onStop(); }
});

test('an error response that is cut fails cleanly and the service keeps answering', async () => {
  const svc = loadService(envFor(tempDir(), 18811, { TH08_BUILD_URL: 'http://127.0.0.1:18799/broken404' }));
  try {
    await waitFor(() => svc.status.state === 'error');
    assert.match(svc.status.error, /HTTP 404/);
    const r = await fetch('http://127.0.0.1:18811/status');
    assert.strictEqual(r.status, 200);
  } finally { svc.onStop(); }
});

test('Node older than 10.4 is refused with a clear error', async () => {
  const oldProcess = Object.create(process, { version: { value: 'v8.17.0' } });
  const svc = loadService(envFor(tempDir(), 18787), { process: oldProcess });
  try {
    await waitFor(() => svc.status.state === 'error');
    assert.match(svc.status.error, /Node v8\.17\.0 is older than the supported 10\.4/);
  } finally { svc.onStop(); }
});

test('a build with the wrong sha256 leaves the service in error and installs nothing', async () => {
  const dataDir = tempDir();
  const svc = loadService(envFor(dataDir, 18792, { TH08_BUILD_SHA256: '0'.repeat(64) }));
  try {
    await waitFor(() => svc.status.state === 'error');
    assert.match(svc.status.error, /sha256 mismatch/);
    assert.ok(!fs.existsSync(path.join(dataDir, 'th08', 'spike', '.complete')));
  } finally { svc.onStop(); }
});

test('an unreachable asset leaves the service in error', async () => {
  const dataDir = tempDir();
  const svc = loadService(envFor(dataDir, 18793, { TH08_ASSET_BASE: 'http://127.0.0.1:18799/nothing/' }));
  try {
    await waitFor(() => svc.status.state === 'error');
    assert.match(svc.status.error, /HTTP 404/);
  } finally { svc.onStop(); }
});

test('untar returns regular files by flat name', () => {
  const svc = loadService({ TH08_DATA_DIR: tempDir(), TH08_PORT: '18794' });
  try {
    const entries = svc._test.untar(require('node:zlib').gunzipSync(BUILD));
    assert.deepEqual(Object.keys(entries).sort(), ['th08-web.html', 'th08-web.js', 'th08-web.wasm']);
  } finally { svc.onStop(); }
});
