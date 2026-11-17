'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { fetchHtml } = require('../lib/xframe');

test('frame fetch accepts only bounded 2xx HTML responses', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<p>hi</p>'); return; }
    if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(Buffer.alloc(512 * 1024 + 1, 97)); return; }
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('missing');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const tracked = [];
  const track = (req) => { tracked.push(req); return req; };
  assert.equal(await fetchHtml(base + '/ok', track), '<p>hi</p>');
  assert.equal(await fetchHtml(base + '/json', track), null);
  assert.equal(await fetchHtml(base + '/big', track), null);
  assert.equal(await fetchHtml(base + '/missing', track), null);
  assert.equal(await fetchHtml('http://127.0.0.1:1/', track), null);
  assert.equal(tracked.length, 5);
});
