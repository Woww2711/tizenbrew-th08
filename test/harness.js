'use strict';
// Test helpers. loadService runs service.js the way TizenBrew 2.0.5's serviceLauncher.js
// does: in a vm context holding copies of Node's globals plus require, tizen and module.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const VERSION = require('../package.json').version;
const DISALLOWED = ['services', 'module', 'global', 'inDebug', 'currentClient', 'currentModule'];

// `globals` replaces sandbox globals, e.g. { process } with another version.
function loadService(env, globals) {
  Object.assign(process.env, env);
  const sandbox = {};
  for (const prop of Object.getOwnPropertyNames(global)) {
    if (!DISALLOWED.includes(prop)) sandbox[prop] = global[prop];
  }
  sandbox.require = require;
  sandbox.tizen = undefined;
  sandbox.module = { exports: {} };
  Object.assign(sandbox, globals);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'service.js'), 'utf8'), vm.createContext(sandbox));
  return sandbox.module.exports;
}

async function waitFor(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'th08-test-'));
}

function syntheticByte(i) {
  return i % 251;
}

const SPIKE_FILES = ['th08-web.js', 'th08-web.wasm', 'spike.html', 'spike.js', 'remote-file.js', 'worker.js'];

// A data dir that already holds this version of the spike, so no download happens.
function preinstall(dataDir) {
  const dir = path.join(dataDir, 'th08', 'spike');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of SPIKE_FILES) fs.writeFileSync(path.join(dir, name), 'placeholder ' + name);
  const buf = Buffer.alloc(1048576);
  for (let i = 0; i < buf.length; i++) buf[i] = syntheticByte(i);
  fs.writeFileSync(path.join(dir, 'synthetic.bin'), buf);
  fs.writeFileSync(path.join(dir, '.complete'), VERSION);
  return dir;
}

// Minimal ustar writer for fixtures.
function makeTarGz(files) {
  const blocks = [];
  for (const [name, data] of Object.entries(files)) {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\u000000', 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

module.exports = { loadService, waitFor, tempDir, preinstall, makeTarGz, syntheticByte, VERSION, ROOT };
