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
            else if (ch.tagName === 'INPUT') { jobs.push({ kind: 'input', node: ch, path: p }); }
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
          } else {
            const r = j.node.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            j.x = r.left + window.scrollX; j.y = r.top + window.scrollY;
            j.w = r.width; j.h = r.height;
          }
          if (j.kind === 'input' && !j.node.value && !j.node.placeholder) { continue; }
          if (j.w <= 0 || j.h <= 0) continue;
          done.add(j);
          if (j.kind === 'select') {
            // 下拉框：控件保留（交互原生化），外观与选项文字全部隐藏，瓦片作背景
            j.node.setAttribute('data-xy-sel', '1');
            j.node.style.appearance = 'none';
            j.node.style.color = 'transparent';
            j.node.style.background = 'transparent';
            for (const op of j.node.querySelectorAll('option')) op.textContent = '';
          } else {
            const sp = document.createElement('span');
            sp.style.cssText = 'display:inline-block;vertical-align:top;width:' + Math.round(j.w) + 'px;height:' + Math.round(j.h) + 'px';
            sp.setAttribute('data-xy-space', '1');
            j.parent = j.node.parentElement;
            j.parent.replaceChild(sp, j.node);
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
            const dx = Math.round((j.x - window.scrollX - q.left) * 2) / 2;
            const dy = Math.round((j.y - window.scrollY - q.top) * 2) / 2;
            if (dx || dy) { j.sp.style.position = 'relative'; j.sp.style.left = dx + 'px'; j.sp.style.top = dy + 'px'; }
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
        try { if (j.sp && j.parent) j.parent.replaceChild(j.node, j.sp); } catch (e) {}
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
      // 输入类属性剥离：placeholder 属于静态 UI 明文
      try {
        clone.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(el => el.removeAttribute('placeholder'));
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
          if (!t || t.tagName !== 'INPUT') continue;
          t.style.backgroundImage = 'url("' + j.tile.url + '")';
          t.style.backgroundSize = '100% 100%';
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
          const tpl = document.createElement('template');
          tpl.innerHTML = j.spHtml;
          t.parentNode.replaceChild(tpl.content.firstChild, t);
        } catch (e) {}
      }
      // ④ 兜底剥除：任何未被瓦片覆盖的可见文本一律清空（零明文保证）
      const stripAll = (node) => {
        for (const ch of [...node.childNodes]) {
          if (ch.nodeType === 3) { if (ch.textContent.trim()) ch.textContent = ''; }
          else if (ch.nodeType === 1 && !skipTags.has(ch.tagName) && ch.tagName !== 'SELECT') stripAll(ch);
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
      return { css: styleCss + '\\n' + linkCss, html: clone.innerHTML, title: document.title, tiles };
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
      if (!target || target === document.documentElement) return { full: true };
      const path = pathOf(target);
      if (path === null) return { full: true };
      if (record.type === 'attributes') return { path, outer: sanitizeClone(target).outerHTML };
      return { path, inner: sanitizeClone(target).innerHTML };
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
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(root, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    sendFile(req, res, file, MIME[path.extname(file)] || 'application/octet-stream',
      p === '/index.html' ? 'no-store' : 'public, max-age=3600');
  };
}

// ---------- Chromium 单例 ----------
let browser = null, launching = null;
async function getBrowser() {
  if (browser && browser.connected) return browser;
  if (launching) return launching;
  launching = (async () => {
    const b = await puppeteer.launch({
      headless: true,
      args: CHROME_ARGS,
      defaultViewport: { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1 },
    });
    b.on('disconnected', () => { console.log('[chrome] disconnected, will relaunch on demand'); browser = null; });
    console.log('[chrome] launched:', await b.version());
    return (browser = b);
  })();
  try { return await launching; } finally { launching = null; }
}

const KEYMAP = {
  Backspace: 8, Enter: 13, Tab: 9, Escape: 27, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35,
};

// ---------- HTTP + WS ----------
// /m/* —— 镜像静态资源代理（CSS/字体/图片回源拉取，仅表现层资源，无数据）
const httpOrigin = ORIGIN_BASE.protocol === 'https:' ? require('https') : require('http');
function proxyAsset(req, res) {
  const u = new URL(req.url.slice(2), ORIGIN_BASE);
  const upstream = httpOrigin.get(u, { headers: { 'user-agent': 'rbi-mirror-asset', accept: req.headers.accept || '*/*' } }, (up) => {
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
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
demoSrv.listen(DEMO_PORT, '0.0.0.0', () => console.log(`[demo  ] listening on 0.0.0.0:${DEMO_PORT}`));

http.createServer(staticHandler(path.join(__dirname, 'protected')))
  .listen(ORIGIN_PORT, '127.0.0.1', () => console.log(`[origin] protected site on 127.0.0.1:${ORIGIN_PORT} (loopback only)`));

// ---------- 会话 ----------
let sessions = 0;
wss.on('connection', async (ws) => {
  if (sessions >= MAX_SESSIONS) {
    ws.send(JSON.stringify({ type: 'error', msg: `会话已满（上限 ${MAX_SESSIONS}），请稍后再试` }));
    ws.close(); return;
  }
  sessions++;
  console.log(`[sess  ] open (${sessions}/${MAX_SESSIONS})`);

  let page = null, cdp = null, quality = 60, mode = DEFAULT_MODE;
  let ffmpeg = null, fedFrames = 0, fedBytes = 0;
  let lastAckAt = 0, lastInputAt = 0, inputLatMs = null, frameTimes = [], statTimer = null;

  const sendJson = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

  // 消息队列必须先于一切 await 挂上：ws 库不缓存无监听期间到达的消息，
  // 冷启动（Chrome 拉起数秒）期间的 hello/mode 一旦错过就永久丢失
  const queue = [];
  let dispatchReady = false;
  const handleCommand = async (m) => {
    switch (m.type) {
          case 'ping': sendJson({ type: 'pong', t: m.t }); break;
          case 'quality':
            if (mode !== 'h264') {
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
            const ok = await page.evaluate((kind, path, value) => {
              const el = window.__xy.find(path);
              if (!el) return false;
              if (kind === 'click') { el.click(); return true; }
              el.value = value;
              el.dispatchEvent(new Event(kind, { bubbles: true }));
              return true;
            }, m.kind, m.path, m.value);
            if (!ok) {
              // 瓦片模式绝不回退明文快照（防御不变式）：失败时重发整页瓦片
              if (mode === 'dom') { await startDomMirror().catch(() => {}); }
              else {
                const snap = await page.evaluate(() => window.__xy.snapshot()).catch(() => null);
                if (snap) sendJson({ type: 'dom-snapshot', css: snap.css.replace(/url\((['"]?)\//g, 'url($1/m/'), html: snap.html, title: snap.title, w: VIEW_W, h: VIEW_H });
              }
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
  ws.on('message', (raw) => { if (dispatchReady) handleRaw(raw); else queue.push(Buffer.from(raw)); });
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
  let patchChain = Promise.resolve();

  async function startDomMirror() {
    await page.evaluate(PAGE_HELPERS);
    if (!domExposed) {
      await page.exposeFunction('__xyPatch', (patches) => {
        if (!domActive || ws.readyState !== 1) return;
        // 串行化处理，避免并发截图竞态
        patchChain = patchChain.then(async () => {
          try {
            if (patches.some(p => p && p.full)) {
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
            ws.send(payload);
            ws._bytes = (ws._bytes || 0) + payload.length;
            ws._chunks = (ws._chunks || 0) + 1;
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
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await page.evaluate((d) => { window.__xyDpr = d; }, DPR);
    const snap = await page.evaluate((b64) => window.__xy.snapshotTiles(b64), shot.data);
    const cssFixed = snap.css.replace(/url\((['"]?)\//g, 'url($1/m/');
    const payload = JSON.stringify({ type: 'dom-snapshot', css: cssFixed, html: snap.html, title: snap.title, w: VIEW_W, h: VIEW_H, tiles: snap.tiles || [] });
    ws.send(payload);
    ws._bytes = (ws._bytes || 0) + payload.length;
    ws._chunks = (ws._chunks || 0) + 1;
    await page.evaluate(() => {
      if (window.__xyObs) window.__xyObs.disconnect();
      window.__xyObs = new MutationObserver((recs) => {
        if (window.__xyBusy) return; // 位图化期间的替换/还原不产生补丁
        const out = [];
        for (const r of recs) out.push(window.__xy.patchOf(r));
        window.__xyPatch(out);
      });
      window.__xyObs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    console.log('[dom   ] mirror started');
  }

  // 变化补丁：对每个变化元素按当前 DPR 重裁瓦片，整块替换（文字/外观均为服务端像素）
  async function tilesPatches(patches) {
    if (patches.some(p => p && p.full)) { await startDomMirror(); return; }
    const out = [];
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
        if (!rect) continue;
        const shot = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: DPR },
          captureBeyondViewport: true,
        });
        const sw = Math.max(1, Math.round(rect.w * DPR)), sh = Math.max(1, Math.round(rect.h * DPR));
        if (rect.isSel) {
          out.push({ path: p.path, selTile: { w: sw, h: sh, url: 'data:image/png;base64,' + shot.data } });
        } else {
          out.push({ path: p.path, tile: { w: sw, h: sh, cssX: Math.round(rect.x * DPR) / DPR, cssY: Math.round(rect.y * DPR) / DPR, cssW: sw / DPR, cssH: sh / DPR, url: 'data:image/png;base64,' + shot.data } });
        }
      } catch (e) {}
    }
    if (!out.length) return;
    const payload = JSON.stringify({ type: 'dom-patches', patches: out });
    ws.send(payload);
    ws._bytes = (ws._bytes || 0) + payload.length;
    ws._chunks = (ws._chunks || 0) + 1;
  }

  async function stopDomMirror() {
    domActive = false;
    try { await page.evaluate(() => { if (window.__xyObs) { window.__xyObs.disconnect(); window.__xyObs = null; } }); } catch {}
  }

  try {
    const b = await getBrowser();
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

    // 等客户端上报 DPR（超时回落 1）：服务端按访客 DPR 渲染 → 瓦片 1:1 显示 → 构造性一致
    const hello = await new Promise((res) => {
      const t = setTimeout(() => res({ dpr: 1 }), 3000);
      const iv = setInterval(() => {
        const i = queue.findIndex((r) => { try { return JSON.parse(r.toString()).type === 'hello'; } catch { return false; } });
        if (i >= 0) {
          clearInterval(iv); clearTimeout(t);
          try { res(JSON.parse(queue.splice(i, 1)[0].toString())); } catch { res({ dpr: 1 }); }
        }
      }, 100);
    });
    DPR = Math.max(1, Math.min(3, parseFloat(hello.dpr) || 1));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: DPR, mobile: false });
    await page.goto(ORIGIN_URL, { waitUntil: 'networkidle0', timeout: 20000 });
    await page.addStyleTag({ content: originFontCssFor() }).catch(() => {});
    sendJson({ type: 'meta', w: VIEW_W, h: VIEW_H, title: await page.title(), url: ORIGIN_URL, maxSessions: MAX_SESSIONS, mode });
    if (mode === 'dom') await startDomMirror();
    else await startScreencast();

    dispatchReady = true;
    for (const raw of queue.splice(0)) await handleRaw(raw);

    ws.on('close', async () => {
      sessions--;
      if (statTimer) clearInterval(statTimer);
      stopFFmpeg();
      await stopDomMirror().catch(() => {});
      console.log(`[sess  ] close (${sessions}/${MAX_SESSIONS})`);
      try { await page.close(); } catch {}
    });
    ws.on('error', () => {});
  } catch (e) {
    sessions--;
    sendJson({ type: 'error', msg: '会话建立失败: ' + e.message });
    try { if (page) await page.close(); } catch {}
    ws.close();
  }
});

process.on('SIGTERM', async () => {
  console.log('[main  ] SIGTERM, shutting down');
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
});
