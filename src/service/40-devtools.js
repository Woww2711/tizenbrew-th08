// Opening the file:// spike page. Chromium does not let the module page
// (http://127.0.0.1:8081/...) navigate to file:// ("Not allowed to load local resource"),
// but DevTools' Page.navigate may: TizenBrew 2.0.x runs its pages with DevTools open on a
// port of the TV. The ports in LISTEN state are read from /proc/net/tcp*.
function listeningPorts() {
  if (process.env.TH08_DEVTOOLS_PORTS) {
    return process.env.TH08_DEVTOOLS_PORTS.split(',').map(Number);
  }
  var ports = [];
  ['/proc/net/tcp', '/proc/net/tcp6'].forEach(function (file) {
    var lines = (readText(file) || '').split('\n').slice(1);
    lines.forEach(function (line) {
      var cols = line.trim().split(/\s+/);
      if (cols[3] !== '0A') return;      // 0A = LISTEN
      var port = parseInt(cols[1].split(':')[1], 16);
      if (port >= 1024 && port !== PORT && ports.indexOf(port) < 0) ports.push(port);
    });
  });
  return ports;
}

// GET JSON from 127.0.0.1:port. Resolves null on any failure, after 1 s overall, or past 1 MB,
// so one odd listening port cannot stall or crash the DevTools search.
function getJson(port, pathname) {
  return new Promise(function (resolve) {
    var settled = false, req, timer;
    function settle(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.abort();
      resolve(value);
    }
    req = http.get({ host: '127.0.0.1', port: port, path: pathname }, function (res) {
      var text = '';
      res.setEncoding('utf8');
      res.on('data', function (c) {
        text += c;
        if (text.length > 1048576) settle(null);
      });
      res.on('end', function () {
        var value = null;
        try { value = JSON.parse(text); } catch (e) { value = null; }
        settle(value);
      });
      res.on('error', function () { settle(null); });
      res.on('aborted', function () { settle(null); });
    });
    timer = setTimeout(function () { settle(null); }, 1000);
    req.on('error', function () { settle(null); });
  });
}

function findModulePage() {
  var found = null;
  return Promise.all(listeningPorts().map(function (port) {
    return getJson(port, '/json/list').then(function (list) {
      if (found || !Array.isArray(list)) return;
      list.forEach(function (t) {
        if (!found && t.type === 'page' && String(t.url).indexOf(PAGE_MATCH) >= 0) found = t;
      });
    });
  })).then(function () { return found; });
}

// One CDP call over a minimal WebSocket client (text frames only). Every way out (reply,
// error, close, timeout) goes through settle(), which also tears the connection down.
function cdpCall(wsUrl, method, params) {
  return new Promise(function (resolve, reject) {
    var u = urlLib.parse(wsUrl);
    var socket = null, settled = false;
    var req = http.request({
      host: u.hostname, port: u.port, path: u.path,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
                 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }
    });
    var timer = setTimeout(function () {
      settle(new Error('no answer from DevTools after ' + CDP_TIMEOUT_MS + ' ms'));
    }, CDP_TIMEOUT_MS);
    function settle(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      else req.abort();
      if (err) reject(err); else resolve(value);
    }
    req.on('error', function (e) { settle(e); });
    req.on('response', function (res) {
      res.resume();
      settle(new Error('DevTools refused the WebSocket: HTTP ' + res.statusCode));
    });
    req.on('upgrade', function (res, sock, head) {
      socket = sock;
      var payload = Buffer.from(JSON.stringify({ id: 1, method: method, params: params }));
      var len = payload.length, header;
      if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
      else { header = Buffer.from([0x81, 0x80 | 126, 0, 0]); header.writeUInt16BE(len, 2); }
      var mask = crypto.randomBytes(4);
      for (var i = 0; i < len; i++) payload[i] ^= mask[i % 4];
      socket.write(Buffer.concat([header, mask, payload]));
      var buf = head && head.length ? head : Buffer.alloc(0);
      function onData(chunk) {
        if (chunk) buf = Buffer.concat([buf, chunk]);
        while (!settled && buf.length >= 2) {
          var n = buf[1] & 0x7f, off = 2;
          if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); off = 4; }
          else if (n === 127) { if (buf.length < 10) return; n = buf.readUInt32BE(2) * 4294967296 + buf.readUInt32BE(6); off = 10; }
          if (buf.length < off + n) return;
          var opcode = buf[0] & 0x0f, data = buf.slice(off, off + n);
          buf = buf.slice(off + n);
          if (opcode === 0x8) return settle(new Error('DevTools closed the connection'));
          if (opcode !== 0x1) continue;
          var msg;
          try { msg = JSON.parse(data.toString('utf8')); } catch (e) { continue; }
          if (msg.id === 1) return settle(null, msg);
        }
      }
      socket.on('data', onData);
      socket.on('error', function (e) { settle(e); });
      socket.on('close', function () { settle(new Error('DevTools closed the connection')); });
      onData(null);
    });
    req.end();
  });
}

function openWithDevtools(url) {
  return findModulePage().then(function (page) {
    if (!page) throw new Error('module page not found in DevTools (ports: ' + listeningPorts().join(',') + ')');
    return cdpCall(page.webSocketDebuggerUrl, 'Page.navigate', { url: url });
  }).then(function (msg) {
    if (msg.error) throw new Error('Page.navigate: ' + msg.error.message);
    if (msg.result && msg.result.errorText) throw new Error('Page.navigate: ' + msg.result.errorText);
  });
}
