'use strict';

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

async function main() {
  const url = process.env.MIRROR_URL;
  if (!url) throw new Error('Set MIRROR_URL to a mirror of test/fixtures/scroll.html');
  const output = process.env.EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const results = [];
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
    defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  });
  try {
    for (const kind of ['visible', 'outer', 'inner']) {
      const page = await browser.newPage();
      const frames = [];
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.webSocketFrameSent', ({ response }) => {
        frames.push(JSON.parse(response.payloadData));
      });
      const result = { kind, pass: false, frames };
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.bringToFront();
        await page.waitForFunction(() => document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('#outer-count')?.textContent === '0', { timeout: 20000 });
        await page.waitForFunction(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('#state-select').value === '1', { timeout: 5000 });
        // One real mouse click, without waiting for the auto-scroll event or retrying.
        await page.click('#mirrorHost >>> #' + kind + '-button');
        await page.waitForFunction(kind => document.querySelector('#mirrorHost').shadowRoot.querySelector('#' + kind + '-count').textContent === '1', { timeout: 5000 }, kind);
        if (kind === 'visible') await page.waitForFunction(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('#state-select').value === '2', { timeout: 5000 });
        result.pass = true;
      } catch (error) {
        result.error = error.message;
      } finally {
        results.push(result);
        console.log(JSON.stringify({ kind, pass: result.pass, error: result.error }));
        await page.close();
      }
    }
  } finally {
    await browser.close();
    if (output) fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
  }
  if (results.some(result => !result.pass)) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
