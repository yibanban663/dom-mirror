'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUploads } = require('../lib/uploads');
const cfg = { maxBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxConcurrent: 4, idleTimeoutMs: 30000 };

// 回归背景:批次 1 对抗发现 uploads 模块自身不校验文件名(路径穿越/超长名/
// 空名)——server.js 上层已拦, 但模块不设防违反纵深分层; 超长名还会在
// upload-end 触发 ENAMETOOLONG, 错误消息可能泄漏服务器路径。

const begin = (name) => {
  const u = createUploads(cfg);
  let err = null;
  try { u.begin('tid', { name, size: 100, fid: 1 }); } catch (e) { err = e.message; }
  return err;
};

test('rejects path traversal names at module level', () => {
  for (const name of ['../evil.png', '..\\evil.png', '/etc/evil.png', 'a/b.png', 'a\\b.png']) {
    assert.match(String(begin(name)), /invalid filename|filename/i, `${name} 应被模块自身拒绝`);
  }
});

test('rejects empty and oversized names (>255 bytes, fs limit)', () => {
  assert.match(String(begin('')), /invalid filename|filename/i);
  assert.match(String(begin('A'.repeat(256) + '.png')), /invalid filename|filename/i);
});

test('accepts legitimate names', () => {
  for (const name of ['report.png', '数据表.xlsx', 'a-b_c.v2.pdf']) {
    assert.equal(begin(name), null, `${name} 应被接受`);
  }
});
