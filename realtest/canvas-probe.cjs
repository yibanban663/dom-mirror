'use strict';
// canvas/CSS 直通功能探针: puppeteer 开 client, 验证镜像端画布渲染 + CSS 下发
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.goto('http://127.0.0.1:8088/', { waitUntil: 'networkidle2' });
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) { await new Promise(r => setTimeout(r, 400)); ready = await page.evaluate(() => !!document.querySelector('canvas')); }
  if (!ready) { console.log('✗ 未就绪'); await browser.close(); process.exit(1); }
  await new Promise(r => setTimeout(r, 3000));
  // 深入 shadow DOM 验证 canvas 与样式
  const res = await page.evaluate(() => {
    let out = { canvases: [], styles: 0, bgOk: false, textOk: false };
    for (const el of document.querySelectorAll('*')) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      const cs = sr.querySelectorAll('canvas');
      for (const c of cs) {
        try {
          const r = c.getBoundingClientRect();
          out.canvases.push({ w: Math.round(r.width), h: Math.round(r.height) });
        } catch (e) {}
      }
      const st = sr.querySelectorAll('style');
      out.styles = st.length;
      let cssText = '';
      for (const s of st) cssText += s.textContent + '\n';
      out.styleHead = cssText.replace(/\s+/g, ' ').slice(0, 220);
      // 实际计算样式验证(排除覆盖误判)
      const body = sr.querySelector('.xy-body') || sr.querySelector('body');
      if (body) out.bodyBg = getComputedStyle(body).backgroundColor;
      const h2 = [...sr.querySelectorAll('h2, [id="subcss"]')].find((x) => x.textContent.includes('SUBCSS-MARK'));
      if (h2) out.h2Color = getComputedStyle(h2).color;
      const p = [...sr.querySelectorAll('p')].find((x) => x.textContent.includes('CANVAS-OK'));
      if (p) out.pColor = getComputedStyle(p).color;
    }
    return out;
  });
  console.log('镜像画布数:', res.canvases.length, JSON.stringify(res.canvases));
  console.log('样式表块:', res.styles, '| body bg:', res.bodyBg || '(未测)', '| h2 色(@import sub.css):', res.h2Color || '(无 h2)', '| p 色(main.css):', res.pColor || '(未测)');
  console.log('style 内容头 220 字符:', res.styleHead);
  await browser.close();
  const pass = res.canvases.length >= 1 && res.pColor === 'rgb(51, 51, 51)' && res.h2Color === 'rgb(0, 119, 0)';
  console.log(pass ? '=== 功能验证通过 ===' : '=== 功能验证失败 ===');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FAIL', String(e).slice(0, 100)); process.exit(2); });
