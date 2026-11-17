'use strict';
// 端到端 v5: 三路径验证
//  ① resize → 服务端重拍 → dom-snapshot 回流 → navProgressDone('done')挂钩
//  ② shadow 内 a.click() → navProgressStart('active')
//  ③ 无回流时 8s 超时兜底('' 清除)
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.goto('http://127.0.0.1:8088/', { waitUntil: 'networkidle2' });
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) { await new Promise(r => setTimeout(r, 500)); ready = await page.evaluate(() => !!document.querySelector('canvas')); }
  if (!ready) { console.log('✗ 镜像未就绪'); await browser.close(); process.exit(1); }
  await new Promise(r => setTimeout(r, 2500));
  // ① done 挂钩: resize → dom-snapshot → navProgressDone
  const seq1 = await page.evaluate(() => new Promise((resolve) => {
    const seq = [];
    const bar = document.getElementById('navProgress');
    const iv = setInterval(() => { const c = bar ? bar.className : '(none)'; if (!seq.length || seq[seq.length - 1] !== c) seq.push(c); }, 40);
    setTimeout(() => { clearInterval(iv); resolve(seq); }, 6000);
    window.dispatchEvent(new Event('resize'));
  }));
  console.log('① resize→回流序列:', JSON.stringify(seq1), seq1.includes('done') ? '✓ done 挂钩生效' : '(done 未捕获)');
  // ② start 挂钩: a.click()
  const seq2 = await page.evaluate(() => new Promise((resolve) => {
    const seq = [];
    const bar = document.getElementById('navProgress');
    const iv = setInterval(() => { const c = bar ? bar.className : '(none)'; if (!seq.length || seq[seq.length - 1] !== c) seq.push(c); }, 50);
    setTimeout(() => { clearInterval(iv); resolve(seq); }, 9000);
    for (const el of document.querySelectorAll('*')) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      const a = [...sr.querySelectorAll('a')].find(x => x.textContent.trim() === 'GO2');
      if (a) { a.click(); break; }
    }
  }));
  const sawActive = seq2.includes('active');
  const timeoutCleared = seq2[seq2.length - 1] === '';
  console.log('② 点击序列:', JSON.stringify(seq2), sawActive ? '✓ active 生效' : '✗ 无 active');
  console.log('③ 8s 超时兜底:', timeoutCleared ? '✓ 收尾为空' : '✗ 未收尾: ' + JSON.stringify(seq2));
  await browser.close();
  const pass = seq1.includes('done') && sawActive && timeoutCleared;
  console.log(pass ? '=== 导航转场三路径全部生效 ===' : '=== 存在未生效路径 ===');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FAIL', String(e.message).slice(0, 80)); process.exit(1); });
