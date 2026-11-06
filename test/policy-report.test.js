'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBlockedOriginTracker } = require('../lib/policy-report');

test('records origins and counts repeats', () => {
  const t = createBlockedOriginTracker();
  t.record('https://cdn.a.com', 'image');
  t.record('https://cdn.a.com', 'image');
  t.record('https://cdn.a.com', 'stylesheet');
  t.record('https://cdn.b.com', 'script');
  const s = t.summary();
  assert.ok(s.includes('cdn.a.com') && s.includes('cdn.b.com'));
  const rows = t.rows();
  assert.deepEqual(rows, [
    { origin: 'https://cdn.a.com', count: 3 },
    { origin: 'https://cdn.b.com', count: 1 },
  ]);
});

test('summary is a single line (log-injection safe) and lists origins', () => {
  const t = createBlockedOriginTracker();
  t.record('https://cdn.a.com\r\n[net] FAKE', 'image');
  const s = t.summary();
  assert.ok(!s.includes('\n') && !s.includes('\r'), '摘要必须单行');
  assert.ok(s.includes('cdn.a.com\\r\\n') || s.includes('cdn.a.com'), 'origin 仍在摘要中(单行化)');
});

test('empty tracker yields empty summary', () => {
  const t = createBlockedOriginTracker();
  assert.equal(t.summary(), '');
  assert.deepEqual(t.rows(), []);
});

test('topN limits rows', () => {
  const t = createBlockedOriginTracker();
  for (let i = 0; i < 30; i++) t.record('https://h' + i + '.com', 'image');
  assert.equal(t.rows().length, 30);
  assert.equal(t.top(5).length, 5);
});
