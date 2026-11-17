'use strict';
// 端到端: 接入向导(blockedOrigins)——白名单拦外域资源 → 会话清理 → [policy] TopN 日志
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');

(async () => {
  // 外域"图床"(将被白名单拦截)
  const evil = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('89504e47', 'hex')); });
  evil.listen(0, '127.0.0.1'); await once(evil, 'listening');
  const evilOrigin = 'http://127.0.0.1:' + evil.address().port;
  // 源站: 引用同源 + 外域图床
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<img src="/ok.png"><img src="' + evilOrigin + '/leak.png"><img src="' + evilOrigin + '/leak2.png">');
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const { createMirror } = require('/Users/yxy/Desktop/agent相关/dom-mirror/');
  const logs = [];
  const mirror = createMirror({
    originUrl: 'http://127.0.0.1:' + origin.address().port + '/',
    requestOrigins: ['http://127.0.0.1:' + origin.address().port], // 只放行源站 → 外域被拦
    browserPoolSize: 0,
    logger: { log: (...a) => logs.push(a.map(String).join(' ')) },
    launchOptions: { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  });
  const server = http.createServer(mirror.handleRequest);
  server.on('upgrade', mirror.handleUpgrade);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');

  const ws = new WebSocket('ws://127.0.0.1:' + server.address().port + '/ws');
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); ws.once('unexpected-response', (q, s) => j(new Error('http ' + s.statusCode))); });
  const msgs = [];
  ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())); } catch {} });
  const ka = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); }, 4000);
  ws.send(JSON.stringify({ type: 'hello', dpr: 1, w: 800, h: 600 }));
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { await new Promise(r => setTimeout(r, 500)); ready = msgs.some(m => m.type === 'sync-ready'); }
  await new Promise(r => setTimeout(r, 1500)); // 给页面加载外域资源(被拦)留时间
  console.log(ready ? '✓ 会话就绪' : '✗ 未就绪');

  // 断开 → 触发 cleanup → 接入向导应输出 [policy] TopN
  const policyLogsBefore = logs.filter(l => l.includes('被拦截资源域')).length;
  ws.close();
  await new Promise(r => setTimeout(r, 15000));
  console.log('--- 15s 后全部日志 ---');
  for (const l of logs) console.log('  ' + l.slice(0, 110));
  if (!logs.some(l => l.includes('被拦截资源域'))) {
    console.log('--- reaper 未触发, mirror.close() 兜底 ---');
    await mirror.close().catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
  }
  const guide = logs.filter(l => l.includes('被拦截资源域'));
  console.log('--- 生命周期日志([policy]/[sess] 相关) ---');
  for (const l of logs) if (l.includes('[policy]') || l.includes('[sess')) console.log('  ' + l.slice(0, 100));
  console.log('--- 判定 ---');
  if (guide.length > policyLogsBefore) {
    console.log('✓ 接入向导端到端成立: 会话清理时输出 TopN');
    console.log('  日志: ' + guide[guide.length - 1].slice(0, 110));
  } else {
    const blockedLogs = logs.filter(l => l.includes('[policy] blocked'));
    console.log(blockedLogs.length ? ('拦截发生过: ' + blockedLogs[0].slice(0, 90) + ' …共 ' + blockedLogs.length + ' 条') : '⚠ 连拦截日志都没有——资源可能没被拦');
    console.log(guide.length ? '向导在建立时就输出过(非清理时)' : '✗ 清理时未输出向导日志——端到端不成立');
  }
  clearInterval(ka);
  await mirror.close().catch(() => {});
  server.closeAllConnections(); await new Promise(r => server.close(r));
  origin.close(); evil.close();
  process.exit(guide.length > policyLogsBefore ? 0 : 1);
})().catch(e => { console.error('FAIL', String(e.message).slice(0, 80)); process.exit(1); });
