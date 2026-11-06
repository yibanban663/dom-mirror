'use strict';
// B) 6 轮会话生命周期(连接→交互→销毁)——RSS 曲线有界性(慢性泄漏检测)
const { WebSocket } = require('ws');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const demoPid = '35180';
const rss = () => { try { return Math.round(parseInt(execSync('ps -o rss= -p ' + demoPid).toString().trim(), 10) / 1024); } catch { return -1; } };

const connect = () => new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1:8088/ws');
  const seen = [];
  const to = setTimeout(() => reject(new Error('30s 未就绪')), 30000);
  ws.on('message', (d) => {
    try {
      const j = JSON.parse(d.toString());
      seen.push(j.type);
      if (j.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: j.t }));
    } catch {}
  });
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', dpr: 1, w: 800, h: 600 }));
    const iv = setInterval(() => {
      if (seen.includes('sync-ready')) { clearInterval(iv); clearTimeout(to); resolve({ ws, seen }); }
    }, 200);
  });
  ws.on('error', () => { clearTimeout(to); reject(new Error('ws error')); });
});

(async () => {
  const samples = [rss()];
  let ok = 0, fail = 0;
  for (let round = 1; round <= 6; round++) {
    try {
      const S = await connect();
      await new Promise((r) => setTimeout(r, 1200));
      for (let i = 0; i < 5; i++) { S.ws.send(JSON.stringify({ type: 'scroll', x: 0, y: i * 30 })); await new Promise((r) => setTimeout(r, 120)); }
      S.ws.close();
      ok++;
    } catch (e) { fail++; console.log('  轮 ' + round + ' 失败: ' + String(e.message).slice(0, 50)); }
    await new Promise((r) => setTimeout(r, 3500));
    samples.push(rss());
    console.log('  轮 ' + round + ' | RSS: ' + samples[samples.length - 1] + 'MB');
  }
  await new Promise((r) => setTimeout(r, 4000));
  samples.push(rss());
  const growth = samples[samples.length - 1] - samples[0];
  console.log('RSS 序列:', JSON.stringify(samples), 'MB | 总增长:', growth, 'MB');
  const tail = samples.slice(-4);
  const monotonic = tail.every((v, i) => i === 0 || v >= tail[i - 1]);
  const leak = growth > 80 || (monotonic && growth > 40);
  console.log('成功轮次:', ok + '/6 |', leak ? '✗ 泄漏嫌疑(单调上涨/增长过大)' : '✓ RSS 有界');
  process.exit(!leak ? 0 : 1);
})().catch((e) => { console.error('FAIL', String(e.message).slice(0, 80)); process.exit(2); });
