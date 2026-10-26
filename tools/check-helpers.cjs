'use strict';
// 校验 PAGE_HELPERS 模板（含 pageHelpersFor 替换后）生成代码的语法
const fs = require('fs');
const s = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
const i = s.indexOf('const PAGE_HELPERS = `');
const j = s.indexOf('`;', i);
if (i < 0 || j < 0) { console.error('PAGE_HELPERS 模板未找到'); process.exit(1); }
const tpl = s.slice(i + 'const PAGE_HELPERS = `'.length, j);
const esc = JSON.stringify('http://origin-b:8000').slice(1, -1);
const code = tpl
  // 模板在模块加载时插值的 config 片段（redactAttributes/maskInputTypes 等），
  // 提取的源文本仍是字面 ${...}——以合法占位值代替
  .replace(/\$\{[^}]*\}/g, '[]')
  // 模板求值会把 \\ 折叠为 \：源文本是"未求值"形态，先模拟该折叠再校验语法
  .replace(/\\(.)/g, '$1')
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
