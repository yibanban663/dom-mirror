'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createMirror } = require('..');

// 回归背景:proxyAsset 的 cache 分支(up.on('data') → chunks.push)对上游
// 响应体无大小上限——白名单源站返回超大 body 时网关全量缓冲(fetchOriginAsset
// 有 4MB 上限, proxyAsset 没有)。恶意/异常源站可致网关内存 DoS。

async function setup(t, bigBytes) {
  // mock 源站: /img.png 流式返回 bigBytes 字节(源站自身内存占用极小)
  const origin = http.createServer((req, res) => {
    if (req.url === '/img.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': bigBytes });
      const chunk = Buffer.alloc(1024 * 1024, 0x41); // 1MB 块
      let sent = 0;
      const pump = () => {
        while (sent < bigBytes) {
          const n = Math.min(chunk.length, bigBytes - sent);
          sent += n;
          if (!res.write(sent === bigBytes ? chunk.subarray(0, n) : chunk)) { res.once('drain', pump); return; }
        }
        res.end();
      };
      pump();
      return;
    }
    res.writeHead(404); res.end();
  });
  t.after(() => { origin.closeAllConnections(); return new Promise(resolve => origin.close(resolve)); });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');

  const rssBefore = process.memoryUsage().rss;
  const mirror = createMirror({ originUrl: `http://127.0.0.1:${origin.address().port}/`, browserPoolSize: 0,
    logger: { log() {} }, originAssetCacheMb: 32 });
  const server = http.createServer(mirror.handleRequest);
  t.after(async () => { await mirror.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { host: 'http://127.0.0.1:' + server.address().port, rssBefore };
}

test('proxy asset response body is size-limited (no unbounded buffering)', { timeout: 60000 }, async t => {
  const bigBytes = 200 * 1024 * 1024; // 200MB 超大上游响应
  const { host, rssBefore } = await setup(t, bigBytes);

  // 发起代理请求; 修复后应快速失败/中断(不缓冲 200MB)
  const r = await new Promise(resolve => {
    const req = http.get(host + '/m/img.png', res => {
      let n = 0;
      res.on('data', c => { n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, received: n }));
    });
    req.on('error', e => resolve({ status: 0, err: e.message.slice(0, 40) }));
    // 安全阀: 15s 未完成即判定挂起/超长
    setTimeout(() => resolve({ status: 'timeout', received: -1 }), 15000);
  });

  const rssAfter = process.memoryUsage().rss;
  const growth = (rssAfter - rssBefore) / 1024 / 1024;
  console.log(`响应状态=${r.status} 收到字节=${r.received} | 网关 RSS 增长=${growth.toFixed(1)}MB`);

  // 绿判定(修复后): 响应被大小上限拒绝(非 200)且 RSS 增长 < 50MB
  const green = (r.status === 502 || r.status === 0) && growth < 50;
  if (!green) {
    console.log(`RED 确认: 上游 ${bigBytes / 1048576}MB 被 ${growth.toFixed(1)}MB 级全量缓冲(无上限)—— 内存 DoS 实证`);
  }
  assert.ok(green, `上游超大响应体不得全量缓冲(实得 status=${r.status}, RSS 增长=${growth.toFixed(1)}MB)`);
});
