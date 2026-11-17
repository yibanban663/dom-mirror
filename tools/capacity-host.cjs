'use strict';

// Test-only host: public test control routes, never a production authentication example.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer').default;
const { createMirror } = require('..');
const output = process.env.EVIDENCE_DIR;
if (!output) throw new Error('EVIDENCE_DIR is required');
fs.mkdirSync(output, { recursive: true });
const browsers = [];
const launch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async options => {
  const browser = await launch(options);
  // Keep scalar evidence only: retaining Browser objects can retain session closures/buffers after close.
  const record = { pid: browser.process().pid, closed: false, connected: true };
  browser.once('disconnected', () => { record.connected = false; });
  const close = browser.close.bind(browser);
  browser.close = async () => { await close(); record.closed = true; };
  browsers.push(record);
  return browser;
};
const mode = process.env.CAPACITY_MODE || 'dom';
const count = Number(process.env.CAPACITY_SESSIONS || 1);
const mirror = createMirror({ originUrl: 'http://load:9000/', maxSessions: count,
  sessionGraceMs: 3000, defaultMode: mode, obfuscate: false,
  getSessionIdentity: () => 'synthetic-capacity', logger: { log() {} } });
let phase = 'baseline';
const started = performance.now();
const resources = [];
function stat(name) {
  return Object.fromEntries(fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim().split('\n').map(line => {
    const [key, value] = line.split(/\s+/); return [key, Number(value)];
  }));
}
function sample() {
  const row = { ms: performance.now() - started, phase,
    memory: Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8')),
    memoryStat: stat('memory.stat'), cpu: stat('cpu.stat'), events: stat('memory.events') };
  resources.push(row);
  return row;
}
function status() {
  return { launched: browsers.length, browsers: browsers.map(record => ({ ...record,
    processGone: !fs.existsSync('/proc/' + record.pid) })) };
}
function save() {
  sample();
  const hashes = Object.fromEntries(['server.js', 'client/index.html', 'lib/sessions.js', 'tools/fixtures/capacity.html',
    'tools/capacity-host.cjs', 'tools/capacity-client.cjs', 'tools/profile-client.cjs', 'tools/fixtures/capacity-plan.json',
    'tools/verify-docker-capacity.sh', 'tools/run-capacity-matrix.sh', 'tools/summarize-capacity.cjs'].map(file => [file,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex')]));
  fs.writeFileSync(path.join(output, 'server.json'), JSON.stringify({ mode, count, node: process.version, hashes,
    cpuMax: fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(), memoryMax: fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
    status: status(), resources }, null, 2));
}
sample();
const interval = setInterval(sample, 250);
interval.unref();
const server = http.createServer((req, res) => {
  if (req.url === '/__capacity/status') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status())); return; }
  if (req.method === 'POST' && req.url.startsWith('/__capacity/phase/')) {
    sample(); phase = req.url.slice('/__capacity/phase/'.length); sample(); res.end('ok'); return;
  }
  mirror.handleRequest(req, res);
});
server.on('upgrade', mirror.handleUpgrade);
server.listen(8088, '0.0.0.0');
let closing;
function close() {
  return closing ??= (async () => {
    const stopped = new Promise(resolve => server.close(resolve));
    await mirror.close(); server.closeAllConnections(); await stopped;
    clearInterval(interval); save();
  })();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => close().catch(error => { console.error(error); process.exitCode = 1; }));
