'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const timers = require('node:timers');
const { createBrowserPool } = require('../lib/browser-pool');

// 免 Chromium 的假浏览器：只实现池依赖的接口面
function fakeBrowser() {
  const b = {
    connected: true,
    handlers: {},
    once(ev, fn) { b.handlers[ev] = fn; },
    async close() { b.connected = false; b.closed = true; },
    async createBrowserContext() {
      return { async close() {} };
    },
    disconnect() { b.connected = false; if (b.handlers.disconnected) b.handlers.disconnected(); },
  };
  return b;
}

test('v0.38.2 空闲休眠：0 租户超阈值的浏览器全部关闭（含基线），再取重新拉起', async () => {
  let launches = 0;
  const made = [];
  const pool = createBrowserPool({
    size: 2,
    launch: async () => { launches++; const b = fakeBrowser(); made.push(b); return b; },
    logger: { log() {} },
    maxTenants: 4,
    idleHibernateMs: 80,
    sweepIntervalMs: 100,
  });
  const h = await pool.acquire();
  assert.equal(launches, 1);
  assert.deepEqual(pool.stats(), { size: 2, live: 1, idle: 0, tenants: 1 });
  await h.release();
  // 闲置超阈值 + 扫描周期 → 休眠归零
  await new Promise(r => timers.setTimeout(r, 500));
  assert.equal(pool.stats().live, 0, 'idle browser hibernated to zero');
  assert.equal(made[0].closed, true);
  // 再取：按需拉起
  const h2 = await pool.acquire();
  assert.equal(launches, 2);
  assert.equal(pool.stats().live, 1);
  await h2.release();
  await pool.close();
});

test('休眠关闭（默认 0）：基线浏览器闲置常驻，只回收超发', async () => {
  let launches = 0;
  const pool = createBrowserPool({
    size: 1,
    launch: async () => { launches++; return fakeBrowser(); },
    logger: { log() {} },
    idleHibernateMs: 0,
    sweepIntervalMs: 100,
  });
  const h = await pool.acquire();
  await h.release();
  await new Promise(r => timers.setTimeout(r, 300));
  assert.equal(pool.stats().live, 1, 'baseline browser stays (warm reuse)');
  await pool.close();
  assert.equal(launches, 1);
});
