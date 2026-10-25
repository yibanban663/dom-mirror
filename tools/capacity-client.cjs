'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const puppeteer = require('puppeteer');
const probe = require('./profile-client.cjs');
const mode = process.env.CAPACITY_MODE || 'dom';
const count = Number(process.env.CAPACITY_SESSIONS || 1);
assert.ok(['dom', 'frame'].includes(mode) && [1, 3, 6].includes(count));
const url = 'http://mirror:8088';
const output = process.env.EVIDENCE_DIR;
assert.ok(output);
fs.mkdirSync(output, { recursive: true });
const report = { mode, count, cold: [], operations: [], events: [], passed: false };
const browsers = [], contexts = [], resources = [];
let phase = 'baseline';
function sample() {
  const cpu = Object.fromEntries(fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').trim().split('\n').map(line => line.split(' ')));
  resources.push({ ms: performance.now(), phase, cpuUsec: Number(cpu.usage_usec),
    memory: Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8')) });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 10000) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) { if (await check()) return; await pause(50); }
  throw new Error(message);
}
async function status() { return (await fetch(url + '/__capacity/status', { signal: AbortSignal.timeout(2000) })).json(); }
async function setPhase(value) {
  sample(); phase = value;
  assert.ok((await fetch(url + '/__capacity/phase/' + value, { method: 'POST' })).ok); sample();
}
async function claim(resume) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  await once(socket, 'open');
  const response = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'hello', resume, dpr: 1, w: 1280, h: 900 }));
  const message = JSON.parse((await response)[0]);
  return { socket, message };
}
const source = http.createServer(async (req, res) => {
  if (req.url === '/events' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    report.events.push(JSON.parse(raw)); res.end('ok'); return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(path.join(__dirname, 'fixtures/capacity.html')));
});

(async () => {
  source.listen(9000, '0.0.0.0'); await once(source, 'listening');
  const interval = setInterval(sample, 250);
  try {
    await until(async () => { try { await status(); return true; } catch { return false; } }, 'mirror readiness');
    // Separate client Chromium per user, so all pages remain visible and rAF can run.
    const pages = await Promise.all(Array.from({ length: count }, async () => {
      const browser = await puppeteer.launch({ headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
        defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 } });
      browsers.push(browser);
      const context = await browser.createBrowserContext(); contexts.push(context);
      const page = await context.newPage();
      await page.evaluateOnNewDocument(() => {
        const Native = WebSocket;
        window.__capacityBytes = { sent: 0, received: 0 };
        window.WebSocket = class extends Native {
          constructor(...args) {
            super(...args); window.__capacitySocket = this;
            this.addEventListener('message', event => {
              window.__capacityBytes.received += new TextEncoder().encode(event.data).length;
              const message = JSON.parse(event.data);
              if (message.type === 'session') window.__capacityToken = message.token;
            });
          }
          send(raw) { window.__capacityBytes.sent += new TextEncoder().encode(raw).length; super.send(raw); }
        };
      });
      await page.evaluateOnNewDocument(probe);
      return page;
    }));
    await pause(1000);
    await setPhase('cold');
    await Promise.all(pages.map(async (page, user) => {
      const start = performance.now();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => document.querySelector('#connectionNotice').hidden
        && document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('#source-id')?.textContent, { timeout: 30000, polling: 20 });
      report.cold.push({ user, ms: performance.now() - start });
      assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
      await page.click('#mirrorHost >>> #command');
      await page.type('#mirrorHost >>> #command', 'capacity');
      await page.evaluate(() => new Promise(resolve => {
        const socket = window.__capacitySocket;
        const listener = event => {
          const message = JSON.parse(event.data);
          if (message.type === 'pong' && message.t === 1) { socket.removeEventListener('message', listener); resolve(); }
        };
        socket.addEventListener('message', listener); socket.send(JSON.stringify({ type: 'ping', t: 1 }));
      }));
    }));
    assert.equal((await status()).launched, count);
    await setPhase('warmup');
    let measuredStart;
    for (let index = 0; index < 23; index++) {
      if (index === 3) { await setPhase('measured'); measuredStart = performance.now(); }
      const tick = performance.now();
      await Promise.all(pages.map(async (page, user) => {
        const title = 'Measured task ' + String(index).padStart(2, '0');
        await page.evaluate((title, index) => window.__profileArm(title, index, false), title, index);
        await page.keyboard.press('Enter');
        await page.waitForFunction(mode => {
          const reading = window.__profileRead();
          return reading.domMs !== null && (mode === 'dom' || reading.paintOpportunityMs !== null);
        }, { timeout: 10000, polling: 20 }, mode);
        const reading = await page.evaluate(() => window.__profileRead());
        report.operations.push({ user, index, measured: index >= 3, ...reading });
      }));
      await pause(Math.max(0, 1000 - (performance.now() - tick)));
    }
    report.measuredDurationMs = performance.now() - measuredStart;
    report.bytes = await Promise.all(pages.map(page => page.evaluate(() => window.__capacityBytes)));
    report.sourceIds = await Promise.all(pages.map(page => page.evaluate(() =>
      document.querySelector('#mirrorHost').shadowRoot.querySelector('#source-id').textContent)));
    await until(() => report.events.length === count * 23, 'all independent source receipts');
    assert.equal(new Set(report.sourceIds).size, count);
    for (const session of report.sourceIds) {
      assert.deepEqual(report.events.filter(event => event.session === session).map(event => event.index), Array.from({ length: 23 }, (_, i) => i));
    }
    await setPhase('limit');
    const before = (await status()).launched;
    const overflow = await claim();
    assert.equal(overflow.message.code, 'SESSION_LIMIT'); overflow.socket.terminate();
    assert.equal((await status()).launched, before);
    report.activeLimitRejected = true;
    const token = await pages[0].evaluate(() => window.__capacityToken);
    await Promise.all(contexts.map(context => context.close()));
    const retainedOverflow = await claim();
    assert.equal(retainedOverflow.message.code, 'SESSION_LIMIT'); retainedOverflow.socket.terminate();
    report.retainedLimitRejected = true;
    await setPhase('cleanup');
    await until(async () => (await status()).browsers.every(browser => browser.closed && browser.processGone && !browser.connected), 'expired browser processes reclaimed', 15000);
    await pause(3000);
    report.reclaimed = await status();
    await setPhase('renewal');
    const expired = await claim(token);
    assert.equal(expired.message.code, 'SESSION_EXPIRED'); expired.socket.terminate();
    const fresh = await claim();
    assert.equal(fresh.message.type, 'session');
    fresh.socket.send(JSON.stringify({ type: 'release' }));
    await once(fresh.socket, 'close');
    await until(async () => {
      const current = await status();
      return current.launched === count + 1 && current.browsers.every(browser => browser.closed && browser.processGone);
    }, 'new slot cleanup', 15000);
    report.newAdmissionAfterReclaim = true;
    report.passed = true;
    console.log(JSON.stringify({ mode, count, passed: true }));
  } catch (error) {
    report.error = error.stack; process.exitCode = 1; console.error(error);
  } finally {
    await Promise.allSettled(browsers.map(browser => browser.close()));
    clearInterval(interval); sample();
    report.clientResources = resources;
    fs.writeFileSync(path.join(output, 'client.json'), JSON.stringify(report, null, 2));
    source.closeAllConnections(); await new Promise(resolve => source.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
