'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createOriginAssetCache } = require('../lib/origin-asset-cache');

test('isCacheableUrl 只认 http(s) 静态扩展名', () => {
  const c = createOriginAssetCache({});
  assert.equal(c.isCacheableUrl('http://x/a.css'), true);
  assert.equal(c.isCacheableUrl('https://x/a.JS'), true);
  assert.equal(c.isCacheableUrl('https://x/a.woff2'), true);
  assert.equal(c.isCacheableUrl('http://x/a.html'), false);
  assert.equal(c.isCacheableUrl('http://x/api/users'), false);
  assert.equal(c.isCacheableUrl('data:text/css,body{}'), false);
});

test('shouldStore 保守规则：set-cookie/no-store/private/Vary 凭据一律不入库', () => {
  const c = createOriginAssetCache({});
  assert.equal(c.shouldStore(200, {}), true);
  assert.equal(c.shouldStore(200, { 'cache-control': 'public, max-age=60' }), true);
  assert.equal(c.shouldStore(200, { 'set-cookie': 'sid=1' }), false);
  assert.equal(c.shouldStore(200, { 'cache-control': 'no-store' }), false);
  assert.equal(c.shouldStore(200, { 'cache-control': 'private' }), false);
  assert.equal(c.shouldStore(200, { vary: 'Cookie' }), false);
  assert.equal(c.shouldStore(200, { vary: 'Accept-Encoding' }), true);
  assert.equal(c.shouldStore(304, {}), false);
});

test('put/get 往返：剥编码头并按实际 body 重算 content-length', () => {
  const c = createOriginAssetCache({});
  const body = Buffer.from('.a{color:red}');
  assert.equal(c.put('http://x/a.css', { status: 200, headers: { 'content-type': 'text/css', 'content-encoding': 'gzip', 'content-length': '999' }, body }), true);
  const hit = c.get('http://x/a.css');
  assert.ok(hit);
  assert.equal(hit.headers['content-length'], String(body.length));
  assert.equal(hit.headers['content-encoding'], undefined);
  assert.equal(hit.body.equals(body), true);
});

test('TTL：max-age 限幅 [30s,600s]，无 cache-control 用默认', async () => {
  let t = 1000;
  const c = createOriginAssetCache({ defaultTtlMs: 500, now: () => t });
  c.put('http://x/a.css', { status: 200, headers: { 'cache-control': 'max-age=3600' }, body: Buffer.from('a') });
  t += 599000;
  assert.ok(c.get('http://x/a.css')); // 600s 上限内
  t += 2000;
  assert.equal(c.get('http://x/a.css'), null); // 过期
  c.put('http://x/b.css', { status: 200, headers: {}, body: Buffer.from('b') });
  t += 501;
  assert.equal(c.get('http://x/b.css'), null); // 默认 TTL
});

test('字节上限 LRU 逐出：超限逐最旧，touch 保新', () => {
  let t = 1000;
  const c = createOriginAssetCache({ maxBytes: 3200, now: () => t });
  const kb = (n) => Buffer.alloc(1024 * n, 7);
  c.put('http://x/a.js', { status: 200, headers: {}, body: kb(1) }); // 1536B
  t += 1;
  c.put('http://x/b.js', { status: 200, headers: {}, body: kb(1) }); // 3072B ≤ 3200
  t += 1;
  assert.ok(c.get('http://x/a.js')); // LRU touch a（仍在库）
  t += 1;
  c.put('http://x/c.js', { status: 200, headers: {}, body: kb(1) }); // 4608 > 3200 → 逐最旧
  assert.equal(c.get('http://x/b.js'), null); // 未 touch 的 b 被逐
  assert.ok(c.get('http://x/a.js')); // touch 过的 a 保留
  assert.ok(c.get('http://x/c.js'));
  assert.ok(c.stats().bytes <= 3200 + 512);
});

test('超限单体不入库', () => {
  const c = createOriginAssetCache({ maxBytes: 1024 * 1024 });
  const big = Buffer.alloc(c.maxEntryBytes + 1, 1);
  assert.equal(c.put('http://x/big.js', { status: 200, headers: {}, body: big }), false);
  assert.equal(c.get('http://x/big.js'), null);
});
