'use strict';

// v0.14 Shadow DOM 回归：声明式影子树序列化、影子内交互/输入、注入后新建组件、
// 影子内 canvas 捕获。断言：
//  1) 镜像 #c1 拥有 shadowRoot（声明式 template 重建）且 #title = CARD-INIT；
//  2) 点击影子内 #btn → 影子 #title 变 CARD-CHANGED-1（事件穿透 + 宿主 outer 补丁重建）；
//  3) 影子内输入框打字 → 影子 #out 显示 typed:xx（值同步按 id 命中影子内 input）；
//  4) 900ms 后延迟挂载的 #c2 影子树出现在镜像（attachShadow patch + 全量重同步路径）；
//  5) 影子内 canvas 被替换为带像素内容的 img（递归穿透捕获）。

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

async function main() {
  const url = process.env.MIRROR_URL;
  if (!url) throw new Error('Set MIRROR_URL to a mirror of test/fixtures/shadow.html');
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
    const sentFrames = [];
    {
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.webSocketFrameSent', ({ response }) => {
        try { sentFrames.push(JSON.parse(response.payloadData)); } catch {}
      });
      results.sentTypes = () => sentFrames.map(f => f.type + (f.kind ? ':' + f.kind : '') + (f.id !== undefined ? '#' + f.id : ''));
    }
    page.on('console', (entry) => { results.console = (results.console || []).concat(entry.text().slice(0, 160)); });
    page.on('pageerror', (error) => { results.pageErrors = (results.pageErrors || []).concat(String(error).slice(0, 200)); });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await page.waitForFunction(() => {
      const c1 = document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('.xy-body #c1');
      return c1 && c1.shadowRoot && c1.shadowRoot.querySelector('#title')?.textContent === 'CARD-INIT';
    }, { timeout: 20000 }).catch(async () => {
      results.diag = await page.evaluate(() => {
        const b = document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('.xy-body');
        const c1 = b ? b.querySelector('#c1') : null;
        return {
          hasBody: !!b,
          c1: c1 ? { hasShadow: !!c1.shadowRoot, html: c1.innerHTML.slice(0, 200), children: c1.children.length } : null,
          bodyHead: b ? b.innerHTML.slice(0, 300) : null,
        };
      }).catch(() => null);
      throw new Error('first wait failed');
    });
    results.steps.push({ step: 'declarative-shadow', pass: true });

    // 影子内点击：真实鼠标坐标点击（CDP Input 事件走客户端完整指针管线），
    // 服务端按锚点平移后在源站真实按压影子内按钮
    {
      const handle = await page.evaluateHandle(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body #c1').shadowRoot.querySelector('#btn'));
      const btn = handle.asElement();
      const bb = await btn.boundingBox();
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await page.mouse.down();
      await page.mouse.up();
      await handle.dispose();
    }
    await page.waitForFunction(() => {
      const c1 = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body #c1');
      return c1 && c1.shadowRoot && c1.shadowRoot.querySelector('#title')?.textContent === 'CARD-CHANGED-1';
    }, { timeout: 8000 });
    results.steps.push({ step: 'shadow-click', pass: true });

    // 影子内输入（值同步按 id 命中影子内元素）。合成事件必须 composed:true
    // 才能穿过影子边界到达镜像根的监听器（浏览器原生事件恒为 composed）
    await page.evaluate(() => {
      const c1 = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body #c1');
      const inp = c1.shadowRoot.querySelector('#in');
      inp.focus();
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      desc.set.call(inp, 'hi');
      inp.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    });
    await page.waitForFunction(() => {
      const c1 = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body #c1');
      return c1 && c1.shadowRoot && c1.shadowRoot.querySelector('#out')?.textContent === 'typed:hi';
    }, { timeout: 8000 }).catch(async () => {
      results.inputDiag = await page.evaluate(() => {
        const c1 = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body #c1');
        const inp = c1 && c1.shadowRoot ? c1.shadowRoot.querySelector('#in') : null;
        return {
          inpHasId: inp ? inp.getAttribute('data-xy-id') : null,
          out: c1 && c1.shadowRoot ? c1.shadowRoot.querySelector('#out')?.textContent : null,
          title: c1 && c1.shadowRoot ? c1.shadowRoot.querySelector('#title')?.textContent : null,
        };
      }).catch(() => null);
      throw new Error('input wait failed');
    });
    results.steps.push({ step: 'shadow-input', pass: true });

    // 延迟挂载组件（attachShadow patch 路径）
    await page.waitForFunction(() => {
      const b = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
      const c2 = b.querySelector('#c2');
      return c2 && c2.shadowRoot && c2.shadowRoot.querySelector('#title')?.textContent === 'CARD-INIT';
    }, { timeout: 15000 });
    results.steps.push({ step: 'late-shadow-host', pass: true });

    // 影子内 canvas 捕获（递归穿透 + 按 id 回填 img）
    await page.waitForFunction(() => {
      const b = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
      const c1 = b.querySelector('#c1');
      const img = c1 && c1.shadowRoot ? c1.shadowRoot.querySelector('img[data-xy-canvas]') : null;
      return img && img.src && img.src.startsWith('data:image/png');
    }, { timeout: 15000 });
    results.steps.push({ step: 'shadow-canvas', pass: true });

    results.pass = results.steps.every(s => s.pass);
  } catch (error) {
    results.error = error.message;
  } finally {
    await browser.close();
    if (results.sentTypes) results.sentTypes = results.sentTypes();
    if (output) fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ pass: results.pass, steps: results.steps.map(s => s.step), error: results.error }));
  }
  if (!results.pass) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
