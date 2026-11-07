// Installing the launcher build with staged activation (spec §3.2):
//   <DATA>/th08/build/       active build: th08-web.js, th08-web.wasm, the launcher files and
//                            .complete (the VERSION that installed it, written last)
//   <DATA>/th08/staging/     a new build is assembled in staging/build; removed when done,
//                            on error and at every start
//   <DATA>/th08/build.old/   the previous build, only while activating
//   <DATA>/th08/state.json   { buildVersion, buildReady, dataReady, files } mirrors build/
//                            and retail/
//   <DATA>/th08/retail/      th08.dat, thbgm.dat, .complete (copied from the PC, 35-data.js)
// The launcher URL, file://<DATA>/th08/build/launcher.html, is the same for every version.

var DOWNLOAD_TIMEOUT_MS = 60000;

// GET into memory, following redirects (GitHub release assets redirect to a CDN). One overall
// deadline per request, and a body cut short (aborted, or shorter than Content-Length) rejects.
function download(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    var settled = false, timer = null, req;
    function settle(err, buf) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { req.abort(); reject(err); } else resolve(buf);
    }
    var opts = urlLib.parse(url);
    opts.headers = { 'User-Agent': 'tizenbrew-th08' };
    req = (opts.protocol === 'https:' ? https : http).get(opts, function (res) {
      res.on('error', function (e) { settle(e); });
      res.on('aborted', function () { settle(new Error('connection cut short: ' + url)); });
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects >= 5) { settle(new Error('too many redirects: ' + url)); res.destroy(); return; }
        settled = true;
        clearTimeout(timer);
        res.destroy(); // the body is not needed
        return resolve(download(urlLib.resolve(url, res.headers.location), redirects + 1));
      }
      if (res.statusCode !== 200) {
        settle(new Error('HTTP ' + res.statusCode + ' for ' + url));
        return res.destroy(); // the body is not needed
      }
      var chunks = [], got = 0, want = res.headers['content-length'];
      res.on('data', function (c) { chunks.push(c); got += c.length; });
      res.on('end', function () {
        if (want !== undefined && got !== Number(want)) {
          return settle(new Error('got ' + got + ' of ' + want + ' bytes from ' + url));
        }
        settle(null, Buffer.concat(chunks));
      });
    });
    timer = setTimeout(function () {
      settle(new Error('download took longer than ' + DOWNLOAD_TIMEOUT_MS / 1000 + ' s: ' + url));
    }, DOWNLOAD_TIMEOUT_MS);
    req.on('error', function (e) { settle(e); });
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Regular files of a ustar archive, by path without a leading "./".
function untar(tarBuf) {
  var out = {}, off = 0;
  while (off + 512 <= tarBuf.length) {
    var header = tarBuf.slice(off, off + 512);
    if (header[0] === 0) break;
    var name = header.slice(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    var prefix = header.slice(345, 500).toString('utf8').replace(/\0[\s\S]*$/, '');
    if (prefix) name = prefix + '/' + name;
    var size = parseInt(header.slice(124, 136).toString('ascii').replace(/\0[\s\S]*$/, '').trim() || '0', 8);
    var type = header[156];
    off += 512;
    if (type === 0 || type === 48) out[name.replace(/^\.\//, '')] = tarBuf.slice(off, off + size);
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

// rm -rf without fs.rmSync (Node 14.14+), keeping the Node 10.4 floor.
function removeTree(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach(function (name) { removeTree(path.join(p, name)); });
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

function writeAtomic(file, buf) {
  fs.writeFileSync(file + '.part', buf);
  fs.renameSync(file + '.part', file);
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch (e) { return -1; }
}

function readState(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')) || {}; } catch (e) { return {}; }
}

// Merges `patch` into state.json, keeping fields this version does not know.
function writeState(root, patch) {
  var state = readState(root);
  Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
  writeAtomic(path.join(root, 'state.json'), Buffer.from(JSON.stringify(state, null, 2)));
  return state;
}

// The version that installed `dir` if it holds a whole build (marker plus every file
// non-empty), else null.
function buildVersionOf(dir) {
  var marker = readText(path.join(dir, '.complete'));
  if (!marker) return null;
  var names = BUILD_FILES.concat(LAUNCHER_FILES);
  for (var i = 0; i < names.length; i++) {
    if (fileSize(path.join(dir, names[i])) <= 0) return null;
  }
  return marker;
}

// An activation cut short leaves build.old/: keep build/ if it is whole, else put the old
// one back. Leftover staging/ is always removed.
function recover(root) {
  var build = path.join(root, 'build'), old = path.join(root, 'build.old');
  if (fs.existsSync(old)) {
    if (buildVersionOf(build)) {
      removeTree(old);
      log('removed build.old');
    } else {
      removeTree(build);
      fs.renameSync(old, build);
      log('restored build.old');
    }
  }
  removeTree(path.join(root, 'staging'));
}

function syncState(root) {
  var v = buildVersionOf(path.join(root, 'build'));
  var files = dataSetOf(path.join(root, 'retail'));
  var state = writeState(root, { buildVersion: v, buildReady: v === VERSION, dataReady: !!files, files: files || [] });
  refreshReady();
  return state;
}

// A service told to stop (a newer one took the port, see 45-takeover.js) must not write
// into <DATA>/th08 any more. Writes are synchronous, so checking before each is enough.
function checkRunning() {
  if (status.state === 'stopped') throw new Error('service stopped');
}

function installBuild(dir) {
  log('download ' + BUILD_URL);
  return download(BUILD_URL).then(function (gz) {
    checkRunning();
    var got = sha256(gz);
    if (got !== BUILD_SHA256) throw new Error('build sha256 mismatch: expected ' + BUILD_SHA256 + ', got ' + got);
    var entries = untar(zlib.gunzipSync(gz));
    BUILD_FILES.forEach(function (name) {
      if (!entries[name] || !entries[name].length) throw new Error('build archive has no (or an empty) ' + name);
      writeAtomic(path.join(dir, name), entries[name]);
    });
  });
}

function installLauncher(dir) {
  return LAUNCHER_FILES.reduce(function (chain, name) {
    return chain.then(function () {
      log('download ' + LAUNCHER_BASE + name);
      return download(LAUNCHER_BASE + name).then(function (buf) {
        checkRunning();
        if (!buf.length) throw new Error('empty download: ' + LAUNCHER_BASE + name);
        writeAtomic(path.join(dir, name), buf);
      });
    });
  }, Promise.resolve());
}

// staging/build → build: (1) build → build.old, (2) staging/build → build, (3) remove
// build.old.
function activate(root) {
  checkRunning();
  var build = path.join(root, 'build'), old = path.join(root, 'build.old');
  if (fs.existsSync(build)) fs.renameSync(build, old);
  fs.renameSync(path.join(root, 'staging', 'build'), build);
  removeTree(old);
  removeTree(path.join(root, 'staging'));
}

// Resolves once build/ holds this version, installing it through staging/ if needed.
function install() {
  checkNode();
  var base = resolveDataDir();
  var root = path.join(base, 'th08');
  status.dataDir = base;
  status.launcherUrl = 'file://' + path.join(root, 'build', 'launcher.html');
  mkdirp(root);
  dataRoot = root;
  fileDir = path.join(root, 'retail');
  diskSpace(root).then(function (d) { status.disk = d; });
  recover(root);
  recoverData(root);
  if (syncState(root).buildReady) return Promise.resolve();
  var staged = path.join(root, 'staging', 'build');
  mkdirp(staged);
  status.state = 'installing';
  status.progress = 'th08-web build';
  return installBuild(staged).then(function () {
    status.progress = 'launcher files';
    return installLauncher(staged);
  }).then(function () {
    checkRunning();
    writeAtomic(path.join(staged, '.complete'), Buffer.from(VERSION));
    activate(root);
    syncState(root);
    status.progress = '';
    log('installed build ' + VERSION);
  }).catch(function (e) {
    if (status.state !== 'stopped') removeTree(path.join(root, 'staging'));
    throw e;
  });
}
