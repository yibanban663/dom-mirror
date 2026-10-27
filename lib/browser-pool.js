'use strict';
// v0.30 实例池：N 个常驻 Chromium × 会话级 BrowserContext 复用。
// 历史形态一会话一浏览器——MAX_SESSIONS=8 即 8 个 Chrome 进程（内存大头）；
// 池化后 N 进程承载全部会话，上下文（cookie/存储/缓存）保持会话级隔离。
// 历史幽灵瓦片（同浏览器并发截图错位）以每浏览器截图互斥兜底：所有
// Page.captureScreenshot 必须 经 exclusive() 串行执行。

function createBrowserPool({ size, launch, logger }) {
  if (!(size > 0)) return null;
  const idle = [];
  const live = new Set();
  const wrap = (browser) => {
    const w = { browser, busy: 0, lock: Promise.resolve() };
    browser.once('disconnected', () => {
      live.delete(w);
      const i = idle.indexOf(w);
      if (i >= 0) idle.splice(i, 1);
    });
    return w;
  };
  const getOrCreate = async () => {
    if (idle.length) return idle.shift();
    if (live.size < size) {
      const b = await launch();
      const w = wrap(b);
      live.add(w);
      return w;
    }
    // 容量已满：等释放，但不超过 20s——busy 实例的 context.close() 悬挂时
    // （宿主高压实测）等不到释放；超时后允许超发一台保证会话必达（_DISCONNECTED
    // 即回收，规模受会话上限自然约束）
    const waited = await new Promise(resolve => {
      const t0 = Date.now();
      const t = setInterval(() => {
        if (idle.length || Date.now() - t0 > 20000) { clearInterval(t); resolve(idle.length > 0); }
      }, 25);
    });
    if (waited) return idle.shift();
    try { logger.log('[pool  ] capacity wait timeout, overshoot launch'); } catch (e) {}
    const b2 = await launch();
    const w2 = wrap(b2);
    live.add(w2);
    return w2;
  };
  return {
    async acquire() {
      const w = await getOrCreate();
      w.busy++;
      const context = await w.browser.createBrowserContext();
      let released = false;
      return {
        browser: w.browser,
        context,
        // 同浏览器互斥段（幽灵瓦片防护）：截图类 CDP 调用经此串行
        exclusive: (fn) => { const run = w.lock.then(fn, fn); w.lock = run.then(() => {}, () => {}); return run; },
        release: async () => {
          if (released) return;
          released = true;
          w.busy--;
          // close 5s 竞速：悬挂不再阻塞回收（实测宿主高压下偶发永久挂起，
          // 会连锁占死容量——见 getOrCreate 等待上限）
          try {
            await Promise.race([
              context.close(),
              new Promise((_, rej) => setTimeout(() => rej(new Error('ctx close timeout')), 5000)),
            ]);
          } catch (e) { try { if (String(e && e.message) === 'ctx close timeout') logger.log('[pool  ] context close timeout, recycle anyway'); } catch (e2) {} }
          if (w.browser.connected && !idle.includes(w)) idle.push(w);
        },
      };
    },
    stats: () => ({ size, live: live.size, idle: idle.length }),
    // v0.30 自愈：逐出疑似僵死浏览器（关闭并移出池——宿主高压下实测出现过
    // 连接存活但 newPage 永久悬挂的 wedged 实例，复用会毒化后续会话）
    // 逐出全部 idle（获取链超时时的怀疑集——busy 实例无从判定不动）
    evictIdle: () => {
      for (const w of idle.splice(0)) {
        live.delete(w);
        try { w.browser.close().catch(() => {}); } catch (e) {}
      }
      try { logger.log('[pool  ] evicted all idle browsers (acquire timeout)'); } catch (e2) {}
    },
    evict: (browser) => {
      for (const w of [...live]) {
        if (w.browser === browser) {
          live.delete(w);
          const i = idle.indexOf(w);
          if (i >= 0) idle.splice(i, 1);
          try { browser.close().catch(() => {}); } catch (e) {}
          try { logger.log('[pool  ] evicted wedged browser'); } catch (e2) {}
          return;
        }
      }
    },
    async close() {
      await Promise.allSettled([...live].map(w => w.browser.close()));
      live.clear();
      idle.length = 0;
    },
  };
}

module.exports = { createBrowserPool };
