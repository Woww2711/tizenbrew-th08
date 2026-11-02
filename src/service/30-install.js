// Installing the spike: the pinned th08-web build, the spike pages and a synthetic file.

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
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) return settle(new Error('too many redirects: ' + url));
        settled = true;
        clearTimeout(timer);
        return resolve(download(urlLib.resolve(url, res.headers.location), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return settle(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      var chunks = [], got = 0, want = res.headers['content-length'];
      res.on('data', function (c) { chunks.push(c); got += c.length; });
      res.on('end', function () {
        if (want !== undefined && got !== Number(want)) {
          return settle(new Error('got ' + got + ' of ' + want + ' bytes from ' + url));
        }
        settle(null, Buffer.concat(chunks));
      });
      res.on('aborted', function () { settle(new Error('connection cut short: ' + url)); });
      res.on('error', function (e) { settle(e); });
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

function writeAtomic(file, buf) {
  fs.writeFileSync(file + '.part', buf);
  fs.renameSync(file + '.part', file);
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

// Byte i is i mod 251, so any slice can be checked without the file.
function syntheticBytes(size) {
  var buf = Buffer.alloc(size);
  for (var i = 0; i < size; i++) buf[i] = i % 251;
  return buf;
}

function installBuild(dir) {
  log('download ' + BUILD_URL);
  return download(BUILD_URL).then(function (gz) {
    var got = sha256(gz);
    if (got !== BUILD_SHA256) throw new Error('build sha256 mismatch: expected ' + BUILD_SHA256 + ', got ' + got);
    var entries = untar(zlib.gunzipSync(gz));
    BUILD_FILES.forEach(function (name) {
      if (!entries[name] || !entries[name].length) throw new Error('build archive has no (or an empty) ' + name);
      writeAtomic(path.join(dir, name), entries[name]);
    });
  });
}

function installAssets(dir) {
  return ASSET_FILES.reduce(function (chain, name) {
    return chain.then(function () {
      log('download ' + ASSET_BASE + name);
      return download(ASSET_BASE + name).then(function (buf) {
        if (!buf.length) throw new Error('empty download: ' + ASSET_BASE + name);
        writeAtomic(path.join(dir, name), buf);
      });
    });
  }, Promise.resolve());
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch (e) { return -1; }
}

// Installed = this version's marker plus every expected file (synthetic.bin at full size).
function spikeComplete(dir) {
  if (readText(path.join(dir, '.complete')) !== VERSION) return false;
  var names = BUILD_FILES.concat(ASSET_FILES);
  for (var i = 0; i < names.length; i++) {
    if (fileSize(path.join(dir, names[i])) <= 0) return false;
  }
  return fileSize(path.join(dir, SYNTHETIC_NAME)) === SYNTHETIC_SIZE;
}

// Resolves the spike directory and installs into it unless it is complete. Milestone-0
// exception to the spec's staged activation: the spike holds no user data, so recovery from
// an interrupted install is a full reinstall (~1.7 MB). The stale marker goes first and the
// new one is written last.
function install() {
  checkNode();
  var base = resolveDataDir();
  var dir = path.join(base, 'th08', 'spike');
  var marker = path.join(dir, '.complete');
  status.dataDir = base;
  status.launcherUrl = 'file://' + path.join(dir, 'spike.html');
  mkdirp(dir);
  fileDir = dir;
  if (spikeComplete(dir)) return Promise.resolve();
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  status.state = 'installing';
  status.progress = 'th08-web build';
  return installBuild(dir).then(function () {
    status.progress = 'spike pages';
    return installAssets(dir);
  }).then(function () {
    status.progress = 'synthetic file';
    writeAtomic(path.join(dir, SYNTHETIC_NAME), syntheticBytes(SYNTHETIC_SIZE));
    writeAtomic(marker, Buffer.from(VERSION));
    status.progress = '';
  });
}
