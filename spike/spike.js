'use strict';
// Milestone 0 checks (spec §4). Each result is shown and sent to the service's /report.
var SERVICE = 'http://127.0.0.1:8790';
var SYNTHETIC_SIZE = 1048576;
var results = [];

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

// Shows the row at once; sending it to the service is bounded and never blocks the checks.
function report(check, ok, detail) {
  results.push(ok);
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
    body: JSON.stringify({ source: 'spike', check: check, ok: ok, detail: detail })
  }, 3000).then(function (res) {
    if (res.status !== 204) throw new Error('HTTP ' + res.status);
  }).catch(function (e) { tr.lastChild.textContent = '(chưa gửi được báo cáo: ' + e.message + ')'; });
  return Promise.resolve(ok);
}

function checkIsolation() {
  var ok = self.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
  return report('1 cross-origin isolation', ok,
    'crossOriginIsolated=' + self.crossOriginIsolated + ', SharedArrayBuffer=' + typeof SharedArrayBuffer);
}

function checkGraphics() {
  var gl = document.createElement('canvas').getContext('webgl2');
  var ok = !!gl && typeof OffscreenCanvas === 'function';
  return report('4 WebGL 2 + OffscreenCanvas', ok, 'webgl2=' + !!gl + ', OffscreenCanvas=' + typeof OffscreenCanvas);
}

// Row 7. On the TV (file://) the service must have opened this page, so openMethod is
// required too; the service records it right after Page.navigate answers, so allow ~3 s.
// A page opened by hand in a desktop browser has no open method.
function checkService() {
  var onTv = location.protocol === 'file:';
  var tries = 0;
  function attempt() {
    tries++;
    return serviceFetch('/status', {}, 5000, function (r) {
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (s) {
      var opened = s.openMethod === 'devtools' || s.openMethod === 'launchUrl';
      if (onTv && !opened && tries < 6) {
        return new Promise(function (resolve) { setTimeout(resolve, 500); }).then(attempt);
      }
      var ok = !!s.dataDir && typeof s.node === 'string' && typeof s.version === 'string' && (opened || !onTv);
      return report('7 service status', ok, 'dataDir=' + s.dataDir + ', node=' + s.node + ', open=' +
        s.openMethod + ', version=' + s.version + (onTv ? '' : ' (desktop: open method not required)'));
    });
  }
  return attempt().catch(function (e) { return report('7 service status', false, String(e)); });
}

// Reads [start, start+length) of `file` on this thread and hands it to a waiting worker
// through shared memory, like the runtime's music reader. Resolves with the worker's verdict
// plus timings: ms (whole run, worker start included), readMs (until the read settled and
// the worker was notified), ackMs (from that notify to the worker's answer) and wakeMs
// (from the read starting to the worker's answer). A watchdog
// ends the run if the worker never answers.
function sharedRead(file, start, length, timeoutMs) {
  return new Promise(function (resolve) {
    var t0 = Date.now(), notifiedAt = null, readStartAt = null, done = false;
    var sab = new SharedArrayBuffer(8 + length);
    var status = new Int32Array(sab, 0, 1);
    var worker = new Worker('worker.js');
    var watchdog = setTimeout(function () {
      finish({ ok: false, value: Atomics.load(status, 0), why: 'watchdog: no answer from the worker' });
    }, timeoutMs + 3000);
    function finish(r) {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      worker.terminate();
      r.ms = Date.now() - t0;
      r.readMs = notifiedAt === null ? null : notifiedAt - t0;
      r.ackMs = notifiedAt === null ? null : Date.now() - notifiedAt;
      r.wakeMs = readStartAt === null ? null : Date.now() - readStartAt;
      resolve(r);
    }
    function notify(value) {
      Atomics.store(status, 0, value);
      Atomics.notify(status, 0, 1);
      notifiedAt = Date.now();
    }
    worker.onerror = function (e) { finish({ ok: false, value: null, why: 'worker error: ' + e.message }); };
    worker.onmessage = function (e) {
      if (e.data.type !== 'waiting') return finish(e.data);
      readStartAt = Date.now();
      file.slice(start, start + length).arrayBuffer().then(function (buf) {
        new Uint8Array(sab, 8).set(new Uint8Array(buf));
        notify(buf.byteLength + 1);
      }).catch(function () { notify(-1); });
    };
    worker.postMessage({ sab: sab, start: start, length: length, timeoutMs: timeoutMs });
  });
}

function timings(r) {
  return r.why + '; read ' + r.readMs + ' ms, ack ' + r.ackMs + ' ms, wake ' + r.wakeMs + ' ms, total ' + r.ms + ' ms';
}

function checkWorker() {
  var local = { slice: function () { return { arrayBuffer: function () { return Promise.resolve(new Uint8Array([0]).buffer); } }; } };
  return sharedRead(local, 0, 1, 2000).then(function (r) {
    return report('2 worker + Atomics.wait/notify', r.ok && r.ackMs <= 2000, timings(r));
  }, function (e) { return report('2 worker + Atomics.wait/notify', false, String(e)); });
}

function checkRemoteRead() {
  var good = new RemoteFile(SERVICE, 'synthetic.bin', SYNTHETIC_SIZE);
  var missing = new RemoteFile(SERVICE, 'missing.bin', SYNTHETIC_SIZE);
  // Spec §4 row 5: the worker answers within 2 s of the notify; a failed read wakes it
  // with -1 within 10 s of the read starting.
  return sharedRead(good, 300000, 65536, 12000).then(function (r) {
    return report('5a range read → worker', r.ok && r.ackMs !== null && r.ackMs <= 2000, timings(r));
  }, function (e) { return report('5a range read → worker', false, String(e)); }).then(function () {
    return sharedRead(missing, 0, 16, 12000);
  }).then(function (r) {
    var ok = r.value === -1 && r.wakeMs !== null && r.wakeMs <= 10000;
    return report('5b failed read wakes worker with -1', ok, 'value=' + r.value + ', ' + timings(r));
  }, function (e) { return report('5b failed read wakes worker with -1', false, String(e)); });
}

// Loads the th08-web runtime without game data: proves the runtime and its pthread pool
// start, not that the game runs.
function checkRuntime() {
  return new Promise(function (resolve) {
    var done = false;
    function finish(ok, detail) {
      if (done) return;
      done = true;
      resolve(report('3 th08-web runtime + pthreads', ok, detail));
    }
    window.Module = {
      noInitialRun: true,
      canvas: document.getElementById('canvas'),
      print: function (t) { console.log(t); },
      printErr: function (t) { console.warn(t); },
      onAbort: function (what) { finish(false, 'abort: ' + what); },
      onRuntimeInitialized: function () {
        var n = typeof PThread === 'object' && PThread.unusedWorkers ? PThread.unusedWorkers.length : -1;
        finish(n > 0, 'onRuntimeInitialized, PThread.unusedWorkers=' + n);
      }
    };
    var script = document.createElement('script');
    script.src = 'th08-web.js';
    script.onerror = function () { finish(false, 'cannot load th08-web.js'); };
    document.body.appendChild(script);
    setTimeout(function () { finish(false, 'no onRuntimeInitialized after 60 s'); }, 60000);
  });
}

function checkAudio() {
  return new Promise(function (resolve) {
    var prompt = document.getElementById('prompt'), done = false;
    var waitTimer = setTimeout(function () { finish(false, 'không có ai bấm OK trong 120 s'); }, 120000);
    function stopListening() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', go);
    }
    function finish(ok, detail) {
      if (done) return;
      done = true;
      clearTimeout(waitTimer);
      stopListening();
      prompt.hidden = true;
      resolve(report('6 audio', ok, detail));
    }
    function onKey(e) { if (e.keyCode === 13) go(); }
    // Runs inside the key/click handler: that user gesture is what unlocks audio.
    function go() {
      stopListening();
      clearTimeout(waitTimer);
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return finish(false, 'no AudioContext');
        var ctx = new Ctx();
        var resumed = Promise.resolve(ctx.resume ? ctx.resume() : undefined);
        withTimeout(resumed, 3000, 'AudioContext.resume').then(function () {
          try {
            var osc = ctx.createOscillator();
            osc.frequency.value = 880;
            osc.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
            finish(ctx.state === 'running', 'AudioContext.state=' + ctx.state);
          } catch (e) { finish(false, 'beep failed: ' + e); }
        }, function (e) { finish(false, 'resume failed: ' + e); });
      } catch (e) { finish(false, 'audio setup failed: ' + e); }
    }
    prompt.hidden = false;
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', go);
  });
}

[checkIsolation, checkGraphics, checkService, checkWorker, checkRemoteRead, checkRuntime, checkAudio]
  .reduce(function (chain, check) {
    return chain.then(function () {
      return Promise.resolve().then(check).catch(function (e) { return report(check.name, false, String(e)); });
    });
  }, Promise.resolve())
  .then(function () {
    var passed = results.filter(Boolean).length;
    report('TỔNG', passed === results.length, passed + '/' + results.length + ' đạt');
  });
