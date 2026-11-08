'use strict';
// 装配序列模拟: 复刻 server 装配(exposeFunction/拦截器/double evaluateOnNewDocument)
// 逐步 evaluate snapshotReal, 定位挂起差异
const puppeteer = require('puppeteer');
const { pageHelpers } = require('../lib/page-helpers');

(async () => {
  const raw = pageHelpers({ redactAttributes: [], maskInputTypes: [], canvasStream: true });
  const esc = JSON.stringify('https://www.ruanyifeng.com').slice(1, -1);
  const script = raw
    .split('__XY_DEFAULT_PREFIX__').join(JSON.stringify('https://www.ruanyifeng.com/blog/').slice(1, -1))
    .split('__XY_ORIGIN_PREFIX__').join(esc);

  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // server 装配顺序: evaluateOnNewDocument(early shadow) 在 goto 前
  await page.evaluateOnNewDocument(() => {
    if (window.__xyEarlyShadow) return;
    window.__xyEarlyShadow = true;
    try {
      window.__xyClosedRoots = new WeakMap();
      window.__xyClosedList = [];
      const orig = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        const sr = orig.call(this, init);
        try { if (sr && init && init.mode === 'closed') { window.__xyClosedRoots.set(this, sr); if (window.__xyClosedList.length < 64) window.__xyClosedList.push({ host: this, root: sr }); } } catch (e) {}
        return sr;
      };
    } catch (e) {}
  });
  await page.evaluateOnNewDocument(script); // v0.78 warm: helpers 同步早挂
  // server: 拦截器
  await page.setRequestInterception(true);
  page.on('request', (r) => { if (/beekka\.com/.test(r.url())) r.abort('blockedbyclient').catch(() => {}); else r.continue().catch(() => {}); });
  const tG = Date.now();
  await page.goto('https://www.ruanyifeng.com/blog/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  console.log('goto:', Date.now() - tG, 'ms');
  await page.evaluate(script); // sessHelpers
  console.log('✓ sessHelpers 注入');
  await page.exposeFunction('__xyPatch', (patches) => { /* 静默 */ });
  console.log('✓ exposeFunction');

  const snapOnce = async (label) => {
    const t0 = Date.now();
    const to = setTimeout(() => { console.log(`  ${label}: ✗ 12s 挂起`); clearTimeout(to); throw new Error('hang'); }, 12000);
    try {
      const s = await page.evaluate((wf, pt) => window.__xy.snapshotReal(wf, pt), false, false);
      clearTimeout(to);
      console.log(`  ${label}: ✓ ${Date.now() - t0}ms html=${(s.html || '').length}B keys=${Object.keys(s).length}`);
      return true;
    } catch (e) { clearTimeout(to); console.log(`  ${label}: ✗ ${String(e.message).slice(0, 80)}`); return false; }
  };
  try {
    await snapOnce('第1次');
    await snapOnce('第2次');
    await snapOnce('第3次');
  } catch (e) { console.log('挂起复现于序列中'); }
  await browser.close();
})().catch((e) => { console.error('FAIL', String(e).slice(0, 120)); process.exit(2); });
