'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const puppeteer = require('puppeteer');
const { createMirror } = require('..');
const output = process.env.EVIDENCE_DIR;
if (!output) throw new Error('Set EVIDENCE_DIR; only a local synthetic host is used');
fs.mkdirSync(output, { recursive: true });
const appBrowsers = [];
const originalLaunch = puppeteer.default.launch;
puppeteer.default.launch = async function (...args) {
  const browser = await originalLaunch.apply(this, args);
  const record = { browser, process: browser.process(), pages: await browser.pages(), closed: false };
  browser.on('targetcreated', async target => {
    if (target.type() === 'page') { const page = await target.page(); if (page) record.pages.push(page); }
  });
  const close = browser.close.bind(browser);
  browser.close = async () => { await close(); record.closed = true; };
  appBrowsers.push(record);
  return browser;
};
const report = { version: require('../package.json').version, cases: [],
  clientSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'client/index.html'))).digest('hex'),
  scriptSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  sessionsSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'lib/sessions.js'))).digest('hex'),
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'server.js'))).digest('hex') };
async function until(condition, message, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(condition(), message);
}
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function stop(server) {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}

async function runCase(browser, mode) {
  const events = [];
  const source = http.createServer(async (req, res) => {
    if (req.url === '/events') {
      let text = ''; for await (const data of req) text += data;
      events.push(JSON.parse(text)); res.end('ok'); return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Identity fixture</title></head><body>
      <h1>Local synthetic session</h1><p id="server-id"></p>
      <input id="draft"><button id="commit">Commit once</button><output id="count">0</output>
      <script>
      const id = crypto.randomUUID(); document.querySelector('#server-id').textContent = id;
      document.querySelector('#commit').onclick = async () => {
        const count = document.querySelector('#count'); count.textContent = Number(count.textContent) + 1;
        await fetch('/events', {method:'POST',body:JSON.stringify({id,draft:document.querySelector('#draft').value,count:Number(count.textContent)})});
      };
      </script></body></html>`);
  });
  const origin = await listen(source);
  const tickets = { owner: crypto.randomBytes(24).toString('hex'), other: crypto.randomBytes(24).toString('hex'),
    tenant: crypto.randomBytes(24).toString('hex') };
  const authenticated = new Map([[tickets.owner, 'tenant-one/alice'], [tickets.other, 'tenant-one/bob'],
    [tickets.tenant, 'tenant-two/alice']]);
  const mirror = createMirror({ originUrl: origin, defaultMode: mode, obfuscate: false, maxSessions: 6,
    getSessionIdentity: req => req.fixtureIdentity, logger: { log() {} } });
  const sockets = new Set();
  let ownerUpgradeAttempts = 0;
  let logoutCount;
  const host = http.createServer(async (req, res) => {
    if (req.url === '/fixture-login') {
      // Test-only opaque credentials; never use this route as a production login implementation.
      const ticket = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!authenticated.has(ticket)) { res.writeHead(401); res.end(); return; }
      res.writeHead(200, { 'set-cookie': `fixture_auth=${ticket}; HttpOnly; SameSite=Strict; Path=/` });
      res.end('synthetic owner login'); return;
    }
    if (!authenticated.has((req.headers.cookie || '').replace('fixture_auth=', ''))) {
      res.writeHead(401); res.end(); return;
    }
    if (req.url === '/fixture-logout' && req.method === 'POST') {
      const identity = authenticated.get((req.headers.cookie || '').replace('fixture_auth=', ''));
      for (const [ticket, owner] of authenticated) if (owner === identity) authenticated.delete(ticket);
      try {
        logoutCount = await mirror.revokeIdentity(identity);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ endedSessions: logoutCount }));
      } catch { res.writeHead(500); res.end('logout failed'); }
      return;
    }
    mirror.handleRequest(req, res);
  });
  host.on('upgrade', (req, socket, head) => {
    if (req.headers.cookie === `fixture_auth=${tickets.owner}`) ownerUpgradeAttempts++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    req.fixtureIdentity = authenticated.get((req.headers.cookie || '').replace('fixture_auth=', ''));
    mirror.handleUpgrade(req, socket, head);
  });
  const url = await listen(host);
  const clients = [];
  let context, siblingContext;
  const item = { mode, events };
  const firstBrowser = appBrowsers.length;
  report.cases.push(item);
  async function connect(ticket, resume) {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws', { headers: {
      Cookie: `fixture_auth=${ticket}`, Origin: url, 'x-user-id': 'tenant-one/alice',
    } });
    const claim = { socket, messages: [], httpStatus: null };
    clients.push(socket);
    socket.on('error', () => {});
    socket.on('unexpected-response', (request, response) => {
      claim.httpStatus = response.statusCode; response.resume(); socket.terminate();
    });
    socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', resume, user: 'alice', tenant: 'tenant-one', dpr: 1, w: 1280, h: 900 })));
    socket.on('message', raw => { claim.messages.push(JSON.parse(raw)); });
    await until(() => claim.httpStatus !== null || claim.messages.length > 0, 'WS admission response');
    return claim;
  }
  async function closeClaim(claim) {
    if (claim.socket.readyState === WebSocket.OPEN) claim.socket.close();
    await until(() => claim.socket.readyState === WebSocket.CLOSED, 'WS close');
  }
  async function snapshot(claim) {
    await until(() => claim.messages.some(message => message.type === 'dom-snapshot'), 'source snapshot after claim');
    return claim.messages.find(message => message.type === 'dom-snapshot').html;
  }
  try {
    context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.evaluateOnNewDocument(() => {
      const Native = WebSocket;
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.type === 'session') window.__fixtureResumeToken = message.token;
          });
        }
      };
    });
    await page.setExtraHTTPHeaders({ Authorization: 'Bearer ' + tickets.owner });
    await page.goto(url + '/fixture-login');
    await page.setExtraHTTPHeaders({});
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#connectionNotice').hidden
      && document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('#server-id')?.textContent, { timeout: 30000 });
    await page.type('#mirrorHost >>> #draft', 'synthetic-owner-draft', { delay: 50 });
    await page.click('#mirrorHost >>> #commit');
    await until(() => events.length === 1, 'independent source commit');
    assert.equal(events[0].draft, 'synthetic-owner-draft');
    const id = events[0].id;
    const token = await page.evaluate(() => window.__fixtureResumeToken);
    assert.equal(typeof token, 'string');

    await page.screenshot({ path: path.join(output, mode + '-before-logout.png') });
    const ownerRecord = appBrowsers[firstBrowser];
    await context.close(); context = null;
    await until(() => sockets.size === 0, 'owner detached before resume');
    const resumed = await connect(tickets.owner, token);
    assert.ok((await snapshot(resumed)).includes('synthetic-owner-draft'), 'real browser draft survives resume');
    assert.equal(resumed.messages[0].resumed, true);

    const retained = await connect(tickets.owner);
    await snapshot(retained);
    const retainedRecord = appBrowsers.at(-1);
    await closeClaim(retained);

    const bob = await connect(tickets.other);
    const bobHtml = await snapshot(bob);
    const bobRecord = appBrowsers.at(-1);
    const tenant = await connect(tickets.tenant);
    const tenantHtml = await snapshot(tenant);
    const tenantRecord = appBrowsers.at(-1);
    assert.ok(!bobHtml.includes(id) && !tenantHtml.includes(id), 'other identities own independent source pages');

    siblingContext = await browser.createBrowserContext();
    const siblingPage = await siblingContext.newPage();
    await siblingPage.evaluateOnNewDocument(() => {
      const Native = WebSocket;
      window.__fixtureConnectionAttempts = 0;
      window.__fixtureCloseCodes = [];
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args);
          window.__fixtureConnectionAttempts++;
          window.__fixtureSocket = this;
          this.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.type === 'session') window.__fixtureResumed = message.resumed;
          });
          this.addEventListener('close', event => window.__fixtureCloseCodes.push(event.code));
        }
      };
    });
    await siblingPage.setExtraHTTPHeaders({ Authorization: 'Bearer ' + tickets.owner });
    await siblingPage.goto(url + '/fixture-login');
    await siblingPage.setExtraHTTPHeaders({});
    await siblingPage.goto(url, { waitUntil: 'domcontentloaded' });
    await siblingPage.waitForFunction(() => document.querySelector('#connectionNotice').hidden
      && document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('#server-id')?.textContent, { timeout: 30000 });
    const sourceIdBeforeDisconnect = await siblingPage.evaluate(() =>
      document.querySelector('#mirrorHost').shadowRoot.querySelector('#server-id').textContent);
    await siblingPage.evaluate(() => window.__fixtureSocket.close(1000, 'fixture temporary disconnect'));
    await siblingPage.waitForFunction(() => window.__fixtureConnectionAttempts === 2 && window.__fixtureResumed
      && document.querySelector('#connectionNotice').hidden, { timeout: 30000 });
    assert.equal(await siblingPage.evaluate(() =>
      document.querySelector('#mirrorHost').shadowRoot.querySelector('#server-id').textContent), sourceIdBeforeDisconnect);
    item.temporaryDisconnectResumed = true;
    const siblingRecord = appBrowsers.at(-1);
    assert.notEqual(siblingRecord, tenantRecord);
    const pending = new WebSocket(url.replace('http:', 'ws:') + '/ws', { headers: { Cookie: `fixture_auth=${tickets.owner}`, Origin: url } });
    clients.push(pending);
    pending.on('error', () => {});
    await once(pending, 'open'); // Deliberately no hello: pending authenticated transport.

    await siblingPage.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'fixture-host-logout'; button.textContent = 'Host logout (synthetic test)';
      button.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647';
      button.onclick = async () => {
        const response = await fetch('/fixture-logout', { method: 'POST' });
        window.__fixtureLogout = { status: response.status, ...await response.json() };
      };
      document.body.append(button);
    });
    const upgradesBeforeLogout = ownerUpgradeAttempts;
    await siblingPage.click('#fixture-host-logout');
    await siblingPage.waitForFunction(() => window.__fixtureLogout, { timeout: 30000 });
    item.logout = await siblingPage.evaluate(() => window.__fixtureLogout);
    assert.deepEqual(item.logout, { status: 200, endedSessions: 3 });
    await until(() => resumed.socket.readyState === WebSocket.CLOSED && pending.readyState === WebSocket.CLOSED,
      'active and pending transports terminated');
    await siblingPage.waitForFunction(() => !document.querySelector('#connectionNotice').hidden
      && document.querySelector('#connectionText').textContent.includes('会话已撤销'));
    await siblingPage.evaluate(() => document.querySelector('#reconn').click());
    // Longer than the maximum retry delay; neither automatic nor reconnect-button retry is allowed.
    await new Promise(resolve => setTimeout(resolve, 6000));
    item.revokedClient = await siblingPage.evaluate(() => ({
      text: document.querySelector('#connectionText').textContent,
      status: document.querySelector('#status').textContent,
      closeCodes: window.__fixtureCloseCodes,
      connectionAttempts: window.__fixtureConnectionAttempts,
      restartHidden: document.querySelector('#newSession').hidden,
      interactionDisabled: document.querySelector('#mirrorScroll').inert && document.querySelector('#rbi').inert,
    }));
    assert.deepEqual(item.revokedClient.closeCodes, [1000, 4001]);
    assert.equal(item.revokedClient.connectionAttempts, 2);
    assert.equal(item.revokedClient.status, '会话已撤销');
    assert.equal(item.revokedClient.restartHidden, true);
    assert.equal(item.revokedClient.interactionDisabled, true);
    item.retryObservationMs = 6000;
    item.postLogoutUpgradeAttempts = ownerUpgradeAttempts - upgradesBeforeLogout;
    assert.equal(item.postLogoutUpgradeAttempts, 0, 'no automatic or button-triggered WS retries after revocation');
    await siblingPage.screenshot({ path: path.join(output, mode + '-after-logout.png') });
    item.uiDisabled = await siblingPage.evaluate(() => !document.querySelector('#connectionNotice').hidden);
    item.pendingTransportClosed = true;

    async function reclaimed(records) {
      await until(() => records.every(record => record.closed && !record.browser.connected
        && (record.process.exitCode !== null || record.process.signalCode !== null)
        && !fs.existsSync('/proc/' + record.process.pid) && record.pages.every(page => page.isClosed())),
      'browser close, page close, child exit and process disappearance');
      return records.map(record => ({ pid: record.process.pid, pages: record.pages.length,
        allPagesClosed: record.pages.every(page => page.isClosed()), processGone: !fs.existsSync('/proc/' + record.process.pid),
        exitCode: record.process.exitCode, signalCode: record.process.signalCode }));
    }
    item.identityResources = await reclaimed([ownerRecord, retainedRecord, siblingRecord]);
    for (const resume of [undefined, token, retained.messages[0].token]) {
      const attempt = await connect(tickets.owner, resume);
      assert.equal(attempt.httpStatus, 401, 'old host credentials cannot enter or resume');
      await closeClaim(attempt);
    }
    item.oldCredentialsRejected = true;
    const freshTicket = crypto.randomBytes(24).toString('hex');
    authenticated.set(freshTicket, 'tenant-one/alice');
    for (const oldToken of [token, retained.messages[0].token]) {
      const attempt = await connect(freshTicket, oldToken);
      assert.equal(attempt.messages[0]?.code, 'SESSION_EXPIRED', 'fresh valid credentials cannot recover revoked tokens');
      await closeClaim(attempt);
    }
    item.oldTokensRejectedWithFreshCredentials = true;
    assert.equal(await mirror.revokeIdentity('tenant-one/alice'), 0);
    assert.equal(await mirror.revokeSession(token), false);

    for (const [claim, record] of [[bob, bobRecord], [tenant, tenantRecord]]) {
      claim.socket.send(JSON.stringify({ type: 'ping', t: 77 }));
      await until(() => claim.messages.some(message => message.type === 'pong' && message.t === 77), 'unrelated identity still usable');
      assert.equal(record.closed, false);
      assert.equal(record.browser.connected, true);
      assert.ok(record.pages.some(page => !page.isClosed()));
    }
    item.otherUserAndTenantUnaffected = true;
    const bobToken = bob.messages[0].token;
    assert.equal(await mirror.revokeSession(bobToken), true);
    await until(() => bob.socket.readyState === WebSocket.CLOSED, 'single-session transport closed');
    item.singleSessionResources = await reclaimed([bobRecord]);
    const bobRetry = await connect(tickets.other, bobToken);
    assert.equal(bobRetry.messages[0]?.code, 'SESSION_EXPIRED');
    await closeClaim(bobRetry);
    assert.equal(tenant.socket.readyState, WebSocket.OPEN);
    item.singleSessionRevoked = true;

    const fresh = await connect(freshTicket);
    const freshHtml = await snapshot(fresh);
    assert.ok(!freshHtml.includes(id) && !freshHtml.includes('synthetic-owner-draft'), 'new login creates a fresh source page');
    item.newLoginStartsFresh = true;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(events.length, 1, 'logout and reconnect must not replay the business commit');
    item.businessReplayCount = events.length - 1;
    item.applicationBrowsersLaunched = appBrowsers.length - firstBrowser;
    item.completed = true;
  } finally {
    await context?.close();
    await siblingContext?.close();
    for (const socket of clients) socket.terminate();
    await mirror.close();
    await stop(host);
    await stop(source);
  }
}

(async () => {
  const browser = await puppeteer.launch({ headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
    defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 } });
  try {
    report.chromium = await browser.version();
    for (const mode of ['dom', 'frame']) await runCase(browser, mode);
    report.completed = true;
  } finally {
    puppeteer.default.launch = originalLaunch;
    await browser.close();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
