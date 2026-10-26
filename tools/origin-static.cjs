'use strict';
// 最小静态源站（多源回归用）：按扩展名给 content-type，/ 映射 index.html。
// 用法：node tools/origin-static.cjs <rootDir> [port]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || process.env.PORT || 8000);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
  // v0.26 动态内容路由：每 5s 一个版本号（跨源 iframe 周期刷新通道的基准用）
  if (pathname === '/tick.html') {
    const ver = Math.floor(Date.now() / 5000);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><style>body{font:13px system-ui,sans-serif;margin:8px;background:#eef7ee}.badge{display:inline-block;padding:3px 8px;background:#2c7;color:#fff;border-radius:4px}</style></head><body><span class="badge">EMBED-OK</span><img src="pic-b.png" width="24" alt=""><div id="tick">TICK:' + ver + '</div><div id="xstat">STAT:loading</div><script>document.getElementById("xstat").textContent="STAT:ran-script";</scr' + 'ipt></body></html>');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(root, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}).listen(port, '0.0.0.0', () => console.log(`[origin-static] ${root} on :${port}`));
