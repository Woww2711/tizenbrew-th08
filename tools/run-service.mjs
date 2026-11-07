// Runs service.js on this machine the way TizenBrew does, for trying the launcher in a
// desktop browser. Env: TH08_DATA_DIR (required), TH08_LAUNCHER_BASE (default: local dev server).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadService } = require('../test/harness.js');

if (!process.env.TH08_DATA_DIR) throw new Error('set TH08_DATA_DIR');
const svc = loadService({ TH08_LAUNCHER_BASE: process.env.TH08_LAUNCHER_BASE || 'http://127.0.0.1:8791/launcher/' });
setInterval(() => {
  const s = svc.status;
  console.log(`${s.state} ${s.progress} ${s.error || ''} reports=${s.reports.length}`);
  for (const r of s.reports.splice(0)) console.log('  report', JSON.stringify(r));
}, 2000);
