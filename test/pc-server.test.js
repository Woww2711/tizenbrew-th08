'use strict';
// pc/serve-th08-data.ps1 under the real Windows PowerShell 5.1, from WSL. WSL cannot reach
// a Windows listener (the firewall drops it), so the server binds Windows' 127.0.0.1 and
// the requests go through Windows' curl.exe. Skipped where there is no Windows.
const test = require('node:test');
const assert = require('node:assert');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadService, waitFor, tempDir, syntheticData, manifestOf, ROOT } = require('./harness');

const PS = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const CURL = '/mnt/c/Windows/System32/curl.exe';
const SKIP = !(fs.existsSync(PS) && fs.existsSync(CURL)) && 'needs Windows PowerShell and curl.exe (WSL)';
const PORT = 18950, TOKEN = '24681357', URL_BASE = 'http://127.0.0.1:' + PORT;
const SCRIPT = path.join(ROOT, 'pc', 'serve-th08-data.ps1');
let server, dataDir, output = '';

const winPath = (p) => new Promise((resolve, reject) => execFile('wslpath', ['-w', p], (e, out) => (e ? reject(e) : resolve(out.trim()))));

// Windows curl.exe: resolves { status, headers (lower-case names), body (Buffer) }.
function curl(args) {
  return new Promise((resolve, reject) => {
    execFile(CURL, ['-s', '-i', '-m', '10'].concat(args), { encoding: 'buffer', maxBuffer: 1 << 24 }, (err, out) => {
      if (err && !out.length) return reject(err);
      const end = out.indexOf('\r\n\r\n');
      const lines = out.subarray(0, end).toString('latin1').split('\r\n');
      const headers = {};
      for (const l of lines.slice(1)) { const i = l.indexOf(':'); headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
      resolve({ status: Number(lines[0].split(' ')[1]), headers, body: out.subarray(end + 4) });
    });
  });
}

test.before(async () => {
  if (SKIP) return;
  dataDir = tempDir();
  for (const [name, buf] of Object.entries(syntheticData())) fs.writeFileSync(path.join(dataDir, name), buf);
  server = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', await winPath(SCRIPT),
    '-DataDir', await winPath(dataDir), '-Address', '127.0.0.1', '-Port', String(PORT), '-Token', TOKEN,
    '-HeaderTimeoutMs', '1000']);
  server.stdout.on('data', (c) => { output += c; });
  server.stderr.on('data', (c) => { output += c; });
  await waitFor(() => /server ready/.test(output) || server.exitCode !== null, 30000);
  assert.match(output, /IP: 127\.0\.0\.1 {3}Port: 18950 {3}Token: 24681357/);
});
test.after(() => { if (server) server.kill(); });

test('the script is plain ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI)', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(fs.readFileSync(SCRIPT, 'latin1')));
});

test('the manifest lists both files with size and SHA-256, and the service accepts it', { skip: SKIP }, async () => {
  const r = await curl([URL_BASE + '/manifest.json?t=' + TOKEN]);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers.connection, 'close');
  assert.deepEqual(JSON.parse(r.body.toString()), { files: manifestOf(syntheticData()) });
  const svc = loadService({ TH08_DATA_DIR: tempDir(), TH08_PORT: '18848', TH08_BUILD_URL: 'http://127.0.0.1:9/never' });
  try {
    assert.deepEqual(svc._test.parseManifest(r.body.toString()), manifestOf(syntheticData()));
  } finally { svc.onStop(); }
});

test('each file is sent whole with its Content-Length', { skip: SKIP }, async () => {
  for (const [name, buf] of Object.entries(syntheticData())) {
    const r = await curl([URL_BASE + '/' + name + '?t=' + TOKEN]);
    assert.equal(r.status, 200, name);
    assert.equal(r.headers['content-length'], String(buf.length), name);
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.ok(r.body.equals(buf), name);
  }
});

test('a wrong or missing token answers 403, other routes 404, other methods 405', { skip: SKIP }, async () => {
  assert.equal((await curl([URL_BASE + '/thbgm.dat?t=1' + TOKEN])).status, 403);
  assert.equal((await curl([URL_BASE + '/manifest.json'])).status, 403);
  assert.equal((await curl([URL_BASE + '/manifest.json?T=' + TOKEN])).status, 403);
  assert.equal((await curl([URL_BASE + '/th08.cfg?t=' + TOKEN])).status, 404);
  assert.equal((await curl([URL_BASE + '/?t=' + TOKEN])).status, 404);
  assert.equal((await curl(['-X', 'POST', URL_BASE + '/manifest.json?t=' + TOKEN])).status, 405);
});

test('an oversized request head answers 400', { skip: SKIP }, async () => {
  const r = await curl(['-H', 'X-Big: ' + 'a'.repeat(9000), URL_BASE + '/manifest.json?t=' + TOKEN]);
  assert.equal(r.status, 400);
});

test('a request head not finished within -HeaderTimeoutMs answers 400', { skip: SKIP }, async () => {
  // A raw client on the Windows side: half a request line, then 1.5 s of silence.
  const client = "$c = New-Object Net.Sockets.TcpClient('127.0.0.1', " + PORT + '); $s = $c.GetStream(); ' +
    "$b = [Text.Encoding]::ASCII.GetBytes('GET /manifest.json'); $s.Write($b, 0, $b.Length); " +
    'Start-Sleep -Milliseconds 1500; (New-Object IO.StreamReader($s)).ReadLine()';
  const line = await new Promise((resolve, reject) => execFile(PS, ['-NoProfile', '-Command', client],
    (e, out) => (e ? reject(e) : resolve(out.trim()))));
  assert.equal(line, 'HTTP/1.1 400 Bad Request');
});

test('a file that changed after the start answers 500 instead of a wrong length', { skip: SKIP }, async () => {
  fs.appendFileSync(path.join(dataDir, 'th08.dat'), 'x');
  try {
    const r = await curl([URL_BASE + '/th08.dat?t=' + TOKEN]);
    assert.equal(r.status, 500);
    assert.match(r.body.toString(), /restart the server/);
  } finally { fs.truncateSync(path.join(dataDir, 'th08.dat'), 4096); }
  assert.match(output, /\/th08\.dat 500/);
  assert.ok(!output.includes('t=' + TOKEN), 'the log never shows the token in a URL');
});

// A raw client on the Windows side that sends `send` (if any), reads `readBytes` bytes
// (if any), then closes with a zero linger time, which sends a reset instead of a FIN.
function resetClient(send, readBytes) {
  const script = "$c = New-Object Net.Sockets.TcpClient('127.0.0.1', " + PORT + '); $s = $c.GetStream(); ' +
    (send ? "$b = [Text.Encoding]::ASCII.GetBytes('" + send + "'); $s.Write($b, 0, $b.Length); " : '') +
    (readBytes ? '$buf = New-Object byte[] ' + readBytes + '; $n = $s.Read($buf, 0, $buf.Length); ' : '') +
    '$c.LingerState = New-Object Net.Sockets.LingerOption($true, 0); $c.Close()';
  return new Promise((resolve, reject) => execFile(PS, ['-NoProfile', '-Command', script],
    (e) => (e ? reject(e) : resolve())));
}

test('a client reset right after connecting does not stop the server', { skip: SKIP }, async () => {
  // One Windows process opens and resets 40 connections in a burst.
  const burst = "1..40 | ForEach-Object { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', " + PORT + '); ' +
    '$c.LingerState = New-Object Net.Sockets.LingerOption($true, 0); $c.Close() }';
  await new Promise((resolve, reject) => execFile(PS, ['-NoProfile', '-Command', burst], (e) => (e ? reject(e) : resolve())));
  await resetClient(null, 0);
  const r = await curl([URL_BASE + '/manifest.json?t=' + TOKEN]);
  assert.equal(r.status, 200);
  assert.equal(server.exitCode, null, 'the server process is still running');
});

test('a client that aborts in the middle of a file does not stop the server', { skip: SKIP }, async () => {
  const req = 'GET /thbgm.dat?t=' + TOKEN + ' HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n';
  await resetClient(req.replace(/\\r\\n/g, '\r\n').replace(/'/g, "''"), 1000);
  const r = await curl([URL_BASE + '/th08.dat?t=' + TOKEN]);
  assert.equal(r.status, 200);
  assert.equal(server.exitCode, null);
});
