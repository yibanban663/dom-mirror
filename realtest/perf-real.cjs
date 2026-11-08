'use strict';
// 真实站点性能探针: ruanyifeng 大 DOM 页(快照/导航回流时延)
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://127.0.0.1:8088/ws');
const seen = [];
const snapAt = [];
let helloAt = 0, navAt = 0;
ws.on('message', (d) => {
  try {
    const j = JSON.parse(d.toString());
    if (j.type === 'dom-snapshot') snapAt.push(Date.now());
    if (seen.indexOf(j.type) < 0) seen.push(j.type);
    if (j.type === 'nav-blocked') console.log('[nav-blocked msg]', j.msg);
  } catch {}
});
ws.on('open', () => {
  helloAt = Date.now();
  ws.send(JSON.stringify({ type: 'hello', dpr: 1, w: 900, h: 700, path: '/blog/' }));
  setTimeout(() => {
    navAt = Date.now();
    ws.send(JSON.stringify({ type: 'navigate', url: 'https://www.ruanyifeng.com/blog/' }));
    setTimeout(() => {
      const ready1 = snapAt[0] ? snapAt[0] - helloAt : -1;
      const after = snapAt.filter((t) => t > navAt);
      console.log('首快照(连接→首帧):', ready1, 'ms');
      console.log('导航→回流快照:', after[0] ? after[0] - navAt : '超时(15s 无新快照)', 'ms');
      console.log('总快照数:', snapAt.length, '| 消息类型:', JSON.stringify(seen));
      ws.close();
      process.exit(0);
    }, 15000);
  }, 12000);
});
setTimeout(() => { console.log('✗ 60s 未完成, 收到: ' + seen.slice(0, 10).join(',')); process.exit(2); }, 60000);
