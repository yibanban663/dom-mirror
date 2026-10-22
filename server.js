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
    async snapshotSkia() {
      window.__xyBusy = true;
      const skipTags = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'STYLE']);
      const runs = [];
      const jobs = [];
      const walk = (node, path) => {
        let idx = 0;
        for (const ch of node.childNodes) {
          // SELECT 子树不下发：option 文本由原生控件显示；占位/清空都会让控件标签消失
          if (ch.nodeType === 1 && (skipTags.has(ch.tagName) || ch.tagName === 'SELECT')) { idx++; continue; }
          const p = path === '' ? String(idx) : path + '/' + idx;
          if (ch.nodeType === 3) {
            if (!ch.textContent.trim()) { idx++; continue; }
            const run = { node: ch, path: p, parent: ch.parentElement };
            const rng = document.createRange();
            rng.selectNodeContents(ch);
            const rects = [...rng.getClientRects()];
            if (!rects.length) { jobs.push({ run, skip: true }); idx++; continue; }
            run.x = Math.min(...rects.map(r => r.left)) + window.scrollX;
            run.y = Math.min(...rects.map(r => r.top)) + window.scrollY;
            run.w = Math.max(...rects.map(r => r.right)) - Math.min(...rects.map(r => r.left));
            run.h = Math.max(...rects.map(r => r.bottom)) - Math.min(...rects.map(r => r.top));
            const cs = getComputedStyle(ch.parentElement);
            const mm = cs.color.match(/rgba?\\(([^)]+)\\)/);
            run.color = mm ? mm[1].split(',').slice(0, 3).map(v => (+v.trim()) / 255) : [0, 0, 0];
            run.size = parseFloat(cs.fontSize) || 16;
            run.bold = (+cs.fontWeight >= 600);
            run.text = ch.textContent;
            jobs.push({ run, skip: false });
          } else if (ch.nodeType === 1) {
            walk(ch, p);
          }
          idx++;
        }
      };
      walk(document.body, '');
      const mctx = document.createElement('canvas').getContext('2d');
      for (const j of jobs) {
        if (j.skip) continue;
        const r = j.run;
        mctx.font = (r.bold ? '700 ' : '400 ') + r.size + 'px "Noto Sans CJK SC", sans-serif';
        const m = mctx.measureText('汉字Ag');
        const asc = m.fontBoundingBoxAscent || Math.round(r.size * 0.88);
        runs.push({ t: r.text, x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.w), h: Math.round(r.h), c: r.color, s: r.size, b: r.bold ? 1 : 0, a: Math.round(asc) });
      }
      // live 就地替换为等大占位 span，实测偏差 relative 归位（复用文字位图的布局保持机制）
      for (const j of jobs) {
        if (j.skip) continue;
        const r = j.run;
        const sp = document.createElement('span');
        // 占位高度：Chrome 对 button/inline-block 内文字的 range rect 返回字体盒（不含行距半领先导），
        // 直接用会让行盒塌陷（实测按钮 38→34）；这类父元素改用其内容盒高度，其余用 rect 高 + top 对齐
        // （v1 实测 12 探针 Δ=0）
        let spH = Math.round(r.h);
        try {
          const pcs = getComputedStyle(r.parent);
          if (r.parent.tagName === 'BUTTON' || pcs.display === 'inline-block' || pcs.display === 'inline-flex') {
            const contentH = r.parent.clientHeight - (parseFloat(pcs.paddingTop) + parseFloat(pcs.paddingBottom) || 0);
            if (contentH > spH && contentH < spH * 3) spH = Math.round(contentH);
          }
        } catch (e) {}
        sp.style.cssText = 'display:inline-block;vertical-align:top;width:' + Math.round(r.w) + 'px;height:' + spH + 'px';
        sp.setAttribute('data-xy-space', '1');
        r.parent.replaceChild(sp, r.node);
        j.sp = sp;
      }
      await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame(r2)));
      for (const j of jobs) {
        if (j.skip) continue;
        const r = j.run;
        const q = j.sp.getBoundingClientRect();
        const dx = Math.round((r.x - window.scrollX - q.left) * 2) / 2;
        const dy = Math.round((r.y - window.scrollY - q.top) * 2) / 2;
        if (dx || dy) { j.sp.style.position = 'relative'; j.sp.style.left = dx + 'px'; j.sp.style.top = dy + 'px'; }
        j.spHtml = j.sp.outerHTML;
        try { r.parent.replaceChild(r.node, j.sp); } catch (e) {}
      }
      const clone = sanitizeClone(document.body);
      // select：标签文本是原生控件画出来的，必须留在 DOM；但只保留选中项，其余 option 文本不下发
      try {
        const liveSels = document.querySelectorAll('select');
        const cloneSels = clone.querySelectorAll('select');
        liveSels.forEach((ls, i) => {
          const cs = cloneSels[i];
          if (!cs) return;
          cs.selectedIndex = ls.selectedIndex;
          for (const op of cs.querySelectorAll('option')) if (!op.selected) op.textContent = '';
        });
      } catch (e) {}
      for (const j of jobs) {
        try {
          const parts = j.run.path.split('/');
          let cn = clone;
          for (const i of parts.slice(0, -1)) { cn = cn.childNodes ? cn.childNodes[+i] : null; if (!cn) break; }
          const target = cn && cn.childNodes ? cn.childNodes[+parts[parts.length - 1]] : null;
          if (!target || target.nodeType !== 3) continue;
          if (j.spHtml) {
            const tpl = document.createElement('template');
            tpl.innerHTML = j.spHtml;
            cn.replaceChild(tpl.content.firstChild, target);
          } else {
            cn.replaceChild(document.createTextNode(''), target);
          }
        } catch (e) {}
      }
      window.__xyBusy = false;
      const styleCss = [...document.querySelectorAll('style')].map(s => s.textContent).join('\\n');
      const hrefs = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href')).filter(Boolean);
      let linkCss = '';
      try {
        const texts = await Promise.all(hrefs.map(h => fetch(h).then(r => r.ok ? r.text() : '').catch(() => '')));
        linkCss = texts.join('\\n');
      } catch (e) {}
      return { css: styleCss + '\\n' + linkCss, html: clone.innerHTML, title: document.title, runs: runs.filter(Boolean) };
    },
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
              const snap = await page.evaluate(() => window.__xy.snapshot());
              sendJson({ type: 'dom-snapshot', css: snap.css.replace(/url\((['"]?)\//g, 'url($1/m/'), html: snap.html, title: snap.title, w: VIEW_W, h: VIEW_H });
              return;
            }
            const payload = JSON.stringify({ type: 'dom-patches', patches });
            ws.send(payload);
            ws._bytes = (ws._bytes || 0) + payload.length;
            ws._chunks = (ws._chunks || 0) + 1;
          } catch (e) {}
        });
      });
      domExposed = true;
    }
    domActive = true;
    const snap = await page.evaluate(() => window.__xy.snapshot());
    const cssFixed = snap.css.replace(/url\((['"]?)\//g, 'url($1/m/');
    const payload = JSON.stringify({ type: 'dom-snapshot', css: cssFixed, html: snap.html, title: snap.title, w: VIEW_W, h: VIEW_H });
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

    await page.goto(ORIGIN_URL, { waitUntil: 'networkidle0', timeout: 20000 });
    sendJson({ type: 'meta', w: VIEW_W, h: VIEW_H, title: await page.title(), url: ORIGIN_URL, maxSessions: MAX_SESSIONS, mode });
    if (mode === 'dom') await startDomMirror();
    else await startScreencast();

    ws.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      try {
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
              const snap = await page.evaluate(() => window.__xy.snapshot()).catch(() => null);
              if (snap) sendJson({ type: 'dom-snapshot', css: snap.css.replace(/url\((['"]?)\//g, 'url($1/m/'), html: snap.html, title: snap.title, w: VIEW_W, h: VIEW_H });
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
      } catch (e) { sendJson({ type: 'error', msg: '事件处理异常: ' + e.message }); }
    });

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
