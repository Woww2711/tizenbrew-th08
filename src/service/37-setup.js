// POST /setup {ip, port, token}: copies the game data once from the PC (spec §3.2).
// GET /manifest.json → free-space check → each file streamed into staging/retail/<name>.part,
// SHA-256 hashed on the way, fsync'ed, checked against the manifest and renamed to <name>
// (a failed file is fetched again whole, SETUP_TRIES times in all) → .complete →
// activateData(). Nothing in retail/ changes until both files are verified. stopService()
// cancels a run: the request is aborted, the file closed, and staging/ is left for the next
// service's recover() (it may already be that service's).
var setupJob = null;            // the running copy: { cancelled, abort, closeFd }

// Validates POST /setup's body; returns { ip, port, token } or an error message.
function parseSetupInput(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be a JSON object';
  var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(b.ip || '').trim());
  var parts = m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
  if (!parts || parts.some(function (n) { return n > 255; })) return 'ip must be an IPv4 address such as 192.168.1.10';
  var port = Number(b.port);
  if (!(port >= 1 && port <= 65535 && port % 1 === 0)) return 'port must be a whole number from 1 to 65535';
  var token = String(b.token || '').trim();
  if (!/^[A-Za-z0-9]{4,64}$/.test(token)) return 'token must be 4 to 64 letters or digits';
  return { ip: parts.join('.'), port: port, token: token };
}

// Fetches `f` into dir/<name> through dir/<name>.part, whole again on a failure.
function fetchVerified(job, base, query, f, entry, dir) {
  var part = path.join(dir, f.name + '.part');
  function attempt(n) {
    checkJob(job);
    entry.attempt = n;
    entry.got = 0;
    entry.phase = 'download';
    return fetchFile(job, base + '/' + f.name + query, f, entry, part).then(function (digest) {
      checkJob(job);
      if (digest !== f.sha256) {
        throw setupError('hash', f.name + ': SHA-256 ' + digest + ' does not match the manifest (' + f.sha256 + ')');
      }
      fs.renameSync(part, path.join(dir, f.name));
      entry.phase = 'done';
    }).catch(function (e) {
      if (job.cancelled || status.state === 'stopped') throw e;
      try { fs.unlinkSync(part); } catch (x) { /* not created */ }
      entry.lastError = e.message;
      if (n >= SETUP_TRIES || e.code === 'token' || e.code === 'http' || e.code === 'disk') throw e;
      log('setup: ' + e.message + '; fetching ' + f.name + ' again');
      return delay(SETUP_RETRY_MS).then(function () { return attempt(n + 1); });
    });
  }
  return attempt(1);
}

// staging/retail → retail as one set: (1) retail → retail.old, (2) staging/retail → retail,
// (3) remove retail.old. recoverData() completes or undoes a cut one at the next start.
function activateData(root) {
  checkRunning();
  var retail = path.join(root, 'retail'), old = path.join(root, 'retail.old');
  if (fs.existsSync(retail)) fs.renameSync(retail, old);
  fs.renameSync(path.join(root, 'staging', 'retail'), retail);
  removeTree(old);
  removeTree(path.join(root, 'staging'));
}

function runSetup(input) {
  var job = setupJob = { cancelled: false, abort: null, closeFd: null };
  var s = status.setup = { state: 'running', phase: 'manifest', from: input.ip + ':' + input.port,
    files: [], error: null, startedAt: new Date().toISOString(), finishedAt: null };
  var base = 'http://' + input.ip + ':' + input.port, query = '?t=' + encodeURIComponent(input.token);
  var staged = path.join(dataRoot, 'staging', 'retail');
  var files = null;
  log('setup from ' + s.from);
  fetchManifest(job, base + '/manifest.json' + query).then(function (list) {
    checkJob(job);
    files = list;
    s.files = files.map(function (f) { return { name: f.name, size: f.size, got: 0, phase: 'wait', attempt: 0 }; });
    s.phase = 'space';
    removeTree(staged);   // a cancelled run's leftovers, if no restart removed them
    return diskSpace(dataRoot);
  }).then(function (d) {
    checkJob(job);
    status.disk = d;
    if (d.error) throw setupError('space', 'cannot measure the free space: ' + d.error);
    // Only the staged copy takes new space (POST /setup is refused while a set is active,
    // and the build is never installed while a setup runs), plus a fixed reserve.
    var need = files.reduce(function (sum, f) { return sum + f.size; }, 0) + DATA_RESERVE;
    if (d.free < need) {
      throw setupError('space', 'not enough free space: need ' + mib(need) + ', free ' + mib(d.free),
        { need: need, free: d.free });
    }
    mkdirp(staged);
    s.phase = 'download';
    return files.reduce(function (chain, f, i) {
      return chain.then(function () { return fetchVerified(job, base, query, f, s.files[i], staged); });
    }, Promise.resolve());
  }).then(function () {
    checkJob(job);
    s.phase = 'activate';
    if (!sizesMatch(staged, files)) throw setupError('disk', 'a staged file does not have its manifest size on disk');
    writeAtomic(path.join(staged, '.complete'), Buffer.from(JSON.stringify({ version: VERSION, files: files })));
    activateData(dataRoot);
    syncState(dataRoot);
    s.phase = 'done';
    s.state = 'done';
    log('setup done: game data ready');
  }).catch(function (e) {
    if (job.cancelled || status.state === 'stopped') {
      s.state = 'cancelled';
      return;
    }
    removeTree(path.join(dataRoot, 'staging'));
    s.state = 'error';
    s.error = { code: e.code || 'error', message: e.message, need: e.need, free: e.free };
    log('setup failed: ' + e.message);
  }).then(function () {
    s.finishedAt = new Date().toISOString();
    if (setupJob === job) setupJob = null;
  });
}

// Called by stopService(): the run stops reading, writing and renaming at once.
function cancelSetup() {
  var job = setupJob;
  if (!job) return;
  job.cancelled = true;
  if (job.abort) job.abort();
  if (job.closeFd) job.closeFd();
  log('setup cancelled');
}
