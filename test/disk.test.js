'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadService, waitFor, tempDir, preinstall } = require('./harness');

test('status.disk reports free and total bytes of the data filesystem via fs.statfs', async () => {
  const dataDir = tempDir();
  preinstall(dataDir);
  const svc = loadService({ TH08_DATA_DIR: dataDir, TH08_PORT: '18814' });
  try {
    await waitFor(() => svc.status.disk !== null);
    const d = svc.status.disk;
    const st = fs.statfsSync(dataDir);
    assert.equal(d.method, 'statfs');
    assert.equal(d.path, path.join(dataDir, 'th08'));
    assert.equal(d.total, st.blocks * st.bsize);
    assert.ok(d.free > 0 && d.free <= d.total, JSON.stringify(d));
    const s = await (await fetch('http://127.0.0.1:18814/status')).json();
    assert.deepEqual(s.disk, d);
  } finally { svc.onStop(); }
});

test('without fs.statfs (Node < 18.15) status.disk comes from df', async () => {
  const dataDir = tempDir();
  preinstall(dataDir);
  const oldFs = Object.assign({}, fs, { statfs: undefined });
  const fakeRequire = (name) => (name === 'fs' ? oldFs : require(name));
  const svc = loadService({ TH08_DATA_DIR: dataDir, TH08_PORT: '18815' }, { require: fakeRequire });
  try {
    await waitFor(() => svc.status.disk !== null);
    const d = svc.status.disk;
    assert.equal(d.method, 'df', JSON.stringify(d));
    assert.ok(d.total > 0 && d.free > 0 && d.free <= d.total, JSON.stringify(d));
  } finally { svc.onStop(); }
});

test('a data dir that cannot be read reports the error instead of numbers', async () => {
  const svc = loadService({ TH08_DATA_DIR: tempDir(), TH08_PORT: '18816', TH08_BUILD_URL: 'http://127.0.0.1:9/never' });
  try {
    const d = await svc._test.diskSpace('/nonexistent/th08-disk-test');
    assert.equal(d.method, 'statfs');
    assert.match(d.error, /ENOENT/);
  } finally { svc.onStop(); }
});
