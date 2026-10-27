'use strict';

// Controlled first-frame ordering: snapshot is delivered, screencast frames are withheld until the first source operation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const { createMirror } = require('..');
const output = process.env.EVIDENCE_DIR;
assert.ok(output); fs.mkdirSync(output, { recursive: true });
const report = { suppressed: 0, forwarded: 0, events: [], passed: false };
const originalLaunch = puppeteer.default.launch;
puppeteer.default.launch = async function (...args) {
  const browser = await originalLaunch.apply(this, args);
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...pageArgs) => {
    const page = await newPage(...pageArgs);
    let allowed = false;
    page.on('request', req => { if (req.url().endsWith('/events')) allowed = true; });
    const create = page.createCDPSession.bind(page);
    page.createCDPSession = async () => {
      const cdp = await create(), on = cdp.on.bind(cdp);
      cdp.on = (event, listener) => on(event, event === 'Page.screencastFrame' ? async payload => {
        const pixel = await sharp(Buffer.from(payload.data, 'base64')).extract({ left: 1260, top: 20, width: 1, height: 1 }).ensureAlpha().raw().toBuffer();
        if (!allowed || pixel[0] !== 31 || pixel[1] !== 139 || pixel[2] !== 67) {
          report.suppressed++; cdp.send('Page.screencastFrameAck', { sessionId: payload.sessionId }).catch(() => {}); return;
        }
        if (!report.firstForwardedPixel) report.firstForwardedPixel = [...pixel];
        report.forwarded++; listener(payload);
      } : listener);
      return cdp;
    };
    return page;
  };
  return browser;
};
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
const source = http.createServer(async (req, res) => {
  if (req.url === '/events' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    report.events.push(JSON.parse(raw)); res.end('ok'); return;
  }
  res.setHeader('content-type', 'text/html'); res.end(fs.readFileSync(path.join(__dirname, 'fixtures/capacity.html')));
});
(async () => {
  let mirror, host, client;
  try {
    mirror = createMirror({ browserPoolSize: 0, originUrl: await listen(source), defaultMode: 'frame', obfuscate: false, logger: { log() {} } });
    host = http.createServer(mirror.handleRequest); host.on('upgrade', mirror.handleUpgrade);
    const url = await listen(host);
    client = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 } });
    const page = await client.newPage();
    await page.evaluateOnNewDocument(require('./profile-client.cjs'));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#connectionNotice').hidden, { timeout: 30000 });
    await page.click('#mirrorHost >>> #command'); await page.type('#mirrorHost >>> #command', 'probe');
    report.initialPixel = await page.evaluate(() => [...document.querySelector('#mirrorHost').shadowRoot
      .querySelector('canvas.xy-tiles').getContext('2d').getImageData(1260, 20, 1, 1).data]);
    assert.deepEqual(report.initialPixel, [24, 139, 67, 255]);
    await page.evaluate(() => window.__profileArm('Measured task 00', 0, false));
    await page.keyboard.press('Enter');
    try {
      await page.waitForFunction(() => window.__profileRead().paintOpportunityMs !== null, { timeout: 5000, polling: 20 });
      report.passed = true;
    } finally {
      report.client = await page.evaluate(() => ({ probe: window.__profileRead(),
        text: document.querySelector('#mirrorHost').shadowRoot.querySelector('#result').textContent,
        pixels: [...document.querySelector('#mirrorHost').shadowRoot.querySelectorAll('canvas.xy-tiles')].map(canvas =>
          [...canvas.getContext('2d').getImageData(1260, 20, 1, 1).data]) }));
      await page.screenshot({ path: path.join(output, 'frame-baseline.png') });
    }
    assert.equal(report.events.length, 1); assert.ok(report.forwarded > 0);
    assert.deepEqual(report.firstForwardedPixel, [31, 139, 67, 255]);
  } catch (error) { report.error = error.stack; process.exitCode = 1; }
  finally {
    await client?.close(); await mirror?.close(); puppeteer.default.launch = originalLaunch;
    for (const server of [host, source]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
