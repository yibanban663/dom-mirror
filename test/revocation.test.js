'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const puppeteer = require('puppeteer').default;
const { createMirror } = require('..');

function mockLaunch(t) {
  const original = puppeteer.launch;
  const launches = [];
  puppeteer.launch = () => new Promise(resolve => {
    const browser = new EventEmitter();
    browser.version = async () => 'test browser';
    browser.closeCount = 0;
    browser.close = async () => { browser.closeCount++; };
    launches.push({ browser, finish: () => resolve(browser) });
  });
  t.after(() => {
    for (const launch of launches) launch.finish();
    puppeteer.launch = original;
  });
  return launches;
}

async function host(t, authenticated = true) {
  const mirror = createMirror({ originUrl: 'http://127.0.0.1:1/', maxSessions: 6,
    logger: { log() {} }, getSessionIdentity: authenticated ? req => req.identity : undefined });
  const server = http.createServer(mirror.handleRequest);
  server.on('upgrade', (req, socket, head) => {
    req.identity = { a: 'tenant/alice', b: 'tenant/bob', c: 'other/alice' }[req.headers.cookie];
    mirror.handleUpgrade(req, socket, head);
  });
  t.after(async () => {
    await mirror.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  async function connect(ticket = 'a', hello = {}) {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, { headers: { Cookie: ticket } });
    t.after(() => socket.terminate());
    await once(socket, 'open');
    if (hello === null) return { socket };
    const response = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'hello', ...hello }));
    return { socket, message: JSON.parse((await response)[0]) };
  }
  return { mirror, connect, url: `http://127.0.0.1:${server.address().port}` };
}

test('single-session revocation invalidates its token synchronously and awaits a late browser', { timeout: 10000 }, async t => {
  const launches = mockLaunch(t);
  const { mirror, connect } = await host(t);
  const owner = await connect();
  const sibling = await connect();
  const disconnected = once(owner.socket, 'close');
  let cleaned = false;
  const revoked = mirror.revokeSession(owner.message.token).then(value => { cleaned = true; return value; });
  await disconnected;
  assert.equal(cleaned, false, 'resource cleanup waits for browser launch');
  const denied = await connect('a', { resume: owner.message.token });
  assert.equal(denied.message.code, 'SESSION_EXPIRED');
  assert.equal(sibling.socket.readyState, WebSocket.OPEN);
  launches[0].finish();
  assert.equal(await revoked, true);
  assert.equal(launches[0].browser.closeCount, 1);
  assert.equal(await mirror.revokeSession(owner.message.token), false);
  assert.equal(await mirror.revokeSession('unknown'), false);
});

test('identity revocation covers retained sessions and pending handshakes, preserving other identities and instances', { timeout: 10000 }, async t => {
  const launches = mockLaunch(t);
  const { mirror, connect } = await host(t);
  const otherHost = await host(t);
  const active = await connect();
  const retained = await connect();
  retained.socket.close();
  await once(retained.socket, 'close');
  const bob = await connect('b');
  const tenant = await connect('c');
  const separate = await otherHost.connect();
  const pending = await connect('a', null);
  const closed = Promise.all([once(active.socket, 'close'), once(pending.socket, 'close')]);
  const revoked = mirror.revokeIdentity('tenant/alice');
  await closed;
  for (const token of [active.message.token, retained.message.token]) {
    const denied = await connect('a', { resume: token });
    assert.equal(denied.message.code, 'SESSION_EXPIRED');
  }
  launches[0].finish();
  launches[1].finish();
  assert.equal(await revoked, 2);
  assert.equal(await mirror.revokeIdentity('tenant/alice'), 0);
  for (const claim of [bob, tenant, separate]) assert.equal(claim.socket.readyState, WebSocket.OPEN);
  assert.equal(launches.length, 5, 'rejected resumes do not create browsers');
  const fresh = await connect();
  assert.equal(fresh.message.type, 'session', 'host must deny new admission after logout');
});

test('revocation waits for page and browser cleanup and leaves host HTTP service running', { timeout: 10000 }, async t => {
  const original = puppeteer.launch;
  let finishPageClose, finishBrowserClose, finishAttach, pageCreated;
  const created = new Promise(resolve => { pageCreated = resolve; });
  let pageCloses = 0, browserCloses = 0;
  const browser = new EventEmitter();
  browser.version = async () => 'test browser';
  browser.close = () => { browserCloses++; return new Promise(resolve => { finishBrowserClose = resolve; }); };
  browser.newPage = async () => {
    pageCreated();
    return {
      createCDPSession: () => new Promise(resolve => { finishAttach = resolve; }),
      close: () => { pageCloses++; return new Promise(resolve => { finishPageClose = resolve; }); },
    };
  };
  puppeteer.launch = async () => browser;
  t.after(() => { finishPageClose?.(); finishBrowserClose?.(); finishAttach?.({}); puppeteer.launch = original; });
  const { mirror, connect, url } = await host(t);
  const owner = await connect();
  await created;
  let done = false;
  const revoked = mirror.revokeSession(owner.message.token).then(value => { done = true; return value; });
  assert.equal(pageCloses, 1);
  assert.equal(browserCloses, 1);
  finishPageClose();
  finishAttach({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false, 'browser close must finish before the API resolves');
  finishBrowserClose();
  assert.equal(await revoked, true);
  assert.equal(await mirror.revokeSession(owner.message.token), false);
  assert.equal(pageCloses, 1);
  assert.equal(browserCloses, 1);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
});

test('anonymous sessions support individual revocation and invalid selectors reject', { timeout: 10000 }, async t => {
  const launches = mockLaunch(t);
  const { mirror, connect } = await host(t, false);
  for (const value of [undefined, null, '', '  ', 7]) {
    await assert.rejects(mirror.revokeSession(value), TypeError);
    await assert.rejects(mirror.revokeIdentity(value), TypeError);
  }
  const owner = await connect();
  const revoked = mirror.revokeSession(owner.message.token);
  launches[0].finish();
  assert.equal(await revoked, true);
  await mirror.close();
  assert.equal(await mirror.revokeSession(owner.message.token), false);
  assert.equal(await mirror.revokeIdentity('tenant/alice'), 0);
});
