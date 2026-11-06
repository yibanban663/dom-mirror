'use strict';
// 对抗批次11: /rum 日志注入复核(取证日志行本身) + 批次13: obf 端点矩阵
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const LOG = path.join(__dirname, 'adv11-demo.log');
if (fs.existsSync(LOG)) fs.unlinkSync(LOG);

const demo = spawn('node', ['../demo/server.js'], {
  cwd: __dirname,
  env: { ...process.env, ORIGIN_URL: 'http://127.0.0.1:18091/', PUPPETEER_EXECUTABLE_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')],
});
const origin = http.createServer((req, res) => { res.writeHead(404); res.end(); });
origin.listen(18091, '127.0.0.1');

const get = (port, p, method, headers, body) => new Promise(resolve => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET', headers: headers || {} }, res => {
    let b = []; res.on('data', c => b.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(b).toString().slice(0, 40) }));
  });
  req.on('error', e => resolve({ status: 0, err: e.message }));
  if (body) req.end(body); else req.end();
});

(async () => {
  await new Promise(r => setTimeout(r, 6000));
  const port = 8088;
  console.log('===== 批次11: /rum 日志注入复核 =====');
  // 同源 POST + CRLF 载荷
  const payload = '{"s":1}\r\n[net] FAKE-INJECTED-LOG-LINE (伪造审计行)';
  const r1 = await get(port, '/rum', 'POST', { origin: 'http://127.0.0.1:' + port, 'content-type': 'text/plain', 'content-length': Buffer.byteLength(payload) }, payload);
  console.log('同源 POST /rum(含 CRLF+FAKE 标记) → ' + r1.status);
  await new Promise(r => setTimeout(r, 800));
  const log = fs.readFileSync(LOG, 'utf8');
  const rumLine = log.split('\n').filter(l => l.includes('[rum-beacon]'));
  console.log('[rum-beacon] 日志行: ' + (rumLine.length ? JSON.stringify(rumLine[0].slice(0, 120)) : '不存在'));
  const fakeLine = log.split('\n').some(l => l.trim() === '[net] FAKE-INJECTED-LOG-LINE (伪造审计行)');
  console.log('独立伪造行(前缀被剥, 行首=FAKE): ' + (fakeLine ? '存在 → 日志注入成立!' : '不存在(注入载荷仅作为 [rum-beacon] 行的续行数据存在, 审计工具按行解析时无法伪装为独立日志条目)'));
  // 无来源 POST(双 header 缺失)
  const r2 = await get(port, '/rum', 'POST', { 'content-length': 2 }, '{}');
  console.log('无 Origin/Referer POST /rum → ' + r2.status + (r2.status === 403 ? ' ✓ 拒绝' : ' ← 检查'));

  console.log('\n===== 批次13: obf 字体端点矩阵(真实 404 面) =====');
  const vectors = [
    ['/m/obf/0123456789abcdef012345/reg.woff2', '未知 sid(24hex 合法形态)'],
    ['/m/obf/short/reg.woff2', 'sid 过短(<4)'],
    ['/m/obf/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/reg.woff2', 'sid 过长(>40)'],
    ['/m/obf/AAAA/bold.woff2', '大写 sid(正则拒)'],
    ['/m/obf/0123456789abcdef012345/site--1.woff2', 'site-N 负数'],
    ['/m/obf/0123456789abcdef012345/site-999999.woff2', 'site-N 越界'],
    ['/m/obf/0123456789abcdef012345/site-1%00.woff2', '空字节'],
    ['/m/obf/../secret.txt', '字面穿越'],
  ];
  for (const [p, label] of vectors) {
    const r = await get(port, p);
    console.log(`[${r.status === 404 ? 'SAFE' : '检查!'}] ${label} → ${r.status}`);
  }

  demo.kill(); origin.close();
  console.log('\n(日志文件保留: ' + LOG + ')');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
