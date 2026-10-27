'use strict';
// The image must run Chromium as non-root with its sandbox active under docker/seccomp-chromium.json.
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

(async () => {
  assert.notEqual(process.getuid(), 0, 'container must not run as root');
  const browser = await puppeteer.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.goto('chrome://sandbox');
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /You are adequately sandboxed/);
    console.log(JSON.stringify({ uid: process.getuid(), sandboxed: true }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
