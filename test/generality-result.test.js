'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { accepts } = require('../tools/generality-result.cjs');
test('generality rejects the historical partial editor success and any missing or failed checks', () => {
  assert.equal(accepts({ case: 'editor', checks: { ce_typing: true }, error: 'keyRttMs undefined' }), false);
  const checks = { ce_typing: true, term_keys: true, selection: true, feed_append: true, feed_text: true };
  assert.equal(accepts({ case: 'editor', checks }), true);
  assert.equal(accepts({ case: 'editor', checks, error: 'unexpected exception' }), false);
  assert.equal(accepts({ case: 'unknown', checks }), false);
  for (const name of Object.keys(checks)) {
    const partial = { ...checks }; delete partial[name];
    assert.equal(accepts({ case: 'editor', checks: partial }), false);
    assert.equal(accepts({ case: 'editor', checks: { ...checks, [name]: false } }), false);
  }
});
