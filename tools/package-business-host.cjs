'use strict';
// Test-only independent consumer. Control endpoints belong to the isolated fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createRequire } = require('node:module');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expected = require('./expected.json');
assert.equal(process.env.NODE_PATH, '');
assert.equal(fs.existsSync('/app'), false, 'source checkout remains accessible');
const entry = fs.realpathSync(require.resolve('@lizhen-xxaq/dom-mirror'));
const packageRoot = path.dirname(entry);
assert.equal(packageRoot, '/consumer/node_modules/@lizhen-xxaq/dom-mirror');
assert.equal(sha256(fs.readFileSync('/consumer/package.tgz')), expected.archiveSha256);
for (const [file, hash] of Object.entries(expected.files)) {
  assert.equal(sha256(fs.readFileSync(path.join(packageRoot, file))), hash, 'archive file differs: ' + file);
}
const installed = require(path.join(packageRoot, 'package.json'));
assert.equal(installed.name, expected.name);
assert.equal(installed.version, expected.version);
const resolvePackage = createRequire(entry);
const dependencies = Object.fromEntries(Object.keys(installed.dependencies).map(name => {
  const resolved = fs.realpathSync(resolvePackage.resolve(name));
  assert.ok(resolved.startsWith('/consumer/node_modules/'), 'dependency outside consumer: ' + name);
  return [name, resolved];
}));
const puppeteer = resolvePackage('puppeteer').default;
const browsers = [];
const contexts = [];
const launch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async options => {
  const browser = await launch(options);
  const record = { pid: browser.process().pid, closed: false, connected: true };
  const close = browser.close.bind(browser);
  browser.close = async () => { await close(); record.closed = true; };
  browser.once('disconnected', () => { record.connected = false; });
  // v0.30 实例池：会话级资源是 BrowserContext——按上下文追踪（池化浏览器
  // 常驻复用，进程级 reclaimed 语义移到 contexts）
  const origCtx = browser.createBrowserContext.bind(browser);
  browser.createBrowserContext = async (...args) => {
    const ctx = await origCtx(...args);
    const rec = { pid: record.pid, closed: false, connected: true };
    const cc = ctx.close.bind(ctx);
    ctx.close = async () => { await cc(); rec.closed = true; rec.connected = false; };
    browser.once('disconnected', () => { rec.connected = false; });
    contexts.push(rec);
    return ctx;
  };
  browsers.push(record);
  return browser;
};
const { createMirror } = require('@lizhen-xxaq/dom-mirror');
const mirror = createMirror({ originUrl: process.env.ORIGIN_URL, obfuscate: false,
  sessionGraceMs: Number(process.env.SESSION_GRACE_MS || 2000) });
function status() {
  const loaded = Object.keys(require.cache).map(file => fs.realpathSync(file));
  assert.ok(loaded.every(file => file === __filename || file === '/consumer/expected.json'
    || file.startsWith('/consumer/node_modules/')), 'module outside installed consumer');
  return { name: installed.name, version: installed.version, archiveSha256: expected.archiveSha256,
    integrity: expected.integrity, entry, dependencies, verifiedArchiveFiles: Object.keys(expected.files).length,
    lockSha256: sha256(fs.readFileSync('/consumer/package-lock.json')), node: process.version,
    sourceCheckoutAbsent: !fs.existsSync('/app'), loadedModulesInsideConsumer: true,
    browsers: browsers.map(record => ({ ...record, processGone: !fs.existsSync('/proc/' + record.pid) })),
    contexts: contexts.map(rec => ({ ...rec, processGone: false })) };
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/__package/close' && req.method === 'POST') {
      await mirror.close(); await mirror.close();
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status())); return;
    }
    if (req.url === '/__package/status') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status())); return;
    }
    if (req.url === '/__package/health') { res.end('host alive'); return; }
    mirror.handleRequest(req, res);
  } catch (error) { console.error(error); res.writeHead(500); res.end('fixture failed'); }
});
server.on('upgrade', mirror.handleUpgrade);
server.listen(8088, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  await mirror.close(); server.closeAllConnections(); server.close();
});
