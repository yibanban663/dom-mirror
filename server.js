'use strict';
/**
 * dom-mirror RBI PoC 服务端 v2 —— 编码演进对比版
 *
 * 三种模式（客户端可运行时切换）：
 *  - jpeg : CDP screencast JPEG 直发（基线）
 *  - webp : CDP screencast WebP 直发（同画质省 30-40%，视 Chromium 支持而定）
 *  - h264 : screencast JPEG → ffmpeg image2pipe → libx264(ultrafast/zerolatency)
 *           → Annex-B over WS → 客户端 WebCodecs 解码（帧间压缩，主攻带宽）
 *
 * 链路：客户端浏览器 <--WS--> 本服务 --CDP--> 无头Chromium --HTTP--> 受保护源站(仅回环)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const puppeteer = require('puppeteer');

const DEMO_PORT = parseInt(process.env.DEMO_PORT || '8088', 10);
const ORIGIN_PORT = parseInt(process.env.ORIGIN_PORT || '8077', 10);
const VIEW_W = parseInt(process.env.VIEW_W || '1280', 10);
const VIEW_H = parseInt(process.env.VIEW_H || '800', 10);
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '3', 10);
const ORIGIN_URL = process.env.ORIGIN_URL || `http://127.0.0.1:${ORIGIN_PORT}/`;
const ORIGIN_BASE = new URL(ORIGIN_URL);
const DEFAULT_MODE = ['jpeg', 'webp', 'h264', 'dom'].includes(process.env.DEFAULT_MODE) ? process.env.DEFAULT_MODE : 'jpeg';
const FRAME_MIN_INTERVAL = parseInt(process.env.FRAME_MIN_INTERVAL || '33', 10); // 30fps 上限
const H264_ARGS = [
  '-hide_banner', '-loglevel', 'error',
  // 关键：稀疏帧输入下跳过长探测，首帧即出流（默认要攒 150 帧才开始编码）
  '-analyzeduration', '0', '-probesize', '1M',
  '-f', 'image2pipe', '-c:v', 'mjpeg', '-r', '30', '-i', 'pipe:0',
  '-vf', `scale=${VIEW_W}:${VIEW_H}`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
  '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p',
  '-x264-params', 'keyint=30:min-keyint=30:scenecut=0:repeat-headers=1',
  '-b:v', '700k', '-maxrate', '1200k', '-bufsize', '200k',
  '-f', 'h264', 'pipe:1',
];
const CHROME_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  '--force-color-profile=srgb', '--font-render-hinting=none',
];

// ---------- DOM 镜像：注入到受保护页面的辅助函数 ----------
// 序列化 = 剥离 script/事件属性 + canvas→位图兜底 + 静态资源 URL 重写(/m 代理) ；路径 = 基于 body 的 childNodes 索引
// 源站字体同源注入：残差根因（实测）——源站文字走 fontconfig 系统字体路径，镜像走 webfont 路径，
// 两者的 FreeType 渲染参数不同 → 文字区残差 ~1/255。给源站页面注入与镜像同一份 @font-face
// （webfont 路径）后三条渲染链同源：同引擎下文字残差 → 0（实测表格区逐位相同，整页 0.7→0.009）。
const FONT_FAMS = ['Noto Sans CJK SC', 'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Microsoft YaHei UI', '微软雅黑'];
function originFontCssFor() {
  const base = `http://127.0.0.1:${DEMO_PORT}`;
  const face = (fam, w, u) => `@font-face{font-family:'${fam}';src:url(${base}${u}) format('woff2');font-weight:${w};font-display:block;}`;
  return FONT_FAMS.map(f => face(f, 400, '/f/noto-regular') + face(f, 700, '/f/noto-bold')).join('');
}
const PAGE_HELPERS = `(() => {
  if (window.__xy) return;
  const ORIGIN_PREFIX = ${JSON.stringify(ORIGIN_BASE.origin)};
  function fixUrl(v) {
    if (!v || /^(data:|blob:|#|mailto:|tel:|javascript:|about:)/i.test(v)) return v;
    if (v.startsWith('//')) return v;
    if (v.startsWith('/')) return '/m' + v;
    if (v.startsWith(ORIGIN_PREFIX)) return '/m' + v.slice(ORIGIN_PREFIX.length);
    return v;
  }
  function sanitizeClone(root) {
    const clone = root.cloneNode(true);
    const strip = (el) => {
      for (const a of [...el.attributes]) {
        if (/^on/i.test(a.name) || a.name === 'srcdoc' || a.name === 'formaction') { el.removeAttribute(a.name); continue; }
        if (a.name === 'href' || a.name === 'src' || a.name === 'action' || a.name === 'poster' || a.name === 'srcset') {
          try { el.setAttribute(a.name, fixUrl(a.value)); } catch (e) {}
        }
      }
    };
    if (clone.querySelectorAll) {
      clone.querySelectorAll('script,noscript,template').forEach(n => n.remove());
      clone.querySelectorAll('*').forEach(strip);
    }
    if (clone.nodeType === 1) strip(clone);
    const liveCanvases = root.nodeType === 1 && root.querySelectorAll ? (root.tagName === 'CANVAS' ? [root] : [...root.querySelectorAll('canvas')]) : [];
    const cloneCanvases = clone.querySelectorAll ? [...clone.querySelectorAll('canvas')] : [];
    cloneCanvases.forEach((c, i) => {
      try {
        const img = document.createElement('img');
        img.src = liveCanvases[i].toDataURL('image/png');
        img.setAttribute('data-xy-canvas', '1');
        // 关键：源站样式表里的 canvas 选择器（如 canvas{display:block}）在镜像中匹配不到 img，
        // 不内联保留原盒子的 display/宽高，inline img 的基线空隙会让后续内容整体偏移（实测 +5px）
        const cs = getComputedStyle(liveCanvases[i]);
        img.style.cssText = 'display:' + cs.display + ';width:' + cs.width + ';height:' + cs.height;
        c.replaceWith(img);
      } catch (e) {}
    });
    return clone;
  }
  function pathOf(node) {
    const parts = [];
    let n = node;
    while (n && n !== document.body) {
      const p = n.parentNode;
      if (!p) return null;
      parts.unshift([...p.childNodes].indexOf(n));
      n = p;
    }
    return n === document.body ? parts.join('/') : null;
  }
  window.__xy = {
    sanitizeClone, pathOf,
    find(path) {
      if (path === '') return document.body;
      let n = document.body;
      for (const i of path.split('/')) { n = n.childNodes[+i]; if (!n) return null; }
      return n;
    },
    async snapshot() {
      const styleCss = [...document.querySelectorAll('style')].map(s => s.textContent).join('\\n');
      const hrefs = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href')).filter(Boolean);
      let linkCss = '';
      try {
        const texts = await Promise.all(hrefs.map(h => fetch(h).then(r => r.ok ? r.text() : '').catch(() => '')));
        linkCss = texts.join('\\n');
      } catch (e) {}
      return {
        css: styleCss + '\\n' + linkCss,
        html: sanitizeClone(document.body).innerHTML,
        title: document.title,
      };
    },
    // 像素瓦片化快照：所有可见文字/画布/下拉框外观 = 服务端按访客 DPR 渲染的原始像素，
    // 客户端 1:1 显示（PNG 无损）→ 构造性 100% 一致；DOM 中零文字明文。布局由等大占位保持。
    async snapshotTiles(sheetB64) {
      const DPR = window.__xyDpr || 1;
      window.__xyBusy = true;
      // 占位替换会把 input/textarea 移出再放回 DOM——自动聚焦的输入框因此失焦，
      // 光标闪烁等"活动感"全部消失（页面看起来被冻住）。快照后恢复焦点与光标位。
      const focusSave = document.activeElement;
      let selS = null, selE = null;
      try {
        if (focusSave && (focusSave.tagName === 'INPUT' || focusSave.tagName === 'TEXTAREA')) {
          selS = focusSave.selectionStart; selE = focusSave.selectionEnd;
        }
      } catch (e) {}
      const img = new Image();
      img.src = 'data:image/png;base64,' + sheetB64;
      await img.decode();
      const sheet = document.createElement('canvas');
      sheet.width = img.width; sheet.height = img.height;
      sheet.getContext('2d').drawImage(img, 0, 0);
      const skipTags = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'STYLE']);
      const jobs = [];
      // 收集：文本节点 + SELECT（原生控件外观走瓦片，选项文字全部不出站）
      const walk = (node, path) => {
        let idx = 0;
        for (const ch of node.childNodes) {
          if (ch.nodeType === 1 && skipTags.has(ch.tagName)) { idx++; continue; }
          const p = path === '' ? String(idx) : path + '/' + idx;
          if (ch.nodeType === 3) { if (ch.textContent.trim()) jobs.push({ kind: 'text', node: ch, path: p }); }
          else if (ch.nodeType === 1) {
            if (ch.tagName === 'SELECT') { jobs.push({ kind: 'select', node: ch, path: p }); }
            else if (ch.tagName === 'INPUT' || ch.tagName === 'TEXTAREA') { jobs.push({ kind: 'input', node: ch, path: p }); }
            else if (ch.tagName === 'CANVAS') { jobs.push({ kind: 'canvas', node: ch, path: p }); }
            else walk(ch, p);
          }
          idx++;
        }
      };
      walk(document.body, '');
      const done = new Set();
      // ① live 就地替换为等大占位（布局零扰动）
      // 注意：文本节点没有 getBoundingClientRect，必须用 Range 的 client rects
      // 行盒高度实测缓存：line-height:normal 的实际行高取决于字体度量（服务端 Noto CJK
      // vs 访客端回退字体），不固化的话镜像行堆叠与服务端累计偏差 1-4px（实测按钮矮 4px）。
      // 测法：把父元素 line-height 在 0/normal 间切换，高度差 = 单行行盒高。
      const lhCache = new Map();
      const usedLineHeight = (par) => {
        if (!par || lhCache.has(par)) return lhCache.get(par) || 0;
        let lh = 0;
        try {
          const clh = getComputedStyle(par).lineHeight;
          if (clh !== 'normal') { const v = parseFloat(clh); lh = isFinite(v) ? v : 0; }
          else {
            // 零宽探针：font:inherit 的 inline-block，其盒高 = 自身行盒 = 所继承字体
            // 的 normal 实际行高。不切换父元素 line-height（会被兄弟元素高度污染，
            // 实测带 beacon 圆点的历史条目测出行高=9px 而非 18.4px），也不扰动布局。
            const probe = document.createElement('span');
            probe.style.cssText = 'font:inherit;line-height:normal;display:inline-block;width:0;overflow:hidden';
            probe.textContent = '国';
            par.appendChild(probe);
            lh = Math.max(0, Math.round(probe.getBoundingClientRect().height * 100) / 100);
            probe.remove();
          }
        } catch (e) {}
        lhCache.set(par, lh);
        return lh;
      };
      for (const j of jobs) {
        try {
          if (j.kind === 'text') {
            const rng = document.createRange();
            rng.selectNodeContents(j.node);
            const rects = [...rng.getClientRects()];
            if (!rects.length) continue;
            j.x = Math.min(...rects.map(q => q.left)) + window.scrollX;
            j.y = Math.min(...rects.map(q => q.top)) + window.scrollY;
            j.w = Math.max(...rects.map(q => q.right)) - Math.min(...rects.map(q => q.left));
            j.h = Math.max(...rects.map(q => q.bottom)) - Math.min(...rects.map(q => q.top));
            j.lines = rects.length; // 行数：spacer 高度 = 行数 × 行盒高（含行距），墨迹高不含行距
          } else {
            const r = j.node.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            j.x = r.left + window.scrollX; j.y = r.top + window.scrollY;
            j.w = r.width; j.h = r.height;
          }
          if (j.kind === 'input' && !j.node.value && !j.node.placeholder) { continue; }
          if (j.w <= 0 || j.h <= 0) continue;
          done.add(j);
          // 注意：live 页只做等大占位（text/canvas/input）；select 绝不动 live——
          // （透明化/清空选项只发生在 clone；曾把 live select 永久清空，导致第二次快照起底板里下拉框标签消失）
          if (j.kind !== 'select') {
            const sp = document.createElement('span');
            const par = j.node.parentElement;
            const lh = usedLineHeight(par);
            if (par) { try { j.parLh = getComputedStyle(par).lineHeight; } catch (e) {} }
            j.lhPin = (j.parLh === 'normal' && lh > 0) ? lh : 0;
            // 高度优先用 行数×行盒高（与服务端行堆叠一致）；测不到时退回墨迹高
            const sh = (lh > 0 && j.lines > 0) ? Math.round(j.lines * lh * 100) / 100 : j.h;
            j.sh = sh;
            sp.style.cssText = 'display:inline-block;vertical-align:top;width:' + j.w + 'px;height:' + sh + 'px';
            sp.setAttribute('data-xy-space', '1');
            j.node.replaceWith(sp);
            j.sp = sp;
          }
        } catch (e) {}
      }
      // ② 等布局稳定 → 实测偏差归位 → 从 DPR 底板裁瓦片 → 还原 live
      await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame(r2)));
      for (const j of jobs) {
        if (!done.has(j)) continue;
        try {
          if (j.sp) {
            const q = j.sp.getBoundingClientRect();
            const dx = j.x - window.scrollX - q.left;
            const dy = j.y - window.scrollY - q.top;
            if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) { j.sp.style.position = 'relative'; j.sp.style.left = dx + 'px'; j.sp.style.top = dy + 'px'; }
            j.spHtml = j.sp.outerHTML;
          }
          if (j.x >= 0 && j.y >= 0 && j.x + j.w <= sheet.width / DPR + 1 && j.y + j.h <= sheet.height / DPR + 1) {
            const sx = Math.round(j.x * DPR), sy = Math.round(j.y * DPR);
            const sw = Math.max(1, Math.round(j.w * DPR)), sh = Math.max(1, Math.round(j.h * DPR));
            const c2 = document.createElement('canvas');
            c2.width = sw; c2.height = sh;
            c2.getContext('2d').drawImage(sheet, sx, sy, sw, sh, 0, 0, sw, sh);
            // 设备像素精确的 CSS 坐标：round(devicePx)/DPR → 瓦片在访客端 1:1 落位，零重采样
            j.tile = { w: sw, h: sh, cssX: sx / DPR, cssY: sy / DPR, cssW: sw / DPR, cssH: sh / DPR, url: c2.toDataURL('image/png') };
          }
        } catch (e) {}
        try { if (j.sp) j.sp.replaceWith(j.node); } catch (e) {}
      }
      const clone = sanitizeClone(document.body);
      // ③ clone 同路径替换：文本→瓦片 img；select→透明控件+背景瓦片；未覆盖文本剥除（零明文）
      const findInClone = (path) => {
        const parts = path.split('/');
        let cn = clone;
        for (const i of parts) { cn = cn.childNodes ? cn.childNodes[+i] : null; if (!cn) return null; }
        return cn;
      };
      const tiles = [];
      for (const j of jobs) {
        if (!done.has(j)) continue;
        if (j.tile) tiles.push(j.tile);
        if (j.kind !== 'select' || !j.tile) continue;
        try {
          const t = findInClone(j.path);
          if (!t) continue;
          t.style.appearance = 'none';
          t.style.color = 'transparent';
          t.style.background = 'transparent none';
          t.style.backgroundImage = 'url("' + j.tile.url + '")';
          t.style.backgroundSize = '100% 100%';
          t.style.backgroundRepeat = 'no-repeat';
          for (const op of t.querySelectorAll('option')) op.textContent = '';
        } catch (e) {}
      }
      // 输入类属性剥离：placeholder/value 默认值/隐藏域/alt/title 均属静态明文（视觉已由瓦片承载）
      try {
        clone.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(el => el.removeAttribute('placeholder'));
        clone.querySelectorAll('input[type="hidden"]').forEach(el => el.remove());
        clone.querySelectorAll('input:not([type="checkbox"]):not([type="radio"])').forEach(el => el.removeAttribute('value'));
        clone.querySelectorAll('[alt]').forEach(el => el.removeAttribute('alt'));
        clone.querySelectorAll('[title]').forEach(el => el.removeAttribute('title'));
      } catch (e) {}
      // canvas 的 clone img → 透明占位（真像素走图层瓦片）
      for (const j of jobs) {
        if (j.kind !== 'canvas' || !j.tile) continue;
        try {
          const t = findInClone(j.path);
          if (!t || t.tagName !== 'IMG') continue;
          t.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        } catch (e) {}
      }
      for (const j of jobs) {
        if (j.kind !== 'input' || !j.tile) continue;
        try {
          const t = findInClone(j.path);
          if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) continue;
          t.style.backgroundImage = 'url("' + j.tile.url + '")';
          // 设备像素精确尺寸：100% 拉伸会按元素分数尺寸重采样整块文字瓦片
          t.style.backgroundSize = j.tile.cssW + 'px ' + j.tile.cssH + 'px';
          t.style.backgroundPosition = '0 0';
          t.style.backgroundRepeat = 'no-repeat';
          t.setAttribute('data-xy-inp', '1');
        } catch (e) {}
      }
      // 占位 span 写回 clone（保持行盒/布局）；文本节点保持空（零明文）
      for (const j of jobs) {
        if (j.kind !== 'text' || !j.sp) continue;
        try {
          const t = findInClone(j.path);
          if (!t || t.nodeType !== 3) continue;
          const par = t.parentNode; // replaceChild 之后 t.parentNode 变 null，必须先取
          const tpl = document.createElement('template');
          tpl.innerHTML = j.spHtml;
          par.replaceChild(tpl.content.firstChild, t);
          // 行高 strut 中和：line-height:normal 的容器行盒高度依赖字体度量
          // （服务端 Noto CJK vs 访客端本地回退字体）。固化为服务端实测行盒高，
          // 镜像行堆叠与源站一致、与访客字体无关。spacer 自身已按 行数×行盒高 撑起。
          if (j.parLh === 'normal' && par && par.style && j.lhPin) {
            par.style.lineHeight = j.lhPin + 'px';
          }
        } catch (e) {}
      }
      // ④ 兜底剥除：任何未被瓦片覆盖的可见文本一律清空（零明文保证）
      const stripAll = (node) => {
        for (const ch of [...node.childNodes]) {
          if (ch.nodeType === 3) { if (ch.textContent.trim()) ch.textContent = ''; }
          else if (ch.nodeType === 1 && !skipTags.has(ch.tagName)) stripAll(ch);
        }
      };
      stripAll(clone);
      window.__xyBusy = false;
      const styleCss = [...document.querySelectorAll('style')].map(s2 => s2.textContent).join('\\n');
      const hrefs = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href')).filter(Boolean);
      let linkCss = '';
      try {
        const texts = await Promise.all(hrefs.map(h => fetch(h).then(r => r.ok ? r.text() : '').catch(() => '')));
        linkCss = texts.join('\\n');
      } catch (e) {}
      // 恢复快照前的焦点（占位替换导致失焦 → 光标闪烁消失）
      try {
        if (focusSave && focusSave.isConnected && document.activeElement !== focusSave &&
            (focusSave.tagName === 'INPUT' || focusSave.tagName === 'TEXTAREA')) {
          focusSave.focus();
          if (selS !== null) { try { focusSave.setSelectionRange(selS, selE); } catch (e2) {} }
        }
      } catch (e) {}
      // html/body 的类与属性决定主题（如 data-theme/class 切换亮暗色变量）——
      // 镜像根 .xy-body 必须原样携带，否则复合选择器 html[data-theme=...] 全部失配
      let docClass = '', docAttrs = '';
      for (const root of [document.documentElement, document.body]) {
        if (!root) continue;
        for (const a of root.attributes || []) {
          if (/^on/i.test(a.name) || a.name === 'style' || a.name === 'id') continue;
          if (a.name === 'class') { docClass += ' ' + a.value; continue; }
          docAttrs += ' ' + a.name + '="' + String(a.value).replace(/"/g, '&quot;') + '"';
        }
      }
      return { css: styleCss + '\\n' + linkCss, html: clone.innerHTML, title: document.title, tiles, docClass: docClass.trim(), docAttrs: docAttrs.trim() };
    },
    rectOf(path) {
      const el = window.__xy.find(path);
      if (!el || !el.getBoundingClientRect) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
    },
    // Skia 文字引擎：文本不出现在镜像 DOM（占位符撑布局），文字以"引擎绘制指令"
    // （runs: 文本/坐标/字号/颜色）下发，客户端 CanvasKit(Skia-WASM) 本地任意 DPR 清晰绘制。
    // 零截图：服务端只做 DOM 测量，资源开销与纯 DOM 镜像同级。
    patchOf(record) {
      // 补丁模型：childList/characterData → 目标元素 innerHTML 重发；attributes → 元素 outerHTML 重发
      let target = record.target;
      if (target.nodeType === 3) target = target.parentElement;
      if (!target || target === document.documentElement) return { full: true, why: record.type + ':docEl:' + (record.attributeName || '') + ':' + (target && target.nodeName) };
      // 快照占位符(data-xy-space)自身的任何变更（含位置校正的 style 属性）都不是业务变更。
      // 实测：②相位给 spacer 写 style 时它还在树上，flush 时已被还原离树——
      // attributes 记录绕过了下面的 childList spacer 过滤，被当成 noPath→full→重同步→
      // 新一轮占位替换又产生同类记录 → 每 tick 自触发全量重同步的死循环（resync 风暴）。
      const isSpacerEl = (n) => n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-xy-space');
      if (isSpacerEl(target)) return null;
      // 已离树的目标无补丁意义（真实的节点增删走父容器 childList 记录，不会丢）
      if (!target.isConnected) return null;
      // 快照自身的占位替换/还原不是业务变更：跳过。否则会用父容器矩形重裁瓦片，
      // 覆盖掉刚下发快照里的正确瓦片（实测 KPI 增量被 88px 裁成 243px、图表面板被重裁覆盖）
      if (record.type === 'childList') {
        const rel = [...(record.addedNodes || []), ...(record.removedNodes || [])];
        const isSpacer = (n) => n && n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-xy-space');
        // 占位替换(text↔span)与还原(span↔原节点)两侧都可能出现 spacer，命中即跳过；
        // 业务真实变更绝不会包含 spacer 节点
        if (rel.length && rel.some(isSpacer)) return null;
      }
      const path = pathOf(target);
      if (path === null) return { full: true, why: record.type + ':noPath:' + target.nodeName + (target.isConnected ? '' : ':DETACHED') };
      if (record.type === 'attributes') return { path, outer: sanitizeClone(target).outerHTML };
      return { path, inner: sanitizeClone(target).innerHTML };
    },
    // 动画/悬停跟随：当前视口底板与上一帧做网格差分，仅变化区域重裁瓦片。
    // CSS 动画、JS 特效、canvas 重绘、视频、:hover 反馈——任何像素变化通用覆盖，
    // 无变化时零下发。瓦片为底板不透明裁片，含新旧位置（位移动画旧影自动覆盖）。
    async diffTiles(b64, dpr) {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const W = img.width, H = img.height;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const cur = ctx.getImageData(0, 0, W, H).data;
      // 参考帧 = 客户端当前持有的画面（而非上一 tick）：慢速辉光每 tick 只漂移约 1 个
      // 灰度级，逐帧比对会被噪声阈值吃掉。与参考帧比对让慢变化累积过阈后才发送，
      // 发送后参考帧前移。PNG 截图渲染确定性 → 静止页逐字节一致，低阈值不误报。
      const ref = window.__xyDiffRef;
      if (!ref || ref.length !== cur.length) { window.__xyDiffRef = cur; return { tiles: [] }; }
      const CELL = Math.max(12, Math.round(20 * dpr));
      const cols = Math.ceil(W / CELL), rows = Math.ceil(H / CELL);
      const cells = new Uint8Array(cols * rows);
      const TH = 4;
      for (let y = 0; y < H; y += 2) {
        const ri = (y / CELL) | 0;
        for (let x = 0; x < W; x += 2) {
          const ci = (x / CELL) | 0;
          if (cells[ri * cols + ci]) continue;
          const p = (y * W + x) * 4;
          if (Math.abs(cur[p] - ref[p]) > TH || Math.abs(cur[p + 1] - ref[p + 1]) > TH || Math.abs(cur[p + 2] - ref[p + 2]) > TH) cells[ri * cols + ci] = 1;
        }
      }
      const rects = [];
      for (let r = 0; r < rows; r++) {
        let c = 0;
        while (c < cols) {
          if (!cells[r * cols + c]) { c++; continue; }
          let c2 = c;
          while (c2 + 1 < cols && cells[r * cols + c2 + 1]) c2++;
          let merged = false;
          for (const rc of rects) {
            if (rc.r1 === r - 1 && c <= rc.c1 + 1 && c2 >= rc.c0 - 1) {
              rc.c0 = Math.min(rc.c0, c); rc.c1 = Math.max(rc.c1, c2); rc.r1 = r; merged = true; break;
            }
          }
          if (!merged) rects.push({ c0: c, c1: c2, r0: r, r1: r });
          c = c2 + 1;
        }
      }
      // 全屏级变化（翻页/滚动）交给补丁与全量快照，不进差分通道
      if (rects.length > 40) { window.__xyDiffRef = cur; return { tiles: [] }; }
      const tiles = [];
      for (const rc of rects) {
        const sx = rc.c0 * CELL, sy = rc.r0 * CELL;
        const sw = Math.min(W - sx, (rc.c1 - rc.c0 + 1) * CELL), sh = Math.min(H - sy, (rc.r1 - rc.r0 + 1) * CELL);
        if (sw < 2 || sh < 2) continue;
        const c2c = document.createElement('canvas');
        c2c.width = sw; c2c.height = sh;
        c2c.getContext('2d').drawImage(cv, sx, sy, sw, sh, 0, 0, sw, sh);
        tiles.push({ w: sw, h: sh, cssX: sx / dpr, cssY: sy / dpr, cssW: sw / dpr, cssH: sh / dpr, url: c2c.toDataURL('image/png') });
      }
      if (tiles.length) window.__xyDiffRef = cur;
      return { tiles };
    },
  };
})();`;

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
};
// 发送静态文件：按 Accept-Encoding 协商 gzip（引擎 wasm/字体/JS 体积大头，实测 wasm 7MB→2.5MB），
// 压缩结果按路径缓存（容器内文件不可变）；图片本身已压缩不再 gzip
const gzCache = new Map();
function sendFile(req, res, file, ctype, cacheCtl) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const accept = req.headers['accept-encoding'] || '';
    const canGz = accept.includes('gzip') && buf.length > 1024 && !/image\/(png|jpeg|webp)|font\/woff2/.test(ctype);
    let entry = gzCache.get(file);
    if (!entry) { entry = {}; gzCache.set(file, entry); }
    let out = buf, enc;
    if (canGz) {
      if (!entry.gz || entry.rawLen !== buf.length) { entry.rawLen = buf.length; entry.gz = zlib.gzipSync(buf, { level: 6 }); }
      out = entry.gz; enc = 'gzip';
    }
    const h = { 'Content-Type': ctype, 'Cache-Control': cacheCtl, 'Content-Length': out.length };
    if (enc) h['Content-Encoding'] = enc;
    res.writeHead(200, h);
    res.end(out);
  });
}
function staticHandler(root) {
  return (req, res) => {
    let p;
    try { p = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch { res.writeHead(400); res.end('bad url'); return; }
    if (p === '/') p = '/index.html';
    const file = path.join(root, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    sendFile(req, res, file, MIME[path.extname(file)] || 'application/octet-stream',
      p === '/index.html' ? 'no-store' : 'public, max-age=3600');
  };
}

// ---------- Chromium：每会话独立实例 ----------
// 共享单例下多标签并发截图会间歇产出错位/幽灵瓦片（像素级实测：瓦片内容与坐标
// 张冠李戴）。独立实例彻底隔离，8 会话上限下内存可承受。
async function launchSessionBrowser() {
  const b = await puppeteer.launch({
    headless: true,
    args: CHROME_ARGS,
    defaultViewport: { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1 },
  });
  b.on('disconnected', () => console.log('[chrome] session browser disconnected'));
  console.log('[chrome] per-session launched:', await b.version());
  return b;
}

const KEYMAP = {
  Backspace: 8, Enter: 13, Tab: 9, Escape: 27, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35,
};

// ---------- HTTP + WS ----------
// /m/* —— 镜像静态资源代理（CSS/字体/图片回源拉取，仅表现层资源，无数据）
const httpOrigin = ORIGIN_BASE.protocol === 'https:' ? require('https') : require('http');
const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|css|woff2?|ttf|otf|eot|mp4|webm)$/i;
function proxyAsset(req, res) {
  // 白名单：只代理表现层静态资源（CSS url() 引用的图片/字体等）。
  // 不加白名单时 GET /m/ 可直接拉到源站整页明文（含页面内密钥）——击穿"数据不出站"
  let u;
  try { u = new URL(req.url.slice(2), ORIGIN_BASE); } catch { res.writeHead(400); res.end(); return; }
  if (!u.pathname || !ASSET_RE.test(u.pathname)) { res.writeHead(403); res.end('asset allowlist'); return; }
  const upstream = httpOrigin.get(u, { headers: { 'user-agent': 'rbi-mirror-asset', accept: req.headers.accept || '*/*' } }, (up) => {
    const ct = (up.headers['content-type'] || '').toLowerCase();
    if ((up.statusCode || 502) >= 400 || /text\/html|json|javascript|xml/.test(ct)) {
      up.resume();
      res.writeHead(403); res.end('asset allowlist');
      return;
    }
    res.writeHead(up.statusCode || 502, {
      'content-type': up.headers['content-type'] || 'application/octet-stream',
      'cache-control': 'public, max-age=300',
    });
    up.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
}

const demoSrv = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/m/')) return proxyAsset(req, res);
  if (req.url === '/f/noto-regular' || req.url === '/f/noto-bold') {
    // 与服务端渲染同源的字体下发（WOFF2）：客户端文字度量与像素渲染一致
    // CORS：源站页面（服务端 Chrome 内）注入的 @font-face 会跨源加载这两个文件
    res.setHeader('access-control-allow-origin', '*');
    // 演进：fontconfig TTC(21MB×2) → 提取 SC 单面 OTF → 与 Regular 同覆盖子集 + WOFF2（6.1/10.2MB）
    sendFile(req, res, path.join(__dirname, 'assets', req.url.endsWith('-bold') ? 'NotoSansSC-Bold.woff2' : 'NotoSansSC-Regular.woff2'),
      'font/woff2', 'public, max-age=86400, immutable');
    return;
  }
  return staticHandler(path.join(__dirname, 'client'))(req, res);
});
const wss = new WebSocketServer({ noServer: true });
demoSrv.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; }
  catch { socket.destroy(); return; }
  if (pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
demoSrv.listen(DEMO_PORT, '0.0.0.0', () => console.log(`[demo  ] listening on 0.0.0.0:${DEMO_PORT}`));

http.createServer(staticHandler(path.join(__dirname, 'protected')))
  .listen(ORIGIN_PORT, '127.0.0.1', () => console.log(`[origin] protected site on 127.0.0.1:${ORIGIN_PORT} (loopback only)`));

// ---------- 会话 ----------
let sessions = 0;
wss.on('connection', async (ws, req) => {
  if (sessions >= MAX_SESSIONS) {
    ws.send(JSON.stringify({ type: 'error', msg: `会话已满（上限 ${MAX_SESSIONS}），请稍后再试` }));
    ws.close(); return;
  }
  sessions++;
  console.log(`[sess  ] open (${sessions}/${MAX_SESSIONS})`);

  let page = null, cdp = null, quality = 60, mode = DEFAULT_MODE;
  let sessionBrowser = null;
  let ffmpeg = null, fedFrames = 0, fedBytes = 0;
  let lastAckAt = 0, lastInputAt = 0, inputLatMs = null, frameTimes = [], statTimer = null;

  const sendJson = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

  // 清理必须先于一切 await 注册：setup 期间（最长约 23s）断连也要释放会话槽、关 page、
  // 清定时器——否则 3 次断连即耗尽 MAX_SESSIONS；无监听的 error 事件还会打崩整个进程
  let dead = false;
  let helloIv = null;
  const cleanup = async () => {
    if (dead) return;
    dead = true;
    sessions--;
    if (statTimer) clearInterval(statTimer);
    if (helloIv) clearInterval(helloIv);
    if (diffTimer) { clearInterval(diffTimer); diffTimer = null; }
    stopFFmpeg();
    try { await stopDomMirror(); } catch {}
    try { if (page) await page.close(); } catch {}
    try { if (sessionBrowser) await sessionBrowser.close(); } catch {}
    console.log(`[sess  ] close (${sessions}/${MAX_SESSIONS})`);
  };
  ws.on('close', cleanup);
  ws.on('error', () => {});

  // 会话源站：虚影 proxy-endpoint 转发时注入 x-rbi-origin（受信内网头）；直连演示用 ORIGIN_URL
  let sessionOrigin = ORIGIN_URL;
  try {
    const hOrigin = req && req.headers['x-rbi-origin'];
    if (hOrigin) {
      const u = new URL(String(hOrigin));
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) sessionOrigin = u.origin + '/';
    }
  } catch (e) {}
    console.log('[sess  ] origin =', sessionOrigin);
    let prodMode = (sessionOrigin !== ORIGIN_URL) || process.env.PROD_PRESENTATION === '1'; // 网关模式/专用实例：访客端隐藏演示壳，只呈现业务页面

  // 交互后的节流全量重同步定时器
  let domResyncTimer = null;
  // 动画/悬停跟随：脏区域差分循环
  let diffTimer = null, diffBusy = false, diffTick = 0;
  // 消息队列必须先于一切 await 挂上：ws 库不缓存无监听期间到达的消息，
  // 冷启动（Chrome 拉起数秒）期间的 hello/mode 一旦错过就永久丢失
  const queue = [];
  let dispatchReady = false;
  const handleCommand = async (m) => {
    switch (m.type) {
          case 'ping': sendJson({ type: 'pong', t: m.t }); break;
          case 'hello': {
            // 会话中 DPR/视口变化（缩放、跨屏、拉窗口）：重新模拟并全量重发瓦片
            const nd = Math.max(1, Math.min(3, parseFloat(m.dpr) || DPR));
            const nw = Math.max(320, Math.min(2560, parseInt(m.w, 10) || viewW));
            const nh = Math.max(240, Math.min(1600, parseInt(m.h, 10) || viewH));
            const changed = (nd !== DPR || nw !== viewW || nh !== viewH) && page;
            DPR = nd; viewW = nw; viewH = nh;
            if (changed) {
              try {
                await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewW, height: viewH, deviceScaleFactor: DPR, mobile: false });
                if (mode === 'dom') await startDomMirror();
                sendJson({ type: 'meta', w: viewW, h: viewH, prod: prodMode });
              } catch (e) {}
            }
            break;
          }
          case 'quality':
            if (mode !== 'h264' && mode !== 'dom') {
              quality = Math.max(10, Math.min(95, parseInt(m.q, 10) || 60));
              await startScreencast();
              sendJson({ type: 'quality', q: quality });
            }
            break;
          case 'mode': {
            const next = ['jpeg', 'webp', 'h264', 'dom'].includes(m.mode) ? m.mode : 'jpeg';
            const isDomLike = (x) => x === 'dom';
            if (isDomLike(mode) && !isDomLike(next)) await stopDomMirror();
            mode = next;
            if (mode === 'h264') { quality = 85; startFFmpeg(); } else { stopFFmpeg(); }
            try {
              if (isDomLike(mode)) {
                await cdp.send('Page.stopScreencast').catch(() => {});
                await startDomMirror();
              } else {
                await startScreencast();
              }
              sendJson({ type: 'mode', mode });
            } catch (e) {
              mode = 'jpeg'; stopFFmpeg(); await stopDomMirror().catch(() => {});
              await startScreencast();
              sendJson({ type: 'error', msg: `模式 ${next} 启动失败已回退 JPEG: ${e.message}` });
              sendJson({ type: 'mode', mode: 'jpeg' });
            }
            break;
          }
          case 'dom': {
            // 客户端镜像 DOM 上的真实交互 → 服务端真实页面元素
            noteInput();
            if (m.kind === 'click') console.log('[dbg] dom click path=' + m.path);
            const ok = await page.evaluate((kind, path, value) => {
              let el = window.__xy.find(path);
              // 镜像里的文字占位符(data-xy-space)与源站文本节点同位：文本节点不能 click，
              // 映射到父元素——真实浏览器里文本上的点击本来就落在父元素
              if (el && el.nodeType === 3) el = el.parentElement;
              if (!el) return false;
              if (kind === 'click') {
                el.click();
                // 真实用户点击会移动焦点；合成 el.click() 不会。不聚焦的话，
                // 后续 CDP 键事件（Enter 发送/提交、Esc、方向键）会落到 body 上，
                // 页面自身的 keydown 监听（如聊天框回车发送）永远收不到。
                // 点击非可聚焦元素时，真实浏览器会把焦点移回 body（原焦点元素失焦）。
                const t = el.tagName;
                const focusable = el.focus && !el.disabled && (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || t === 'BUTTON' || t === 'A' || el.isContentEditable);
                if (focusable) {
                  try { el.focus(); } catch (e) {}
                } else {
                  try { const ae = document.activeElement; if (ae && ae !== document.body && ae.blur) ae.blur(); } catch (e) {}
                }
                return true;
              }
              // React/Vue 受控输入：必须用原型原生 setter 改值，否则框架值追踪器忽略
              // 合成 input 事件，state 不更新 → 表单提交的是空值（实测受控输入登录踩坑）
              // 键入即焦点：真实浏览器里用户在某字段打字，该字段必为焦点；
              // 同步焦点后，后续 CDP 键事件（Enter 发送/提交、Esc、方向键）才落在正确元素上
              try { if (el.focus && !el.disabled) el.focus(); } catch (e) {}
              const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
                : window.HTMLInputElement.prototype;
              const desc = Object.getOwnPropertyDescriptor(proto, 'value');
              if (desc && desc.set) desc.set.call(el, value); else el.value = value;
              el.dispatchEvent(new Event(kind, { bubbles: true }));
              return true;
            }, m.kind, m.path, m.value);
            if (!ok && mode === 'dom') {
              // 防御不变式：失败只做瓦片化全量重同步；明文快照在任何模式下都不下发
              await startDomMirror().catch(() => {});
            }
            // 受控输入在服务端生效后：空闲防抖 700ms 全量重发瓦片。防抖到"停止输入"
            // 才触发（逐键重同步是卡顿与闪烁来源）；客户端原子切换使重同步无闪烁。
            // 输入框自身外观由补丁即时更新，全量快照兜底联动过滤与布局位移。
            if (ok && mode === 'dom') {
              if (domResyncTimer) clearTimeout(domResyncTimer);
              domResyncTimer = setTimeout(() => { domResyncTimer = null; startDomMirror().catch(() => {}); }, 700);
            }
            break;
          }
          case 'mouse': {
            if (m.action !== 'move') noteInput();
            const common = { x: m.x, y: m.y, button: m.button || 'left' };
            if (m.action === 'move') await cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mouseMoved' });
            else if (m.action === 'down') await cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mousePressed', clickCount: 1 });
            else if (m.action === 'up') await cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mouseReleased', clickCount: 1 });
            else if (m.action === 'wheel') await cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mouseWheel', deltaX: m.dx || 0, deltaY: m.dy || 0 });
            break;
          }
          case 'key': {
            noteInput();
            if (m.key === 'Enter') {
              const foc = await page.evaluate(() => document.activeElement ? (document.activeElement.tagName + '#' + document.activeElement.id + ' val="' + String(document.activeElement.value || '').slice(0, 30) + '"') : 'null').catch(() => 'eval-fail');
              console.log('[dbg] Enter arrived, server focus=' + foc);
            }
            const k = m.key;
            if (KEYMAP[k]) {
              const args = { type: m.action === 'up' ? 'keyUp' : 'keyDown', key: k, code: k, windowsVirtualKeyCode: KEYMAP[k], nativeVirtualKeyCode: KEYMAP[k] };
              if (m.action !== 'up' && k === 'Enter') args.text = '\r';
              await cdp.send('Input.dispatchKeyEvent', args);
            } else if (m.text) {
              if (m.action !== 'up') await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: m.text, key: m.text, unmodifiedText: m.text });
              else await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: m.text });
            }
            break;
          }
          case 'scrolltop':
            await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
            break;
        }
  };
  const handleRaw = async (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    try {
      await handleCommand(m);
    } catch (e) { sendJson({ type: 'error', msg: '事件处理异常: ' + e.message }); }
  };
  let cmdChain = Promise.resolve();
  const enqueue = (raw) => { cmdChain = cmdChain.then(() => handleRaw(raw)).catch(() => {}); };
  ws.on('message', (raw) => { if (dispatchReady) enqueue(raw); else queue.push(Buffer.from(raw)); });
  const noteInput = () => { lastInputAt = Date.now(); };

  async function startScreencast() {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.send('Page.startScreencast', {
      format: mode === 'webp' ? 'webp' : 'jpeg',
      quality, maxWidth: VIEW_W, maxHeight: VIEW_H, everyNthFrame: 1,
    });
  }

  function startFFmpeg() {
    if (ffmpeg) return;
    ffmpeg = spawn('ffmpeg', H264_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
    const ff = ffmpeg;
    let errTail = [];
    ff.stderr.on('data', (d) => {
      const lines = d.toString().split('\n').filter(Boolean);
      errTail.push(...lines);
      if (errTail.length > 8) errTail = errTail.slice(-8);
    });
    ff.stdin.on('error', (e) => console.log('[h264  ] stdin error:', e.message));
    ff.stdout.on('data', (chunk) => {
      if (ws.readyState === 1) {
        ws.send(chunk);
        ws._bytes = (ws._bytes || 0) + chunk.length;
        ws._chunks = (ws._chunks || 0) + 1;
      }
    });
    ff.on('error', (e) => {
      console.log('[h264  ] ffmpeg error:', e.message);
      try { ff.kill(); } catch {}
      if (ffmpeg === ff) ffmpeg = null;
    });
    ff.on('exit', (code, sig) => {
      console.log(`[h264  ] ffmpeg exit code=${code} sig=${sig} fed=${fedFrames} stdinMB=${(fedBytes/1048576).toFixed(2)}`);
      if (errTail.length) console.log('[h264  ] stderr tail:', errTail.join(' | ').slice(-500));
      if (ffmpeg === ff) ffmpeg = null;
    });
    console.log('[h264  ] ffmpeg spawned');
  }
  function stopFFmpeg() {
    if (!ffmpeg) return;
    try { ffmpeg.stdin.end(); } catch {}
    try { ffmpeg.kill('SIGKILL'); } catch {}
    ffmpeg = null;
  }

  // ---------- DOM 镜像通道 ----------
  let domActive = false, domExposed = false;
  let DPR = 1;
  let viewW = VIEW_W, viewH = VIEW_H;
  let patchChain = Promise.resolve();

  let domStarting = null;
  function startDomMirror() {
    // 重入保护：多个调用点（模式切换/交互回退/补丁重同步）可能并发到达；
    // 两个 snapshotTiles 在同一 live 页上交错会让彼此的底板含占位空白
    if (domStarting) return domStarting;
    console.log('[dbg] startDomMirror <- ' + (new Error().stack.split('\n')[2] || '?').trim().replace(/^at /, ''));
    domStarting = (async () => {
      try { await doStartDomMirror(); }
      finally { domStarting = null; }
    })();
    return domStarting;
  }
  async function doStartDomMirror() {
    await page.evaluate(PAGE_HELPERS);
    if (!domExposed) {
      await page.exposeFunction('__xyPatch', (patches) => {
        if (!domActive || ws.readyState !== 1) return;
        // 串行化处理，避免并发截图竞态
        patchChain = patchChain.then(async () => {
          try {
            if (patches.some(p => p && p.full)) {
              console.log('[dbg] full patch why:', patches.filter(p => p && p.full).map(p => p.why || '?').slice(0, 3).join(' | ').slice(0, 200));
              // 全量重同步也必须走瓦片化路径（明文快照在瓦片模式下是防御漏洞）
              await startDomMirror();
              return;
            }
            if (patches.some(p => p && (p.tile || p.selTile))) {
              const payload = JSON.stringify({ type: 'dom-patches', patches });
              ws.send(payload);
              ws._bytes = (ws._bytes || 0) + payload.length;
              ws._chunks = (ws._chunks || 0) + 1;
            } else {
              await tilesPatches(patches);
            }
          } catch (e) {}
        });
      });
      domExposed = true;
    }
    domActive = true;
    // 关键：等 webfonts 就绪再截底板。源站注入的 @font-face 用 font-display:block，
    // 字重文件（10MB 级）加载完成前文字隐身——过早截图会产出空白文字瓦片（实测 Bold 全缺）
    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve())).catch(() => {});
    await new Promise(r => setTimeout(r, 150));
    // 底板健康检查：共享 Chrome 偶发产出空白/未完成合成的截图，直接用会把全批瓦片
    // 裁成空白。解码采样判空，坏帧等待 500ms 重拍一次。
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const sheetHealthy = async (b64) => {
      try {
        return await page.evaluate((d) => {
          return new Promise((res) => {
            const im = new Image();
            im.onload = () => {
              try {
                const c = document.createElement('canvas');
                c.width = Math.min(im.width, 400); c.height = Math.min(im.height, 300);
                const x = c.getContext('2d');
                x.drawImage(im, 0, 0, c.width, c.height);
                const dd = x.getImageData(0, 0, c.width, c.height).data;
                const colors = new Map();
                let n = 0;
                for (let i = 0; i < dd.length; i += 4 * 13) {
                  const k = (dd[i] >> 3) + ',' + (dd[i + 1] >> 3) + ',' + (dd[i + 2] >> 3);
                  colors.set(k, (colors.get(k) || 0) + 1);
                  n++;
                }
                const dominant = Math.max(...colors.values());
                res(dominant / n < 0.995); // 单一颜色占绝大面积 = 空白帧
              } catch (e) { res(true); }
            };
            im.onerror = () => res(false);
            im.src = 'data:image/png;base64,' + d;
          });
        }, b64);
      } catch (e) { return true; }
    };
    if (!(await sheetHealthy(shot.data))) {
      console.log('[dom   ] blank sheet detected, recapturing');
      await new Promise(r => setTimeout(r, 500));
      shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    }
    await page.evaluate((d) => { window.__xyDpr = d; }, DPR);
    const snap = await page.evaluate((b64) => window.__xy.snapshotTiles(b64), shot.data);
    try {
      const foc = await page.evaluate(() => document.activeElement ? (document.activeElement.tagName + '#' + (document.activeElement.id || '')) : 'none');
      console.log('[dom   ] post-snapshot focus:', foc);
    } catch (e) {}
    const cssFixed = snap.css.replace(/url\((['"]?)\//g, 'url($1/m/');
    const payload = JSON.stringify({ type: 'dom-snapshot', css: cssFixed, html: snap.html, title: snap.title, w: VIEW_W, h: VIEW_H, tiles: snap.tiles || [], docClass: snap.docClass || '', docAttrs: snap.docAttrs || '' });
    ws.send(payload);
    ws._bytes = (ws._bytes || 0) + payload.length;
    ws._chunks = (ws._chunks || 0) + 1;
    await page.evaluate(() => {
      if (window.__xyObs) window.__xyObs.disconnect();
      window.__xyObs = new MutationObserver((recs) => {
        if (window.__xyBusy) {
          // 位图化期间的变更不丢、也不整体重同步（重同步自身耗时会再撞上变更，形成
          // 自我延续的风暴，实测 15s 内 24 次全量快照）：记录下来，快照完成后按常规
          // 补丁链补发（瓦片重裁的是最新像素）
          const pend = window.__xyPending || (window.__xyPending = []);
          for (const r of recs) { try { const p2 = window.__xy.patchOf(r); if (p2) pend.push(p2); } catch (e) {} }
          if (pend.length > 200) pend.splice(0, pend.length - 200);
          return;
        }
        const out = [];
        for (const r of recs) { const p2 = window.__xy.patchOf(r); if (p2) out.push(p2); }
        if (out.length) window.__xyPatch(out);
      });
      window.__xyObs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      // 快照期间发生的变更补发（常规补丁链；不触发全量重同步）
      const pending = (window.__xyPending || []).filter(Boolean);
      window.__xyPending = null;
      if (pending.length) window.__xyPatch(pending);
    });
    console.log('[dom   ] mirror started');
    startDiffLoop();
  }

  // 变化补丁：一批变更合并为一次整页截图、页面内统一裁剪（流式回复逐字变更时，
  // 逐元素 clip 截图会把 CPU 打满并造成会话级卡顿）。文字/外观均为服务端像素。
  async function tilesPatches(patches) {
    if (patches.some(p => p && p.full)) { await startDomMirror(); return; }
    // 与全量快照同理：font-display:block 窗口内截图会得到空白文字瓦片
    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve())).catch(() => {});
    const items = [];
    for (const p of patches) {
      if (!p || p.path === undefined) continue;
      try {
        const rect = await page.evaluate((path) => {
          const el = window.__xy.find(path);
          if (!el || !el.getBoundingClientRect) return null;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return null;
          return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height,
                   isSel: el.tagName === 'SELECT' };
        }, p.path);
        if (rect) items.push({ path: p.path, ...rect });
      } catch (e) {}
    }
    if (!items.length) return;
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const out = await page.evaluate(async (b64, list, dpr) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const sheet = document.createElement('canvas');
      sheet.width = img.width; sheet.height = img.height;
      sheet.getContext('2d').drawImage(img, 0, 0);
      const out2 = [];
      for (const it of list) {
        const sx = Math.round(it.x * dpr), sy = Math.round(it.y * dpr);
        const sw = Math.max(1, Math.round(it.w * dpr)), sh = Math.max(1, Math.round(it.h * dpr));
        if (sx < 0 || sy < 0 || sx + sw > sheet.width + 2 || sy + sh > sheet.height + 2) continue;
        const c2 = document.createElement('canvas');
        c2.width = sw; c2.height = sh;
        c2.getContext('2d').drawImage(sheet, sx, sy, sw, sh, 0, 0, sw, sh);
        const tile = { w: sw, h: sh, cssX: sx / dpr, cssY: sy / dpr, cssW: sw / dpr, cssH: sh / dpr, url: c2.toDataURL('image/png') };
        out2.push(it.isSel ? { path: it.path, selTile: tile } : { path: it.path, tile });
      }
      return out2;
    }, shot.data, items, DPR).catch(() => null);
    if (!out || !out.length) return;
    const payload = JSON.stringify({ type: 'dom-patches', patches: out });
    if (ws.readyState !== 1) return;
    ws.send(payload);
    ws._bytes = (ws._bytes || 0) + payload.length;
    ws._chunks = (ws._chunks || 0) + 1;
  }

  async function stopDomMirror() {
    domActive = false;
    try { await page.evaluate(() => { if (window.__xyObs) { window.__xyObs.disconnect(); window.__xyObs = null; } }); } catch {}
  }

  // 动画/悬停跟随：视口差分循环（dom 模式）。全量快照/交互重同步期间跳过，
  // 首帧只建基准；无变化零下发。瓦片为不透明底板裁片，位移动画的新旧位置都在
  // 差分区域内，客户端直接覆盖即可，无需清理旧瓦片。
  function startDiffLoop() {
    // 重启：错位瓦片根因定位为共享 Chrome 单例的多标签截图不一致，已改为每会话
    // 独立浏览器实例。差分通道恢复启用（动画/悬停/视频跟随）。
    if (diffTimer) return;
    let diffSince = 0;
    diffTimer = setInterval(async () => {
      if (diffBusy) {
        // 卡死自愈：截图/evaluate 挂起会让 diffBusy 永真、该会话动画永久停更
        if (Date.now() - diffSince > 5000) { console.log('[diff] stuck tick, self-healing'); diffBusy = false; }
        else return;
      }
      if (dead || mode !== 'dom' || !domActive || !page || !cdp || ws.readyState !== 1 || domStarting) return;
      diffBusy = true; diffSince = Date.now();
      try {
        const shot = await Promise.race([
          cdp.send('Page.captureScreenshot', { format: 'png' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('shot timeout')), 2500)),
        ]);
        const out = await Promise.race([
          page.evaluate((b64, d) => window.__xy.diffTiles(b64, d), shot.data, DPR),
          new Promise((_, rej) => setTimeout(() => rej(new Error('diff timeout')), 2500)),
        ]).catch((e) => { console.log('[diff] eval err:', e && e.message); return null; });
        if (!(diffTick = (diffTick + 1) % 20)) {
          try {
            const vis = await page.evaluate(() => document.visibilityState + ' focus=' + document.hasFocus());
            console.log('[diff] tick20 visibility:', vis);
          } catch (e) {}
        }
        if (out === null) { console.log('[diff] diffTiles returned null (err)'); }
        if (out && out.tiles && out.tiles.length) {
          const payload = JSON.stringify({ type: 'anim-tiles', tiles: out.tiles });
          if (ws.readyState === 1) {
            ws.send(payload);
            ws._bytes = (ws._bytes || 0) + payload.length;
            ws._chunks = (ws._chunks || 0) + 1;
          }
        }
      } catch (e) {}
      finally { diffBusy = false; }
    }, 140);
  }

  try {
    const b = await launchSessionBrowser();
    sessionBrowser = b;
    page = await b.newPage();
    cdp = await page.createCDPSession();

    cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
      try {
        const now = Date.now();
        if (lastInputAt) { inputLatMs = now - lastInputAt; lastInputAt = 0; }
        frameTimes.push(now);
        const buf = Buffer.from(data, 'base64');
        if (mode === 'h264') {
          if (ffmpeg && ffmpeg.stdin.writable) {
            fedFrames++; fedBytes += buf.length;
            if (fedFrames <= 3) console.log(`[h264  ] feed#${fedFrames} ${buf.length}B`);
            ffmpeg.stdin.write(buf);
          }
        } else if (ws.readyState === 1) {
          ws.send(buf);
          ws._bytes = (ws._bytes || 0) + buf.length;
          ws._frames = (ws._frames || 0) + 1;
        }
        const wait = Math.max(0, lastAckAt + FRAME_MIN_INTERVAL - now);
        lastAckAt = now + wait;
        setTimeout(() => {
          cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        }, wait);
      } catch (e) { /* session may be closing */ }
    });

    statTimer = setInterval(() => {
      const now = Date.now();
      frameTimes = frameTimes.filter(t => now - t < 1000);
      sendJson({ type: 'sstats', fps: frameTimes.length, inLat: inputLatMs, mode });
    }, 1000);

    // 主框架导航（登录跳转/表单提交等）：重新注入镜像管线并全量重发，
    // 否则登录成功跳转后镜像冻结在旧页面（访客视角=点了没反应）
    page.on('framenavigated', (frame) => {
      try {
        if (frame !== page.mainFrame()) return;
        if (!domActive || ws.readyState !== 1) return;
        navChain = navChain.then(async () => {
          try {
            await page.evaluate(PAGE_HELPERS).catch(() => {});
            await page.addStyleTag({ content: originFontCssFor() }).catch(() => {});
            if (mode === 'dom') await startDomMirror();
          } catch (e) {}
        });
      } catch (e) {}
    });
    let navChain = Promise.resolve();

    // 等客户端上报 DPR（超时回落 1）：服务端按访客 DPR 渲染 → 瓦片 1:1 显示 → 构造性一致
    const hello = await new Promise((res) => {
      const t = setTimeout(() => res({ dpr: 1 }), 3000);
      helloIv = setInterval(() => {
        const i = queue.findIndex((r) => { try { return JSON.parse(r.toString()).type === 'hello'; } catch { return false; } });
        if (i >= 0) {
          clearInterval(helloIv); clearTimeout(t);
          try { res(JSON.parse(queue.splice(i, 1)[0].toString())); } catch { res({ dpr: 1 }); }
        }
      }, 100);
    });
    DPR = Math.max(1, Math.min(3, parseFloat(hello.dpr) || 1));
    // 首次 hello 同时带回访客视口：服务端按访客真实视口渲染，镜像才与直连构图一致
    if (hello.w) viewW = Math.max(320, Math.min(2560, parseInt(hello.w, 10) || viewW));
    if (hello.h) viewH = Math.max(240, Math.min(1600, parseInt(hello.h, 10) || viewH));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewW, height: viewH, deviceScaleFactor: DPR, mobile: false });
    await page.goto(sessionOrigin, { waitUntil: 'networkidle0', timeout: 20000 });
    await page.addStyleTag({ content: originFontCssFor() }).catch(() => {});
    sendJson({ type: 'meta', w: viewW, h: viewH, title: await page.title(), url: sessionOrigin, maxSessions: MAX_SESSIONS, mode, prod: prodMode });
    if (mode === 'dom') await startDomMirror();
    else await startScreencast();

    dispatchReady = true;
    for (const raw of queue.splice(0)) enqueue(raw);

  } catch (e) {
    sendJson({ type: 'error', msg: '会话建立失败: ' + e.message });
    try { await cleanup(); } catch {}
    try { ws.close(); } catch {}
  }
});

process.on('SIGTERM', async () => {
  console.log('[main  ] SIGTERM, shutting down');
  process.exit(0);
});
