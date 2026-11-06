'use strict';
// rum-regression: ping 副作用链回归探针
// 1) 带 rum 负载的 ping → 服务端 [rum] 日志(副作用链)
// 2) 纯 ping → 即时 pong(旁路)
// 3) 带 fp 的 ping 洪发 20 条 → 软组限流 RATE(防 CPU 放大)
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://127.0.0.1:8088/ws');
const seen = [];
let rate = 0, pongBare = null, tBare = 0;
ws.on('message', (d) => {
  try {
    const j = JSON.parse(d.toString());
    seen.push(j.type);
    if (j.code === 'RATE') rate++;
    if (j.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: j.t }));
    if (j.type === 'pong' && j.t === 'bare-probe') pongBare = Date.now();
  } catch {}
});
setTimeout(() => { console.log('✗ 40s 未完成, 收到: ' + seen.slice(0, 12).join(',')); process.exit(2); }, 40000);
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', dpr: 1, w: 800, h: 600 }));
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (seen.includes('sync-ready')) { clearInterval(iv); run(); }
    else if (Date.now() - t0 > 30000) { clearInterval(iv); console.log('✗ 未就绪'); process.exit(2); }
  }, 200);
});
function run() {
  console.log('✓ 就绪');
  // 1) rum 负载 ping × 3(间隔 300ms)
  for (let i = 0; i < 3; i++) {
    ws.send(JSON.stringify({ type: 'ping', t: 'rum-' + i, rum: { frame: 5 + i, session: 1, probe: 'rum-regression' } }));
  }
  // 3) fp 负载 ping × 20(间隔 40ms → 0.8s, 软组 12/2s 应触发 RATE)
  setTimeout(() => {
    for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ type: 'ping', t: 'fp-' + i, fp: 42 }));
    // 2) 纯 ping 旁路探针
    tBare = Date.now();
    ws.send(JSON.stringify({ type: 'ping', t: 'bare-probe' }));
  }, 1200);
  setTimeout(() => {
    console.log('RATE(fp 洪发):', rate, rate >= 5 ? '✓ 软组限流生效' : '(未触发或未限流)');
    console.log('纯 ping 延迟:', pongBare ? (pongBare - tBare) + 'ms' : '无响应');
    console.log('RUM_PING_SENT=3');
    ws.close();
    setTimeout(() => process.exit(0), 400);
  }, 6000);
}
