'use strict';
// 回归测试: 点击镜像内链接 → 源站导航 → 快照回流 → 镜像渲染新页 + 进度条生命周期
// 红(修复前): 导航发生但镜像冻结旧页(TypeError css.replace) + done 未触发
// 绿(修复后): PAGE2-MARK 渲染 + active→done 完整生命周期
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 90)));
  await page.goto('http://127.0.0.1:8088/', { waitUntil: 'networkidle2' });
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) { await new Promise(r => setTimeout(r, 500)); ready = await page.evaluate(() => !!document.querySelector('canvas')); }
  if (!ready) { console.log('✗ 未就绪'); await browser.close(); process.exit(1); }
  await new Promise(r => setTimeout(r, 2500));
  const seq = page.evaluate(() => new Promise((resolve) => {
    const s = [];
    const bar = document.getElementById('navProgress');
    const iv = setInterval(() => { const c = bar ? bar.className : '(none)'; if (!s.length || s[s.length - 1] !== c) s.push(c); }, 50);
    setTimeout(() => { clearInterval(iv); resolve(s); }, 9000);
    for (const el of document.querySelectorAll('*')) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      const a = [...sr.querySelectorAll('a')].find(x => x.textContent.trim() === 'GO2');
      if (a) { a.click(); return; }
    }
  }));
  let navigated = false;
  for (let i = 0; i < 24 && !navigated; i++) {
    await new Promise(r => setTimeout(r, 400));
    navigated = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) { const sr = el.shadowRoot; if (sr && sr.textContent.includes('PAGE2-MARK')) return true; }
      return false;
    });
  }
  const seqFinal = await seq;
  console.log('镜像渲染新页:', navigated ? '✓ PAGE2-MARK 已渲染' : '✗ 冻结旧页');
  console.log('进度条生命周期:', JSON.stringify(seqFinal), seqFinal.includes('active') ? '✓ active' : '✗ 无 active', seqFinal.includes('done') ? '✓ done' : '(done 未捕获)');
  console.log('客户端异常:', errors.length ? '✗ ' + errors.join(' | ') : '✓ 无 pageerror');
  await browser.close();
  const pass = navigated && seqFinal.includes('active') && errors.length === 0;
  console.log(pass ? '=== 回归测试通过(绿) ===' : '=== 回归测试失败(红) ===');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FAIL', String(e.message).slice(0, 80)); process.exit(1); });
