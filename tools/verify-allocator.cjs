'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const native = require('./native-memory.node');
const allocator = process.env.MEMORY_EXPECT_ALLOCATOR;
const before = native.allocatorStats();
assert.equal(before.implementation, allocator);
const mapped = fs.readFileSync('/proc/self/maps', 'utf8').includes('libjemalloc');
assert.equal(mapped, allocator === 'jemalloc');
const bytes = 64 * 2 ** 20;
const held = Buffer.alloc(bytes, 1);
const after = native.allocatorStats();
if (allocator === 'jemalloc') assert.ok(after.allocated - before.allocated >= bytes, 'Live Buffer must appear in jemalloc allocation stats');
assert.equal(held[bytes - 1], 1);
console.log(JSON.stringify({ allocator, passed: true, mapped, liveBufferBytes: held.length,
  allocatedDelta: allocator === 'jemalloc' ? after.allocated - before.allocated : null, before, after }));
