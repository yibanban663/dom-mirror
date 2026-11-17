'use strict';
// Network-isolated, synthetic two-origin regression; no external targets or credentials.
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
(async () => {
  let nodeFetches = 0;
  const frame = http.createServer((req, res) => {
    if (req.headers['user-agent'] === 'rbi-mirror-xframe') nodeFetches++;
    res.setHeader('content-type', 'text/html');
    res.end('<p id="visible">VISIBLE_FRAME</p><input type="hidden" value="PRIVATE_HIDDEN">'
      + '<input type="password" value="PRIVATE_PASSWORD"><input type="file" value="PRIVATE_FILE">'
      + '<input type="email" value="PRIVATE_EMAIL"><textarea>PRIVATE_TEXTAREA</textarea>'
      + '<div data-private="PRIVATE_ATTRIBUTE">public</div><template><input value="PRIVATE_TEMPLATE"></template>'
      + '<script>window.privateData="PRIVATE_SCRIPT"</script>');
  });
  const servers = [frame];
  let browser;
  const results = [];
  try {
    const frameUrl = await listen(frame);
    const origin = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html'); res.end('<iframe src="' + frameUrl + '/"></iframe>');
    });
    servers.push(origin);
    const originUrl = await listen(origin);
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
    for (const allowed of [false, true]) {
      const mirror = createMirror({ originUrl, obfuscate: false, sessionGraceMs: 0,
        crossOriginFrameOrigins: allowed ? [frameUrl] : [],
        redactAttributes: ['data-private'], maskInputTypes: ['email', 'textarea'] });
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
        if (allowed) {
          await page.waitForFunction(() => document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('iframe')?.srcdoc.includes('VISIBLE_FRAME'), { timeout: 30000 });
          const srcdoc = await page.evaluate(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('iframe').srcdoc);
          for (const value of ['PRIVATE_HIDDEN', 'PRIVATE_PASSWORD', 'PRIVATE_FILE', 'PRIVATE_EMAIL', 'PRIVATE_TEXTAREA',
            'PRIVATE_ATTRIBUTE', 'PRIVATE_TEMPLATE', 'PRIVATE_SCRIPT']) {
            assert.ok(!srcdoc.includes(value), 'srcdoc leaks ' + value);
            assert.ok(!wire.join('\n').includes(value), 'WS leaks ' + value);
          }
          assert.ok(srcdoc.includes('*****'));
          assert.ok(nodeFetches > 0);
        } else {
          await page.waitForSelector('#mirrorHost >>> [data-xy-iframe-blocked]', { timeout: 30000 });
          assert.equal(nodeFetches, 0, 'default policy made a Node-side cross-origin request');
          assert.ok(!wire.join('\n').includes('VISIBLE_FRAME'));
        }
        results.push({ allowed, pass: true, nodeFetches });
      } finally { await context.close(); await mirror.close(); await stop(host); }
    }
    const report = { pass: true, results };
    if (process.env.EVIDENCE_DIR) {
      fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'xframe-policy.json'), JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify(report));
  } finally {
    await browser?.close();
    await Promise.all(servers.map(stop));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
