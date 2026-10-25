'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assetUrl, selectOrigin } = require('../lib/policy');
const base = new URL('https://origin.example/app/');

test('asset proxy accepts same-origin presentation resources with query strings', () => {
  assert.equal(assetUrl('/fonts/site.woff2?v=2', base).href, 'https://origin.example/fonts/site.woff2?v=2');
  assert.equal(assetUrl('logo.png', base).pathname, '/app/logo.png');
});

test('asset proxy rejects other hosts, credentials, schemes and non-assets', () => {
  for (const value of ['//other.example/x.png', '/\\other.example/x.png', 'http://origin.example/x.png',
    'https://u:p@origin.example/x.css', '/', '/api/data', '/app.js', 'data:image/png,x', 'http://[']) {
    assert.equal(assetUrl(value, base), null, value);
  }
});

test('source header requires an explicit origin allowlist', () => {
  assert.equal(selectOrigin(undefined, base.href, []), base.href);
  assert.throws(() => selectOrigin(base.origin, base.href, []));
  assert.equal(selectOrigin(base.origin + '/path?q=1', base.href, [base.origin]), base.origin + '/');
  for (const value of ['https://origin.example.attacker.test', 'https://u:p@origin.example', 'file:///etc/passwd', 'invalid']) {
    assert.throws(() => selectOrigin(value, base.href, [base.origin]), value);
  }
});
