'use strict';
// Waits on shared memory the way th08-web's music reader does: the main thread fills the
// data area, stores byteCount + 1 (or -1 on failure) in status[0] and calls Atomics.notify.
// Message in: { sab, start, length, timeoutMs }. The data area starts at byte 8.
self.onmessage = function (e) {
  var m = e.data;
  var status = new Int32Array(m.sab, 0, 1);
  var data = new Uint8Array(m.sab, 8);
  self.postMessage({ type: 'waiting' });
  var woke = Atomics.wait(status, 0, 0, m.timeoutMs);
  var value = Atomics.load(status, 0);
  function result(ok, why) { self.postMessage({ type: 'result', ok: ok, value: value, why: why }); }
  if (woke === 'timed-out') return result(false, 'timed out after ' + m.timeoutMs + ' ms');
  if (value < 0) return result(false, 'read failed');
  var count = value - 1;
  if (count !== m.length) return result(false, 'got ' + count + ' bytes, expected ' + m.length);
  for (var i = 0; i < count; i++) {
    if (data[i] !== (m.start + i) % 251) return result(false, 'byte ' + i + ' differs');
  }
  result(true, 'ok');
};
