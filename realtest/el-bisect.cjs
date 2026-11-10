'use strict';
// 事件循环阻塞分层定位: A) 纯 node 空转基线 B) node+createMirror 最小配置
// 用法: node el-bisect.cjs <layer>
const layer = process.argv[2] || 'A';
const { monitorEventLoopDelay } = require('node:perf_hooks');

const report = (label, h) => {
  h.disable();
  const p = (q) => +(h.percentile(q) / 1e6).toFixed(2);
  console.log(JSON.stringify({ layer: label, p50: p(50), p95: p(95), max: p(100), samples: h.count }));
};

if (layer === 'A') {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  setTimeout(() => {
    report('A-纯node空转', h);
    process.exit(0);
  }, 15000);
  setInterval(() => {}, 1000); // 保持事件循环
  return;
}

// B) node + createMirror 最小配置(无池/无预热/无浏览器)
const { createMirror } = require('../server');
const mirror = createMirror({
  originUrl: 'http://127.0.0.1:8098/',
  browserPoolSize: 0,
  logger: { log: () => {} },
});
const h = monitorEventLoopDelay({ resolution: 20 });
h.enable();
setTimeout(() => {
  report('B-createMirror', h);
  mirror.close().catch(() => {}).finally(() => process.exit(0));
}, 15000);
setInterval(() => {}, 1000);
