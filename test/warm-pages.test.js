'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createWarmPageManager } = require('../lib/warm-pages');

// mock：浏览器池 + context + page（只实现 warm 管理器用到的面）
function makeMocks({ idle = 2, live = 0 } = {}) {
  const state = { released: 0, pages: [] };
  function makePage() {
    const p = {
      handlers: new Map(),
      loadedUrl: '',
      async setRequestInterception() {},
      async evaluateOnNewDocument() {},
      async goto(url) { p.loadedUrl = url; return null; },
      url: () => p.loadedUrl,
      on: (ev, fn) => { p.handlers.set(ev, fn); },
      off: (ev, fn) => { if (p.handlers.get(ev) === fn) p.handlers.delete(ev); },
    };
    state.pages.push(p);
    return p;
  }
  const pool = {
    stats: () => ({ size: live + idle, live, idle }),
    acquire: async () => {
      live += 1; idle -= 1;
      return {
        browser: { id: state.released },
        context: { newPage: async () => makePage() },
        exclusive: (fn) => fn(),
        release: async () => { state.released += 1; live -= 1; idle += 1; },
      };
    },
  };
  return { pool, state };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('注册后台预热 → take 取走单条且清空', async () => {
  const { pool, state } = makeMocks();
  const mgr = createWarmPageManager({ browserPool: pool, warmup: 1, ttlMs: 60000, requestAllowed: () => true, logger: { log: () => {} } });
  await mgr.register('http://a/', 'http://a/');
  await sleep(50);
  assert.equal(mgr.stats().entries, 1);
  const e = mgr.take('http://a/');
  assert.ok(e && e.page === state.pages[0]);
  assert.equal(e.url, 'http://a/');
  assert.equal(mgr.stats().entries, 0);
  assert.ok(e.page.handlers.has('request')); // 预热期拦截器仍挂着（会话侧负责 off）
  await mgr.stop();
});

test('容量占用（live>=size）时不预热——绝不与在线会话抢容量', async () => {
  const { pool } = makeMocks({ idle: 0, live: 2 });
  const mgr = createWarmPageManager({ browserPool: pool, warmup: 1, ttlMs: 60000, requestAllowed: () => true, logger: { log: () => {} } });
  await mgr.register('http://a/', 'http://a/');
  await sleep(50);
  assert.equal(mgr.stats().entries, 0);
  await mgr.stop();
});

test('TTL 过期清仓：过期热页被释放', async () => {
  const { pool, state } = makeMocks();
  const mgr = createWarmPageManager({ browserPool: pool, warmup: 1, ttlMs: 40, requestAllowed: () => true, logger: { log: () => {} } });
  await mgr.register('http://a/', 'http://a/');
  await sleep(60);
  await mgr.ensure('http://a/', 'http://a/'); // 触发过期清理 + 重建
  await sleep(60);
  assert.ok(state.released >= 1, '过期热页应被释放至少一次');
  await mgr.stop();
});

test('stop 释放全部库存', async () => {
  const { pool, state } = makeMocks();
  const mgr = createWarmPageManager({ browserPool: pool, warmup: 2, ttlMs: 60000, requestAllowed: () => true, logger: { log: () => {} } });
  await mgr.register('http://a/', 'http://a/');
  await sleep(50);
  await mgr.ensure('http://a/', 'http://a/'); // ensure 单次只补一页：手动补满
  await sleep(50);
  assert.equal(mgr.stats().entries, 2); // warmup=2 全部就位
  await mgr.stop();
  assert.equal(mgr.stats().entries, 0);
  assert.equal(state.released, 2);
});

test('yieldForSession：中止在途预热并释放库存（在线会话优先）', async () => {
  const { pool, state } = makeMocks({ idle: 1, live: 0 });
  const mgr = createWarmPageManager({ browserPool: pool, warmup: 1, ttlMs: 60000, requestAllowed: () => true, logger: { log: () => {} } });
  await mgr.register('http://a/', 'http://a/');
  await sleep(40);
  assert.equal(mgr.stats().entries, 1);
  mgr.register('http://a/', 'http://a/'); // 触发第二个在途预热不了（warmup=1），改注入在途：直接 yield
  const freed = mgr.yieldForSession();
  assert.ok(freed >= 1);
  await sleep(60);
  assert.equal(mgr.stats().entries, 0);
  assert.ok(state.released >= 1);
  await mgr.stop();
});

test('无池/关预热返回 null', () => {
  assert.equal(createWarmPageManager({ browserPool: null, warmup: 1 }), null);
  const { pool } = makeMocks();
  assert.equal(createWarmPageManager({ browserPool: pool, warmup: 0 }), null);
});
