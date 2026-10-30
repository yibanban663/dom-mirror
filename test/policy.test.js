'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assetUrl, selectOrigin, createRequestPolicy, requestAllowed } = require('../lib/policy');
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

test('server browser requests are limited to listed origins and in-page schemes', () => {
  const origins = new Set(['https://origin.example', 'https://cdn.example']);
  for (const value of ['https://origin.example/app', 'https://cdn.example/a.js?x=1', 'data:image/png,x', 'blob:https://origin.example/id', 'about:blank']) {
    assert.equal(requestAllowed(value, origins), true, value);
  }
  for (const value of ['http://origin.example/', 'https://origin.example:8443/', 'https://u:p@origin.example/',
    'http://169.254.169.254/latest', 'file:///etc/passwd', 'chrome://version', 'ftp://origin.example/', 'not a url']) {
    assert.equal(requestAllowed(value, origins), false, value);
  }
});

test('v0.38 wildcard suffix policy matches subdomains and apex of pinned protocol only', () => {
  const policy = createRequestPolicy(['https://origin.example', 'https://*.cdn.example', 'https://*.bdstatic.com/']);
  for (const value of ['https://cdn.example/a.js', 'https://a.cdn.example/x.png', 'https://a.b.cdn.example/y.css',
    'https://bdstatic.com/z.png', 'https://pss.bdstatic.com/static/i.png']) {
    assert.equal(requestAllowed(value, policy), true, value);
  }
  for (const value of ['http://a.cdn.example/', 'https://a.cdn.example:8443/', 'https://xcdn.example/',
    'https://cdn.example.attacker.test/', 'https://a.cdn.example.evil.test/', 'ftp://cdn.example/x']) {
    assert.equal(requestAllowed(value, policy), false, value);
  }
  assert.equal(requestAllowed('https://origin.example/app', policy), true);
});
