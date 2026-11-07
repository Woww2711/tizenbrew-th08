'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const TH08Saves = require('../launcher/saves.js');

// Enough of Emscripten's FS and IDBFS for saves.js. FS nodes: path → { kind: 'dir'|'link'|'file',
// data, mtime }; every change gets a later mtime. IndexedDB: db[mount] = Map(path → entry).
// opts.stored: entries IndexedDB holds at start; opts.populate(cb): replaces syncfs(true);
// opts.remoteDelay: ms before getRemoteSet answers (Infinity: never); opts.failPut / throwPut:
// the put of that path fails / throws (may be set later); opts.txError: every request fails.
// HEAPU8 is the module's heap (the game writes th08.cfg from there).
function fakeModule(opts = {}) {
  const nodes = new Map([['/', { kind: 'dir' }]]);
  const calls = [];
  const db = {};
  const pending = [];
  let clock = 1000, txOpen = 0;
  const stats = { tx: 0, maxTxOpen: 0 };
  const eexist = () => Object.assign(new Error('FS error'), { errno: 20 });
  const norm = (p) => path.posix.normalize(p[0] === '/' ? p : FS.cwd() + '/' + p).replace(/(.)\/$/, '$1');
  const set = (p, node) => nodes.set(p, Object.assign({ mtime: new Date(++clock) }, node));
  const HEAPU8 = new Uint8Array(new SharedArrayBuffer(4096));
  const FS = {
    cwdPath: '/',
    cwd() { return FS.cwdPath; },
    chdir(p) { FS.cwdPath = norm(p); },
    lookupPath(p) {
      const n = norm(p);
      if (!nodes.has(n)) throw new Error('ENOENT ' + n);
      return { path: n, node: { mount: { mountpoint: n } } };
    },
    mkdir(p) { const n = norm(p); if (nodes.has(n)) throw eexist(); calls.push(['mkdir', n]); set(n, { kind: 'dir' }); },
    stat(p) { const n = norm(p); if (!nodes.has(n)) throw new Error('ENOENT ' + n); return { mode: nodes.get(n).kind }; },
    lstat(p) { return FS.stat(p); },
    isDir: (mode) => mode === 'dir',
    readdir: (p) => ['.', '..'].concat([...nodes.keys()].filter((k) => k !== '/' && path.posix.dirname(k) === p).map((k) => path.posix.basename(k))),
    unlink(p) { calls.push(['unlink', norm(p)]); nodes.delete(norm(p)); },
    rmdir(p) { calls.push(['rmdir', norm(p)]); nodes.delete(norm(p)); },
    rename(a, b) { calls.push(['rename', norm(a), norm(b)]); set(norm(b), nodes.get(norm(a))); nodes.delete(norm(a)); },
    truncate(p) { calls.push(['truncate', p]); },
    symlink(target, p) { if (nodes.has(norm(p))) throw eexist(); calls.push(['symlink', target, p]); set(norm(p), { kind: 'link', link: target }); },
    mount(type, o, p) { calls.push(['mount', type, o, p]); db[p] = db[p] || new Map(); },
    open(p, flags) {
      let n = norm(p);
      if (nodes.has(n) && nodes.get(n).kind === 'link') n = nodes.get(n).link;
      if ((flags & 3) && (flags & 512)) set(n, { kind: 'file', data: new Uint8Array(0) });          // O_TRUNC, like CREATE_ALWAYS
      if ((flags & 3) && !nodes.has(n)) set(n, { kind: 'file', data: new Uint8Array(0) });
      calls.push(['open', n, flags]);
      return { path: n, flags };
    },
    write(stream, buffer, offset, length, position) {
      position = position || 0;
      const old = nodes.get(stream.path).data;
      if (old.length >= position + length) {                 // like MEMFS: in place when it fits
        old.set(buffer.subarray(offset, offset + length), position);
        return length;
      }
      const data = new Uint8Array(Math.max(old.length, position + length));
      data.set(old);
      data.set(buffer.subarray(offset, offset + length), position);
      set(stream.path, { kind: 'file', data });
      return length;
    },
    close(stream) { calls.push(['close', stream.path]); },
    writeFile(p, data) { const s = FS.open(p, 577); FS.write(s, data, 0, data.length, 0); FS.close(s); },
    readFile(p) { const v = nodes.get(norm(p)); if (!v || v.kind !== 'file') throw new Error('ENOENT ' + p); return v.data; },
    syncfs(populate, cb) {
      calls.push(['syncfs', populate]);
      if (opts.populate) return opts.populate(cb);
      for (const [p, kind] of Object.entries(opts.stored || {})) set(p, kind === 'file' ? { kind, data: new Uint8Array(1) } : { kind });
      setTimeout(() => cb(null), 1);
    }
  };
  const IDBFS = {
    DB_STORE_NAME: 'FILE_DATA',
    getLocalSet(mount, cb) {
      const entries = {};
      for (const [p, n] of nodes) if (p.indexOf(mount.mountpoint + '/') === 0) entries[p] = { timestamp: n.mtime };
      cb(null, { type: 'local', entries });
    },
    loadLocalEntry(p, cb) {
      const n = nodes.get(p);
      cb(null, n.kind === 'file' ? { timestamp: n.mtime, mode: 'file', contents: n.data }
        : n.kind === 'link' ? { timestamp: n.mtime, mode: 'link', link: n.link } : { timestamp: n.mtime, mode: 'dir' });
    },
    getRemoteSet(mount, cb) {
      const store = db[mount.mountpoint];
      const answer = () => {
        const entries = {};
        for (const [p, e] of store) entries[p] = { timestamp: e.timestamp };
        cb(null, { type: 'remote', entries, db: { transaction: () => transaction(store) } });
      };
      if (opts.remoteDelay === Infinity) pending.push(answer);
      else setTimeout(answer, opts.remoteDelay || 1);
    }
  };
  // IndexedDB's rules: requests run in order at commit; a failing request fires its onerror,
  // then the transaction's; unless one of them calls preventDefault() the transaction aborts.
  // abort() drops every request (nothing applied, onabort); otherwise the successful ones commit.
  function transaction(store) {
    const tx = { ops: [], aborted: false, done: false, error: null };
    stats.tx++;
    stats.maxTxOpen = Math.max(stats.maxTxOpen, ++txOpen);
    tx.abort = () => { if (tx.done) throw new Error('InvalidStateError'); tx.aborted = true; };
    const request = (op, p, e) => {
      if (opts.throwPut === p) throw new Error('DataCloneError');
      const req = { onerror: null, fails: opts.txError || opts.failPut === p };
      tx.ops.push([op, p, e, req]);
      return req;
    };
    tx.objectStore = () => ({ put: (e, p) => request('put', p, e), delete: (p) => request('delete', p) });
    setTimeout(() => {
      txOpen--;
      const applied = [];
      for (const [op, p, e, req] of tx.ops) {
        if (tx.aborted) break;
        if (!req.fails) { applied.push([op, p, e]); continue; }
        const ev = { target: { error: new Error('QuotaExceededError') }, defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; } };
        if (req.onerror) req.onerror(ev);
        if (!tx.aborted && tx.onerror) tx.onerror(ev);
        if (!ev.defaultPrevented) tx.aborted = true;
        tx.error = ev.target.error;
      }
      tx.done = true;
      if (tx.aborted) return tx.onabort && tx.onabort({ target: tx });
      for (const [op, p, e] of applied) if (op === 'put') store.set(p, e); else store.delete(p);
      stats.committed = (stats.committed || 0) + 1;
      tx.oncomplete();
    }, opts.txDelay || 5);
    return tx;
  }
  return { Module: { FS, IDBFS, HEAPU8 }, FS, nodes, calls, db, stats, pending, HEAPU8, opts };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stored = (m, mount, p) => m.db[mount].get(p);

// A prepared module with the game's cwd and the tracker; settle 30 ms for the tests.
async function tracked(opts) {
  const m = fakeModule(opts);
  await TH08Saves.prepare(m.Module);
  m.FS.chdir('/game');
  m.states = [];
  m.tracker = TH08Saves.track(m.Module, (v) => m.states.push(v.state));
  m.calls.length = 0;
  return m;
}
test.beforeEach(() => { TH08Saves.settleMs = 30; });
test.afterEach(() => { TH08Saves.settleMs = 1000; TH08Saves.timeoutMs = 10000; });

test('prepare mounts IDBFS without autoPersist, loads from IndexedDB, then links the save files', async () => {
  const { Module, calls, nodes } = fakeModule({ stored: { '/save/score.dat': 'file' } });
  const r = await TH08Saves.prepare(Module);
  assert.deepEqual(r, { removedRetail: false, mounts: ['/save', '/game/replay', '/game/backup', '/game/snapshot'] });
  assert.deepEqual(calls.filter((c) => c[0] === 'mount').map((c) => [c[1], c[2], c[3]]),
    r.mounts.map((m) => [Module.IDBFS, {}, m]));
  const i = calls.findIndex((c) => c[0] === 'syncfs');
  assert.deepEqual(calls[i], ['syncfs', true]);
  assert.ok(calls.findIndex((c) => c[0] === 'symlink') > i, 'links after loading');
  assert.deepEqual(calls.filter((c) => c[0] === 'symlink').map((c) => c.slice(1)),
    [['/save/th08.cfg', '/game/th08.cfg'], ['/save/score.dat', '/game/score.dat'], ['/save/score.txt', '/game/score.txt']]);
  assert.equal(nodes.get('/save/score.dat').kind, 'file');
});

test('an IndexedDB that fails or never answers rejects prepare: the game must not start', async () => {
  const failing = fakeModule({ populate: (cb) => setTimeout(() => cb(new Error('IDB unavailable')), 1) });
  await assert.rejects(TH08Saves.prepare(failing.Module), /IDB unavailable/);
  assert.equal(failing.calls.filter((c) => c[0] === 'symlink').length, 0);
  TH08Saves.timeoutMs = 50;
  const hung = [];
  const silent = fakeModule({ populate: (cb) => hung.push(cb) });
  await assert.rejects(TH08Saves.prepare(silent.Module), (e) => e.timeout === true && /no answer after 50 ms/.test(e.message));
  hung.forEach((cb) => cb(null));             // a late answer is ignored
});

test('retail archives found in save storage are removed', async () => {
  const { Module, nodes } = fakeModule({ stored: { '/save/TH08.DAT': 'file', '/game/replay/x': 'dir',
    '/game/replay/x/thbgm.dat': 'file', '/game/replay/a.rpy': 'file' } });
  const r = await TH08Saves.prepare(Module);
  assert.equal(r.removedRetail, true);
  assert.ok(!nodes.has('/save/TH08.DAT'));
  assert.ok(!nodes.has('/game/replay/x/thbgm.dat'));
  assert.equal(nodes.get('/game/replay/a.rpy').kind, 'file');
});

test('a file the game closes on a save mount is flushed once, settleMs later; /game files are not', async () => {
  const m = await tracked();
  const s = m.FS.open('score.dat', 33345);                  // the /game/score.dat link, as the game opens it
  m.FS.write(s, new Uint8Array(16030).fill(7), 0, 16030, 0);
  m.FS.close(s);
  m.FS.close(m.FS.open('/game/modern-files.txt', 33857));   // the runtime's own log in MEMFS
  assert.equal(m.stats.tx, 0, 'nothing before the settle time');
  await sleep(80);
  assert.equal(m.stats.tx, 1);
  assert.equal(stored(m, '/save', '/save/score.dat').contents.length, 16030);
  assert.deepEqual(m.states, ['pending', 'saving', 'saved']);
  assert.equal(m.tracker.view().flushes, 1);
});

test('no flush, not even an explicit one, while a writable save file is open', async () => {
  const m = await tracked();
  const replay = m.FS.open('./replay/th8_01.rpy', 33345);
  m.FS.close(m.FS.open('th08.cfg', 33345));
  m.FS.close(m.FS.open('score.dat', 32768));               // reading is not a change
  await sleep(80);
  await m.tracker.flush();                                  // visibility hidden while the game writes
  assert.equal(m.stats.tx, 0, 'the replay is still being written');
  assert.equal(m.tracker.view().openWriters, 1);
  m.FS.write(replay, new Uint8Array(3), 0, 3, 0);
  m.FS.close(replay);
  await sleep(80);
  assert.equal(m.stats.tx, 2, 'one flush: one transaction each for /save and /game/replay');
  assert.equal(stored(m, '/game/replay', '/game/replay/th8_01.rpy').contents.length, 3);
});

test('renames, deletions and new dirs under a save mount are changes, resolved from the cwd', async () => {
  const m = await tracked();
  m.FS.chdir('/game/backup');
  m.FS.writeFile('/game/backup/score_4.261107.bak', new Uint8Array(3));
  await sleep(80);
  assert.ok(stored(m, '/game/backup', '/game/backup/score_4.261107.bak'));
  m.FS.rename('score_4.261107.bak', 'score_5.261107.bak');
  m.FS.chdir('/game');
  m.FS.mkdir('../tmp-not-saved');
  await sleep(80);
  assert.ok(stored(m, '/game/backup', '/game/backup/score_5.261107.bak'));
  assert.ok(!stored(m, '/game/backup', '/game/backup/score_4.261107.bak'), 'the old name is deleted');
  m.FS.unlink('./backup/score_5.261107.bak');
  m.FS.mkdir('./snapshot/new');
  await sleep(80);
  assert.ok(!stored(m, '/game/backup', '/game/backup/score_5.261107.bak'));
  assert.ok(stored(m, '/game/snapshot', '/game/snapshot/new'));
  const before = m.stats.tx;
  m.FS.symlink('/x', '/game/not-a-mount-link');
  await sleep(80);
  assert.equal(m.stats.tx, before, 'a link in /game is no change');
  assert.equal(TH08Saves.resolve(m.FS, './replay/../score.dat'), '/game/score.dat');
});

test('the game rewriting a file during a flush cannot tear what is stored', async () => {
  const m = await tracked({ remoteDelay: 40 });
  m.FS.writeFile('/save/score.dat', new Uint8Array(100).fill(1));
  await sleep(45);                                          // flush 1 copied the tree, waits for IndexedDB
  const s = m.FS.open('score.dat', 32833);                  // rewrites in place, no O_TRUNC, like MEMFS when the data fits
  m.FS.write(s, new Uint8Array(10).fill(2), 0, 10, 0);
  await sleep(60);
  assert.deepEqual([...stored(m, '/save', '/save/score.dat').contents.slice(0, 3)], [1, 1, 1]);
  assert.equal(stored(m, '/save', '/save/score.dat').contents.length, 100, 'the complete old file, not a torn one');
  m.FS.write(s, new Uint8Array(90).fill(2), 0, 90, 10);
  m.FS.close(s);
  await sleep(150);
  assert.equal(stored(m, '/save', '/save/score.dat').contents.length, 100);
  assert.equal(stored(m, '/save', '/save/score.dat').contents[0], 2, 'the new file once it is closed');
});

test('a lock stops the flush that is running: a late answer starts no transaction', async () => {
  const m = await tracked({ remoteDelay: 30 });
  TH08Saves.timeoutMs = 40;
  m.FS.writeFile('/save/score.dat', new Uint8Array(4));
  m.FS.writeFile('/game/replay/th8_01.rpy', new Uint8Array(4));
  await sleep(200);                                         // /save answers at ~30 ms and commits; /game/replay's answer is past the deadline
  assert.equal(m.tracker.view().state, 'locked');
  assert.equal(m.stats.tx, 1, 'no transaction for the remaining mounts after the lock');
  assert.equal(m.stats.committed, 1);
  assert.ok(!m.db['/game/replay'].get('/game/replay/th8_01.rpy'));
});

test('a duplicated stream cannot make the writer count negative', async () => {
  const m = await tracked();
  const s = m.FS.open('score.dat', 33345);
  const dup = Object.assign({}, s);                         // FS.dupStream copies the stream's properties
  m.FS.close(dup);
  m.FS.close(s);
  assert.equal(m.tracker.view().openWriters, 0);
  m.FS.writeFile('/save/score.txt', new Uint8Array(1));
  const w = m.FS.open('score.dat', 33345);
  assert.equal(m.tracker.view().openWriters, 1);
  m.FS.close(w);
});

test('flushes never overlap: a change during a flush gets its own flush afterwards', async () => {
  const m = await tracked({ txDelay: 40 });
  m.FS.writeFile('/save/score.dat', new Uint8Array(4));
  await sleep(45);                                          // first flush in its transaction
  m.FS.writeFile('/game/replay/th8_02.rpy', new Uint8Array(4));
  await m.tracker.flush();                                  // an explicit one queued too
  await sleep(150);
  assert.equal(m.stats.maxTxOpen, 1);
  assert.ok(stored(m, '/game/replay', '/game/replay/th8_02.rpy'));
  assert.equal(m.tracker.view().state, 'saved');
  assert.equal(m.tracker.view().flushes, 2);
});

test('a flush that times out locks saving for the session; no flush is started after the lock', async () => {
  const m = await tracked({ remoteDelay: Infinity });
  TH08Saves.timeoutMs = 40;
  m.FS.writeFile('/save/score.dat', new Uint8Array(4));
  await sleep(120);
  const v = m.tracker.view();
  assert.deepEqual([v.locked, v.state], [true, 'locked']);
  assert.match(v.error, /no answer after 40 ms/);
  m.FS.writeFile('/save/score.dat', new Uint8Array(5));
  await m.tracker.flush();
  await sleep(80);
  assert.equal(m.pending.length, 1, 'no flush after the lock');
  m.pending.forEach((answer) => answer());
  await sleep(30);
  assert.equal(m.tracker.view().state, 'locked', 'a late answer changes nothing');
});

test('any IndexedDB error locks saving too (no retry that could overlap)', async () => {
  const m = await tracked({ txError: true });
  m.FS.writeFile('/save/score.dat', new Uint8Array(4));
  await sleep(80);
  assert.deepEqual([m.tracker.view().state, m.tracker.view().error], ['locked', 'QuotaExceededError']);
  m.FS.writeFile('/save/score.txt', new Uint8Array(4));
  await sleep(80);
  assert.equal(m.stats.tx, 1);
});

test('an explicit flush runs at once; with nothing changed it writes nothing', async () => {
  const m = await tracked();
  await m.tracker.flush();
  assert.equal(m.stats.tx, 0);
  m.FS.writeFile('/save/score.dat', new Uint8Array(4));
  const v = await m.tracker.flush();
  assert.equal(v.state, 'saved');
  assert.equal(m.stats.tx, 1);
  await sleep(80);
  assert.equal(m.stats.tx, 1, 'the settle timer was cancelled');
});

test('options changed in game memory are written to th08.cfg and flushed', async () => {
  const m = await tracked();
  m.HEAPU8.subarray(1000, 1060).fill(7);
  const s = m.FS.open('th08.cfg', 33345);                 // the game's write at start, from its heap
  m.FS.write(s, m.HEAPU8, 1000, 60, 0);
  assert.equal(m.tracker.checkConfig(), false, 'never while th08.cfg is open for writing');
  m.FS.close(s);
  await sleep(80);
  assert.equal(m.tracker.view().cfgPtr, 1000);
  assert.equal(m.tracker.checkConfig(), false, 'unchanged: nothing to write');
  m.HEAPU8[1028] = 3;                                       // lifeCount changed in the Option menu
  assert.equal(m.tracker.checkConfig(), true);
  assert.equal(m.FS.readFile('/save/th08.cfg')[28], 3);
  assert.equal(m.tracker.view().cfgPtr, 1000, 'its own write does not move the pointer');
  await sleep(80);
  assert.equal(stored(m, '/save', '/save/th08.cfg').contents[28], 3);
  m.FS.writeFile('/save/th08.cfg', new Uint8Array(59));     // not from the heap, and not 60 bytes
  assert.equal(m.tracker.view().cfgPtr, 1000);
  assert.equal(m.tracker.checkConfig(), false, 'a th08.cfg of another size is left alone');
});

test('the configuration is left alone before the game wrote th08.cfg or with a pointer out of the heap', async () => {
  const m = await tracked();
  assert.equal(m.tracker.checkConfig(), false);
  const s = m.FS.open('th08.cfg', 33345);
  m.FS.write(s, m.HEAPU8, 4090, 60, 0);                     // a range past the heap's end
  m.FS.close(s);
  assert.equal(m.tracker.checkConfig(), false);
  assert.equal(m.calls.filter((c) => c[0] === 'open').length, 1, 'only the game\'s own open');
});

test('one failing write rolls the whole mount back: it keeps the previous generation', async () => {
  for (const failure of ['failPut', 'throwPut']) {
    const m = await tracked({});
    m.FS.writeFile('/save/score.dat', new Uint8Array(4).fill(1));
    m.FS.writeFile('/save/score.txt', new Uint8Array(4).fill(1));
    await sleep(80);
    m.opts[failure] = '/save/score.txt';                     // sorted after score.dat: its put comes second
    m.FS.writeFile('/save/score.dat', new Uint8Array(4).fill(2));
    m.FS.writeFile('/save/score.txt', new Uint8Array(4).fill(2));
    await sleep(80);
    assert.equal(stored(m, '/save', '/save/score.dat').contents[0], 1, failure + ': score.dat is not half-new');
    assert.equal(stored(m, '/save', '/save/score.txt').contents[0], 1, failure);
    assert.equal(m.tracker.view().state, 'locked', failure);
  }
});
