'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const puppeteer = require('puppeteer');
const probe = require('./profile-client.cjs');
const output = process.env.EVIDENCE_DIR;
assert.ok(output);
fs.mkdirSync(output, { recursive: true });
const url = 'http://mirror:8088';
const report = { group: process.env.MEMORY_GROUP, cycles: [], events: [], passed: false };
const browsers = [];
const cycles = Number(process.env.MEMORY_CYCLES || 10);
assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 60, 'MEMORY_CYCLES must be 1..60');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) { if (await check()) return; await pause(50); }
  throw new Error(message);
}
async function status() { return (await fetch(url + '/__memory/status', { signal: AbortSignal.timeout(2000) })).json(); }
async function checkpoint(cycle, phase) {
  const response = await fetch(`${url}/__memory/checkpoint/${cycle}/${phase}`, { method: 'POST' });
  assert.ok(response.ok); return response.json();
}
const source = http.createServer(async (req, res) => {
  if (req.url === '/events' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    report.events.push(JSON.parse(raw)); res.end('ok'); return;
  }
  res.setHeader('content-type', 'text/html'); res.end(fs.readFileSync(path.join(__dirname, 'fixtures/capacity.html')));
});
(async () => {
  source.listen(9000, '0.0.0.0'); await once(source, 'listening');
  try {
    await until(async () => { try { await status(); return true; } catch { return false; } }, 'host readiness');
    for (let user = 0; user < 3; user++) browsers.push(await puppeteer.launch({ headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
      defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 } }));
    await pause(1000);
    await checkpoint(0, 'baseline');
    const ids = new Set();
    for (let cycle = 1; cycle <= cycles; cycle++) {
      const result = { cycle, operations: [] }; report.cycles.push(result);
      await checkpoint(cycle, 'beforeLaunch');
      const clients = await Promise.all(browsers.map(async browser => {
        const context = await browser.createBrowserContext();
        const page = await context.newPage(); await page.evaluateOnNewDocument(probe);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('#connectionNotice').hidden
          && document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('#source-id')?.textContent, { timeout: 30000, polling: 20 });
        const id = await page.evaluate(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('#source-id').textContent);
        assert.ok(!ids.has(id)); ids.add(id);
        await page.click('#mirrorHost >>> #command');
        await page.type('#mirrorHost >>> #command', 'memory');
        return { context, page, id };
      }));
      await checkpoint(cycle, 'postLaunch');
      for (let index = 0; index < 10; index++) {
        const tick = performance.now();
        await Promise.all(clients.map(async ({ page }, user) => {
          await page.evaluate(index => window.__profileArm('Measured task ' + String(index).padStart(2, '0'), index, false), index);
          await page.keyboard.press('Enter');
          try {
            await page.waitForFunction(() => {
              const reading = window.__profileRead(); return reading.domMs !== null && reading.paintOpportunityMs !== null;
            }, { timeout: 10000, polling: 20 });
          } catch (error) {
            result.failureDiagnostic = { user, index, ...await page.evaluate(() => ({
              probe: window.__profileRead(), visibility: document.visibilityState,
              resultText: document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('#result')?.textContent,
              notice: document.querySelector('#connectionText').textContent,
              layers: [...(document.querySelector('#mirrorHost')?.shadowRoot?.querySelectorAll('canvas.xy-tiles') || [])].map(canvas => ({
                width: canvas.width, height: canvas.height, pixel: [...canvas.getContext('2d').getImageData(1260, 20, 1, 1).data],
              })),
            })) };
            await page.screenshot({ path: path.join(output, `failure-${cycle}-${user}-${index}.png`) });
            throw error;
          }
          result.operations.push({ user, index, ...await page.evaluate(() => window.__profileRead()) });
        }));
        await pause(Math.max(0, 1000 - (performance.now() - tick)));
      }
      await until(() => report.events.length === cycle * 30, 'source receipts');
      for (const { id } of clients) assert.deepEqual(report.events.filter(event => event.session === id).map(event => event.index),
        Array.from({ length: 10 }, (_, i) => i));
      await checkpoint(cycle, 'active');
      await Promise.all(clients.map(({ context }) => context.close()));
      await checkpoint(cycle, 'detached');
      await until(async () => {
        const state = await status();
        return state.launched === cycle * 3 && state.browsers.every(browser => browser.closed && !browser.connected && browser.processGone);
      }, 'all browser processes reclaimed');
      await checkpoint(cycle, 'postClose');
      await pause(3000);
      result.postIdle = await checkpoint(cycle, 'postIdle');
      assert.equal(result.postIdle.after.cgroup.oomKills, 0);
      result.passed = true;
      fs.writeFileSync(path.join(output, 'client.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ group: report.group, cycle, anonMiB: result.postIdle.after.cgroup.anon / 2 ** 20,
        externalMiB: result.postIdle.after.node.external / 2 ** 20,
        externalReleasedBytes: result.postIdle.before.node.external - result.postIdle.after.node.external }));
    }
    if (process.env.MEMORY_FINAL_DIAGNOSTICS === '1') {
      report.finalDiagnostics = [];
      await pause(15000);
      for (const phase of ['finalIdle', 'finalGc', ...(process.env.MEMORY_SKIP_TRIM === '1' ? [] : ['finalTrim'])]) {
        report.finalDiagnostics.push(await checkpoint(cycles, phase));
      }
      await pause(3000);
      report.finalDiagnostics.push(await checkpoint(cycles, 'finalSettled'));
    }
    report.passed = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
  finally {
    await Promise.allSettled(browsers.map(browser => browser.close()));
    fs.writeFileSync(path.join(output, 'client.json'), JSON.stringify(report, null, 2));
    source.closeAllConnections(); await new Promise(resolve => source.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
