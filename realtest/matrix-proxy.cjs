'use strict';
// 实测矩阵: 白名单源站大资产 × 修复前/后 行为与内存对照
// 用法: node matrix-proxy.cjs   (SERVER_MODULE 可指定修复前源码副本)
const http = require('node:http');
const { once } = require('node:events');
const { createMirror } = require(process.env.SERVER_MODULE || '../');
const MB = 1024 * 1024;

// 场景: idx → 字节数(全部 .png 白名单扩展; 独立 URL 防缓存串扰)
const SIZES = { 0: 1024, 1: 10 * MB, 2: 200 * MB };

async function scenario(host, idx, label, mode) {
  const bytes = SIZES[idx];
  const t0 = Date.now();
  const rssBefore = process.memoryUsage().rss;
  const r = await new Promise(resolve => {
    const req = http.get(host + '/m/big' + idx + '.png', res => {
      let n = 0;
      res.on('data', c => { n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, received: n, ms: Date.now() - t0 }));
      res.on('error', e => resolve({ status: res.statusCode || 0, received: n, err: e.message.slice(0, 30), ms: Date.now() - t0 }));
    });
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 'timeout', received: -1, ms: Date.now() - t0 }); });
  });
  const growth = (process.memoryUsage().rss - rssBefore) / MB;
  console.log(`  [${mode}] ${label} → status=${r.status} 收到=${(r.received / MB).toFixed(2)}MB 耗时=${r.ms}ms 网关RSS增长=${growth.toFixed(1)}MB`);
  return r;
}

(async () => {
  console.log(`===== 代理大资产实测矩阵(模式: ${process.env.FIX_MODE || 'after'}) =====`);
  // mock 源站: /big<idx>.png 按 SIZES 返回
  const origin = http.createServer((req, res) => {
    const m = req.url.match(/\/big(\d)\.png/);
    if (m && SIZES[m[1]]) {
      const bytes = SIZES[m[1]];
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes });
      const chunk = Buffer.alloc(1024 * 1024, 0x41);
      let sent = 0;
      const pump = () => { while (sent < bytes) { const n = Math.min(chunk.length, bytes - sent); sent += n; if (!res.write(sent === bytes ? chunk.subarray(0, n) : chunk)) { res.once('drain', pump); return; } } res.end(); };
      pump();
      return;
    }
    res.writeHead(404); res.end();
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');

  const mirror = createMirror({ originUrl: `http://127.0.0.1:${origin.address().port}/`, browserPoolSize: 0,
    logger: { log() {} }, originAssetCacheMb: 32 });
  const server = http.createServer(mirror.handleRequest);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = 'http://127.0.0.1:' + server.address().port;

  for (const [idx, label] of [['0', 'S0 正常小图'], ['1', 'S1 大 png 10MB'], ['2', 'S2 超大 200MB']]) {
    await scenario(host, idx, label, process.env.FIX_MODE || 'after');
  }

  await mirror.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); origin.close();
  console.log('矩阵完成');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
