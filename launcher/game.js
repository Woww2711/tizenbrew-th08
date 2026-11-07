'use strict';
// The TH08 launcher (spec §3.4), at <DATA>/th08/build/launcher.html (file://). Based on
// upstream th08-web.html v0.1.0: th08.dat is read whole into the runtime's heap, thbgm.dat is
// range-read on demand, both through the module service (RemoteFile). Saves: launcher/saves.js.
// No crossOriginIsolated gate: the TV gives file:// pages SharedArrayBuffer without it.
var PAGE_VERSION = '0.0.4';
var SERVICE = 'http://127.0.0.1:8790';

var TH08Game = (function () {
  // report(kind, level, message, data): at most one report per kind every intervalMs; the
  // ones in between are only counted (a dead service makes the game retry reads ~1500/s).
  function createReporter(post, now, intervalMs) {
    var last = {};
    return function report(kind, level, message, data) {
      var t = now(), k = last[kind];
      if (k && t - k.at < intervalMs) { k.suppressed++; return false; }
      last[kind] = { at: t, suppressed: 0 };
      post({ source: 'launcher', version: PAGE_VERSION, kind: kind, level: level, message: message,
        data: data === undefined ? null : data, suppressed: k ? k.suppressed : 0 });
      return true;
    };
  }

  // { sizes } from a /status answer, or { error } (Vietnamese) saying why the game cannot start.
  function startCheck(s) {
    if (!s || typeof s !== 'object') return { error: 'Service không trả lời. Hãy thoát rồi mở lại module.' };
    if (s.version !== PAGE_VERSION) {
      return { error: 'Service đang chạy là bản ' + s.version + ', trang là bản ' + PAGE_VERSION +
        '. Hãy rút điện TV 1 phút rồi mở lại module.' };
    }
    if (!s.ready && s.state === 'ready' && !s.dataReady) return { error: 'Chưa có dữ liệu game: hãy chép từ máy tính ở trang module.' };
    if (!s.ready) return { error: 'Service chưa sẵn sàng (' + s.state + '). Hãy thoát rồi mở lại module.' };
    var sizes = {};
    (s.files || []).forEach(function (f) { sizes[f.name] = f.size; });
    if (!(sizes['th08.dat'] > 0) || !(sizes['thbgm.dat'] > 0)) return { error: 'Service không báo dữ liệu game.' };
    return { sizes: sizes };
  }

  // sample(snapshot, t, visible) → true once the game loop has run and then made no progress
  // for stallMs while the page was visible (the title menu's Quit ends th08-web's loop for
  // good; a hang would look the same). Low 16 bits of _th08_web_get_frame_snapshot():
  // main-loop callbacks.
  function stallWatch(stallMs) {
    var loop = -1, changedAt = 0, ran = false;
    return function sample(snapshot, t, visible) {
      var l = snapshot & 0xffff;
      if (!visible) { changedAt = t; return false; }
      if (l !== loop) {
        if (loop !== -1) ran = true;
        loop = l;
        changedAt = t;
        return false;
      }
      return ran && t - changedAt >= stallMs;
    };
  }

  // sample(snapshot, t) → game frames per second since the last sample (null the first time).
  // High 16 bits of the snapshot: authored game (calc) frames.
  function fpsMeter() {
    var prev = null, prevT = 0;
    return function sample(snapshot, t) {
      var f = snapshot >>> 16, r = null;
      if (prev !== null && t > prevT) r = ((f - prev) & 0xffff) * 1000 / (t - prevT);
      prev = f;
      prevT = t;
      return r;
    };
  }

  // One banner line, several sources: set(source, kind, text) / clear(source); render(top)
  // gets the most important one (PRIORITY order) or null. A source only clears its own.
  var PRIORITY = ['fatal', 'saves', 'audio', 'music', 'pad'];
  function createBanners(render) {
    var shown = {};
    function update() {
      for (var i = 0; i < PRIORITY.length; i++) if (shown[PRIORITY[i]]) return render(shown[PRIORITY[i]]);
      render(null);
    }
    return {
      set: function (source, kind, text) { shown[source] = { source: source, kind: kind, text: text }; update(); },
      clear: function (source) { if (shown[source]) { delete shown[source]; update(); } },
      has: function (source) { return !!shown[source]; }
    };
  }

  // What a pad sample asks the launcher to do: { start } | { reload } | { menuKeys } | { openMenu }
  // | null. Nothing while the page is not focused and visible (active): a pad pressed while
  // the TV shows something else must not start the game or confirm the service test.
  var PAD_MENU = { up: 'up', down: 'down', a: 'ok', b: 'back', select: 'back' };
  function padAction(phase, menuOpen, info, active) {
    if (!active) return null;
    var a = info.pressed.indexOf('a') >= 0;
    if (phase === 'ready' && a) return { start: true };
    if (phase === 'stalled' && a) return { reload: true };
    if (phase !== 'running') return null;
    if (menuOpen) {
      var keys = info.pressed.map(function (n) { return PAD_MENU[n]; }).filter(Boolean);
      return keys.length ? { menuKeys: keys } : null;
    }
    return info.menu ? { openMenu: true } : null;
  }

  return { createReporter: createReporter, startCheck: startCheck, stallWatch: stallWatch, fpsMeter: fpsMeter,
    createBanners: createBanners, padAction: padAction };
})();

if (typeof module === 'object' && module.exports) module.exports = TH08Game;

// ---- In the page --------------------------------------------------------------------------
var Module = typeof document === 'undefined' ? null : (function () {
  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('canvas');
  var phase = 'loading';         // loading | ready | starting | running | stalled | failed
  var gameFile = null, bgmFile = null, gameBytes = null, prepared = null, tracker = null;
  var input = TH08Input.create(function (vk, on) { Module._th08_web_set_key_state(vk, on); });
  var lines = [];                // the runtime's last output lines, sent with errors
  var stats = { reads: 0, readErrors: 0, readMaxMs: 0, readMs: 0, fps: [], audio: null };
  var readBroken = false, audioPrompt = false, padStart = false, showStats = false, padWarned = false;
  var menu = null;               // null, or { items, at, confirm } while the launcher menu is open

  function post(body) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 3000);
    fetch(SERVICE + '/report', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined })
      .then(function () { clearTimeout(timer); }, function () { clearTimeout(timer); });
  }
  var report = TH08Game.createReporter(post, function () { return Date.now(); }, 10000);

  function show(text) { $('screen').textContent = text; $('screen').hidden = !text; }
  // The banner needs nothing from the service: it is how a dead service is noticed.
  var banners = TH08Game.createBanners(function (top) {
    var b = $('banner');
    b.className = top ? top.kind : '';
    b.textContent = top ? top.text : '';
    b.hidden = !top;
  });
  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.hidden = true; }, 2500);
  }
  function fail(message, data) {
    phase = 'failed';
    show(message + '\n\nBack: về trang module');
    banners.set('fatal', 'error', message);
    report('fail', 'error', message, data);
  }
  function remember(line) {
    lines.push(String(line));
    if (lines.length > 40) lines.shift();
  }

  window.onerror = function (message, source, line) {
    banners.set('fatal', 'error', 'Lỗi: ' + message);
    report('onerror', 'error', String(message), { source: source, line: line, lines: lines.slice(-10) });
  };
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
    banners.set('fatal', 'error', 'Lỗi: ' + reason);
    report('rejection', 'error', reason, { lines: lines.slice(-10) });
  });

  // Music reads are the only reads during play: their failures are how a dead service shows.
  RemoteFile.onRead = function (r) {
    if (r.name !== 'thbgm.dat') return;
    stats.reads++;
    if (r.error) {
      stats.readErrors++;
      if (!readBroken) {
        readBroken = true;
        banners.set('music', 'warn', 'Không đọc được nhạc nền qua service (' + r.error + '). Game vẫn chạy; ' +
          'nếu nhạc không trở lại, hãy thoát rồi mở lại module.');
      }
      report('read', 'error', r.error, { start: r.start, length: r.length, ms: r.ms });
      return;
    }
    stats.readMs += r.ms;
    if (r.ms > stats.readMaxMs) stats.readMaxMs = r.ms;
    if (r.ms > 1000) report('slow-read', 'warn', 'thbgm.dat read took ' + r.ms + ' ms', { start: r.start, length: r.length });
    if (readBroken) {
      readBroken = false;
      banners.clear('music');                       // only the music warning: others stay
      report('read-ok', 'info', 'music reads work again', { errors: stats.readErrors });
    }
  };

  function onSaveState(v) {
    if (v.state === 'saved') toast('Đã lưu');
    if (v.state === 'locked') {
      banners.set('saves', 'error', 'Không lưu được (' + v.error + '): từ giờ điểm, replay, cài đặt KHÔNG được lưu. ' +
        'Hãy thoát rồi mở lại module.');
      report('save-locked', 'error', v.error, v);
    }
    if (v.state === 'saved' && v.flushes === 1) report('save-saved', 'info', 'first flush', v);
  }

  function getStatus() {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 5000);
    return fetch(SERVICE + '/status', { signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
      return res.json();
    }).then(function (s) { clearTimeout(timer); return s; }, function () { clearTimeout(timer); return null; });
  }

  var onRuntimeReady = null;
  var runtimeReady = new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('runtime did not start within 60 s')); }, 60000);
    onRuntimeReady = function () { clearTimeout(timer); resolve(); };
  });

  function prepare() {
    show('Đang tải…');
    getStatus().then(function (s) {
      var c = TH08Game.startCheck(s);
      if (c.error) throw Object.assign(new Error(c.error), { shown: true });
      gameFile = new RemoteFile(SERVICE, 'th08.dat', c.sizes['th08.dat']);
      bgmFile = new RemoteFile(SERVICE, 'thbgm.dat', c.sizes['thbgm.dat']);
      return runtimeReady;
    }).then(function () {
      var t0 = Date.now();
      var data = gameFile.arrayBuffer().then(function (buf) {
        report('th08.dat', 'info', 'th08.dat ' + buf.byteLength + ' B in ' + (Date.now() - t0) + ' ms');
        return buf;
      }, function (e) {
        throw Object.assign(new Error('Không tải được th08.dat qua service: ' + e.message), { shown: true });
      });
      var saves = TH08Saves.prepare(Module).then(function (r) {
        report('saves', 'info', 'save storage loaded in ' + (Date.now() - t0) + ' ms', r);
        return r;
      }, function (e) {
        throw Object.assign(new Error('Không đọc được dữ liệu lưu (IndexedDB): ' + e.message +
          '. Game không chạy để khỏi ghi đè save; hãy thoát rồi mở lại module.'), { shown: true });
      });
      return Promise.all([data, saves]);
    }).then(function (r) {
      gameBytes = new Uint8Array(r[0]);
      prepared = r[1];
      phase = 'ready';
      show('Bấm OK (hoặc A trên tay cầm) để bắt đầu\n\nTay cầm: A bắn/chọn · B bom/hủy · LB/RB chậm · Start tạm dừng · ' +
        'giữ Select 2 giây: menu\nRemote: OK = Z · Back = tạm dừng');
    }).catch(function (e) {
      fail(e.shown ? e.message : 'Không khởi động được: ' + e.message, { lines: lines.slice(-10) });
    });
  }

  function start(byPad) {
    phase = 'starting';
    padStart = byPad;
    var p = Module._th08_web_allocate_game_data(gameBytes.byteLength);
    if (!p) { fail('Không đủ bộ nhớ cho th08.dat.'); return; }
    Module.HEAPU8.set(gameBytes, p);
    gameBytes = null;
    Module.th08RetailFiles = [gameFile, bgmFile];
    Module._th08_web_set_retail_file_sizes(gameFile.size, bgmFile.size);
    Module.FS.chdir('/game');
    Module.FS.writeFile('th08.dat', new Uint8Array(0));
    Module.FS.writeFile('thbgm.dat', new Uint8Array(0));
    tracker = TH08Saves.track(Module, onSaveState);
    if (prepared.removedRetail) tracker.flush();
    phase = 'running';
    show('');
    canvas.focus();
    Module.callMain([]);
    watchAudio(Date.now());
    setInterval(tick, 1000);
  }

  // SDL creates its AudioContext when the game opens audio. After an OK press (a user
  // activation) Chromium starts it running; a pad button is no activation. Not running →
  // resume(); still not running → ask for OK on the remote (that OK never reaches the game).
  function watchAudio(t0) {
    var sdl = Module.SDL2;
    var ctx = sdl && sdl.audioContext;
    if (!ctx) {
      if (Date.now() - t0 < 15000) setTimeout(function () { watchAudio(t0); }, 200);
      else report('audio', 'warn', 'SDL created no AudioContext within 15 s');
      return;
    }
    measureAudio(sdl);
    if (ctx.state === 'running') { report('audio', 'info', 'AudioContext running', { rate: ctx.sampleRate, padStart: padStart }); return; }
    ctx.resume();
    setTimeout(function () {
      if (ctx.state === 'running') { report('audio', 'info', 'AudioContext resumed', { rate: ctx.sampleRate }); return; }
      audioPrompt = true;
      banners.set('audio', 'warn', 'Âm thanh chưa bật — bấm OK trên remote.');
      report('audio', 'warn', 'AudioContext ' + ctx.state + ' after resume()', { padStart: padStart });
    }, 1000);
  }
  function resumeAudio() {
    var ctx = Module.SDL2.audioContext;
    ctx.resume().then(function () {
      if (ctx.state !== 'running') return;
      audioPrompt = false;
      banners.clear('audio');
      report('audio', 'info', 'AudioContext running after OK');
    });
  }

  // Counts SDL audio callbacks that came more than 1.5 buffers after the previous one. It
  // shows main-thread stalls, not every cause of a crackle (the output path is not seen here).
  function measureAudio(sdl, tries) {
    var node = sdl.audio && sdl.audio.scriptProcessorNode;
    if (!node) { if ((tries || 0) < 50) setTimeout(function () { measureAudio(sdl, (tries || 0) + 1); }, 200); return; }
    var inner = node.onaudioprocess, budget = node.bufferSize / sdl.audioContext.sampleRate * 1000;
    var a = stats.audio = { calls: 0, late: 0, maxGapMs: 0, bufferMs: Math.round(budget * 10) / 10, last: 0 };
    node.onaudioprocess = function (e) {
      var t = performance.now();
      if (a.last) {
        var gap = t - a.last;
        if (gap > a.maxGapMs) a.maxGapMs = gap;
        if (gap > budget * 1.5) a.late++;
      }
      a.last = t;
      a.calls++;
      return inner.call(this, e);
    };
  }

  var stall = TH08Game.stallWatch(15000), fps = TH08Game.fpsMeter(), ticks = 0;
  function tick() {
    ticks++;
    var visible = document.visibilityState === 'visible';
    var snap = Module._th08_web_get_frame_snapshot();
    var f = fps(snap, Date.now());
    if (visible && f !== null) stats.fps.push(f);
    // On the TV this is the only view of the numbers (the service answers 127.0.0.1 only).
    if (showStats && f !== null) {
      $('fps').textContent = Math.round(f) + ' fps · âm thanh trễ ' + (stats.audio ? stats.audio.late : '?') +
        ' lần · đọc nhạc lỗi ' + stats.readErrors + ', chậm nhất ' + stats.readMaxMs + ' ms (trong phút này)';
    }
    if (ticks % 2 === 0) tracker.checkConfig();
    if (ticks % 60 === 0) minuteReport();
    if (phase === 'running' && stall(snap, Date.now(), visible)) {
      phase = 'stalled';
      input.lock();
      tracker.flush();
      show('Game dừng phản hồi (15 giây không có khung hình mới; thường là do chọn Quit).\n\nBấm OK hoặc A để chạy lại.');
      report('stalled', 'warn', 'no new frame for 15 s (title Quit, or a hang)');
    }
  }
  function minuteReport() {
    var list = stats.fps.splice(0), sum = 0, min = Infinity;
    list.forEach(function (x) { sum += x; if (x < min) min = x; });
    var a = stats.audio;
    report('minute', 'info', 'fps ' + (list.length ? (sum / list.length).toFixed(1) : '?'), {
      fps: list.length ? Math.round(sum / list.length * 10) / 10 : null, minFps: list.length ? Math.round(min) : null,
      reads: stats.reads, readErrors: stats.readErrors, readMaxMs: stats.readMaxMs,
      readAvgMs: stats.reads ? Math.round(stats.readMs / stats.reads) : null,
      audio: a ? { calls: a.calls, late: a.late, maxGapMs: Math.round(a.maxGapMs), bufferMs: a.bufferMs } : null,
      saves: tracker.view() });
    stats.reads = 0; stats.readErrors = 0; stats.readMaxMs = 0; stats.readMs = 0;
    if (a) { a.calls = 0; a.late = 0; a.maxGapMs = 0; }
  }

  // The launcher menu (hold Select 2 s, or F2): numbers on screen, and the service test of
  // spec §6 ("service dies while music plays"), which has its own confirmation. Opening and
  // closing it lets go of every key; the pad then waits for neutral.
  var MENU_ITEMS = ['stats', 'service', 'close'];
  function drawMenu() {
    var d = $('dialog');
    d.hidden = false;
    if (menu.confirm) {
      d.textContent = 'Thử lỗi: dừng service (POST /shutdown) khi nhạc đang chạy?\n\nA / OK: dừng · B / Back: hủy';
      return;
    }
    var labels = { stats: (showStats ? 'Ẩn' : 'Hiện') + ' số đo (fps, âm thanh trễ, đọc nhạc)',
      service: 'Thử dừng service…', close: 'Đóng menu' };
    d.textContent = 'Menu\n\n' + MENU_ITEMS.map(function (k, i) { return (i === menu.at ? '▶ ' : '    ') + labels[k]; })
      .join('\n') + '\n\n▲▼ chọn · A / OK: chọn · B / Back: đóng';
  }
  function openMenu() {
    input.lock();
    Module._th08_web_clear_key_state();
    menu = { at: 0, confirm: false, busy: false };
    drawMenu();
  }
  function closeMenu() {
    menu = null;
    $('dialog').hidden = true;
    input.lock();
  }
  function menuKey(k) {
    if (menu.busy) return;
    if (menu.confirm) {
      if (k === 'ok') { menu.busy = true; $('dialog').textContent = 'Đang gửi /shutdown…'; shutdownService(); }
      if (k === 'back') { menu.confirm = false; drawMenu(); }
      return;
    }
    if (k === 'up') menu.at = (menu.at + MENU_ITEMS.length - 1) % MENU_ITEMS.length;
    if (k === 'down') menu.at = (menu.at + 1) % MENU_ITEMS.length;
    if (k === 'back') { closeMenu(); return; }
    if (k === 'ok') {
      var item = MENU_ITEMS[menu.at];
      if (item === 'close') { closeMenu(); return; }
      if (item === 'stats') { showStats = !showStats; $('fps').hidden = !showStats; }
      if (item === 'service') menu.confirm = true;
    }
    drawMenu();
  }
  // The banner only ever comes from the next real music read failing.
  function shutdownService() {
    report('diag', 'info', 'service test: POST /shutdown from the launcher');
    // The service closes every connection when it stops: give the report a moment to arrive.
    setTimeout(sendShutdown, 1000);
  }
  function sendShutdown() {
    fetch(SERVICE + '/shutdown', { method: 'POST' }).then(function (res) {
      $('dialog').textContent = 'Đã gửi /shutdown: HTTP ' + res.status + '. Chờ lần đọc nhạc tiếp theo báo lỗi…';
    }, function (e) {
      $('dialog').textContent = 'Gửi /shutdown lỗi: ' + e.message;
    }).then(function () { setTimeout(function () { if (menu) closeMenu(); }, 4000); });
  }
  var MENU_KEYS = { 38: 'up', 40: 'down', 13: 'ok', 27: 'back', 10009: 'back', 113: 'back' };

  window.addEventListener('keydown', function (e) {
    if (e.keyCode === TH08Input.BACK) e.preventDefault();      // Back in the game is Esc (pause)
    if (phase === 'failed') { if (e.keyCode === TH08Input.BACK) history.back(); return; }   // the module page
    if (phase === 'ready') {
      if (e.keyCode === TH08Input.OK) { e.preventDefault(); input.block(e); start(false); }   // consumed
      return;
    }
    if (phase === 'stalled') { if (e.keyCode === TH08Input.OK) location.reload(); return; }
    if (phase !== 'running') return;
    if (menu) {
      e.preventDefault();
      if (MENU_KEYS[e.keyCode] && !e.repeat) menuKey(MENU_KEYS[e.keyCode]);
      return;
    }
    if (audioPrompt && e.keyCode === TH08Input.OK) { e.preventDefault(); input.block(e); resumeAudio(); return; }
    var c = input.keydown(e);
    if (!c) return;
    e.preventDefault();
    if (c.action === 'menu' && !e.repeat) openMenu();
  }, true);
  window.addEventListener('keyup', function (e) {
    if (phase === 'running' && (input.keyup(e) || menu)) e.preventDefault();
  }, true);

  // The gamepad, sampled every animation frame while the page is visible (also unfocused, so
  // the lock sees the pad go neutral; actions need focus and visibility: padAction).
  var padSeen = false;
  function samplePad() {
    var visible = document.visibilityState === 'visible', focused = document.hasFocus();
    if (phase !== 'running' || menu) input.lock();     // the pad sends to the game only while it runs
    var info = input.sample(navigator.getGamepads ? navigator.getGamepads() : [], performance.now(), focused, visible);
    if (info.connected && !padSeen) {
      padSeen = true;
      var p = TH08Input.choosePad(navigator.getGamepads()).pad;
      report('pad', 'info', 'gamepad: ' + p.id, { mapping: p.mapping, buttons: p.buttons.length, axes: p.axes.length });
      if (!info.standard) banners.set('pad', 'warn', 'Tay cầm không theo chuẩn (' + p.id + '): nút có thể bị đổi chỗ.');
    }
    if (!info.connected && padSeen) { padSeen = false; banners.clear('pad'); }
    var act = TH08Game.padAction(phase, !!menu, info, focused && visible);
    if (!act) return;
    if (act.start) start(true);                         // A reaches the game only after release
    if (act.reload) location.reload();
    if (act.menuKeys) act.menuKeys.forEach(function (k) { if (menu) menuKey(k); });
    if (act.openMenu) openMenu();
  }
  var padLooping = false;
  function padLoop() {
    if (document.visibilityState !== 'visible') { padLooping = false; return; }   // stop sampling while hidden
    samplePad();
    requestAnimationFrame(padLoop);
  }
  function startPadLoop() { if (!padLooping) { padLooping = true; requestAnimationFrame(padLoop); } }

  function letGo() {
    input.lock();
    if (phase === 'running') Module._th08_web_clear_key_state();
  }
  window.addEventListener('blur', letGo);
  window.addEventListener('focus', samplePad);
  window.addEventListener('gamepadconnected', samplePad);
  window.addEventListener('gamepaddisconnected', function () { letGo(); samplePad(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { startPadLoop(); samplePad(); return; }
    letGo();
    if (tracker) tracker.flush();
  });
  window.addEventListener('pagehide', function () { if (tracker) tracker.flush(); });

  // For a desktop trial over DevTools (tools/cdp.mjs eval): what the launcher knows.
  window.TH08Launcher = { phase: function () { return phase; }, stats: stats, held: input.held,
    saves: function () { return tracker ? tracker.view() : null; } };
  setTimeout(prepare, 0);
  startPadLoop();
  return {
    noInitialRun: true,
    canvas: canvas,
    print: remember,
    printErr: remember,
    onAbort: function (what) {
      phase = 'failed';
      banners.set('fatal', 'error', 'Game dừng do lỗi: ' + what + '. Hãy thoát rồi mở lại module.');
      report('abort', 'error', String(what), { lines: lines.slice(-20) });
    },
    onRuntimeInitialized: function () { onRuntimeReady(); }
  };
})();
