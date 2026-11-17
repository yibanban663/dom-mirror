'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createMirror } = require('..');

// 回归背景:ORIGIN_URL 带子路径(如 https://x.com/blog/)时,客户端资源按
// M_BASE+pathname 改写为 /m/blog/images/x.png,而 proxyAsset 把 rest='blog/...'
// 相对 ORIGIN_BASE(含 /blog/ 子路径)解析 → /blog/blog/images/x.png → 源站 404。
// 实测:ruanyifeng /blog/ 源站镜像中 person2_s.jpg 404,直连同路径 200。

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f6b0000000049454e44ae426082', 'hex');

function mockOrigin(t) {
  const server = http.createServer((req, res) => {
    if (req.url === '/blog/images/x.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
    if (req.url === '/blog/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<img src="images/x.png">'); return; }
    res.writeHead(404); res.end();
  });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => server.address().port);
}

async function mirrorHost(t, originUrl) {
  const mirror = createMirror({ originUrl, browserPoolSize: 0, logger: { log() {} } });
  const server = http.createServer(mirror.handleRequest);
  t.after(async () => { await mirror.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

function get(url) {
  return new Promise(resolve => {
    http.get(url, res => {
      let body = [];
      res.on('data', c => body.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(body) }));
    }).on('error', e => resolve({ status: 0, err: e.message }));
  });
}

test('subpath origin: /m/ asset proxy resolves image under the subpath (no double join)', { timeout: 15000 }, async t => {
  const originPort = await mockOrigin(t);
  const host = await mirrorHost(t, `http://127.0.0.1:${originPort}/blog/`);
  const r = await get(host + '/m/blog/images/x.png');
  assert.equal(r.status, 200, `期望 200(源站 /blog/images/x.png 存在), 实得 ${r.status} —— 子路径被重复拼接`);
  assert.equal(r.body.length, PNG.length);
});

test('subpath origin: asset allowlist still rejects non-asset paths (e.g. HTML) through /m/', { timeout: 15000 }, async t => {
  const originPort = await mockOrigin(t);
  const host = await mirrorHost(t, `http://127.0.0.1:${originPort}/blog/`);
  // 锁定安全行为: /m/ 代理只放行静态资产扩展名, HTML 一律 403(防拉取源站整页明文)
  const r = await get(host + '/m/blog/');
  assert.equal(r.status, 403, 'HTML 经 /m/ 代理应被扩展名白名单 403');
});
