'use strict';
// 快照超时诊断: 在真实 ruanyifeng 页面直接跑 snapshotReal, 分段计时定位卡点
const puppeteer = require('puppeteer');
const { pageHelpers } = require('../lib/page-helpers');

(async () => {
  // server 的 sessHelpers: PAGE_HELPERS 字符串做双占位符替换
  const raw = pageHelpers({ redactAttributes: [], maskInputTypes: [], canvasStream: true });
  const ORIGIN_BASE = new URL('https://www.ruanyifeng.com/blog/');
  const esc = JSON.stringify('https://www.ruanyifeng.com').slice(1, -1);
  const helperScript = raw
    .split('__XY_DEFAULT_PREFIX__').join(JSON.stringify(ORIGIN_BASE.origin).slice(1, -1))
    .split('__XY_ORIGIN_PREFIX__').join(esc);
  if (!helperScript || helperScript.length < 1000) { console.log('✗ helpers 构造失败'); process.exit(2); }
  console.log('helpers 长度:', helperScript.length);

  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  console.log('goto ruanyifeng...');
  const tGoto = Date.now();
  await page.goto('https://www.ruanyifeng.com/blog/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('goto:', e.message));
  console.log('goto 完成:', Date.now() - tGoto, 'ms');
  await page.evaluate(helperScript);
  console.log('helpers 注入完成');
  // 计时跑 snapshotReal(wf=false, pt=CSS_PASS 默认?)
  const t0 = Date.now();
  const to = setTimeout(() => { console.log('✗ 15s snapshotReal 未返回(挂起实锤)'); process.exit(1); }, 15000);
  try {
    const snap = await page.evaluate((wf, pt) => window.__xy.snapshotReal(wf, pt), false, false);
    clearTimeout(to);
    console.log('snapshotReal 完成:', Date.now() - t0, 'ms | html 长度:', (snap.html || '').length, '| css 长度:', (snap.css || '').length);
  } catch (e) {
    clearTimeout(to);
    console.log('✗ snapshotReal 抛错:', String(e.message).slice(0, 150));
  }
  await browser.close();
})().catch((e) => { console.error('FAIL', String(e).slice(0, 120)); process.exit(2); });
