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

// 服务端浏览器请求白名单：HTTP(S) 只放行列入 origins 的源（无 URL 凭据），
// data/blob/about 为页内资源；其余 scheme 一律拒绝
function requestAllowed(value, origins) {
  try {
    const url = new URL(value);
    if (['data:', 'blob:', 'about:'].includes(url.protocol)) return true;
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && origins.has(url.origin);
  } catch { return false; }
}

module.exports = { assetUrl, selectOrigin, requestAllowed };
