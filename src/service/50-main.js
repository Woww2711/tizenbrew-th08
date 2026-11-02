server.on('error', function (e) {
  status.state = 'error';
  status.error = 'port ' + PORT + ': ' + e.message;
});

server.listen(PORT, '127.0.0.1', function () {
  Promise.resolve().then(install).then(function () {
    status.state = 'ready';
    log('ready');
  }, function (e) {
    status.state = 'error';
    status.error = e.message;
    log('install failed: ' + e.message);
  });
});

module.exports = {
  status: status,
  // TizenBrew from 2.1 opens the URL this returns instead of the module's appPath.
  launchUrl: function () {
    if (status.state !== 'ready') return null;
    status.openMethod = 'launchUrl';
    return status.launcherUrl;
  },
  onStop: function () { server.close(); },
  _test: { parseRange: parseRange, untar: untar, syntheticBytes: syntheticBytes, sha256: sha256 }
};
