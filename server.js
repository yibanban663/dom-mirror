'use strict';
/**
 * dom-mirror 可嵌入 DOM 镜像引擎。进程、端口与 Demo 由宿主管理。
 *
 * 两种模式（客户端可运行时切换）：
 *  - dom   : 真文本 DOM 镜像（默认）——服务端序列化 DOM+CSS，客户端原生渲染
 *            （布局/CSS 动画/悬停/输入全部本地 60fps），增量补丁事件驱动，
 *            结构补丁事件驱动；可选字体混淆（PUA 双映射）
 *  - frame : 像素直出兜底——合成器帧驱动差分，整页 PNG 条带下发（无视频编解码）
 *
 * 链路：客户端浏览器 <--WS--> 宿主接入 --CDP--> 无头Chromium --HTTP--> 配置源站
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const puppeteer = require('puppeteer').default;
const { assetUrl, selectOrigin } = require('./lib/policy');
const { SessionStore } = require('./lib/sessions');
const { frameCropInput } = require('./lib/frame-codec');

const { normalizeOptions } = require('./lib/options');
const { createStaticFiles } = require('./lib/static');
const { createTimers } = require('./lib/timers');

function createMirror(options) {
const config = normalizeOptions(options);
const {
  originUrl: ORIGIN_URL, width: VIEW_W, height: VIEW_H,
  maxSessions: MAX_SESSIONS, sessionGraceMs: SESSION_GRACE_MS,
  allowedOrigins: ALLOWED_ORIGINS, defaultMode: DEFAULT_MODE,
} = config;
const ORIGIN_BASE = new URL(ORIGIN_URL);
const logger = config.logger;
let sharp = null; try { sharp = require('sharp'); } catch (e) { logger.log('[sharp ] unavailable:', e.message); }
const CHROME_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  '--force-color-profile=srgb', '--font-render-hinting=none',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
];
let closed = false;
let closePromise;
const sessionTasks = new Set();
const cleanups = new Set();
const requests = new Set();
function trackRequest(req) {
  requests.add(req);
  req.once('close', () => requests.delete(req));
  return req;
}

// ---------- DOM 镜像：注入到受保护页面的辅助函数 ----------
// 序列化 = 剥离 script/事件属性 + canvas→位图兜底 + 静态资源 URL 重写(/m 代理) ；路径 = 基于 body 的元素 children 索引
const PAGE_HELPERS = `(() => {
  // 滚动同步钩子（v3 事件驱动，替代帧差分通道）：页面/内部容器的任何滚动
  // 都以 80ms 节流上报（capture 能收到不冒泡的内层滚动）。必须放在 __xy 守卫
  // 之前——导航后重注入helpers时 __xy 已存在会提前 return，钩子会丢。
  if (!window.__xyScrollHooked) {
    window.__xyScrollHooked = true;
    let __xyLastPing = 0;
    const ping = (force) => {
      const now = Date.now();
      if (!force && now - __xyLastPing < 80) return;
      // 回声抑制：服务端镜像客户端上报的滚动时（__xyMirroring 窗口内），
      // 镜像写入触发的滚动事件不再回推（否则 ~RTT 后把自己拽回旧位置）
      if (!force && Date.now() - (window.__xyMirroring || 0) < 250) return;
      __xyLastPing = now;
      try { window.__xyScrollPing({ sx: Math.round(window.scrollX), sy: Math.round(window.scrollY), scrollers: (window.__xy ? window.__xy.scrollers() : []) }); } catch (e) {}
    };
    window.addEventListener('scroll', () => ping(false), true);
    window.__xyScrollPingNow = ping;
  }
  // rAF 活动计数（canvas 捕获门）：动画循环完全停转 = 页面静止，
  // canvas 不可能变化 → 零捕获。典型渲染循环即使画面不变也持续 rAF，
  // 计数只作"完全停转"的判零依据（不停转的静止画面走指数退避）。
  if (!window.__xyRafWrapped) {
    window.__xyRafWrapped = true;
    window.__xyRafCount = 0;
    const origRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => origRaf((t) => { window.__xyRafCount++; try { cb(t); } catch (e) {} });
  }
  if (window.__xy) return;
  const ORIGIN_PREFIX = ${JSON.stringify(ORIGIN_BASE.origin)};
  function fixUrl(v) {
    if (!v || /^(data:|blob:|#|mailto:|tel:|javascript:|about:)/i.test(v)) return v;
    if (v.startsWith('//')) return v;
    if (v.startsWith('/')) return '/m' + v;
    if (v.startsWith(ORIGIN_PREFIX)) return '/m' + v.slice(ORIGIN_PREFIX.length);
    return v;
  }
  // 防抓取编码：文本码点 -> 会话 PUA 置换码点（混淆字体双映射回原字形渲染）。
  // 目标码点在补充平面（0xF0000+），源域全 BMP；域外字符原样透传。
  function encStr(s) {
    const M = window.__xyObfMap;
    if (!M || !s) return s;
    let out = '', hit = false;
    for (let i = 0; i < s.length; i++) {
      const t = M[s.charCodeAt(i)];
      if (t !== undefined) { out += String.fromCodePoint(t); hit = true; }
      else out += s[i];
    }
    return hit ? out : s;
  }
  const REDACT_ATTRIBUTES = new Set(${JSON.stringify(config.redactAttributes)});
  function stripAttributes(el) {
    for (const a of [...el.attributes]) {
      if (REDACT_ATTRIBUTES.has(a.name.toLowerCase())) { el.removeAttribute(a.name); continue; }
      if (/^on/i.test(a.name) || a.name === 'srcdoc' || a.name === 'formaction') { el.removeAttribute(a.name); continue; }
      // 零明文收口：aria-*/title/alt 是纯文本载体（无视觉作用），一并剥离
      if (/^(aria-(label|placeholder|description|roledescription|valuetext)|title|alt)$/i.test(a.name)) { el.removeAttribute(a.name); continue; }
      if (a.name === 'placeholder' && window.__xyObfMap && a.value) {
        try { el.setAttribute('placeholder', encStr(a.value)); } catch (e) {}
        continue;
      }
      if (a.name === 'href' || a.name === 'src' || a.name === 'action' || a.name === 'poster' || a.name === 'srcset') {
        try { el.setAttribute(a.name, fixUrl(a.value)); } catch (e) {}
      }
    }
  }
  function sanitizeClone(root) {
    const clone = root.cloneNode(true);
    // 注释不参与元素路径，直接删除，避免下发非展示内容。
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach(node => node.remove());
    // selected 是运行时属性，innerHTML 不会自动带上；显式写回选中状态。
    const liveSelects = root.tagName === 'SELECT' ? [root] : [...root.querySelectorAll('select')];
    const cloneSelects = clone.tagName === 'SELECT' ? [clone] : [...clone.querySelectorAll('select')];
    cloneSelects.forEach((select, i) => {
      [...select.options].forEach((option, j) => option.toggleAttribute('selected', liveSelects[i].options[j].selected));
    });
    const controls = node => /^(INPUT|TEXTAREA)$/.test(node.tagName) ? [node] : [...node.querySelectorAll('input,textarea')];
    const liveControls = controls(root);
    controls(clone).forEach((control, i) => {
      const live = liveControls[i];
      if (control.tagName === 'TEXTAREA') { control.textContent = live.value; return; }
      if (['hidden', 'password', 'file'].includes(control.type)) { control.removeAttribute('value'); return; }
      if (control.type !== 'hidden') control.setAttribute('value', live.value);
      if (control.type === 'checkbox' || control.type === 'radio') control.toggleAttribute('checked', live.checked);
    });
    if (clone.querySelectorAll) {
      clone.querySelectorAll('script,noscript,template').forEach(n => n.remove());
      clone.querySelectorAll('*').forEach(stripAttributes);
    }
    if (clone.nodeType === 1) stripAttributes(clone);
    // 文本节点编码。TEXTAREA 跳过：输入框值是明文（客户端原样回传源站，编码会污染
    // 输入链路），靠字体端原码点保留渲染照常；STYLE 跳过：CSS 不可编码。
    if (window.__xyObfMap) {
      const walk = (node) => {
        for (const c of node.childNodes) {
          if (c.nodeType === 3) {
            if (node.tagName !== 'TEXTAREA' && node.tagName !== 'STYLE' && c.nodeValue && /[\\u3000-\\u9fff\\uff00-\\uffef]/.test(c.nodeValue)) c.nodeValue = encStr(c.nodeValue);
          } else if (c.nodeType === 1 && c.tagName !== 'TEXTAREA' && c.tagName !== 'STYLE') {
            walk(c);
          }
        }
      };
      walk(clone);
    }
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
  // 只按元素编号：HTML 重解析会丢弃空文本、合并相邻文本，不能使用 childNodes。
  const XY_SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE']);
  const pathChildren = (node) => [...node.children].filter(c => !XY_SKIP.has(c.tagName.toUpperCase()));
  function pathOf(node) {
    const parts = [];
    let n = node;
    while (n && n !== document.body) {
      const p = n.parentElement;
      if (!p) return null;
      const index = pathChildren(p).indexOf(n);
      if (index < 0) return null;
      parts.unshift(index);
      n = p;
    }
    return n === document.body ? parts.join('/') : null;
  }
  window.__xy = {
    sanitizeClone, pathOf,
    // 内部滚动容器收集：可滚动且 scrollTop/Left>0 的元素（path+偏移）。
    // 源站 JS 自动滚动（如聊天自动滚到底）必须同步到代理，否则代理盒子
    // 停在未滚动位置，与瓦片/源站错位（实测流式后气泡整体低 4px）
    scrollers() {
      const out = [];
      try {
        for (const el of document.body.querySelectorAll('*')) {
          if ((el.scrollTop > 0 || el.scrollLeft > 0) && el.scrollHeight > el.clientHeight + 1) {
            const p = pathOf(el);
            if (p !== null) out.push([p, Math.round(el.scrollTop), Math.round(el.scrollLeft)]);
            if (out.length > 12) break;
          }
        }
      } catch (e) {}
      return out;
    },
    find(path) {
      if (path === '') return document.body;
      let n = document.body;
      for (const i of path.split('/')) {
        n = pathChildren(n)[+i];
        if (!n) return null;
      }
      return n;
    },
    // v4 真文本快照：镜像 DOM 携带真实文本，客户端用源站同款 CSS/字体本地渲染
    // ——布局/动画/悬停/打字/图标全部原生，与服务端渲染零耦合（构造性一致）。
    // 快照零截图：开销与页面复杂度解耦（此前 4000 元素页瓦片级联 3 秒的根源）。
    // 防抓取不靠像素化：由编码层（字体混淆，后续挂载）承担。
    async snapshotReal(wantFrame) {
      const DPR = window.__xyDpr || 1;
      const clone = sanitizeClone(document.body);
      const styleCss = [...document.querySelectorAll('style')].map(s2 => s2.textContent).join('\\n');
      const hrefs = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href')).filter(Boolean);
      let linkCss = '';
      try {
        const texts = await Promise.all(hrefs.map(h => fetch(h).then(r => r.ok ? r.text() : '').catch((e) => { console.warn('[snapcss] fetch fail', h, String(e).slice(0, 60)); return ''; })));
        linkCss = texts.join('\\n');
      } catch (e) { console.warn('[snapcss] batch fail', String(e).slice(0, 60)); }
      window.__xyCssDiag = { hrefs, lens: hrefs.map((h, i) => (linkCss.length)), styleLen: styleCss.length, linkLen: linkCss.length, kf: (linkCss.match(/@keyframes/g) || []).length, at: Date.now(), url: location.pathname };
      let docClass = '', docAttrs = '';
      for (const root of [document.documentElement, document.body]) {
        if (!root) continue;
        const safeRoot = root.cloneNode(false);
        stripAttributes(safeRoot);
        for (const a of safeRoot.attributes || []) {
          if (/^on/i.test(a.name) || a.name === 'style' || a.name === 'id') continue;
          if (a.name === 'class') { docClass += ' ' + a.value; continue; }
          docAttrs += ' ' + a.name + '="' + String(a.value).replace(/"/g, '&quot;') + '"';
        }
      }
      // frame（显式像素直出）模式：唯一保留截图的地方——整页 PNG 条带
      let frame = null;
      if (wantFrame) {
        const shotB64 = window.__xyFrameShot;
        if (shotB64) {
          const img = new Image();
          img.src = 'data:image/png;base64,' + shotB64;
          await img.decode();
          const sheet = document.createElement('canvas');
          sheet.width = img.width; sheet.height = img.height;
          sheet.getContext('2d').drawImage(img, 0, 0);
          const CAP = 12000;
          const pageH = Math.min(sheet.height / DPR, CAP);
          const bands = [];
          const BH = 512;
          for (let by = 0; by < pageH; by += BH) {
            const bh = Math.min(BH, pageH - by);
            if (bh < 2) break;
            const c3 = document.createElement('canvas');
            c3.width = sheet.width; c3.height = Math.round(bh * DPR);
            c3.getContext('2d').drawImage(sheet, 0, Math.round(by * DPR), sheet.width, c3.height, 0, 0, sheet.width, c3.height);
            bands.push({ w: sheet.width, h: c3.height, cssX: 0, cssY: by, cssW: sheet.width / DPR, cssH: bh, url: c3.toDataURL('image/png') });
          }
          frame = { pageW: sheet.width / DPR, pageH: Math.round(pageH), tiles: bands };
        }
      }
      return { css: styleCss + '\\n' + linkCss, html: clone.innerHTML, title: document.title, tiles: [], frame, sx: window.scrollX, sy: window.scrollY, scrollers: window.__xy.scrollers(), docClass: docClass.trim(), docAttrs: docAttrs.trim() };
    },

    // Skia 文字引擎：文本不出现在镜像 DOM（占位符撑布局），文字以"引擎绘制指令"
    // （runs: 文本/坐标/字号/颜色）下发，客户端 CanvasKit(Skia-WASM) 本地任意 DPR 清晰绘制。
    // 零截图：服务端只做 DOM 测量，资源开销与纯 DOM 镜像同级。
    patchOf(record) {
      // 补丁模型：childList/characterData → 目标元素 innerHTML 重发；attributes → 元素 outerHTML 重发
      let target = record.target;
      if (target.nodeType === 3) target = target.parentElement;
      if (!target || target === document.documentElement) {
        // html 的 class 变更是主题/状态切换（应用会周期性翻转，如在线状态指示）：
        // 走轻量 docClass 补丁直改镜像根类名。若当 full 处理会形成
        // "翻转→全量重同步→再翻转" 的重建风暴（实测内页每秒多次全量快照，
        // 重建窗口吞点击、打断输入）。
        if (target && record.type === 'attributes' && record.attributeName === 'class') {
          return { docClass: REDACT_ATTRIBUTES.has('class') ? '' : target.className };
        }
        return { full: true, why: record.type + ':docEl:' + (record.attributeName || '') + ':' + (target && target.nodeName) };
      }
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
      // v3：inner/outer 仅作标记（内容由 tilesPatches 在整页截图后统一 tileize，
      // 此处克隆整段再丢弃是纯浪费）；客户端按 p.inner/p.outer !== undefined 分派
      if (record.type === 'attributes') return { path, outer: 1 };
      return { path, inner: 1 };
    },
  };
})();`;

// ---------- 静态文件 ----------
const { sendFile, staticHandler, clear: clearStaticFiles } = createStaticFiles();

// ---------- Chromium：每会话独立实例 ----------
// 共享单例下多标签并发截图会间歇产出错位/幽灵瓦片（像素级实测：瓦片内容与坐标
// 张冠李戴）。使用独立实例；实际容量由宿主按业务测量。
async function launchSessionBrowser() {
  const b = await puppeteer.launch({
    headless: true,
    args: CHROME_ARGS,
    defaultViewport: { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1 },
    ...config.launchOptions,
  });
  b.on('disconnected', () => logger.log('[chrome] session browser disconnected'));
  logger.log('[chrome] per-session launched:', await b.version());
  return b;
}

const KEYMAP = {
  Backspace: 8, Enter: 13, Tab: 9, Escape: 27, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35,
};

// ---------- HTTP + WS ----------
// /m/* —— 扩展名及响应类型受限的静态资源代理，不解析或剔除资源内数据。
const httpOrigin = ORIGIN_BASE.protocol === 'https:' ? require('https') : require('http');
function proxyAsset(req, res) {
  // 白名单：只代理表现层静态资源（CSS url() 引用的图片/字体等）。
  // 不加白名单时 GET /m/ 可直接拉到源站整页明文（含页面内密钥）——击穿"数据不出站"
  const u = assetUrl(req.url.slice(2), ORIGIN_BASE);
  if (!u) { res.writeHead(403); res.end('asset allowlist'); return; }
  const upstream = trackRequest(httpOrigin.get(u, { headers: { 'user-agent': 'rbi-mirror-asset', accept: req.headers.accept || '*/*' } }, (up) => {
    const ct = (up.headers['content-type'] || '').toLowerCase();
    if ((up.statusCode || 502) < 200 || (up.statusCode || 502) >= 300 || /text\/html|json|javascript|xml/.test(ct)) {
      up.resume();
      res.writeHead(403); res.end('asset allowlist');
      return;
    }
    res.writeHead(up.statusCode || 502, {
      'content-type': up.headers['content-type'] || 'application/octet-stream',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    });
    up.on('error', () => res.destroy());
    up.pipe(res);
  }));
  upstream.setTimeout(12000, () => upstream.destroy(new Error('asset timeout')));
  upstream.on('error', () => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502); res.end('bad gateway');
  });
}

// ---------- 防抓取编码层：字体混淆（会话种子池轮换） ----------
// 原理：镜像文本以 PUA 码点（0xF0000+，随会话种子置换）下发；混淆字体的 cmap 把
// PUA 码点双映射回原字形（原码点保留）——渲染与原生逐位一致（CFF 轮廓原样），
// 但 DOM 文本/复制/爬虫拿到的是乱码。ASCII/西文不混淆（等宽代码块、数字原样），
// 域=CJK 标点(3000-303F)+基本区(4E00-9FFF)+全角(FF00-FFEF)。
// 字体由 tools/build_obf_font.py 在构建期烘焙（种子池 assets/obf/），会话创建即生效
// （零预热）；种子池可扩容，动态按会话构建走同脚本（python3-fonttools）。
const OBF_ON = config.obfuscate;
const OBF_POOL_DIR = path.join(__dirname, 'assets', 'obf');
const OBF_FAMILIES = ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', 'Source Han Sans SC'];
const obfPool = [];
try {
  for (const f of fs.readdirSync(OBF_POOL_DIR).filter(x => /^reg-s\d+\.json$/.test(x)).sort()) {
    const seed = f.match(/s(\d+)\./)[1];
    const permRaw = JSON.parse(fs.readFileSync(path.join(OBF_POOL_DIR, f), 'utf8'));
    const plain = {};
    for (const k of Object.keys(permRaw)) plain[parseInt(k, 16)] = parseInt(permRaw[k], 16);
    obfPool.push({ seed, plain, permJson: path.join(OBF_POOL_DIR, f), reg: path.join(OBF_POOL_DIR, f.replace('.json', '.woff2')), bold: path.join(OBF_POOL_DIR, 'bold-s' + seed + '.woff2') });
  }
  logger.log(`[obf   ] pool: ${obfPool.length} seeds ${OBF_ON ? 'ON' : 'OFF'}${obfPool.length ? '' : '（assets/obf 缺失）'}`);
} catch (e) { logger.log('[obf   ] pool unavailable:', e.message); }
let obfRR = 0;
const obfSessions = new Map();   // sid -> pool entry（含 .siteFonts 网站字体孪生）
const obfFontCache = new Map();  // 文件路径 -> Buffer（LRU≤8，~3-8MB/项）
const obfTwinCache = new Map();  // url|seed -> Buffer（网站字体 PUA 孪生，LRU≤12）
const obfHttp = ORIGIN_BASE.protocol === 'https:' ? require('https') : require('http');
// 下载源站字体文件（同源静态资源，服务端代取）
function obfFetchFont(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    try {
      const req = trackRequest(obfHttp.get(url, { timeout: timeoutMs }, (r) => {
        if ((r.statusCode || 0) >= 400) { r.resume(); resolve(null); return; }
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve(Buffer.concat(chunks)));
        r.on('error', () => resolve(null));
      }));
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch (e) { resolve(null); }
  });
}
// 网站自有字体（艺术字/品牌字/图标字）的 PUA 孪生构建：把会话置换码点追加进
// 网站字体自身的 cmap——被编码的艺术字文本由【网站原字体】渲染，逐位还原。
const { execFile } = require('child_process');
const execFileP = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 20000 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
});
async function buildObfTwin(ent, url) {
  const key = url + '|' + ent.seed;
  if (obfTwinCache.has(key)) return obfTwinCache.get(key);
  const buf = await obfFetchFont(url);
  if (!buf || buf.length < 500) return null;
  const h = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  const src = `/tmp/obf-twin-${h}.src`;
  const out = `/tmp/obf-twin-${h}.woff2`;
  require('fs').writeFileSync(src, buf);
  const r = await execFileP('python3', [path.join(__dirname, 'tools', 'build_obf_twins.py'), src, ent.permJson, out]);
  if (!r.ok || !fs.existsSync(out)) { logger.log('[obf   ] twin build fail:', url.slice(-40), r.stdout.slice(0, 80)); return null; }
  const outBuf = fs.readFileSync(out);
  if (obfTwinCache.size >= 12) obfTwinCache.delete(obfTwinCache.keys().next().value);
  obfTwinCache.set(key, outBuf);
  return outBuf;
}
// 通用兜底字体族（页面 CSS 提取不到时的保险；PUA 专用面只接 U+F0000-10FFFF，
// 对未编码字符零影响——任何站点的明文字符一律走访客本机字体，与原生一致）
const OBF_FAMS_DEFAULT = [
  'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Microsoft YaHei UI', '微软雅黑', '微软雅黑 UI',
  'Noto Sans SC', 'Noto Sans CJK SC', 'Source Han Sans SC', 'Source Han Sans CN', '思源黑体',
  'Segoe UI', 'Helvetica Neue', 'Arial', 'SimHei', 'SimSun', '黑体', '宋体',
  'WenQuanYi Micro Hei', 'Droid Sans Fallback',
];
const OBF_FAM_SKIP = new Set(['inherit', 'initial', 'unset', 'revert', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'ui-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'BlinkMacSystemFont', 'math', 'emoji', 'fangsong', 'STKaiti', 'STSong']);
function nextObfSession() {
  if (!OBF_ON || !obfPool.length) return null;
  const sid = crypto.randomUUID().slice(0, 8);
  const ent = obfPool[obfRR++ % obfPool.length];
  obfSessions.set(sid, ent);
  return { sid, plain: ent.plain };
}
// 从页面 CSS 提取全部 font-family 族名（通用引擎：不写死站点字体栈）
function obfFamiliesFromCss(css) {
  const found = new Set(OBF_FAMS_DEFAULT);
  const re = /font-family\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(css || ''))) {
    for (const raw of m[1].split(',')) {
      const f = raw.trim().replace(/^['"]|['"]$/g, '').trim();
      if (f && f.length <= 48 && !OBF_FAM_SKIP.has(f.toLowerCase()) && !f.startsWith('var(')) found.add(f);
    }
    if (found.size > 90) break;
  }
  return [...found].slice(0, 90);
}
// PUA 专用 @font-face：unicode-range 只接 U+F0000-10FFFF——混淆字体仅渲染被编码的
// 码点，页面其余字符（英文/数字/标点/未编码 CJK）全部走访客本机字体 → 与原生一致。
function obfFacesCss(sid, fams) {
  return fams.map(f =>
    '@font-face{font-family:"' + f + '";src:url(/m/obf/' + sid + '/reg.woff2) format("woff2");font-weight:400;font-display:block;unicode-range:U+F0000-10FFFF}'
    + '@font-face{font-family:"' + f + '";src:url(/m/obf/' + sid + '/bold.woff2) format("woff2");font-weight:700;font-display:block;unicode-range:U+F0000-10FFFF}').join('');
}

function handleRequest(req, res) {
  if (closed) { res.writeHead(503); res.end('mirror closed'); return; }
  if (req.url && req.url.startsWith('/m/obf/')) {
    // 会话混淆字体（池内种子轮换；URL 含会话 id，跨会话不可互换）。
    // site-<i> = 网站自有字体的 PUA 孪生（艺术字逐位还原）
    const mSite = String(req.url).match(/^\/m\/obf\/([0-9a-z-]{4,40})\/site-(\d+)\.woff2$/);
    if (mSite) {
      const ent = obfSessions.get(mSite[1]);
      const sf = ent && ent.siteFonts && ent.siteFonts[+mSite[2]];
      if (!sf) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'private, max-age=3600' });
      res.end(sf.buf);
      return;
    }
    const m2 = String(req.url).match(/^\/m\/obf\/([0-9a-z-]{4,40})\/(reg|bold)\.woff2$/);
    const ent = m2 && obfSessions.get(m2[1]);
    if (!ent) { res.writeHead(404); res.end(); return; }
    let buf = obfFontCache.get(m2[2] === 'bold' ? ent.bold : ent.reg);
    if (!buf) {
      try { buf = fs.readFileSync(m2[2] === 'bold' ? ent.bold : ent.reg); }
      catch (e) { res.writeHead(404); res.end(); return; }
      if (obfFontCache.size >= 8) obfFontCache.delete(obfFontCache.keys().next().value);
      obfFontCache.set(m2[2] === 'bold' ? ent.bold : ent.reg, buf);
    }
    res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=86400, immutable' });
    res.end(buf);
    return;
  }
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
}
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const identities = new WeakMap();
function handleUpgrade(req, socket, head) {
  if (closed) { socket.destroy(); return; }
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; }
  catch { socket.destroy(); return; }
  if (pathname !== '/ws') { socket.destroy(); return; }
  if (config.getSessionIdentity) {
    try {
      const identity = config.getSessionIdentity(req);
      if (identity && typeof identity.then === 'function') {
        Promise.resolve(identity).catch(() => {});
        throw new TypeError('getSessionIdentity must be synchronous');
      }
      if (typeof identity !== 'string' || !identity.trim()) throw new TypeError('missing session identity');
      identities.set(req, identity);
    } catch {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
  }
  try { req.rbiOrigin = selectOrigin(req.headers['x-rbi-origin'], ORIGIN_URL, ALLOWED_ORIGINS); }
  catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

// ---------- 会话 ----------
const sessionStore = new SessionStore({ limit: MAX_SESSIONS, graceMs: SESSION_GRACE_MS });
const sessionLifecycles = new WeakMap();
const socketIdentities = new WeakMap();
let sessions = 0;
wss.on('connection', (socket, req) => {
  socketIdentities.set(socket, identities.get(req));
  socket.on('error', () => {});
  const reject = (code) => {
    const messages = {
      SESSION_EXPIRED: '会话已过期或不可恢复，请核对上次提交结果后重新开始',
      SESSION_BUSY: '原连接尚未释放，正在重试',
      SESSION_LIMIT: '会话已满，请稍后重试',
      INVALID_HANDSHAKE: '连接握手无效，请重新开始',
    };
    const terminal = code === 'SESSION_EXPIRED' || code === 'INVALID_HANDSHAKE';
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'error', code, terminal, msg: messages[code] }));
    socket.close(terminal ? 1008 : 1013);
  };
  const timer = setTimeout(() => reject('INVALID_HANDSHAKE'), 3000);
  socket.once('close', () => clearTimeout(timer));
  socket.once('message', raw => {
    clearTimeout(timer);
    if (closed || socket.readyState !== 1) return;
    let hello;
    try { hello = JSON.parse(raw.toString()); } catch { reject('INVALID_HANDSHAKE'); return; }
    if (!hello || hello.type !== 'hello') { reject('INVALID_HANDSHAKE'); return; }
    const scope = JSON.stringify([req.rbiOrigin || ORIGIN_URL, req.headers.origin || '', identities.get(req) ?? null]);
    let claimed;
    try { claimed = sessionStore.claim(hello.resume, scope, socket); }
    catch (error) { reject(error.message); return; }
    const { session, resumed } = claimed;
    if (!resumed) wss.emit('session', session, req);
    session.send(JSON.stringify({ type: 'session', token: session.token, resumed, graceMs: SESSION_GRACE_MS }));
    session.emit('message', raw);
    if (resumed) session.emit('resume');
  });
});
wss.on('session', (ws, req) => {
  const lifecycle = { identity: identities.get(req) };
  sessionLifecycles.set(ws, lifecycle);
  const task = runSession(ws, req, lifecycle);
  lifecycle.task = task;
  sessionTasks.add(task);
  task.finally(() => sessionTasks.delete(task)).catch(error => logger.log('[sess  ] setup failed:', error.message));
});
async function runSession(ws, req, lifecycle) {
  const timers = createTimers();
  const { setTimeout, clearTimeout, setInterval, clearInterval } = timers;
  sessions++;
  logger.log(`[sess  ] open (${sessions}/${MAX_SESSIONS})`);

  let page = null, cdp = null, mode = DEFAULT_MODE;
  let sessionBrowser = null;
  const obfSess = nextObfSession(); // 防抓取字体混淆（dom 模式启用；无池则 null 透明降级）
  let lastInputAt = 0, inputLatMs = null, frameTimes = [], statTimer = null;

  const sendJson = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

  // 逻辑会话终止时清理；普通 WS 断线由 SessionStore 保留到恢复或过期。
  // setup 期间也要登记清理，避免浏览器晚启动后泄漏。
  let dead = false;
  let helloIv = null;
  let lastCssSig = null; // 样式表集合指纹（1Hz 兜底比对；每次全量快照后置 null 重定基线）
  let cleanupPromise;
  let cancelHello = () => {};
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    dead = true;
    cancelHello();
    timers.clear();
    cleanupPromise = (async () => {
      sessions--;
      if (obfSess) obfSessions.delete(obfSess.sid);
      domActive = false;
      await Promise.allSettled([page?.close(), sessionBrowser?.close()]);
      logger.log(`[sess  ] close (${sessions}/${MAX_SESSIONS})`);
    })();
    cleanupPromise.finally(() => cleanups.delete(cleanup)).catch(() => {});
    return cleanupPromise;
  };
  cleanups.add(cleanup);
  lifecycle.cleanup = cleanup;
  ws.on('close', cleanup);
  ws.on('error', () => {});

  // 会话源站：WAF proxy-endpoint 转发时注入 x-rbi-origin（受信内网头）；直连演示用 ORIGIN_URL
  const sessionOrigin = req.rbiOrigin || ORIGIN_URL;
    logger.log('[sess  ] origin =', sessionOrigin);
    let prodMode = (sessionOrigin !== ORIGIN_URL) || config.presentation === 'embedded'; // 网关模式/专用实例：访客端隐藏演示壳，只呈现业务页面

  // 交互后的节流全量重同步定时器
  let domResyncTimer = null;
  // 动画/悬停跟随：脏区域差分循环（仅 frame 模式）
  let diffTimer = null, diffBusy = false, diffTick = 0;
  // v3 dom 模式：canvas 元素按需捕获 / 结构补丁合并窗 / 滚动同步去重
  let canvasTimer = null;
  let structTimer = null; const structBuf = new Map();
  const lastPatchSent = new Map();
  let lastScrollKey = '';
  let statLastChunks = 0;
  let canvasSigsReset = null; // 全量重同步后 canvas 捕获基准失效（画面已变）
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
                if (mode === 'dom' || mode === 'frame') await startDomMirror();
                sendJson({ type: 'meta', w: viewW, h: viewH, prod: prodMode });
              } catch (e) {}
            }
            break;
          }
          case 'mode': {
            // dom（真文本镜像，默认）↔ frame（像素直出兜底）双向可切
            const next = ['dom', 'frame'].includes(m.mode) ? m.mode : 'dom';
            // frame → dom：帧差分循环与帧流必须死亡（dom 无帧率不变式）
            if (mode === 'frame' && next !== 'frame') {
              if (diffTimer) { clearInterval(diffTimer); diffTimer = null; }
              cdp.send('Page.stopScreencast').catch(() => {});
            }
            mode = next;
            try {
              await cdp.send('Page.stopScreencast').catch(() => {});
              await startDomMirror();
              sendJson({ type: 'mode', mode });
            } catch (e) {
              sendJson({ type: 'error', msg: `模式 ${next} 启动失败: ${e.message}` });
            }
            break;
          }
          case 'dom': {
            // 客户端镜像 DOM 上的真实交互 → 服务端真实页面元素
            noteInput();
            if (m.kind === 'click') logger.log('[dbg] dom click path=' + m.path);
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
              // 合成 input 事件，state 不更新 → 表单提交的是空值（实测生产站点
              // 键入即焦点（仅 input 事件）：真实浏览器里用户在某字段打字，该字段必为焦点；
              // 同步焦点后，后续 CDP 键事件（Enter 发送/提交、Esc、方向键）才落在正确元素上。
              // change 事件在失焦时触发——此刻聚焦等于"用户刚离开又被拉回"，禁止
              if (kind === 'input') { try { if (el.focus && !el.disabled) el.focus(); } catch (e) {} }
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
            // 输入后不再做防抖全量重发：差分循环（140ms）+ 结构补丁已覆盖一切视觉
            // 跟进，而全量重建会吞掉重建窗口内的点击（实测登录按钮点击落在 700ms
            // 防抖重建里被静默丢弃 → 登录"点了没反应"）。结构漂移由元素数指纹兜底。
            break;
          }
          case 'mouse': {
            if (m.action !== 'move') noteInput();
            let mx = m.x, my = m.y;
            // 锚点平移：客户端镜像布局与服务端有偏差（字体度量/宽度差），纯坐标会
            // 点错位置。以按下时的目标元素为锚：服务端实测该元素矩形，与客户端
            // 记录的镜像矩形做同一平移——整个手势期间偏移恒定，滑块/拖放语义成立
            if (m.apath !== undefined && m.apath !== null) {
              const tr = await page.evaluate((path, ax, ay) => {
                try {
                  let el = window.__xy ? window.__xy.find(path) : null;
                  if (el && el.nodeType === 3) el = el.parentElement;
                  if (!el || !el.getBoundingClientRect) return null;
                  const r = el.getBoundingClientRect();
                  return { dx: r.left - ax, dy: r.top - ay };
                } catch (e) { return null; }
              }, m.apath, m.ax, m.ay).catch(() => null);
              if (tr) { mx += tr.dx; my += tr.dy; }
            }
            const common = { x: mx, y: my, button: m.button || 'left' };
            if (m.action === 'move') await cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mouseMoved', buttons: m.buttons || 0 });
            else if (m.action === 'down') await cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mousePressed', clickCount: 1, buttons: 1 });
            else if (m.action === 'up') await cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mouseReleased', clickCount: 1, buttons: 1 });
            else if (m.action === 'wheel') {
              await cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mouseWheel', deltaX: m.dx || 0, deltaY: m.dy || 0 });
            }
            break;
          }
          case 'key': {
            noteInput();
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
          case 'repaint': {
            // 本地投机孔回落：客户端孔关闭后请求该区域按服务端当前画面重绘
            // （单张瓦片，消除 putImageData 复原与服务端瓦片的竞态）
            noteInput();
            try {
              const shotR = await cdp.send('Page.captureScreenshot', { format: 'png' });
              const tileR = await page.evaluate((b64, x, y, w, h, d) => {
                return new Promise((res) => {
                  const im = new Image();
                  im.onload = () => {
                    const vx = Math.round((x - window.scrollX) * d), vy = Math.round((y - window.scrollY) * d);
                    const vw = Math.min(Math.round(w * d), im.width - vx), vh = Math.min(Math.round(h * d), im.height - vy);
                    if (vw < 1 || vh < 1 || vx < 0 || vy < 0) { res(null); return; }
                    const c = document.createElement('canvas');
                    c.width = vw; c.height = vh;
                    c.getContext('2d').drawImage(im, vx, vy, vw, vh, 0, 0, vw, vh);
                    res({ w: vw, h: vh, cssX: x, cssY: y, cssW: vw / d, cssH: vh / d, url: c.toDataURL('image/png') });
                  };
                  im.onerror = () => res(null);
                  im.src = 'data:image/png;base64,' + b64;
                });
              }, shotR.data, Math.max(0, m.x || 0), Math.max(0, m.y || 0), Math.max(2, m.w || 2), Math.max(2, m.h || 2), DPR).catch(() => null);
              if (tileR && ws.readyState === 1) {
                const pr = JSON.stringify({ type: 'anim-tiles', tiles: [tileR] });
                ws.send(pr);
                ws._bytes = (ws._bytes || 0) + pr.length;
              }
            } catch (e) {}
            break;
          }
          case 'scroll': {
            // v3 dom 模式：客户端本地原生滚动（零延迟），滚动位置上报到服务端——
            // 服务端页面跟到同位置（懒加载/锚点/后续补丁裁剪坐标才正确），
            // 内部滚动容器一并同步
            noteInput();
            await page.evaluate((x, y, inner) => {
              window.__xyMirroring = Date.now(); // 镜像写入窗口：ping 侧不再回推
              try { window.scrollTo(x, y); } catch (e) {}
              for (const s of (inner || [])) {
                try {
                  const el = window.__xy ? window.__xy.find(s[0]) : null;
                  if (el) { el.scrollTop = s[1]; el.scrollLeft = s[2]; }
                } catch (e) {}
              }
            }, m.x || 0, m.y || 0, m.inner || []).catch(() => {});
            // 键同步：服务端镜像后的页面滚动钩子会产出同位置 ping，
            // 去重键先记为本次上报值，避免 RTT 后回拽
            lastScrollKey = (m.x || 0) + ',' + (m.y || 0) + ',' + JSON.stringify(m.inner || []);
            break;
          }
        }
  };
  const handleRaw = async (raw) => {
    if (dead) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    try {
      await handleCommand(m);
    } catch (e) { sendJson({ type: 'error', msg: '事件处理异常: ' + e.message }); }
  };
  let cmdChain = Promise.resolve();
  const enqueue = (raw) => { cmdChain = cmdChain.then(() => handleRaw(raw)).catch(() => {}); };
  ws.on('message', (raw) => { if (dispatchReady) enqueue(raw); else queue.push(Buffer.from(raw)); });
  const noteInput = () => { lastInputAt = Date.now(); };
  ws.on('resume', () => {
    if (!dispatchReady) return; // 初始化中的会话仍由首次快照完成同步
    cmdChain = cmdChain.then(async () => {
      if (dead || ws.readyState !== 1) return;
      if (domStarting) await domStarting;
      sendJson({ type: 'meta', w: viewW, h: viewH, title: await page.title(), maxSessions: MAX_SESSIONS, mode, prod: prodMode });
      structBuf.clear(); lastPatchSent.clear();
      clearTimeout(fullDebounceT); fullDebounceT = null; lastFullDoneAt = 0;
      await startDomMirror();
      sendJson({ type: 'sync-ready' });
    }).catch(() => ws.close(1011, 'resume failed'));
  });


  // ---------- DOM 镜像通道 ----------
  let domActive = false, domExposed = false;
  let DPR = 1;
  let viewW = VIEW_W, viewH = VIEW_H;
  let pendingFrame = null, lastFrameAt = 0, lastFrameAt2 = 0; // 合成器帧回调缓存（编码-解码范式帧源）
  let domStartAt = 0; // 全量快照起点（死锁自愈计时）
  let patchChain = Promise.resolve();

  let domStarting = null;
  // 全链路超时：截图/evaluate 在复杂页面可能挂起（实测 34 秒死锁——domStarting
  // 永真 → 差分循环被 guard 跳过 → 视觉更新全停，直到全量重同步偶然复活）。
  // 所有重操作的 await 必须有超时兜底。
  const withTimeout = (p2, ms, tag2) => Promise.race([
    p2,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + (tag2 || 'op'))), ms)),
  ]);
  let lastFullDoneAt = 0, fullDebounceT = null, pendingFull = false;
  function startDomMirror() {
    if (dead || ws.readyState !== 1) return Promise.resolve();
    // 重入保护：多个调用点（模式切换/交互回退/补丁重同步）可能并发到达；
    // 两个 snapshotTiles 在同一 live 页上交错会让彼此的底板含占位空白。
    // 被吞触发必须补发（pendingFull）：full 补丁（如 head 注入懒加载样式表的
    // noPath:HEAD）到达时若正有快照在飞，直接 return 会把触发消费掉且无人重排
    // ——实测 Assistant css 注入被吞一次后镜像动画样式永久缺失。
    if (domStarting) { pendingFull = true; return domStarting; }
    // 防抖：SPA 登录/路由切换会连发全量触发（head 注入样式 noPath:HEAD、
    // +600/+1500ms 导航重试、补丁 miss 客户端重同步），实测 4 秒内 6 次全量
    // 快照——重建窗口互相吞点击、镜像反复闪旧页。700ms 窗口内合并为一次。
    const since = Date.now() - lastFullDoneAt;
    if (since < 700) {
      if (!fullDebounceT) {
        fullDebounceT = setTimeout(() => { fullDebounceT = null; startDomMirror(); }, 700 - since + 30);
      }
      return Promise.resolve();
    }
    domStartAt = Date.now();
    logger.log('[dbg] startDomMirror <- ' + (new Error().stack.split('\n')[2] || '?').trim().replace(/^at /, ''));
    domStarting = (async () => {
      try { await doStartDomMirror(); }
      finally {
        domStarting = null; lastFullDoneAt = Date.now();
        if (pendingFull) {
          pendingFull = false;
          fullDebounceT = setTimeout(() => { fullDebounceT = null; startDomMirror().catch(() => {}); }, 60);
        }
      }
    })();
    return domStarting;
  }
  async function doStartDomMirror() {
    await page.evaluate(PAGE_HELPERS);
    if (obfSess && mode === 'dom') {
      // 编码表注入源站页（sanitizeClone 序列化时置换文本码点）
      await page.evaluate((m) => { window.__xyObfMap = m; }, obfSess.plain).catch(() => {});
    }
    if (!domExposed) {
      await page.exposeFunction('__xyPatch', (patches) => {
        if (!domActive || ws.readyState !== 1) return;
        // 串行化处理，避免并发截图竞态
          patchChain = patchChain.then(async () => {
          try {
            // 轻量主题补丁：html class 变更直改镜像根类名，不进重同步链
            const dcPatch = patches.find(p => p && p.docClass !== undefined);
            if (dcPatch) sendJson({ type: 'doc-class', cls: dcPatch.docClass });
            const rest = patches.filter(p => p && p.docClass === undefined);
            if (!rest.length) return;
            if (rest.some(p => p && p.full)) {
              logger.log('[dbg] full patch why:', patches.filter(p => p && p.full).map(p => p.why || '?').slice(0, 3).join(' | ').slice(0, 200));
              // 全量重同步也必须走瓦片化路径（明文快照在瓦片模式下是防御漏洞）
              await startDomMirror();
              return;
            }
            // v3：dom 与 frame 同路径——结构+瓦片补丁（均零明文）。60ms 合并窗 +
            // 同路径去重（流式回复逐字变更只保留最新态），每批一次整页截图统一
            // tileize。事件驱动：静止页零消息、零流量，不存在任何帧率概念。
            for (const p of rest) {
              if (!p || p.path === undefined) continue;
              // outer 含子树：同路径 outer 与 inner 在合并窗内相遇时保留 outer
              const kind2 = (p.outer !== undefined) ? 'outer' : 'inner';
              if (kind2 === 'inner' && structBuf.get(p.path) === 'outer') continue;
              structBuf.set(p.path, kind2);
            }
            if (structTimer) return;
            structTimer = setTimeout(async () => {
              structTimer = null;
              if (dead || ws.readyState !== 1) { structBuf.clear(); return; }
              const batch = [...structBuf.entries()].map(([path, kind2]) => ({ path, [kind2]: 1 }));
              structBuf.clear();
              // 异步兜底：截图超时/导航销毁上下文一旦以 unhandled rejection
              // 冒泡会击穿整个网关进程（Node>=15 默认退出）
              try { await tilesPatches(batch); } catch (e) { logger.log('[patch] batch err:', e && e.message); }
            }, 60);
          } catch (e) {}
        });
      });
      try {
        await page.exposeFunction('__xyScrollPing', (st) => {
          if (!domActive || ws.readyState !== 1 || mode !== 'dom') return;
          const key = st.sx + ',' + st.sy + ',' + JSON.stringify(st.scrollers || []);
          if (key === lastScrollKey) return;
          lastScrollKey = key;
          sendJson({ type: 'scroll-sync', sx: st.sx, sy: st.sy, scrolls: st.scrollers || [] });
        });
      } catch (e) {}
      domExposed = true;
    }
    domActive = true;
    // observer 先挂后拍（关键顺序）：原实现快照之后才挂 observer，快照期间二次
    // 导航（POST→302→落地页）会让快照发出旧内容且新文档上无任何 observer——
    // 该会话从此零补丁零触发（实测 css 永久冻结的一种成因）。先挂可观测窗口
    // 覆盖整个快照期；PAGE_HELPERS 注入加超时防导航竞态悬挂。
    await withTimeout(page.evaluate(PAGE_HELPERS), 8000, 'helpers').catch((e) => {
      logger.log('[dom   ] helpers inject fail:', e && e.message);
    });
    await page.evaluate(() => {
      if (window.__xyObs) window.__xyObs.disconnect();
      window.__xyObs = new MutationObserver((recs) => {
        const out = [];
        for (const r of recs) { try { const p2 = window.__xy.patchOf(r); if (p2) out.push(p2); } catch (e) {} }
        if (out.length) window.__xyPatch(out);
      });
      window.__xyObs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    }).catch(() => {});
    // v4：dom 快照零截图（文本/输入框外观由客户端原生渲染，字体由源站 CSS 自带）。
    // frame 模式仍需整页截图作条带底板。
    await page.evaluate((d) => { window.__xyDpr = d; }, DPR);
    if (mode === 'frame') {
      try {
        const shotF = await withTimeout(cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }), 8000, 'frameSheet');
        await page.evaluate((b64) => { window.__xyFrameShot = b64; }, shotF.data);
      } catch (e) { await page.evaluate(() => { window.__xyFrameShot = null; }).catch(() => {}); }
    }
    const snap = await withTimeout(page.evaluate((wf) => window.__xy.snapshotReal(wf), mode === 'frame'), 10000, 'snapshot');
    try {
      const diag = await page.evaluate(() => window.__xyCssDiag || null);
      if (diag) logger.log(`[snapcss] ${diag.url} links=${diag.hrefs.length}(${diag.hrefs.map(h => h.split('/').pop()).join(',')}) kf=${diag.kf} cssLen=${diag.styleLen + diag.linkLen}`);
    } catch (e) {}
    try {
      const foc = await page.evaluate(() => document.activeElement ? (document.activeElement.tagName + '#' + (document.activeElement.id || '')) : 'none');
      logger.log('[dom   ] post-snapshot focus:', foc);
    } catch (e) {}
    let siteFaces = '';
    if (obfSess && mode === 'dom') {
      // 网站自有 @font-face（艺术字/品牌字）：解析 family/weight/src 字体 URL，
      // 为每个字体构建 PUA 孪生（构建失败则优雅跳过——该族 PUA 文本落到栈内
      // 后续 MiSans 面，普通黑体渲染而非豆腐）
      const ent = obfSessions.get(obfSess.sid);
      const siteFonts = [];
      const ffRe = /@font-face\s*\{([^}]*)\}/g;
      let fm;
      while ((fm = ffRe.exec(snap.css)) && siteFonts.length < 6) {
        const blk = fm[1];
        const fam = (blk.match(/font-family\s*:\s*['"]?([^;'"]+?)['"]?\s*(?:;|$)/) || [])[1];
        let url = (blk.match(/src\s*:[^;]*?url\((['"]?)([^)'"]+?\.(?:woff2|woff|ttf|otf))\1/i) || [])[2];
        if (!fam || !url || /^data:/i.test(url)) continue;
        try { url = new URL(url, sessionOrigin).href; } catch (e) { continue; }
        const wRaw = ((blk.match(/font-weight\s*:\s*([^;]+)/) || [])[1] || '400').trim();
        const w = /^\d+$/.test(wRaw) ? wRaw : '400';
        if (siteFonts.some(x => x.fam === fam && x.w === w)) continue;
        siteFonts.push({ fam, w, url });
      }
      const built = [];
      for (const sf of siteFonts) {
        const buf = await buildObfTwin(ent, sf.url);
        if (buf && buf.length > 500) built.push({ fam: sf.fam, w: sf.w, buf });
      }
      if (built.length) {
        ent.siteFonts = built;
        siteFaces = built.map((x, i) =>
          '@font-face{font-family:"' + x.fam.replace(/"/g, '') + '";src:url(/m/obf/' + obfSess.sid + '/site-' + i + '.woff2) format("woff2");font-weight:' + x.w + ';font-display:block;unicode-range:U+F0000-10FFFF}').join('');
        logger.log(`[obf   ] site-font twins: ${built.map(x => x.fam + '/' + Math.round(x.buf.length / 1024) + 'KB').join(', ')}`);
      } else ent.siteFonts = null;
    }
    const obfCssBlock = (obfSess && mode === 'dom') ? (obfFacesCss(obfSess.sid, obfFamiliesFromCss(snap.css)) + siteFaces) : '';
    const cssFixed = snap.css.replace(/url\((['"]?)\//g, 'url($1/m/') + obfCssBlock;
    const payload = JSON.stringify({ type: 'dom-snapshot', css: cssFixed, html: snap.html, title: snap.title, w: viewW, h: viewH, tiles: snap.tiles || [], frame: snap.frame || null, docClass: snap.docClass || '', docAttrs: snap.docAttrs || '', sx: snap.sx || 0, sy: snap.sy || 0, scrollers: snap.scrollers || [] });
    ws.send(payload);
    ws._bytes = (ws._bytes || 0) + payload.length;
    ws._chunks = (ws._chunks || 0) + 1;
    logger.log('[dom   ] mirror started');
    lastCssSig = null; // 快照即最新基线，下一拍重定（含懒加载样式表）
    // v3：dom 模式无帧流（客户端本地渲染，更新全部事件驱动——补丁/滚动同步/
    // canvas 元素捕获）；帧差分通道仅属于显式 frame（像素直出）模式
    if (mode === 'frame') {
      startDiffLoop();
      // captureBeyondViewport 截图会中断 Page.screencast 帧流——重启
      cdp.send('Page.stopScreencast').catch(() => {});
      setTimeout(() => { if (mode === 'frame') cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }).catch(() => {}); }, 80);
    } else {
      if (canvasSigsReset) canvasSigsReset(); // 重同步后旧基准必然失配（防"画面变化但比对为同"冻结）
      startCanvasWatch();
    }
  }

  // 结构+瓦片补丁（v3）：一批变更合并为一次整页截图；每个变更子树在页面内
  // tileize（文本→带服务端像素背景的等大占位，元素锚定）后以 inner/outer 下发。
  // 客户端替换后瓦片随镜像文档流排版——无坐标、无图层、无帧率，零明文。
  async function tilesPatches(patches) {
    if (patches.some(p => p && p.full)) { await startDomMirror(); return; }
    // 祖先后代去重：祖先 innerHTML 已含后代最终态；按深度排序祖先优先，
    // 后到的祖先会移除已收入的其后代
    const sorted = [...patches].filter(p => p && p.path !== undefined && (p.inner !== undefined || p.outer !== undefined))
      .sort((a, b) => String(a.path).split('/').length - String(b.path).split('/').length);
    const items = [];
    for (const p of sorted) {
      const pp = String(p.path);
      if (items.some(q => pp === q.path || pp.startsWith(q.path + '/'))) continue;
      for (let k = items.length - 1; k >= 0; k--) {
        if (items[k].path.startsWith(pp + '/')) items.splice(k, 1);
      }
      items.push({ path: pp, outer: p.outer !== undefined ? 1 : undefined, inner: p.outer !== undefined ? undefined : 1 });
    }
    if (!items.length) return;
    const out = await withTimeout(page.evaluate((list) => {
      const out2 = [];
      for (const it of list) {
        try {
          let live = window.__xy.find(it.path);
          if (!live) continue;
          if (live.nodeType === 3) live = live.parentElement;
          if (!live || live.nodeType !== 1) continue;
          const cl = window.__xy.sanitizeClone(live);
          const html = (it.outer !== undefined) ? cl.outerHTML : cl.innerHTML;
          if (html) out2.push((it.outer !== undefined) ? { path: it.path, outer: html } : { path: it.path, inner: html });
        } catch (e) {}
      }
      return out2;
    }, items), 5000, 'patchReal').catch((e) => { logger.log('[patch] real err:', e && e.message); return null; });
    if (!out || !out.length) return;
    if (ws.readyState !== 1) return;
    // 轮询自更新常产生逐字节相同的结果（像素一致 → data URL 一致）：
    // 与上次已下发比对，全同批次直接跳过（省带宽与客户端重排）
    if (lastPatchSent.size > 500) lastPatchSent.clear();
    const out2 = out.filter(p => {
      const key = (p.outer !== undefined ? 'o:' : 'i:') + p.path;
      const html = p.outer !== undefined ? p.outer : p.inner;
      if (lastPatchSent.get(key) === html) return false;
      lastPatchSent.set(key, html);
      return true;
    });
    if (!out2.length) return;
    const payload = JSON.stringify({ type: 'dom-patches', patches: out2 });
    ws.send(payload);
    ws._bytes = (ws._bytes || 0) + payload.length;
    ws._chunks = (ws._chunks || 0) + 1;
  }

  // v3 dom 模式：canvas 元素按需捕获。仅当页面存在视口内 canvas 时才截图，
  // 且逐元素比对像素（sharp raw 或字节级），无变化零下发——静止 canvas（软件
  // GL 下的 WebGL）零流量，动画 canvas 以 ~2fps 元素级小图跟随。绝不整页推流。
  function startCanvasWatch() {
    if (canvasTimer) return;
    const lastSigs = new Map();
    canvasSigsReset = () => lastSigs.clear();
    canvasTimer = setInterval(async () => {
      if (mode !== 'dom' || !domActive || dead || !page || !cdp || ws.readyState !== 1) return;
      try {
        const list = await withTimeout(page.evaluate(() => {
          const out = [];
          try {
            for (const c of document.body.querySelectorAll('canvas')) {
              const r = c.getBoundingClientRect();
              if (r.width < 8 || r.height < 8) continue;
              if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
              const path = window.__xy.pathOf(c);
              if (path === null) continue;
              out.push({ path, x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height });
              if (out.length >= 3) break;
            }
          } catch (e) {}
          return out;
        }), 1500, 'canvasList').catch(() => null);
        if (!list) return;
        if (!list.length) { if (lastSigs.size) lastSigs.clear(); return; }
        // rAF 活动门：260ms 窗口零回调 = 动画循环完全停转，canvas 必然静止，
        // 零捕获（静止 canvas 的持续捕获曾是 CPU 大头：实测 34-47%）
        const rafDelta = await withTimeout(page.evaluate(() => new Promise((res2) => {
          const before = window.__xyRafCount || 0;
          setTimeout(() => res2((window.__xyRafCount || 0) - before), 260);
        })), 1500, 'rafGate').catch(() => 1);
        if (rafDelta === 0) return;
        const nowMs = Date.now();
        for (const it of list) {
          // 未变化画布指数退避：450ms→900→1800→3600 封顶；一变化即复位
          const st0 = lastSigs.get(it.path);
          if (st0 && st0.nextAt && nowMs < st0.nextAt) continue;
          const shot = await withTimeout(cdp.send('Page.captureScreenshot', {
            format: 'png',
            clip: { x: it.x, y: it.y, width: it.w, height: it.h, scale: DPR },
            captureBeyondViewport: true,
          }), 3000, 'canvasShot').catch(() => null);
          if (!shot) continue;
          let changed = true;
          try {
            if (sharp) {
              const { info, data } = await sharp(Buffer.from(shot.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
              const prev = lastSigs.get(it.path);
              if (prev && prev.w === info.width && prev.h === info.height && prev.data && prev.data.equals(data)) changed = false;
              else if (prev) { prev.w = info.width; prev.h = info.height; prev.data = data; }
              else lastSigs.set(it.path, { w: info.width, h: info.height, data, unchanged: 0, nextAt: 0 });
            } else {
              const prev = lastSigs.get(it.path);
              if (prev && prev.b64 === shot.data) changed = false;
              else if (prev) prev.b64 = shot.data;
              else lastSigs.set(it.path, { b64: shot.data, unchanged: 0, nextAt: 0 });
            }
          } catch (e) {}
          if (!changed) {
            const st = lastSigs.get(it.path);
            if (st) { st.unchanged = (st.unchanged || 0) + 1; st.nextAt = Date.now() + Math.min(3600, 450 * Math.pow(2, st.unchanged)); }
            continue;
          }
          const st2 = lastSigs.get(it.path);
          if (st2) { st2.unchanged = 0; st2.nextAt = 0; }
          if (ws.readyState === 1) {
            const pl = JSON.stringify({ type: 'canvas-tile', path: it.path, url: 'data:image/png;base64,' + shot.data });
            ws.send(pl);
            ws._bytes = (ws._bytes || 0) + pl.length;
            ws._chunks = (ws._chunks || 0) + 1;
          }
        }
      } catch (e) {}
    }, 450);
  }

  async function stopDomMirror() {
    domActive = false;
    try { await page.evaluate(() => { if (window.__xyObs) { window.__xyObs.disconnect(); window.__xyObs = null; } }); } catch {}
  }

  // 动画/悬停跟随：视口差分循环（dom 模式）。全量快照/交互重同步期间跳过，
  // 首帧只建基准；无变化零下发。瓦片为不透明底板裁片，位移动画的新旧位置都在
  // 差分区域内，客户端直接覆盖即可，无需清理旧瓦片。
  function startDiffLoop() {
    // 编码-解码范式差分通道 v2（仅 frame 像素直出模式）：合成器帧回调 → sharp
    // 进程内解码/比较/裁剪/编码。dom 模式不进入此通道——dom 是客户端本地渲染，
    // 更新全部事件驱动（补丁/滚动/元素捕获），不存在帧率。
    if (diffTimer || mode !== 'frame') return;
    if (mode === 'frame') {
      cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }).catch(() => {});
    }
    let prevRaw = null, prevW = 0, prevH = 0;   // 上一帧 raw 像素（BGRA）
    let lastAnnSX = 0, lastAnnSY = 0, lastScrolls = '[]', lastHoles = '[]';
    let metaAt = 0, meta = { holes: [], scrollers: [], sx: 0, sy: 0 };

    const diffFrame = async (b64) => {
      if (!sharp) return null;
      // ensureAlpha：合成器 PNG 可能为 3 通道（RGB），Uint32 视图按 4 字节/像素索引
      // 会越界读 undefined → 恒等误判（实测 tiles=0 的根因）。恒定 RGBA 后视图对齐。
      const framePng = Buffer.from(b64, 'base64');
      const img = sharp(framePng).ensureAlpha();
      const { info, data } = await img.raw().toBuffer({ resolveWithObject: true });
      const W = info.width, H = info.height, CH = info.channels;
      if (!prevRaw || prevW !== W || prevH !== H) {
        prevRaw = data; prevW = W; prevH = H;
        return { tiles: [], full: true };
      }
      // 逐像素比较找脏行/列（Uint32 视图加速；行级先筛再列级细化）
      const dirtyRows = new Uint8Array(H);
      let any = false;
      const a = new Uint32Array(data.buffer, data.byteOffset, (data.length / 4) | 0);
      const b = new Uint32Array(prevRaw.buffer, prevRaw.byteOffset, (prevRaw.length / 4) | 0);
      const w32 = W >> 2; // 每行 Uint32 数（4 像素/步，TH 兜底用通道级复检）
      for (let y = 0; y < H; y++) {
        const off = y * W;
        for (let x = 0; x < W; x++) {
          if (a[off + x] !== b[off + x]) {
            // Uint32 不等但可能只是 alpha 位——通道级复检（阈值 2）
            const p = (off + x) * CH, q = p - CH + 3;
            void q;
            const dd = data, pp = prevRaw;
            if (Math.abs(dd[p] - pp[p]) > 2 || Math.abs(dd[p + 1] - pp[p + 1]) > 2 || Math.abs(dd[p + 2] - pp[p + 2]) > 2) { dirtyRows[y] = 1; any = true; break; }
          }
        }
      }
      prevRaw = data; prevW = W; prevH = H;
      if (!any) return { tiles: [] };
      // 行程合并成矩形（按连续脏行段，列取整行宽——screencast 帧内横向裁剪收益小
      // 且增加编码次数；行段合并上限 8 段防碎片）
      const rects = [];
      let y0 = -1;
      for (let y = 0; y <= H; y++) {
        const d2 = y < H && dirtyRows[y];
        if (d2 && y0 < 0) y0 = y;
        else if (!d2 && y0 >= 0) { rects.push([0, y0, W, y - y0]); y0 = -1; }
      }
      if (rects.length > 8) {
        // 合并为整帧一张
        rects.length = 0;
        rects.push([0, 0, W, H]);
      }
      const tiles = [];
      for (const [rx, ry, rw, rh] of rects) {
        if (rw < 2 || rh < 2) continue;
        const png = await frameCropInput(sharp, framePng, { info, data }).extract({ left: rx, top: ry, width: rw, height: rh }).png({ compressionLevel: 3 }).toBuffer();
        tiles.push({ w: rw, h: rh, cssX: Math.round(rx / DPR) + Math.round(meta.sx || 0), cssY: Math.round(ry / DPR) + Math.round(meta.sy || 0), cssW: rw / DPR, cssH: rh / DPR, url: 'data:image/png;base64,' + png.toString('base64') });
      }
      return { tiles };
    };

    const fetchMeta = async (inputActive) => {
      // 轻量 evaluate：只拿 holes/scrollers/scroll 位置（无大参数）
      try {
        const r = await Promise.race([
          page.evaluate((ia) => {
            const out = { holes: [], scrollers: [], sx: window.scrollX, sy: window.scrollY };
            try { out.scrollers = window.__xy.scrollers(); } catch (e) {}
            try {
              const maskAnims = true;
              let area = 0;
              const push = (r2, el) => {
                if (r2.width < 2 || r2.height < 2) return;
                if (el && (el.textContent || '').trim()) return;
                const d = window.__xyDpr || 1;
                const x0 = Math.max(0, Math.floor(r2.left * d)), y0 = Math.max(0, Math.floor(r2.top * d));
                const W2 = window.innerWidth * d, H2 = window.innerHeight * d;
                const x1 = Math.min(W2, Math.ceil((r2.left + r2.width) * d)), y1 = Math.min(H2, Math.ceil((r2.top + r2.height) * d));
                if (x1 <= x0 || y1 <= y0) return;
                out.holes.push([Math.round(x0 / d) + Math.round(window.scrollX), Math.round(y0 / d) + Math.round(window.scrollY), Math.round((x1 - x0) / d), Math.round((y1 - y0) / d)]);
                area += (x1 - x0) * (y1 - y0);
              };
              for (const a2 of document.getAnimations()) {
                if (a2.playState !== 'running') continue;
                const el = a2.effect && a2.effect.target;
                if (!el || !el.getBoundingClientRect) continue;
                if (el.querySelector && el.querySelector('canvas, svg, video, iframe')) continue;
                push(el.getBoundingClientRect(), el);
              }
              const ae = document.activeElement;
              if (ia && ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && !ae.disabled) push(ae.getBoundingClientRect(), null);
              if (area > window.innerWidth * window.innerHeight * 0.8) out.holes = [];
            } catch (e) {}
            return out;
          }, inputActive),
          new Promise((_, rej) => setTimeout(() => rej(new Error('meta timeout')), 1500)),
        ]).catch(() => null);
        if (r) meta = r;
      } catch (e) {}
    };
    let pfSeen = 0, pfLogged = 0;
    diffTimer = setInterval(async () => {
      if (diffBusy) return;
      if (dead || mode !== 'frame' || !domActive || !page || !cdp || ws.readyState !== 1) return;
      pfSeen++; if (pfSeen % 62 === 0) { logger.log('[diffv2] tick ok, pfLogged=' + pfLogged); pfLogged = 0; }
      if (domStarting) {
        if (!domStartAt) domStartAt = Date.now();
        else if (Date.now() - domStartAt > 8000) { domStarting = null; domStartAt = 0; }
        else return;
      } else domStartAt = 0;
      const pf = pendingFrame;
      pendingFrame = null;
      // 帧流 watchdog：有活动（近期输入/动画周期内）但 5 秒无帧 = 帧流已断，重启
      if (!pf) {
        if (Date.now() - lastFrameAt2 > 5000 && (Date.now() - lastInputAt) < 60000) {
          lastFrameAt2 = Date.now();
          cdp.send('Page.stopScreencast').catch(() => {});
          cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }).catch(() => {});
          logger.log('[diffv2] screencast watchdog restarted');
        }
        return;
      }
      lastFrameAt2 = Date.now();
      pfLogged++;
      diffBusy = true;
      try {
        // 每 ~200ms 刷新一次 meta（holes/scrollers/scroll）
        const now = Date.now();
        if (now - metaAt > 200) { metaAt = now; fetchMeta(!!lastInputAt && (Date.now() - lastInputAt < 800)); }
        const out = await diffFrame(pf.data).catch((e2) => { logger.log('[diffv2] frame err:', e2 && e2.message); return null; });
        if (!out) return;
        const holesNow = JSON.stringify(meta.holes || []);
        const holesMoved = holesNow !== lastHoles;
        const scrollsNow = JSON.stringify(meta.scrollers || []);
        const innerMoved = scrollsNow !== lastScrolls;
        const scrollMoved = Math.abs((meta.sx || 0) - lastAnnSX) > 1 || Math.abs((meta.sy || 0) - lastAnnSY) > 1;
        if ((out.tiles && out.tiles.length) || scrollMoved || innerMoved || holesMoved) {
          const payload = JSON.stringify({ type: 'anim-tiles', tiles: out.tiles || [], holes: meta.holes || [], sx: meta.sx || 0, sy: meta.sy || 0, scrolls: meta.scrollers || [] });
          if (ws.readyState === 1) {
            ws.send(payload);
            ws._bytes = (ws._bytes || 0) + payload.length;
            ws._chunks = (ws._chunks || 0) + 1;
            lastAnnSX = meta.sx || 0; lastAnnSY = meta.sy || 0; lastScrolls = scrollsNow; lastHoles = holesNow;
          }
        }
      } catch (e) {}
      finally { diffBusy = false; }
    }, 16);
  }

  try {
    const b = await launchSessionBrowser();
    if (dead) { await b.close(); return; }
    sessionBrowser = b;
    b.on('disconnected', () => {
      if (dead) return;
      sendJson({ type: 'error', code: 'SESSION_EXPIRED', terminal: true, msg: '服务端浏览器已关闭，请核对上次提交结果后重新开始' });
      ws.close(1011, 'browser closed');
    });
    page = await b.newPage();
    if (dead) { await page.close(); return; }
    cdp = await page.createCDPSession();
    if (dead) return;
    // 临时诊断：会话页面的 API 请求状态（定位登录后数据不加载问题）
    page.on('response', (r) => {
      try {
        const u = r.url();
        if (r.status() >= 300 || /assistant|api|auth/.test(u)) {
          logger.log('[net   ]', r.status(), r.request().method(), u.slice(0, 90));
        }
      } catch (e) {}
    });
    page.on('pageerror', (e) => { try { logger.log('[pageerr]', String(e && e.message).slice(0, 140)); } catch (e2) {} });

    cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
      try {
        const now = Date.now();
        if (lastInputAt) { inputLatMs = now - lastInputAt; lastInputAt = 0; }
        frameTimes.push(now);
        // 编码-解码范式（frame 模式）：合成器每帧变化即推（60fps 帧回调驱动差分）。
        // 帧存 pendingFrame，差分循环 32ms 消费；立即 ack 保持帧流。
        // 静止时无帧 = 零 CPU 零流量。dom 模式不订阅帧流，不会走到这里。
        pendingFrame = { data, at: now };
        setTimeout(() => { cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {}); }, 0);
      } catch (e) { /* session may be closing */ }
    });

    statTimer = setInterval(() => {
      if (dead || ws.readyState !== 1) return;
      const now = Date.now();
      frameTimes = frameTimes.filter(t => now - t < 1000);
      const mr = (ws._chunks || 0) - statLastChunks; statLastChunks = ws._chunks || 0;
      // v3：dom 无帧流——上报下行消息速率（帧语义只属于像素流模式）；
      // 每秒兜底触发一次滚动同步 ping（捕获监听遗漏的初始态/漂移）
      if (mode === 'dom' && domActive) { page.evaluate(() => { if (window.__xyScrollPingNow) window.__xyScrollPingNow(true); }).catch(() => {}); }
      // 结构指纹 + CSS 集合指纹（必须在 .then 内取值再上报：elCount 闭包竞态
      // 曾使 sstats.els 恒为 0、客户端 els-drift 重同步雷达整体失活）。
      // CSS 兜底：SPA 懒加载样式表注入 head 可能错过 observer（导航竞态/触发
      // 被吞）——实测 Assistant css（17 个入场 keyframes）不下发则镜像动画全灭。
      // 集合变化即触发全量重同步；成功快照后由 doStartDomMirror 重定基线，
      // 失败则保持脏态每秒重试，不提前更新基线。
      if ((mode === 'dom' || mode === 'frame') && domActive && !domStarting) {
        page.evaluate(() => document.body ? document.body.querySelectorAll(':not(script):not(noscript):not(template)').length : 0)
          .then(async (n) => {
            let sig = null;
            try {
              sig = await page.evaluate(() => {
                const links = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href')).filter(Boolean);
                return links.join('|') + '#' + document.querySelectorAll('style').length;
              });
            } catch (e) {}
            if (sig !== null) {
              if (lastCssSig === null) lastCssSig = sig;
              else if (sig !== lastCssSig) {
                logger.log('[snapcss] set changed:', String(lastCssSig).slice(0, 90), '->', sig.slice(0, 90));
                startDomMirror().catch(() => {});
              }
            }
            sendJson({ type: 'sstats', fps: frameTimes.length, mr, inLat: inputLatMs, mode, els: n });
          })
          .catch(() => sendJson({ type: 'sstats', fps: frameTimes.length, mr, inLat: inputLatMs, mode, els: 0 }));
      } else {
        sendJson({ type: 'sstats', fps: frameTimes.length, mr, inLat: inputLatMs, mode, els: 0 });
      }
    }, 1000);

    // 主框架导航（登录跳转/表单提交等）：重新注入镜像管线并全量重发，
    // 否则登录成功跳转后镜像冻结在旧页面（访客视角=点了没反应）。
    // SPA 登录后是异步引导：立即快照只拍到骨架，内容 1-3 秒后才到——
    // 补丁路径与骨架代理碰撞错位且不报 miss。导航后 +2.5s/+7s 定时重拍兜底。
    page.on('framenavigated', (frame) => {
      try {
        if (frame !== page.mainFrame()) return;
        if (!domActive || ws.readyState !== 1) return;
        navChain = navChain.then(async () => {
          try {
            await page.evaluate(PAGE_HELPERS).catch(() => {});
            if (mode === 'dom' || mode === 'frame') await startDomMirror();
            for (const d of [600, 1500]) {
              setTimeout(() => {
                if (dead || !domActive || ws.readyState !== 1) return;
                startDomMirror().catch(() => {});
              }, d);
            }
          } catch (e) {}
        });
      } catch (e) {}
    });
    let navChain = Promise.resolve();

    // 等客户端上报 DPR（超时回落 1）：服务端按访客 DPR 渲染 → 瓦片 1:1 显示 → 构造性一致
    const hello = await new Promise((res) => {
      cancelHello = () => res({ dpr: 1 });
      if (dead) { cancelHello(); return; }
      const t = setTimeout(() => { clearInterval(helloIv); res({ dpr: 1 }); }, 3000);
      helloIv = setInterval(() => {
        const i = queue.findIndex((r) => { try { return JSON.parse(r.toString()).type === 'hello'; } catch { return false; } });
        if (i >= 0) {
          clearInterval(helloIv); clearTimeout(t);
          try { res(JSON.parse(queue.splice(i, 1)[0].toString())); } catch { res({ dpr: 1 }); }
        }
      }, 100);
    });
    if (dead) return;
    DPR = Math.max(1, Math.min(3, parseFloat(hello.dpr) || 1));
    // 首次 hello 同时带回访客视口：服务端按访客真实视口渲染，镜像才与直连构图一致
    if (hello.w) viewW = Math.max(320, Math.min(2560, parseInt(hello.w, 10) || viewW));
    if (hello.h) viewH = Math.max(240, Math.min(1600, parseInt(hello.h, 10) || viewH));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewW, height: viewH, deviceScaleFactor: DPR, mobile: false });
    await page.goto(sessionOrigin, { waitUntil: 'networkidle0', timeout: 20000 });
    sendJson({ type: 'meta', w: viewW, h: viewH, title: await page.title(), maxSessions: MAX_SESSIONS, mode, prod: prodMode });
    if (mode === 'dom' || mode === 'frame') await startDomMirror();

    dispatchReady = true;
    for (const raw of queue.splice(0)) enqueue(raw);
    sendJson({ type: 'sync-ready' });

  } catch (e) {
    sendJson({ type: 'error', msg: '会话建立失败: ' + e.message });
    try { await cleanup(); } catch {}
    try { ws.close(); } catch {}
  }
}

async function revokeSessions(selected) {
  const pending = [];
  for (const session of selected) {
    const socket = session.socket;
    session.close(1008, 'session revoked');
    socket?.terminate();
    const lifecycle = sessionLifecycles.get(session);
    pending.push(lifecycle?.task, lifecycle?.cleanup());
  }
  await Promise.allSettled(pending);
  return selected.length;
}

async function revokeSession(token) {
  if (typeof token !== 'string' || !token.trim()) throw new TypeError('token must be a non-empty string');
  const session = sessionStore.entries.get(token);
  return (await revokeSessions(session ? [session] : [])) > 0;
}

async function revokeIdentity(identity) {
  if (typeof identity !== 'string' || !identity.trim()) throw new TypeError('identity must be a non-empty string');
  const selected = [...sessionStore.entries.values()].filter(session => sessionLifecycles.get(session)?.identity === identity);
  const result = revokeSessions(selected);
  // Includes authenticated transports that have not sent their first hello yet.
  for (const socket of wss.clients) {
    if (socketIdentities.get(socket) === identity) socket.terminate();
  }
  return result;
}

function close() {
  if (closePromise) return closePromise;
  closed = true;
  closePromise = (async () => {
    for (const session of [...sessionStore.entries.values()]) session.close(1001, 'mirror closing');
    for (const socket of wss.clients) socket.terminate();
    for (const request of requests) request.destroy();
    await Promise.allSettled([...sessionTasks, ...[...cleanups].map(cleanup => cleanup())]);
    await new Promise(resolve => wss.close(resolve));
    obfSessions.clear();
    obfFontCache.clear();
    obfTwinCache.clear();
    clearStaticFiles();
  })();
  return closePromise;
}

return { handleRequest, handleUpgrade, revokeSession, revokeIdentity, close };
}

module.exports = { createMirror };
