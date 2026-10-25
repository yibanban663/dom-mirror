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
const enforce = process.env.IDENTITY_ENFORCE === '1';
const report = { version: require('../package.json').version, enforce, cases: [],
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
  const mirror = createMirror({ originUrl: origin, defaultMode: mode, obfuscate: false,
    getSessionIdentity: req => req.fixtureIdentity, logger: { log() {} } });
  const sockets = new Set();
  const host = http.createServer((req, res) => {
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
    mirror.handleRequest(req, res);
  });
  host.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    req.fixtureIdentity = authenticated.get((req.headers.cookie || '').replace('fixture_auth=', ''));
    mirror.handleUpgrade(req, socket, head);
  });
  const url = await listen(host);
  const clients = [];
  let context;
  const item = { mode, events };
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

    const ownOther = await connect(tickets.other);
    const otherHtml = await snapshot(ownOther);
    assert.ok(!otherHtml.includes(id), 'other identity can create its own independent real browser');
    ownOther.socket.send(JSON.stringify({ type: 'release' }));
    await closeClaim(ownOther);
    item.otherUserOwnSession = true;
    await context.close(); context = null;
    await until(() => sockets.size === 0, 'owner detach before resume attempts');

    for (const [name, ticket] of [['crossUser', tickets.other], ['crossTenant', tickets.tenant]]) {
      const attempt = await connect(ticket, token);
      const accepted = attempt.messages[0]?.type === 'session';
      item[name] = { resumed: accepted, code: attempt.messages[0]?.code ?? null };
      if (accepted) item[name].receivedOwnerData = (await snapshot(attempt)).includes('synthetic-owner-draft');
      await closeClaim(attempt);
    }
    const resumed = await connect(tickets.owner, token);
    const html = await snapshot(resumed);
    assert.equal(resumed.messages[0].resumed, true);
    assert.ok(html.includes(id) && html.includes('synthetic-owner-draft'), 'owner recovers original source and draft');
    assert.equal(events.length, 1, 'claims/resume must not replay the commit');
    item.ownerResume = true;
    item.businessReplayCount = events.length - 1;

    authenticated.delete(tickets.owner);
    resumed.socket.send(JSON.stringify({ type: 'ping', t: 77 }));
    await until(() => resumed.messages.some(message => message.type === 'pong' && message.t === 77), 'existing connection lifetime boundary');
    item.existingConnectionSurvivesHostRevocation = true;
    await closeClaim(resumed);
    for (const [name, ticket] of [['revokedIdentity', tickets.owner], ['unauthenticated', 'not-a-ticket']]) {
      const attempt = await connect(ticket, token);
      item[name] = { httpStatus: attempt.httpStatus, resumed: attempt.messages[0]?.type === 'session' };
      await closeClaim(attempt);
    }
    item.protectionPassed = !item.crossUser.resumed && !item.crossTenant.resumed
      && item.crossUser.code === 'SESSION_EXPIRED' && item.crossTenant.code === 'SESSION_EXPIRED'
      && item.revokedIdentity.httpStatus === 401 && item.unauthenticated.httpStatus === 401;
    if (enforce) assert.equal(item.protectionPassed, true, 'host identity must prevent cross-user/tenant resume and unauthenticated admission');
    item.completed = true;
  } finally {
    await context?.close();
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
    for (const mode of ['dom', 'frame']) await runCase(browser, mode);
    report.completed = true;
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
