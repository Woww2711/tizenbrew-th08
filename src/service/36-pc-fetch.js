// Talking to pc/serve-th08-data.ps1 (spec §3.1) for POST /setup (37-setup.js): the manifest,
// and one file streamed to disk while it is hashed. Every request is bounded and can be
// aborted from outside (job.abort) when the service stops.

// An Error with a code the module page turns into a message: network, token, http,
// manifest, space, size, hash, disk, stopped.
function setupError(code, message, extra) {
  var e = new Error(message);
  e.code = code;
  if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
  return e;
}

function mib(bytes) { return (bytes / 1048576).toFixed(0) + ' MiB'; }

// The manifest's files as [{ name, size, sha256 }] in RETAIL_FILES order, or throws.
function parseManifest(text) {
  var m;
  try { m = JSON.parse(text); } catch (e) { throw setupError('manifest', 'manifest is not JSON: ' + e.message); }
  var files = m && Array.isArray(m.files) ? m.files.map(function (f) {
    return f && typeof f === 'object' ? { name: f.name, size: f.size,
      sha256: typeof f.sha256 === 'string' ? f.sha256.toLowerCase() : f.sha256 } : f;
  }) : null;
  if (!validFiles(files)) {
    throw setupError('manifest', 'manifest must list exactly ' + RETAIL_FILES.join(' and ') +
      ', each with a size (1 byte to ' + mib(MAX_DAT_SIZE) + ') and a 64-hex sha256');
  }
  return RETAIL_FILES.map(function (name) { return files.filter(function (f) { return f.name === name; })[0]; });
}

function checkJob(job) {
  if (job.cancelled) throw setupError('stopped', 'setup cancelled: the service stopped');
  checkRunning();
}

// One GET to the PC server. onResponse(res, finish) consumes the response and settles with
// finish(err, value). Bounded by SETUP_IDLE_MS without data and, if given, deadlineMs in
// all; job.abort() ends it from outside. The URL holds the token: it is never logged.
function pcGet(job, url, deadlineMs, onResponse) {
  return new Promise(function (resolve, reject) {
    var settled = false, timer = null, req;
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      job.abort = null;
      if (err) { req.abort(); reject(err); } else resolve(value);
    }
    job.abort = function () { finish(setupError('stopped', 'setup cancelled: the service stopped')); };
    req = http.get(url, function (res) {
      res.on('aborted', function () { finish(setupError('network', 'the PC closed the connection')); });
      res.on('error', function (e) { finish(setupError('network', 'connection error: ' + e.message)); });
      onResponse(res, finish);
    });
    req.setTimeout(SETUP_IDLE_MS, function () {
      finish(setupError('network', 'no data from the PC for ' + SETUP_IDLE_MS / 1000 + ' s'));
    });
    req.on('error', function (e) { finish(setupError('network', 'cannot reach the PC server: ' + e.message)); });
    if (deadlineMs) {
      timer = setTimeout(function () {
        finish(setupError('network', 'the PC did not finish within ' + deadlineMs / 1000 + ' s'));
      }, deadlineMs);
    }
  });
}

function statusError(code, what) {
  if (code === 403) return setupError('token', 'the PC server refused the token (HTTP 403)');
  return setupError('http', what + ': the PC server answered HTTP ' + code);
}

function fetchManifest(job, url) {
  return pcGet(job, url, MANIFEST_TIMEOUT_MS, function (res, finish) {
    if (res.statusCode !== 200) { res.resume(); return finish(statusError(res.statusCode, 'manifest.json')); }
    var text = '';
    res.setEncoding('utf8');
    res.on('data', function (c) {
      text += c;
      if (text.length > 65536) finish(setupError('manifest', 'manifest larger than 64 KiB'));
    });
    res.on('end', function () {
      try { finish(null, parseManifest(text)); } catch (e) { finish(e); }
    });
  });
}

// Time allowed for one attempt at a file, connect and body: SETUP_FLOOR_MS plus the size at
// SETUP_MIN_RATE. The idle timeout alone would wait forever for a PC that trickles.
function fileDeadline(size) {
  return SETUP_FLOOR_MS + Math.ceil(size / SETUP_MIN_RATE * 1000);
}

// Writes all of `buf` at the file position: fs.write may write fewer bytes than asked.
function writeAll(fd, buf, cb) {
  fs.write(fd, buf, 0, buf.length, null, function (err, n) {
    if (err) return cb(err);
    if (n === buf.length) return cb(null);
    if (!(n > 0)) return cb(new Error('the write made no progress'));
    writeAll(fd, buf.slice(n), cb);
  });
}

// Streams one file into `part`, hashing on the way; resolves with the SHA-256 once every
// byte is written and fsync'ed and the file on disk has the manifest size. Chunks are
// written strictly in order through a queue; the response is paused while one is written
// (a chunk that still arrives during the pause just waits in the queue).
function fetchFile(job, url, f, entry, part) {
  checkJob(job);
  var fd = fs.openSync(part, 'w'), writing = false, closeWanted = false, closed = false;
  function closeFd() {
    closeWanted = true;
    if (writing || closed) return;
    closed = true;
    try { fs.closeSync(fd); } catch (e) { /* already closed */ }
  }
  job.closeFd = closeFd;
  return pcGet(job, url, fileDeadline(f.size), function (res, finish) {
    if (res.statusCode !== 200) { res.resume(); return finish(statusError(res.statusCode, f.name)); }
    var hash = crypto.createHash('sha256'), got = 0, queue = [], ended = false, flushing = false;
    function flush() {
      flushing = true;
      entry.phase = 'verify';
      fs.fsync(fd, function (err) {
        if (err) return finish(setupError('disk', 'cannot flush ' + f.name + ': ' + err.message));
        fs.fstat(fd, function (err2, st) {
          if (err2) return finish(setupError('disk', 'cannot stat ' + f.name + ': ' + err2.message));
          if (st.size !== f.size) {
            return finish(setupError('disk', f.name + ': ' + st.size + ' bytes on disk, expected ' + f.size));
          }
          finish(null, hash.digest('hex'));
        });
      });
    }
    function pump() {
      if (writing || closeWanted || flushing) return;
      if (!queue.length) {
        if (ended) flush(); else res.resume();
        return;
      }
      var c = queue.shift();
      writing = true;
      writeAll(fd, c, function (err) {
        writing = false;
        if (closeWanted) return closeFd();
        if (err) return finish(setupError('disk', 'cannot write ' + f.name + ': ' + err.message));
        entry.got += c.length;
        pump();
      });
    }
    res.on('data', function (c) {
      if (closeWanted) return;
      got += c.length;
      if (got > f.size) return finish(setupError('size', f.name + ': the PC sent more than ' + f.size + ' bytes'));
      hash.update(c);
      queue.push(c);
      res.pause();
      pump();
    });
    res.on('end', function () {
      if (got !== f.size) return finish(setupError('size', f.name + ': got ' + got + ' of ' + f.size + ' bytes'));
      ended = true;
      pump();
    });
  }).then(function (digest) { closeFd(); return digest; }, function (e) { closeFd(); throw e; });
}
