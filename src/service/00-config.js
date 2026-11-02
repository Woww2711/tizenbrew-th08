// TH08 TizenBrew module service (milestone 0: TV capability spike).
// TizenBrew 2.0.x runs this file in a vm sandbox with require, tizen and module. Its Node
// on Tizen 9 is at least 10.4 (tizenbrew-kodi relies on that); ES5 syntax keeps a margin.
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var zlib = require('zlib');
var urlLib = require('url');

var VERSION = '0.0.1';
var PORT = Number(process.env.TH08_PORT) || 8790;
var BUILD_URL = process.env.TH08_BUILD_URL ||
  'https://github.com/N0zoM1z0/th08-web/releases/download/v0.1.0/th08-web-v0.1.0.tar.gz';
var BUILD_SHA256 = process.env.TH08_BUILD_SHA256 ||
  'f0e3c671137ed150862f32b5ef08e848ac9f09f5c6b7ab0d33d63801ed0a4da1';
var BUILD_FILES = ['th08-web.js', 'th08-web.wasm'];
var ASSET_BASE = process.env.TH08_ASSET_BASE ||
  'https://cdn.jsdelivr.net/gh/Woww2711/tizenbrew-th08@' + VERSION + '/spike/';
var ASSET_FILES = ['spike.html', 'spike.js', 'remote-file.js', 'worker.js'];
var SYNTHETIC_NAME = 'synthetic.bin';
var SYNTHETIC_SIZE = 1048576;
var PAGE_MATCH = 'tizenbrew-th08';
var MIN_NODE = [10, 4];
var CDP_TIMEOUT_MS = Number(process.env.TH08_CDP_TIMEOUT_MS) || 10000;

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
