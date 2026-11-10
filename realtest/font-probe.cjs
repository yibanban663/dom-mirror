'use strict';
// FONT_ALIGN 生效验证: 镜像端 css 替换/@font-face 注入/Noto 字体可加载
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  const fontReqs = [];
  page.on('response', (r) => { if (r.url().includes('/f/noto')) fontReqs.push(r.status() + ' ' + r.url().split('/').pop()); });
  await page.goto('http://127.0.0.1:8088/', { waitUntil: 'networkidle2' });
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) { await new Promise(r => setTimeout(r, 400)); ready = await page.evaluate(() => !!document.querySelector('canvas')); }
  if (!ready) { console.log('✗ 未就绪'); await browser.close(); process.exit(1); }
  await new Promise(r => setTimeout(r, 3000));
  const res = await page.evaluate(() => {
    let cssText = '', replaced = { t1: null, t2: null, t3: null }, georgiaKept = null;
    for (const el of document.querySelectorAll('*')) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      for (const s of sr.querySelectorAll('style')) cssText += s.textContent + '\n';
      for (const [id, key] of [['t1', 't1'], ['t2', 't2'], ['t3', 't3'], ['t4', 't4']]) {
        const el2 = sr.querySelector('#' + id);
        if (el2) {
          const ff = getComputedStyle(el2).fontFamily;
          if (key === 't4') georgiaKept = ff;
          else replaced[key] = ff;
        }
      }
    }
    const ffLines = cssText.split('\n').filter((l) => l.includes('font-family')).map((l) => l.trim().slice(0, 90));
    const LOCAL_FONTS_P = 'PingFang SC|Hiragino Sans GB|Microsoft YaHei|微软雅黑|SimHei|黑体|SimSun|宋体|KaiTi|楷体|Source Han Sans SC|思源黑体|Source Han Serif SC|Noto Sans CJK SC|Noto Serif CJK SC|WenQuanYi[a-zA-Z ]*|Heiti SC|STHeiti|LiHei Pro|SF Pro (?:Text|Display)|Helvetica Neue|Segoe UI|Roboto|Ubuntu|Cantarell|system-ui|apple-system|BlinkMacSystemFont';
    const famReProbe = new RegExp('(["\']?)(' + LOCAL_FONTS_P + ')\\1', 'i');
    const famReProbeTest = { yahei: famReProbe.test('Microsoft YaHei'), simsun: famReProbe.test('SimSun') };
    const styleCount = [];
    for (const el of document.querySelectorAll('*')) { const sr = el.shadowRoot; if (sr) styleCount.push(sr.querySelectorAll('style').length); }
    return { ffLines, famReProbeTest, styleCount, cssText, replaced, georgiaKept, notoFace: cssText.includes('Noto Sans SC') && cssText.includes('/f/noto-regular') };
  });
  console.log('@font-face 注入:', res.notoFace ? '✓' : '✗');
  console.log('页内复刻 famRe.test:', JSON.stringify(res.famReProbeTest));
  console.log('shadow style 块分布:', JSON.stringify(res.styleCount));
  console.log('cssText 中 font-family 行:');
  for (const l of res.ffLines) console.log('  ', l);
  console.log('t1(Microsoft YaHei) computed:', res.replaced.t1);
  console.log('t2(SimSun) computed:', res.replaced.t2);
  console.log('t3(system-ui) computed:', res.replaced.t3);
  console.log('t4(Georgia, 非本地字体应保留) computed:', res.georgiaKept);
  const t1ok = res.replaced.t1 && res.replaced.t1.includes('Noto Sans SC');
  const t2ok = res.replaced.t2 && res.replaced.t2.includes('Noto Sans SC');
  const t3ok = res.replaced.t3 && res.replaced.t3.includes('Noto Sans SC');
  const t4ok = res.georgiaKept && !res.georgiaKept.includes('Noto Sans SC');
  const fontLoadOk = fontReqs.length > 0;
  console.log(t1ok && t2ok && t3ok ? '✓ 本地字体栈全部对齐为 Noto Sans SC' : '✗ 对齐缺失');
  console.log(t4ok ? '✓ 非本地字体(Georgia)保留' : '(t4 未测/替换)');
  console.log(fontLoadOk ? '✓ Noto woff2 已被客户端加载(' + fontReqs.join('; ') + ')' : '(字体未触发加载或 404: ' + JSON.stringify(fontReqs) + ')');
  await browser.close();
  process.exit(t1ok && t2ok && t3ok && t4ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', String(e).slice(0, 100)); process.exit(2); });
