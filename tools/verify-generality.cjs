'use strict';
// 通用性基准：六类业务形态在 dom 镜像下的等价性断言 + 带宽度量。
// 环境变量：CASE（forms|editor|media|layout|style|canvas）、MIRROR_URL、EVIDENCE_DIR。
// 断言走"服务端真实状态的黑盒出口"（fixture 把状态写进 DOM，经补丁回显）——
// 镜像本地显示 ≠ 服务端真实，只认回显。
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const CASE = process.env.CASE || 'forms';
const mirrorUrl = process.env.MIRROR_URL;
if (!mirrorUrl) throw new Error('Set MIRROR_URL');

// 页面侧助手（注入后所有 evaluate 回调只用 window.__q/__rep/__click/__setv）
const HELPERS = `window.__q = (s) => document.querySelector('#mirrorHost').shadowRoot.querySelector(s);
window.__qa = (s) => [...document.querySelector('#mirrorHost').shadowRoot.querySelectorAll(s)];
window.__rep = () => { const sr = document.querySelector('#mirrorHost').shadowRoot; for (const id of ['report','state','geo','keys','log']) { const el = sr.querySelector('#' + id); if (el) return el.textContent; } return ''; };
window.__setv = (s, v) => { const el = window.__q(s); if (!el) return false; const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); el.dispatchEvent(new Event('change', { bubbles: true, composed: true })); return true; };
window.__click = (s, dx, dy) => { const el = window.__q(s); if (!el) return false; const r = el.getBoundingClientRect(); const o = { bubbles: true, composed: true, cancelable: true, button: 0, isPrimary: true, pointerId: 7, clientX: r.left + (dx === undefined ? r.width / 2 : dx), clientY: r.top + (dy === undefined ? r.height / 2 : dy) }; el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', o)); return true; };`;

async function main() {
  const out = { case: CASE, pass: false, checks: {}, bytes: {} };
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      window.__bytes = {};
      window.__shiftPatches = 0; // v0.23 平移补丁计数（delHead/prepend 形态）
      const O = window.WebSocket;
      window.WebSocket = function (url, p) {
        const ws = p === undefined ? new O(url) : new O(url, p);
        ws.addEventListener('message', (ev) => {
          try {
            const j = JSON.parse(ev.data);
            window.__bytes[j.type] = (window.__bytes[j.type] || 0) + (ev.data.length || 0);
            if (j.type === 'dom-patches' && Array.isArray(j.patches)) {
              for (const x of j.patches) if (x.delHead !== undefined || x.prepend !== undefined) window.__shiftPatches++;
            }
          } catch {}
        });
        return ws;
      };
      window.WebSocket.prototype = O.prototype;
    });
    const t0 = Date.now();
    await page.goto(mirrorUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForFunction(() => {
      const b = document.querySelector('#mirrorHost') && document.querySelector('#mirrorHost').shadowRoot && document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
      return !!(b && b.innerHTML.length > 100);
    }, { timeout: 30000 }).catch(() => {});
    await page.evaluate(HELPERS);
    out.tti = Date.now() - t0;
    const rep = () => page.evaluate(() => window.__rep());
    const waitRep = (re, timeout = 10000) => page.waitForFunction((r) => new RegExp(r).test(window.__rep()), { timeout }, re).then(() => true).catch(() => false);
    const settle = (ms) => new Promise(r => setTimeout(r, ms));

    if (CASE === 'forms') {
      await page.waitForFunction(() => !!window.__q('#dump'), { timeout: 20000 });
      await page.evaluate(() => { window.__setv('#t1', 'hello镜像'); window.__setv('#n1', '42'); window.__setv('#d1', '2026-10-26'); window.__setv('#ta1', '多行文本'); });
      await page.evaluate(() => { window.__click('input[name=cb][value=a]'); window.__click('input[name=cb][value=c]'); window.__click('input[name=rd][value=y]'); });
      // select：真实路径是客户端原生下拉选择 → change 事件转发；这里设值+派发 change 等价走转发链
      await page.evaluate(() => { const s = window.__q('#s1'); const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value'); d.set.call(s, 'two'); s.dispatchEvent(new Event('change', { bubbles: true, composed: true })); });
      await settle(700);
      await page.evaluate(() => window.__click('#dump'));
      const ok = await waitRep('^STATE:', 8000);
      const txt = ok ? await rep() : 'TIMEOUT';
      const j = (() => { try { return JSON.parse(txt.slice(6)); } catch { return {}; } })();
      out.checks.text = j.t1 === 'hello镜像';
      out.checks.number = j.n1 === '42';
      out.checks.date = j.d1 === '2026-10-26';
      out.checks.textarea = j.ta1 === '多行文本';
      out.checks.checkbox = j.cb === 'a,c';
      out.checks.radio = j.rd === 'y';
      out.checks.select = j.s1 === 'two';
      out.state = txt.slice(0, 300);
      // 程序化改态（rrweb setter 劫持路径）：源站 JS 直改 checked/value/select
      await settle(500);
      await page.evaluate(() => window.__click('#prog'));
      await settle(1500);
      const pgm = await page.evaluate(() => ({
        cbB: window.__q('input[name=cb][value=b]').checked,
        rdX: window.__q('input[name=rd][value=x]').checked,
        rdY: window.__q('input[name=rd][value=y]').checked,
        s1: window.__q('#s1').value,
        t1: window.__q('#t1').value,
      }));
      out.checks.pgm_checked = pgm.cbB === true && pgm.rdX === true && pgm.rdY === false;
      out.checks.pgm_value = pgm.s1 === 'three' && pgm.t1 === 'pgm';
      out.pgm = pgm;
      // 多选 selected 程序化直改（option.selected setter 劫持路径）
      await page.evaluate(() => window.__click('#selmulti'));
      out.checks.pgm_multi = await page.waitForFunction(() => {
        const s2 = window.__q('#s2');
        return s2 && [...s2.selectedOptions].map(o => o.value).join(',') === 'm2,m3';
      }, { timeout: 8000 }).then(() => true).catch(() => false);
    }

    if (CASE === 'editor') {
      await page.waitForFunction(() => !!window.__q('#ce'), { timeout: 20000 });
      await page.evaluate(() => window.__click('#ce'));
      await page.keyboard.type('XY编辑', { delay: 30 });
      await settle(900);
      out.checks.ce_typing = await page.evaluate(() => /ce-input:[3-9]/.test(window.__q('#log').textContent));
      await page.evaluate(() => window.__click('#term'));
      const t0 = Date.now();
      await page.keyboard.type('ab', { delay: 30 });
      let keyRtt = null;
      await page.waitForFunction(() => /KEYS:a/.test(window.__q('#keys').textContent), { timeout: 8000, polling: 10 })
        .then(() => { keyRtt = Date.now() - t0; }).catch(() => {});
      out.perf.keyRttMs = keyRtt; // 键盘型应用首字符回显 RTT（10ms 轮询粒度）
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      await settle(600);
      out.checks.term_keys = await page.evaluate(() => /KEYS:ab\[ArrowLeft\]/.test(window.__q('#keys').textContent));
      // 程序化选区镜像：源站 addRange → 客户端高亮层落在 #para 附近
      await page.evaluate(() => window.__click('#selbtn'));
      out.checks.selection = await page.waitForFunction(() => {
        const sr = document.querySelector('#mirrorHost').shadowRoot;
        const layer = sr.querySelector('[data-xy-sel]');
        if (!layer || !layer.children.length) return false;
        const para = sr.querySelector('#para');
        if (!para) return false;
        const pr = para.getBoundingClientRect();
        const first = layer.children[0].getBoundingClientRect();
        return Math.abs(first.top - pr.top) < 60 && first.width > 4;
      }, { timeout: 8000 }).then(() => true).catch(() => false);
      // 追加流（v0.17 append 补丁）+ 首行文本原位修改（text 补丁）
      for (let i = 0; i < 3; i++) { await page.evaluate(() => window.__click('#feedbtn')); await settle(350); }
      out.checks.feed_append = await page.evaluate(() => {
        const rows = window.__qa('#feed .row');
        return rows.length === 3 && rows[2].textContent === 'line-3';
      });
      await page.evaluate(() => window.__click('#txtbtn'));
      await settle(900);
      out.checks.feed_text = await page.evaluate(() => {
        const r = window.__q('#feed .row');
        return r && r.textContent === 'line-edited';
      });
      out.seen = 'log=' + (await page.evaluate(() => window.__q('#log').textContent)) + ' keys=' + (await page.evaluate(() => window.__q('#keys').textContent));
    }

    if (CASE === 'media') {
      await page.waitForFunction(() => !!window.__q('#i1'), { timeout: 20000 });
      await settle(3200);
      const txt = await rep();
      out.report = txt.slice(0, 300);
      out.checks.src = /i1:pic-a\.png/.test(txt);
      out.checks.srcset = /i2:pic-b\.png/.test(txt);
      out.checks.picture = /i3:pic-c\.png/.test(txt);
      out.checks.poster = /poster:pic-a\.png/.test(txt);
      out.checks.image_set_bg = /bg:url\([^)]*m/.test(txt) || /pic-b/.test(txt);
      // 媒体状态同步（v0.17 dom-props.media）：播放/seek/暂停跟随（静音 WAV，两端 muted 自动播放允许）
      await page.evaluate(() => window.__click('#play'));
      await page.waitForFunction(() => {
        const a = window.__q('#a1');
        return a && !a.paused;
      }, { timeout: 8000 }).then(() => true).catch(() => false).then(v => { out.checks.media_play = v; });
      await page.evaluate(() => window.__click('#seek'));
      out.checks.media_seek = await page.waitForFunction(() => {
        const a = window.__q('#a1');
        return a && Math.abs(a.currentTime - 0.4) < 0.15;
      }, { timeout: 8000 }).then(() => true).catch(() => false);
      await page.evaluate(() => window.__click('#pause'));
      out.checks.media_pause = await page.waitForFunction(() => {
        const a = window.__q('#a1');
        return a && a.paused;
      }, { timeout: 8000 }).then(() => true).catch(() => false);
    }

    if (CASE === 'layout') {
      await page.waitForFunction(() => !!window.__q('#open'), { timeout: 20000 });
      await settle(900);
      out.checks.fixed_top = await page.evaluate(() => Math.round(window.__q('#fixedbar').getBoundingClientRect().top) === 0);
      const scrolled = await page.evaluate(() => { const el = window.__q('#inner'); el.scrollTop = 140; return el.scrollTop; });
      await settle(1400);
      const g1 = await rep();
      out.checks.inner_scroll = scrolled > 0 && /"innerScroll":1[0-9]{2}/.test(g1);
      await page.evaluate(() => window.__click('#open'));
      await settle(1000);
      out.checks.modal = await page.evaluate(() => /"overlayVisible":true/.test(window.__rep()));
      await page.evaluate(() => window.__click('#close'));
      await settle(900);
      await page.evaluate(() => window.__click('#dlgbtn'));
      await settle(1000);
      out.checks.dialog = await page.evaluate(() => /"dlgOpen":true/.test(window.__rep()));
      out.geo = [g1.slice(0, 220), (await rep()).slice(0, 220)];
    }

    if (CASE === 'style') {
      await page.waitForFunction(() => !!window.__q('#adopt'), { timeout: 20000 });
      await settle(2600);
      const init = await rep();
      out.checks.link_css = /"bg":"rgb\(240, 244, 250\)"/.test(init) && /"col":"rgb\(60, 64, 70\)"/.test(init);
      out.checks.import_css = /"impColor":"rgb\(180, 60, 30\)"/.test(init);
      await page.evaluate(() => window.__click('#adopt'));
      await settle(2600);
      out.checks.adopted_change = await page.evaluate(() => /"col":"rgb\(9, 96, 168\)"/.test(window.__rep()));
      await page.evaluate(() => window.__click('#link2'));
      await settle(3200);
      out.checks.late_link = await page.evaluate(() => /"border":"rgb\(30, 150, 90\)"/.test(window.__rep()));
      // v0.20：body 继承还原——镜像里的裸元素必须拿到源站 body 的 serif/深红
      // （此前继承客户端外壳的字体/主题色）
      out.checks.body_inherit = await page.evaluate(() => {
        const el = window.__q('#inh');
        if (!el) return false;
        const cs = getComputedStyle(el);
        return /Georgia/i.test(cs.fontFamily) && cs.color === 'rgb(150, 40, 40)';
      });
      out.reports = [init.slice(0, 200), (await rep()).slice(0, 200)];
    }

    if (CASE === 'canvas') {
      await page.waitForFunction(() => window.__qa('[data-xy-canvas-stream], [data-xy-canvas]').length >= 1, { timeout: 20000 });
      await settle(1100);
      // 点击第一个画布镜像（指令流 canvas 或位图兜底 img，几何同位）；服务端命中真实画布
      await page.evaluate(() => {
        const el = window.__qa('[data-xy-canvas-stream], [data-xy-canvas]')[0];
        if (!el) return;
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, composed: true, cancelable: true, button: 0, isPrimary: true, pointerId: 9, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        el.dispatchEvent(new PointerEvent('pointerdown', o));
        el.dispatchEvent(new PointerEvent('pointerup', o));
      });
      out.checks.canvas2d_report = await waitRep('c2d-drawn', 8000);
      out.checks.canvas2d_node = await page.evaluate(() => {
        const sr = document.querySelector('#mirrorHost').shadowRoot;
        return !!(sr.querySelector('[data-xy-canvas-stream]') || sr.querySelector('[data-xy-canvas]'));
      });
      out.checks.webgl_node = await page.evaluate(() => window.__qa('[data-xy-canvas-stream], [data-xy-canvas]').length >= 2);
      // WebGL 可见性门控：off 屏动画画布（top:-9999px）不产生捕获更新——
      // 其镜像 img 的 src 在 3s 观察窗内保持不变（on 屏画布正常位图通道）
      out.checks.webgl_offscreen_gated = await page.evaluate(async () => {
        const imgs = window.__qa('img[data-xy-canvas]');
        if (imgs.length < 3) return false;
        const srcs = imgs.map(im => im.src);
        await new Promise(r => setTimeout(r, 3000));
        const after = window.__qa('img[data-xy-canvas]').map(im => im.src);
        if (after.length !== srcs.length) return false;
        // 文档顺序：c2d(指令流canvas) cgl(静态) cgl-anim(动画) cgl-off(离屏)——最后一个是离屏
        return after[after.length - 1] === srcs[srcs.length - 1];
      });
      // v0.22：可见动画 WebGL 快档帧率——4s 窗口计镜像 img src 变化次数。
      // imgs 顺序 = [c2d(注入前位图), cgl(静态), cgl-anim(动画), cgl-off(离屏)]：
      // 动画位 ≥4 次/秒；两个静态位合计 ≤2（各自首次同步）；离屏位恒 0
      out.checks.webgl_anim_fps = await page.evaluate(async () => {
        const imgs = window.__qa('img[data-xy-canvas]');
        if (imgs.length < 4) return false;
        let anim = 0, stat = 0, off = 0;
        const mo = new MutationObserver((recs) => {
          for (const r of recs) {
            if (r.target === imgs[2]) anim++;
            else if (r.target === imgs[3]) off++;
            else stat++;
          }
        });
        for (const im of imgs) mo.observe(im, { attributes: true, attributeFilter: ['src'] });
        await new Promise(r => setTimeout(r, 4000));
        mo.disconnect();
        window.__xyWebglFps = { animUpdates: anim, staticUpdates: stat, offUpdates: off, perSec: +(anim / 4).toFixed(1) };
        return anim / 4 >= 4 && stat <= 2 && off === 0;
      });
      const fpsInfo = await page.evaluate(() => window.__xyWebglFps || null);
      if (fpsInfo) out.perf = Object.assign(out.perf || {}, { webglFps: fpsInfo });
      out.checks.table_rows = await page.evaluate(() => window.__qa('#bigtable tr').length >= 2000);
      await page.evaluate(() => window.__click('#bigtable td.hit'));
      out.checks.table_click = await waitRep('row:\\d+', 8000);
      await page.evaluate(() => window.__click('#keys'));
      await page.keyboard.type('k9');
      await page.keyboard.press('Enter');
      await settle(900);
      out.checks.term_keys = await page.evaluate(() => /keys:k9/.test(window.__rep()));
      out.report_final = (await rep()).slice(0, 160);
    }

    if (CASE === 'dnd') {
      await page.waitForFunction(() => !!window.__q('#item'), { timeout: 20000 });
      await settle(800);
      // HTML5 拖拽：镜像上合成 dragstart → dragover(dz) → drop(dz)，载荷 ITEM-A
      // 应在源站被读取并回显（drop:ITEM-A + 放置区文案）
      const dnd = await page.evaluate(() => {
        const sr = document.querySelector('#mirrorHost').shadowRoot;
        const item = sr.querySelector('#item');
        const dz = sr.querySelector('#dz');
        if (!item || !dz) return false;
        const ir = item.getBoundingClientRect();
        const dr = dz.getBoundingClientRect();
        const dt = new DataTransfer();
        dt.setData('text/plain', 'ITEM-A');
        const mk = (type, el, x, y, d2) => {
          const ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: d2 || dt });
          el.dispatchEvent(ev);
          return ev;
        };
        mk('dragstart', item, ir.left + 10, ir.top + 10);
        mk('dragover', dz, dr.left + 30, dr.top + 20);
        mk('drop', dz, dr.left + 30, dr.top + 20);
        mk('dragend', item, ir.left + 10, ir.top + 10);
        return true;
      });
      out.checks.dnd_drop = dnd && await waitRep('drop:ITEM-A', 9000);
      // 触摸：合成 touchstart（真实移动端访客产生原生事件，此处合成验证链路）
      await page.evaluate(() => {
        const tp = window.__q('#tpad');
        const r = tp.getBoundingClientRect();
        const t = new Touch({ identifier: 1, target: tp, clientX: r.left + 20, clientY: r.top + 10 });
        tp.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, composed: true, touches: [t], targetTouches: [t], changedTouches: [t] }));
      });
      out.checks.touch = await waitRep('touch:', 8000);
      // 程序化焦点：源站 focus() → 镜像光标跟随（focus-sync）
      await page.evaluate(() => window.__click('#fbtn'));
      out.checks.focus_sync = await page.waitForFunction(() => {
        const sr = document.querySelector('#mirrorHost').shadowRoot;
        const ae = sr.activeElement;
        return !!(ae && (ae.id === 't1'));
      }, { timeout: 8000 }).then(() => true).catch(() => false);
      // 分歧自愈：删除 3 个镜像节点制造漂移 → 服务端指纹两拍内自动全量重同步
      await page.evaluate(() => { for (const id of ['#dz', '#tpad', '#fbtn']) { const el = window.__q(id); if (el) el.remove(); } });
      out.checks.self_heal = await page.waitForFunction(() => !!window.__q('#dz') && !!window.__q('#fbtn'), { timeout: 15000 }).then(() => true).catch(() => false);
      out.dnd_final = (await rep()).slice(0, 120);
    }

    if (CASE === 'vlist') {
      await page.waitForFunction(() => !!window.__q('#vwrap'), { timeout: 20000 });
      await settle(1200);
      const initial = await rep();
      out.initial = initial.slice(0, 80);
      // 镜像滚动内层容器 → 服务端跟随换窗 → 补丁回传；计每滚一笔的补丁字节
      const bytesBefore = await page.evaluate(() => (window.__bytes['dom-patches'] || 0));
      const scrollBy = async (px) => {
        await page.evaluate((v) => { const el = window.__q('#vwrap'); el.scrollTop += v; }, px);
        await settle(1400);
      };
      await scrollBy(29 * 12);
      const b1 = await page.evaluate(() => (window.__bytes['dom-patches'] || 0)) - bytesBefore;
      await scrollBy(29 * 25);
      const b2 = await page.evaluate(() => (window.__bytes['dom-patches'] || 0)) - bytesBefore - b1;
      out.perf = Object.assign(out.perf || {}, { vlistPatchBytesScroll1: b1, vlistPatchBytesScroll2: b2 });
      out.vlist_final = (await rep()).slice(0, 80);
      // 功能断言：服务端真实换窗（updates ≥10 且 first 前移两位数）且窗口行数恒定
      out.checks.vlist_updates = await page.evaluate(() => /^REPORT:first=\d{2,};updates=\d{2,}/.test(window.__rep()));
      out.checks.vlist_rows = await page.evaluate(() => window.__qa('#vwin .vrow').length === 20);
      // v0.23 平移 diff：机制断言（负载无关）——慢滚期间必须收到 ≥1 条
      // delHead/prepend 平移补丁；字节数记录不断言（慢 runner 量级漂移大）
      const before2 = await page.evaluate(() => (window.__bytes['dom-patches'] || 0));
      const shifts0 = await page.evaluate(() => window.__shiftPatches);
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => { const el = window.__q('#vwrap'); el.scrollTop += 29; });
        await settle(500);
      }
      await settle(1200);
      const perStep = ((await page.evaluate(() => (window.__bytes['dom-patches'] || 0))) - before2) / 10;
      const shifts = (await page.evaluate(() => window.__shiftPatches)) - shifts0;
      out.perf = Object.assign(out.perf || {}, { vlistSlowPerStepBytes: +perStep.toFixed(0), vlistShiftPatches: shifts });
      out.checks.vlist_shiftdiff = shifts >= 1;
    }

    out.bytes = await page.evaluate(() => window.__bytes).catch(() => ({}));
    // 流畅度/延迟基线（不参与 pass 判定）：主线程帧时间 p95 + 键盘型应用回显 RTT
    try {
      const frames = await page.evaluate(async () => {
        // 帧时间采样 1.2s
        const ft = [];
        await new Promise((res) => {
          let n = 0;
          const loop = (t0) => {
            if (n++ > 0) ft.push(performance.now() - t0);
            if (ft.length >= 70) { res(); return; }
            requestAnimationFrame(loop);
          };
          requestAnimationFrame(loop);
        });
        ft.sort((a, b) => a - b);
        return { frameP50: +ft[Math.floor(ft.length * 0.5)].toFixed(1), frameP95: +ft[Math.floor(ft.length * 0.95)].toFixed(1) };
      });
      out.perf = Object.assign(out.perf || {}, frames);
    } catch (e) { out.perf = Object.assign(out.perf || {}, { err: String(e).slice(0, 80) }); }
    await page.close();
  } catch (e) {
    out.error = e.message;
  } finally {
    await browser.close();
  }
  out.pass = !!(out.checks && Object.keys(out.checks).length && Object.values(out.checks).every(Boolean));
  const evd = process.env.EVIDENCE_DIR;
  if (evd) {
    fs.mkdirSync(evd, { recursive: true });
    fs.writeFileSync(path.join(evd, 'result-' + CASE + '.json'), JSON.stringify(out, null, 2));
  }
  console.log(JSON.stringify(out));
  if (!out.pass) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
