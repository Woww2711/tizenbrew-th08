'use strict';
// Keyboard, TV remote and gamepad → the virtual keys (VK) th08-web reads through
// Module._th08_web_set_key_state(vk, 0/1) (spec §3.5). Every source is held separately
// (each keyboard key by its event.code, each pad button / stick direction) and OR-ed per
// VK; setKey is called only when the merged state of a VK changes, never to repeat.
// The pad sends nothing while locked: at the start, after blur / hidden / disconnect and
// around the launcher menu. It unlocks only when the page is focused and visible and the
// pad is connected and neutral (all buttons up, stick in the dead zone).
var TH08Input = (function () {
  // Keyboard keys by KeyboardEvent.code: upstream th08-web.html v0.1.0's table.
  var BY_CODE = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Numpad1: 97, Numpad2: 98,
    Numpad3: 99, Numpad4: 100, Numpad6: 102, Numpad7: 103, Numpad8: 104, Numpad9: 105, Home: 36, KeyP: 80,
    KeyD: 68, KeyZ: 90, KeyX: 88, ShiftLeft: 16, ShiftRight: 16, Escape: 27, ControlLeft: 17,
    ControlRight: 17, KeyQ: 81, KeyS: 83, KeyR: 82 };
  // The TV remote (SolarCell: arrows, OK, Back) by keyCode; Back = Esc (pause, never history.back).
  var BY_KEYCODE = { 37: 37, 38: 38, 39: 39, 40: 40, 10009: 27 };
  var OK = 13, BACK = 10009, VK_Z = 90;      // OK on the remote and Enter: Z (confirm/shoot)
  // Standard-mapping pad: A, B, LB, RB, Start, D-pad; Select (8) is the launcher's menu key.
  var BUTTONS = { 0: 90, 1: 88, 4: 16, 5: 16, 9: 27, 12: 38, 13: 40, 14: 37, 15: 39 };
  var NAMES = { 0: 'a', 1: 'b', 8: 'select', 9: 'start', 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
  var STICK_ON = 0.5, STICK_OFF = 0.35, MENU_HOLD_MS = 2000;

  // { vk } for a game key, { action: 'menu' } for F2 (the launcher menu), null for anything else.
  function classify(e) {
    if (e.code === 'F2') return { action: 'menu' };
    if (e.keyCode === OK) return { vk: VK_Z };
    if (Object.prototype.hasOwnProperty.call(BY_CODE, e.code)) return { vk: BY_CODE[e.code] };
    if (!e.code && Object.prototype.hasOwnProperty.call(BY_KEYCODE, e.keyCode)) return { vk: BY_KEYCODE[e.keyCode] };
    if (e.keyCode === BACK) return { vk: 27 };
    return null;
  }
  function physical(e) { return 'k:' + (e.code ? e.code : e.keyCode); }

  function pressedButton(b) { return !!b && (b.pressed || b.value > 0.5); }

  // The pad to use: the first with the standard mapping, else the first one (standard: false).
  function choosePad(pads) {
    var list = [];
    for (var i = 0; pads && i < pads.length; i++) if (pads[i] && pads[i].connected !== false) list.push(pads[i]);
    for (var j = 0; j < list.length; j++) if (list[j].mapping === 'standard') return { pad: list[j], standard: true };
    return list.length ? { pad: list[0], standard: false } : null;
  }

  function create(setKey) {
    var holds = {};            // source → VK
    var count = {};            // VK → sources holding it
    var blocked = {};          // keyboard keys ignored until their keyup
    var stick = { up: false, down: false, left: false, right: false };
    var padLocked = true, lastButtons = {}, menuSince = null, menuFired = false;

    // Sources change silently; commit() then tells setKey about every VK whose merged state
    // differs from the last commit, once (a pad going from LB to RB in one sample sends nothing).
    var sent = {};             // VK → 1 as last told to setKey
    function hold(id, vk) {
      if (holds[id] !== undefined) return;
      holds[id] = vk;
      count[vk] = (count[vk] || 0) + 1;
    }
    function release(id) {
      var vk = holds[id];
      if (vk === undefined) return;
      delete holds[id];
      count[vk]--;
      if (count[vk] === 0) delete count[vk];
    }
    function commit() {
      Object.keys(sent).forEach(function (vk) { if (!count[vk]) { delete sent[vk]; setKey(Number(vk), 0); } });
      Object.keys(count).forEach(function (vk) { if (!sent[vk]) { sent[vk] = 1; setKey(Number(vk), 1); } });
    }
    function releasePad() { Object.keys(holds).forEach(function (id) { if (id.indexOf('p:') === 0) release(id); }); }
    function releaseAll() { Object.keys(holds).forEach(release); commit(); }

    // Stick with hysteresis: a direction turns on at ≥ STICK_ON and off below STICK_OFF.
    function stickDir(dir, value) {
      if (!stick[dir] && value >= STICK_ON) stick[dir] = true;
      else if (stick[dir] && value < STICK_OFF) stick[dir] = false;
      return stick[dir];
    }

    // One sample of navigator.getGamepads() (every animation frame while visible, and on
    // focus / visibilitychange / gamepadconnected). Returns { connected, standard, locked,
    // pressed: [names of buttons newly down], menu: true once Select was held MENU_HOLD_MS }.
    function sample(pads, now, focused, visible) {
      var chosen = choosePad(pads);
      var info = { connected: !!chosen, standard: !!chosen && chosen.standard, locked: padLocked, pressed: [], menu: false };
      if (!chosen) { releasePad(); commit(); padLocked = true; lastButtons = {}; menuSince = null; info.locked = true; return info; }
      var pad = chosen.pad, axes = pad.axes || [], buttons = pad.buttons || [];
      var x = axes[0] || 0, y = axes[1] || 0;
      var dirs = { up: stickDir('up', -y), down: stickDir('down', y), left: stickDir('left', -x), right: stickDir('right', x) };
      var neutral = Math.abs(x) < STICK_OFF && Math.abs(y) < STICK_OFF;
      var now_ = {};
      for (var i = 0; i < buttons.length; i++) {
        if (pressedButton(buttons[i])) { now_[i] = true; neutral = false; }
      }
      Object.keys(now_).forEach(function (i) { if (!lastButtons[i] && NAMES[i]) info.pressed.push(NAMES[i]); });
      lastButtons = now_;
      if (now_[8]) {
        if (menuSince === null) menuSince = now;
        if (!menuFired && now - menuSince >= MENU_HOLD_MS) { menuFired = true; info.menu = true; }
      } else {
        menuSince = null;
        menuFired = false;
      }
      if (padLocked && focused && visible && neutral) padLocked = false;
      info.locked = padLocked;
      if (padLocked) return info;
      Object.keys(BUTTONS).forEach(function (b) {
        if (now_[b]) hold('p:b' + b, BUTTONS[b]); else release('p:b' + b);
      });
      var stickVk = { up: 38, down: 40, left: 37, right: 39 };
      Object.keys(dirs).forEach(function (d) { if (dirs[d]) hold('p:s' + d, stickVk[d]); else release('p:s' + d); });
      commit();
      return info;
    }

    return {
      // Returns classify(e); a game key is held from its first keydown (repeats change nothing).
      // A key passed to block() is ignored until its keyup (null).
      keydown: function (e) {
        var id = physical(e);
        if (blocked[id]) return null;
        var c = classify(e);
        if (c && c.vk !== undefined) { hold(id, c.vk); commit(); }
        return c;
      },
      keyup: function (e) {
        var id = physical(e);
        if (blocked[id]) { delete blocked[id]; return null; }
        release(id);
        commit();
        return classify(e);
      },
      // The key of e (the OK that started the game or unlocked audio) never reaches the game.
      block: function (e) { blocked[physical(e)] = true; release(physical(e)); commit(); },
      sample: sample,
      // Lets go of every key (keyboard and pad) and makes the pad wait for neutral again.
      lock: function () { releaseAll(); padLocked = true; },
      releaseAll: releaseAll,
      held: function () { return Object.keys(count).map(Number).sort(function (a, b) { return a - b; }); }
    };
  }

  return { classify: classify, create: create, choosePad: choosePad, OK: OK, BACK: BACK, MENU_HOLD_MS: MENU_HOLD_MS };
})();

if (typeof module === 'object' && module.exports) module.exports = TH08Input;
