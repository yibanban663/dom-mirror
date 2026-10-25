'use strict';
// Isolated real-business host using the public API; never loaded by the package entrypoint.
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const puppeteer = require('puppeteer').default;
const sharp = require('sharp');
const native = require('./native-memory.node');
const { createMirror } = require('..');
const browsers = [];
const launch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async options => {
  const browser = await launch(options);
  const record = { pid: browser.process().pid, closed: false, connected: true,
    jemallocMapped: fs.readFileSync(`/proc/${browser.process().pid}/maps`, 'utf8').includes('libjemalloc') };
  browser.once('disconnected', () => { record.connected = false; });
  const close = browser.close.bind(browser);
  browser.close = async () => { await close(); record.closed = true; };
  browsers.push(record);
  return browser;
};
const mirror = createMirror({ originUrl: process.env.ORIGIN_URL, defaultMode: 'dom', obfuscate: false,
  sessionGraceMs: Number(process.env.SESSION_GRACE_MS || 60000),
  launchOptions: { env: { ...process.env, LD_PRELOAD: '', MALLOC_CONF: '' } } });
function status() {
  const files = ['server.js', 'client/index.html', 'lib/sessions.js', 'tools/allocator-business-host.cjs',
    'tools/verify-vikunja.cjs', 'tools/verify-recovery.cjs', 'tools/native-memory.c'];
  return { node: process.version, allocator: native.allocatorStats(), sharpConcurrency: sharp.concurrency(),
    env: { LD_PRELOAD: process.env.LD_PRELOAD, MALLOC_CONF: process.env.MALLOC_CONF,
      MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX, VIPS_CONCURRENCY: process.env.VIPS_CONCURRENCY },
    browsers: browsers.map(record => ({ ...record, processGone: !fs.existsSync('/proc/' + record.pid) })),
    hashes: Object.fromEntries(files.map(file => [file, crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex')])) };
}
const server = http.createServer((req, res) => {
  if (req.url === '/__allocator/status') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status())); return; }
  mirror.handleRequest(req, res);
});
server.on('upgrade', mirror.handleUpgrade);
server.listen(8088, '0.0.0.0');
let closing;
function close() {
  return closing ??= (async () => {
    const stopped = new Promise(resolve => server.close(resolve));
    await mirror.close(); server.closeAllConnections(); await stopped;
  })();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => close().catch(error => { console.error(error); process.exitCode = 1; }));
