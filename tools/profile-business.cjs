'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { api, persisted, button } = require('./verify-vikunja.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mode = process.env.CASES;
const output = process.env.EVIDENCE_DIR;
const presentation = process.env.PROFILE_PRESENTATION === '1';
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.ceil(p * sorted.length) - 1];
  return { count: values.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1), samplesMs: values };
}
async function barrier(page) {
  if (mode === 'direct') return;
  await page.evaluate(() => new Promise((resolve, reject) => {
    const socket = window.__profileSocket, t = Math.random();
    const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Command barrier timeout')); }, 10000);
    function receive(event) {
      let m; try { m = JSON.parse(event.data); } catch { return; }
      if (m.type === 'pong' && m.t === t) { clearTimeout(timer); socket.removeEventListener('message', receive); resolve(); }
    }
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ type: 'ping', t }));
  }));
}
async function main() {
  if (!['direct', 'dom', 'frame'].includes(mode) || !output) throw new Error('Set one CASES mode and EVIDENCE_DIR');
  fs.mkdirSync(output, { recursive: true });
  const result = { metric: 'Enter to task DOM presence (not frame pixel presentation); includes Puppeteer/CDP and requestAnimationFrame polling', mode, pass: false, viewport: { width: 1280, height: 900, dpr: 1 }, warmup: 3, measured: 20 };
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage'], defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 } });
  let page;
  try {
    const username = 'profile' + crypto.randomBytes(6).toString('hex'), password = crypto.randomUUID() + 'Aa9!';
    await api('/register', 'POST', { username, password, email: username + '@example.invalid' });
    const { token } = await api('/login', 'POST', { username, password });
    const project = await api('/projects', 'PUT', { title: 'Performance fixture' }, token);
    page = await browser.newPage();
    const mirror = mode !== 'direct', prefix = mirror ? '#mirrorHost >>> ' : '';
    const field = prefix + 'textarea[placeholder="Add a task…"]';
    const bytes = { receivedPayload: 0, sentPayload: 0, receivedByType: {} };
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Performance.enable');
    for (const [event, direction] of [['Network.webSocketFrameReceived', 'receivedPayload'], ['Network.webSocketFrameSent', 'sentPayload']]) {
      cdp.on(event, ({ response }) => {
        const size = Buffer.byteLength(response.payloadData);
        bytes[direction] += size;
        if (direction === 'receivedPayload') {
          let type = 'other'; try { type = JSON.parse(response.payloadData).type || type; } catch {}
          bytes.receivedByType[type] = (bytes.receivedByType[type] || 0) + size;
        }
      });
    }
    await page.evaluateOnNewDocument(() => {
      const Native = WebSocket;
      window.WebSocket = class extends Native { constructor(...args) { super(...args); window.__profileSocket = this; } };
    });
    if (presentation) {
      assert.equal(mode, 'frame', 'presentation probe requires frame mode');
      await page.evaluateOnNewDocument(require('./profile-client.cjs'));
    }
    const coldStart = performance.now();
    await page.goto(mirror ? process.env.MIRROR_URL : process.env.BUSINESS_URL + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (mirror) await page.waitForFunction(() => document.querySelector('#connectionNotice').hidden, { timeout: 30000 });
    await page.waitForSelector(prefix + '#username', { timeout: 30000 });
    result.coldLoginDomReadyMs = performance.now() - coldStart;
    // Let login-page hydration settle before entering credentials.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 });
    await page.type(prefix + '#username', username);
    await page.type(prefix + '#password', password);
    await button(page, mirror, 'Login');
    await page.waitForSelector(field, { timeout: 30000 });
    const href = (mirror ? '/m' : '') + '/projects/' + project.id;
    await page.locator(prefix + 'a[href="' + href + '"]').setTimeout(20000).click();
    await page.waitForSelector(prefix + 'a[href^="' + href + '/"]', { timeout: 20000 });
    await sleep(3000);
    const timings = [], totals = [], observations = [];
    for (let i = 0; i < result.warmup + result.measured; i++) {
      const title = 'Measured task ' + String(i).padStart(2, '0');
      await page.type(field, title);
      await barrier(page);
      if (presentation) await page.evaluate((title, i) => window.__profileArm(title, i, i === 0), title, i);
      const start = performance.now();
      await page.keyboard.press('Enter');
      await page.waitForFunction((mirror, title) => {
        const root = mirror ? document.querySelector('#mirrorHost').shadowRoot : document;
        return [...root.querySelectorAll('a,span')].some(e => e.textContent.trim() === title);
      }, { polling: 'raf', timeout: 15000 }, mirror, title);
      const visibleMs = performance.now() - start;
      await persisted('/projects/' + project.id + '/tasks', token, tasks => tasks.find(t => t.title === title));
      const apiObservedMs = performance.now() - start;
      if (presentation) {
        if (i === 0) {
          await sleep(250);
          const negative = await page.evaluate(() => window.__profileRead());
          assert.equal(negative.keydownObserved, true);
          assert.ok(negative.domMs !== null, 'negative control needs a real DOM update');
          assert.equal(negative.drawMs, null, 'DOM presence must not pass a blocked canvas draw');
          result.negativeDrawControl = { pass: true, ...negative };
          await page.evaluate(() => {
            window.__profileSetSkip(false);
            window.__profileSocket.send(JSON.stringify({ type: 'mode', mode: 'frame' }));
          });
        }
        await page.waitForFunction(() => { const p = window.__profileRead(); return p && p.paintOpportunityMs !== null; }, { polling: 'raf', timeout: 15000 });
        const observed = await page.evaluate(() => window.__profileRead());
        assert.ok(observed.domMs !== null && observed.drawMs !== null && observed.paintOpportunityMs !== null);
        if (i >= result.warmup) observations.push(observed);
      }
      if (i >= result.warmup) { timings.push(visibleMs); totals.push(apiObservedMs); }
      await sleep(150);
    }
    const tasks = await api('/projects/' + project.id + '/tasks', 'GET', null, token);
    assert.equal(tasks.length, result.warmup + result.measured);
    assert.equal(new Set(tasks.map(t => t.title)).size, tasks.length);
    result.enterToTaskDom = distribution(timings);
    result.enterToTaskDomAndApiObserved = distribution(totals);
    if (presentation) {
      for (let i = 0; i < observations.length; i++) {
        const o = observations[i], c = o.correlation;
        if (!c) continue;
        assert.equal(c.server.op, i + result.warmup, 'operation/frame association');
        assert.ok(Math.abs(o.drawMs - c.keyToReceiveMs - c.receiveToDrawMs) < 0.01, 'client interval identity');
        const s = c.server;
        const sum = s.commandQueueMs + s.handleToFrameMs + s.frameQueueMs + s.processingMs;
        assert.ok(Math.abs(sum - s.enterReceivedToSerializeMs) < 1, 'server interval identity');
        for (const value of [s.commandQueueMs, s.handleToFrameMs, s.frameQueueMs, s.processingMs]) assert.ok(value >= 0);
      }
      result.presentation = {
        definition: 'Keydown to synthetic source task-version marker in client canvas, then two requestAnimationFrame callbacks; not physical display time',
        dom: distribution(observations.map(o => o.domMs)),
        canvasDraw: distribution(observations.map(o => o.drawMs)),
        paintOpportunity: distribution(observations.map(o => o.paintOpportunityMs)),
        correlationCoverage: { matched: observations.filter(o => o.correlation).length, total: observations.length },
        observations,
      };
    }
    result.bytes = bytes;
    result.clientMetrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.filter(m => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'JSHeapUsedSize'].includes(m.name)).map(m => [m.name, m.value]));
    result.pass = true;
    await sleep(3000);
    if (mirror) await page.evaluate(() => window.__profileSocket.send(JSON.stringify({ type: 'release' })));
  } catch (error) {
    result.error = error.message;
    if (presentation && page) result.probeFailure = await page.evaluate(() => window.__profileRead?.()).catch(() => null);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'profile-client.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result));
  if (!result.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
