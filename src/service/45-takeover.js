// Getting port PORT. A module update in TizenBrew 2.0.5 may leave the previous version's
// service running, holding the port. From 0.0.2 every service answers POST /shutdown, so a
// newer one asks it to stop and listens again. 0.0.1 has no /shutdown: then this service is
// "blocked": it tells the old service through the old one's /report (whose /status is what
// the module page sees), and retries the port slowly in case TizenBrew stops the old one.
// Holding the port is also the lock on <DATA>/th08: only the holder installs.
var blockedTimer = null;

// After stopService every async step of the takeover ends here: no more requests, and a
// listen that completed anyway is closed again. Returns true when stopped.
function stoppedAfter(listenErr) {
  if (status.state !== 'stopped') return false;
  if (!listenErr) server.close();
  return true;
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Resolves null when listening, or the listen error.
function tryListen() {
  return new Promise(function (resolve) {
    function onError(e) { server.removeListener('listening', onListening); resolve(e); }
    function onListening() { server.removeListener('error', onError); resolve(null); }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, '127.0.0.1');
  });
}

// A request to whatever holds 127.0.0.1:PORT. Resolves { status, body } (body parsed as JSON
// when possible) or null on any failure or after `ms`.
function askPort(method, pathname, body, ms) {
  return new Promise(function (resolve) {
    var settled = false, timer;
    function settle(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.abort();
      resolve(value);
    }
    var req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: method,
      headers: { 'Content-Type': 'application/json' } }, function (res) {
      var text = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { if (text.length < 65536) text += c; });
      res.on('end', function () {
        var parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
        settle({ status: res.statusCode, body: parsed });
      });
      res.on('error', function () { settle(null); });
      res.on('aborted', function () { settle(null); });
    });
    timer = setTimeout(function () { settle(null); }, ms);
    req.on('error', function () { settle(null); });
    req.end(body || undefined);
  });
}

// Resolves true once listening, false if still busy after `tries` attempts or stopped.
function retryListen(tries) {
  if (stoppedAfter(true)) return Promise.resolve(false);
  return tryListen().then(function (err) {
    if (stoppedAfter(err)) return false;
    if (!err) return true;
    if (err.code !== 'EADDRINUSE' || tries <= 1) return false;
    return delay(TAKEOVER_DELAY_MS).then(function () { return retryListen(tries - 1); });
  });
}

function takeOver() {
  var t = status.takeover = { from: null, result: null, at: new Date().toISOString() };
  log('port ' + PORT + ' busy; asking the running service to stop');
  return askPort('GET', '/status', null, 2000).then(function (r) {
    t.from = r && r.body && typeof r.body.version === 'string' ? r.body.version : null;
    if (stoppedAfter(true)) return 'stopped';
    return askPort('POST', '/shutdown', JSON.stringify({ from: VERSION }), 2000);
  }).then(function (r) {
    if (r === 'stopped' || stoppedAfter(true)) return false;
    if (!r) t.result = 'no answer to /shutdown';
    else if (r.status === 202) t.result = 'stopped';
    else t.result = '/shutdown answered HTTP ' + r.status;
    log('takeover: ' + t.result);
    return t.result === 'stopped' ? retryListen(TAKEOVER_TRIES) : false;
  }).then(function (ok) {
    if (ok) return true;
    if (stoppedAfter(true)) return false;
    if (t.result === 'stopped') t.result = 'stopped, but the port stayed busy';
    blocked(t);
    return false;
  });
}

function blocked(t) {
  if (status.state === 'stopped') return;
  status.state = 'blocked';
  status.error = 'port ' + PORT + ' is held by ' + (t.from ? 'service ' + t.from : 'another program') +
    ' (' + t.result + '); unplug the TV for 1 minute, then open the module again';
  log(status.error);
  askPort('POST', '/report', JSON.stringify({ source: 'service', version: VERSION, level: 'error',
    message: status.error, takeover: t }), 2000);
  blockedTimer = setTimeout(function retry() {
    tryListen().then(function (err) {
      if (stoppedAfter(err)) return;
      if (err) { blockedTimer = setTimeout(retry, BLOCKED_RETRY_MS); return; }
      t.result += '; port free at ' + new Date().toISOString();
      status.error = null;
      log('port free, starting');
      boot();
    });
  }, BLOCKED_RETRY_MS);
}

// Resolves true when this service holds the port.
function start() {
  return tryListen().then(function (err) {
    if (stoppedAfter(err)) return false;
    if (!err) return true;
    if (err.code !== 'EADDRINUSE') throw err;
    return takeOver();
  });
}

function stopService(reason) {
  if (status.state === 'stopped') return;
  status.state = 'stopped';
  log('stopping: ' + reason);
  clearTimeout(blockedTimer);
  cancelSetup();
  openHandler = null;
  server.close();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
}
