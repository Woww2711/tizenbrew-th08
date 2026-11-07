'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { readRecord } = require('../launcher/probe.js');

const fsWith = (content, err) => ({ readFile() { if (err) throw err; return content; } });
const good = { count: 2, at: 'x', version: '0.0.2', history: [{ count: 1 }, { count: 2 }] };

test('a missing file (ENOENT, either Emscripten style) means no record yet', () => {
  assert.deepEqual(readRecord(fsWith(null, Object.assign(new Error('x'), { errno: 44 })), '/f'), { missing: true });
  assert.deepEqual(readRecord(fsWith(null, Object.assign(new Error('x'), { code: 'ENOENT' })), '/f'), { missing: true });
});

test('a valid record is returned', () => {
  assert.deepEqual(readRecord(fsWith(JSON.stringify(good)), '/f'), { record: good });
});

test('other read errors, corrupt JSON and wrong schemas are errors, never "missing"', () => {
  const bad = [fsWith(null, Object.assign(new Error('EIO'), { errno: 29 })), fsWith(null, Object.assign(new Error('EACCES'), { errno: 2 })), fsWith('{oops'), fsWith('null'), fsWith('{}'),
    fsWith(JSON.stringify(Object.assign({}, good, { count: 'a' }))), fsWith(JSON.stringify(Object.assign({}, good, { count: 0 }))),
    fsWith(JSON.stringify(Object.assign({}, good, { history: {} }))),
    fsWith(JSON.stringify(Object.assign({}, good, { history: [null] })))];
  bad.forEach((fs, i) => { const r = readRecord(fs, '/f'); assert.ok(r.error && !r.missing && !r.record, 'case ' + i); });
});
