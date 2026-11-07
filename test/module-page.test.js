'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./harness');

const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const OPEN = 'POST http://127.0.0.1:8790/open';

// Runs the module page's inline script with stub DOM and network. Timers never fire: the
// test drives the page one step at a time (press a key, then let the promises settle).
async function runPage({ version, state, backForward }) {
  const requests = [];
  const keydown = [];
  const els = {};
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const ctx = {
    document: { getElementById(id) { return els[id] || (els[id] = { textContent: '' }); } },
    performance: { getEntriesByType: () => [{ type: backForward ? 'back_forward' : 'navigate' }] },
    history: { back() {} },
    setTimeout() { return 0; },
    clearTimeout() {},
    fetch(url, init) {
      const method = (init && init.method) || 'GET';
      requests.push(method + ' ' + url);
      const isStatus = url.endsWith('/status');
      const body = isStatus ? { version, state, reports: [] } : {};
      return Promise.resolve({ status: isStatus ? 200 : 202, json: () => Promise.resolve(body) });
    },
    addEventListener(type, fn) { if (type === 'keydown') keydown.push(fn); },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  await flush();
  return {
    requests,
    els,
    async press(keyCode) { keydown.forEach((fn) => fn({ keyCode })); await flush(); },
  };
}

test('after Back, OK does not ask a stale service to open the launcher', async () => {
  const page = await runPage({ version: '0.0.1', state: 'ready', backForward: true });
  await page.press(13);
  assert.ok(page.els.err.textContent.indexOf('0.0.1') >= 0, 'the stale warning is shown');
  assert.ok(page.requests.indexOf(OPEN) < 0, 'no POST /open: ' + page.requests.join(', '));
});

test('after Back, OK asks a service of the right version and state to open', async () => {
  const page = await runPage({ version: '0.0.2', state: 'ready', backForward: true });
  await page.press(13);
  assert.ok(page.requests.indexOf(OPEN) >= 0, 'POST /open sent: ' + page.requests.join(', '));
});

test('a stale service without a version is shown as "?"', async () => {
  const page = await runPage({ version: undefined, state: 'ready', backForward: false });
  assert.ok(page.els.err.textContent.indexOf('bản ?') >= 0, page.els.err.textContent);
  assert.ok(page.requests.indexOf(OPEN) < 0, 'no POST /open');
});
