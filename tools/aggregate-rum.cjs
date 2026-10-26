'use strict';
// v0.27 RUM 周度复评工具：读网关日志中的 [rum]/[rum-beacon] 行（stdin 或文件），
// 聚合帧时间/交互到视觉延迟 p50/p95 与字节构成。用法（生产网关）：
//   docker logs rbi-gateway 2>&1 | grep '\[rum' | node tools/aggregate-rum.cjs
// 或：node tools/aggregate-rum.cjs rum.log
const fs = require('node:fs');

const input = process.argv[2]
  ? fs.readFileSync(process.argv[2], 'utf8')
  : fs.readFileSync(0, 'utf8');

const rows = [];
for (const line of input.split('\n')) {
  const i = line.indexOf('{');
  if (i < 0) continue;
  try { rows.push(JSON.parse(line.slice(i))); } catch {}
}
function agg(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return { n: s.length, min: +s[0].toFixed(1), p50: +s[Math.floor(s.length / 2)].toFixed(1), p95: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(1), max: +s[s.length - 1].toFixed(1) };
}
const lat50 = rows.map(r => r.inLatP50).filter(v => v != null);
const lat95 = rows.map(r => r.inLatP95).filter(v => v != null);
const fp50 = rows.map(r => r.frameP50).filter(v => v != null);
const fp95 = rows.map(r => r.frameP95).filter(v => v != null);
const bytes = {};
let sessions = 0;
for (const r of rows) {
  const bb = r.bytesBy || {};
  if (Object.keys(bb).length) sessions++;
  for (const [k, v] of Object.entries(bb)) bytes[k] = (bytes[k] || 0) + v;
}
const viewports = {};
for (const r of rows) {
  const k = `${r.vw}x${r.vh}@${r.dpr}`;
  viewports[k] = (viewports[k] || 0) + 1;
}
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  reportLines: rows.length,
  sessionsApprox: sessions,
  inLatP50: agg(lat50), inLatP95: agg(lat95),
  frameP50: agg(fp50), frameP95: agg(fp95),
  snapsTotal: rows.reduce((a, r) => a + (r.snaps || 0), 0),
  patchesTotal: rows.reduce((a, r) => a + (r.patches || 0), 0),
  bytesAggregate: bytes,
  viewports,
}, null, 1));
