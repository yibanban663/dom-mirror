'use strict';
// v0.32 镜像复用：热页池。预热「单访客专用」的已加载会话页——预热 context 在
// 任何访客到来之前创建并完成源站导航，被某会话取走后即归该访客独占（结束随
// 会话正常销毁），绝不跨访客共享 cookie/存储（WAF 隔离语义不变）。
// 取走命中时省去 context 创建 + 冷加载，首帧从「快照+WS」起步。
// 容量纪律：预热只在有空闲浏览器时进行；在线会话冷路径启动时先 yield——
// 预热中止、库存释放，绝不与真实访客抢池容量。
function createWarmPageManager({ browserPool, warmup = 1, ttlMs = 90000, ensureIntervalMs = 4000, requestAllowed, logger = console, timers = globalThis, now = Date.now, onReady } = {}) {
  if (!browserPool || warmup <= 0) return null;
  const inventory = new Map(); // key -> [{ handle, page, url, loadedAt, reqHandler }]
  const warming = new Set(); // { aborted, handle }——在途预热（可被 yield 抢占）
  // 键归一化到 origin 形态：会话注册用完整 URL（带路径/斜杠）、宿主预热用
  // origin——不归一化则同源两键永不相通（:82 会话取不到宿主为 :180 备的热页）
  const normKey = (k) => { try { return new URL(k).origin; } catch (e) { return k; } };
  const keyUrls = new Map();
  const recentKeys = [];
  const inflight = new Set();
  let stopped = false;

  const log = (...a) => { try { logger.log(...a); } catch (e) {} };

  async function createEntry(key, url) {
    const w = { aborted: false, handle: null };
    warming.add(w);
    inflight.add(key);
    try {
      const handle = await new Promise((resolve, reject) => {
        const t = timers.setTimeout(() => reject(new Error('warm acquire timeout')), 15000);
        browserPool.acquire().then((h) => { timers.clearTimeout(t); resolve(h); }, (e) => { timers.clearTimeout(t); reject(e); });
      });
      w.handle = handle;
      if (w.aborted || stopped) { await handle.release().catch(() => {}); return null; }
      const page = await handle.context.newPage();
      if (w.aborted || stopped) { await page.close().catch(() => {}); await handle.release().catch(() => {}); return null; }
      // 预热期先挂源站白名单拦截（与正式会话同语义；取走时换为会话作用域处理器）
      await page.setRequestInterception(true);
      const origins = new Set([new URL(url).origin]);
      const reqHandler = (r) => {
        if (requestAllowed(r.url(), origins)) { r.continue().catch(() => {}); return; }
        r.abort(r.isNavigationRequest() ? 'aborted' : 'blockedbyclient').catch(() => {});
      };
      page.on('request', reqHandler);
      // 与正式会话相同的页面级前置补丁（closed shadow 注册表）
      await page.evaluateOnNewDocument(() => {
        if (window.__xyEarlyShadow) return;
        window.__xyEarlyShadow = true;
        try {
          window.__xyClosedRoots = new WeakMap();
          window.__xyClosedList = [];
          const orig = Element.prototype.attachShadow;
          Element.prototype.attachShadow = function (init) {
            const sr = orig.call(this, init);
            try {
              if (sr && init && init.mode === 'closed') {
                window.__xyClosedRoots.set(this, sr);
                if (window.__xyClosedList.length < 64) window.__xyClosedList.push({ host: this, root: sr });
              }
            } catch (e) {}
            return sr;
          };
        } catch (e) {}
      });
      // 入库存前必须网络静止：DCL 即入库会在途请求未清，接手方摘预热拦截器/
      // 重开 interception 时把暂停的请求卡死（实测 265ms 龄热页接手后快照饿死）。
      // 等静默发生在后台预热路径，不阻塞任何访客。
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 })
        .catch(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}));
      if (w.aborted || stopped) { try { page.off('request', reqHandler); } catch (e) {} await page.close().catch(() => {}); await handle.release().catch(() => {}); return null; }
      const entry = { handle, page, url: page.url(), loadedAt: now(), reqHandler, key };
      const list = inventory.get(key) || [];
      list.push(entry);
      inventory.set(key, list);
      log('[warm  ] ready', key, '->', entry.url);
      // v0.32.5 底色预热回调（宿主注入缓存回填——服务重启后第一访也有正确底色）
      if (typeof onReady === 'function') { try { onReady(entry); } catch (e) {} }
      return entry;
    } catch (e) {
      if (w.handle) await w.handle.release().catch(() => {});
      throw e;
    } finally {
      warming.delete(w);
      inflight.delete(key);
    }
  }

  function closeEntry(e) {
    const list = inventory.get(e.key);
    if (list) inventory.set(e.key, list.filter((x) => x !== e));
    try { e.page.off('request', e.reqHandler); } catch (err) {}
    return e.handle.release().catch(() => {});
  }

  // 在线会话优先：中止在途预热并释放全部库存——冷路径会话启动前调用，
  // 保证真实访客绝不等在预热后面
  function yieldForSession() {
    let freed = 0;
    for (const w of warming) { if (!w.aborted) { w.aborted = true; freed++; } }
    for (const list of inventory.values()) for (const e of [...list]) { closeEntry(e).catch(() => {}); freed++; }
    if (freed) log('[warm  ] yield for session (freed', freed, ')');
    return freed;
  }

  async function ensure(key, url) {
    if (stopped || !key || !url) return;
    key = normKey(key);
    // 过期清仓：TTL 之外的热页直接释放（下次 ensure 重建）
    const list = inventory.get(key) || [];
    const keep = [];
    for (const e of list) {
      if (now() - e.loadedAt > ttlMs) closeEntry(e).catch(() => {});
      else keep.push(e);
    }
    inventory.set(key, keep);
    if (keep.length >= warmup || inflight.has(key)) return;
    // 只在有空闲浏览器时预热：绝不与在线会话抢容量。注意池的 live 计所有存活
    // 实例（busy+idle），"有容量"的判据是 idle>0 而非 live<size（曾误判致永不复热）
    try {
      const st = browserPool.stats();
      // 有余量才预热：live<size（还能拉新实例，含启动期 live=0）或已有空闲实例；
      // 与在线会话抢容量的情形（live>=size 且 idle=0）绝不预热
      if (!(st.live < st.size || (st.idle ?? 0) > 0)) return;
    } catch (e) { return; }
    createEntry(key, url).catch((e) => log('[warm  ] ensure fail:', e && e.message));
  }

  function register(key, url) {
    key = normKey(key);
    keyUrls.set(key, url);
    if (!recentKeys.includes(key)) { recentKeys.push(key); if (recentKeys.length > 4) recentKeys.shift(); }
    return ensure(key, url);
  }

  function take(key) {
    key = normKey(key);
    const list = inventory.get(key) || [];
    if (!list.length) return null;
    const e = list.shift();
    inventory.set(key, list);
    return e;
  }

  const timer = timers.setInterval(() => {
    if (stopped) return;
    for (const key of [...new Set([...inventory.keys(), ...recentKeys])]) {
      ensure(key, keyUrls.get(key) || key);
    }
  }, ensureIntervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  async function stop() {
    stopped = true;
    for (const w of warming) w.aborted = true;
    try { timers.clearInterval(timer); } catch (e) {}
    const all = [];
    for (const list of inventory.values()) for (const e of [...list]) all.push(closeEntry(e));
    inventory.clear();
    await Promise.allSettled(all);
  }

  return {
    register,
    take,
    ensure,
    yieldForSession,
    stop,
    stats: () => ({ keys: [...inventory.keys()], entries: [...inventory.values()].reduce((n, l) => n + l.length, 0) }),
  };
}

module.exports = { createWarmPageManager };
