'use strict';
// cssProxyRewritePure(直通路径 CSS 改写, 纯函数依赖注入)回归测试
// 缺陷背景: 实测 ruanyifeng 形态的 @import url("/sub.css") 相对路径在直通
// 模式下未被改写 → 镜像端按壳解析 404 → @import 链断 → 子样式表规则全丢
// (canvas-origin 实测: h2 色 rgb(0,0,0), 期望 rgb(0,119,0))
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cssProxyRewritePure } = require('../server');

const ORIGIN = 'http://127.0.0.1:8098';
const BASE = ORIGIN + '/main.css'; // 样式表自身的源站绝对地址
const allowedHas = (o) => o === 'https://cdn.beekka.com';

test('@import url 相对根路径 → 同源 /m/ 通道', () => {
  const out = cssProxyRewritePure('@import url("/sub.css");body{background:#f0f0f0}', BASE, ORIGIN + '/', allowedHas);
  assert.ok(out.includes('@import url("/m/sub.css")'), '@import 相对路径必须改写为 /m/ 通道, 实际: ' + out);
  assert.ok(out.includes('.xy-body{background:#f0f0f0}'), 'body 选择器替换不回归');
});

test('originBase 带尾斜杠/路径 → 规范化后判定不受影响', () => {
  const a = cssProxyRewritePure('@import url("/sub.css")', BASE, ORIGIN + '/', allowedHas);
  const b = cssProxyRewritePure('@import url("/sub.css")', BASE, ORIGIN + '/blog/', allowedHas);
  assert.ok(a.includes('/m/sub.css') && b.includes('/m/sub.css'), '两种 originBase 形态都要改写');
});

test('url() 相对路径同源 → /m/ 通道', () => {
  const out = cssProxyRewritePure('a{background:url("../img/x.png")}', BASE, ORIGIN + '/', allowedHas);
  assert.ok(out.includes('url("/m/img/x.png")'), 'url() 相对路径改写, 实际: ' + out);
});

test('白名单跨源 → /m/o/<b64> 通道', () => {
  const out = cssProxyRewritePure('a{background:url("https://cdn.beekka.com/blogimg/x.png")}', BASE, ORIGIN + '/', allowedHas);
  assert.ok(/url\("\/m\/o\/[A-Za-z0-9_-]+\/blogimg\/x\.png"\)/.test(out), '跨源白名单 b64 通道: ' + out);
});

test('非白名单跨源 → 原样保留(交给镜像端拒绝)', () => {
  const out = cssProxyRewritePure('a{background:url("https://evil.invalid/x.png")}', BASE, ORIGIN + '/', allowedHas);
  assert.ok(out.includes('evil.invalid'), '不改写非白名单: ' + out);
});

test('既有行为不回归: 字体对齐无关的普通规则/选择器替换', () => {
  const out = cssProxyRewritePure('p{color:#333}html{--x:1}:root{--y:2}', BASE, ORIGIN + '/', allowedHas);
  assert.ok(out.includes('p{color:#333}'), '普通规则原样');
  assert.ok(out.includes('.xy-body{--x:1}'), 'html→.xy-body');
  assert.ok(out.includes('.xy-body{--y:2}'), ':root→.xy-body');
});

test('fragment 引用(#)不改写——SVG filter/clip-path 引用断裂防护', () => {
  const out = cssProxyRewritePure('a{clip-path:url(#myclip);filter:url(#f)}', BASE, ORIGIN + '/', allowedHas);
  assert.ok(out.includes('url(#myclip)') && out.includes('url(#f)'), 'fragment 必须原样, 实际: ' + out);
});

test('幂等: 已改写的 /m/ 路径不二次改写(防 /m/m/ 病态)', () => {
  const out = cssProxyRewritePure('a{background:url(/m/sub.css)}', BASE, ORIGIN + '/', allowedHas);
  assert.ok(!out.includes('/m/m/'), '禁止双重改写, 实际: ' + out);
  assert.ok(out.includes('url(/m/sub.css)'), '已改写路径原样保留: ' + out);
});
