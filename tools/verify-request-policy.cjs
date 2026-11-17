'use strict';
// Network-isolated, synthetic regression: the server-side browser must not reach origins outside its allowlist.
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { createMirror } = require('..');
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function stop(server) {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const hits = [];
  let originUrl;
  const forbidden = http.createServer((req, res) => {
    // Only the server-side browser sends the origin page as referrer; the mirror client renders from its own origin.
    if (String(req.headers.referer || '').startsWith(originUrl)) hits.push(req.url);
    res.setHeader('content-type', req.url.endsWith('.png') ? 'image/png' : 'text/html');
    res.end(req.url.endsWith('.png') ? Buffer.alloc(0) : '<p>FORBIDDEN_PAGE</p>');
  });
  const servers = [forbidden];
  let browser;
  const results = [];
  try {
    const forbiddenUrl = await listen(forbidden);
    const origin = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<p id="ok">ALLOWED_PAGE</p><img src="' + forbiddenUrl + '/pixel.png">'
        + '<a id="out" href="' + forbiddenUrl + '/nav">out</a>'
        + '<a id="blank" target="_blank" href="' + forbiddenUrl + '/blank">blank</a>'
        + '<button id="pop" onclick="window.open(\'' + forbiddenUrl + '/popup\')">pop</button>'
        + '<form action="' + forbiddenUrl + '/form" method="post"><button id="sub">sub</button></form>'
        + '<script>fetch("' + forbiddenUrl + '/xhr").catch(() => {});</script>');
    });
    servers.push(origin);
    originUrl = await listen(origin);
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
    for (const allowed of [false, true]) {
      hits.length = 0;
      const mirror = createMirror({ originUrl, obfuscate: false, sessionGraceMs: 0, requestOrigins: allowed ? [forbiddenUrl] : [] });
      const host = http.createServer(mirror.handleRequest);
      host.on('upgrade', mirror.handleUpgrade);
      const context = await browser.createBrowserContext();
      try {
        const url = await listen(host);
        const page = await context.newPage();
        const wire = [];
        const cdp = await page.createCDPSession();
        await cdp.send('Network.enable');
        cdp.on('Network.webSocketFrameReceived', ({ response }) => { if (response.opcode === 1) wire.push(response.payloadData); });
        await page.goto(url);
        await page.waitForFunction(() => document.querySelector('#mirrorHost')?.shadowRoot?.textContent.includes('ALLOWED_PAGE'), { timeout: 30000 });
        if (allowed) {
          // Positive control: the same page reaches an allowed origin, so zero hits below is meaningful.
          for (let i = 0; i < 50 && !hits.length; i++) await sleep(100);
          assert.ok(hits.includes('/pixel.png') && hits.includes('/xhr'), 'allowed origin unreachable: ' + hits.join(','));
        } else {
          for (const id of ['#pop', '#blank', '#sub', '#out']) {
            await page.click('#mirrorHost >>> ' + id);
            await sleep(1500);
          }
          assert.deepEqual(hits, [], 'server browser reached a non-allowlisted origin: ' + hits.join(','));
          assert.ok(wire.some(text => text.includes('NAVIGATION_BLOCKED')), 'blocked navigation was not reported');
          assert.ok(await page.evaluate(() => document.querySelector('#mirrorHost').shadowRoot.textContent.includes('ALLOWED_PAGE')));
        }
        results.push({ allowed, pass: true, hits: [...hits] });
      } finally { await context.close(); await mirror.close(); await stop(host); }
    }
    const report = { pass: true, results };
    if (process.env.EVIDENCE_DIR) {
      fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'request-policy.json'), JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify(report));
  } finally {
    await browser?.close();
    await Promise.all(servers.map(stop));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
