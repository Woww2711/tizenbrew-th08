// HTTP API on 127.0.0.1:PORT. The launcher is a file:// document (origin "null"), so
// every response allows any origin and is loadable under COEP require-corp.
var fileDir = null;             // <DATA>/th08/retail: the files served on /file/<name>
var FILE_ALLOW = RETAIL_FILES;
var openHandler = null;         // set once the launcher build is installed

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit, cb) {
  var chunks = [], size = 0, done = false;
  req.on('data', function (chunk) {
    if (done) return;
    size += chunk.length;
    if (size > limit) { done = true; cb(new Error('body larger than ' + limit + ' bytes')); return; }
    chunks.push(chunk);
  });
  req.on('end', function () { if (!done) { done = true; cb(null, Buffer.concat(chunks).toString('utf8')); } });
  req.on('error', function (e) { if (!done) { done = true; cb(e); } });
}

// Only "bytes=a-b" and "bytes=a-"; anything else is unsatisfiable.
function parseRange(header, size) {
  var m = /^bytes=(\d+)-(\d*)$/.exec(header || '');
  if (!m) return null;
  var start = Number(m[1]);
  var end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return null;
  return { start: start, end: end };
}

function serveFile(req, res, name) {
  if (!fileDir || FILE_ALLOW.indexOf(name) < 0) return sendJson(res, 404, { error: 'not found: ' + name });
  var file = path.join(fileDir, name);
  fs.stat(file, function (err, st) {
    if (err) return sendJson(res, 404, { error: 'not found: ' + name });
    var headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    if (req.headers.range) {
      var r = parseRange(req.headers.range, st.size);
      if (!r) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
        return res.end();
      }
      headers['Content-Range'] = 'bytes ' + r.start + '-' + r.end + '/' + st.size;
      headers['Content-Length'] = r.end - r.start + 1;
      res.writeHead(206, headers);
      return pipeFile(fs.createReadStream(file, { start: r.start, end: r.end }), res);
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    pipeFile(fs.createReadStream(file), res);
  });
}

// A read error after the headers went out can only cut the response short; a client that
// goes away early must not leave the file open.
function pipeFile(stream, res) {
  stream.on('error', function (e) {
    log('read error: ' + e.message);
    res.destroy();
  });
  res.on('close', function () { stream.destroy(); });
  stream.pipe(res);
}

function handle(req, res) {
  setCors(res);
  var url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && url === '/status') {
    refreshReady();
    return sendJson(res, 200, status);
  }
  if (req.method === 'POST' && url === '/report') {
    return readBody(req, 65536, function (err, text) {
      if (err) return sendJson(res, 413, { error: err.message });
      var report;
      try { report = JSON.parse(text); } catch (e) { report = null; }
      if (!report || typeof report !== 'object' || Array.isArray(report)) {
        return sendJson(res, 400, { error: 'body must be a JSON object' });
      }
      report.at = new Date().toISOString();
      addReport(report);
      res.writeHead(204);
      res.end();
    });
  }
  if (req.method === 'POST' && url === '/open') {
    if (!openHandler || !refreshReady()) return sendJson(res, 409, { error: 'not ready' });
    try { openHandler(); } catch (e) { return sendJson(res, 500, { error: e.message }); }
    return sendJson(res, 202, { opening: true });
  }
  if (req.method === 'POST' && url === '/shutdown') {
    // A newer version of this module asks for the port (see 45-takeover.js).
    log('shutdown requested');
    res.on('finish', function () { stopService('POST /shutdown'); });
    return sendJson(res, 202, { version: VERSION, stopping: true });
  }
  if (req.method === 'GET' && url.indexOf('/file/') === 0) {
    var name;
    try { name = decodeURIComponent(url.slice('/file/'.length)); } catch (e) {
      return sendJson(res, 400, { error: 'bad file name' });
    }
    return serveFile(req, res, name);
  }
  sendJson(res, 404, { error: 'not found' });
}

var server = http.createServer(handle);
