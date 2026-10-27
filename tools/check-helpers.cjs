'use strict';
// 校验 PAGE_HELPERS 模板（含 pageHelpersFor 替换后）生成代码的语法
const fs = require('fs');
const { pageHelpers } = require('../lib/page-helpers');
const esc = JSON.stringify('http://origin-b:8000').slice(1, -1);
const code = pageHelpers({ redactAttributes: [], maskInputTypes: [], canvasStream: true })
  .split('__XY_DEFAULT_PREFIX__').join('http://127.0.0.1:8077')
  .split('__XY_ORIGIN_PREFIX__').join(esc);
try { new Function(code); console.log('PAGE_HELPERS OK, len=', code.length); } catch (e) {
  console.error('SYNTAX FAIL:', e.message);
  const tmp = require('path').join(require('os').tmpdir(), 'page-helpers-check.js');
  fs.writeFileSync(tmp, code);
  const { execFileSync } = require('child_process');
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'inherit' }); } catch (e2) {}
  const lines = code.split('\n');
  const m = /(\d+):(\d+)/.exec(String(e.stack || ''));
  if (m) console.log('near line', m[1], ':\n', lines.slice(Math.max(0, m[1] - 3), m[1] + 2).join('\n'));
  process.exit(1);
}
for (const l of code.split('\n')) {
  if (/M_BASE|toProxyUrl|cssUrlRewrite|ORIGIN_PREFIX =/.test(l)) console.log(l.trim());
}
