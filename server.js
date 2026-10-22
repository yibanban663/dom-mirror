'use strict';
/**
 * 虚影 RBI 帧流 PoC 服务端 v2 —— 编码演进对比版
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
    patchOf(record) {
      // 补丁模型：childList/characterData → 目标元素 innerHTML 重发；attributes → 元素 outerHTML 重发
      let target = record.target;
      if (target.nodeType === 3) target = target.parentElement;
      if (!target || target === document.documentElement) return { full: true };
      const path = pathOf(target);
      if (path === null) return { full: true };
      if (record.type === 'attributes') {
        return { path, outer: sanitizeClone(target).outerHTML };
      }
      return { path, inner: sanitizeClone(target).innerHTML };
    },
  };
})();`;

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};
function staticHandler(root) {
  return (req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(root, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
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
  if (req.url === '/f/noto') {
    // 服务端渲染所用字体的下发：保证镜像端文字与服务端像素渲染一致
    fs.readFile(path.join(__dirname, 'assets', 'NotoSansSC-Regular.otf'), (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'content-type': 'font/otf',
        'cache-control': 'public, max-age=86400',
        'content-length': buf.length,
      });
      res.end(buf);
    });
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

  async function startDomMirror() {
    await page.evaluate(PAGE_HELPERS);
    if (!domExposed) {
      await page.exposeFunction('__xyPatch', (patches) => {
        if (!domActive || ws.readyState !== 1) return;
        if (patches.some(p => p && p.full)) {
          page.evaluate(() => window.__xy.snapshot())
            .then(snap => sendJson({ type: 'dom-snapshot', css: snap.css.replace(/url\((['"]?)\//g, 'url($1/m/'), html: snap.html, title: snap.title, w: VIEW_W, h: VIEW_H }))
            .catch(() => {});
          return;
        }
        const payload = JSON.stringify({ type: 'dom-patches', patches });
        ws.send(payload);
        ws._bytes = (ws._bytes || 0) + payload.length;
        ws._chunks = (ws._chunks || 0) + 1;
      });
      domExposed = true;
    }
    domActive = true;
    const snap = await page.evaluate(() => window.__xy.snapshot());
    // CSS 内部 url(/x) 重写到 /m/x 资源代理
    const cssFixed = snap.css.replace(/url\((['"]?)\//g, 'url($1/m/');
    const payload = JSON.stringify({ type: 'dom-snapshot', css: cssFixed, html: snap.html, title: snap.title, w: VIEW_W, h: VIEW_H });
    ws.send(payload);
    ws._bytes = (ws._bytes || 0) + payload.length;
    ws._chunks = (ws._chunks || 0) + 1;
    await page.evaluate(() => {
      if (window.__xyObs) window.__xyObs.disconnect();
      window.__xyObs = new MutationObserver((recs) => {
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
            if (mode === 'dom' && next !== 'dom') await stopDomMirror();
            mode = next;
            if (mode === 'h264') { quality = 85; startFFmpeg(); } else { stopFFmpeg(); }
            try {
              if (mode === 'dom') {
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
