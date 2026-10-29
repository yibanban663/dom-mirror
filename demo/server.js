'use strict';

const http = require('node:http');
const path = require('node:path');
const { createStaticFiles } = require('../lib/static');

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function startDemo(createMirror = require('..').createMirror) {
  const files = createStaticFiles();
  // v0.31 anim 基准用：/__delay/<ms> 可控延迟响应（拖住 networkidle0 静默判定，
  // 让「首帧等静默」与「首帧 DCL 起流」两种语义在本用例下红绿可判）
  const originStatic = files.staticHandler(path.join(__dirname, '..', 'protected'));
  const origin = http.createServer((req, res) => {
    let dm = null;
    try { dm = new URL(req.url, 'http://x').pathname.match(/^\/(__delay)\/(\d+)$/); } catch (e) {}
    if (dm) {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('ok'); }, Math.min(30000, Number(dm[2]) || 0));
      return;
    }
    originStatic(req, res);
  });
  const servers = [origin];
  let mirror;
  let closing;
  const close = () => closing ??= (async () => {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await mirror?.close();
    await Promise.all(servers.map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })));
    files.clear();
  })();
  const stop = () => { close().catch(error => { console.error(error); process.exitCode = 1; }); };
  try {
    await listen(origin, Number(process.env.ORIGIN_PORT ?? 8077), '127.0.0.1');
    mirror = createMirror({
      originUrl: process.env.ORIGIN_URL || `http://127.0.0.1:${origin.address().port}/`,
      width: Number(process.env.VIEW_W ?? 1280),
      height: Number(process.env.VIEW_H ?? 800),
      maxSessions: Number(process.env.MAX_SESSIONS ?? 3),
      sessionGraceMs: Number(process.env.SESSION_GRACE_MS ?? 60000),
      allowedOrigins: (process.env.RBI_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean),
      crossOriginFrameOrigins: (process.env.XFRAME_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean),
      requestOrigins: (process.env.REQUEST_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean),
      defaultMode: process.env.DEFAULT_MODE || 'dom',
      presentation: process.env.PROD_PRESENTATION === '1' ? 'embedded' : 'demo',
      // v0.36.2：混淆改为显式开启（OBFUSCATE=1）。此前默认开——池缺省时自动降级
      // 掩盖了这一点；池子烘焙进镜像后默认翻转，所有断言中文明文的回归全红。
      // 库层默认仍为 true（宿主显式关）；运行面显式开是运维自觉的 WAF 姿态
      obfuscate: process.env.OBFUSCATE === '1',
      canvasStream: process.env.CANVAS_STREAM !== '0',
      elbit: process.env.XY_ELBIT !== '0',
      chromiumSandbox: process.env.CHROMIUM_SANDBOX !== '0',
      // v0.30：池随会话上限缩放（min 半数、至少 2）——burst 下排队窗口可控；测试环境 maxSessions 2-3 → 2 不变
      browserPoolSize: process.env.BROWSER_POOL !== undefined ? Number(process.env.BROWSER_POOL) : Math.max(2, Math.ceil((Number(process.env.MAX_SESSIONS) || 3) / 2)),
      // v0.32 镜像复用：热页与源站资产缓存（演示/生产默认开；0 关）
      sessionWarmup: process.env.SESSION_WARMUP !== undefined ? Number(process.env.SESSION_WARMUP) : 1,
      sessionWarmupTtl: Number(process.env.SESSION_WARMUP_TTL) || 90000,
      originAssetCacheMb: process.env.ORIGIN_ASSET_CACHE_MB !== undefined ? Number(process.env.ORIGIN_ASSET_CACHE_MB) : 32,
      originAssetCacheTtl: Number(process.env.ORIGIN_ASSET_CACHE_TTL) || 120000,
      sessionGraceMs: Number(process.env.SESSION_GRACE_MS) || 60000,
      maskInputTypes: (process.env.MASK_INPUT_TYPES || '').split(',').map(v => v.trim()).filter(Boolean),
    });
    const server = http.createServer(mirror.handleRequest);
    servers.push(server);
    server.on('upgrade', mirror.handleUpgrade);
    await listen(server, Number(process.env.DEMO_PORT ?? 8088), '0.0.0.0');
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    console.log(`[origin] protected site on 127.0.0.1:${origin.address().port} (loopback only)`);
    console.log(`[demo  ] listening on 0.0.0.0:${server.address().port}`);
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (require.main === module) {
  startDemo().catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { startDemo };
