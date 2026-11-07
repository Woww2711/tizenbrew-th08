// RemoteFile: the File-like object th08-web's runtime reads retail data through
// (size, arrayBuffer(), slice(a, b).arrayBuffer()), backed by the module service.
// Every read is checked strictly and rejects on any mismatch or at its deadline,
// so the runtime's waiting thread is always woken (range reads after RemoteFile.timeoutMs,
// whole-file reads after wholeTimeoutMs()).
(function (root) {
  'use strict';

  // Index rules of File.slice: negative counts from the end, NaN is 0, then clamp to [0, size].
  function clampIndex(value, size, fallback) {
    if (value === undefined) return fallback;
    var n = Math.floor(Number(value));
    if (n !== n) return 0;
    return n < 0 ? Math.max(size + n, 0) : Math.min(n, size);
  }

  function request(url, headers, checkResponse, ms) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer;
    // Without AbortController the timeout still rejects, but the connection stays open.
    var work = fetch(url, { headers: headers, signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
      var problem = checkResponse(res);
      if (problem) {
        if (ctrl) ctrl.abort();
        throw new Error(problem + ' (' + url + ')');
      }
      return res.arrayBuffer();
    });
    work.catch(function () {});
    var timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('no answer after ' + ms + ' ms (' + url + ')'));
      }, ms);
    });
    return Promise.race([work, timeout]).then(function (buf) {
      clearTimeout(timer);
      return buf;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function RemoteFile(serviceUrl, name, size) {
    this.serviceUrl = serviceUrl;
    this.name = name;
    this.size = size;
  }

  // A range read (music, 1 MiB at most) must answer within timeoutMs. A whole-file read
  // (th08.dat, 45 MiB) gets timeoutMs plus its size at fullRate bytes/s: about 32 s.
  RemoteFile.timeoutMs = 10000;
  RemoteFile.fullRate = 2097152;
  // Called after every read: { name, start, length, ms, error } (error null when it worked).
  RemoteFile.onRead = null;

  function observe(self, start, length, work) {
    var t0 = Date.now();
    function tell(error) {
      if (typeof RemoteFile.onRead !== 'function') return;
      try {
        RemoteFile.onRead({ name: self.name, start: start, length: length, ms: Date.now() - t0, error: error });
      } catch (e) { /* an observer must never break a read */ }
    }
    return work.then(function (buf) { tell(null); return buf; }, function (err) {
      tell(String((err && err.message) || err));
      throw err;
    });
  }

  RemoteFile.prototype.wholeTimeoutMs = function () {
    return RemoteFile.timeoutMs + Math.ceil(this.size * 1000 / RemoteFile.fullRate);
  };

  RemoteFile.prototype.url = function () {
    return this.serviceUrl + '/file/' + encodeURIComponent(this.name);
  };

  // The whole file; used for th08.dat, which the runtime copies into its heap.
  RemoteFile.prototype.arrayBuffer = function () {
    var size = this.size;
    return observe(this, 0, size, request(this.url(), {}, function (res) {
      return res.status === 200 ? null : 'expected HTTP 200, got ' + res.status;
    }, this.wholeTimeoutMs()).then(function (buf) {
      if (buf.byteLength !== size) throw new Error('expected ' + size + ' bytes, got ' + buf.byteLength);
      return buf;
    }));
  };

  // Bytes [start, end), with the index rules of File.slice (negative counts from the end, NaN is 0, clamped).
  RemoteFile.prototype.slice = function (start, end) {
    var self = this;
    var a = clampIndex(start, self.size, 0);
    var b = clampIndex(end, self.size, self.size);
    return {
      arrayBuffer: function () {
        if (a >= b) return Promise.resolve(new ArrayBuffer(0));
        var want = 'bytes ' + a + '-' + (b - 1) + '/' + self.size;
        return observe(self, a, b - a, request(self.url(), { Range: 'bytes=' + a + '-' + (b - 1) }, function (res) {
          // A 200 would carry the whole file: refuse it before reading the body.
          if (res.status !== 206) return 'expected HTTP 206, got ' + res.status;
          var got = res.headers.get('Content-Range');
          return got === want ? null : 'expected Content-Range "' + want + '", got "' + got + '"';
        }, RemoteFile.timeoutMs).then(function (buf) {
          if (buf.byteLength !== b - a) throw new Error('expected ' + (b - a) + ' bytes, got ' + buf.byteLength);
          return buf;
        }));
      }
    };
  };

  if (typeof module === 'object' && module.exports) module.exports = RemoteFile;
  else root.RemoteFile = RemoteFile;
})(typeof self !== 'undefined' ? self : this);
