'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, VERSION } = require('./harness');

const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const OPEN = 'POST http://127.0.0.1:8790/open';

// Runs the module page's inline script with stub DOM and network. Timers never fire by
// themselves: fire(ms) runs the timers with that delay once, so the test steps the page.
// net.statusDown makes /status fail (connection lost); net.openStatus is the answer to /open.
async function runPage({ version, state, backForward, openStatus }) {
  const requests = [];
  const listeners = {};
  const timers = [];
  const els = {};
  const net = { statusDown: false, openStatus: openStatus === undefined ? 202 : openStatus };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const ctx = {
    document: { getElementById(id) { return els[id] || (els[id] = { textContent: '' }); } },
    performance: { getEntriesByType: () => [{ type: backForward ? 'back_forward' : 'navigate' }] },
    history: { back() {} },
    setTimeout(fn, ms) { timers.push({ fn: fn, ms: ms }); return 0; },
    clearTimeout() {},
    fetch(url, init) {
      const method = (init && init.method) || 'GET';
      requests.push(method + ' ' + url);
      const isStatus = url.endsWith('/status');
      if (isStatus && net.statusDown) return Promise.reject(new Error('connection lost'));
      if (!isStatus && net.hangOpen) return new Promise(function () {});
      const body = isStatus ? { version, state, reports: [] } : { error: 'stub' };
      return Promise.resolve({ status: isStatus ? 200 : net.openStatus, json: () => Promise.resolve(body) });
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  await flush();
  return {
    requests,
    els,
    net,
    opens() { return requests.filter((r) => r === OPEN).length; },
    async fire(ms) {
      const due = timers.filter((t) => t.ms === ms);
      due.forEach((t) => timers.splice(timers.indexOf(t), 1));
      due.forEach((t) => t.fn());
      await flush();
    },
    async press(keyCode) {
      (listeners.keydown || []).forEach((fn) => fn({ keyCode: keyCode }));
      await flush();
    },
    async pageshow(persisted) {
      (listeners.pageshow || []).forEach((fn) => fn({ persisted: persisted }));
      await flush();
    },
  };
}

test('after Back, OK does not ask a stale service to open the launcher', async () => {
  const page = await runPage({ version: '0.0.1', state: 'ready', backForward: true });
  await page.press(13);
  assert.ok(page.els.err.textContent.indexOf('0.0.1') >= 0, 'the stale warning is shown');
  assert.equal(page.opens(), 0, 'no POST /open: ' + page.requests.join(', '));
});

test('after Back, OK asks a service of the right version and state to open', async () => {
  const page = await runPage({ version: VERSION, state: 'ready', backForward: true });
  await page.press(13);
  assert.equal(page.opens(), 1, 'POST /open sent: ' + page.requests.join(', '));
});

test('a stale service without a version is shown as "?"', async () => {
  const page = await runPage({ version: undefined, state: 'ready', backForward: false });
  assert.ok(page.els.err.textContent.indexOf('bản ?') >= 0, page.els.err.textContent);
  assert.equal(page.opens(), 0, 'no POST /open');
});

test('an open refused, then a lost connection, is sent again once the service is ready', async () => {
  const page = await runPage({ version: VERSION, state: 'ready', backForward: false, openStatus: 500 });
  assert.equal(page.opens(), 1, 'the first open was sent and refused');
  page.net.statusDown = true;
  await page.fire(1000);                 // poll: connection lost
  await page.fire(2000);                 // retry: gate closed, nothing sent
  assert.equal(page.opens(), 1, 'no POST while the service is unreachable');
  page.net.statusDown = false;
  page.net.openStatus = 202;
  await page.fire(1000);                 // poll: ready again
  assert.equal(page.opens(), 2, 'pending open sent: ' + page.requests.join(', '));
});

test('after Back, a retry waits for OK instead of opening on its own', async () => {
  const page = await runPage({ version: VERSION, state: 'ready', backForward: false, openStatus: 500 });
  assert.equal(page.opens(), 1, 'the first open was sent and refused');
  await page.pageshow(true);             // came back from the back/forward cache: waitOk
  page.net.openStatus = 202;
  await page.fire(2000);                 // the retry fires with the service up: still no open
  await page.fire(1000);                 // poll: ready, shows the OK prompt
  assert.equal(page.opens(), 1, 'no auto open after Back: ' + page.requests.join(', '));
  assert.ok(page.els.msg.textContent.indexOf('OK') >= 0, page.els.msg.textContent);
  await page.press(13);                  // OK sends it
  assert.equal(page.opens(), 2, 'OK sends the open');
});

test('the error of three failed opens stays on screen after the service answers ready', async () => {
  const page = await runPage({ version: VERSION, state: 'ready', backForward: false, openStatus: 500 });
  await page.fire(2000);                 // retry 2: refused
  await page.fire(2000);                 // retry 3: refused, final error
  assert.equal(page.opens(), 3, 'three attempts: ' + page.requests.join(', '));
  assert.ok(page.els.err.textContent.indexOf('Không gửi được') >= 0, page.els.err.textContent);
  await page.fire(1000);                 // poll: ready
  await page.fire(1000);                 // and again
  assert.ok(page.els.err.textContent.indexOf('Không gửi được') >= 0, 'error still shown: ' + page.els.err.textContent);
  assert.equal(page.els.msg.textContent, '');
  assert.equal(page.opens(), 3, 'no further attempts');
});

test('OK does not send a second open while one is still in flight', async () => {
  const page = await runPage({ version: VERSION, state: 'ready', backForward: true });
  page.net.hangOpen = true;              // the first POST never gets an answer
  await page.press(13);
  assert.equal(page.opens(), 1, 'first POST sent');
  await page.pageshow(true);             // back/forward cache again: waitOk while the POST is waiting
  await page.press(13);
  assert.equal(page.opens(), 1, 'no second POST: ' + page.requests.join(', '));
});
