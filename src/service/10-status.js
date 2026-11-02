// What the service knows, served on GET /status: the TV gives no other view of it.
var status = {
  version: VERSION,
  state: 'starting',          // starting | installing | ready | error
  error: null,
  progress: '',
  node: process.version,
  dataDir: null,
  launcherUrl: null,
  openMethod: null,           // devtools | launchUrl, once the spike page was opened
  openError: null,
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
