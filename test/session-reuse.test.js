'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { SessionStore } = require('../lib/sessions');

// 最小 socket mock（Session.attach 用到 on/once/ping/close/terminate/readyState）
function mockSocket() {
  const handlers = {};
  const s = {
    readyState: 1,
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
    once: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
    ping: () => {},
    close: () => { s.readyState = 3; (handlers.close || []).forEach(fn => fn()); },
    terminate: () => { s.readyState = 3; (handlers.close || []).forEach(fn => fn()); },
    emitClose: () => { s.readyState = 3; (handlers.close || []).forEach(fn => fn()); },
    send: () => {},
  };
  return s;
}

test('v0.36 会话复用：grace 会话不占死上限（满额时逐最旧 grace，而非 SESSION_LIMIT）', () => {
  const store = new SessionStore({ limit: 2, graceMs: 10000, heartbeatMs: 0 });
  const s1 = mockSocket();
  const s2 = mockSocket();
  const a = store.claim(undefined, 'scope-a', s1);
  const b = store.claim(undefined, 'scope-b', s2);
  assert.equal(store.entries.size, 2);
  // 两个都断线进入 grace
  s1.emitClose();
  s2.emitClose();
  assert.equal(a.session.socket, null);
  assert.equal(store.entries.size, 2);
  // 第三个新会话：应逐出最旧 grace 而不是抛错
  const c = store.claim(undefined, 'scope-c', mockSocket());
  assert.ok(c.session);
  assert.equal(store.entries.size, 2); // 逐 1 补 1
  // 被逐的必是 grace 之一（a/s1 先断 → 应被逐）
  assert.equal(a.session.closed, true);
  assert.equal(b.session.closed, false);
});

test('全部活跃时仍严格拒绝（上限语义保留）', () => {
  const store = new SessionStore({ limit: 2, graceMs: 10000, heartbeatMs: 0 });
  store.claim(undefined, 's1', mockSocket());
  store.claim(undefined, 's2', mockSocket());
  assert.throws(() => store.claim(undefined, 's3', mockSocket()), /SESSION_LIMIT/);
});

test('resume 认领同一会话槽（刷新复用）', () => {
  const store = new SessionStore({ limit: 1, graceMs: 10000, heartbeatMs: 0 });
  const first = store.claim(undefined, 'same', mockSocket());
  first.session.socket.emitClose();
  const again = store.claim(first.session.token, 'same', mockSocket());
  assert.equal(again.resumed, true);
  assert.equal(again.session.token, first.session.token);
  assert.equal(store.entries.size, 1);
});
