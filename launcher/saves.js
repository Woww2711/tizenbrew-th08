'use strict';
// th08-web's save storage, laid out as upstream th08-web.html v0.1.0 does: IndexedDB-backed
// IDBFS mounts at /save and /game/{replay,backup,snapshot}, retail archives removed from them,
// /game/{th08.cfg,score.dat,score.txt} as links into /save. Unlike upstream there is no
// autoPersist (it can push a half-loaded tree to IndexedDB): the game only starts once the
// mounts are filled from IndexedDB, and track() writes them back explicitly, one flush at a
// time, from a copy taken while no save file is open (see the M1b runtime study).
var TH08Saves = (function () {
  var FILES = ['th08.cfg', 'score.dat', 'score.txt'];
  var DIRS = ['replay', 'backup', 'snapshot'];
  var RETAIL = ['th08.dat', 'thbgm.dat'];
  var MOUNTS = ['/save'].concat(DIRS.map(function (d) { return '/game/' + d; }));
  // The game reads th08.cfg once at start and writes it back from g_Supervisor.cfg (60 bytes)
  // only then: th08-web never runs the native exit path that saves changed options.
  var CONFIG = '/save/th08.cfg';
  var CONFIG_SIZE = 60;

  function ensureDir(FS, p) {
    try { FS.mkdir(p); } catch (e) { if (!FS.isDir(FS.stat(p).mode)) throw e; }
  }

  // run(cb) with a deadline: a hung IndexedDB must not hang the launcher. A callback after
  // the deadline is ignored; the error then carries timeout: true.
  function deadline(run) {
    var ms = api.timeoutMs;
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        done = true;
        var e = new Error('IndexedDB: no answer after ' + ms + ' ms');
        e.timeout = true;
        reject(e);
      }, ms);
      run(function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err instanceof Error ? err : new Error(String((err && err.message) || err))); else resolve();
      });
    });
  }

  function entries(FS, dir) {
    return FS.readdir(dir).filter(function (n) { return n !== '.' && n !== '..'; });
  }

  function removeTree(FS, dir) {
    entries(FS, dir).forEach(function (n) {
      var p = dir + '/' + n;
      if (FS.isDir(FS.lstat(p).mode)) { removeTree(FS, p); FS.rmdir(p); } else FS.unlink(p);
    });
  }

  // Game data must never land in browser storage; true if something was removed.
  function removeRetail(FS, dir) {
    var removed = false;
    entries(FS, dir).forEach(function (n) {
      var p = dir + '/' + n, isDir = FS.isDir(FS.lstat(p).mode);
      if (RETAIL.indexOf(n.toLowerCase()) >= 0) {
        if (isDir) { removeTree(FS, p); FS.rmdir(p); } else FS.unlink(p);
        removed = true;
      } else if (isDir) {
        removed = removeRetail(FS, p) || removed;
      }
    });
    return removed;
  }

  // Resolves { removedRetail, mounts } once every mount holds what IndexedDB has. Rejects if
  // IndexedDB fails or does not answer: the launcher must then not start the game (a game
  // writing over an empty tree could later replace the real saves).
  function prepare(Module) {
    var FS = Module.FS;
    ensureDir(FS, '/game');
    ensureDir(FS, '/save');
    DIRS.forEach(function (d) { ensureDir(FS, '/game/' + d); });
    return Promise.resolve().then(function () {
      MOUNTS.forEach(function (m) { FS.mount(Module.IDBFS, {}, m); });
      return deadline(function (cb) { FS.syncfs(true, cb); });
    }).then(function () {
      var removed = MOUNTS.reduce(function (acc, m) { return removeRetail(FS, m) || acc; }, false);
      FILES.forEach(function (f) { FS.symlink('/save/' + f, '/game/' + f); });
      return { removedRetail: removed, mounts: MOUNTS };
    });
  }

  function isSavePath(p) {
    return typeof p === 'string' && MOUNTS.some(function (m) { return p === m || p.indexOf(m + '/') === 0; });
  }

  // The absolute path an FS call names: relative to the cwd, parent links and . / .. resolved.
  // Unknown → '' (not a save path); a node (ftruncate) → its path.
  function resolve(FS, p) {
    try {
      if (typeof p !== 'string') return p && typeof FS.getPath === 'function' ? FS.getPath(p) : '';
      var abs = p.charAt(0) === '/' ? p : FS.cwd().replace(/\/$/, '') + '/' + p;
      var cut = abs.replace(/\/+$/, '').lastIndexOf('/');
      var dir = abs.slice(0, cut) || '/', base = abs.slice(cut + 1).replace(/\/+$/, '');
      dir = FS.lookupPath(dir, { follow: true }).path;
      if (base === '.' || base === '') return dir;
      if (base === '..') return dir.slice(0, dir.lastIndexOf('/')) || '/';
      return (dir === '/' ? '' : dir) + '/' + base;
    } catch (e) {
      return '';
    }
  }

  function same(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // A copy of one mount's tree, taken synchronously (the game cannot run an FS call in
  // between): IDBFS's own walk and entry format, with the file bytes copied.
  function snapshot(FS, IDBFS, mountpoint) {
    var mount = FS.lookupPath(mountpoint, { follow: true }).node.mount;
    var local = null, entries = {};
    IDBFS.getLocalSet(mount, function (e, set) { if (e) throw e; local = set; });
    Object.keys(local.entries).forEach(function (p) {
      IDBFS.loadLocalEntry(p, function (e, entry) {
        if (e) throw e;
        if (entry.contents) entry.contents = new Uint8Array(entry.contents);
        entries[p] = entry;
      });
    });
    return { mount: mount, entries: entries };
  }

  // Writes a snapshot to its mount's IndexedDB store in one transaction: entries that are new,
  // have another time or were touched since the last flush are put, entries gone are deleted.
  // All or nothing: any failing request, or an exception while queueing, aborts the whole
  // transaction, so the mount keeps its previous generation.
  function persist(IDBFS, snap, touched, cb, live) {
    IDBFS.getRemoteSet(snap.mount, function (err, remote) {
      if (err) return cb(err);
      if (live && !live()) return;                  // the flush was cancelled (locked): no new transaction
      var put = Object.keys(snap.entries).filter(function (p) {
        var r = remote.entries[p];
        return !r || touched[p] || r.timestamp.getTime() !== snap.entries[p].timestamp.getTime();
      });
      var gone = Object.keys(remote.entries).filter(function (p) { return !snap.entries[p]; });
      if (!put.length && !gone.length) return cb(null);
      var finished = false, tx = null;
      function end(e) { if (!finished) { finished = true; cb(e || null); } }
      function fail(e) {
        try { if (tx) tx.abort(); } catch (x) { /* already finished or aborting */ }
        end(e || new Error('IndexedDB transaction failed'));
      }
      function watch(req) {
        req.onerror = function (e) { fail(e && e.target && e.target.error); };
      }
      try {
        tx = remote.db.transaction([IDBFS.DB_STORE_NAME], 'readwrite');
        var store = tx.objectStore(IDBFS.DB_STORE_NAME);
        tx.oncomplete = function () { end(null); };
        tx.onerror = tx.onabort = function (e) { fail((e && e.target && e.target.error) || (tx && tx.error)); };
        put.sort().forEach(function (p) { watch(store.put(snap.entries[p], p)); });
        gone.sort().reverse().forEach(function (p) { watch(store['delete'](p)); });
      } catch (e) {
        fail(e);
      }
    });
  }

  // Watches every change the game makes under the save mounts (all its file calls run on
  // this thread: Emscripten proxies them from the game's pthread) and flushes settleMs after
  // the last one. A flush runs only while no save file is open for writing (checked when it
  // runs, also for an explicit flush): it copies the mounts at once, then writes the copy, so
  // the game can write again meanwhile. Flushes run one at a time, mounts one after another.
  // Any error or a timeout locks saving for the rest of the session. onState(view) hears it.
  function track(Module, onState) {
    var FS = Module.FS;
    var orig = {};
    var t = { state: 'idle', dirty: false, openWriters: 0, locked: false, savedAt: null, lastMs: null,
      error: null, flushes: 0, cfgPtr: 0, cfgWrites: 0 };
    var timer = null, chain = Promise.resolve(), mirroring = false;
    var touched = {}, openPaths = {}, writers = [];

    function view() {
      return { state: t.state, dirty: t.dirty, openWriters: t.openWriters, locked: t.locked, savedAt: t.savedAt,
        lastMs: t.lastMs, error: t.error, flushes: t.flushes, cfgPtr: t.cfgPtr, cfgWrites: t.cfgWrites };
    }
    function emit() {
      if (typeof onState !== 'function') return;
      try { onState(view()); } catch (e) { /* the page's handler must not break the game's FS call */ }
    }
    function schedule() {
      if (t.locked) return;
      clearTimeout(timer);
      timer = setTimeout(flush, api.settleMs);
    }
    function mark(paths) {
      if (t.locked) return;
      paths.forEach(function (p) { touched[p] = true; });
      t.dirty = true;
      if (t.state !== 'saving') { t.state = 'pending'; emit(); }
      schedule();
    }
    function lock(e) {
      t.locked = true;
      t.state = 'locked';
      t.error = String((e && e.message) || e);
      clearTimeout(timer);
      emit();
      return view();
    }
    function runOnce() {
      if (t.locked || !t.dirty) return view();
      if (t.openWriters > 0) { schedule(); return view(); }      // the game is writing: later
      var snaps, mine = touched;
      try {
        snaps = MOUNTS.map(function (m) { return snapshot(FS, Module.IDBFS, m); });
      } catch (e) {
        return lock(e);
      }
      touched = {};
      t.dirty = false;
      t.state = 'saving';
      emit();
      var t0 = Date.now(), cancelled = false;
      function live() { return !cancelled && !t.locked; }
      return deadline(function (cb) {
        (function next(i) {
          if (!live()) return;
          if (i === snaps.length) return cb(null);
          persist(Module.IDBFS, snaps[i], mine, function (err) { if (err) cb(err); else next(i + 1); }, live);
        })(0);
      }).then(function () {
        t.flushes++;
        t.savedAt = Date.now();
        t.lastMs = t.savedAt - t0;
        t.state = t.dirty ? 'pending' : 'saved';
        emit();
        return view();
      }, function (e) { cancelled = true; return lock(e); });
    }
    // Queues one flush after any running one; resolves with the state after it.
    function flush() {
      clearTimeout(timer);
      timer = null;
      chain = chain.then(runOnce);
      return chain;
    }

    orig.open = FS.open;
    FS.open = function () {
      var stream = orig.open.apply(FS, arguments);
      if (stream && (stream.flags & 3) !== 0 && isSavePath(stream.path)) {
        writers.push(stream);                  // by identity: a dup'd stream copy is not counted twice
        t.openWriters = writers.length;
        openPaths[stream.path] = (openPaths[stream.path] || 0) + 1;
      }
      return stream;
    };
    orig.close = FS.close;
    FS.close = function (stream) {
      var at = stream ? writers.indexOf(stream) : -1, counted = at >= 0;
      try {
        return orig.close.apply(FS, arguments);
      } finally {
        if (counted) {
          writers.splice(at, 1);
          t.openWriters = writers.length;
          openPaths[stream.path]--;
          mark([stream.path]);
        }
      }
    };
    orig.write = FS.write;
    FS.write = function (stream, buffer, offset, length) {
      var n = orig.write.apply(FS, arguments);
      // The game writes th08.cfg straight from g_Supervisor.cfg in its heap: remember where.
      if (!mirroring && stream && stream.path === CONFIG && length === CONFIG_SIZE && buffer &&
          Module.HEAPU8 && buffer.buffer === Module.HEAPU8.buffer) {
        t.cfgPtr = buffer.byteOffset + offset;
      }
      return n;
    };
    ['rename', 'unlink', 'rmdir', 'mkdir', 'symlink', 'truncate'].forEach(function (name) {
      orig[name] = FS[name];
      FS[name] = function () {
        var args = arguments;
        var named = name === 'rename' ? [args[0], args[1]] : name === 'symlink' ? [args[1]] : [args[0]];
        var hits = named.map(function (p) { return resolve(FS, p); }).filter(isSavePath);
        var result = orig[name].apply(FS, args);
        if (hits.length) mark(hits);
        return result;
      };
    });

    // Writes the game's live configuration to th08.cfg when it differs (an option changed).
    // Only from the heap range the game itself wrote th08.cfg from, never while the file is
    // open for writing, and only over a 60-byte th08.cfg. True if it wrote.
    function checkConfig() {
      var heap = Module.HEAPU8;
      if (!t.cfgPtr || t.locked || !heap || t.cfgPtr + CONFIG_SIZE > heap.length || openPaths[CONFIG] > 0) return false;
      var file = null;
      try { file = FS.readFile(CONFIG); } catch (e) { return false; }
      if (file.length !== CONFIG_SIZE) return false;
      var live = heap.slice(t.cfgPtr, t.cfgPtr + CONFIG_SIZE);
      if (same(file, live)) return false;
      mirroring = true;
      try { FS.writeFile(CONFIG, live); } finally { mirroring = false; }
      t.cfgWrites++;
      return true;
    }

    return { flush: flush, checkConfig: checkConfig, view: view };
  }

  var api = { prepare: prepare, track: track, isSavePath: isSavePath, resolve: resolve, MOUNTS: MOUNTS,
    CONFIG: CONFIG, timeoutMs: 10000, settleMs: 1000 };
  return api;
})();

if (typeof module === 'object' && module.exports) module.exports = TH08Saves;
