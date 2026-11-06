'use strict';
// clean-audit.cjs — dialog 修复后的端到端清洗审计(12 个无 alert 载荷)
// 前置: attack-origin2.cjs 以 PAYLOAD_SET="3,4,6,7,9,10,12,13,14,15,16,17" 运行于 8099
//        demo/server.js 以 ORIGIN_URL=http://127.0.0.1:8099/ 运行于 8088
const puppeteer = require('puppeteer').default;
const EXEC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
(async () => {
  const b = await puppeteer.launch({ headless: true, executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  const alerts = [], pageErrors = [];
  p.on('dialog', async d => { alerts.push(d.message()); await d.dismiss(); });
  p.on('pageerror', e => pageErrors.push(String(e).slice(0, 80)));
  await p.goto('http://127.0.0.1:8088/', { waitUntil: 'domcontentloaded' });
  let ready = false;
  for (let i = 0; i < 35 && !ready; i++) {
    await new Promise(r => setTimeout(r, 1000));
    ready = await p.evaluate(() => { const sr = document.getElementById('mirrorHost') && document.getElementById('mirrorHost').shadowRoot; const r = sr && sr.querySelector('.xy-body'); return !!(r && (r.textContent.includes('NORMAL-CONTENT') || r.textContent.includes('PK'))); }).catch(() => false);
  }
  if (!ready) { console.log('✗ 镜像未就绪'); await b.close(); process.exit(1); }
  const audit = await p.evaluate(() => {
    const sr = document.getElementById('mirrorHost').shadowRoot;
    const root = sr.querySelector('.xy-body');
    const html = root.innerHTML;
    return {
      scripts: root.querySelectorAll('script').length,
      onAttrs: [...root.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length,
      jsRefs: [...root.querySelectorAll('a,form,iframe,object,meta')].filter(e => [...e.attributes].some(a => /javascript:/i.test(String(a.value).replace(/\s/g, '')))).length,
      metaLeft: root.querySelectorAll('meta').length,
      secret: html.includes('SECRET'),
      forged: !!root.querySelector('[data-xy-id="99999"]'),
    };
  });
  await p.screenshot({ path: 'clean-audit.png' });
  console.log('=== 端到端清洗审计(dialog 修复后 · 12 无 alert 载荷) ===');
  console.log(`弹窗: ${alerts.length}${alerts.length ? ' ← ' + JSON.stringify(alerts) : '(零执行) ✓'} | 页面错误: ${pageErrors.length}`);
  console.log(`script=${audit.scripts}(应0) on*=${audit.onAttrs}(应0) javascript:引用=${audit.jsRefs}(应0) meta残留=${audit.metaLeft}(应0——本轮修复) 秘密泄漏=${audit.secret}(应false) 伪造标记采信=${audit.forged}(应false)`);
  const clean = audit.scripts === 0 && audit.onAttrs === 0 && audit.jsRefs === 0 && audit.metaLeft === 0 && !audit.secret && !audit.forged && alerts.length === 0 && pageErrors.length === 0;
  console.log(clean ? '\n★ 端到端清洗审计全绿(dialog 修复后载荷环境)——清洗完备性验证补齐' : '\n存在异常!');
  await b.close(); process.exit(clean ? 0 : 1);
})().catch(e => { console.error('FAIL', String(e.message).slice(0, 80)); process.exit(1); });
