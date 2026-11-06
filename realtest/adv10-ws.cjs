'use strict';
// 对抗批次10: WS 输入值对抗完整版(真实会话, dialog 修复后)
const { WebSocket } = require('ws');
const port = 8088;
(async () => {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); ws.once('unexpected-response', (q, s) => j(new Error('http ' + s.statusCode))); });
  const msgs = [];
  ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())); } catch {} });
  let closed = false;
  ws.on('close', c => { closed = true; });
  ws.send(JSON.stringify({ type: 'hello', dpr: 1, w: 800, h: 600 }));
  let ready = false;
  for (let i = 0; i < 60 && !ready && !closed; i++) { await new Promise(r => setTimeout(r, 500)); ready = msgs.some(m => m.type === 'sync-ready'); }
  if (!ready) { console.log('✗ 装配未就绪'); process.exit(1); }
  console.log('会话就绪(dialog 修复后), 开始输入值对抗\n');
  const send = o => ws.send(JSON.stringify(o));
  const cases = [
    ['X-D2 key Enter+1KB text', { type: 'key', action: 'down', key: 'Enter', text: 'E'.repeat(1024) }],
    ['X-E1 dnd 30KB 载荷', { type: 'dnd', kind: 'drop', x: 100, y: 100, text: 'D'.repeat(30 * 1024) }],
    ['X-F1 repaint 负/零', { type: 'repaint', x: -1e9, y: -1e9, w: -5, h: 0 }],
    ['X-F2 repaint 巨区 1e7', { type: 'repaint', x: 0, y: 0, w: 1e7, h: 1e7 }],
    ['X-G2 composition s>e 边界', { type: 'composition', text: '测试文本', s: 100, e: -100 }],
    ['X-R1 repair ids 注入', { type: 'repair', ids: [1e999, -1e999, 0.1, 'x', null, { a: 1 }, 1, 2] }],
    ['X-M1 mode 非法值', { type: 'mode', mode: 'javascript:alert(1)' }],
    ['X-M2 mode frame 正常', { type: 'mode', mode: 'frame' }],
    ['X-H1 hello dpr=1e999', { type: 'hello', dpr: 1e999, w: NaN, h: -5 }],
    ['X-H2 hello 负尺寸', { type: 'hello', dpr: -2, w: -500, h: -500 }],
    ['X-H3 hello 正常回设', { type: 'hello', dpr: 1, w: 800, h: 600 }],
  ];
  for (const [name, msg] of cases) {
    if (closed) { console.log('[' + name + '] 会话已断, 跳过'); continue; }
    const idx = msgs.length;
    send(msg);
    await new Promise(r => setTimeout(r, 1200));
    const resp = msgs.slice(idx);
    const err = resp.find(m => m.type === 'error');
    console.log(`[${closed ? '已断!' : '存活'}] ${name} | ${resp.length ? resp.map(m => m.type + (m.msg ? ':' + String(m.msg).slice(0, 24) : '')).join(',') : '(静默)'}`);
  }
  console.log('\n批次10 完成');
  ws.close(); setTimeout(() => process.exit(0), 300);
})().catch(e => { console.error('FAIL', String(e.message).slice(0, 60)); process.exit(1); });
