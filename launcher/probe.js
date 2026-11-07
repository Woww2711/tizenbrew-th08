'use strict';
// Milestone-1 probe (v0.0.3). (1) Does th08-web's save storage (IDBFS in IndexedDB) survive
// a reload, a power cut and a module update at the stable path <DATA>/th08/build/launcher.html?
// Every run first reads the probe record from /save (and says whether a record of an earlier
// version, 0.0.2, came through the update), then writes it back with the count + 1 and waits
// until IndexedDB has it. (2) Can the game data copied from the PC be read through the
// service the way the runtime reads it (RemoteFile)? Shown here and sent to /report.
var PAGE_VERSION = '0.0.3';
var SERVICE = 'http://127.0.0.1:8790';
var PROBE_FILE = '/save/tv-probe.json';
var service = null;   // the last /status answer

function show(id, text) { document.getElementById(id).textContent = text; }

// Settles with `promise`, or rejects after `ms` (and aborts `ctrl` if given).
function withTimeout(promise, ms, what, ctrl) {
  var timer;
  var timeout = new Promise(function (resolve, reject) {
    timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
      reject(new Error(what + ': no answer after ' + ms + ' ms'));
    }, ms);
  });
  promise.catch(function () {});
  return Promise.race([promise, timeout]).then(function (v) { clearTimeout(timer); return v; },
    function (e) { clearTimeout(timer); throw e; });
}

// `read` consumes the response inside the same time bound (e.g. r.json()).
function serviceFetch(pathname, init, ms, read) {
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  init = init || {};
  if (ctrl) init.signal = ctrl.signal;
  var work = fetch(SERVICE + pathname, init);
  if (read) work = work.then(read);
  return withTimeout(work, ms, pathname, ctrl);
}

// Shows a row at once; sending it to the service is bounded and never blocks the probe.
function row(check, ok, detail, data) {
  var tr = document.createElement('tr');
  tr.className = ok ? 'ok' : 'fail';
  [check, ok ? 'ĐẠT' : 'LỖI', detail, ''].forEach(function (text) {
    var td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
  });
  document.getElementById('rows').appendChild(tr);
  serviceFetch('/report', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'probe', version: PAGE_VERSION, check: check, ok: ok, detail: detail, data: data })
  }, 3000).then(function (res) {
    if (res.status !== 204) throw new Error('HTTP ' + res.status);
  }).catch(function (e) { tr.lastChild.textContent = '(chưa gửi được báo cáo: ' + e.message + ')'; });
}

function mb(bytes) { return (bytes / 1048576).toFixed(0) + ' MB'; }

function checkService() {
  return serviceFetch('/status', {}, 5000, function (r) { return r.json(); }).then(function (s) {
    service = s;
    var sameVersion = s.version === PAGE_VERSION;
    var onTv = location.protocol === 'file:';
    var stableUrl = !onTv || s.launcherUrl === location.href;
    var t = s.takeover ? ' · thay service cũ: ' + (s.takeover.from || '?') + ' → ' + s.takeover.result : '';
    row('Service', sameVersion && stableUrl, 'bản ' + s.version + ' (trang ' + PAGE_VERSION + '), ' + s.state +
      ', chạy từ ' + s.startedAt + ', node ' + s.node + t, { version: s.version, state: s.state,
      startedAt: s.startedAt, node: s.node, launcherUrl: s.launcherUrl, href: location.href, takeover: s.takeover });
    if (!sameVersion) {
      row('Service cũ', false, 'Service đang chạy là bản ' + s.version + '. Rút điện TV 1 phút rồi mở lại module.');
    }
    if (!stableUrl) row('Đường dẫn', false, 'trang ở ' + location.href + ', service chờ ' + s.launcherUrl);
    var d = s.disk;
    if (!d) row('Dung lượng', false, 'service chưa đo');
    else if (d.error) row('Dung lượng', false, d.method + ': ' + d.error, d);
    else row('Dung lượng', true, 'còn trống ' + mb(d.free) + ' / ' + mb(d.total) + ' (' + d.method + ', ' + d.path + ')', d);
  }).catch(function (e) {
    row('Service', false, 'không trả lời: ' + e.message);
  });
}

// Loads the th08-web runtime (no game data): its FS and IDBFS are what the game saves with.
function loadRuntime() {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('no onRuntimeInitialized after 60 s')); }, 60000);
    window.Module = {
      noInitialRun: true,
      canvas: document.getElementById('canvas'),
      print: function (t) { console.log(t); },
      printErr: function (t) { console.warn(t); },
      onAbort: function (what) { clearTimeout(timer); reject(new Error('abort: ' + what)); },
      onRuntimeInitialized: function () { clearTimeout(timer); resolve(window.Module); }
    };
    var script = document.createElement('script');
    script.src = 'th08-web.js';
    script.onerror = function () { clearTimeout(timer); reject(new Error('cannot load th08-web.js')); };
    document.body.appendChild(script);
  });
}

function isCount(n) { return typeof n === 'number' && isFinite(n) && n >= 1 && Math.floor(n) === n; }

// Reads and validates the probe record: { record } | { missing: true } | { error }.
// Only ENOENT means "no record yet"; anything else must not be mistaken for a first run.
function readRecord(FS, file) {
  var text, rec, i;
  try {
    text = FS.readFile(file, { encoding: 'utf8' });
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.errno === 44)) return { missing: true };
    return { error: 'đọc lỗi: ' + ((e && e.message) || e) };
  }
  try { rec = JSON.parse(text); } catch (e2) { return { error: 'JSON hỏng: ' + e2.message }; }
  if (!rec || typeof rec !== 'object' || !isCount(rec.count) || typeof rec.at !== 'string' ||
      typeof rec.version !== 'string' || !Array.isArray(rec.history)) {
    return { error: 'bản ghi sai cấu trúc' };
  }
  for (i = 0; i < rec.history.length; i++) {
    if (!rec.history[i] || typeof rec.history[i] !== 'object' || !isCount(rec.history[i].count)) {
      return { error: 'lịch sử sai cấu trúc' };
    }
  }
  return { record: rec };
}

// The version whose probe record must come through the module update to this one.
var UPDATE_FROM = '0.0.2';

function isEntryOf(h, version) {
  return !!h && typeof h === 'object' && h.version === version && isCount(h.count) && typeof h.at === 'string';
}

// Did the record written by `fromVersion` come through the module update? Resolves
// { ok, detail, from } where `from` is that version's last well-formed entry; a record
// that already confirmed it keeps it as `updatedFrom` (checked the same way).
function updateCheck(before, fromVersion) {
  if (!before) {
    return { ok: false, from: null, detail: 'không có bản ghi: save của bản ' + fromVersion + ' đã mất (hoặc bản đó chưa chạy trên TV này)' };
  }
  var u = before.updatedFrom;
  if (isEntryOf(u, fromVersion)) {
    return { ok: true, from: { version: u.version, count: u.count, at: u.at },
      detail: 'đã xác nhận ở lần trước: bản ghi của bản ' + u.version + ' (lần ' + u.count + ') còn sau cập nhật' };
  }
  for (var i = before.history.length - 1; i >= 0; i--) {
    var h = before.history[i];
    if (isEntryOf(h, fromVersion)) {
      return { ok: true, from: { version: h.version, count: h.count, at: h.at },
        detail: 'đọc được bản ghi do bản ' + h.version + ' ghi: lần ' + h.count + ' lúc ' + h.at + ' (đọc trước khi ghi lần này)' };
    }
  }
  return { ok: false, from: null, detail: 'bản ghi không có lần mở nào của bản ' + fromVersion };
}

function describe(rec) {
  return 'lần ' + rec.count + ' lúc ' + rec.at + ' (bản ' + rec.version + ')';
}

function probe(Module) {
  var t0 = Date.now(), before = null, record = null;
  return TH08Saves.prepare(Module).then(function (saves) {
    var read = saves.available ? readRecord(Module.FS, PROBE_FILE) : { missing: true };
    before = read.record || null;
    row('Đọc save', saves.available && !read.error, !saves.available
      ? 'IndexedDB không dùng được: ' + saves.error
      : read.error ? 'bản ghi ' + PROBE_FILE + ' không đọc được, KHÔNG ghi đè: ' + read.error
      : (before ? 'đọc được ' + describe(before) : 'chưa có bản ghi (lần mở đầu tiên, hoặc dữ liệu đã mất)') +
        ' · ' + (Date.now() - t0) + ' ms', { saves: saves, record: before, error: read.error || null });
    if (!saves.available) throw new Error('no persistent storage: ' + saves.error);
    if (read.error) throw new Error('unreadable probe record: ' + read.error);
    var upd = updateCheck(before, UPDATE_FROM);
    row('Save qua cập nhật', upd.ok, upd.detail, { from: upd.from });
    var entry = { count: (before ? before.count : 0) + 1, at: new Date().toISOString(), version: PAGE_VERSION,
      serviceStartedAt: service ? service.startedAt : null };
    var history = (before && before.history ? before.history.slice(-9) : []).concat([entry]);
    record = { count: entry.count, at: entry.at, version: entry.version, history: history, updatedFrom: upd.from };
    Module.FS.writeFile(PROBE_FILE, JSON.stringify(record));
    t0 = Date.now();
    return TH08Saves.flush(Module);
  }).then(function () {
    row('Ghi save', true, 'đã ghi lần ' + record.count + ', IndexedDB xác nhận sau ' + (Date.now() - t0) + ' ms',
      { record: record });
    show('summary', 'Lần mở thứ ' + record.count + '. ' +
      (before ? 'Lần trước: ' + describe(before) + '.' : 'Không có lần trước.'));
    show('history', 'Lịch sử (mới nhất cuối, giờ UTC):\n' + record.history.map(function (h) {
      return '  #' + h.count + '  ' + h.at + '  bản ' + h.version + '  service từ ' + h.serviceStartedAt;
    }).join('\n'));
  }, function (e) {
    if (record) row('Ghi save', false, 'IndexedDB báo lỗi khi ghi: ' + e);
    show('summary', 'Không lưu được: ' + e.message);
  });
}

function hex(buf) {
  return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
}

// SHA-256 as hex, or null where crypto.subtle is missing.
function digest(buf) {
  if (typeof crypto !== 'object' || !crypto || !crypto.subtle) return Promise.resolve(null);
  return crypto.subtle.digest('SHA-256', buf).then(hex);
}

var CHUNK = 65536;

// Reads the game data through the service the way the runtime will: th08.dat whole
// (RemoteFile.arrayBuffer, HTTP 200 and the exact size) and thbgm.dat in 64 KiB ranges
// (RemoteFile.slice, HTTP 206, Content-Range and the byte count checked by RemoteFile).
// `RF` is RemoteFile, `files` the service's [{ name, size, sha256 }]. Resolves the rows.
function dataChecks(RF, serviceUrl, files, now) {
  var rows = [], f = {};
  files.forEach(function (x) { f[x.name] = x; });
  var bgm = new RF(serviceUrl, 'thbgm.dat', f['thbgm.dat'].size), size = f['thbgm.dat'].size;
  function timed(check, work, describeOk) {
    var t0 = now();
    return work().then(function (v) {
      var r = describeOk(v, Math.round(now() - t0));
      rows.push({ check: check, ok: r.ok, detail: r.detail, data: r.data });
    }, function (e) {
      rows.push({ check: check, ok: false, detail: String((e && e.message) || e) });
    });
  }
  function range(check, a, b) {
    return timed(check, function () { return bgm.slice(a, b).arrayBuffer(); }, function (buf, ms) {
      return { ok: true, detail: 'HTTP 206, byte ' + a + '–' + (b - 1) + ' / ' + size + ', ' + buf.byteLength + ' B trong ' + ms + ' ms',
        data: { start: a, end: b, ms: ms } };
    });
  }
  var mid = Math.floor(size / 2), burst = Math.min(16, Math.floor((size - mid) / CHUNK));
  return timed('th08.dat (toàn bộ)', function () {
    var th08 = f['th08.dat'];
    return new RF(serviceUrl, 'th08.dat', th08.size).arrayBuffer().then(function (buf) {
      return digest(buf).then(function (h) { return { bytes: buf.byteLength, hash: h, want: th08.sha256 }; });
    });
  }, function (v, ms) {
    var ok = v.hash === null || v.hash === v.want;
    return { ok: ok, data: { bytes: v.bytes, ms: ms, sha256: v.hash },
      detail: 'HTTP 200, ' + v.bytes + ' B trong ' + ms + ' ms, ' + (v.hash === null ? 'không có crypto.subtle (bỏ qua SHA-256)'
        : ok ? 'SHA-256 khớp' : 'SHA-256 KHÔNG khớp: ' + v.hash) };
  }).then(function () {
    return range('thbgm.dat đầu', 0, Math.min(CHUNK, size));
  }).then(function () {
    return range('thbgm.dat giữa', mid, Math.min(mid + CHUNK, size));
  }).then(function () {
    return range('thbgm.dat cuối', Math.max(size - CHUNK, 0), size);
  }).then(function () {
    return timed('thbgm.dat ' + burst + ' × 64 KiB liên tiếp', function () {
      var chain = Promise.resolve(0);
      for (var i = 0; i < burst; i++) {
        (function (a) {
          chain = chain.then(function (n) { return bgm.slice(a, a + CHUNK).arrayBuffer().then(function (b) { return n + b.byteLength; }); });
        })(mid + i * CHUNK);
      }
      return chain;
    }, function (n, ms) {
      return { ok: n === burst * CHUNK, data: { bytes: n, ms: ms },
        detail: n + ' B trong ' + ms + ' ms (' + (ms ? (n / 1048576 / (ms / 1000)).toFixed(1) : '∞') + ' MiB/s)' };
    });
  }).then(function () { return rows; });
}

function checkData() {
  var s = service;
  if (!s || !s.ready) {
    row('Dữ liệu game', false, s ? 'service chưa sẵn sàng: buildReady=' + s.buildReady + ', dataReady=' + s.dataReady
      : 'không có /status');
    return Promise.resolve();
  }
  row('Dữ liệu game', true, s.files.map(function (x) { return x.name + ' ' + x.size + ' B'; }).join(', '), { files: s.files });
  var now = function () { return performance.now(); };
  return dataChecks(RemoteFile, SERVICE, s.files, now).then(function (rows) {
    var passed = 0;
    rows.forEach(function (r) { row(r.check, r.ok, r.detail, r.data); if (r.ok) passed++; });
    var sum = document.getElementById('summary');
    sum.textContent += '\nDữ liệu qua service: ' + passed + '/' + rows.length + ' ĐẠT.';
  });
}

// Keys work from the start, so a hung step never traps the user on this page. Every step
// is bounded (status 5 s, runtime 60 s, IndexedDB TH08Saves.timeoutMs each way, each data
// read RemoteFile.timeoutMs).
function run() {
  show('ver', PAGE_VERSION);
  document.getElementById('hint').hidden = false;
  window.addEventListener('keydown', function (e) {
    if (e.keyCode === 13) location.reload();
    if (e.keyCode === 10009) history.back();
  });
  return checkService().then(loadRuntime).then(function (Module) {
    row('Runtime th08-web', true, 'onRuntimeInitialized; IDBFS=' + typeof Module.IDBFS);
    return probe(Module);
  }, function (e) {
    row('Runtime th08-web', false, e.message);
    show('summary', 'Runtime không nạp được: ' + e.message);
  }).then(checkData).catch(function (e) {
    show('summary', 'Lỗi không mong đợi: ' + ((e && e.message) || e));
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { readRecord: readRecord, updateCheck: updateCheck, dataChecks: dataChecks };
} else {
  run();
}
