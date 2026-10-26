'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer, WebSocket } = require('ws');
const { createUploads, UPLOAD_CHUNK_BYTES } = require('../lib/uploads');
const { normalizeOptions } = require('../lib/options');
const options = extra => ({ maxBytes: 65536, maxTotalBytes: 131072, maxConcurrent: 2, idleTimeoutMs: 100, ...extra });
const entry = size => ({ name: 'test.txt', size, fid: 1 });
const chunk = Buffer.alloc(UPLOAD_CHUNK_BYTES, 65).toString('base64');

test('upload reservations bound concurrent, pending and completed data, including empty files', () => {
  const uploads = createUploads(options());
  uploads.begin('a', entry(65536)); uploads.begin('b', entry(65536));
  assert.throws(() => uploads.begin('c', entry(1)), /session upload limit/);
  assert.throws(() => uploads.begin('a', entry(1)), /invalid transfer id/);
  for (const id of ['a', 'b']) {
    uploads.append(id, chunk); uploads.append(id, chunk);
    assert.equal(Buffer.concat(uploads.finish(id).chunks).length, 65536);
  }
  assert.throws(() => uploads.begin('c', entry(1)), /session upload limit/);
  uploads.clear();
  for (let i = 0; i < 64; i++) { uploads.begin(String(i), entry(0)); uploads.finish(String(i)); }
  assert.throws(() => uploads.begin('extra', entry(0)), /session upload limit/);
});

test('incomplete, malformed, empty and overly fragmented uploads release reservations', () => {
  for (const bad of ['', '!!!!', Buffer.alloc(UPLOAD_CHUNK_BYTES + 1).toString('base64')]) {
    const uploads = createUploads(options({ maxTotalBytes: 65536 }));
    uploads.begin('a', entry(65536));
    assert.throws(() => uploads.append('a', bad));
    uploads.begin('b', entry(65536));
  }
  const uploads = createUploads(options());
  uploads.begin('a', entry(2)); uploads.append('a', 'YQ==');
  assert.throws(() => uploads.append('a', 'Yg=='), /chunk or size limit/);
  uploads.begin('a', entry(2));
  assert.throws(() => uploads.finish('a'), /size mismatch/);
  assert.throws(() => uploads.finish('a'), /unknown upload/);
  for (const size of [-1, 65537, 1.5, '2', NaN]) assert.throws(() => uploads.begin('bad', entry(size)));
});

test('idle uploads expire, release memory reservations and cannot accept later chunks', () => {
  const uploads = createUploads(options());
  uploads.begin('a', entry(65536), 0); uploads.begin('b', entry(65536), 0);
  uploads.append('b', chunk, 90);
  assert.deepEqual(uploads.expire(100), ['a']);
  assert.throws(() => uploads.append('a', chunk), /unknown upload/);
  uploads.begin('c', entry(65536), 100);
  assert.deepEqual(uploads.expire(200), ['b', 'c']);
});

test('full upload chunks including JSON fit the real WebSocket limit with and without compression', async () => {
  for (const perMessageDeflate of [false, { threshold: 512 }]) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 64 * 1024, perMessageDeflate });
    await once(server, 'listening');
    const connection = once(server, 'connection');
    const client = new WebSocket('ws://127.0.0.1:' + server.address().port);
    try {
      const [peer] = await connection;
      await once(client, 'open');
      const received = once(peer, 'message');
      const message = JSON.stringify({ type: 'upload-chunk', tid: 't'.repeat(128), b64: chunk });
      assert.ok(Buffer.byteLength(message) < 64 * 1024);
      client.send(message);
      assert.equal((await received)[0].toString(), message);
    } finally {
      client.terminate(); for (const peer of server.clients) peer.terminate();
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test('upload budgets and cross-origin frame policy are explicit and validated', () => {
  const config = normalizeOptions({ originUrl: 'http://localhost/' });
  assert.deepEqual(config.crossOriginFrameOrigins, []);
  assert.equal(config.upload.maxTotalBytes, 16 * 1024 * 1024);
  for (const upload of [{ maxTotalBytes: 0 }, { maxConcurrent: 9 }, { idleTimeoutMs: 1 }]) {
    assert.throws(() => normalizeOptions({ originUrl: 'http://localhost/', upload }));
  }
  for (const crossOriginFrameOrigins of ['https://example.invalid', ['file:///tmp/'], ['http://user:pass@localhost']]) {
    assert.throws(() => normalizeOptions({ originUrl: 'http://localhost/', crossOriginFrameOrigins }));
  }
});
