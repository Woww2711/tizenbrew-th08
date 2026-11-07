// The game data set (spec §3.2): <DATA>/th08/retail/ holds th08.dat, thbgm.dat and
// .complete, a JSON { version, files: [{ name, size, sha256 }] } written last into the
// staged copy. A set is only ever activated whole: staging/retail → retail, with
// retail.old while activating. state.json mirrors it as dataReady and files.
var dataRoot = null;            // <DATA>/th08 once install() resolved it

function isSize(n) { return typeof n === 'number' && n % 1 === 0 && n > 0 && n <= MAX_DAT_SIZE; }

// True for exactly one { name, size, sha256 } per RETAIL_FILES name, sha256 as lowercase hex.
function validFiles(files) {
  if (!Array.isArray(files) || files.length !== RETAIL_FILES.length) return false;
  var seen = {};
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (!f || typeof f !== 'object' || RETAIL_FILES.indexOf(f.name) < 0 || seen[f.name]) return false;
    if (!isSize(f.size) || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return false;
    seen[f.name] = true;
  }
  return true;
}

function sizesMatch(dir, files) {
  for (var i = 0; i < files.length; i++) {
    if (fileSize(path.join(dir, files[i].name)) !== files[i].size) return false;
  }
  return true;
}

// The files of the whole set in `dir` (marker valid and every size right), else null.
function dataSetOf(dir) {
  var marker = null;
  try { marker = JSON.parse(readText(path.join(dir, '.complete'))); } catch (e) { marker = null; }
  if (!marker || !validFiles(marker.files) || !sizesMatch(dir, marker.files)) return null;
  return marker.files.map(function (f) { return { name: f.name, size: f.size, sha256: f.sha256 }; });
}

// An activation cut short leaves retail.old/: keep retail/ if it is a whole set, else put
// the old one back. recover() already removed staging/ (and staging/retail with it).
function recoverData(root) {
  var retail = path.join(root, 'retail'), old = path.join(root, 'retail.old');
  if (!fs.existsSync(old)) return;
  if (dataSetOf(retail)) {
    removeTree(old);
    log('removed retail.old');
  } else {
    removeTree(retail);
    fs.renameSync(old, retail);
    log('restored retail.old');
  }
}

// Composite readiness (spec §3.2), checked against the disk every time it is asked:
// buildReady && dataReady && every file of state.json present with its size.
function refreshReady() {
  if (!dataRoot) return false;
  var state = readState(dataRoot);
  var files = validFiles(state.files) ? state.files : [];
  status.buildReady = state.buildReady === true && buildVersionOf(path.join(dataRoot, 'build')) === VERSION;
  status.dataReady = state.dataReady === true && files.length > 0 && sizesMatch(path.join(dataRoot, 'retail'), files);
  status.files = files;
  status.ready = status.state === 'ready' && status.buildReady && status.dataReady;
  return status.ready;
}
