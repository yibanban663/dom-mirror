'use strict';

const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|css|woff2?|ttf|otf|eot|mp4|webm)$/i;

function assetUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (url.origin !== base.origin || url.username || url.password || !ASSET_RE.test(url.pathname)) return null;
    return url;
  } catch { return null; }
}

function selectOrigin(header, fallback, allowed) {
  if (!header) return fallback;
  const url = new URL(String(header));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !allowed.includes(url.origin)) {
    throw new Error('origin not allowed');
  }
  return url.origin + '/';
}

// v0.38 请求白名单策略对象：真实站点资源普遍走独立 CDN 域（bdstatic/hdslb/
// githubusercontent…），逐子域枚举不可行。条目支持协议钉死的后缀通配：
//   https://www.baidu.com     精确 origin
//   https://*.bdstatic.com    任意子域 + 裸域，同协议、无端口（label 边界安全：
//                             xbdstatic.com 不匹配 .bdstatic.com）
// WAF 红线：通配基座必须是注册域——公共后缀（com/cn/co.uk…）或单 label 一律
// 拒绝（*.com 等于放行全网）；拒绝降级为精确条目处理（永不放宽）。
// 传入 Set 时按旧语义仅精确匹配（内部单点调用兼容）
const PUBLIC_SUFFIX = new Set([
  'com', 'net', 'org', 'gov', 'edu', 'mil', 'int', 'io', 'co', 'info', 'biz', 'me', 'tv', 'cc', 'xyz', 'top', 'cn', 'jp', 'uk', 'ru', 'de', 'fr', 'kr', 'us', 'in', 'au', 'ca', 'br', 'it', 'nl', 'se', 'ch', 'tw', 'hk', 'sg', 'vn', 'th', 'id', 'ph', 'my', 'tr', 'ar', 'mx', 'es', 'pt', 'pl', 'ua', 'ir', 'sa', 'ae', 'eg', 'za', 'ng', 'ke',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'co.jp', 'ne.jp', 'or.jp', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'com.hk', 'com.tw', 'com.sg', 'com.my', 'co.in', 'co.kr', 'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.ru', 'org.ru', 'net.ru', 'gov.ru',
]);
function wildcardBaseOk(d) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d)) return false; // ≥2 labels、合法字符
  const labels = d.split('.');
  const twoLabelTld = labels.slice(-2).join('.');
  if (PUBLIC_SUFFIX.has(d)) return false;            // *.com / *.co.uk
  if (PUBLIC_SUFFIX.has(twoLabelTld) && labels.length <= 2) return false; // *.uk 类
  return true;
}
function createRequestPolicy(entries) {
  const exact = new Set();
  const suffix = new Map(); // protocol -> Set<registrable domain>
  const rejected = [];
  for (const entry of entries || []) {
    const v = String(entry).trim().replace(/\/+$/, '');
    const m = /^https?:\/\/\*\.(.+)$/i.exec(v);
    if (m) {
      const base = m[1].toLowerCase();
      if (!wildcardBaseOk(base)) { rejected.push(v); continue; }
      const proto = v.slice(0, v.indexOf('*')).toLowerCase().replace('//', ''); // 'https:' / 'http:'
      if (!suffix.has(proto)) suffix.set(proto, new Set());
      suffix.get(proto).add(base);
    } else if (v) {
      // 带 * 却不成形的条目（如 https://*evil）一律拒绝：精确入库虽在实践中
      // 难以命中（* 主机不可解析），WAF 语义上错误配置就该显式失败而非惰性
      if (v.includes('*')) { rejected.push(v); continue; }
      exact.add(v);
    }
  }
  return { exact, suffix, rejected };
}

// 服务端浏览器请求白名单：HTTP(S) 只放行列入 origins 的源（无 URL 凭据），
// data/blob/about 为页内资源；其余 scheme 一律拒绝
function requestAllowed(value, origins) {
  try {
    const url = new URL(value);
    if (['data:', 'blob:', 'about:'].includes(url.protocol)) return true;
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (origins instanceof Set) return origins.has(url.origin);
    const exact = origins && origins.exact;
    if (exact && exact.has(url.origin)) return true;
    const suffix = origins && origins.suffix;
    if (suffix && suffix.size) {
      const set = suffix.get(url.protocol);
      if (set && !url.port) {
        const host = url.hostname.toLowerCase();
        for (const d of set) {
          if (host === d || host.endsWith('.' + d)) return true;
        }
      }
    }
    return false;
  } catch { return false; }
}

module.exports = { assetUrl, selectOrigin, createRequestPolicy, requestAllowed };
