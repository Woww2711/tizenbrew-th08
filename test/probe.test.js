'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { readRecord, updateCheck, dataChecks } = require('../launcher/probe.js');
const RemoteFile = require('../launcher/remote-file.js');
const { loadService, waitFor, tempDir, preinstall, syntheticData, manifestOf } = require('./harness');

const fsWith = (content, err) => ({ readFile() { if (err) throw err; return content; } });
const good = { count: 2, at: 'x', version: '0.0.2', history: [{ count: 1 }, { count: 2 }] };

test('a missing file (ENOENT, either Emscripten style) means no record yet', () => {
  assert.deepEqual(readRecord(fsWith(null, Object.assign(new Error('x'), { errno: 44 })), '/f'), { missing: true });
  assert.deepEqual(readRecord(fsWith(null, Object.assign(new Error('x'), { code: 'ENOENT' })), '/f'), { missing: true });
});

test('a valid record is returned', () => {
  assert.deepEqual(readRecord(fsWith(JSON.stringify(good)), '/f'), { record: good });
});

test('other read errors, corrupt JSON and wrong schemas are errors, never "missing"', () => {
  const bad = [fsWith(null, Object.assign(new Error('EIO'), { errno: 29 })), fsWith(null, Object.assign(new Error('EACCES'), { errno: 2 })), fsWith('{oops'), fsWith('null'), fsWith('{}'),
    fsWith(JSON.stringify(Object.assign({}, good, { count: 'a' }))), fsWith(JSON.stringify(Object.assign({}, good, { count: 0 }))),
    fsWith(JSON.stringify(Object.assign({}, good, { history: {} }))),
    fsWith(JSON.stringify(Object.assign({}, good, { history: [null] })))];
  bad.forEach((fs, i) => { const r = readRecord(fs, '/f'); assert.ok(r.error && !r.missing && !r.record, 'case ' + i); });
});

test('a record with entries of 0.0.2 read by 0.0.3 shows the update kept the save', () => {
  const rec = { count: 6, at: 'c', version: '0.0.3', history: [{ count: 4, at: 'a', version: '0.0.2' },
    { count: 5, at: 'b', version: '0.0.2' }, { count: 6, at: 'c', version: '0.0.3' }] };
  const r = updateCheck(rec, '0.0.2');
  assert.equal(r.ok, true);
  assert.deepEqual(r.from, { version: '0.0.2', count: 5, at: 'b' });
  assert.match(r.detail, /^đọc được bản ghi do bản 0\.0\.2 ghi: lần 5 lúc b/);
});

test('no record, no 0.0.2 entry, or a malformed proof is not proof; a valid kept proof is', () => {
  const own = { count: 1, at: 'a', version: '0.0.3', history: [{ count: 1, at: 'a', version: '0.0.3' }] };
  const notProof = [null, own,
    Object.assign({}, own, { history: [{ count: 4, at: 'a' }] }),                       // no version
    Object.assign({}, own, { history: [{ count: 4, at: 'a', version: '0.0.1' }] }),     // another version
    Object.assign({}, own, { history: [{ count: 'x', at: 'a', version: '0.0.2' }] }),   // bad count
    Object.assign({}, own, { updatedFrom: {} }),
    Object.assign({}, own, { updatedFrom: { version: '0.0.2', count: 0, at: 'b' } })];
  notProof.forEach((rec, i) => assert.equal(updateCheck(rec, '0.0.2').ok, false, 'case ' + i));
  const kept = Object.assign({}, own, { updatedFrom: { version: '0.0.2', count: 5, at: 'b' } });
  assert.equal(updateCheck(kept, '0.0.2').ok, true);
  assert.deepEqual(updateCheck(kept, '0.0.2').from, kept.updatedFrom);
});

test('dataChecks reads th08.dat whole and thbgm.dat in ranges through the service', async () => {
  const dataDir = tempDir();
  preinstall(dataDir);
  const svc = loadService({ TH08_DATA_DIR: dataDir, TH08_PORT: '18849' });
  try {
    await waitFor(() => svc.status.ready);
    const files = manifestOf(syntheticData());
    const rows = await dataChecks(RemoteFile, 'http://127.0.0.1:18849', files, () => performance.now());
    assert.deepEqual(rows.map((r) => [r.check, r.ok]), [['th08.dat (toàn bộ)', true], ['thbgm.dat đầu', true],
      ['thbgm.dat giữa', true], ['thbgm.dat cuối', true], ['thbgm.dat 8 × 64 KiB liên tiếp', true]]);
    assert.match(rows[0].detail, /^HTTP 200, 4096 B trong \d+ ms, SHA-256 khớp$/);
    assert.match(rows[3].detail, /^HTTP 206, byte 983040–1048575 \/ 1048576, 65536 B trong \d+ ms$/);
    const wrong = files.map((f) => Object.assign({}, f, f.name === 'th08.dat' ? { sha256: '0'.repeat(64) } : { size: f.size + 1 }));
    const bad = await dataChecks(RemoteFile, 'http://127.0.0.1:18849', wrong, () => performance.now());
    assert.match(bad[0].detail, /SHA-256 KHÔNG khớp/);
    assert.ok(bad.every((r) => !r.ok), JSON.stringify(bad));
  } finally { svc.onStop(); }
});
