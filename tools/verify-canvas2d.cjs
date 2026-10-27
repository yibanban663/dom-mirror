'use strict';

// v0.14 canvas 指令流回归：注入后创建的 2d 画布走 canvas-ops 重放（镜像保留
// <canvas>），注入前创建的画布走位图（镜像 img）。断言：
//  1) 镜像 #live 是 CANVAS 且像素确实在画（采样点非空白、柱色正确）；
//  2) 动画推进（两次采样 tick 文本/柱高不同 → 指令流持续到达）；
//  3) #legacy 在镜像中是 IMG（位图兜底）；
//  4) 统计本连接 canvas-ops 下行字节（带宽对比证据，双模式由 docker 脚本收集）。
// 环境变量 EXPECT_STREAM=0 时反向断言（CANVAS_STREAM=0 的位图模式对照）。

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

async function main() {
  const url = process.env.MIRROR_URL;
  if (!url) throw new Error('Set MIRROR_URL to a mirror of test/fixtures/canvas2d.html');
  const output = process.env.EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const expectStream = process.env.EXPECT_STREAM !== '0';
  const results = { mode: expectStream ? 'stream' : 'bitmap', bytes: { canvasOps: 0, canvasTile: 0, total: 0 }, pass: false };
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
    defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  });
  try {
    const page = await browser.newPage();
    page.on('console', (entry) => { results.console = (results.console || []).concat(entry.text().slice(0, 140)); });
    page.on('pageerror', (error) => { results.pageErrors = (results.pageErrors || []).concat(String(error).slice(0, 200)); });
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameReceived', ({ response }) => {
      const size = (response.payloadData || '').length;
      results.bytes.total += size;
      if (response.payloadData.startsWith('{"type":"canvas-ops"')) results.bytes.canvasOps += size;
      if (response.payloadData.startsWith('{"type":"canvas-tile"')) results.bytes.canvasTile += size;
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    // 点击源站按钮创建 live canvas（此刻注入已完成：2d 上下文走指令流 patch）。
    // 镜像中 canvas 元素不带原 id（位图通道替换为 img；流通道保留 canvas）：
    // 按引擎标记定位。fixture = 1 个位图画布 + 1 个点击后创建的画布
    await page.waitForFunction(() => {
      const b = document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('.xy-body');
      return b && b.querySelector('#mk') && b.querySelector('img[data-xy-canvas]');
    }, { timeout: 20000 });
    await page.click('#mirrorHost >>> #mk');
    if (expectStream) {
      await page.waitForFunction(() => {
        const b = document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('.xy-body');
        return b && b.querySelector('canvas[data-xy-canvas-stream]');
      }, { timeout: 20000 });
    } else {
      await page.waitForFunction(() => {
        const b = document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('.xy-body');
        return b && b.querySelectorAll('img[data-xy-canvas]').length >= 2;
      }, { timeout: 20000 });
    }

    const kind = await page.evaluate((stream) => {
      const b = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
      if (stream) {
        const c = b.querySelector('canvas[data-xy-canvas-stream]');
        return { live: c ? 'CANVAS' : 'none', legacy: b.querySelector('img[data-xy-canvas]') ? 'IMG' : 'none', w: c ? c.width : 0, h: c ? c.height : 0 };
      }
      const imgs = b.querySelectorAll('img[data-xy-canvas]');
      return { live: imgs.length >= 2 ? 'IMG' : 'none', legacy: imgs.length >= 1 ? 'IMG' : 'none' };
    }, expectStream);
    results.kind = kind;
    if (expectStream && kind.live !== 'CANVAS') throw new Error('live canvas should stay CANVAS in stream mode, got ' + kind.live);
    if (!expectStream && kind.live !== 'IMG') throw new Error('live canvas should be IMG in bitmap mode, got ' + kind.live);
    if (kind.legacy !== 'IMG') throw new Error('legacy canvas should be IMG (bitmap fallback), got ' + kind.legacy);
    results.steps = (results.steps || []).concat(['kinds:' + kind.live + '/' + kind.legacy]);

    // v0.29 指令流字节预算：#mkheavy 画布持续 putImageData 大块数据（单批远超
    // 100KB/10s 预算）——引擎应停发指令流并转位图，镜像侧 canvas 原位换 img
    //（img 继承 data-xy-canvas-stream 且补 data-xy-canvas 标记）。仅流模式有意义。
    if (expectStream) {
      await page.click('#mirrorHost >>> #mkheavy');
      // 超预算画布可能在追加补丁序列化时即占位 img（预算先于序列化触发），
      // 也可能先镜像为 canvas 再由 tile 触发原位替换——两种终态都是
      // img[data-xy-canvas]（流模式基线只有 legacy 1 个，heavy 到位后 ≥2）
      const heavy = await page.waitForFunction(() => {
        const b = document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('.xy-body');
        return b && b.querySelectorAll('img[data-xy-canvas]').length >= 2;
      }, { timeout: 15000 }).then(() => true).catch(() => false);
      results.heavyBudgetFlip = heavy;
      if (!heavy) throw new Error('heavy canvas should flip to bitmap (img) after ops budget exceeded');
      results.steps.push('heavy:flip-to-img');
    }

    // 采样镜像 live 画布像素（stream 直接 getImageData；bitmap 过一层 drawImage）。
    // 首批指令可能晚于 canvas 元素插入到达：带重试（最多 ~3s）等首批重放落笔。
    const sample = () => page.evaluate((stream) => {
      const b = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
      const el = stream ? b.querySelector('canvas[data-xy-canvas-stream]') : b.querySelectorAll('img[data-xy-canvas]')[1];
      const off = document.createElement('canvas');
      off.width = 320; off.height = 120;
      const c = off.getContext('2d');
      try { c.drawImage(el, 0, 0, 320, 120); } catch (e) {}
      const p1 = c.getImageData(60, 100, 1, 1).data;  // 柱区（黄 or 渐变）
      const p2 = c.getImageData(150, 8, 1, 1).data;   // 顶部空白区
      // 整画布签名（动画断言用：柱高每 tick 变化）
      let sig = 0;
      try {
        const d = c.getImageData(0, 0, 320, 120).data;
        for (let i = 3; i < d.length; i += 997 * 4) sig = (sig * 31 + d[i] + d[i - 1] + d[i - 2]) | 0;
      } catch (e) {}
      return { p1: [p1[0], p1[1], p1[2]], p2: [p2[0], p2[1], p2[2]], sig };
    }, expectStream);
    const sampleWithRetry = async () => {
      let s = await sample();
      for (let i = 0; i < 12 && (s.p1[0] === 0 && s.p1[1] === 0 && s.p1[2] === 0); i++) {
        await new Promise(r => setTimeout(r, 250));
        s = await sample();
      }
      return s;
    };
    const s1 = await sampleWithRetry();
    results.sample1 = s1;
    // 柱区应有颜色（黄 e9c46a ≈ 233,196,106 或渐变青绿），空白区接近透明/浅色
    if (expectStream) {
      const inked = s1.p1[0] > 30 || s1.p1[1] > 30 || s1.p1[2] > 30;
      if (!inked) throw new Error('live canvas appears blank: ' + JSON.stringify(s1.p1));
    }
    // 动画推进：等 700ms 再采样，整画布签名应变化（柱高每 tick 变）
    await new Promise(r => setTimeout(r, 700));
    const s2 = await sampleWithRetry();
    results.sample2 = s2;
    if (expectStream) {
      const changed = s1.sig !== s2.sig;
      if (!changed) throw new Error('live canvas not animating (signatures equal)');
    }
    results.steps = results.steps.concat(['pixels', 'animate']);
    results.pass = true;
  } catch (error) {
    results.error = error.message;
  } finally {
    await browser.close();
    if (output) fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ pass: results.pass, mode: results.mode, error: results.error, bytes: results.bytes }));
  }
  if (!results.pass) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
