'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { SessionStore } = require('../lib/sessions');

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(raw) { this.sent.push(raw); }
  close() { this.readyState = 3; this.emit('close'); }
}
const store = options => new SessionStore({ limit: 2, graceMs: 1000, heartbeatMs: 0, ...options });

test('resume keeps logical session and does not buffer or replay commands', () => {
  const registry = store();
  const a = new Socket();
  const { session } = registry.claim(undefined, 'origin-a', a);
  const commands = [];
  session.on('message', raw => commands.push(raw));
  a.emit('message', '{"type":"key","key":"Enter"}');
  a.close();
  session.send('discarded offline update');
  const b = new Socket();
  const resumed = registry.claim(session.token, 'origin-a', b);
  assert.equal(resumed.session, session);
  assert.equal(resumed.resumed, true);
  assert.deepEqual(commands, ['{"type":"key","key":"Enter"}']);
  assert.deepEqual(b.sent, []);
  a.emit('message', '{"type":"key","key":"Enter"}');
  assert.equal(commands.length, 1);
  session.close();
});

test('active sessions cannot be taken over and resume is bound to scope', () => {
  const registry = store();
  const { session } = registry.claim(undefined, 'origin-a', new Socket());
  assert.throws(() => registry.claim(session.token, 'origin-a', new Socket()), /SESSION_BUSY/);
  assert.throws(() => registry.claim(session.token, 'origin-b', new Socket()), /SESSION_EXPIRED/);
  assert.throws(() => registry.claim('invalid', 'origin-a', new Socket()), /SESSION_EXPIRED/);
  session.close();
});

// v0.36 会话复用语义：grace（断线等待）会话不再占死上限——满额时逐最旧 grace
// 让新访客进来（此前刷新/关页数次即 SESSION_LIMIT，线上实测 8 次耗尽）；被逐
// 会话的令牌不可再恢复，正常过期路径保持原语义
test('detached sessions are evictable at limit (v0.36), expired token cannot resume', async () => {
  const registry = store({ limit: 1, graceMs: 30 });
  const socket = new Socket();
  const first = registry.claim(undefined, 'origin-a', socket).session;
  socket.close();
  assert.equal(first.socket, null);
  // 满额但唯一占位者处于 grace：新会话接管，旧会话被逐
  const second = registry.claim(undefined, 'origin-a', new Socket()).session;
  assert.ok(second && second !== first);
  assert.equal(first.closed, true);
  assert.equal(registry.entries.size, 1);
  assert.throws(() => registry.claim(first.token, 'origin-a', new Socket()), /SESSION_EXPIRED/);
  // 正常过期：detach 后超过 grace 自动关闭，令牌失效
  const closed = once(second, 'close');
  second.socket.close();
  let deadline;
  try {
    await Promise.race([closed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('expiration timeout')), 2000); })]);
  } finally { clearTimeout(deadline); }
  assert.equal(registry.entries.size, 0);
  assert.throws(() => registry.claim(second.token, 'origin-a', new Socket()), /SESSION_EXPIRED/);
});

test('release terminates only the attached session and runs cleanup once', () => {
  const registry = store();
  const a = new Socket();
  const first = registry.claim(undefined, 'same-account', a).session;
  const second = registry.claim(undefined, 'same-account', new Socket()).session;
  assert.notEqual(first.token, second.token);
  let closed = 0;
  first.on('close', () => closed++);
  a.emit('message', '{"type":"release"}');
  first.close();
  assert.equal(closed, 1);
  assert.equal(second.readyState, 1);
  assert.equal(registry.entries.size, 1);
  second.close();
});

test('heartbeat terminates a silent transport and eventually reclaims its session', async () => {
  const registry = store({ heartbeatMs: 5, graceMs: 10 });
  const socket = new Socket();
  let pings = 0;
  socket.ping = () => { pings++; };
  socket.terminate = () => socket.close();
  const { session } = registry.claim(undefined, 'origin-a', socket);
  let deadline;
  try {
    await Promise.race([
      once(session, 'close'),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('heartbeat timeout')), 1000); }),
    ]);
  } finally { clearTimeout(deadline); }
  assert.equal(pings, 1);
  assert.equal(socket.readyState, 3);
  assert.equal(registry.entries.size, 0);
});
