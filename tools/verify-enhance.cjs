'use strict';

// v0.15 增强项回归：adoptedStyleSheets 追踪（快照收集 + 1Hz 指纹触发重同步）与
// 输入值掩码（MASK_INPUT_TYPES=text）。断言：
//  1) 初始镜像 #target 计算背景 = 构造样式表的绿色（快照收集 adopted 规则）；
//  2) 点击 flip 后 ~1.5s 内镜像背景变红（指纹签名变化 → 全量重同步）；
//  3) 掩码：镜像 #q 的 value 属性为等长 *（12 字符），非明文。

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

async function main() {
  const url = process.env.MIRROR_URL;
  if (!url) throw new Error('Set MIRROR_URL to a mirror of test/fixtures/enhance.html');
  const output = process.env.EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const results = { steps: [], pass: false };
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
    defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    const bg = () => page.evaluate(() => {
      const b = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
      return getComputedStyle(b.querySelector('#target')).backgroundColor;
    });
    await page.waitForFunction(() => {
      const b = document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('.xy-body');
      return b && b.querySelector('#target') && b.querySelector('#q');
    }, { timeout: 20000 });
    const bg1 = await bg();
    results.adoptedBefore = bg1;
    if (bg1 !== 'rgb(81, 207, 102)') throw new Error('adopted sheet not collected, bg=' + bg1);
    results.steps.push('adopted-collected');

    // 掩码（非聚焦态读镜像 value 属性）
    const masked = await page.evaluate(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body #q').value);
    results.maskedValue = masked;
    if (masked !== '*'.repeat(12)) throw new Error('mask mismatch: ' + JSON.stringify(masked));
    results.steps.push('mask-value');

    // 源站 1.8s 自动 replaceSync 翻红 → 1Hz 指纹变化 → 全量重同步 → 镜像背景变红
    let bg2 = null;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      bg2 = await bg();
      if (bg2 === 'rgb(255, 107, 107)') break;
      await new Promise(r => setTimeout(r, 400));
    }
    results.adoptedAfter = bg2;
    if (bg2 !== 'rgb(255, 107, 107)') throw new Error('adopted flip not resynced, bg=' + bg2);
    results.steps.push('adopted-resync');

    results.pass = true;
  } catch (error) {
    results.error = error.message;
  } finally {
    await browser.close();
    if (output) fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ pass: results.pass, steps: results.steps, error: results.error }));
  }
  if (!results.pass) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
