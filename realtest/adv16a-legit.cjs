'use strict';
// A) 合法访客负载 30s: mouse 20/s + scroll 2/s + domclick 1/s + navigate 1/15s → 零 RATE 误伤
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://127.0.0.1:8088/ws');
const seen = [];
let rate = 0;
const pongAt = {};
ws.on('message', (d) => {
  try {
    const j = JSON.parse(d.toString());
    seen.push(j.type);
    if (j.code === 'RATE') rate++;
    if (j.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: j.t }));
    if (j.type === 'pong') pongAt[j.t] = Date.now();
  } catch {}
});
setTimeout(() => { console.log('✗ 45s 未完成, 收到: ' + seen.slice(0, 12).join(',')); process.exit(2); }, 45000);
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', dpr: 1, w: 800, h: 600 }));
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (seen.includes('sync-ready')) { clearInterval(iv); start(); }
    else if (Date.now() - t0 > 30000) { clearInterval(iv); console.log('✗ 30s 未就绪, 收到: ' + seen.slice(0, 10).join(',')); process.exit(2); }
  }, 200);
});
function start() {
  console.log('✓ 会话就绪, 开始 30s 合法负载');
  let moves = 0, scrolls = 0, clicks = 0, navigations = 0;
  const mouseIv = setInterval(() => { ws.send(JSON.stringify({ type: 'mouse', action: 'move', x: 100 + (moves % 50), y: 100 + (moves % 40) })); moves++; }, 50);
  const scrollIv = setInterval(() => { ws.send(JSON.stringify({ type: 'scroll', x: 0, y: (scrolls++ % 5) * 10 })); }, 500);
  const clickIv = setInterval(() => { ws.send(JSON.stringify({ type: 'domclick', id: 2 })); clicks++; }, 1000);
  const navIv = setInterval(() => { ws.send(JSON.stringify({ type: 'navigate', url: 'http://127.0.0.1:8099/' })); navigations++; }, 15000);
  setTimeout(() => {
    clearInterval(mouseIv); clearInterval(scrollIv); clearInterval(clickIv); clearInterval(navIv);
    console.log('mouse:', moves, '| scroll:', scrolls, '| domclick:', clicks, '| navigate:', navigations);
    console.log('RATE 误伤:', rate, rate === 0 ? '✓ 零误伤' : '✗ 存在误伤!');
    ws.close();
    setTimeout(() => process.exit(rate === 0 ? 0 : 1), 500);
  }, 30000);
}
