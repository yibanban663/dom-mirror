'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePools } = require('../tools/summarize-v8-memory.cjs');

test('V8 pool log parser preserves committed counters and rejects unanchored lines', () => {
  const log = [
    'Pool buffering 1 chunks of committed: 256 KB',
    '[1:0xabc]       19 ms: Mark-Compact 3.9 (5.8) -> 3.7 (6.5) MB, pooled: 0 MB, 5.16 / 0.00 ms testing;',
    '[1:0xabc] Pool buffering 0 chunks of committed:      0 KB',
    '[1:0xabc]      120 ms: Scavenge 5.8 (8.0) -> 3.9 (8.0) MB, pooled: 2 MB, 0.1 ms;',
    '[1:0xabc] Pool buffering 8 chunks of committed:   2048 KB',
  ].join('\n');
  assert.deepEqual(parsePools(log), [{ gcMs: 19, chunks: 0, committedMiB: 0 }, { gcMs: 120, chunks: 8, committedMiB: 2 }]);
  assert.deepEqual(parsePools('ordinary untraced server log'), []);
});
