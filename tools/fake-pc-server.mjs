// Serves game data the way pc/serve-th08-data.ps1 does, for trying the setup on this PC: the
// service in WSL cannot reach a server on Windows (the firewall drops it).
// Default: synthetic data, th08.dat 4 KiB, thbgm.dat 8 MiB (byte i = i mod 251). --slow sends
// thbgm.dat at 64 KiB per 50 ms (about 6 s), so the server can be stopped in the middle of it.
// --dir <folder> serves your own th08.dat and thbgm.dat from <folder>, read-only, for a local
// trial of the real game (never copy them into this repository).
// Usage: node tools/fake-pc-server.mjs <port> <token> [--slow | --dir <folder>]
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { startFakePc } = require('../test/fake-pc.js');
const { syntheticData, syntheticByte } = require('../test/harness.js');

const [port, token, flag, dir] = [Number(process.argv[2]), process.argv[3], process.argv[4], process.argv[5]];
if (!port || !token || (flag === '--dir' && !dir)) {
  throw new Error('usage: node tools/fake-pc-server.mjs <port> <token> [--slow | --dir <folder>]');
}
let data;
if (flag === '--dir') {
  data = { 'th08.dat': readFileSync(join(dir, 'th08.dat')), 'thbgm.dat': readFileSync(join(dir, 'thbgm.dat')) };
} else {
  const thbgm = Buffer.alloc(8 * 1048576);
  for (let i = 0; i < thbgm.length; i++) thbgm[i] = syntheticByte(i);
  data = { 'th08.dat': syntheticData()['th08.dat'], 'thbgm.dat': thbgm };
}
const pc = await startFakePc({ port, token, data, slow: flag === '--slow' ? 'thbgm.dat' : undefined });
console.log(`fake PC server on http://127.0.0.1:${port}/ token ${token}` +
  (flag === '--slow' ? ' (slow)' : flag === '--dir' ? ` (files from ${dir})` : ''));
let shown = 0;
setInterval(() => { for (const r of pc.seen.slice(shown)) console.log('  ' + r); shown = pc.seen.length; }, 500);
