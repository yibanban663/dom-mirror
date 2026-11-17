'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvasSigs } = require('../lib/canvas');

const sig = (byte, w = 2) => ({ w, h: 1, data: Buffer.alloc(w * 4, byte) });

test('unchanged canvases back off exponentially and reset on change', () => {
  const sigs = createCanvasSigs();
  assert.equal(sigs.record(1, sig(0), 0), true);
  assert.equal(sigs.due(1, 0), true);
  const waits = [];
  let now = 0;
  for (let i = 0; i < 5; i++) {
    assert.equal(sigs.record(1, sig(0), now), false);
    for (waits[i] = 0; !sigs.due(1, now + waits[i]); waits[i] += 50);
    now += waits[i];
  }
  assert.deepEqual(waits, [900, 1800, 3600, 3600, 3600]);
  assert.equal(sigs.record(1, sig(1), now), true);
  assert.equal(sigs.due(1, now), true);
});

test('size changes and failed comparisons count as changed', () => {
  const sigs = createCanvasSigs();
  sigs.record('a', sig(0), 0);
  assert.equal(sigs.record('a', sig(0, 3), 0), true);
  sigs.record('a', sig(0, 3), 0);
  assert.equal(sigs.due('a', 10), false);
  assert.equal(sigs.record('a', null, 10), true);
  assert.equal(sigs.due('a', 10), true);
  assert.equal(sigs.record('a', sig(0, 3), 10), false, 'failed comparison keeps the previous baseline');
  assert.equal(sigs.size, 1);
  sigs.clear();
  assert.equal(sigs.size, 0);
});
