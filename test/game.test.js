'use strict';
const test = require('node:test');
const assert = require('node:assert');
const TH08Game = require('../launcher/game.js');
const { VERSION } = require('./harness');

const files = [{ name: 'th08.dat', size: 46838025 }, { name: 'thbgm.dat', size: 449961024 }];

test('the game starts only with a ready service of this version that names both files', () => {
  assert.deepEqual(TH08Game.startCheck({ version: VERSION, ready: true, state: 'ready', files }),
    { sizes: { 'th08.dat': 46838025, 'thbgm.dat': 449961024 } });
  assert.match(TH08Game.startCheck(null).error, /^Service không trả lời/);
  assert.match(TH08Game.startCheck({ version: '0.0.3', ready: true, files }).error, /bản 0\.0\.3, trang là bản 0\.0\.4/);
  assert.match(TH08Game.startCheck({ version: VERSION, ready: false, state: 'installing', files }).error, /chưa sẵn sàng \(installing\)/);
  assert.match(TH08Game.startCheck({ version: VERSION, ready: false, state: 'ready', dataReady: false, files: [] }).error, /^Chưa có dữ liệu game/);
  assert.match(TH08Game.startCheck({ version: VERSION, ready: true, files: files.slice(0, 1) }).error, /không báo dữ liệu game/);
});

test('reports are limited to one per kind per interval; the skipped ones are counted', () => {
  const sent = [];
  let now = 0;
  const report = TH08Game.createReporter((b) => sent.push(b), () => now, 10000);
  assert.equal(report('read', 'error', 'Failed to fetch'), true);
  for (let i = 0; i < 1500; i++) report('read', 'error', 'Failed to fetch');
  assert.equal(report('audio', 'info', 'running'), true, 'another kind is not held back');
  now = 10000;
  report('read', 'error', 'Failed to fetch', { start: 1 });
  assert.deepEqual(sent.map((b) => [b.kind, b.suppressed]), [['read', 0], ['audio', 0], ['read', 1500]]);
  assert.deepEqual(sent[2], { source: 'launcher', version: VERSION, kind: 'read', level: 'error',
    message: 'Failed to fetch', data: { start: 1 }, suppressed: 1500 });
});

test('a game loop that ran and then made no progress for 15 s while visible is reported as stalled', () => {
  const quit = TH08Game.stallWatch(15000);
  assert.equal(quit(0, 0, true), false);
  assert.equal(quit(0, 20000, true), false, 'never ran yet (still starting)');
  assert.equal(quit(5, 21000, true), false);
  assert.equal(quit(5, 30000, true), false);
  assert.equal(quit(5 | (7 << 16), 35000, false), false, 'hidden: no frames expected');
  assert.equal(quit(5, 49000, true), false, 'the hidden time does not count');
  assert.equal(quit(5, 50001, true), true);
  assert.equal(quit(6, 50002, true), false, 'progress again');
});

test('the frame rate comes from game frames, across the 16-bit wrap', () => {
  const fps = TH08Game.fpsMeter();
  assert.equal(fps((65500 << 16) >>> 0, 1000), null);
  assert.equal(fps(((65500 + 60) & 0xffff) << 16, 2000), 60);
  assert.equal(fps(((65500 + 90) & 0xffff) << 16, 3000), 30);
});

test('each banner source clears only itself; the most important one is shown', () => {
  const shown = [];
  const banners = TH08Game.createBanners((top) => shown.push(top && top.source + ':' + top.kind));
  banners.set('music', 'warn', 'music reads fail');
  banners.set('saves', 'error', 'saving locked');
  banners.set('audio', 'warn', 'press OK');
  banners.clear('music');                       // music came back: the save lock stays on screen
  banners.clear('audio');
  banners.set('fatal', 'error', 'abort');
  banners.clear('saves');
  banners.clear('fatal');
  assert.deepEqual(shown, ['music:warn', 'saves:error', 'saves:error', 'saves:error', 'saves:error',
    'fatal:error', 'fatal:error', null]);
  assert.equal(banners.has('saves'), false);
});

test('pad presses act only while the page is focused and visible', () => {
  const info = (pressed, menu = false) => ({ pressed, menu });
  assert.deepEqual(TH08Game.padAction('ready', false, info(['a']), true), { start: true });
  assert.equal(TH08Game.padAction('ready', false, info(['a']), false), null, 'no start in the background');
  assert.deepEqual(TH08Game.padAction('running', true, info(['down', 'a', 'x']), true), { menuKeys: ['down', 'ok'] });
  assert.equal(TH08Game.padAction('running', true, info(['a']), false), null, 'no "stop service" in the background');
  assert.deepEqual(TH08Game.padAction('running', false, info([], true), true), { openMenu: true });
  assert.equal(TH08Game.padAction('running', false, info([], true), false), null);
  assert.deepEqual(TH08Game.padAction('stalled', false, info(['a']), true), { reload: true });
  assert.equal(TH08Game.padAction('loading', false, info(['a']), true), null);
});
