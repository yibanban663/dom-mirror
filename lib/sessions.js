'use strict';

const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');

class Session extends EventEmitter {
  constructor(store, scope) {
    super();
    this.store = store;
    this.scope = scope;
    this.token = randomBytes(32).toString('base64url');
    this.socket = null;
    this.closed = false;
    this.expires = null;
    this.expiresAt = null;
    this.heartbeat = null;
  }

  get readyState() { return this.socket?.readyState ?? 3; }
  send(data) { if (this.readyState === 1) this.socket.send(data); }

  attach(socket) {
    clearTimeout(this.expires);
    this.expires = null;
    this.expiresAt = null;
    this.socket = socket;
    let alive = true;
    const heartbeat = this.store.heartbeatMs > 0 ? setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      socket.ping();
    }, this.store.heartbeatMs) : null;
    heartbeat?.unref();
    this.heartbeat = heartbeat;
    socket.on('pong', () => { alive = true; });
    socket.on('error', () => {});
    socket.on('message', raw => {
      if (this.socket !== socket || this.closed) return;
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.type === 'release') { this.close(); return; }
      this.emit('message', raw);
    });
    socket.once('close', () => {
      clearInterval(heartbeat);
      if (this.socket !== socket || this.closed) return;
      this.socket = null;
      this.emit('detach');
      this.expiresAt = Date.now() + this.store.graceMs;
      this.expires = setTimeout(() => this.close(), this.store.graceMs);
      this.expires.unref();
    });
  }

  close(code = 1000, reason = 'session ended') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.expires);
    clearInterval(this.heartbeat);
    this.store.entries.delete(this.token);
    const socket = this.socket;
    this.socket = null;
    socket?.close(code, reason);
    this.emit('close');
  }
}

class SessionStore {
  constructor({ limit, graceMs = 60000, heartbeatMs = 10000 }) {
    this.entries = new Map();
    this.limit = limit;
    this.graceMs = graceMs;
    this.heartbeatMs = heartbeatMs;
  }

  claim(token, scope, socket) {
    let session;
    if (token !== undefined) {
      session = typeof token === 'string' && this.entries.get(token);
      if (session && session.expiresAt !== null && session.expiresAt <= Date.now()) session.close();
      if (!session || session.closed || session.scope !== scope) throw new Error('SESSION_EXPIRED');
      if (session.readyState !== 3) throw new Error('SESSION_BUSY');
    } else {
      if (this.entries.size >= this.limit) {
        // v0.36 会话复用：entries 含 grace（断线等待恢复）会话——它们不该占死
        // 上限（刷新/关页 8 次即耗尽）。满额时先逐最旧的 grace 会话，仅当全部
        // 活跃（有 socket）才真正拒绝
        let oldest = null;
        for (const s of this.entries.values()) {
          if (s.socket === null && !s.closed) {
            if (!oldest || (s.expiresAt || 0) < (oldest.expiresAt || 0)) oldest = s;
          }
        }
        if (!oldest) throw new Error('SESSION_LIMIT');
        try { oldest.close(1001, 'session evicted (limit)'); } catch (e) {}
      }
      session = new Session(this, scope);
      this.entries.set(session.token, session);
    }
    session.attach(socket);
    return { session, resumed: token !== undefined };
  }
}

module.exports = { SessionStore };
