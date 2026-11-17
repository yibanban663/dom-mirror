'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const puppeteer = require('puppeteer').default;
const { createMirror } = require('..');

function mockLaunch(t) {
  const original = puppeteer.launch;
  const launches = [];
  puppeteer.launch = () => new Promise(() => { /* 本组用例不发 hello，不进入装配 */ });
  t.after(() => { puppeteer.launch = original; });
  return launches;
}

async function host(t, cfg) {
  const mirror = createMirror({ originUrl: 'http://127.0.0.1:1/', browserPoolSize: 0,
    logger: { log() {} }, ...cfg });
  const server = http.createServer(mirror.handleRequest);
  server.on('upgrade', mirror.handleUpgrade);
  t.after(async () => {
    await mirror.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  async function connect() {
    // 只完成升级（不发 hello）：限流判定发生在升级阶段，不占会话槽
    return new Promise(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
      const done = v => { try { ws.terminate(); } catch {} resolve(v); };
      ws.on('open', () => done('ok'));
      ws.on('unexpected-response', (req, res) => done(res.statusCode === 429 ? 429 : 'other'));
      ws.on('error', () => done('error'));
      ws.on('close', () => {});
    });
  }
  return { connect };
}

test('global session rate limit works independently of the per-ip switch', { timeout: 10000 }, async t => {
  mockLaunch(t);
  // per-IP=0（不限）+ 全局阈值 1：第 2 个新建连接必须被全局滑窗拒绝——
  // 回归背景：全局检查曾嵌套在 per-IP>0 块内，per-IP=0 时被整体连坐关闭，
  // v0.42 为 DD 代理分摊源 IP 场景增设的兜底形同虚设
  const { connect } = await host(t, { sessionRatePerMin: 0, sessionGlobalRatePerMin: 1 });
  const results = [await connect(), await connect()];
  assert.deepEqual(results, ['ok', 429]);
});

test('per-ip session rate limit still applies alongside the global switch', { timeout: 10000 }, async t => {
  mockLaunch(t);
  // per-IP 阈值 1：第 2 个新建连接按来源 IP 拒绝（修复不得破坏 per-IP 语义）
  const { connect } = await host(t, { sessionRatePerMin: 1, sessionGlobalRatePerMin: 0 });
  const results = [await connect(), await connect()];
  assert.deepEqual(results, ['ok', 429]);
});
