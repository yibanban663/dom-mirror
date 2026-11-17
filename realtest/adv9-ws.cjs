'use strict';
// 对抗批次9: WS 输入值对抗(真实会话)
const { WebSocket } = require('ws');
const port = 8088;
(async () => {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); ws.once('unexpected-response', (q, s) => j(new Error('http ' + s.statusCode))); });
  const msgs = [];
  ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())); } catch {} });
  let closed = false;
  ws.on('close', c => { closed = true; msgs.push({ type: 'CLOSED', code: c }); });
  ws.send(JSON.stringify({ type: 'hello', dpr: 1, w: 800, h: 600 }));
  // 保活: 服务端 15s 无消息/pong 会回收空闲会话(反空闲设计)——真实客户端每 10s ping
  const keepAlive = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); }, 5000);
  let ready = false;
  for (let i = 0; i < 60 && !ready && !closed; i++) { await new Promise(r => setTimeout(r, 500)); ready = msgs.some(m => m.type === 'sync-ready'); }
  if (!ready) { console.log('✗ 装配未就绪 (closed=' + closed + ')'); process.exit(1); }
  console.log('会话就绪(sync-ready), 开始 WS 值对抗\n');
  const send = o => ws.send(JSON.stringify(o));
  const cases = [
    ['W-A1 mouse NaN', { type: 'mouse', action: 'down', x: NaN, y: NaN }],
    ['W-A2 mouse 超大', { type: 'mouse', action: 'down', x: 1e9, y: -1e9 }],
    ['W-A3 mouse up MAX', { type: 'mouse', action: 'up', x: Number.MAX_VALUE, y: -Number.MAX_VALUE }],
    ['W-C1 scroll 结构注入', { type: 'scroll', x: NaN, y: Infinity, inner: [{ id: { malicious: 1 }, top: 'str' }] }],
    ['W-D1 key 1MB text', { type: 'key', action: 'down', text: 'K'.repeat(1024 * 1024) }],
    ['W-E1 dnd 512KB 载荷', { type: 'dnd', kind: 'drop', x: NaN, y: NaN, text: 'D'.repeat(512 * 1024) }],
    ['W-F1 repaint 负/零尺寸', { type: 'repaint', x: -1e9, y: -1e9, w: -5, h: 0 }],
    ['W-G1 composition 1MB', { type: 'composition', text: 'C'.repeat(1024 * 1024), s: -5, e: 1e9 }],
    ['W-H1 mode 非法值', { type: 'mode', mode: 'javascript:alert(1)' }],
    ['W-I1 hello 边界值', { type: 'hello', dpr: 1e999, w: NaN, h: -5 }],
    ['W-I2 hello 负尺寸', { type: 'hello', dpr: -2, w: -500, h: -500 }],
    ['W-J1 repair ids 注入', { type: 'repair', ids: [1e999, -1e999, 0.1, 'x', null, {a:1}] }],
    ['W-K1 repaint 流式放大', { type: 'repaint', x: 0, y: 0, w: 1e7, h: 1e7 }],
  ];
  for (const [name, msg] of cases) {
    if (closed) { console.log('[' + name + '] 会话已断, 跳过'); continue; }
    const idx = msgs.length;
    send(msg);
    await new Promise(r => setTimeout(r, 1200));
    const resp = msgs.slice(idx);
    const err = resp.find(m => m.type === 'error');
    console.log(`[${closed ? '已断' : '存活'}] ${name} | ${resp.length ? resp.map(m => m.type + (m.msg ? ':' + String(m.msg).slice(0, 26) : '')).join(',') : '(静默接受)'}`);
  }
  console.log('\n批次9 完成');
  clearInterval(keepAlive); ws.close(); setTimeout(() => process.exit(0), 300);
})().catch(e => { console.error('FAIL', String(e.message).slice(0, 60)); process.exit(1); });
