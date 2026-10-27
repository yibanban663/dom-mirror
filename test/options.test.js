'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOptions } = require('../lib/options');

test('redaction accepts exact attribute names and snapshots a normalized independent list', () => {
  const attributes = ['DATA-PRIVATE', 'data-private', 'aria-label'];
  const config = normalizeOptions({ originUrl: 'http://localhost/', redactAttributes: attributes });
  assert.deepEqual(config.redactAttributes, ['data-private', 'aria-label']);
  attributes.push('class');
  assert.deepEqual(config.redactAttributes, ['data-private', 'aria-label']);
  assert.deepEqual(normalizeOptions({ originUrl: 'http://localhost/' }).redactAttributes, []);
});

test('redaction rejects selectors, empty names and non-string lists', () => {
  for (const redactAttributes of ['data-private', ['[data-private]'], [''], [null], [12], ['data-*']]) {
    assert.throws(() => normalizeOptions({ originUrl: 'http://localhost/', redactAttributes }), TypeError);
  }
});

test('identity hooks are opt-in functions and are not executed during configuration', () => {
  let called = false;
  const getSessionIdentity = () => { called = true; return 'host-user'; };
  const config = normalizeOptions({ originUrl: 'http://localhost/', getSessionIdentity });
  assert.strictEqual(config.getSessionIdentity, getSessionIdentity);
  assert.equal(called, false);
  assert.equal(normalizeOptions({ originUrl: 'http://localhost/' }).getSessionIdentity, undefined);
  for (const value of [null, '', 'user', {}, 1]) {
    assert.throws(() => normalizeOptions({ originUrl: 'http://localhost/', getSessionIdentity: value }), TypeError);
  }
});

test('Chromium sandbox is on by default and only an explicit boolean disables it', () => {
  assert.equal(normalizeOptions({ originUrl: 'http://localhost/' }).chromiumSandbox, true);
  assert.equal(normalizeOptions({ originUrl: 'http://localhost/', chromiumSandbox: false }).chromiumSandbox, false);
  for (const chromiumSandbox of [0, 'false', 'no']) {
    assert.throws(() => normalizeOptions({ originUrl: 'http://localhost/', chromiumSandbox }), TypeError);
  }
});

test('request origins default to none and reject credentials or non-HTTP schemes', () => {
  assert.deepEqual(normalizeOptions({ originUrl: 'http://localhost/' }).requestOrigins, []);
  assert.deepEqual(normalizeOptions({ originUrl: 'http://localhost/', requestOrigins: ['https://cdn.example/path'] }).requestOrigins, ['https://cdn.example']);
  for (const requestOrigins of ['https://cdn.example', ['ftp://cdn.example'], ['https://u:p@cdn.example']]) {
    assert.throws(() => normalizeOptions({ originUrl: 'http://localhost/', requestOrigins }), TypeError);
  }
});
