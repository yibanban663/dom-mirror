'use strict';
// Negative controls: the fixture must reject source fallback and changed artifacts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const host = '/consumer/host.cjs';
const entry = require.resolve('@lizhen-xxaq/dom-mirror');
const checks = [];
for (const file of ['/consumer/package.tgz', entry]) {
  const original = fs.readFileSync(file);
  try {
    fs.appendFileSync(file, '\n// changed artifact\n');
    assert.throws(() => require(host), { code: 'ERR_ASSERTION' });
    checks.push({ name: file.endsWith('.tgz') ? 'changed-archive' : 'changed-installed-file', rejected: true });
  } finally { fs.writeFileSync(file, original); }
}
fs.mkdirSync('/app');
try {
  assert.throws(() => require(host), /source checkout remains accessible/);
  checks.push({ name: 'source-directory-fallback', rejected: true });
} finally { fs.rmdirSync('/app'); }
process.env.NODE_PATH = '/home/pptruser/node_modules';
assert.throws(() => require(host), { code: 'ERR_ASSERTION' });
checks.push({ name: 'node-path-fallback', rejected: true });
console.log(JSON.stringify({ pass: true, checks }, null, 2));
