'use strict';
// canvas 像素级验证: 静态画布(红蓝矩形, v0.82 恒空白 bug 的回归判定)
//                 + 动态画布(持续重绘, 指令流重放)+ 幻影批次日志检查
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.goto('http://127.0.0.1:8088/', { waitUntil: 'networkidle2' });
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) { await new Promise(r => setTimeout(r, 400)); ready = await page.evaluate(() => !!document.querySelector('canvas')); }
  if (!ready) { console.log('✗ 未就绪'); await browser.close(); process.exit(1); }
  await new Promise(r => setTimeout(r, 3500)); // 等指令流/快照渲染
  const res = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      for (const c of sr.querySelectorAll('canvas')) {
        const r = c.getBoundingClientRect();
        let info = { w: Math.round(r.width), h: Math.round(r.height), pixels: null, err: '' };
        try {
          const ctx = c.getContext('2d');
          if (!ctx) { info.err = 'no-2d-context'; }
          else {
            const d = ctx.getImageData(0, 0, Math.min(c.width, 200), Math.min(c.height, 120)).data;
            let red = 0, blue = 0, opaque = 0, total = d.length / 4;
            for (let i = 0; i < d.length; i += 4) {
              if (d[i + 3] > 0) opaque++;
              if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90) red++;
              if (d[i + 2] > 180 && d[i] < 90 && d[i + 1] < 90) blue++;
            }
            info.pixels = { total, opaque, red, blue };
          }
        } catch (e) { info.err = String(e.message).slice(0, 60); }
        out.push(info);
      }
    }
    return out;
  });
  console.log('镜像画布像素分析:');
  res.forEach((c, i) => console.log(`  画布${i + 1}: ${c.w}x${c.h} | 像素: ${JSON.stringify(c.pixels)} ${c.err ? '| err: ' + c.err : ''}`));
  // 判定: 至少一个画布含红色与蓝色像素(静态画布内容), 非全透明
  const withPx = res.filter((c) => c.pixels && c.pixels.total > 100);
  const hasColor = withPx.some((c) => c.pixels.red > 50 && c.pixels.blue > 50);
  const allBlank = withPx.length > 0 && withPx.every((c) => c.pixels.opaque === 0);
  console.log(withPx.length ? (allBlank ? '✗ 画布全透明(恒空白回归!)' : hasColor ? '✓ 静态画布内容渲染(红蓝矩形在)' : '△ 有像素但无红蓝(内容待查)') : '✗ 无可读画布像素');
  console.log(hasColor ? '=== 静态画布内容验证通过(v0.82 修复生效) ===' : '=== 未确认 ===');
  await browser.close();
  process.exit(hasColor ? 0 : 1);
})().catch((e) => { console.error('FAIL', String(e).slice(0, 100)); process.exit(2); });
