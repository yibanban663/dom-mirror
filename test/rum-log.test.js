'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createMirror } = require('..');

// 回归背景:POST /rum 的 body 未净化直接拼接进审计日志
// (logger.log('[rum-beacon] ' + body))——body 中的 CRLF 使攻击者可注入
// 任意伪造日志行, 破坏审计完整性。修复:body 单行化后再落日志。

async function host(t) {
  const collected = [];
  const mirror = createMirror({ originUrl: 'http://127.0.0.1:1/', browserPoolSize: 0,
    logger: { log: (...a) => collected.push(a.map(String).join(' ')) } });
  const server = http.createServer(mirror.handleRequest);
  t.after(async () => { await mirror.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { mirror, port: server.address().port, collected };
}

const postRum = (port, headers, body) => new Promise(resolve => {
  const req = http.request({ host: '127.0.0.1', port, path: '/rum', method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
  req.on('error', () => resolve(0));
  req.end(body);
});

test('rum beacon body is logged as a single line (CRLF sanitized)', { timeout: 10000 }, async t => {
  const { port, collected } = await host(t);
  const payload = '{"s":1}\r\n[net] FAKE-INJECTED-LOG-LINE (伪造审计行)';
  const status = await postRum(port, { origin: `http://127.0.0.1:${port}` }, payload);
  assert.equal(status, 204);
  await new Promise(r => setTimeout(r, 100));
  const rumLines = collected.filter(l => l.includes('[rum-beacon]'));
  assert.equal(rumLines.length, 1, '恰一条 rum 日志');
  // 伪造行不得成为独立日志条目
  const forgedAsEntry = collected.some(l => l.startsWith('[net] FAKE') || l.trim() === '[net] FAKE-INJECTED-LOG-LINE (伪造审计行)');
  assert.equal(forgedAsEntry, false, '伪造行不得作为独立日志条目');
  // rum 行自身必须单行(内嵌换行已转义)
  assert.ok(!rumLines[0].includes('\n'), 'rum 日志行必须单行');
});

test('rum rejects cross-origin and missing-origin beacons', { timeout: 10000 }, async t => {
  const { port, collected } = await host(t);
  const post = (prt, headers, body) => new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: prt, path: '/rum', method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
    req.on('error', () => resolve(0));
    req.end(body);
  });
  const cross = await post(port, { origin: 'http://evil.example.com' }, '{"s":1}');
  const none = await post(port, {}, '{"s":1}');
  assert.equal(cross, 403, '跨源 beacon 403');
  assert.equal(none, 403, '无来源 beacon 403');
  assert.equal(collected.filter(l => l.includes('[rum-beacon]')).length, 0, '被拒 beacon 不落日志');
});
