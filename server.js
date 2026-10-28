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
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const puppeteer = require('puppeteer').default;
const { assetUrl, selectOrigin, requestAllowed } = require('./lib/policy');
const { SessionStore } = require('./lib/sessions');
const { frameCropInput, scanDirtyRows, dirtyRects } = require('./lib/frame-codec');
const { createUploads, UPLOAD_CHUNK_BYTES } = require('./lib/uploads');

const { normalizeOptions } = require('./lib/options');
const { createStaticFiles } = require('./lib/static');
const { createTimers } = require('./lib/timers');
const { pageHelpers } = require('./lib/page-helpers');
const input = require('./lib/input');
const xframe = require('./lib/xframe');
const { listCanvases: canvasList, createCanvasSigs } = require('./lib/canvas');

function createMirror(options) {
const config = normalizeOptions(options);
const {
  originUrl: ORIGIN_URL, width: VIEW_W, height: VIEW_H,
  maxSessions: MAX_SESSIONS, sessionGraceMs: SESSION_GRACE_MS,
  allowedOrigins: ALLOWED_ORIGINS, defaultMode: DEFAULT_MODE,
} = config;
const UPLOAD_MAX = config.upload.maxBytes;
const UPLOAD_EXTS = new Set(config.upload.extensions);
const DOWNLOAD_MAX = config.download.maxBytes;
const ORIGIN_BASE = new URL(ORIGIN_URL);
const logger = config.logger;
let sharp = null; try { sharp = require('sharp'); } catch (e) { logger.log('[sharp ] unavailable:', e.message); }
// chromiumSandbox=false 仅用于无法提供 user namespace 的环境（渲染进程被攻破即拿到宿主进程权限）
const CHROME_ARGS = [
  ...(config.chromiumSandbox ? [] : ['--no-sandbox', '--disable-setuid-sandbox']), '--disable-dev-shm-usage',
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

const PAGE_HELPERS = pageHelpers(config);
// 会话级 PAGE_HELPERS：按 sessionOrigin 替换源站前缀（多源会话的绝对地址改写与
// /m/o/<b64> 资产下发都依赖它；替换失败时运行态回退仅影响绝对地址）。第二个
// 占位符固定替换为 ORIGIN_URL 缺省源站——短式 /m 只路由到它。
function pageHelpersFor(originPrefix) {
  const esc = JSON.stringify(String(originPrefix)).slice(1, -1);
  return PAGE_HELPERS
    .split('__XY_DEFAULT_PREFIX__').join(JSON.stringify(ORIGIN_BASE.origin).slice(1, -1))
    .split('__XY_ORIGIN_PREFIX__').join(esc);
}

// ---------- 静态文件 ----------
const { sendFile, staticHandler, clear: clearStaticFiles } = createStaticFiles();

// ---------- Chromium：每会话独立实例 ----------
// 共享单例下多标签并发截图会间歇产出错位/幽灵瓦片（像素级实测：瓦片内容与坐标
// 张冠李戴）。使用独立实例；实际容量由宿主按业务测量。
const { createBrowserPool } = require('./lib/browser-pool');
// v0.30 实例池（browserPoolSize=0 时为 null，保持一会话一浏览器）
const sessionLaunch = () => puppeteer.launch({
  headless: true,
  args: CHROME_ARGS,
  defaultViewport: { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1 },
  ...config.launchOptions,
});
const browserPool = config.browserPoolSize > 0
  ? createBrowserPool({ size: config.browserPoolSize, launch: sessionLaunch, logger })
  : null;
// v0.32 镜像复用：热页池（单访客专用预热页，免冷启动）+ 源站静态资产跨会话共享缓存
const { createWarmPageManager } = require('./lib/warm-pages');
const { createOriginAssetCache } = require('./lib/origin-asset-cache');
const originAssetCache = config.originAssetCacheMb > 0
  ? createOriginAssetCache({ maxBytes: config.originAssetCacheMb * 1024 * 1024, defaultTtlMs: config.originAssetCacheTtl })
  : null;
const warmPages = createWarmPageManager({
  browserPool, warmup: config.sessionWarmup, ttlMs: config.sessionWarmupTtl, requestAllowed, logger,
});
// v0.32 资产缓存回源抓取：10s 超时 + 单体上限（超限中断），失败由调用方放行
const fetchOriginAsset = (u) => new Promise((resolve, reject) => {
  let parsed;
  try { parsed = new URL(u); } catch (e) { reject(e); return; }
  const mod = parsed.protocol === 'https:' ? httpBoth.https : httpBoth.http;
  const req = trackRequest(mod.get(u, { headers: { 'user-agent': 'rbi-mirror-asset', accept: '*/*' } }, (up) => {
    if ((up.statusCode || 502) < 200 || (up.statusCode || 502) >= 300) { up.resume(); reject(new Error('asset status ' + up.statusCode)); return; }
    const chunks = [];
    let total = 0, over = false;
    up.on('data', (c) => { total += c.length; if (total > originAssetCache.maxEntryBytes) { over = true; try { up.destroy(); } catch (e) {} } else chunks.push(c); });
    up.on('end', () => { if (over) { reject(new Error('asset too large')); return; } resolve({ status: up.statusCode || 200, headers: up.headers, body: Buffer.concat(chunks) }); });
    up.on('error', reject);
  }));
  req.setTimeout(10000, () => req.destroy(new Error('asset fetch timeout')));
  req.on('error', reject);
});

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

// ---------- HTTP + WS ----------
// /m/* —— 扩展名及响应类型受限的静态资源代理，不解析或剔除资源内数据。
// 多源会话（x-rbi-origin 白名单）资产以 /m/o/<b64url(origin)>/path 下发，
// 短式 /m/path 固定路由到 ORIGIN_URL 缺省源站（历史形态，缓存友好）。
const ORIGIN_ALLOWED = new Set([ORIGIN_BASE.origin, ...ALLOWED_ORIGINS.map(x => String(x).replace(/\/+$/, ''))]);
const httpBoth = { http: require('http'), https: require('https') };
const httpOrigin = ORIGIN_BASE.protocol === 'https:' ? httpBoth.https : httpBoth.http;
// /m 代理路径 → 绝对 URL（obf 网站字体下载等 Node 侧消费方使用）；非代理形态原样返回
function unproxyAsset(u) {
  const s = String(u);
  let mo = s.match(/^\/m\/o\/([A-Za-z0-9_-]+)(\/[^\s?#]*)?(\?[^\s#]*)?$/);
  if (mo) {
    let org = ''; try { org = Buffer.from(mo[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return s; }
    return org + (mo[2] || '/') + (mo[3] || '');
  }
  mo = s.match(/^\/m(\/[^\s?#]*)(\?[^\s#]*)?$/);
  if (mo) return ORIGIN_URL.replace(/\/+$/, '') + mo[1] + (mo[2] || '');
  return s;
}
// v0.25 跨源 iframe 同源化：会话作用域资产代理。secret 为每会话随机值（同 obf
// 字体路由的安全模型），注册表只收该会话源站页面实际嵌入过的源——防开放代理/
// SSRF；扩展名与响应类型限制与 /m 一致
const xframeOrigins = new Map(); // secret -> Set(origin)
function proxyXframeAsset(req, res) {
  let rest = req.url.slice(5); // 去 /m/x/
  const mo = rest.match(/^([0-9a-f]{8,64})\/([A-Za-z0-9_-]+)(\/[^\s?#]*)(\?[^\s#]*)?$/);
  if (!mo) { res.writeHead(403); res.end('xframe route'); return; }
  const allowed = xframeOrigins.get(mo[1]);
  let org = '';
  try { org = Buffer.from(mo[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) {}
  if (!allowed || !org || !allowed.has(org)) { res.writeHead(403); res.end('xframe origin'); return; }
  const mod = org.startsWith('https:') ? httpBoth.https : httpBoth.http;
  let base;
  try { base = new URL(org + '/'); } catch (e) { res.writeHead(403); res.end('xframe origin'); return; }
  const u = assetUrl(mo[3] + (mo[4] || ''), base);
  if (!u) { res.writeHead(403); res.end('asset allowlist'); return; }
  const upstream = trackRequest(mod.get(u, { headers: { 'user-agent': 'rbi-mirror-asset', accept: req.headers.accept || '*/*' } }, (up) => {
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
function proxyAsset(req, res) {
  // 白名单：只代理表现层静态资源（CSS url() 引用的图片/字体等）。
  // 不加白名单时 GET /m/ 可直接拉到源站整页明文（含页面内密钥）——击穿"数据不出站"
  let rest = req.url.slice(2);
  let base = ORIGIN_BASE;
  const mo = rest.match(/^\/o\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (mo) {
    let org = null;
    try { org = new URL(Buffer.from(mo[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (e) {}
    if (!org || !/^https?:$/.test(org.protocol) || !ORIGIN_ALLOWED.has(org.origin)) { res.writeHead(403); res.end('asset origin'); return; }
    base = new URL(org.origin + '/');
    rest = mo[2] || '/';
  }
  const mod = base.protocol === 'https:' ? httpBoth.https : httpBoth.http;
  const u = assetUrl(rest, base);
  if (!u) { res.writeHead(403); res.end('asset allowlist'); return; }
  // v0.32 镜像复用：/m/ 表现层资产跨访客共享缓存——命中免回源
  if (originAssetCache) {
    const hit = originAssetCache.get(u);
    if (hit) {
      try { logger.log('[cache ] m-hit', new URL(u).pathname.slice(0, 70)); } catch (e) {}
      res.writeHead(hit.status, {
        'content-type': hit.headers['content-type'] || 'application/octet-stream',
        'cache-control': 'public, max-age=300',
        'x-content-type-options': 'nosniff',
      });
      res.end(hit.body);
      return;
    }
  }
  const upstream = trackRequest(mod.get(u, { headers: { 'user-agent': 'rbi-mirror-asset', accept: req.headers.accept || '*/*' } }, (up) => {
    const ct = (up.headers['content-type'] || '').toLowerCase();
    if ((up.statusCode || 502) < 200 || (up.statusCode || 502) >= 300 || /text\/html|json|javascript|xml/.test(ct)) {
      up.resume();
      res.writeHead(403); res.end('asset allowlist');
      return;
    }
    if (originAssetCache) {
      // 缓冲回填（/m/ 本就限图片/字体小资产）：入库由 put 的保守规则裁决
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const body = Buffer.concat(chunks);
        originAssetCache.put(u, { status: up.statusCode || 200, headers: up.headers, body });
        if (!res.headersSent) {
          res.writeHead(up.statusCode || 200, {
            'content-type': up.headers['content-type'] || 'application/octet-stream',
            'cache-control': 'public, max-age=300',
            'x-content-type-options': 'nosniff',
          });
        }
        res.end(body);
      });
      up.on('error', () => res.destroy());
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
// 下载源站字体文件（同源静态资源，服务端代取）
function obfFetchFont(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    try {
      // 多源会话的网站字体可能跨协议（ORIGIN_URL 与 x-rbi-origin 源不同）
      const mod = String(url).startsWith('https:') ? httpBoth.https : httpBoth.http;
      const req = trackRequest(mod.get(url, { timeout: timeoutMs }, (r) => {
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
  // v0.21 RUM 尾包：pagehide 时 sendBeacon('/rum')（text/plain，同源免预检）。
  // 只落日志聚合，不解析内容、无跨源暴露
  if (req.method === 'POST' && String(req.url).split('?')[0] === '/rum') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) { body = body.slice(0, 8192); req.destroy(); } });
    req.on('end', () => {
      try { logger.log('[rum-beacon] ' + body); } catch (e) {}
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    });
    return;
  }
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); } // 网关壳无图标：204 消掉访客控制台每页一条的 404
  if (req.url && req.url.startsWith('/m/x/')) return proxyXframeAsset(req, res);
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
  // v0.31 真路由：任意业务路径承载镜像客户端（/login、/dashboard/x 深链直开）。
  // 静态文件优先命中；无扩展名或 .html 且未命中的路径回落 index.html，其余资源 404 保持
  const clientRoot = path.join(__dirname, 'client');
  const serveStatic = staticHandler(clientRoot);
  if (req.method !== 'GET' && req.method !== 'HEAD') return serveStatic(req, res);
  let spaPath = '';
  try { spaPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch { return serveStatic(req, res); }
  const spaExt = path.extname(spaPath);
  if (spaExt && spaExt !== '.html') return serveStatic(req, res);
  const spaFile = path.join(clientRoot, path.normalize(spaPath === '/' ? '/index.html' : spaPath).replace(/^([/\\])+/, ''));
  if (!spaFile.startsWith(clientRoot)) return serveStatic(req, res);
  fs.access(spaFile, (err) => {
    if (!err) return serveStatic(req, res);
    sendFile(req, res, path.join(clientRoot, 'index.html'), 'text/html; charset=utf-8', 'no-store');
  });
}
// permessage-deflate：JSON 快照/补丁文本高度重复，deflate 通常 5-10× 缩减
// （阈值 512B，小帧不压省 CPU）；浏览器 WS 客户端普遍支持，握手透明协商
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: { threshold: 512 } });
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
  let sessionExclusive = (fn) => fn(); // v0.30 池化：同浏览器截图互斥（无池=直通）
  let sessionRelease = null;
  const obfSess = nextObfSession(); // 防抓取字体混淆（dom 模式启用；无池则 null 透明降级）
  let lastInputAt = 0, inputLatMs = null, frameTimes = [], statTimer = null;
  // v0.13 文件传输：会话临时目录（上传暂存/下载落地），会话结束即删除
  let sessionUploadDir = null, sessionDownloadDir = null;
  let browserCdpDetached = null;
  const sessionUploads = createUploads(config.upload);
  setInterval(() => {
    for (const tid of sessionUploads.expire()) sendJson({ type: 'upload-end', tid, ok: false, error: 'upload expired' });
  }, Math.min(config.upload.idleTimeoutMs, 1000));
  const sessionDownloads = new Map(); // guid -> {name,received}

  const sendJson = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

  // 逻辑会话终止时清理；普通 WS 断线由 SessionStore 保留到恢复或过期。
  // setup 期间也要登记清理，避免浏览器晚启动后泄漏。
  let dead = false;
  let helloIv = null;
  let lastAliveAt = Date.now(); // v0.30 ws 活性
  let lastCssSig = null; // 样式表集合指纹（1Hz 兜底比对；每次全量快照后置 null 重定基线）
  let lastCssSent = null; // v0.17 带宽：最近一次快照下发 css（相同则省略；hello/恢复后置 null 必发全量）
  let driftStreak = 0, lastDriftHeal = 0; // v0.18 分歧自愈：连续漂移计数与限频
  let xframeSecret = null; // v0.25 跨源 iframe 资产代理的会话作用域密钥
  let xframeBusy = false;
  let xframeTimer = null; // v0.26 跨源 iframe 周期刷新（变化推 outer 补丁）
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
      if (xframeSecret) xframeOrigins.delete(xframeSecret);
      if (xframeTimer) { clearInterval(xframeTimer); xframeTimer = null; }
      domActive = false;
      // pool-off 保持历史形态（page 与 browser 关闭并行发起——mock 编排按此时序
      // 编写，实测串行拆分会悬挂 close 等待链）；池化时只关上下文不关浏览器
      if (sessionRelease) {
        await Promise.allSettled([page?.close()]);
        await sessionRelease();
      } else {
        await Promise.allSettled([page?.close(), sessionBrowser?.close()]);
      }
      sessionUploads.clear();
      sessionDownloads.clear();
      if (browserCdpDetached) browserCdpDetached();
      await Promise.allSettled([
        sessionUploadDir ? fsp.rm(sessionUploadDir, { recursive: true, force: true }) : null,
        sessionDownloadDir ? fsp.rm(sessionDownloadDir, { recursive: true, force: true }) : null,
      ]);
      logger.log(`[sess  ] close (${sessions}/${MAX_SESSIONS})`);
    })();
    cleanupPromise.finally(() => cleanups.delete(cleanup)).catch(() => {});
    return cleanupPromise;
  };
  cleanups.add(cleanup);
  lifecycle.cleanup = cleanup;
  ws.on('close', cleanup);
  ws.on('error', () => {});
  // v0.30 会话活性探测：浏览器页销毁后 TCP 半开不触发 close（既有缺陷，
  // 一会话一浏览器时靠 MAX_SESSIONS 冗余掩盖；池化后会占死池位）。
  // 1s 轮询：readyState≥2 直调 cleanup；协议 ping 探活，15s 无活性兜底。
  ws.on('pong', () => { lastAliveAt = Date.now(); });
  // 仅池化模式创建（空转 interval 会吊住"无句柄自然退出"的测试进程——CI
  // 语法 job 实测卡死；pool-off 路径与历史行为完全同构）
  if (browserPool) {
    // 收割条件：readyState=3（握手完毕）且连续 3 次轮询（3s）close 事件仍未
    // 发出——只收"漏发 close"的僵死 socket。readyState=2（客户端主动断连握手
    // 进行中）不干预：close 事件会自然发出走既有清理/宽限链路（恢复测试的
    // 主动断连-重连即此形态，2CPU 下立即 terminate 会掐断恢复窗口）
    let closedTicks = 0;
    timers.setInterval(() => {
      if (dead) return;
      if (ws.readyState === 3) {
        closedTicks++;
        if (closedTicks >= 3) {
          logger.log('[sess  ] closed-socket reaped (state=3 x' + closedTicks + 's, close event missed)');
          try { ws.terminate(); } catch (e) {}
          cleanup();
        }
        return;
      }
      closedTicks = 0;
      if (Date.now() - lastAliveAt > 15000) {
        logger.log('[sess  ] dead-connection reaped (no pong 15s)');
        try { ws.terminate(); } catch (e) {}
        cleanup();
        return;
      }
      try { ws.ping(); } catch (e) {}
    }, 1000);
  }

  // 会话源站：WAF proxy-endpoint 转发时注入 x-rbi-origin（受信内网头）；直连演示用 ORIGIN_URL
  const sessionOrigin = req.rbiOrigin || ORIGIN_URL;
    let sessHelpers;
    try { sessHelpers = pageHelpersFor(new URL(sessionOrigin).origin); }
    catch (e) { sessHelpers = pageHelpersFor(ORIGIN_BASE.origin); }
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
  let navOrigins = null; // v0.30 伪路由：requestOrigins 构建后回填（作用域桥接）
  let statLastChunks = 0;
  let canvasSigsReset = null; // 全量重同步后 canvas 捕获基准失效（画面已变）
  // 消息队列必须先于一切 await 挂上：ws 库不缓存无监听期间到达的消息，
  // 冷启动（Chrome 拉起数秒）期间的 hello/mode 一旦错过就永久丢失
  const queue = [];
  let dispatchReady = false;
  const handleCommand = async (m) => {
    switch (m.type) {
          case 'ping': {
            sendJson({ type: 'pong', t: m.t });
            // v0.21 RUM：客户端 10s 心跳携带真实会话性能数据（帧时间/交互延迟/
            // 字节分布），落日志聚合（[rum] 行）；sendBeacon 尾包走 POST /rum
            if (m.rum && typeof m.rum === 'object') {
              try { logger.log('[rum] ' + JSON.stringify(m.rum)); } catch (e) {}
            }
            // v0.18：分歧检测（Timelapse/Dolos 思想）——客户端 ping 携带镜像元素
            // 指纹，与源站比对；持续漂移两拍且距上次自愈 >10s → 自动全量重同步。
            // 把"镜像悄悄坏了"变成"自愈+可观测"（sstats 前打一行日志）
            if (m.fp !== undefined && Number.isFinite(m.fp) && mode === 'dom' && domActive && !dead) {
              try {
                const srvFp = await page.evaluate(() => document.body.getElementsByTagName('*').length - document.body.querySelectorAll('script, [data-xy-space]').length);
                const drift = Math.abs(srvFp - m.fp);
                if (drift > Math.max(2, srvFp * 0.02)) {
                  driftStreak++;
                  if (driftStreak >= 2 && Date.now() - lastDriftHeal > 10000) {
                    lastDriftHeal = Date.now();
                    driftStreak = 0;
                    logger.log(`[drift ] self-heal: server=${srvFp} mirror=${m.fp} delta=${drift}`);
                    startDomMirror().catch(() => {});
                  }
                } else driftStreak = 0;
              } catch (e) {}
            }
            break;
          }
          case 'hello': {
            // 会话中 DPR/视口变化（缩放、跨屏、拉窗口）：重新模拟并全量重发瓦片；
            // hello 同时是断线恢复握手——客户端 css 缓存已丢，置空必发全量
            lastCssSent = null;
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
            noteInput();
            if (m.kind === 'click') logger.log('[dbg] dom click ref=' + (m.id !== undefined ? '#' + m.id : m.path));
            const ok = await input.domAction(page, m);
            if (!ok && mode === 'dom') {
              // 防御不变式：失败只做瓦片化全量重同步；明文快照在任何模式下都不下发
              await startDomMirror().catch(() => {});
            }
            // 输入后不再做防抖全量重发：差分循环（140ms）+ 结构补丁已覆盖一切视觉
            // 跟进，而全量重建会吞掉重建窗口内的点击（实测登录按钮点击落在 700ms
            // 防抖重建里被静默丢弃 → 登录"点了没反应"）。结构漂移由元素数指纹兜底。
            break;
          }
          case 'navigate': {
            // v0.30 伪路由：地址栏跳转。仅允许会话源站白名单内的目标（与请求
            // 拦截同语义）；相对地址按当前页解析，裸主机名自动补 http://
            noteInput();
            try {
              let u = String(m.url || '').trim();
              if (!u) break;
              if (!/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('/') && !u.startsWith('//') && /^[^/\s]+\.[^/\s]+/.test(u)) u = 'http://' + u;
              const parsed = new URL(u, page.url());
              if (!['http:', 'https:'].includes(parsed.protocol)) { sendJson({ type: 'nav-blocked', msg: '仅支持 http/https 地址' }); break; }
              if (!navOrigins || !requestAllowed(parsed.href, navOrigins)) { sendJson({ type: 'nav-blocked', msg: '目标地址不在允许范围内' }); break; }
              await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
              sendJson({ type: 'location', url: page.url() });
            } catch (e) { sendJson({ type: 'nav-blocked', msg: '导航失败: ' + e.message }); }
            break;
          }
          case 'history': {
            noteInput();
            try {
              const fn = m.dir === 'forward' ? page.goForward : page.goBack;
              await fn.call(page, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
              // 历史栈底防护：池化 context 的 newPage 初始 about:blank 残留在栈底，
              // 业务首页再退会落入空白镜像（原生浏览器首页本就不可退）——原地弹回
              if (page.url() === 'about:blank') {
                const back = m.dir === 'forward' ? page.goBack : page.goForward;
                await back.call(page, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
              }
              sendJson({ type: 'location', url: page.url() });
            } catch (e) {}
            break;
          }
          case 'mouse':
            if (m.action !== 'move') noteInput();
            await input.mouse(page, cdp, m);
            break;
          case 'key':
            noteInput();
            await input.key(cdp, m);
            break;
          case 'dnd':
            noteInput();
            await input.dnd(page, m).catch(() => {});
            break;
          case 'touch':
            noteInput();
            await input.touch(cdp, m).catch(() => {});
            break;
          case 'composition':
            noteInput();
            await input.composition(page, cdp, m).catch(err => sendJson({ type: 'error', msg: 'composition failed: ' + err.message }));
            break;
          case 'composition-commit':
            noteInput();
            await input.compositionCommit(page, cdp, m).catch(err => sendJson({ type: 'error', msg: 'composition commit failed: ' + err.message }));
            break;
          case 'upload-begin': {
            // 镜像文件上传（v0.13）：客户端 File → WS 分块 → 会话临时目录 →
            // puppeteer uploadFile（DOM.setFileInputFiles）→ 远端 change
            const tid = String(m.tid || '');
            const name = path.basename(String(m.name || ''));
            const size = m.size;
            const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
            if (!tid || !name || !ext || !UPLOAD_EXTS.has(ext.toLowerCase())) {
              sendJson({ type: 'upload-accept', tid, ok: false, error: 'extension not allowed' });
              break;
            }
            try {
              sessionUploads.begin(tid, { name, size, fid: m.fid });
              sendJson({ type: 'upload-accept', tid, ok: true, maxChunk: UPLOAD_CHUNK_BYTES });
            } catch (error) { sendJson({ type: 'upload-accept', tid, ok: false, error: error.message }); }
            break;
          }
          case 'upload-chunk': {
            const tid = String(m.tid || '');
            try { sessionUploads.append(tid, m.b64); }
            catch (error) { sendJson({ type: 'upload-end', tid, ok: false, error: error.message }); }
            break;
          }
          case 'upload-end': {
            const tid = String(m.tid || '');
            noteInput();
            try {
              const st = sessionUploads.finish(tid);
              const buf = Buffer.concat(st.chunks);
              if (buf.length !== st.size) throw new Error('size mismatch');
              if (!sessionUploadDir) sessionUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-upload-'));
              // 会话私有目录 + name 已 basename 收口：直接用原文件名，远端页面
              // 读到的 files[0].name 与访客本地选择一致（uuid 前缀会污染业务文件名）
              const fp = path.join(sessionUploadDir, st.name);
              fs.writeFileSync(fp, buf);
              // 按 id 找回源站 file input，CDP 设置文件并触发 change
              const ref = st.fid;
              const handle = await page.evaluateHandle((r) => window.__xy.find(r), ref);
              const el = handle.asElement ? handle.asElement() : null;
              if (!el || !el.uploadFile) { await handle.dispose(); throw new Error('file input not found'); }
              await el.uploadFile(fp);
              await handle.dispose();
              await page.evaluate((r) => {
                const el2 = window.__xy.find(r);
                if (el2) el2.dispatchEvent(new Event('change', { bubbles: true }));
              }, ref).catch(() => {});
              logger.log('[up    ] stored:', st.name, buf.length, 'bytes');
              sendJson({ type: 'upload-end', tid, ok: true, name: st.name, size: buf.length });
            } catch (err) {
              sendJson({ type: 'upload-end', tid, ok: false, error: String(err && err.message || err) });
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
              const shotR = await sessionExclusive(() => cdp.send('Page.captureScreenshot', { format: 'png' }));
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
          case 'scroll':
            noteInput();
            await input.scroll(page, m).catch(() => {});
            // 键同步：服务端镜像后的页面滚动钩子会产出同位置 ping，
            // 去重键先记为本次上报值，避免 RTT 后回拽
            lastScrollKey = (m.x || 0) + ',' + (m.y || 0) + ',' + JSON.stringify(m.inner || []);
            break;
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
  ws.on('message', (raw) => { lastAliveAt = Date.now(); if (dispatchReady) enqueue(raw); else queue.push(Buffer.from(raw)); });
  const noteInput = () => { lastInputAt = Date.now(); };
  ws.on('resume', () => {
    if (!dispatchReady) return; // 初始化中的会话仍由首次快照完成同步
    cmdChain = cmdChain.then(async () => {
      if (dead || ws.readyState !== 1) return;
      if (domStarting) await domStarting;
      sendJson({ type: 'meta', w: viewW, h: viewH, title: await page.title(), maxSessions: MAX_SESSIONS, mode, prod: prodMode, warm: false }); // v0.32 resume 不经热页（本闭包无 warmEntry）
      sendJson({ type: 'location', url: page.url() });
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
    // v0.29：重应用（SOC 大屏）head 持续变更（childList:noPath:HEAD 样式注入）
    // 会周期性触发全量重同步——1.4MB 级快照连发。防抖窗口 700→2000ms：内容
    // 增量仍走补丁通道实时下发，全量重发只作低频兜底（尾部触发保证终态一致）。
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
    await page.evaluate(sessHelpers);
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
          let rest = patches.filter(p => p && p.docClass === undefined);
          // v0.17：属性补丁（程序化 checked/value）直发，不进结构差分
          const propPatches = rest.filter(p => p.__xyProp);
          if (propPatches.length && domActive && ws.readyState === 1) {
            sendJson({ type: 'dom-props', props: propPatches.map(p => p.__xyProp) });
          }
          rest = rest.filter(p => p.__xyProp === undefined && p.__xySel === undefined && p.text === undefined && p.append === undefined && p.attrs === undefined);
          // v0.17：选区补丁单独下发
          const selPatch = patches.find(p => p && p.__xySel);
          if (selPatch && domActive && ws.readyState === 1) sendJson({ type: 'dom-sel', ...selPatch.__xySel });
          // v0.18：焦点同步单独下发
          const focusPatch = patches.find(p => p && p.__xyFocus);
          if (focusPatch && domActive && ws.readyState === 1) sendJson({ type: 'focus-sync', id: focusPatch.__xyFocus.id });
          rest = rest.filter(p => p.__xyFocus === undefined);
          // v0.17 带宽：文本节点级/追加型补丁直发（O(增量) 而非 O(容器)）；
          // 追加先行——同批中文本补丁可能指向刚追加内容的子节点，顺序保证注册先于定位
          const appendPatches = patches.filter(p => p && p.append !== undefined);
          const textPatches = patches.filter(p => p && p.text !== undefined);
          if ((appendPatches.length || textPatches.length) && domActive && ws.readyState === 1) {
            sendJson({ type: 'dom-patches', patches: appendPatches.concat(textPatches) });
          }
          // v0.29：属性补丁 O(1) 直发（不进瓦片批——无 DOM 重读，几十字节）
          const attrsPatches = patches.filter(p => p && p.attrs !== undefined);
          if (attrsPatches.length && domActive && ws.readyState === 1) {
            sendJson({ type: 'dom-patches', patches: attrsPatches });
          }
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
              if (!p || (p.id === undefined && p.path === undefined)) continue;
              const key = (p.id !== undefined) ? '#' + p.id : p.path;
              // outer 含子树：同目标 outer 与 inner 在合并窗内相遇时保留 outer
              const kind2 = (p.outer !== undefined) ? 'outer' : 'inner';
              if (kind2 === 'inner' && structBuf.get(key) === 'outer') continue;
              structBuf.set(key, kind2);
            }
            // v0.29：合并窗 60→150ms——持续变更型仪表盘（SOC 大屏）瓦片批
            // 16/s（每批整页截图+PNG 切块）是带宽与 CPU 双大头；150ms（≈6.7fps）
            // 对背景构件视觉足够，文本/值通道不受此窗影响
            if (structTimer) return;
            structTimer = setTimeout(async () => {
              structTimer = null;
              if (dead || ws.readyState !== 1) { structBuf.clear(); return; }
              const batch = [...structBuf.entries()].map(([key, kind2]) => ({ key, [kind2]: 1 }));
              structBuf.clear();
              // 异步兜底：截图超时/导航销毁上下文一旦以 unhandled rejection
              // 冒泡会击穿整个网关进程（Node>=15 默认退出）
              try { await tilesPatches(batch); } catch (e) { logger.log('[patch] batch err:', e && e.message); }
            }, 150);
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
      // v0.14：canvas 2D 指令流上行通道（60ms 合并批量下发 canvas-ops）
      try {
        await page.exposeFunction('__xyCanvasOps', (batches) => {
          if (!domActive || ws.readyState !== 1 || mode !== 'dom') return;
          if (!Array.isArray(batches)) return;
          const payload = JSON.stringify({ type: 'canvas-ops', batches });
          if (payload.length > 512 * 1024) return; // 防御：异常巨批丢弃（正常批 << 64KiB）
          ws.send(payload);
          ws._bytes = (ws._bytes || 0) + payload.length;
          ws._chunks = (ws._chunks || 0) + 1;
        });
      } catch (e) {}
      domExposed = true;
    }
    domActive = true;
    // observer 先挂后拍（关键顺序）：原实现快照之后才挂 observer，快照期间二次
    // 导航（POST→302→落地页）会让快照发出旧内容且新文档上无任何 observer——
    // 该会话从此零补丁零触发（实测 css 永久冻结的一种成因）。先挂可观测窗口
    // 覆盖整个快照期；PAGE_HELPERS 注入加超时防导航竞态悬挂。
    await withTimeout(page.evaluate(sessHelpers), 8000, 'helpers').catch((e) => {
      logger.log('[dom   ] helpers inject fail:', e && e.message);
    });
    await page.evaluate(() => {
      // v0.27 修复：attachShadow 包装器引用的 window.__xyObserveShadow 此前
      // 从未被赋值（历史空引用）——注入后创建的影子根（含 closed）一直没挂
      // observer，closed 组件的动态变化对镜像不可见
      if (window.__xy && window.__xy.observeShadow) window.__xyObserveShadow = window.__xy.observeShadow;
      if (window.__xy && window.__xy.observeIframe) window.__xyObserveIframe = window.__xy.observeIframe;
      if (window.__xyObs) window.__xyObs.disconnect();
      window.__xyObs = new MutationObserver((recs) => {
        const out = [];
        for (const r of recs) { try { const p2 = window.__xy.patchOf(r); if (p2) out.push(p2); } catch (e) {} }
        if (out.length) window.__xyPatch(out);
      });
      window.__xyObs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      // v0.17：属性 setter 劫持队列（程序化 checked/value 变更）60ms 合并下发
      if (window.__xyPropTimer) clearInterval(window.__xyPropTimer);
      window.__xyPropTimer = setInterval(() => {
        if (!window.__xyPropQ || !window.__xyPropQ.size) return;
        const out = [...window.__xyPropQ.values()];
        window.__xyPropQ.clear();
        window.__xyPatch(out.map((p) => ({ __xyProp: p })));
      }, 60);
      // v0.17：媒体元素状态（播放/暂停/seek/音量/进度）并入同一通道；
      // timeupdate 1s 节流（暂停/seek/音量事件即时）
      if (!window.__xyMediaHooked) {
        window.__xyMediaHooked = true;
        let lastT = 0;
        const mediaPing = (el) => {
          try {
            if (!el || !el.tagName || !/^(VIDEO|AUDIO)$/.test(el.tagName)) return;
            if (!window.__xy || !window.__xyPropQ) return;
            const id = window.__xy.idOf(el);
            if (id === null) return;
            window.__xyPropQ.set(id, { id, media: { paused: el.paused, t: el.currentTime, muted: el.muted, vol: el.volume } });
          } catch (e) {}
        };
        for (const ev of ['play', 'pause', 'seeked', 'volumechange']) window.addEventListener(ev, (e) => mediaPing(e.target), true);
        window.addEventListener('timeupdate', (e) => {
          const now = Date.now();
          if (now - lastT < 1000) return;
          lastT = now;
          mediaPing(e.target);
        }, true);
      }
      // v0.17：选区镜像——selectionchange 150ms 节流。镜像内容在客户端 shadow
      // root 内，文档级 Selection API 无法跨边界设置；改为下发选区矩形
      // （Range.getClientRects + 滚动偏移 → 页面坐标），客户端绝对定位高亮层
      // 呈现（随镜像文档流滚动）。搜索高亮/表格选择类业务由此跟随。
      if (!window.__xySelHooked) {
        window.__xySelHooked = true;
        let selT = null, lastSelKey = '';
        document.addEventListener('selectionchange', () => {
          if (selT) return;
          selT = setTimeout(() => {
            selT = null;
            try {
              const s = document.getSelection();
              if (!s || s.rangeCount === 0 || s.isCollapsed) return;
              const r = s.getRangeAt(0);
              const rects = [];
              for (const rc of r.getClientRects()) {
                if (rects.length >= 200) break;
                if (rc.width < 1 || rc.height < 1) continue;
                rects.push([Math.round(rc.left + window.scrollX), Math.round(rc.top + window.scrollY), Math.round(rc.width), Math.round(rc.height)]);
              }
              if (!rects.length) return;
              const key = JSON.stringify(rects);
              if (key === lastSelKey) return;
              lastSelKey = key;
              window.__xyPatch([{ __xySel: { rects } }]);
            } catch (e) {}
          }, 150);
        });
      }
      // v0.18：焦点同步——源站 JS 聚焦字段（autofocus/校验定位）时镜像跟随光标。
      // 300ms 节流；body/无焦点发 null
      if (!window.__xyFocusHooked) {
        window.__xyFocusHooked = true;
        let fT = null, lastF = undefined;
        const ping = () => {
          fT = null;
          try {
            const ae = document.activeElement;
            const id = (ae && ae !== document.body && ae !== document.documentElement && window.__xy) ? window.__xy.idOf(ae) : null;
            if (id === lastF) return;
            lastF = id;
            window.__xyPatch([{ __xyFocus: { id } }]);
          } catch (e) {}
        };
        window.addEventListener('focusin', () => { if (!fT) fT = setTimeout(ping, 300); }, true);
        window.addEventListener('focusout', () => { if (!fT) fT = setTimeout(ping, 300); }, true);
      }
      // v0.14：现存 shadow root 全量兜底观察（attachShadow patch 覆盖此后新建的）
      if (window.__xy && window.__xy.observeShadows) window.__xy.observeShadows();
      // v0.14：现存同源 iframe 文档观察（load 钩子覆盖此后加载的）
      if (window.__xy && window.__xy.observeIframes) window.__xy.observeIframes();
    }).catch(() => {});
  // v0.26：force=true 重抓既有条目（周期刷新通道）；返回内容发生变化的 url 列表
  async function prepareXframes(force) {
      // v0.26 prepareXframes(force)：跨源 iframe 同源化——服务端代理抓取（无访客凭据，6s/512KB，仅
      // text/html）→ 页内 sanitize（剥 script/事件属性，资产 URL 改写为
      // /m/x/<secret>/<b64(origin)>）→ 存 window.__xyXframe，sanitizeClone 的
      // iframe 分支用它替代占位块。secret 每会话随机；origin 注册表限定"本会话
      // 源站实际嵌入过的源"（防开放代理）。抓取失败保持占位回退
      if (dead || xframeBusy || !config.crossOriginFrameOrigins.length) return [];
      xframeBusy = true;
      let xframeChanged = [];
      try {
        const xfCand = await page.evaluate(xframe.listCandidates, !!force);
        if (dead) return [];
        if (xfCand.length) {
          if (!xframeSecret) {
            xframeSecret = crypto.randomBytes(12).toString('hex');
            if (!xframeOrigins.has(xframeSecret)) xframeOrigins.set(xframeSecret, new Set());
          }
          const origins = xframeOrigins.get(xframeSecret);
          const htmls = [];
          for (const raw of xfCand) {
            try {
              const url = new URL(raw, sessionOrigin);
              if (dead || url.username || url.password || !config.crossOriginFrameOrigins.includes(url.origin)) continue;
              const abs = url.href;
              const html = await xframe.fetchHtml(abs, trackRequest);
              if (html && !dead) { origins.add(new URL(abs).origin); htmls.push({ url: abs, html }); }
            } catch (e) {}
          }
          if (htmls.length) {
            await page.evaluate(xframe.storeSanitized, htmls, xframeSecret).then((ch) => { xframeChanged = ch || []; }).catch(() => {});
          }
        }
      } catch (e) {}
      finally { xframeBusy = false; }
      return xframeChanged;
  }
    // v0.25/0.26：跨源 iframe 同源化内容预取（首拍全量），周期刷新定时器对
    // 变化条目推宿主 outer 补丁（客户端整替 iframe，srcdoc 随新内容到达）
    try { await prepareXframes(false); } catch (e) {}
    if (!xframeTimer) {
      xframeTimer = setInterval(async () => {
        if (mode !== 'dom' || !domActive || dead || !page || ws.readyState !== 1) return;
        try {
          const changed = await prepareXframes(true);
          if (!changed || !changed.length) return;
          const patches = await withTimeout(page.evaluate((urls) => {
            const out = [];
            for (const f of document.body.querySelectorAll('iframe')) {
              if (urls.includes(f.src)) out.push({ id: window.__xy.idOf(f), outer: window.__xy.sanitizeClone(f).outerHTML });
            }
            return out;
          }, changed), 5000, 'xframePush').catch(() => null);
          if (patches && patches.length && ws.readyState === 1) sendJson({ type: 'dom-patches', patches });
        } catch (e) {}
      }, Number(process.env.XFRAME_REFRESH_MS || 15000));
    }
    // v4：dom 快照零截图（文本/输入框外观由客户端原生渲染，字体由源站 CSS 自带）。
    // frame 模式仍需整页截图作条带底板。
    await page.evaluate((d) => { window.__xyDpr = d; }, DPR);
    if (mode === 'frame') {
      try {
        const shotF = await withTimeout(sessionExclusive(() => cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })), 8000, 'frameSheet');
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
        try { url = new URL(unproxyAsset(url), sessionOrigin).href; } catch (e) { continue; }
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
    // css 内 url() 已在快照采集时按所属样式表基址改写为 /m(/m/o) 代理路径。
    // v0.17 带宽：css 与上次快照相同（SPA 路由切换常态）则不再重发——导航兜底
    // 重拍的快照从 ~css+html 缩到 ~html；hello（含断线恢复）后重置必发全量
    const cssFixed = snap.css + obfCssBlock;
    const cssSame = (lastCssSent !== null && lastCssSent === cssFixed);
    if (!cssSame) lastCssSent = cssFixed;
    const payload = JSON.stringify(Object.assign({ type: 'dom-snapshot', css: cssSame ? undefined : cssFixed, cssSame: cssSame || undefined, html: snap.html, title: snap.title, w: viewW, h: viewH, tiles: snap.tiles || [], frame: snap.frame || null, docClass: snap.docClass || '', docAttrs: snap.docAttrs || '', bodyStyle: snap.bodyStyle || '', sx: snap.sx || 0, sy: snap.sy || 0, scrollers: snap.scrollers || [], bodyId: snap.bodyId }));
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
    // 后到的祖先会移除已收入的其后代（深度沿用 path 计算；id 版本 path 恒存在）
    const sorted = [...patches].filter(p => p && p.key !== undefined && (p.inner !== undefined || p.outer !== undefined))
      .sort((a, b) => String(a.path ?? '').split('/').length - String(b.path ?? '').split('/').length);
    const items = [];
    for (const p of sorted) {
      const pp = String(p.path ?? p.key);
      if (items.some(q => pp === q.path || pp.startsWith(q.path + '/'))) continue;
      for (let k = items.length - 1; k >= 0; k--) {
        if (items[k].path.startsWith(pp + '/')) items.splice(k, 1);
      }
      items.push({ key: p.key, path: pp, outer: p.outer !== undefined ? 1 : undefined, inner: p.outer !== undefined ? undefined : 1 });
    }
    if (!items.length) return;
    const out = await withTimeout(page.evaluate((list) => {
      const out2 = [];
      // v0.23 窗口平移检测：inner 补丁先与上次下发的子元素序列比对——虚拟滚动
      // 整窗重建的形态是 old.slice(k) ≡ new 前段（下移，删头+尾部新增）或反向
      // （上移）。命中则发 O(增量) 的 delHead+append / prepend+delTail，不命中
      // 回退整段 inner。prev 序列按容器 id 记忆（≤32 容器防内存）
      if (!window.__xyKids) window.__xyKids = new Map();
      for (const it of list) {
        try {
          const ref = (it.key !== undefined && String(it.key)[0] === '#') ? Number(String(it.key).slice(1)) : it.path;
          let live = window.__xy.find(ref);
          if (!live) continue;
          if (live.nodeType === 3) live = live.parentElement;
          if (!live || live.nodeType !== 1) continue;
          const cl = window.__xy.sanitizeClone(live);
          if (it.outer !== undefined) {
            const html = cl.outerHTML;
            if (html) out2.push({ id: ref, path: it.path, outer: html });
            continue;
          }
          const kids = [...cl.children].map(c2 => c2.outerHTML);
          // 比对用规范化串：虚拟滚动每轮整窗重建，data-xy-id 随元素新建而变化，
          // 内容本体相同——剥离 id 属性后比对（发送内容保留原串，新行携带新 id）
          const norm = (h2) => h2.replace(/ data-xy-id="\d+"/g, '');
          const kidsN = kids.map(norm);
          const kidsKey = (typeof ref === 'number' ? '#' + ref : 'p' + it.path) + ':kids';
          const prev = window.__xyKids.get(kidsKey);
          if (prev && prev.length >= 4 && kidsN.length >= 4 && window.__xyKids.size <= 32) {
            // 下移检测：old.slice(k) ≡ new[0..len-k)
            let shift = 0;
            for (let k = 1; k <= prev.length - 4; k++) {
              if (prev.slice(k).every((h3, i) => h3 === kidsN[i]) && prev.length - k <= kidsN.length) { shift = k; break; }
            }
            if (shift > 0) {
              const tail = kids.slice(prev.length - shift).join('');
              window.__xyKids.set(kidsKey, kidsN);
              if (tail) out2.push({ id: typeof ref === 'number' ? ref : undefined, path: it.path, delHead: shift, append: tail });
              else out2.push({ id: typeof ref === 'number' ? ref : undefined, path: it.path, delHead: shift });
              continue;
            }
            // 上移检测：new 尾段 ≡ old[0..len-k)
            let shift2 = 0;
            for (let k = 1; k <= prev.length - 4; k++) {
              if (prev.slice(0, prev.length - k).every((h3, i) => h3 === kidsN[i + k]) && prev.length - k <= kidsN.length) { shift2 = k; break; }
            }
            if (shift2 > 0) {
              const head = kids.slice(0, shift2).join('');
              window.__xyKids.set(kidsKey, kidsN);
              if (head) out2.push({ id: typeof ref === 'number' ? ref : undefined, path: it.path, prepend: head, delTail: shift2 });
              else out2.push({ id: typeof ref === 'number' ? ref : undefined, path: it.path, delTail: shift2 });
              continue;
            }
            // v0.24 LCS 子序列编辑脚本（kidKeep/kidIns）：覆盖窗口边界与混合
            // 批次形态（纯平移检测的回退场景）。规范化串整数化后 O(n·m) DP
            // （n,m≤64），keep=旧序索引（客户端按新序重排并复用保留节点），
            // ins=[新序位置, 原始 html]。仅元素子节点容器可用（文本节点不参与
            // children 序列，混入会丢内容）；编码比整窗省 30%+ 才启用
            const elOnly = [...cl.childNodes].every((n2) => n2.nodeType === 1);
            if (elOnly && kidsN.length <= 64 && prev.length <= 64) {
              const idMap = new Map();
              const a = prev.map((s2) => { if (!idMap.has(s2)) idMap.set(s2, idMap.size); return idMap.get(s2); });
              const b = kidsN.map((s2) => { if (!idMap.has(s2)) idMap.set(s2, idMap.size); return idMap.get(s2); });
              const n2 = a.length, m2 = b.length;
              const dp = [];
              for (let i2 = 0; i2 <= n2; i2++) dp.push(new Int32Array(m2 + 1));
              for (let i2 = n2 - 1; i2 >= 0; i2--) for (let j2 = m2 - 1; j2 >= 0; j2--) dp[i2][j2] = a[i2] === b[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
              const keepIdx = [];
              const keptNew = [];
              let i3 = 0, j3 = 0;
              while (i3 < n2 && j3 < m2) {
                if (a[i3] === b[j3]) { keepIdx.push(i3); keptNew.push(j3); i3++; j3++; }
                else if (dp[i3 + 1][j3] >= dp[i3][j3 + 1]) i3++;
                else j3++;
              }
              const keptSet = new Set(keptNew);
              const insOps = [];
              for (let jj = 0; jj < m2; jj++) if (!keptSet.has(jj)) insOps.push([jj, kids[jj]]);
              const encSize = keepIdx.length * 3 + insOps.reduce((s3, x2) => s3 + x2[1].length + 6, 0) + 40;
              const innerLen = cl.innerHTML.length;
              if (keepIdx.length >= 2 && encSize < innerLen * 0.7) {
                window.__xyKids.set(kidsKey, kidsN);
                out2.push({ id: typeof ref === 'number' ? ref : undefined, path: it.path, kidKeep: keepIdx, kidIns: insOps, kidTotal: m2 });
                continue;
              }
            }
          }
          window.__xyKids.set(kidsKey, kidsN);
          const html = cl.innerHTML;
          if (html) out2.push({ id: typeof ref === 'number' ? ref : undefined, path: it.path, inner: html });
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
      const key = (p.id !== undefined ? 'o#' + p.id : 'p:' + (p.path ?? '')) + (p.outer !== undefined ? ':o' : ':i');
      // v0.23：inner 去重用规范化串（剥离 data-xy-id）——虚拟滚动整窗重建时
      // 内容相同但元素新建导致 id 全变，原文比对必然 miss 而重复整窗下发
      const html = p.outer !== undefined ? p.outer : (p.inner !== undefined ? p.inner.replace(/ data-xy-id="\d+"/g, '') : JSON.stringify(p));
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
  // GL 下的 WebGL）零流量。v0.22 自适应节奏：可见动画画布升到 ~8fps 快档
  // （120ms tick），静止画布指数退避不变；rAF 门改相邻 tick 差分（无 260ms
  // 阻塞），捕获列表 600ms 缓存，每秒捕获总数预算 12 封顶 CPU
  function startCanvasWatch() {
    if (canvasTimer) return;
    const sigs = createCanvasSigs();
    canvasSigsReset = sigs.clear;
    let canvasBusy = false;
    let rafLast = { n: -1, at: 0 };
    let listCache = { at: 0, list: null };
    const captureTimes = [];
    canvasTimer = setInterval(async () => {
      if (canvasBusy) return;
      if (mode !== 'dom' || !domActive || dead || !page || !cdp || ws.readyState !== 1) return;
      canvasBusy = true;
      try {
        const now = Date.now();
        // 捕获列表 600ms 缓存（坐标为页面绝对值，滚动安全；可见性过滤随之）
        if (!listCache.list || now - listCache.at > 600) {
          const fresh = await withTimeout(page.evaluate(canvasList), 1500, 'canvasList').catch(() => null);
          if (fresh === null) return;
          listCache = { at: now, list: fresh };
        }
        const list = listCache.list;
        if (!list.length) { if (sigs.size) sigs.clear(); return; }
        // rAF 活动门（轻量差分版）：相邻 tick 采样 __xyRafCount，300ms 无增量
        // = 动画循环停转 → canvas 必然静止零捕获（静止 canvas 的持续捕获曾是
        // CPU 大头：实测 34-47%）
        const rafN = await withTimeout(page.evaluate(() => window.__xyRafCount || 0), 400, 'rafN').catch(() => null);
        if (rafN === null) return;
        if (rafN === rafLast.n) { if (Date.now() - rafLast.at > 300 && !list.some((it) => it.kind === 'elbit' && it.fresh) && !list.some((it) => it.hot)) return; }
        else rafLast = { n: rafN, at: Date.now() };
        const nowMs = Date.now();
        while (captureTimes.length && nowMs - captureTimes[0] > 1000) captureTimes.shift();
        for (const it of list) {
          // 未变化画布指数退避：450ms→900→1800→3600 封顶；一变化即复位
          // （v0.14：键改为节点 id——影子内画布 path 可为 null）
          const sigKey = it.id !== undefined ? it.id : it.path;
          if (!sigs.due(sigKey, nowMs)) continue;
          // 每秒捕获预算（≤12）：快档动画画布不挤占整页；预算内按列表序优先
          if (captureTimes.length >= 12) break;
          const shot = await withTimeout(sessionExclusive(() => cdp.send('Page.captureScreenshot', {
            format: 'png',
            clip: { x: it.x, y: it.y, width: it.w, height: it.h, scale: DPR },
            captureBeyondViewport: true,
          })), 3000, 'canvasShot').catch(() => null);
          if (!shot) continue;
          captureTimes.push(Date.now());
          let sig = null;
          try {
            if (sharp) {
              const { info, data } = await sharp(Buffer.from(shot.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
              sig = { w: info.width, h: info.height, data };
            } else sig = { w: 0, h: 0, data: Buffer.from(shot.data, 'base64') };
          } catch (e) {}
          if (!sigs.record(sigKey, sig, Date.now(), { elbit: it.kind === 'elbit' })) continue;
          if (ws.readyState === 1) {
            const pl = JSON.stringify({ type: 'canvas-tile', id: it.id, path: it.path, url: 'data:image/png;base64,' + shot.data });
            ws.send(pl);
            ws._bytes = (ws._bytes || 0) + pl.length;
            ws._chunks = (ws._chunks || 0) + 1;
          }
        }
      } catch (e) {} finally { canvasBusy = false; }
    }, 120);
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
        return { tiles: [{ w: W, h: H, cssX: Math.round(meta.sx || 0), cssY: Math.round(meta.sy || 0),
          cssW: W / DPR, cssH: H / DPR, url: 'data:image/png;base64,' + b64 }], full: true };
      }
      const { dirtyRows, any } = scanDirtyRows(data, prevRaw, W, H, CH);
      prevRaw = data; prevW = W; prevH = H;
      if (!any) return { tiles: [] };
      const tiles = [];
      for (const [rx, ry, rw, rh] of dirtyRects(dirtyRows, W, H)) {
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
    // v0.30：池化时会话取常驻浏览器的独立上下文（隔离 cookie/存储），结束只关
    // 上下文不关浏览器；无池保持历史一会话一浏览器
    let poolHandle = null;
    let b;
    let warmEntry = null; // v0.32 镜像复用：热页命中时免 context 创建与冷加载
    if (browserPool && warmPages) {
      try { warmPages.register(sessionOrigin, sessionOrigin); } catch (e) {}
      try {
        warmEntry = warmPages.take(sessionOrigin);
        if (warmEntry) {
          poolHandle = warmEntry.handle;
          page = warmEntry.page;
          try { page.off('request', warmEntry.reqHandler); } catch (e2) {}
          b = poolHandle.browser;
          sessionExclusive = poolHandle.exclusive;
          sessionRelease = poolHandle.release;
          logger.log('[warm  ] take', warmEntry.url, 'age', Date.now() - warmEntry.loadedAt, 'ms');
        }
      } catch (e) {
        logger.log('[warm  ] take fail:', e && e.message);
        warmEntry = null; poolHandle = null;
      }
    }
    if (browserPool && !warmEntry) {
      // v0.32 镜像复用：冷路径启动——预热立即让位（中止在途/释放库存），
      // 真实访客绝不等在预热后面（小池下预热隐形占位曾致会话 20s 干等）
      if (warmPages) { try { warmPages.yieldForSession(); } catch (e) {} }
      // v0.30 自愈：newPage 20s 竞速——宿主高压下实测池浏览器可能连接存活但
      // newPage 永久悬挂；超时逐出该实例重取一次，仍败回退独立浏览器保证会话必达
      const takePooled = () => Promise.race([
        (async () => {
          const h = await browserPool.acquire();
          const page = await h.context.newPage();
          return { h, page };
        })(),
        // 竞速覆盖 acquire+createBrowserContext+newPage 全链（实测悬挂点可在
        // 任一环——宿主高压下 createBrowserContext 也曾永久挂起）
        new Promise((_, rej) => setTimeout(() => rej(new Error('pool acquire timeout')), 20000)),
      ]);
      try {
        ({ h: poolHandle, page } = await takePooled());
      } catch (e) {
        logger.log('[pool  ] acquire retry after:', e && e.message);
        if (poolHandle) { const bad = poolHandle.browser; await poolHandle.release().catch(() => {}); browserPool.evict(bad); poolHandle = null; }
        else browserPool.evictIdle();
        try {
          ({ h: poolHandle, page } = await takePooled());
        } catch (e2) {
          logger.log('[pool  ] fallback to standalone browser:', e2 && e2.message);
          if (poolHandle) { await poolHandle.release().catch(() => {}); poolHandle = null; }
        }
      }
      if (poolHandle) {
        b = poolHandle.browser;
        sessionExclusive = poolHandle.exclusive;
        sessionRelease = poolHandle.release;
      } else {
        b = await launchSessionBrowser();
      }
    } else if (!browserPool) {
      b = await launchSessionBrowser();
    }
    if (dead) { if (poolHandle) await poolHandle.release(); else await b.close(); return; }
    sessionBrowser = b;
    // 弹窗不镜像且不受页面拦截约束：除会话页面外新建的页面一律关闭
    b.on('targetcreated', (t) => {
      if (!page || t.type() !== 'page' || t === page.target()) return;
      // v0.30：池化时同浏览器还有其他会话的上下文——只关本上下文的弹窗
      if (poolHandle && t.browserContext && t.browserContext() !== poolHandle.context) return;
      t.page().then((p) => p && p.close()).catch(() => {});
    });
    b.on('disconnected', () => {
      if (dead) return;
      sendJson({ type: 'error', code: 'SESSION_EXPIRED', terminal: true, msg: '服务端浏览器已关闭，请核对上次提交结果后重新开始' });
      ws.close(1011, 'browser closed');
    });
    if (!page) page = poolHandle ? await poolHandle.context.newPage() : await b.newPage();
    if (dead) { await page.close(); return; }
    // v0.27 closed shadow 捕获：attachShadow 补丁在页面任何脚本之前安装
    //（evaluateOnNewDocument），parse 期创建的 closed root 也进注册表——此前
    // helpers 在 networkidle0 后注入，注入前创建的 closed root 永远拿不到引用。
    // 注册表：WeakMap(host→root) + 有界数组（全量注入后补挂 observer 用）。
    // 声明式 <template shadowrootmode="closed">（HTML 解析器直接挂载，不调
    // attachShadow）规范上无回调，仍不可观测——见 FIDELITY.md 边界定案。
    // （宿主单测以仅含 createCDPSession/close 的 mock page 驱动——能力守卫）
    if (typeof page.evaluateOnNewDocument === 'function') await page.evaluateOnNewDocument(() => {
      if (window.__xyEarlyShadow) return;
      window.__xyEarlyShadow = true;
      try {
        window.__xyClosedRoots = new WeakMap();
        window.__xyClosedList = [];
        const orig = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (init) {
          const sr = orig.call(this, init);
          try {
            if (sr && init && init.mode === 'closed') {
              window.__xyClosedRoots.set(this, sr);
              if (window.__xyClosedList.length < 64) window.__xyClosedList.push({ host: this, root: sr });
            }
          } catch (e) {}
          return sr;
        };
      } catch (e) {}
    });
    cdp = await page.createCDPSession();
    if (dead) return;
    // 请求白名单（默认拒绝）：服务端浏览器只访问会话源站与显式允许的源，访客无法
    // 借源站链接/跳转/表单把它当作内网跳板。puppeteer 拦截同时覆盖跨站 iframe（OOPIF）
    const requestOrigins = new Set([new URL(sessionOrigin).origin, ...config.crossOriginFrameOrigins, ...config.requestOrigins]);
    navOrigins = requestOrigins;
    if (typeof page.setRequestInterception === 'function') {
      await page.setRequestInterception(true);
      // 弹窗的首个请求发生在新页面上、不经过本页拦截：在页面脚本之前禁用新窗口
      if (typeof page.evaluateOnNewDocument === 'function') await page.evaluateOnNewDocument(() => {
        if (window.__xyNoWinOpen) return;
        window.__xyNoWinOpen = true;
        window.open = () => null;
        const newWindow = (t) => t && !/^_(self|parent|top)$/i.test(t);
        for (const type of ['click', 'submit']) {
          window.addEventListener(type, (e) => {
            const el = e.target && e.target.closest && e.target.closest(type === 'click' ? 'a[target],area[target]' : 'form[target]');
            if (el && newWindow(el.getAttribute('target'))) e.preventDefault();
          }, true);
        }
      });
      page.on('request', (r) => {
        if (requestAllowed(r.url(), requestOrigins)) {
          // v0.32 镜像复用：源站静态资产跨会话共享缓存命中——本地回填免回源
          // 带 Cookie 的请求（登录后鉴权资产）一律绕过缓存直连：网关侧抓取不带
          // 凭据，源站可能回 200 登录页 HTML——当 JS 回给浏览器即中毒（Vikunja
          // 恢复回归实测）；也是跨用户内容污染的载体
          if (originAssetCache && r.method() === 'GET' && !r.headers()['cookie'] && originAssetCache.isCacheableUrl(r.url())) {
            const hit = originAssetCache.get(r.url());
            if (hit) {
              r.respond({ status: hit.status, headers: hit.headers, body: hit.body }).catch(() => {});
              try { logger.log('[cache ] hit', new URL(r.url()).pathname.slice(0, 70)); } catch (e) {}
              return;
            }
            // 未命中：网关侧回源抓取（拦截开启时 response.body() 对部分响应永不
            // settle，捕获式入库不可靠）——入库成功直接回给会话浏览器，失败放行
            fetchOriginAsset(r.url()).then((got) => {
              if (originAssetCache.put(r.url(), got)) {
                const e2 = originAssetCache.get(r.url());
                if (e2) {
                  try { logger.log('[cache ] fill', new URL(r.url()).pathname.slice(0, 70)); } catch (e) {}
                  r.respond({ status: e2.status, headers: e2.headers, body: e2.body }).catch(() => {});
                  return;
                }
              }
              r.continue().catch(() => {});
            }).catch(() => r.continue().catch(() => {}));
            return;
          }
          r.continue().catch(() => {}); return;
        }
        logger.log('[policy] blocked', r.resourceType(), r.url().slice(0, 90));
        // 主框架导航用 aborted：取消而不提交错误页，页面停留原处；子框架与子资源用
        // blockedbyclient（iframe 落到跨源错误页，镜像按跨源占位处理）
        const mainNav = r.isNavigationRequest() && r.frame() === page.mainFrame();
        r.abort(mainNav ? 'aborted' : 'blockedbyclient').catch(() => {});
        if (mainNav) sendJson({ type: 'error', code: 'NAVIGATION_BLOCKED', msg: '目标地址不在允许范围内' });
      });
    }
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

    // 下载通道（v0.13）：源站下载落地会话临时目录，完成后按 ≤48KiB 分块回传并
    // 立即删除服务端文件。文件名 basename 收口 + resolve 目录包含校验（防逃逸）。
    try {
      const browserCdp = await sessionBrowser.target().createCDPSession();
      sessionDownloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-dl-'));
      // v0.30：池化时按 browserContextId 限定下载目录——同浏览器多会话互不串扰
      const dlOpts = { behavior: 'allow', downloadPath: sessionDownloadDir, eventsEnabled: true };
      if (poolHandle && poolHandle.context && poolHandle.context.id) dlOpts.browserContextId = poolHandle.context.id;
      await browserCdp.send('Browser.setDownloadBehavior', dlOpts);
      browserCdpDetached = () => browserCdp.detach().catch(() => {});
    } catch (e) { logger.log('[dl    ] behavior set fail:', e.message); }
    // CDP 事件按域分发：Page.downloadWillBegin/Progress 需要 Page.enable，
    // puppeteer 的独立 CDP 会话默认不启用事件域
    await cdp.send('Page.enable').catch(() => {});
    cdp.on('Page.downloadWillBegin', (ev) => {
      if (dead || ws.readyState !== 1) return;
      const name = path.basename(String(ev.suggestedFilename || 'download.bin'));
      logger.log('[dl    ] willBegin:', name);
      sessionDownloads.set(ev.guid, { name, received: 0 });
      sendJson({ type: 'download-begin', id: ev.guid, name });
    });
    cdp.on('Page.downloadProgress', (ev) => {
      const st = sessionDownloads.get(ev.guid);
      if (!st) return;
      if (ev.state === 'inProgress') {
        st.received = ev.receivedBytes || 0;
        if (st.received > DOWNLOAD_MAX || ev.totalBytes > DOWNLOAD_MAX) {
          cdp.send('Browser.cancelDownload', { guid: ev.guid }).catch(() => {});
        }
        return;
      }
      sessionDownloads.delete(ev.guid);
      if (ev.state === 'canceled') {
        sendJson({ type: 'download-end', id: ev.guid, ok: false, error: 'canceled' });
        return;
      }
      if (ev.state !== 'completed' || dead || ws.readyState !== 1) return;
      (async () => {
        try {
          const dir = path.resolve(sessionDownloadDir);
          const fp = path.resolve(sessionDownloadDir, st.name);
          if (fp !== dir && !fp.startsWith(dir + path.sep)) throw new Error('bad download path');
          const size = (await fsp.stat(fp)).size;
          if (size > DOWNLOAD_MAX) { await fsp.rm(fp, { force: true }); throw new Error('size limit ' + DOWNLOAD_MAX); }
          const buf = await fsp.readFile(fp);
          await fsp.rm(fp, { force: true }).catch(() => {});
          if (buf.length > DOWNLOAD_MAX) throw new Error('size limit ' + DOWNLOAD_MAX);
          sendJson({ type: 'download-begin', id: ev.guid, name: st.name, size: buf.length });
          const CHUNK = 48 * 1024;
          for (let off = 0; off < buf.length; off += CHUNK) {
            if (dead || ws.readyState !== 1) return;
            sendJson({ type: 'download-chunk', id: ev.guid, b64: buf.subarray(off, off + CHUNK).toString('base64') });
          }
          sendJson({ type: 'download-end', id: ev.guid, ok: true, name: st.name, size: buf.length });
          logger.log('[dl    ] delivered:', st.name, buf.length, 'bytes');
        } catch (err) {
          sendJson({ type: 'download-end', id: ev.guid, ok: false, error: String(err && err.message || err) });
        }
      })();
    });


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
                // v0.15：adoptedStyleSheets 内容哈希签名（replace/replaceSync 改内容
                // 不一定改规则数，逐规则字符级哈希；1Hz 一次开销可忽略）
                let adopted = '';
                try {
                  for (const s2 of (document.adoptedStyleSheets || [])) {
                    try {
                      for (const r of s2.cssRules) {
                        const t = r.cssText;
                        let h = 0;
                        for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
                        adopted += h.toString(36) + ',';
                      }
                    } catch (e) {}
                  }
                } catch (e) {}
                return links.join('|') + '#' + document.querySelectorAll('style').length + '#' + adopted;
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
        // v0.30 pseudo-route
        if (frame === page.mainFrame() && ws.readyState === 1) { try { sendJson({ type: 'location', url: frame.url() }); } catch (e2) {} }
        if (frame !== page.mainFrame()) return;
        if (!domActive || ws.readyState !== 1) return;
        navChain = navChain.then(async () => {
          try {
            await page.evaluate(sessHelpers).catch(() => {});
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
    // v0.31 真路由：访客深链路径接管首跳（仅非根路径且形态安全——单个 / 开头、
    // 无协议与反斜杠，防 //host 协议相对地址逃逸出会话源站）
    let initialUrl = sessionOrigin;
    {
      const hp = String(hello.path || '');
      if (hp && hp !== '/' && hp.startsWith('/') && !hp.startsWith('//') && !hp.includes('\\') && !hp.includes('://')) {
        try {
          const u = new URL(sessionOrigin);
          u.pathname = hp.split('?')[0] || '/';
          u.search = hp.includes('?') ? '?' + hp.slice(hp.indexOf('?') + 1) : '';
          if (requestAllowed(u.href, new Set([u.origin]))) initialUrl = u.href;
        } catch (e) {}
      }
    }
    // v0.31 入场动画保真：DCL 即开流。networkidle0 等完整静默，挂载入场动画
    // （框架加动画类→animationend 即移除类）早已结束，首帧快照只余终态，访客
    // 永远看不到动画；从 DCL 起拍首帧，入场序列经快照+补丁在访客端完整重放
    // v0.32 镜像复用：热页命中且访客未深链（initialUrl 未变）时免首跳——热页
    // 即源站入口导航后的稳态，首帧从「快照+WS」起步
    if (warmEntry && initialUrl === sessionOrigin && (Date.now() - warmEntry.loadedAt) <= config.sessionWarmupTtl) {
      logger.log('[warm  ] snapshot-only takeover:', page.url());
    } else {
      await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }
    sendJson({ type: 'meta', w: viewW, h: viewH, title: await page.title(), maxSessions: MAX_SESSIONS, mode, prod: prodMode, warm: !!warmEntry }); // v0.32 热页命中标志（验收可观测）
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

function waitForRevokedClose(socket) {
  if (!socket || socket.readyState === 3) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => socket.terminate(), 1000);
    timer.unref();
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

async function revokeSessions(selected) {
  const pending = [];
  for (const session of selected) {
    const socket = session.socket;
    session.close(4001, 'SESSION_REVOKED');
    pending.push(waitForRevokedClose(socket));
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
  const pending = [result];
  // Includes authenticated transports that have not sent their first hello yet.
  for (const socket of wss.clients) {
    if (socketIdentities.get(socket) === identity && socket.readyState === 1) {
      socket.close(4001, 'SESSION_REVOKED');
      pending.push(waitForRevokedClose(socket));
    }
  }
  await Promise.all(pending);
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
    if (warmPages) await warmPages.stop(); // v0.32 热页库存释放（在池收口前）
    if (browserPool) await browserPool.close(); // v0.30 常驻浏览器统一收口
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
