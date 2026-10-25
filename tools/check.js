'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

for (const name of ['client/index.html', 'protected/index.html', 'test/fixtures/scroll.html', 'test/fixtures/data-boundary.html', 'tools/fixtures/capacity.html']) {
  const html = fs.readFileSync(path.join(root, name), 'utf8');
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    new vm.Script(match[1], { filename: name });
  }
}

for (const name of ['tools/capacity-host.cjs', 'tools/capacity-client.cjs', 'tools/summarize-capacity.cjs',
  'tools/memory-host.cjs', 'tools/memory-client.cjs', 'tools/summarize-memory.cjs', 'tools/verify-frame-baseline.cjs',
  'tools/summarize-allocator.cjs', 'tools/verify-allocator.cjs', 'tools/verify-select.cjs', 'tools/allocator-business-host.cjs']) {
  new vm.Script(fs.readFileSync(path.join(root, name), 'utf8'), { filename: name });
}

// Compile the actual injected template after evaluating its server-side interpolation.
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const start = server.indexOf('const PAGE_HELPERS = ');
const end = server.indexOf('\n// ---------- 静态文件', start);
if (start < 0 || end < 0) throw new Error('PAGE_HELPERS not found');
const helpers = vm.runInNewContext(server.slice(start, end) + '\nPAGE_HELPERS;', {
  ORIGIN_BASE: new URL('http://127.0.0.1:8077/'), config: { redactAttributes: [] },
});
new vm.Script(helpers, { filename: 'PAGE_HELPERS' });
console.log('Client, demo and injected scripts compile');
