'use strict';
// v0.20 带宽量化：抓一条真实 dom-snapshot payload，按 ws permessage-deflate 的
// 默认压缩参数（zlib level 3）测实际压缩比。运行于 client 容器（network 内）。
// 用法：node tools/measure-deflate.cjs（env: MIRROR_URL）
const zlib = require('node:zlib');
const WebSocket = require('ws');

(async () => {
  const mirror = process.env.MIRROR_URL || 'http://mirror:8088/';
  const ws = new WebSocket(mirror.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws', {
    headers: { 'permessage-deflate': 'client_max_window_bits' }, // 模拟浏览器协商（与实际客户端一致）
  });
  const payload = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting snapshot')), 30000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', dpr: 1, w: 1280, h: 800 })));
    ws.on('message', (raw) => {
      try {
        const s = raw.toString();
        if (s.startsWith('{"type":"dom-snapshot"')) { clearTimeout(timer); try { ws.close(); } catch {} resolve(s); }
      } catch {}
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  const buf = Buffer.from(payload, 'utf8');
  // ws 服务端 permessageDeflate 默认 zlib level 3；阈值 512B（我们配置）
  const out3 = zlib.deflateSync(buf, { level: 3 });
  const out6 = zlib.deflateSync(buf, { level: 6 });
  const cssStart = payload.indexOf('"css":"');
  const htmlStart = payload.indexOf('"html":"');
  const cssLen = htmlStart > cssStart ? htmlStart - cssStart - 9 : 0;
  console.log(JSON.stringify({
    rawBytes: buf.length,
    cssApproxBytes: cssLen,
    htmlApproxBytes: buf.length - htmlStart,
    deflateL3: out3.length,
    ratioL3: +(buf.length / out3.length).toFixed(2),
    deflateL6: out6.length,
    ratioL6: +(buf.length / out6.length).toFixed(2),
  }));
})().catch((e) => { console.error(e.message); process.exit(1); });
