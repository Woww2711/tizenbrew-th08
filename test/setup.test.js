'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadService, waitFor, tempDir, preinstall, syntheticData, manifestOf } = require('./harness');
const { startFakePc } = require('./fake-pc');

const TOKEN = '12345678';
// Another data set than syntheticData(), for replacing an active one.
const NEW_DATA = { 'th08.dat': Buffer.alloc(3000, 1), 'thbgm.dat': Buffer.alloc(700000, 2) };

// Every env value the setup reads is set each time: process.env is shared by the file.
// `globals` replaces sandbox globals (e.g. a `require` handing out a different fs).
function start(port, { data = false, env = {}, globals } = {}) {
  const dataDir = tempDir();
  preinstall(dataDir, { data });
  const svc = loadService(Object.assign({ TH08_DATA_DIR: dataDir, TH08_PORT: String(port),
    TH08_DATA_RESERVE: '', TH08_SETUP_RETRY_MS: '50', TH08_SETUP_IDLE_MS: '', TH08_SETUP_FLOOR_MS: '',
    TH08_SETUP_MIN_RATE: '' }, env), globals);
  return { svc, dataDir, root: path.join(dataDir, 'th08'), base: 'http://127.0.0.1:' + port };
}

function postSetup(base, body) {
  return fetch(base + '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function setupTo(t, pcPort, token = TOKEN) {
  await waitFor(() => t.svc.status.state === 'ready');
  const res = await postSetup(t.base, { ip: '127.0.0.1', port: pcPort, token });
  assert.equal(res.status, 202, await res.text());
  await waitFor(() => t.svc.status.setup.state !== 'running', 10000);
  return t.svc.status.setup;
}

const routes = (pc, route) => pc.seen.filter((r) => r === 'GET ' + route).length;

test('POST /setup copies both files, verifies them and activates the set', async () => {
  const pc = await startFakePc({ port: 18850, token: TOKEN, data: syntheticData() });
  const t = start(18836);
  try {
    const s = await setupTo(t, 18850);
    assert.equal(s.state, 'done', JSON.stringify(s.error));
    assert.deepEqual(s.files.map((f) => [f.name, f.got, f.phase, f.attempt]),
      [['th08.dat', 4096, 'done', 1], ['thbgm.dat', 1048576, 'done', 1]]);
    for (const [name, buf] of Object.entries(syntheticData())) {
      assert.ok(fs.readFileSync(path.join(t.root, 'retail', name)).equals(buf), name);
    }
    assert.ok(!fs.existsSync(path.join(t.root, 'staging')), 'staging removed');
    const st = await (await fetch(t.base + '/status')).json();
    assert.deepEqual([st.ready, st.dataReady], [true, true]);
    assert.deepEqual(st.files, manifestOf(syntheticData()));
    assert.ok(!JSON.stringify(st).includes(TOKEN), 'the token is never shown on /status');
  } finally { t.svc.onStop(); await pc.close(); }
});

test('bad input answers 400 and starts nothing; a setup before the build is ready answers 409', async () => {
  const t = start(18837);
  try {
    await waitFor(() => t.svc.status.state === 'ready');
    for (const body of ['not json', '[1]', {}, { ip: '1.2.3', port: 8765, token: TOKEN },
      { ip: '256.1.1.1', port: 8765, token: TOKEN }, { ip: '192.168.1.10', port: 0, token: TOKEN },
      { ip: '192.168.1.10', port: 'x', token: TOKEN }, { ip: '192.168.1.10', port: 8765, token: 'ab' },
      { ip: '192.168.1.10', port: 8765, token: 'ab cd' }]) {
      assert.equal((await postSetup(t.base, body)).status, 400, JSON.stringify(body));
    }
    assert.equal(t.svc.status.setup, null);
  } finally { t.svc.onStop(); }
  const broken = start(18838, { env: { TH08_BUILD_URL: 'http://127.0.0.1:9/never' } });
  fs.rmSync(path.join(broken.root, 'build'), { recursive: true });
  try {
    await waitFor(() => broken.svc.status.state === 'error');
    const res = await postSetup(broken.base, { ip: '127.0.0.1', port: 18851, token: TOKEN });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'not-ready');
  } finally { broken.svc.onStop(); }
});

test('a second POST /setup while one runs answers 409', async () => {
  const pc = await startFakePc({ port: 18851, token: TOKEN, data: syntheticData(), slow: 'thbgm.dat' });
  const t = start(18839);
  try {
    await waitFor(() => t.svc.status.state === 'ready');
    assert.equal((await postSetup(t.base, { ip: '127.0.0.1', port: 18851, token: TOKEN })).status, 202);
    const again = await postSetup(t.base, { ip: '127.0.0.1', port: 18851, token: TOKEN });
    assert.equal(again.status, 409);
    const body = await again.json();
    assert.equal(body.code, 'running');
    assert.match(body.error, /already running/);
  } finally { t.svc.onStop(); await pc.close(); }
});

test('a wrong token, or no server at ip:port, fails at the manifest and writes nothing', async () => {
  const pc = await startFakePc({ port: 18852, token: TOKEN, data: syntheticData() });
  const t = start(18840);
  try {
    let s = await setupTo(t, 18852, '87654321');
    assert.deepEqual([s.state, s.phase, s.error.code], ['error', 'manifest', 'token']);
    s = await setupTo(t, 18859);
    assert.deepEqual([s.state, s.phase, s.error.code], ['error', 'manifest', 'network']);
    assert.match(s.error.message, /cannot reach the PC server/);
    assert.ok(!fs.existsSync(path.join(t.root, 'retail')) && !fs.existsSync(path.join(t.root, 'staging')));
    assert.equal(t.svc.status.ready, false);
  } finally { t.svc.onStop(); await pc.close(); }
});

test('a manifest that does not list exactly th08.dat and thbgm.dat, well formed, is refused', async () => {
  const good = manifestOf(syntheticData());
  const pc = await startFakePc({ port: 18853, token: TOKEN, data: syntheticData() });
  const t = start(18841);
  const bad = [[good[0]], good.concat([{ name: 'x.dat', size: 1, sha256: good[0].sha256 }]), [good[0], good[0]],
    [good[0], Object.assign({}, good[1], { size: 0 })], [good[0], Object.assign({}, good[1], { size: 1.5 })],
    [good[0], Object.assign({}, good[1], { size: '1048576' })], [good[0], Object.assign({}, good[1], { sha256: 'ab' })],
    [good[0], Object.assign({}, good[1], { sha256: 'z'.repeat(64) })], [good[0], Object.assign({}, good[1], { name: '../thbgm.dat' })]];
  try {
    for (const files of bad) {
      pc.opts.manifest = { files };
      const s = await setupTo(t, 18853);
      assert.deepEqual([s.state, s.error.code], ['error', 'manifest'], JSON.stringify(files));
    }
    pc.opts.manifest = { files: good.map((f) => Object.assign({}, f, { sha256: f.sha256.toUpperCase() })) };
    assert.equal((await setupTo(t, 18853)).state, 'done', 'upper-case hex is accepted');
    assert.equal(routes(pc, '/thbgm.dat'), 1, 'files are fetched only for the valid manifest');
  } finally { t.svc.onStop(); await pc.close(); }
});

test('not enough free space fails before any download and reports the numbers', async () => {
  const pc = await startFakePc({ port: 18854, token: TOKEN, data: syntheticData() });
  const t = start(18842, { env: { TH08_DATA_RESERVE: String(1e15) } });
  try {
    const s = await setupTo(t, 18854);
    assert.deepEqual([s.state, s.phase, s.error.code], ['error', 'space', 'space']);
    assert.equal(s.error.need, 4096 + 1048576 + 1e15);
    // Other test files write to the same disk meanwhile: the free space only matches roughly.
    const free = fs.statfsSync(t.root).bavail * fs.statfsSync(t.root).bsize;
    assert.ok(Math.abs(s.error.free - free) < 64 * 1048576, s.error.free + ' vs ' + free);
    assert.match(s.error.message, /^not enough free space: need \d+ MiB, free \d+ MiB$/);
    assert.deepEqual(pc.seen, ['GET /manifest.json']);
  } finally { t.svc.onStop(); await pc.close(); }
});

test('a body cut short is fetched again whole', async () => {
  const pc = await startFakePc({ port: 18855, token: TOKEN, data: syntheticData(), cut: { 'thbgm.dat': 2 } });
  const t = start(18843);
  try {
    const s = await setupTo(t, 18855);
    assert.equal(s.state, 'done', JSON.stringify(s.error));
    assert.equal(s.files[1].attempt, 3);
    assert.equal(routes(pc, '/thbgm.dat'), 3);
    assert.equal(t.svc.status.ready, true);
  } finally { t.svc.onStop(); await pc.close(); }
});

test('a PC that stops sending is given up after the idle timeout, 3 times', async () => {
  const pc = await startFakePc({ port: 18861, token: TOKEN, data: syntheticData(), stall: 'th08.dat' });
  const t = start(18860, { env: { TH08_SETUP_IDLE_MS: '200' } });
  try {
    const s = await setupTo(t, 18861);
    assert.deepEqual([s.state, s.phase, s.error.code], ['error', 'download', 'network']);
    assert.match(s.error.message, /^no data from the PC for 0\.2 s$/);
    assert.equal(routes(pc, '/th08.dat'), 3);
  } finally { t.svc.onStop(); await pc.close(); }
});

test('a file that never matches its SHA-256 fails after 3 tries and nothing is activated', async () => {
  const pc = await startFakePc({ port: 18856, token: TOKEN, data: NEW_DATA, corrupt: { 'thbgm.dat': 99 } });
  const t = start(18844);
  try {
    const s = await setupTo(t, 18856);
    assert.deepEqual([s.state, s.error.code], ['error', 'hash']);
    assert.match(s.error.message, /thbgm\.dat: SHA-256 [0-9a-f]{64} does not match the manifest/);
    assert.equal(routes(pc, '/thbgm.dat'), 3);
    assert.ok(!fs.existsSync(path.join(t.root, 'retail')) && !fs.existsSync(path.join(t.root, 'staging')));
    assert.equal(t.svc.status.ready, false);
  } finally { t.svc.onStop(); await pc.close(); }
});

test('with the game data already set up, POST /setup answers 409 already-set and asks the PC nothing', async () => {
  const pc = await startFakePc({ port: 18857, token: TOKEN, data: NEW_DATA });
  const t = start(18845, { data: true });
  try {
    await waitFor(() => t.svc.status.state === 'ready');
    const res = await postSetup(t.base, { ip: '127.0.0.1', port: 18857, token: TOKEN });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'already-set');
    assert.deepEqual(pc.seen, []);
    assert.equal(t.svc.status.setup, null);
    assert.ok(fs.readFileSync(path.join(t.root, 'retail', 'thbgm.dat')).equals(syntheticData()['thbgm.dat']));
  } finally { t.svc.onStop(); await pc.close(); }
});

test('a PC that keeps trickling is cut at the per-attempt deadline, 3 times', async () => {
  const pc = await startFakePc({ port: 18863, token: TOKEN, data: syntheticData(), trickle: 'th08.dat' });
  const t = start(18862, { env: { TH08_SETUP_FLOOR_MS: '300', TH08_SETUP_MIN_RATE: '1e12' } });
  try {
    const s = await setupTo(t, 18863);
    assert.deepEqual([s.state, s.phase, s.error.code], ['error', 'download', 'network']);
    assert.match(s.error.message, /^the PC did not finish within 0\.3\d* s$/);
    assert.equal(routes(pc, '/th08.dat'), 3);
    await waitFor(() => pc.closed.filter((r) => r === '/th08.dat').length === 3);
    assert.ok(!fs.existsSync(path.join(t.root, 'staging')));
  } finally { t.svc.onStop(); await pc.close(); }
});

// A sandbox fs whose write() writes at most `max` bytes; with `lie` it reports the full
// length anyway (a write that silently loses bytes).
function shortWrites(max, lie) {
  const realFs = require('node:fs');
  const write = (fd, buf, off, len, pos, cb) => realFs.write(fd, buf, off, Math.min(len, max), pos,
    (err, n) => cb(err, lie ? len : n));
  const fakeFs = Object.assign({}, realFs, { write });
  return { require: (name) => (name === 'fs' ? fakeFs : require(name)) };
}

test('short writes are completed; a file short on disk is never activated', async () => {
  const pc = await startFakePc({ port: 18866, token: TOKEN, data: syntheticData() });
  const t = start(18864, { globals: shortWrites(1000, false) });
  let liar;
  try {
    const first = await setupTo(t, 18866);
    assert.equal(first.state, 'done', JSON.stringify(first.error));
    assert.ok(fs.readFileSync(path.join(t.root, 'retail', 'thbgm.dat')).equals(syntheticData()['thbgm.dat']));
    liar = start(18865, { globals: shortWrites(1000, true) });   // after t: the env is shared
    const s = await setupTo(liar, 18866);
    assert.deepEqual([s.state, s.error.code], ['error', 'disk']);
    assert.match(s.error.message, /^th08\.dat: \d+ bytes on disk, expected 4096$/);
    assert.ok(!fs.existsSync(path.join(liar.root, 'retail')));
    assert.equal(liar.svc.status.ready, false);
  } finally { t.svc.onStop(); if (liar) liar.svc.onStop(); await pc.close(); }
});

test('a stop mid-download cancels the copy; the next service starts from a clean staging', async () => {
  const pc = await startFakePc({ port: 18858, token: TOKEN, data: syntheticData(), slow: 'thbgm.dat' });
  const t = start(18846);
  const part = path.join(t.root, 'staging', 'retail', 'thbgm.dat.part');
  let next;
  try {
    await waitFor(() => t.svc.status.state === 'ready');
    assert.equal((await postSetup(t.base, { ip: '127.0.0.1', port: 18858, token: TOKEN })).status, 202);
    await waitFor(() => t.svc.status.setup.files.length && t.svc.status.setup.files[1].got > 0);
    assert.equal((await fetch(t.base + '/shutdown', { method: 'POST' })).status, 202);
    await waitFor(() => t.svc.status.setup.state === 'cancelled');
    await waitFor(() => pc.closed.includes('/thbgm.dat'));
    const size = fs.statSync(part).size;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.statSync(part).size, size, 'nothing written after the stop');
    assert.ok(!fs.existsSync(path.join(t.root, 'retail', 'thbgm.dat')), 'nothing activated');
    next = loadService({ TH08_DATA_DIR: t.dataDir, TH08_PORT: '18847' });
    await waitFor(() => next.status.state === 'ready');
    assert.ok(!fs.existsSync(path.join(t.root, 'staging')), 'staging removed at start');
    assert.deepEqual([next.status.ready, next.status.dataReady], [false, false]);
  } finally { t.svc.onStop(); if (next) next.onStop(); await pc.close(); }
});

test('a staging cleanup that throws still ends the setup with the original error and frees the slot', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const realFs = require('node:fs');
  const flag = { fail: false };
  const boom = () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); };
  const fakeFs = Object.assign({}, realFs, {
    unlinkSync: (p) => (flag.fail ? boom() : realFs.unlinkSync(p)),
    rmdirSync: (p) => (flag.fail ? boom() : realFs.rmdirSync(p)) });
  const globals = { require: (name) => (name === 'fs' ? fakeFs : require(name)) };
  const t = start(18867, { globals });
  try {
    await waitFor(() => t.svc.status.state === 'ready');
    fs.mkdirSync(path.join(t.root, 'staging'), { recursive: true });
    fs.writeFileSync(path.join(t.root, 'staging', 'junk'), 'x');
    flag.fail = true;
    // No server at this port: the manifest fails, then the cleanup throws.
    assert.equal((await postSetup(t.base, { ip: '127.0.0.1', port: 18868, token: TOKEN })).status, 202);
    await waitFor(() => t.svc.status.setup.state !== 'running', 10000);
    assert.equal(t.svc.status.setup.state, 'error');
    assert.notEqual(t.svc.status.setup.error.code, 'EIO', 'the original error is kept');
    assert.ok(t.svc.status.setup.finishedAt);
    flag.fail = false;
    const again = await postSetup(t.base, { ip: '127.0.0.1', port: 18868, token: TOKEN });
    assert.equal(again.status, 202, 'the slot is free again');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(unhandled, []);
  } finally { process.removeListener('unhandledRejection', onUnhandled); t.svc.onStop(); }
});
