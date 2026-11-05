'use strict';
// v0.76 单元测试（秒级、无 docker）：对账判定 / 源站记忆库 / 壳注释剥离。
// v0.75 的两枚自伤 bug（参数类型/变量名残留）都发生在纯逻辑层——e2e 抓得慢，
// 这里直接按语义断言。
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fidelityJudge, createFidelityStore, FIDELITY_PASS, FIDELITY_MIN_JUDGED } = require('../lib/fidelity');
const { stripClientComments } = require('../lib/text-utils');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok -', name); }

const dims = new Map([[1, { id: 1, w: 100, h: 50 }], [2, { id: 2, w: 200, h: 80 }], [3, { id: 3, w: 300, h: 120 }], [4, { id: 4, w: 400, h: 160 }], [5, { id: 5, w: 120, h: 60 }]]);
const live = [{ id: 1, w: 100, h: 50 }, { id: 2, w: 202, h: 80 }, { id: 3, w: 300, h: 120 }, { id: 4, w: 400, h: 160 }, { id: 5, w: 120, h: 60 }];
const cmAll = () => new Map(live.map((s) => [s.id, s]));

t('全命中', () => {
  const v = fidelityJudge(live, cmAll(), dims, {});
  assert.deepStrictEqual(v, { match: 5, judged: 5, unstable: 0 });
});
t('稳定性过滤：live 自身漂移剔除不计败', () => {
  const shifted = live.map((s) => s.id === 2 ? { id: 2, w: 400, h: 300 } : s);
  const v = fidelityJudge(shifted, cmAll(), dims, {});
  assert.strictEqual(v.unstable, 1);
  assert.strictEqual(v.judged, 4);
  assert.strictEqual(v.match, 4);
});
t('客户端缺样本=受判不中', () => {
  const cm = cmAll(); cm.delete(5);
  const v = fidelityJudge(live, cm, dims, {});
  assert.strictEqual(v.judged, 5);
  assert.strictEqual(v.match, 4);
});
t('w<0（live 移除）跳过', () => {
  const live2 = live.slice(0, 4).concat([{ id: 5, w: -1, h: -1 }]);
  const v = fidelityJudge(live2, cmAll(), dims, {});
  assert.strictEqual(v.judged, 4);
  assert.strictEqual(v.match, 4);
});
t('trap 扰动致判败', () => {
  const v = fidelityJudge(live, cmAll(), dims, { trap: true });
  assert.strictEqual(v.match, 0);
  assert.strictEqual(v.judged, 5);
});
t('页总高维度：一致计中 / 塌陷计败', () => {
  const ok = fidelityJudge(live, cmAll(), dims, { srvH: 2000, cliH: 2010 });
  assert.strictEqual(ok.judged, 6); assert.strictEqual(ok.match, 6);
  const bad = fidelityJudge(live, cmAll(), dims, { srvH: 2000, cliH: 800 });
  assert.strictEqual(bad.judged, 6); assert.strictEqual(bad.match, 5);
});
t('页总高单侧缺失不计', () => {
  const v = fidelityJudge(live, cmAll(), dims, { srvH: 2000 });
  assert.strictEqual(v.judged, 5);
});
t('常量', () => { assert.strictEqual(FIDELITY_PASS, 0.7); assert.strictEqual(FIDELITY_MIN_JUDGED, 4); });

// 记忆库：hot/mark 同步断言；防抖落盘往返异步收尾（Atomics.wait 会阻塞事件
// 循环把 5s 防抖定时器一并卡死——落盘断言必须走真实定时器路径）
const fidFile = path.join(os.tmpdir(), 'xy-fid-test-' + Date.now() + '.json');
{
  const s1 = createFidelityStore(fidFile);
  assert.strictEqual(s1.hot('http://a'), false);
  s1.mark('http://a'); s1.mark('http://a'); s1.mark('http://a');
  assert.strictEqual(s1.hot('http://a'), true);
  assert.strictEqual(s1.hot('http://b'), false);
  const s2 = createFidelityStore(fidFile); // 防抖未落盘：新实例为空
  assert.strictEqual(s2.hot('http://a'), false);
  n++; console.log('ok - 记忆库：hot/mark/防抖未落盘');
}
setTimeout(() => {
  const s3 = createFidelityStore(fidFile); // 落盘后重开：状态保留
  try {
    assert.strictEqual(s3.hot('http://a'), true);
    fs.unlinkSync(fidFile);
  } catch (e) { console.error('FAIL 落盘往返: ' + e.message); process.exit(1); }
  n++; console.log('ok - 记忆库：落盘往返');
  console.log('UNIT-PASS', n, 'tests');
}, 5500);

t('注释剥离：行注释去除、代码保留', () => {
  const out = stripClientComments('<style>a{color:red}</style>\n// 注释行\n<script>var a=1;</script>');
  assert.ok(!out.includes('注释行'), out);
  assert.ok(out.includes('var a=1;'), out);
  assert.ok(out.includes('a{color:red}'), out);
});
t('注释剥离：中文跨行块注释不泄漏（v0.55 事故形态）', () => {
  const out = stripClientComments('<style>a{color:red}\n/* 中文注释\n   第二行 */\nb{color:blue}</style>');
  assert.ok(!out.includes('中文注释'), out);
  assert.ok(!out.includes('第二行'), out);
  assert.ok(out.includes('a{color:red}'), out);
  assert.ok(out.includes('b{color:blue}'), out);
});


