// Free space on the filesystem that holds `dir`, for /status now and for the space check
// before copying the game data later. fs.statfs exists from Node 18.15; older Node falls
// back to `df -Pk`. Resolves { method, path, free, total } (bytes) or { method, path, error }.
function diskSpace(dir) {
  return new Promise(function (resolve) {
    if (typeof fs.statfs === 'function') {
      return fs.statfs(dir, function (err, st) {
        if (err) return resolve({ method: 'statfs', path: dir, error: err.message });
        resolve({ method: 'statfs', path: dir, free: st.bavail * st.bsize, total: st.blocks * st.bsize });
      });
    }
    childProcess.execFile('df', ['-Pk', dir], { timeout: 5000 }, function (err, stdout) {
      if (err) return resolve({ method: 'df', path: dir, error: 'no fs.statfs; df: ' + err.message });
      var cols = String(stdout).trim().split('\n').pop().trim().split(/\s+/);
      var total = Number(cols[1]) * 1024, free = Number(cols[3]) * 1024;
      if (!(total > 0) || isNaN(free)) return resolve({ method: 'df', path: dir, error: 'cannot read df output: ' + stdout });
      resolve({ method: 'df', path: dir, free: free, total: total });
    });
  });
}
