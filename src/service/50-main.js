var opening = false;

function openLauncher() {
  if (opening) return;
  opening = true;
  status.openError = null;
  log('opening ' + status.launcherUrl);
  Promise.resolve().then(function () { return openWithDevtools(status.launcherUrl); }).then(function () {
    status.openMethod = 'devtools';
    log('opened with DevTools');
  }, function (e) {
    status.openError = e.message;
    log('open failed: ' + e.message);
  }).then(function () { opening = false; });
}

// Runs once this service holds the port.
function boot() {
  status.state = 'starting';
  server.on('error', function (e) { log('server error: ' + e.message); });
  Promise.resolve().then(install).then(function () {
    if (status.state === 'stopped') return;
    status.state = 'ready';
    refreshReady();
    openHandler = openLauncher;
    log('ready');
  }, function (e) {
    if (status.state === 'stopped') return;
    status.state = 'error';
    status.error = e.message;
    log('install failed: ' + e.message);
  });
}

start().then(function (ok) {
  if (ok && !stoppedAfter(null)) boot();
}, function (e) {
  if (status.state === 'stopped') return;
  status.state = 'error';
  status.error = 'port ' + PORT + ': ' + e.message;
  log(status.error);
});

module.exports = {
  status: status,
  // TizenBrew from 2.1 opens the URL this returns instead of the module's appPath.
  launchUrl: function () {
    if (!refreshReady()) return null;
    status.openMethod = 'launchUrl';
    return status.launcherUrl;
  },
  onStop: function () { stopService('onStop'); },
  _test: { parseRange: parseRange, untar: untar, sha256: sha256, diskSpace: diskSpace,
    parseSetupInput: parseSetupInput, parseManifest: parseManifest }
};
