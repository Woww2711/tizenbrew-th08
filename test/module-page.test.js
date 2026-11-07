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

const SETUP = 'POST http://127.0.0.1:8790/setup';

// Runs the module page's inline script with stub DOM and network. Timers never fire by
// themselves: fire(ms) runs the timers with that delay once, so the test steps the page.
// net.statusDown makes /status fail (connection lost); net.openStatus is the answer to /open;
// net.ready (default: state is 'ready') and net.setup go into /status; net.setupStatus and
// net.setupAnswer answer POST /setup, whose bodies land in net.setupBodies.
async function runPage({ version, state, backForward, openStatus, ready, setup }) {
  const requests = [];
  const listeners = {};
  const timers = [];
  const els = {};
  const net = { statusDown: false, openStatus: openStatus === undefined ? 202 : openStatus,
    ready: ready === undefined ? state === 'ready' : ready, setup: setup || null, setupStatus: 202,
    setupAnswer: { started: true }, setupBodies: [] };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const document = {
    activeElement: null,
    getElementById(id) {
      return els[id] || (els[id] = { id, textContent: '', value: '', hidden: false, handlers: {},
        focus() { document.activeElement = this; },
        addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
        click() { (this.handlers.click || []).forEach((fn) => fn({})); } });
    },
  };
  const ctx = {
    document,
    performance: { getEntriesByType: () => [{ type: backForward ? 'back_forward' : 'navigate' }] },
    history: { back() {} },
    setTimeout(fn, ms) { timers.push({ fn: fn, ms: ms }); return 0; },
    clearTimeout() {},
    fetch(url, init) {
      const method = (init && init.method) || 'GET';
      requests.push(method + ' ' + url);
      const isStatus = url.endsWith('/status');
      if (isStatus && net.statusDown) return Promise.reject(new Error('connection lost'));
      if (url.endsWith('/setup')) {
        net.setupBodies.push(JSON.parse(init.body));
        return Promise.resolve({ status: net.setupStatus, json: () => Promise.resolve(net.setupAnswer) });
      }
      if (!isStatus && net.hangOpen) return new Promise(function () {});
      const body = isStatus ? { version, state, ready: net.ready, setup: net.setup, reports: [] } : { error: 'stub' };
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
      (listeners.keydown || []).forEach((fn) => fn({ keyCode: keyCode, preventDefault() {} }));
      await flush();
    },
    async click(id) {
      els[id].click();
      await flush();
    },
    setups() { return requests.filter((r) => r === SETUP).length; },
    el(id) { return document.getElementById(id); },
    focused() { return document.activeElement && document.activeElement.id; },
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

const running = (got) => ({ state: 'running', phase: 'download', from: '192.168.1.10:8765', error: null, files: [
  { name: 'th08.dat', size: 46838025, got: 46838025, phase: 'done', attempt: 1 },
  { name: 'thbgm.dat', size: 449961024, got: got, phase: 'download', attempt: 2 }] });
const failed = (phase, error) => ({ state: 'error', phase, from: '192.168.1.10:8765', error, files: [] });

test('without game data the form is shown with the default IP and port; nothing opens', async () => {
  const page = await runPage({ version: VERSION, state: 'ready', ready: false });
  assert.equal(page.els.setup.hidden, false);
  assert.equal(page.els.ip.value, '192.168.1.10');
  assert.equal(page.els.port.value, '8765');
  assert.equal(page.els.start.textContent, 'Bắt đầu');
  assert.equal(page.focused(), 'token');
  assert.equal(page.opens(), 0);
  await page.press(40);                  // ▼ from the token field goes to the button, and stays there
  await page.press(40);
  assert.equal(page.focused(), 'start');
  await page.press(38);
  await page.press(38);
  assert.equal(page.focused(), 'port');
});

test('Bắt đầu checks the form, sends POST /setup and then shows the progress per file', async () => {
  const page = await runPage({ version: VERSION, state: 'ready', ready: false });
  page.el('token').value = 'ab';
  await page.click('start');
  assert.equal(page.setups(), 0, 'a bad token is not sent');
  assert.match(page.els.err.textContent, /^Mã là dãy số/);
  page.el('token').value = ' 12345678 ';
  await page.click('start');
  assert.deepEqual(page.net.setupBodies, [{ ip: '192.168.1.10', port: 8765, token: '12345678' }]);
  assert.equal(page.els.setup.hidden, true);
  page.net.setup = running(157286400);
  await page.fire(1000);
  assert.equal(page.els.progress.textContent,
    'th08.dat: xong 44.7 MiB / 44.7 MiB\nthbgm.dat: đang tải 150.0 MiB / 429.1 MiB (lần 2)');
  assert.match(page.els.msg.textContent, /Đang chép dữ liệu từ 192\.168\.1\.10:8765/);
});

test('setup errors are explained in Vietnamese and the button becomes Thử lại', async () => {
  const cases = [
    [failed('manifest', { code: 'token', message: 'x' }), /^Sai mã: máy tính trả lỗi 403/],
    [failed('manifest', { code: 'network', message: 'cannot reach the PC server: connect ECONNREFUSED' }),
      /^Không kết nối được máy tính 192\.168\.1\.10:8765 \(cannot reach.*tường lửa Windows/s],
    [failed('download', { code: 'hash', message: 'thbgm.dat: SHA-256 …' }), /^Dữ liệu không khớp SHA-256 sau 3 lần tải/],
    [failed('space', { code: 'space', message: 'x', need: 566231040, free: 104857600 }),
      /^Không đủ dung lượng trống: cần 540\.0 MiB, còn 100\.0 MiB\./]];
  for (const [setup, re] of cases) {
    const page = await runPage({ version: VERSION, state: 'ready', ready: false, setup });
    assert.match(page.els.err.textContent, re);
    assert.equal(page.els.start.textContent, 'Thử lại');
    assert.equal(page.els.setup.hidden, false);
  }
});

test('a refused POST /setup is shown and kept over the last run error', async () => {
  const page = await runPage({ version: VERSION, state: 'ready', ready: false,
    setup: failed('manifest', { code: 'token', message: 'x' }) });
  page.net.setupStatus = 409;
  page.net.setupAnswer = { error: 'the service is not ready', code: 'not-ready' };
  page.el('token').value = '12345678';
  await page.click('start');
  await page.fire(1000);
  assert.match(page.els.err.textContent, /^Service từ chối \(HTTP 409\): the service is not ready/);
  page.net.setupAnswer = { error: 'the game data is already set up', code: 'already-set' };
  await page.click('start');
  assert.match(page.els.err.textContent, /^Dữ liệu game đã có trên TV/);
});

test('when the copy is done and the service is ready, the launcher opens', async () => {
  const page = await runPage({ version: VERSION, state: 'ready', ready: false, setup: running(1) });
  assert.equal(page.opens(), 0);
  page.net.ready = true;
  page.net.setup = Object.assign(running(449961024), { state: 'done', phase: 'done' });
  await page.fire(1000);
  assert.equal(page.opens(), 1, page.requests.join(', '));
  assert.equal(page.els.setup.hidden, true);
  assert.equal(page.els.progress.textContent, '');
});

test('409 running means already copying: the form is hidden and the progress follows', async () => {
  const page = await runPage({ version: VERSION, state: 'ready', ready: false });
  page.net.setupStatus = 409;
  page.net.setupAnswer = { error: 'a setup is already running', code: 'running' };
  page.el('token').value = '12345678';
  await page.click('start');
  assert.equal(page.els.setup.hidden, true);
  assert.equal(page.els.msg.textContent, 'Đang chép…');
  assert.equal(page.els.err.textContent, '');
});

test('the run error replaces an earlier form error once a run has been seen', async () => {
  const page = await runPage({ version: VERSION, state: 'ready', ready: false });
  page.el('token').value = 'ab';
  await page.click('start');
  assert.match(page.els.err.textContent, /^Mã là dãy số/);
  page.net.setup = running(1);
  await page.fire(1000);
  page.net.setup = failed('manifest', { code: 'token', message: 'x' });
  await page.fire(1000);
  assert.match(page.els.err.textContent, /^Sai mã: máy tính trả lỗi 403/);
});

test('a stale service gets no POST /setup and the form is hidden', async () => {
  const page = await runPage({ version: '0.0.1', state: 'ready', ready: false });
  assert.equal(page.els.setup.hidden, true);
  page.el('token').value = '12345678';
  await page.click('start');
  assert.equal(page.setups(), 0);
});

test('stale progress is cleared when the service stops answering', async () => {
  const page = await runPage({ version: VERSION, state: 'ready', ready: false, setup: running(1) });
  assert.match(page.els.progress.textContent, /thbgm\.dat/);
  page.net.statusDown = true;
  await page.fire(1000);
  assert.equal(page.els.progress.textContent, '');
  assert.equal(page.els.setup.hidden, true);
});
