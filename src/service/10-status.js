// What the service knows, served on GET /status: the TV gives no other view of it.
var status = {
  version: VERSION,
  state: 'starting',          // starting | installing | ready | error | blocked | stopped
  error: null,
  progress: '',
  node: process.version,
  dataDir: null,
  launcherUrl: null,
  openMethod: null,           // devtools | launchUrl, once the launcher was opened
  openError: null,
  startedAt: new Date().toISOString(),
  disk: null,                 // { method, path, free, total } or { method, path, error }
  takeover: null,             // set when port PORT was busy at start, see 45-takeover.js
  reports: [],
  log: []
};

function log(msg) {
  status.log.push(new Date().toISOString().slice(11, 19) + ' ' + msg);
  if (status.log.length > 50) status.log.shift();
}

function addReport(report) {
  status.reports.push(report);
  if (status.reports.length > 200) status.reports.shift();
}
