'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const TH08Saves = require('../launcher/saves.js');

// Enough of Emscripten's FS for saves.js: a path → 'dir' | 'file' | 'link' map. syncfs(true)
// adds `stored` (what IndexedDB holds); syncError makes every syncfs fail; hang never calls back.
function fakeModule(opts = {}) {
  const nodes = new Map([['/', 'dir']]);
  const calls = [];
  const hung = [];
  const eexist = () => Object.assign(new Error('FS error'), { errno: 20 });
  const FS = {
    mkdir(p) { if (nodes.has(p)) throw eexist(); nodes.set(p, 'dir'); },
    stat(p) { if (!nodes.has(p)) throw new Error('ENOENT ' + p); return { mode: nodes.get(p) }; },
    lstat(p) { return FS.stat(p); },
    isDir: (mode) => mode === 'dir',
    readdir: (p) => ['.', '..'].concat([...nodes.keys()].filter((k) => k !== '/' && path.posix.dirname(k) === p).map((k) => path.posix.basename(k))),
    unlink(p) { calls.push(['unlink', p]); nodes.delete(p); },
    rmdir(p) { calls.push(['rmdir', p]); nodes.delete(p); },
    symlink(target, p) { if (nodes.has(p)) throw eexist(); calls.push(['symlink', target, p]); nodes.set(p, 'link'); },
    mount(type, o, p) { calls.push(['mount', type, o, p]); },
    syncfs(populate, cb) {
      calls.push(['syncfs', populate]);
      if (opts.hang) { hung.push(cb); return; }
      if (populate && !opts.syncError) for (const [p, kind] of Object.entries(opts.stored || {})) nodes.set(p, kind);
      setTimeout(() => cb(opts.syncError || null), 1);
    }
  };
  return { Module: { FS, IDBFS: 'IDBFS' }, nodes, calls, hung };
}

test('prepare mounts IDBFS like upstream, loads from IndexedDB, then links the save files', async () => {
  const { Module, calls, nodes } = fakeModule({ stored: { '/save/score.dat': 'file' } });
  const r = await TH08Saves.prepare(Module);
  assert.deepEqual(r, { available: true, error: null, removedRetail: false,
    mounts: ['/save', '/game/replay', '/game/backup', '/game/snapshot'] });
  assert.deepEqual(calls.filter((c) => c[0] === 'mount').map((c) => [c[1], c[2], c[3]]),
    r.mounts.map((m) => ['IDBFS', { autoPersist: true }, m]));
  const i = calls.findIndex((c) => c[0] === 'syncfs');
  assert.deepEqual(calls[i], ['syncfs', true]);
  assert.ok(calls.findIndex((c) => c[0] === 'symlink') > i, 'links after loading');
  assert.deepEqual(calls.filter((c) => c[0] === 'symlink').map((c) => c.slice(1)),
    [['/save/th08.cfg', '/game/th08.cfg'], ['/save/score.dat', '/game/score.dat'], ['/save/score.txt', '/game/score.txt']]);
  assert.equal(nodes.get('/save/score.dat'), 'file');
});

test('a failing IndexedDB leaves saves in memory and reports why', async () => {
  const { Module, calls } = fakeModule({ syncError: new Error('IDB unavailable') });
  const r = await TH08Saves.prepare(Module);
  assert.equal(r.available, false);
  assert.equal(r.error, 'IDB unavailable');
  assert.equal(calls.filter((c) => c[0] === 'symlink').length, 3);
});

test('retail archives found in save storage are removed', async () => {
  const { Module, nodes } = fakeModule({ stored: { '/save/TH08.DAT': 'file', '/game/replay/x': 'dir',
    '/game/replay/x/thbgm.dat': 'file', '/game/replay/a.rpy': 'file' } });
  const r = await TH08Saves.prepare(Module);
  assert.equal(r.removedRetail, true);
  assert.ok(!nodes.has('/save/TH08.DAT'));
  assert.ok(!nodes.has('/game/replay/x/thbgm.dat'));
  assert.equal(nodes.get('/game/replay/a.rpy'), 'file');
});

test('flush writes to IndexedDB and rejects on its error', async () => {
  const ok = fakeModule();
  await TH08Saves.flush(ok.Module);
  assert.deepEqual(ok.calls, [['syncfs', false]]);
  await assert.rejects(TH08Saves.flush(fakeModule({ syncError: new Error('quota') }).Module), /quota/);
});

test('an IndexedDB that never answers times out; a late answer is ignored', async () => {
  TH08Saves.timeoutMs = 50;
  try {
    const { Module, hung, calls } = fakeModule({ hang: true });
    const r = await TH08Saves.prepare(Module);
    assert.equal(r.available, false);
    assert.equal(r.error, 'IndexedDB: no answer after 50 ms');
    assert.equal(calls.filter((c) => c[0] === 'symlink').length, 3, 'game can still start');
    await assert.rejects(TH08Saves.flush(Module), /IndexedDB: no answer after 50 ms/);
    assert.equal(hung.length, 2);
    hung.forEach((cb) => cb(null));
    hung.forEach((cb) => cb(new Error('late')));
  } finally { TH08Saves.timeoutMs = 10000; }
});
