'use strict';
// th08-web's save storage, as set up by upstream th08-web.html v0.1.0: IndexedDB-backed
// IDBFS mounts at /save and /game/{replay,backup,snapshot}, filled from IndexedDB once at
// start, retail archives removed from them, and /game/{th08.cfg,score.dat,score.txt} as
// links into /save. The launcher calls TH08Saves.prepare(Module) before the game starts.
var TH08Saves = (function () {
  var FILES = ['th08.cfg', 'score.dat', 'score.txt'];
  var DIRS = ['replay', 'backup', 'snapshot'];
  var RETAIL = ['th08.dat', 'thbgm.dat'];
  var MOUNTS = ['/save'].concat(DIRS.map(function (d) { return '/game/' + d; }));

  function ensureDir(FS, p) {
    try { FS.mkdir(p); } catch (e) { if (!FS.isDir(FS.stat(p).mode)) throw e; }
  }

  // syncfs with a deadline: a hung IndexedDB must not hang the launcher. A callback after
  // the deadline is ignored.
  function sync(FS, populate) {
    var ms = api.timeoutMs;
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        done = true;
        reject(new Error('IndexedDB: no answer after ' + ms + ' ms'));
      }, ms);
      FS.syncfs(populate, function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
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

  // Resolves { available, error, removedRetail, mounts }. Like upstream, storage errors do
  // not stop the game: saves then live in memory only (available false, error set).
  function prepare(Module) {
    var FS = Module.FS;
    var result = { available: false, error: null, removedRetail: false, mounts: MOUNTS };
    ensureDir(FS, '/game');
    ensureDir(FS, '/save');
    DIRS.forEach(function (d) { ensureDir(FS, '/game/' + d); });
    return Promise.resolve().then(function () {
      MOUNTS.forEach(function (m) { FS.mount(Module.IDBFS, { autoPersist: true }, m); });
      return sync(FS, true);
    }).then(function () {
      result.available = true;
    }, function (e) {
      result.error = String((e && e.message) || e);
    }).then(function () {
      result.removedRetail = MOUNTS.reduce(function (acc, m) { return removeRetail(FS, m) || acc; }, false);
      FILES.forEach(function (f) { FS.symlink('/save/' + f, '/game/' + f); });
      return result;
    });
  }

  // Writes every mount to IndexedDB; resolves when IndexedDB has it.
  function flush(Module) {
    return sync(Module.FS, false);
  }

  var api = { prepare: prepare, flush: flush, MOUNTS: MOUNTS, timeoutMs: 10000 };
  return api;
})();

if (typeof module === 'object' && module.exports) module.exports = TH08Saves;
