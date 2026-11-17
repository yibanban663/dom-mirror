'use strict';
// Executed through stdin inside the independent consumer, using installed deps.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { WebSocket } = createRequire('/consumer/package.json')('ws');
const base = 'http://127.0.0.1:8088';
async function state() {
  const response = await fetch(base + '/__package/status', { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  return response.json();
}
// v0.30 池化：会话资源=BrowserContext（浏览器常驻复用）——reclaimed 改上下文语义
const reclaimed = cs => cs.length && cs.every(c => c.closed);
async function waitFor(predicate) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const value = await state();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Package browser lifecycle timed out');
}
(async () => {
  const before = await waitFor(value => reclaimed(value.contexts));
  assert.ok(before.contexts.length >= Number(process.env.PACKAGE_EXPECTED_BROWSERS), 'contexts: ' + before.contexts.length);
  const socket = new WebSocket('ws://127.0.0.1:8088/ws');
  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'hello' }));
    await waitFor(value => value.contexts.length === before.contexts.length + 1 && value.contexts.at(-1).connected);
    const disconnected = once(socket, 'close');
    const response = await fetch(base + '/__package/close', { method: 'POST', signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200);
    await disconnected;
    const after = await waitFor(value => reclaimed(value.contexts));
    assert.equal(after.contexts.length, before.contexts.length + 1);
    assert.equal(await (await fetch(base + '/__package/health')).text(), 'host alive');
    assert.equal((await fetch(base + '/')).status, 503);
    console.log(JSON.stringify({ pass: true, before, after, activeSessionClosed: true,
      repeatedClosePassed: true, hostRemainsAlive: true, closedMirrorStatus: 503 }, null, 2));
  } finally { socket.terminate(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
