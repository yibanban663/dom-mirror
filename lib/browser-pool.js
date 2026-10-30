'use strict';
// v0.38 租户制实例池：常驻 Chromium × 会话级 BrowserContext 租户。
// 历史形态（≤v0.37）虽已按上下文隔离，但 acquire 把浏览器 shift 出 idle——
// 并发会话实际各占一台 Chromium（池满→20s 干等→超发），"复用"名存实亡。
// 租户制：浏览器常驻池内，会话 attach 上下文（租户数最少优先），满租才等/超发。
// 隔离边界 = BrowserContext（cookie/存储/缓存会话级独立）；同浏览器 CDP 截图
// 全部经 exclusive() 串行（幽灵瓦片防护，v0.30 起所有截图路径已过此闸）。

function createBrowserPool({ size, launch, logger, maxTenants = 4 }) {
  if (!(size > 0)) return null;
  const limit = Math.max(1, maxTenants | 0);
  const pool = new Set(); // { browser, tenants:Set<token>, idleAt, lock }

  const wrap = (browser) => {
    const w = { browser, tenants: new Set(), idleAt: 0, lock: Promise.resolve() };
    browser.once('disconnected', () => pool.delete(w));
    return w;
  };
  const launchNew = async () => {
    const b = await launch();
    const w = wrap(b);
    pool.add(w);
    return w;
  };
  // 租户数最少的健康实例优先（负载摊开；0 租户 = 热浏览器直接复用，免冷启）
  const pickTenantable = () => {
    let best = null;
    for (const w of pool) {
      if (w.browser.connected && w.tenants.size < limit) {
        if (!best || w.tenants.size < best.tenants.size) best = w;
      }
    }
    return best;
  };

  // v0.35 idle 收缩器：超发/闲置浏览器（0 租户且闲置 ≥120s）回收，池回归 size
  // 基线；基线内的 0 租户浏览器保留——热复用的价值就在这里（下一会话免冷启）
  const shrinkTimer = setInterval(() => {
    try {
      const excess = pool.size - size;
      if (excess <= 0) return;
      const idles = [...pool].filter(w => w.tenants.size === 0 && Date.now() - (w.idleAt || 0) >= 120000)
        .sort((a, b) => (a.idleAt || 0) - (b.idleAt || 0));
      let closed = 0;
      for (const w of idles) {
        if (pool.size - size <= 0) break;
        pool.delete(w);
        try { w.browser.close().catch(() => {}); } catch (e) {}
        closed++;
      }
      if (closed) logger.log('[pool  ] shrink: closed', closed, 'excess idle browser(s)');
    } catch (e) {}
  }, 60000);
  if (shrinkTimer && typeof shrinkTimer.unref === 'function') shrinkTimer.unref();

  let seq = 0;
  return {
    async acquire() {
      let w = pickTenantable();
      if (!w && pool.size < size) w = await launchNew();
      if (!w) {
        // 全部满租：等释放（≤20s——context.close 悬挂时不无限等），超时超发一台
        // 保证会话必达（断连即回收，规模受会话上限自然约束）
        const waited = await new Promise(resolve => {
          const t0 = Date.now();
          const t = setInterval(() => {
            const free = pickTenantable();
            if (free || Date.now() - t0 > 20000) { clearInterval(t); resolve(free || null); }
          }, 25);
        });
        w = waited;
        if (!w) {
          try { logger.log('[pool  ] tenant wait timeout, overshoot launch'); } catch (e) {}
          w = await launchNew();
        }
      }
      const token = ++seq;
      const context = await w.browser.createBrowserContext();
      w.tenants.add(token);
      let released = false;
      return {
        browser: w.browser,
        context,
        // 同浏览器互斥段（幽灵瓦片防护）：截图类 CDP 调用经此串行——租户制下
        // 同浏览器并发会话真实存在，此闸成为硬依赖
        exclusive: (fn) => { const run = w.lock.then(fn, fn); w.lock = run.then(() => {}, () => {}); return run; },
        release: async () => {
          if (released) return;
          released = true;
          w.tenants.delete(token);
          if (w.tenants.size === 0) w.idleAt = Date.now();
          // close 5s 竞速：悬挂不再阻塞回收（宿主高压下偶发永久挂起）
          try {
            await Promise.race([
              context.close(),
              new Promise((_, rej) => setTimeout(() => rej(new Error('ctx close timeout')), 5000)),
            ]);
          } catch (e) { try { if (String(e && e.message) === 'ctx close timeout') logger.log('[pool  ] context close timeout, recycle anyway'); } catch (e2) {} }
        },
      };
    },
    stats: () => {
      let idle = 0, tenants = 0;
      for (const w of pool) { if (w.tenants.size === 0 && w.browser.connected) idle++; tenants += w.tenants.size; }
      return { size, live: pool.size, idle, tenants };
    },
    evictIdle: () => {
      for (const w of [...pool]) {
        if (w.tenants.size === 0) {
          pool.delete(w);
          try { w.browser.close().catch(() => {}); } catch (e) {}
        }
      }
      try { logger.log('[pool  ] evicted all idle browsers (acquire timeout)'); } catch (e2) {}
    },
    // 逐出指定浏览器：租户制下同浏览器还挂着其他会话——只在无并发租户时才整
    // 实例逐出，否则放回（自己的 context 悬挂不该陪葬别人的会话）
    evict: (browser) => {
      for (const w of [...pool]) {
        if (w.browser === browser) {
          if (w.tenants.size > 1) { try { logger.log('[pool  ] evict skipped: browser has', w.tenants.size, 'tenants'); } catch (e) {} return; }
          pool.delete(w);
          try { browser.close().catch(() => {}); } catch (e) {}
          try { logger.log('[pool  ] evicted wedged browser'); } catch (e2) {}
          return;
        }
      }
    },
    async close() {
      try { clearInterval(shrinkTimer); } catch (e) {}
      await Promise.allSettled([...pool].map(w => w.browser.close()));
      pool.clear();
    },
  };
}

module.exports = { createBrowserPool };
