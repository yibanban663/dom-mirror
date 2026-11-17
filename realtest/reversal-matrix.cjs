'use strict';
// 反转验证矩阵: 对每个已修复 bug, 临时恢复修复前源码 → 对应测试必须红
// → 恢复修复 → 测试必须绿。证明测试真实捕捉 bug(排除恒绿假测试)。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const run = (cmd, timeoutMs) => {
  try {
    const out = execFileSync('node', [cmd], { encoding: 'utf8', timeout: timeoutMs || 120000, cwd: __dirname + '/..' });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '').slice(0, 200) };
  }
};

const TARGETS = [
  { bug: 'BUG-1 全局限流连坐', test: 'test/rate-limit.test.js', file: 'server.js', before: '0f1b749^:server.js' },
  { bug: 'BUG-2 代理响应体上限', test: 'test/proxy-asset-limit.test.js', file: 'server.js', before: '5fc1c0a^:server.js' },
  { bug: 'BUG-3 /rum 日志注入', test: 'test/rum-log.test.js', file: 'server.js', before: 'bc48808^:server.js' },
  { bug: 'BUG-4 uploads 纵深', test: 'test/uploads-defense.test.js', file: 'lib/uploads.js', before: '65d1b47^:lib/uploads.js' },
];

console.log('===== 反转验证矩阵(修复前源码 → 测试必须红; 修复后 → 必须绿)=====\n');
let allOk = true;
for (const T of TARGETS) {
  const backup = fs.readFileSync(__dirname + '/../' + T.file);
  const beforeSrc = execFileSync('git', ['show', T.before], { cwd: __dirname + '/..', maxBuffer: 32 * 1024 * 1024 });
  fs.writeFileSync(__dirname + '/../' + T.file, beforeSrc);

  const red = run(T.test, 120000);
  const redOk = /fail [1-9]/.test(red.out);
  fs.writeFileSync(__dirname + '/../' + T.file, backup);

  const green = run(T.test, 120000);
  const greenOk = /pass [1-9]/.test(green.out) && !/fail [1-9]/.test(green.out);
  const verdict = redOk && greenOk;
  if (!verdict) allOk = false;
  console.log(`${verdict ? '✓ 确认' : '✗ 存疑'} ${T.bug}(${T.before} 反转)`);
  console.log(`   修复前 → ${red.out.split('\n').filter(l => /pass|fail/.test(l)).join(' | ') || red.out.slice(-100).replace(/\n/g, ' | ')}`);
  console.log(`   修复后 → ${green.out.split('\n').filter(l => /pass|fail/.test(l)).join(' ')}`);
  console.log('');
}
console.log(allOk ? '===== 全部反转验证通过: 每个测试在其 bug 修复前变红、修复后变绿 =====' : '===== 存在未通过项, 见上 =====');
process.exit(allOk ? 0 : 1);
