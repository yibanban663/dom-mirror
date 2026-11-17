'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTrace, readTrace, mappingCycles } = require('../tools/memory-trace.cjs');

test('disk telemetry preserves every record without retaining trace rows; legacy evidence stays readable', () => {
  for (const storage of ['memory', 'disk']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-trace-'));
    try {
      const trace = createTrace(directory, storage);
      for (let i = 0; i < 1000; i++) trace.append('samples', { ms: i, cycle: Math.floor(i / 10) });
      trace.append('checkpoints', { cycle: 1, phase: 'postIdle' });
      trace.append('collections', { duration: 2 });
      const saved = trace.snapshot();
      assert.equal(saved.samples.length, storage === 'disk' ? 0 : 1000);
      assert.equal(saved.checkpoints.length, storage === 'disk' ? 0 : 1);
      assert.equal(saved.collections.length, storage === 'disk' ? 0 : 1);
      const restored = readTrace(directory, JSON.parse(JSON.stringify(saved)));
      assert.equal(restored.samples.length, 1000);
      assert.deepEqual(restored.samples[999], { ms: 999, cycle: 99 });
      assert.deepEqual(restored.checkpoints, [{ cycle: 1, phase: 'postIdle' }]);
      assert.deepEqual(restored.collections, [{ duration: 2 }]);
      assert.throws(() => createTrace(directory, storage)); // No silently mixed runs.
      assert.throws(() => readTrace(directory, { ...saved, traceCounts: { ...saved.traceCounts, samples: 1001 } }), /count mismatch/);
      if (storage === 'disk') {
        fs.appendFileSync(path.join(directory, 'samples.jsonl'), '{');
        assert.throws(() => readTrace(directory, saved), /Truncated/);
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  const legacy = { samples: [], checkpoints: [], collections: [] };
  assert.equal(readTrace('/unused', legacy), legacy);
});

test('mapping capture configuration rejects invalid cycle numbers and storage modes', () => {
  assert.deepEqual(mappingCycles('20,16,18,18'), [16, 18, 20]);
  assert.deepEqual(mappingCycles(), []);
  for (const value of ['0', '61', '18,', 'NaN', '1.5']) assert.throws(() => mappingCycles(value));
  assert.throws(() => createTrace('/unused', 'typo'), /MEMORY_TRACE_STORAGE/);
});
