'use strict';
// v0.76 对账纯逻辑（单元测试锚点）：判定 + 源站降级记忆库。
// 从 server.js 抽出——v0.75 的两枚自伤 bug（参数类型/变量名）都是纯逻辑层
// 的错，e2e 抓得慢；这里可直接 node 断言。

const FIDELITY_PASS = 0.7;   // 单轮通过线：命中/受判 ≥ 70%
const FIDELITY_MIN_JUDGED = 4; // 剔除后受判样本下限（低于=页面剧烈变化，跳过不计败）
const WINDOW_MS = 600000;    // 源站降级事件记忆窗口
const HOT_MARKS = 3;         // 窗口内降级次数 → 站点兜底

function fpTolerance(w, h) {
  return { tw: Math.max(6, Math.round(w * 0.04)), th: Math.max(6, Math.round(h * 0.04)) };
}

// srvFp: [{id,w,h}]（w<0 = live 已移除，跳过）；clientMap: id → {w,h}；
// dims: 快照时刻基准几何 Map（稳定性过滤：live≠基准 = 页面自身改的，剔除）；
// opts.trap: 测试钩子（扰动受判样本几何，模拟站点改版漂移）；
// opts.srvH/cliH: 页总高维度（整页塌陷一个数字抓住；任一侧缺失则不计）。
function fidelityJudge(srvFp, clientMap, dims, opts) {
  const o = opts || {};
  let match = 0, judged = 0, unstable = 0;
  for (const s of (srvFp || [])) {
    if (!s || s.w < 0 || s.h < 0) continue;
    const snapD = dims ? dims.get(s.id) : null;
    if (!snapD) continue;
    const { tw, th } = fpTolerance(s.w, s.h);
    if (Math.abs(s.w - (snapD.w || 0)) > tw || Math.abs(s.h - (snapD.h || 0)) > th) { unstable++; continue; }
    judged++;
    const trapHit = o.trap && judged % 10 !== 0;
    const sw = trapHit ? s.w + 64 : s.w;
    const sh = trapHit ? s.h + 48 : s.h;
    const c = clientMap.get(s.id);
    if (!c || !Number.isFinite(c.w) || !Number.isFinite(c.h)) continue;
    if (Math.abs((c.w || 0) - sw) <= tw && Math.abs((c.h || 0) - sh) <= th) match++;
  }
  if (Number.isFinite(o.srvH) && o.srvH > 0 && Number.isFinite(o.cliH) && o.cliH > 0) {
    judged++;
    if (Math.abs(o.cliH - o.srvH) <= Math.max(8, Math.round(o.srvH * 0.02))) match++;
  }
  return { match, judged, unstable };
}

// 源站降级记忆：窗口滑出自动恢复；file 提供时落盘（防抖 5s）——容器重启
// 不丢冷却状态；重新部署（换镜像）自然清零：新引擎版本重考一次是合理语义。
function createFidelityStore(file) {
  const self = { marks: new Map(), file: file || null, saveT: null };
  self.prune = () => {
    const now = Date.now();
    for (const [k, arr] of self.marks) {
      const a2 = (arr || []).filter((t) => now - t < WINDOW_MS);
      if (a2.length) self.marks.set(k, a2); else self.marks.delete(k);
    }
  };
  self.load = () => {
    try {
      const d = JSON.parse(require('node:fs').readFileSync(self.file, 'utf8'));
      for (const k of Object.keys(d || {})) if (Array.isArray(d[k])) self.marks.set(k, d[k]);
    } catch (e) {}
    self.prune();
  };
  self.hot = (origin) => { if (!origin) return false; self.prune(); return (self.marks.get(origin) || []).length >= HOT_MARKS; };
  self.mark = (origin) => {
    if (!origin) return;
    self.prune();
    const a = self.marks.get(origin) || [];
    a.push(Date.now());
    self.marks.set(origin, a);
    if (!self.file || self.saveT) return;
    self.saveT = setTimeout(() => {
      self.saveT = null;
      try {
        self.prune();
        const o = {};
        for (const [k, v] of self.marks) o[k] = v;
        require('node:fs').writeFileSync(self.file, JSON.stringify(o));
      } catch (e) {}
    }, 5000);
  };
  if (self.file) self.load();
  return self;
}

module.exports = { fpTolerance, fidelityJudge, createFidelityStore, FIDELITY_PASS, FIDELITY_MIN_JUDGED };
