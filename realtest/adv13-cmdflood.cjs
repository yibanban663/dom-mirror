'use strict';
// 红: 会话内命令零限流——200 条 mode(合法值) 洪发 → 积压延迟 + RSS 放大
const { WebSocket } = require('ws');
const { execSync } = require('node:child_process');
const demoPid = '29590';
const rss = () => { try { return Math.round(parseInt(execSync('ps -o rss= -p ' + demoPid).toString().trim(), 10) / 1024); } catch { return -1; } };
(async () => {
  const ws = new WebSocket('ws://127.0.0.1:8088/ws');
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); ws.once('unexpected-response', (q, s) => j(new Error('http ' + s.statusCode))); });
  const seen = [];
  let rateErrors = 0;
  ws.on('message', (d) => {
    try {
      const j = JSON.parse(d.toString());
      seen.push(j.type);
      if (j.code === 'RATE') rateErrors++;
      if (j.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: j.t })); // 真实 client 行为: 回应服务端活性探测
    } catch {}
  });
  ws.send(JSON.stringify({ type: 'hello', dpr: 1, w: 800, h: 600 }));
  let ready = false;
  const tReady0 = Date.now();
  for (let i = 0; i < 80 && !ready; i++) { await new Promise(r => setTimeout(r, 500)); ready = seen.includes('sync-ready'); }
  if (!ready) { console.log('✗ 30s 未 sync-ready; 收到: ' + seen.join(',')); ws.close(); process.exit(2); }
  console.log('✓ 会话就绪(' + Math.round((Date.now() - tReady0) / 100) / 10 + 's)');
  const rssStart = rss();
  console.log('起始 RSS:', rssStart, 'MB');
  // 基线: ping 延迟
  const tPing0 = Date.now(); let pongT = null;
  const pongAt = {};
  ws.on('message', (d) => { try { const j = JSON.parse(d.toString()); if (j.type === 'pong') pongAt[j.t] = Date.now(); } catch {} });
  ws.send(JSON.stringify({ type: 'ping', t: 'probe-base' }));
  await new Promise(r => setTimeout(r, 1500));
  const baseLat = pongAt['probe-base'] ? pongAt['probe-base'] - tPing0 : -1;
  console.log('基线 ping 延迟:', baseLat, 'ms');
  // 洪发 200 条 mode
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) { ws.send(JSON.stringify({ type: 'mode', mode: 'dom' })); await new Promise(r => setTimeout(r, 30)); }
  const sentDone = Date.now() - t0;
  console.log('200 条 mode 发送完成:', sentDone, 'ms | RSS:', rss(), 'MB');
  // 积压探测: 发 probe ping, 等 pong
  const t1 = Date.now();
  ws.send(JSON.stringify({ type: 'ping', t: 'probe-after' }));
  await new Promise(r => setTimeout(r, 25000));
  const afterLat = pongAt['probe-after'] ? pongAt['probe-after'] - t1 : -1;
  const rssEnd = rss();
  console.log('洪发后 ping 延迟:', afterLat, 'ms | RATE 错误数:', rateErrors);
  console.log('终 RSS:', rssEnd, 'MB | 增长:', rssEnd - rssStart, 'MB');
  const red = (afterLat === -1 || afterLat > 5000) || (rssEnd - rssStart) > 150;
  console.log(red ? '=== 红: 命令洪发放大/积压实证 ===' : '=== 绿: 无放大 ===');
  ws.close(); setTimeout(() => process.exit(red ? 1 : 0), 500);
})().catch(e => { console.error('FAIL', String(e.message).slice(0, 60)); process.exit(2); });
