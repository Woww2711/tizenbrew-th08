'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadService, tempDir, VERSION, ROOT } = require('./harness');

test('package.json declares a TizenBrew app module with a service', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.packageType, 'app');
  assert.equal(pkg.appPath, 'app/index.html');
  assert.equal(pkg.serviceFile, 'service.js');
  assert.deepEqual(pkg.keys, []);
});

test('service.js loads in a TizenBrew-like sandbox and reports its version', () => {
  const svc = loadService({ TH08_DATA_DIR: tempDir(), TH08_PORT: '18899', TH08_BUILD_URL: 'http://127.0.0.1:9/never' });
  try {
    assert.equal(svc.status.version, VERSION);
    assert.equal(svc.status.node, process.version);
  } finally { svc.onStop(); }
});

test('code that runs on the TV uses ES5 syntax', () => {
  const files = fs.readdirSync(path.join(ROOT, 'src', 'service')).map((f) => path.join('src', 'service', f))
    .concat(['spike/remote-file.js', 'spike/worker.js', 'spike/spike.js', 'launcher/saves.js', 'launcher/probe.js',
      'launcher/launcher.html', 'app/index.html'])
    .filter((f) => fs.existsSync(path.join(ROOT, f)));
  for (const f of files) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /=>|\blet\s|\bconst\s|`|\?\.|\bclass\s/, f);
  }
});
