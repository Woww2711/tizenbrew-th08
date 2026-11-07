// Serves synthetic game data the way pc/serve-th08-data.ps1 does, for trying the setup on
// this PC: the service in WSL cannot reach a server on Windows (the firewall drops it).
// th08.dat is 4 KiB, thbgm.dat 8 MiB (byte i = i mod 251). --slow sends thbgm.dat at 64 KiB
// per 50 ms (about 6 s), so the server can be stopped in the middle of it.
// Usage: node tools/fake-pc-server.mjs <port> <token> [--slow]
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startFakePc } = require('../test/fake-pc.js');
const { syntheticData, syntheticByte } = require('../test/harness.js');

const [port, token, flag] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
if (!port || !token) throw new Error('usage: node tools/fake-pc-server.mjs <port> <token> [--slow]');
const thbgm = Buffer.alloc(8 * 1048576);
for (let i = 0; i < thbgm.length; i++) thbgm[i] = syntheticByte(i);
const data = { 'th08.dat': syntheticData()['th08.dat'], 'thbgm.dat': thbgm };
const pc = await startFakePc({ port, token, data, slow: flag === '--slow' ? 'thbgm.dat' : undefined });
console.log(`fake PC server on http://127.0.0.1:${port}/ token ${token}${flag === '--slow' ? ' (slow)' : ''}`);
let shown = 0;
setInterval(() => { for (const r of pc.seen.slice(shown)) console.log('  ' + r); shown = pc.seen.length; }, 500);
