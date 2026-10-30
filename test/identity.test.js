'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const puppeteer = require('puppeteer').default;
const { createMirror } = require('..');

async function fixture(t, getSessionIdentity) {
  const mirror = createMirror({ browserPoolSize: 0, originUrl: 'http://127.0.0.1:1/', logger: { log() {} }, getSessionIdentity });
  const server = http.createServer(mirror.handleRequest);
  server.on('upgrade', (req, socket, head) => {
    // A synthetic host authentication layer; public identity headers are never trusted.
    req.authenticatedUser = { 'ticket-a': 'tenant-one/alice', 'ticket-b': 'tenant-one/bob',
      'ticket-c': 'tenant-two/alice' }[req.headers.cookie];
    mirror.handleUpgrade(req, socket, head);
  });
  t.after(async () => {
    await mirror.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  async function connect(cookie, hello = {}) {
    const socket = new WebSocket(url, { headers: { Cookie: cookie, Origin: 'http://' + new URL(url).host,
      'x-user-id': 'tenant-one/alice' } });
    t.after(() => socket.terminate());
    await once(socket, 'open');
    const received = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'hello', user: 'alice', tenant: 'tenant-one', ...hello }));
    return { socket, message: JSON.parse((await received)[0]) };
  }
  return { url, connect };
}

test('trusted host identity binds resume across users and tenants without trusting client fields', { timeout: 10000 }, async t => {
  const original = puppeteer.launch;
  const browsers = [];
  puppeteer.launch = () => new Promise(resolve => { browsers.push(resolve); });
  t.after(() => {
    for (const resolve of browsers) {
      const browser = new EventEmitter();
      browser.version = async () => 'test browser';
      browser.close = async () => {};
      resolve(browser);
    }
    puppeteer.launch = original;
  });
  const { connect } = await fixture(t, req => req.authenticatedUser);
  const owner = await connect('ticket-a');
  const token = owner.message.token;
  assert.equal(owner.message.resumed, false);
  owner.socket.close();
  await once(owner.socket, 'close');
  for (const ticket of ['ticket-b', 'ticket-c']) {
    const attempt = await connect(ticket, { resume: token, identity: 'tenant-one/alice' });
    assert.equal(attempt.message.code, 'SESSION_EXPIRED');
  }
  const resumed = await connect('ticket-a', { resume: token });
  assert.equal(resumed.message.resumed, true);
  assert.equal(resumed.message.token, token);
  assert.equal(browsers.length, 1, 'rejected claims and resume must not launch another browser');
});

test('configured identity hook rejects missing, invalid, thrown and asynchronous identities before WS upgrade', { timeout: 10000 }, async t => {
  const { url } = await fixture(t, req => {
    switch (req.headers.cookie) {
      case 'throws': throw new Error('host authentication failed');
      case 'async': return Promise.reject(new Error('unsupported asynchronous hook'));
      case 'empty': return '   ';
      case 'object': return { user: 'alice' };
      default: return undefined;
    }
  });
  for (const cookie of ['none', 'throws', 'async', 'empty', 'object']) {
    const socket = new WebSocket(url, { headers: { Cookie: cookie } });
    const status = await new Promise((resolve, reject) => {
      socket.on('unexpected-response', (request, response) => {
        response.resume();
        resolve(response.statusCode);
        request.destroy();
      });
      socket.on('open', () => reject(new Error('unauthorized upgrade succeeded')));
      socket.on('error', () => {});
    });
    assert.equal(status, 401, cookie);
  }
});
