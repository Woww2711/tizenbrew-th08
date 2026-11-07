'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadService, waitFor, tempDir, preinstall, syntheticData, writeDataSet, manifestOf } = require('./harness');

function state(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'th08', 'state.json'), 'utf8'));
}

async function started(dataDir, port) {
  const svc = loadService({ TH08_DATA_DIR: dataDir, TH08_PORT: String(port) });
  await waitFor(() => svc.status.state === 'ready' || svc.status.state === 'error');
  return svc;
}

test('build and data set on disk: ready, with the files on /status and in state.json', async () => {
  const dataDir = tempDir();
  preinstall(dataDir);
  const svc = await started(dataDir, 18830);
  try {
    const s = await (await fetch('http://127.0.0.1:18830/status')).json();
    assert.deepEqual([s.ready, s.buildReady, s.dataReady], [true, true, true]);
    assert.deepEqual(s.files, manifestOf(syntheticData()));
    assert.equal(state(dataDir).dataReady, true);
    assert.deepEqual(state(dataDir).files, s.files);
    assert.equal(svc.launchUrl(), s.launcherUrl);
  } finally { svc.onStop(); }
});

test('build without data: the service is up but not ready; /open and launchUrl refuse', async () => {
  const dataDir = tempDir();
  preinstall(dataDir, { data: false });
  const svc = await started(dataDir, 18831);
  try {
    assert.equal(svc.status.state, 'ready', svc.status.error);
    const s = await (await fetch('http://127.0.0.1:18831/status')).json();
    assert.deepEqual([s.ready, s.buildReady, s.dataReady], [false, true, false]);
    const res = await fetch('http://127.0.0.1:18831/open', { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal(svc.launchUrl(), null);
    assert.equal(svc.status.openMethod, null);
  } finally { svc.onStop(); }
});

test('a data file of the wrong size is not ready at start, and state.json says so', async () => {
  const dataDir = tempDir();
  preinstall(dataDir);
  fs.truncateSync(path.join(dataDir, 'th08', 'retail', 'thbgm.dat'), 1000);
  const svc = await started(dataDir, 18832);
  try {
    assert.equal(svc.status.ready, false);
    assert.equal(svc.status.dataReady, false);
    assert.deepEqual([state(dataDir).dataReady, state(dataDir).files], [false, []]);
  } finally { svc.onStop(); }
});

test('a data file removed while running is noticed on the next /status and /open', async () => {
  const dataDir = tempDir();
  preinstall(dataDir);
  const svc = await started(dataDir, 18833);
  try {
    assert.equal(svc.status.ready, true);
    fs.unlinkSync(path.join(dataDir, 'th08', 'retail', 'th08.dat'));
    const s = await (await fetch('http://127.0.0.1:18833/status')).json();
    assert.deepEqual([s.ready, s.dataReady], [false, false]);
    assert.equal((await fetch('http://127.0.0.1:18833/open', { method: 'POST' })).status, 409);
  } finally { svc.onStop(); }
});

test('an activation cut before the new set was whole puts retail.old back', async () => {
  const dataDir = tempDir();
  preinstall(dataDir, { data: false });
  const root = path.join(dataDir, 'th08');
  writeDataSet(root, syntheticData(), 'retail.old');
  writeDataSet(root, { 'th08.dat': Buffer.from('half') }, 'retail');      // no thbgm.dat: not a whole set
  writeDataSet(root, syntheticData(), 'staging/retail');
  const svc = await started(dataDir, 18834);
  try {
    assert.equal(svc.status.ready, true);
    assert.equal(fs.readFileSync(path.join(root, 'retail', 'th08.dat')).length, 4096);
    assert.ok(!fs.existsSync(path.join(root, 'retail.old')));
    assert.ok(!fs.existsSync(path.join(root, 'staging')), 'staged data removed, never activated');
    assert.ok(svc.status.log.some((l) => /restored retail\.old/.test(l)));
  } finally { svc.onStop(); }
});

test('an activation cut after the new set was moved in keeps it and drops retail.old', async () => {
  const dataDir = tempDir();
  preinstall(dataDir, { data: false });
  const root = path.join(dataDir, 'th08');
  writeDataSet(root, { 'th08.dat': Buffer.from('old th08'), 'thbgm.dat': Buffer.from('old bgm') }, 'retail.old');
  writeDataSet(root, syntheticData(), 'retail');
  const svc = await started(dataDir, 18835);
  try {
    assert.equal(svc.status.ready, true);
    assert.equal(fs.readFileSync(path.join(root, 'retail', 'thbgm.dat')).length, 1048576);
    assert.ok(!fs.existsSync(path.join(root, 'retail.old')));
    assert.ok(svc.status.log.some((l) => /removed retail\.old/.test(l)));
  } finally { svc.onStop(); }
});
