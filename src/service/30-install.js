// Installing the spike. Until Task 3 adds the downloads, only an already installed
// spike (version marker present) counts as installed.
function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

function install() {
  var base = resolveDataDir();
  var dir = path.join(base, 'th08', 'spike');
  status.dataDir = base;
  status.launcherUrl = 'file://' + path.join(dir, 'spike.html');
  mkdirp(dir);
  fileDir = dir;
  if (readText(path.join(dir, '.complete')) === VERSION) return Promise.resolve();
  return Promise.reject(new Error('spike not installed'));
}
