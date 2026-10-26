'use strict';

// v0.14 同源 iframe 回归：srcdoc 内联渲染、iframe 内交互与输入回环、跨域占位。
//  1) 镜像 #same iframe 以 srcdoc 渲染子文档（#title = CHILD-INIT）；
//  2) 点击 iframe 内 #btn → 源站 iframe 文档变更 → 宿主 outer 补丁（新 srcdoc）
//     → 镜像 iframe 重建后 #title 以 CHILD-CHANGED 开头；
//  3) iframe 内输入框打字 → 值同步按 id 命中 iframe 内元素 → #echo = echo:hi；
//  4) 跨域 #cross 在镜像中为占位块（data-xy-iframe-blocked），主文档渲染不受阻。

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

async function main() {
  const url = process.env.MIRROR_URL;
  if (!url) throw new Error('Set MIRROR_URL to a mirror of test/fixtures/iframe.html');
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
    await page.waitForFunction(() => {
      const b = document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('.xy-body');
      const f = b && b.querySelector('#same');
      return f && f.contentDocument && f.contentDocument.querySelector('#title')?.textContent === 'CHILD-INIT';
    }, { timeout: 20000 });
    results.steps.push({ step: 'srcdoc-inline', pass: true });

    // iframe 内点击：手动换算绝对坐标（iframe 主文档矩形 + 按钮 iframe 内矩形），
    // 真实鼠标走完整指针管线
    {
      const pos = await page.evaluate(() => {
        const f = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body #same');
        const fr = f.getBoundingClientRect();
        const br = f.contentDocument.querySelector('#btn').getBoundingClientRect();
        return { x: fr.left + br.left + br.width / 2, y: fr.top + br.top + br.height / 2 };
      });
      await page.mouse.move(pos.x, pos.y);
      await page.mouse.down();
      await page.mouse.up();
    }
    await page.waitForFunction(() => {
      const b = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
      const f = b.querySelector('#same');
      return f && f.contentDocument && (f.contentDocument.querySelector('#title')?.textContent || '').startsWith('CHILD-CHANGED');
    }, { timeout: 10000 });
    results.steps.push({ step: 'iframe-click', pass: true });

    // iframe 内输入（合成 composed InputEvent 进 iframe 文档的监听器）
    await page.evaluate(() => {
      const f = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body #same');
      const inp = f.contentDocument.querySelector('#in');
      inp.focus();
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      desc.set.call(inp, 'hi');
      inp.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    });
    await page.waitForFunction(() => {
      const b = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
      const f = b.querySelector('#same');
      return f && f.contentDocument && f.contentDocument.querySelector('#echo')?.textContent === 'echo:hi';
    }, { timeout: 10000 });
    results.steps.push({ step: 'iframe-input', pass: true });

    // 跨域占位：主文档仍渲染（有 body 有其他节点），#cross 位置为占位块
    const blocked = await page.evaluate(() => {
      const b = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
      const ph = b.querySelector('[data-xy-iframe-blocked]');
      return { has: !!ph, text: ph ? ph.textContent : null };
    });
    results.blocked = blocked;
    if (!blocked.has) throw new Error('cross-origin placeholder missing');
    results.steps.push({ step: 'cross-placeholder', pass: true });

    results.pass = results.steps.every(s => s.pass);
  } catch (error) {
    results.error = error.message;
  } finally {
    await browser.close();
    if (output) fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ pass: results.pass, steps: results.steps.map(s => s.step), error: results.error }));
  }
  if (!results.pass) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
