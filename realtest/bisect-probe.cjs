'use strict';
// bisect-probe.cjs — 判定给定载荷集的镜像是否在 18s 内就绪(0=绿就绪, 1=红卡死)
const { WebSocket } = require('ws');
(async () => {
  const ws = new WebSocket('ws://127.0.0.1:8088/ws');
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); ws.once('unexpected-response', (q, s) => j(new Error('http ' + s.statusCode))); });
  const msgs = [];
  ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())); } catch {} });
  let closed = false;
  ws.on('close', () => { closed = true; });
  const keepAlive = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); }, 4000);
  ws.send(JSON.stringify({ type: 'hello', dpr: 1, w: 800, h: 600 }));
  let ready = false;
  for (let i = 0; i < 18 && !ready && !closed; i++) {
    await new Promise(r => setTimeout(r, 1000));
    ready = msgs.some(m => m.type === 'sync-ready');
  }
  clearInterval(keepAlive);
  // 就绪判定增强: sync-ready 或 已收到 dom-snapshot
  const hasSnap = msgs.some(m => m.type === 'dom-snapshot');
  console.log((ready || hasSnap) ? 'GREEN(就绪)' : 'RED(卡死/未就绪)');
  ws.close(); setTimeout(() => process.exit(ready || hasSnap ? 0 : 1), 200);
})().catch(e => { console.log('PROBE-ERR ' + e.message.slice(0, 50)); process.exit(1); });
