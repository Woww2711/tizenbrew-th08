// RemoteFile: the File-like object th08-web's runtime reads retail data through
// (size, arrayBuffer(), slice(a, b).arrayBuffer()), backed by the module service.
// Every read is checked strictly and rejects on any mismatch or after RemoteFile.timeoutMs,
// so the runtime's waiting thread is always woken.
(function (root) {
  'use strict';

  function request(url, headers, checkResponse) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer;
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
        reject(new Error('no answer after ' + RemoteFile.timeoutMs + ' ms (' + url + ')'));
      }, RemoteFile.timeoutMs);
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

  RemoteFile.timeoutMs = 10000;

  RemoteFile.prototype.url = function () {
    return this.serviceUrl + '/file/' + encodeURIComponent(this.name);
  };

  // The whole file; used for th08.dat, which the runtime copies into its heap.
  RemoteFile.prototype.arrayBuffer = function () {
    var size = this.size;
    return request(this.url(), {}, function (res) {
      return res.status === 200 ? null : 'expected HTTP 200, got ' + res.status;
    }).then(function (buf) {
      if (buf.byteLength !== size) throw new Error('expected ' + size + ' bytes, got ' + buf.byteLength);
      return buf;
    });
  };

  // Bytes [start, end), clamped to the file like File.slice.
  RemoteFile.prototype.slice = function (start, end) {
    var self = this;
    var a = Math.max(0, Math.floor(start || 0));
    var b = Math.min(end === undefined ? self.size : Math.floor(end), self.size);
    return {
      arrayBuffer: function () {
        if (a >= b) return Promise.resolve(new ArrayBuffer(0));
        var want = 'bytes ' + a + '-' + (b - 1) + '/' + self.size;
        return request(self.url(), { Range: 'bytes=' + a + '-' + (b - 1) }, function (res) {
          // A 200 would carry the whole file: refuse it before reading the body.
          if (res.status !== 206) return 'expected HTTP 206, got ' + res.status;
          var got = res.headers.get('Content-Range');
          return got === want ? null : 'expected Content-Range "' + want + '", got "' + got + '"';
        }).then(function (buf) {
          if (buf.byteLength !== b - a) throw new Error('expected ' + (b - a) + ' bytes, got ' + buf.byteLength);
          return buf;
        });
      }
    };
  };

  if (typeof module === 'object' && module.exports) module.exports = RemoteFile;
  else root.RemoteFile = RemoteFile;
})(this);
