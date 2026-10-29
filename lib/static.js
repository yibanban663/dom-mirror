'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function createStaticFiles() {
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
  };
  // 按路径缓存 gzip；资源文件在实例运行期间应保持不变。
  const gzCache = new Map();
  function sendFile(req, res, file, ctype, cacheCtl) {
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const accept = req.headers['accept-encoding'] || '';
      const canGz = accept.includes('gzip') && buf.length > 1024 && !/image\/(png|jpeg|webp)|font\/woff2/.test(ctype);
      let entry = gzCache.get(file);
      if (!entry) { entry = {}; gzCache.set(file, entry); }
      let out = buf, enc;
      if (canGz) {
        if (!entry.gz || entry.rawLen !== buf.length) { entry.rawLen = buf.length; entry.gz = zlib.gzipSync(buf, { level: 6 }); }
        out = entry.gz; enc = 'gzip';
      }
      const h = { 'Content-Type': ctype, 'Cache-Control': cacheCtl, 'Content-Length': out.length,
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }; // v0.36 WAF 加固
      if (enc) h['Content-Encoding'] = enc;
      res.writeHead(200, h);
      res.end(out);
    });
  }
  function staticHandler(root) {
    return (req, res) => {
      let p;
      try { p = decodeURIComponent((req.url || '/').split('?')[0]); }
      catch { res.writeHead(400); res.end('bad url'); return; }
      if (p === '/') p = '/index.html';
      const file = path.join(root, path.normalize(p).replace(/^([/\\])+/, ''));
      if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
      sendFile(req, res, file, MIME[path.extname(file)] || 'application/octet-stream',
        p === '/index.html' ? 'no-store' : 'public, max-age=3600');
    };
  }

  return { sendFile, staticHandler, clear: () => gzCache.clear() };
}
module.exports = { createStaticFiles };
