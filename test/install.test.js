'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { loadService, waitFor, tempDir, makeTarGz, VERSION, BUILD_FILES } = require('./harness');

const BUILD = makeTarGz({
  'th08-web.html': Buffer.from('<html>'),
  'th08-web.js': Buffer.from('// runtime'),
  'th08-web.wasm': Buffer.from([0, 97, 115, 109])
});
const BUILD_SHA = crypto.createHash('sha256').update(BUILD).digest('hex');
const LAUNCHER = ['launcher.html', 'saves.js', 'probe.js'];

// Serves /build.tar.gz (also via a redirect) and /launcher/<file>.
let fixture;
test.before(async () => {
  fixture = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/build.tar.gz' }); return res.end(); }
    if (req.url === '/broken302') { res.writeHead(302, { Location: '/build.tar.gz', 'Content-Length': 100 }); res.write('xxxxx'); return setTimeout(() => res.destroy(), 20); }
    if (req.url === '/broken404') { res.writeHead(404, { 'Content-Length': 100 }); res.write('xxxxx'); return setTimeout(() => res.destroy(), 20); }
    if (req.url === '/build.tar.gz') { res.writeHead(200); return res.end(BUILD); }
    const name = req.url.replace('/launcher/', '');
    if (LAUNCHER.includes(name)) { res.writeHead(200); return res.end('asset ' + name); }
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
    TH08_LAUNCHER_BASE: 'http://127.0.0.1:18799/launcher/'
  }, overrides);
}

// A whole build of `version` in <dataDir>/th08/<sub>, every file holding `tag`.
function fakeBuild(dataDir, sub, version, tag) {
  const dir = path.join(dataDir, 'th08', sub);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of BUILD_FILES) fs.writeFileSync(path.join(dir, name), tag + ' ' + name);
  fs.writeFileSync(path.join(dir, '.complete'), version);
  return dir;
}

function state(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'th08', 'state.json'), 'utf8'));
}

async function settled(svc) {
  await waitFor(() => svc.status.state === 'ready' || svc.status.state === 'error');
}

test('installs the runtime and launcher files into build/ through staging', async () => {
  const dataDir = tempDir();
  const svc = loadService(envFor(dataDir, 18791));
  try {
    await settled(svc);
    assert.equal(svc.status.state, 'ready', svc.status.error);
    const dir = path.join(dataDir, 'th08', 'build');
    assert.equal(svc.status.launcherUrl, 'file://' + path.join(dir, 'launcher.html'));
    assert.equal(fs.readFileSync(path.join(dir, 'th08-web.js'), 'utf8'), '// runtime');
    assert.deepEqual([...fs.readFileSync(path.join(dir, 'th08-web.wasm'))], [0, 97, 115, 109]);
    assert.ok(!fs.existsSync(path.join(dir, 'th08-web.html')), 'upstream launcher is not installed');
    for (const name of LAUNCHER) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'asset ' + name);
    assert.equal(fs.readFileSync(path.join(dir, '.complete'), 'utf8'), VERSION);
    assert.ok(!fs.existsSync(path.join(dataDir, 'th08', 'staging')), 'staging removed');
    assert.ok(!fs.existsSync(path.join(dataDir, 'th08', 'build.old')), 'build.old removed');
    assert.deepEqual(state(dataDir), { buildVersion: VERSION, buildReady: true, dataReady: false, files: [] });
  } finally { svc.onStop(); }
});

test('a complete build of this version is kept without downloading', async () => {
  const dataDir = tempDir();
  fakeBuild(dataDir, 'build', VERSION, 'kept');
  const svc = loadService(envFor(dataDir, 18788, { TH08_BUILD_URL: 'http://127.0.0.1:9/never' }));
  try {
    await settled(svc);
    assert.equal(svc.status.state, 'ready', svc.status.error);
    assert.ok(!svc.status.log.some((l) => l.indexOf('download') >= 0), 'no download');
    assert.equal(fs.readFileSync(path.join(dataDir, 'th08', 'build', 'probe.js'), 'utf8'), 'kept probe.js');
  } finally { svc.onStop(); }
});

test('an older build is replaced and state.json keeps fields it does not own', async () => {
  const dataDir = tempDir();
  fakeBuild(dataDir, 'build', '0.0.1-old', 'old');
  fs.writeFileSync(path.join(dataDir, 'th08', 'state.json'), JSON.stringify({ note: 'kept', buildReady: true }));
  const svc = loadService(envFor(dataDir, 18789));
  try {
    await settled(svc);
    assert.equal(svc.status.state, 'ready', svc.status.error);
    const dir = path.join(dataDir, 'th08', 'build');
    assert.equal(fs.readFileSync(path.join(dir, 'probe.js'), 'utf8'), 'asset probe.js');
    assert.equal(fs.readFileSync(path.join(dir, '.complete'), 'utf8'), VERSION);
    assert.deepEqual(state(dataDir), { note: 'kept', buildReady: true, buildVersion: VERSION, dataReady: false, files: [] });
  } finally { svc.onStop(); }
});

test('a failed install leaves the active build untouched and removes staging', async () => {
  const dataDir = tempDir();
  fakeBuild(dataDir, 'build', '0.0.1-old', 'old');
  const svc = loadService(envFor(dataDir, 18792, { TH08_BUILD_SHA256: '0'.repeat(64) }));
  try {
    await waitFor(() => svc.status.state === 'error');
    assert.match(svc.status.error, /sha256 mismatch/);
    assert.equal(fs.readFileSync(path.join(dataDir, 'th08', 'build', 'probe.js'), 'utf8'), 'old probe.js');
    assert.ok(!fs.existsSync(path.join(dataDir, 'th08', 'staging')));
    assert.deepEqual(state(dataDir), { buildVersion: '0.0.1-old', buildReady: false, dataReady: false, files: [] });
  } finally { svc.onStop(); }
});

test('an activation cut after build → build.old is undone at start', async () => {
  const dataDir = tempDir();
  fakeBuild(dataDir, 'build.old', VERSION, 'old');
  fakeBuild(dataDir, 'staging/build', VERSION, 'half');
  const svc = loadService(envFor(dataDir, 18786, { TH08_BUILD_URL: 'http://127.0.0.1:9/never' }));
  try {
    await settled(svc);
    assert.equal(svc.status.state, 'ready', svc.status.error);
    assert.equal(fs.readFileSync(path.join(dataDir, 'th08', 'build', 'probe.js'), 'utf8'), 'old probe.js');
    assert.ok(!fs.existsSync(path.join(dataDir, 'th08', 'build.old')));
    assert.ok(!fs.existsSync(path.join(dataDir, 'th08', 'staging')));
    assert.ok(svc.status.log.some((l) => /restored build\.old/.test(l)));
  } finally { svc.onStop(); }
});

test('an activation cut after staging/build → build keeps the new build', async () => {
  const dataDir = tempDir();
  fakeBuild(dataDir, 'build.old', '0.0.1-old', 'old');
  fakeBuild(dataDir, 'build', VERSION, 'new');
  const svc = loadService(envFor(dataDir, 18785, { TH08_BUILD_URL: 'http://127.0.0.1:9/never' }));
  try {
    await settled(svc);
    assert.equal(svc.status.state, 'ready', svc.status.error);
    assert.equal(fs.readFileSync(path.join(dataDir, 'th08', 'build', 'probe.js'), 'utf8'), 'new probe.js');
    assert.ok(!fs.existsSync(path.join(dataDir, 'th08', 'build.old')));
  } finally { svc.onStop(); }
});

test('an empty or cut launcher download fails the install', async () => {
  for (const [base, port, re] of [['empty', 18793, /empty download: http:\/\/127\.0\.0\.1:18799\/empty\/launcher\.html/],
    ['short', 18794, /cut short|got 10 of 100|aborted|socket hang up/], ['nothing', 18787, /HTTP 404/]]) {
    const dataDir = tempDir();
    const svc = loadService(envFor(dataDir, port, { TH08_LAUNCHER_BASE: `http://127.0.0.1:18799/${base}/` }));
    try {
      await waitFor(() => svc.status.state === 'error');
      assert.match(svc.status.error, re);
      assert.ok(!fs.existsSync(path.join(dataDir, 'th08', 'build')), base);
      assert.ok(!fs.existsSync(path.join(dataDir, 'th08', 'staging')), base);
    } finally { svc.onStop(); }
  }
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
  const svc = loadService(envFor(tempDir(), 18812), { process: oldProcess });
  try {
    await waitFor(() => svc.status.state === 'error');
    assert.match(svc.status.error, /Node v8\.17\.0 is older than the supported 10\.4/);
  } finally { svc.onStop(); }
});

test('untar returns regular files by flat name', () => {
  const svc = loadService({ TH08_DATA_DIR: tempDir(), TH08_PORT: '18813' });
  try {
    const entries = svc._test.untar(require('node:zlib').gunzipSync(BUILD));
    assert.deepEqual(Object.keys(entries).sort(), ['th08-web.html', 'th08-web.js', 'th08-web.wasm']);
  } finally { svc.onStop(); }
});
