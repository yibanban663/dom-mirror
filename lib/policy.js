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

module.exports = { assetUrl, selectOrigin };
