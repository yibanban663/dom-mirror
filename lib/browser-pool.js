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
    // 容量已满：轮询等释放（会话结束必释放；25ms 粒度足够）
    await new Promise(resolve => {
      const t = setInterval(() => { if (idle.length) { clearInterval(t); resolve(); } }, 25);
    });
    return idle.shift();
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
          try { await context.close(); } catch (e) { try { logger.log('[pool  ] context close fail:', e.message); } catch (e2) {} }
          if (w.browser.connected && !idle.includes(w)) idle.push(w);
        },
      };
    },
    stats: () => ({ size, live: live.size, idle: idle.length }),
    async close() {
      await Promise.allSettled([...live].map(w => w.browser.close()));
      live.clear();
      idle.length = 0;
    },
  };
}

module.exports = { createBrowserPool };
