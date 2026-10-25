'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const puppeteer = require('puppeteer').default;
const { WebSocket } = require('ws');
const { createMirror } = require('..');
const quiet = { log() {} };

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function host(t, options = {}) {
  const mirror = createMirror({ originUrl: 'http://127.0.0.1:1/', logger: quiet, ...options });
  const server = http.createServer((req, res) => {
    if (req.url === '/host-health') { res.end('host alive'); return; }
    mirror.handleRequest(req, res);
  });
  server.on('upgrade', mirror.handleUpgrade);
  t.after(async () => {
    await mirror.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { mirror, server, url: `http://127.0.0.1:${server.address().port}` };
}

async function hello(t, url, payload = {}) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const message = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'hello', ...payload }));
  return { socket, message: JSON.parse((await message)[0]) };
}

test('import never listens, launches Chromium, reads Demo config or owns process signals', () => {
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const puppeteer = require('puppeteer').default;
    const events = ['SIGTERM', 'SIGINT', 'unhandledRejection'];
    const before = events.map(event => process.listeners(event));
    http.Server.prototype.listen = () => { throw new Error('implicit listen'); };
    puppeteer.launch = () => { throw new Error('implicit browser'); };
    console.log = () => { throw new Error('import log'); };
    process.env.ORIGIN_URL = 'invalid Demo setting';
    const { createMirror } = require('./');
    assert.equal(typeof createMirror, 'function');
    events.forEach((event, i) => assert.deepEqual(process.listeners(event), before[i]));
  `], { cwd: require('node:path').join(__dirname, '..'), timeout: 10000 });
});

test('invalid package options fail before creating resources', async () => {
  for (const options of [undefined, {}, { originUrl: 'file:///tmp/a' },
    { originUrl: 'http://user:password@localhost/' },
    { originUrl: 'http://localhost/', maxSessions: 0 },
    { originUrl: 'http://localhost/', width: NaN },
    { originUrl: 'http://localhost/', defaultMode: 'video' },
    { originUrl: 'http://localhost/', allowedOrigins: '*' }]) {
    assert.throws(() => createMirror(options), TypeError);
  }
  const mirror = createMirror({ originUrl: 'http://localhost/', logger: quiet });
  assert.strictEqual(mirror.close(), mirror.close());
  await mirror.close();
});

test('instances isolate session capacity and resume tokens; close awaits late browser launch', { timeout: 10000 }, async t => {
  const launches = [];
  let closed = 0;
  function finishLaunch(pending) {
    const browser = new EventEmitter();
    browser.version = async () => 'test browser';
    browser.close = async () => { closed++; };
    browser.newPage = async () => { throw new Error('closed instance must not create a page'); };
    pending.resolve(browser);
  }
  const originalLaunch = puppeteer.launch;
  puppeteer.launch = options => {
    const pending = deferred();
    launches.push({ ...pending, options });
    return pending.promise;
  };
  t.after(() => {
    for (const pending of launches) finishLaunch(pending);
    puppeteer.launch = originalLaunch;
  });
  const a = await host(t, { maxSessions: 1, launchOptions: { args: ['--host-selected-flag'] } });
  const b = await host(t, { maxSessions: 1 });
  const first = await hello(t, a.url);
  assert.equal(first.message.type, 'session');
  const busy = await hello(t, a.url);
  assert.equal(busy.message.code, 'SESSION_LIMIT');
  const foreign = await hello(t, b.url, { resume: first.message.token });
  assert.equal(foreign.message.code, 'SESSION_EXPIRED');
  const second = await hello(t, b.url);
  assert.equal(second.message.type, 'session');
  assert.notEqual(first.message.token, second.message.token);
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[0].options.args, ['--host-selected-flag']);
  let finished = false;
  const closing = a.mirror.close().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  finishLaunch(launches[0]);
  await closing;
  assert.equal(closed, 1);
  assert.equal((await fetch(a.url)).status, 503);
  assert.equal(await (await fetch(a.url + '/host-health')).text(), 'host alive');
  assert.equal((await fetch(b.url)).status, 200);
  const closeSecond = b.mirror.close();
  finishLaunch(launches[1]);
  await closeSecond;
  assert.equal(closed, 2);
});

test('Demo owns env config, ephemeral listeners and signal cleanup', { timeout: 10000 }, async t => {
  const { startDemo } = require('../demo/server');
  const names = ['DEMO_PORT', 'ORIGIN_PORT', 'ORIGIN_URL'];
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
  }));
  process.env.DEMO_PORT = '0';
  process.env.ORIGIN_PORT = '0';
  delete process.env.ORIGIN_URL;
  const before = process.listeners('SIGTERM');
  let config;
  let stopped = 0;
  const demo = await startDemo(options => {
    config = options;
    return { handleRequest(req, res) { res.end('demo'); }, handleUpgrade() {}, async close() { stopped++; } };
  });
  t.after(() => demo.close());
  assert.match(config.originUrl, /^http:\/\/127\.0\.0\.1:[1-9]\d*\/$/);
  assert.equal((await fetch(config.originUrl)).status, 200);
  assert.equal(config.presentation, 'demo');
  assert.strictEqual(demo.close(), demo.close());
  await demo.close();
  assert.equal(stopped, 1);
  assert.deepEqual(process.listeners('SIGTERM'), before);
  await assert.rejects(fetch(config.originUrl));
});

test('close cancels active session timers and interrupts in-flight navigation', { timeout: 10000 }, async t => {
  const originalLaunch = puppeteer.launch;
  const started = deferred();
  const navigation = deferred();
  const page = new EventEmitter();
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  page.createCDPSession = async () => cdp;
  page.goto = () => { started.resolve(); return navigation.promise; };
  let pagesClosed = 0, browsersClosed = 0;
  page.close = async () => { pagesClosed++; navigation.reject(new Error('navigation interrupted')); };
  const browser = new EventEmitter();
  browser.version = async () => 'test browser';
  browser.newPage = async () => page;
  browser.close = async () => { browsersClosed++; };
  puppeteer.launch = async () => browser;
  t.after(() => { puppeteer.launch = originalLaunch; });
  const { mirror, url } = await host(t);
  await hello(t, url);
  await started.promise;
  await mirror.close();
  assert.equal(pagesClosed, 1);
  assert.equal(browsersClosed, 1);
});
