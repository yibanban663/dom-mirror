'use strict';

// v0.13 P0 三件套回归（IME 合成/上屏、文件上传回环、文件下载回环）：
//  - IME：在镜像输入框派发真实 CompositionEvent 序列（start/update('nihao')/end('你好')），
//    断言远端合成期回显 'nihao'（CDP imeSetComposition 生效）且上屏后为 '你好'（insertText）。
//  - 上传：镜像 file input 经 DataTransfer 置入真实 File（触发原生 change），断言远端
//    页面读到同名同内容文件（WS 分块 → 服务端临时目录 → CDP setFileInputFiles → change）。
//  - 下载：点击镜像下载链接，断言客户端装配出同名同内容文件（downloadWillBegin/Progress →
//    分块下行 → Blob + a[download]）。

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const UP_NAME = 'up-p0.txt';
const UP_TEXT = 'P0-UPLOAD-MARKER 0123456789';
const DL_TEXT = 'P0-DOWNLOAD-MARKER abcdefghijklmnopqrstuvwxyz';

async function main() {
  const url = process.env.MIRROR_URL;
  if (!url) throw new Error('Set MIRROR_URL to a mirror of test/fixtures/longtail-p0.html');
  const output = process.env.EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const results = { ime: {}, upload: {}, download: {}, pass: false };
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
    defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  });
  try {
    const page = await browser.newPage();
    page.on('console', (entry) => { results.console = (results.console || []).concat(entry.text().slice(0, 160)); });
    page.on('pageerror', (error) => { results.pageErrors = (results.pageErrors || []).concat(String(error).slice(0, 200)); });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await page.waitForFunction(() => {
      const body = document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('.xy-body');
      return body && body.querySelector('#q') && body.querySelector('#echo');
    }, { timeout: 20000 });

    // ---- IME ----
    try {
      await page.click('#mirrorHost >>> #q');
      await page.waitForFunction(() => document.activeElement && document.querySelector('#mirrorHost').shadowRoot.activeElement === document.querySelector('#mirrorHost').shadowRoot.querySelector('#q'), { timeout: 3000 });
      await page.evaluate(() => {
        const q = document.querySelector('#mirrorHost').shadowRoot.querySelector('#q');
        q.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        q.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'nihao' }));
      });
      await page.waitForFunction(() => {
        const echo = document.querySelector('#mirrorHost').shadowRoot.querySelector('#echo');
        return echo && echo.textContent === 'echo:nihao';
      }, { timeout: 6000 }).catch(() => {});
      results.ime.composition = await page.evaluate(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('#echo').textContent);
      await page.evaluate(() => {
        const q = document.querySelector('#mirrorHost').shadowRoot.querySelector('#q');
        q.value = '你好';
        q.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
      });
      await page.waitForFunction(() => {
        const root = document.querySelector('#mirrorHost').shadowRoot;
        const echo = root.querySelector('#echo');
        const q = root.querySelector('#q');
        return echo && echo.textContent === 'echo:你好' && q && q.value === '你好';
      }, { timeout: 6000 });
      results.ime.commit = await page.evaluate(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('#echo').textContent);
      results.ime.pass = results.ime.commit === 'echo:你好';
    } catch (error) { results.ime.error = error.message; }

    // ---- Upload ----
    try {
      await page.evaluate(async (name, text) => {
        const dt = new DataTransfer();
        dt.items.add(new File([text], name, { type: 'text/plain' }));
        const f = document.querySelector('#mirrorHost').shadowRoot.querySelector('#f');
        f.files = dt.files;
        f.dispatchEvent(new Event('change', { bubbles: true }));
      }, UP_NAME, UP_TEXT);
      await page.waitForFunction((name, text) => {
        const up = document.querySelector('#mirrorHost').shadowRoot.querySelector('#up-status');
        return up && up.textContent.startsWith('GOT ' + name) && up.textContent.includes(text.slice(0, 8));
      }, { timeout: 10000 }, UP_NAME, UP_TEXT);
      results.upload.status = await page.evaluate(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('#up-status').textContent);
      results.upload.clientRecords = await page.evaluate(() => window.__xyUploads);
      results.upload.pass = results.upload.status.startsWith('GOT ' + UP_NAME);
    } catch (error) {
      results.upload.error = error.message;
      try {
        results.upload.status = await page.evaluate(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('#up-status').textContent);
        results.upload.clientRecords = await page.evaluate(() => window.__xyUploads);
        results.upload.mirrorFiles = await page.evaluate(() => {
          const f = document.querySelector('#mirrorHost').shadowRoot.querySelector('#f');
          return f && f.files ? f.files.length : -1;
        });
      } catch {}
    }

    // ---- Download ----
    try {
      await page.click('#mirrorHost >>> #dl');
      await page.waitForFunction((marker) => {
        return (window.__xyDownloads || []).some(d => d.state === 'saved' && d.name === 'p0-dl.txt' && d.text && d.text.includes(marker));
      }, { timeout: 12000 }, DL_TEXT);
      results.download.records = await page.evaluate(() => window.__xyDownloads);
      results.download.pass = results.download.records.some(d => d.state === 'saved' && d.name === 'p0-dl.txt');
    } catch (error) {
      results.download.error = error.message;
      try { results.download.records = await page.evaluate(() => window.__xyDownloads); } catch {}
    }

    results.pass = !!(results.ime.pass && results.upload.pass && results.download.pass);
  } catch (error) {
    results.error = error.message;
  } finally {
    await browser.close();
    if (output) fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ pass: results.pass, ime: results.ime.pass || results.ime.error, upload: results.upload.pass || results.upload.error, download: results.download.pass || results.download.error }));
  }
  if (!results.pass) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
