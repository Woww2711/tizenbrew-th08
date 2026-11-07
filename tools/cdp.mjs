// Drives a desktop Chromium started with --remote-debugging-port, for trying the launcher.
// Usage: node tools/cdp.mjs <port> eval <expression>          (awaits promises, prints the value)
//        node tools/cdp.mjs <port> key <name> [holdMs] [times] [repeat]  (trusted key events)
//        node tools/cdp.mjs <port> shot <file.png>
//        node tools/cdp.mjs <port> nav <url>
//        node tools/cdp.mjs <port> pad press <button> [holdMs] [times]   (a fake standard gamepad)
//        node tools/cdp.mjs <port> pad axis <axis> <value> [holdMs]
// Key names: keyboard codes (KeyZ, KeyX, ShiftLeft, Escape, Enter, ArrowUp…, F2) and the TV
// remote's Back (sent with its Tizen keyCode and no code). The fake pad replaces
// navigator.getGamepads() in the page: it proves the launcher's mapping, not a real pad's.
import { writeFileSync } from 'node:fs';

const [port, cmd, ...args] = process.argv.slice(2);
const KEYS = { Enter: ['Enter', 'Enter', 13], KeyZ: ['KeyZ', 'z', 90], KeyX: ['KeyX', 'x', 88],
  ShiftLeft: ['ShiftLeft', 'Shift', 16], Escape: ['Escape', 'Escape', 27], F9: ['F9', 'F9', 120],
  ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowRight: ['ArrowRight', 'ArrowRight', 39],
  F2: ['F2', 'F2', 113], Back: ['', 'XF86Back', 10009] };
// Installs (once) a connected standard-mapping pad that the page reads through getGamepads().
const FAKE_PAD = `window.__pad || (function () {
  var p = { id: 'CDP fake pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: [] };
  for (var i = 0; i < 17; i++) p.buttons.push({ pressed: false, touched: false, value: 0 });
  navigator.getGamepads = function () { return [p, null, null, null]; };
  window.__pad = p;
  // Like a real one, the event carries the pad: th08-web's SDL reads e.gamepad on its own thread.
  var ev = new Event('gamepadconnected');
  Object.defineProperty(ev, 'gamepad', { value: p });
  window.dispatchEvent(ev);
  return p;
})()`;

const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const waiting = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: args[0], awaitPromise: true, returnByValue: true });
  const v = r.result.exceptionDetails ? r.result.exceptionDetails : r.result.result.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v));
} else if (cmd === 'key') {
  const [name, hold = '120', times = '1', repeat] = args;
  if (!KEYS[name]) throw new Error('unknown key ' + name);
  const [code, key, keyCode] = KEYS[name];
  const ev = (type, autoRepeat = false) => send('Input.dispatchKeyEvent', { type, code, key, autoRepeat,
    windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  for (let i = 0; i < Number(times); i++) {
    await ev('keyDown');
    // "repeat": auto-repeat keydowns every 100 ms while held, like a key held on a keyboard or remote.
    for (let t = 100; repeat === 'repeat' && t < Number(hold); t += 100) { await sleep(100); await ev('keyDown', true); }
    await sleep(repeat === 'repeat' ? Number(hold) % 100 : Number(hold));
    await ev('keyUp');
    await sleep(250);
  }
} else if (cmd === 'pad') {
  const [what, index, a, b] = args;
  const set = (expr) => send('Runtime.evaluate', { expression: FAKE_PAD + ';' + expr });
  await set('0');
  if (what === 'press') {
    for (let i = 0; i < Number(b || 1); i++) {
      await set(`__pad.buttons[${Number(index)}] = { pressed: true, touched: true, value: 1 }`);
      await sleep(Number(a || 120));
      await set(`__pad.buttons[${Number(index)}] = { pressed: false, touched: false, value: 0 }`);
      await sleep(250);
    }
  } else if (what === 'axis') {
    await set(`__pad.axes[${Number(index)}] = ${Number(a)}`);
    await sleep(Number(b || 120));
    await set(`__pad.axes[${Number(index)}] = 0`);
    await sleep(250);
  } else if (what !== 'connect') {
    throw new Error('unknown pad action ' + what);
  }
} else if (cmd === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(args[0], Buffer.from(r.result.data, 'base64'));
} else if (cmd === 'nav') {
  await send('Page.navigate', { url: args[0] });
} else {
  throw new Error('unknown command ' + cmd);
}
ws.close();
process.exit(0);
