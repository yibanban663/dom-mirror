'use strict';

// A bounded capture of the real, built-in Demo. No external source or credentials.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { startDemo } = require('../demo/server');

async function main() {
  const output = process.env.SCREENSHOT_DIR;
  if (!output) throw new Error('Set SCREENSHOT_DIR to an output directory');
  fs.mkdirSync(output, { recursive: true });
  // This tool owns its local Demo and always captures the built-in synthetic app.
  delete process.env.ORIGIN_URL;
  delete process.env.RBI_ALLOWED_ORIGINS;
  process.env.ORIGIN_PORT = '8077';
  process.env.DEMO_PORT = '8088';
  process.env.DEFAULT_MODE = 'dom';
  process.env.PROD_PRESENTATION = '0';
  process.env.OBFUSCATE = '0';
  process.env.SESSION_GRACE_MS = '0';
  const demo = await startDemo();
  let browser;
  const report = {
    version: require('../package.json').version,
    capturedAt: new Date().toISOString(),
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    source: 'Built-in synthetic customer dashboard; no real account or business data',
    obfuscate: false,
    captures: { overview: 'Horizontal Demo extent, clipped to 960px height', interaction: 'Mirror pane element' },
    steps: [],
  };
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
      defaultViewport: report.viewport,
    });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8088/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#connectionNotice').hidden
      && document.querySelector('#mirrorHost')?.shadowRoot?.querySelectorAll('#tbody tr').length === 12,
    { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('#clock').textContent !== '--:--:--'
      && document.querySelector('#mRtt').textContent !== '-', { timeout: 10000 });
    const captureOverview = async filename => {
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      await page.screenshot({ path: path.join(output, filename), captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: 960 } });
    };
    await captureOverview('demo-dom.png');
    report.steps.push({ mode: 'dom', action: 'Initial dashboard', rows: 12, screenshot: 'demo-dom.png' });

    await page.type('#mirrorHost >>> #q', '138', { delay: 90 });
    await page.waitForFunction(() => document.querySelector('#mirrorHost').shadowRoot.querySelectorAll('#tbody tr').length === 1);
    await page.click('#mirrorHost >>> #rent');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type('299', { delay: 100 });
    await page.waitForFunction(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('#total').textContent === '￥6,458.40');
    const actual = await page.evaluate(() => {
      const root = document.querySelector('#mirrorHost').shadowRoot;
      return { query: root.querySelector('#q').value, count: root.querySelector('#cnt').textContent,
        rent: root.querySelector('#rent').value, total: root.querySelector('#total').textContent };
    });
    assert.deepEqual(actual, { query: '138', count: '1', rent: '299', total: '￥6,458.40' });
    await (await page.$('#mirrorBox')).screenshot({ path: path.join(output, 'demo-interaction.png') });
    report.steps.push({ mode: 'dom', action: 'Real keyboard search and quote edit', ...actual, screenshot: 'demo-interaction.png' });

    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    let frameMessages = 0;
    cdp.on('Network.webSocketFrameReceived', ({ response }) => {
      try {
        const message = JSON.parse(response.payloadData);
        if (message.type === 'anim-tiles' && message.tiles?.length) frameMessages++;
      } catch {}
    });
    await page.click('button[data-m="frame"]');
    await page.waitForFunction(() => document.querySelector('#mMode').textContent === 'frame'
      && document.querySelector('#connectionNotice').hidden
      && document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-tiles')?.width > 0,
    { timeout: 20000 });
    const deadline = Date.now() + 10000;
    while (!frameMessages && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(frameMessages > 0, 'Frame mode must receive nonempty PNG tile updates');
    await page.waitForFunction(() => {
      const layer = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-tiles');
      return layer?.height > 100 && layer.getContext('2d').getImageData(1, 1, 1, 1).data[3] > 0;
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await captureOverview('demo-frame.png');
    report.steps.push({ mode: 'frame', action: 'Switch the existing session to PNG fallback',
      tileMessagesReceived: frameMessages, screenshot: 'demo-frame.png' });
    report.pass = true;
  } finally {
    await browser?.close();
    await demo.close();
    fs.writeFileSync(path.join(output, 'demo-capture.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
