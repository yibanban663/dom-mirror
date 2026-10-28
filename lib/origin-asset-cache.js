'use strict';
// v0.32 镜像复用：源站静态资产跨会话共享缓存。
// 会话浏览器对源站 CSS/JS/图片/字体的回源请求，命中即本地回填（r.respond），
// 未命中回源并按保守规则入库（200、无 set-cookie、非 no-store/private、
// Vary 不含 Cookie/Authorization、体积上限内）。TTL 优先取源站 max-age（限幅），
// 无 cache-control 用默认 TTL。字节上限 LRU 逐出。
const STATIC_EXT = new Set(['css', 'js', 'mjs', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'map']);
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

function createOriginAssetCache({ maxBytes = 32 * 1024 * 1024, defaultTtlMs = 120000, now = Date.now } = {}) {
  const store = new Map(); // url -> { status, headers, body, bytes, expiresAt, at }
  let totalBytes = 0;

  const isCacheableUrl = (url) => {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const ext = (u.pathname.match(/\.([a-z0-9]{1,12})$/i) || [])[1];
    return !!ext && STATIC_EXT.has(ext.toLowerCase());
  };

  const shouldStore = (status, headers) => {
    if (status !== 200) return false;
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    if (h['set-cookie']) return false;
    const cc = h['cache-control'] || '';
    if (/no-store|private/i.test(cc)) return false;
    const vary = h['vary'] || '';
    if (/cookie|authorization/i.test(vary)) return false;
    return true;
  };

  const ttlFor = (headers) => {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    const m = (h['cache-control'] || '').match(/max-age\s*=\s*(\d+)/i);
    if (m) return Math.max(30000, Math.min(600000, Number(m[1]) * 1000));
    return defaultTtlMs;
  };

  const evict = () => {
    while (totalBytes > maxBytes && store.size > 1) {
      const oldest = store.keys().next().value;
      const e = store.get(oldest);
      store.delete(oldest);
      totalBytes -= e.bytes;
    }
  };

  return {
    isCacheableUrl,
    shouldStore,
    maxEntryBytes: MAX_ENTRY_BYTES,
    get(url) {
      const e = store.get(url);
      if (!e) return null;
      if (now() >= e.expiresAt) { store.delete(url); totalBytes -= e.bytes; return null; }
      // LRU touch
      store.delete(url); store.set(url, e);
      return e;
    },
    put(url, { status, headers, body }) {
      if (!isCacheableUrl(url) || !shouldStore(status, headers)) return false;
      if (!body || !body.length || body.length > MAX_ENTRY_BYTES) return false;
      const prev = store.get(url);
      if (prev) { store.delete(url); totalBytes -= prev.bytes; }
      const clean = {};
      for (const [k, v] of Object.entries(headers || {})) {
        const lk = k.toLowerCase();
        // body 已解码：剥编码/传输层与协商头，长度按实际重算
        if (['content-encoding', 'transfer-encoding', 'content-length', 'set-cookie', 'connection', 'vary'].includes(lk)) continue;
        clean[k] = v;
      }
      clean['content-length'] = String(body.length);
      const entry = { status, headers: clean, body, bytes: body.length + 512, expiresAt: now() + ttlFor(headers), at: now() };
      store.set(url, entry);
      totalBytes += entry.bytes;
      evict();
      return true;
    },
    stats: () => ({ entries: store.size, bytes: totalBytes, maxBytes }),
  };
}

module.exports = { createOriginAssetCache };
