'use strict';
const test = require('node:test');
const assert = require('node:assert');
const TH08Input = require('../launcher/input.js');

const kb = (code, keyCode) => ({ code, keyCode });
const remote = (keyCode) => ({ code: '', keyCode });
// A gamepad as navigator.getGamepads() gives it: pad({ 0: true }, [x, y]) has A down.
const pad = (down = {}, axes = [0, 0], mapping = 'standard') => ({ connected: true, mapping, axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: !!down[i], value: down[i] ? 1 : 0 })) });
function mapper() {
  const sent = [];
  const input = TH08Input.create((vk, on) => sent.push([vk, on]));
  let t = 0;
  input.at = (pads, focused = true, visible = true) => input.sample(pads, t += 16, focused, visible);
  return { input, sent };
}

test('keyboard and the SolarCell remote map to the agreed keys; colour and number keys do nothing', () => {
  const cases = [[kb('KeyZ', 90), { vk: 90 }], [kb('ShiftRight', 16), { vk: 16 }], [kb('Enter', 13), { vk: 90 }],
    [remote(13), { vk: 90 }], [remote(38), { vk: 38 }], [remote(10009), { vk: 27 }], [kb('F2', 113), { action: 'menu' }],
    [remote(403), null], [remote(406), null], [kb('Digit1', 49), null], [kb('KeyA', 65), null]];
  for (const [e, want] of cases) assert.deepEqual(TH08Input.classify(e), want, JSON.stringify(e));
});

test('keyboard keys and pad buttons are OR-ed per game key; setKey only on a change', () => {
  const { input, sent } = mapper();
  input.at([pad()]);                                   // neutral: the pad unlocks
  input.keydown(kb('ShiftLeft', 16));
  input.keydown(kb('ShiftRight', 16));
  input.at([pad({ 4: true })]);                        // LB
  input.keyup(kb('ShiftLeft', 16));
  input.at([pad({ 5: true })]);                        // RB instead of LB
  input.keyup(kb('ShiftRight', 16));
  assert.deepEqual(input.held(), [16]);
  input.at([pad()]);
  assert.deepEqual(sent, [[16, 1], [16, 0]]);
  input.at([pad({ 0: true, 1: true, 9: true, 12: true })]);
  assert.deepEqual(input.held(), [27, 38, 88, 90]);
});

test('the left stick turns a direction on at 0.5 and off below 0.35', () => {
  const { input, sent } = mapper();
  input.at([pad()]);
  for (const x of [0.4, 0.5, 0.4, 0.36, 0.34, -0.6]) input.at([pad({}, [x, 0])]);
  assert.deepEqual(sent, [[39, 1], [39, 0], [37, 1]]);
});

test('the pad waits for neutral after blur, hiding or a disconnect; it keeps sampling meanwhile', () => {
  const { input, sent } = mapper();
  input.at([pad()]);
  input.at([pad({ 0: true })]);
  input.lock();                                        // blur
  assert.deepEqual(sent, [[90, 1], [90, 0]]);
  assert.equal(input.at([pad({ 0: true })]).locked, true, 'A still down: no send');
  assert.equal(input.at([pad()], false).locked, true, 'not focused');
  assert.equal(input.at([pad()], true, false).locked, true, 'hidden');
  assert.deepEqual(input.at([pad()]).locked, false);
  input.at([pad({ 13: true })]);
  assert.equal(input.at([]).connected, false);         // pulled out: released and locked
  assert.equal(input.at([pad({ 13: true })]).locked, true);
  assert.deepEqual(sent.slice(2), [[40, 1], [40, 0]]);
});

test('the press that starts the game reaches the game only after it was released', () => {
  const { input, sent } = mapper();
  const info = input.at([pad({ 0: true })]);           // start screen: A is reported, not sent
  assert.deepEqual([info.pressed, info.locked], [['a'], true]);
  input.at([pad({ 0: true })]);
  input.at([pad({ 0: true })]);
  assert.deepEqual(sent, []);
  input.at([pad()]);
  input.at([pad({ 0: true })]);
  assert.deepEqual(sent, [[90, 1]]);
});

test('a blocked key (OK that started the game or unlocked audio) never reaches the game, even held', () => {
  const { input, sent } = mapper();
  input.block(remote(13));
  for (let i = 0; i < 5; i++) assert.equal(input.keydown(remote(13)), null);
  input.keyup(remote(13));
  input.keydown(remote(13));
  assert.deepEqual(sent, [[90, 1]]);
});

test('holding Select for 2 s opens the menu once; a shorter press does not', () => {
  const { input } = mapper();
  const opened = [];
  for (let t = 0; t <= 3000; t += 100) if (input.sample([pad({ 8: true })], t, true, true).menu) opened.push(t);
  input.sample([pad()], 3100, true, true);
  for (let t = 3200; t <= 4800; t += 100) if (input.sample([pad({ 8: true })], t, true, true).menu) opened.push(t);
  assert.deepEqual(opened, [2000]);
});

test('without a standard pad the first one is used and flagged', () => {
  const odd = pad({}, [0, 0], '');
  assert.deepEqual(TH08Input.choosePad([null, odd]), { pad: odd, standard: false });
  const std = pad();
  assert.deepEqual(TH08Input.choosePad([odd, std]), { pad: std, standard: true });
  assert.equal(TH08Input.choosePad([null, null]), null);
});

test('a key passed from one pad source to another in one sample is not released in between', () => {
  const { input, sent } = mapper();
  input.at([pad()]);
  input.at([pad({ 4: true })]);                        // LB: focus
  input.at([pad({ 5: true })]);                        // RB instead, in the same sample
  input.at([pad({ 12: true })]);                       // D-pad up
  input.at([pad({}, [0, -0.9])]);                      // stick up instead, in the same sample
  input.at([pad()]);
  assert.deepEqual(sent, [[16, 1], [16, 0], [38, 1], [38, 0]]);
});
