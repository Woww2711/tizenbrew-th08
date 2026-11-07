// TH08 TizenBrew module service (milestone 1, step 1: persistence and update probe).
// TizenBrew 2.0.x runs this file in a vm sandbox with require, tizen and module. Its Node
// on the Q7F is v18.18.2 (milestone 0); ES5 syntax keeps a margin.
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var zlib = require('zlib');
var urlLib = require('url');
var childProcess = require('child_process');

var VERSION = '0.0.3';
var PORT = Number(process.env.TH08_PORT) || 8790;
var BUILD_URL = process.env.TH08_BUILD_URL ||
  'https://github.com/N0zoM1z0/th08-web/releases/download/v0.1.0/th08-web-v0.1.0.tar.gz';
var BUILD_SHA256 = process.env.TH08_BUILD_SHA256 ||
  'f0e3c671137ed150862f32b5ef08e848ac9f09f5c6b7ab0d33d63801ed0a4da1';
var BUILD_FILES = ['th08-web.js', 'th08-web.wasm'];
// The module's own launcher files, copied into build/ next to the runtime.
var LAUNCHER_BASE = process.env.TH08_LAUNCHER_BASE ||
  'https://cdn.jsdelivr.net/gh/Woww2711/tizenbrew-th08@' + VERSION + '/launcher/';
var LAUNCHER_FILES = ['launcher.html', 'saves.js', 'probe.js'];
var RETAIL_FILES = ['th08.dat', 'thbgm.dat'];
var PAGE_MATCH = 'tizenbrew-th08';
var MIN_NODE = [10, 4];
var CDP_TIMEOUT_MS = Number(process.env.TH08_CDP_TIMEOUT_MS) || 10000;
// Taking the port over from an older service: wait between listen attempts, and how many.
var TAKEOVER_DELAY_MS = Number(process.env.TH08_TAKEOVER_DELAY_MS) || 250;
var TAKEOVER_TRIES = 20;
var BLOCKED_RETRY_MS = Number(process.env.TH08_BLOCKED_RETRY_MS) || 5000;

function checkNode() {
  var v = process.version.slice(1).split('.').map(Number);
  if (v[0] < MIN_NODE[0] || (v[0] === MIN_NODE[0] && v[1] < MIN_NODE[1])) {
    throw new Error('Node ' + process.version + ' is older than the supported ' + MIN_NODE.join('.'));
  }
}

// apps_rw/<package>/data is the directory TizenBrew's own package may write to.
function resolveDataDir() {
  if (typeof tizen === 'object' && tizen && tizen.application) {
    return '/opt/usr/home/owner/apps_rw/' + tizen.application.getAppInfo().packageId + '/data';
  }
  if (process.env.TH08_DATA_DIR) return process.env.TH08_DATA_DIR;
  throw new Error('cannot resolve the data directory: no tizen API and TH08_DATA_DIR is unset');
}
