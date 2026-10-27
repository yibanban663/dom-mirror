'use strict';
// v3 dom 模式 canvas 位图捕获：候选清单（页内执行）与逐画布签名/退避状态

// 页内：视口内需位图捕获的画布（指令流画布走 canvas-ops 重放除外），最多 3 个，坐标为页面绝对值
function listCanvases() {
  const out = [];
  try {
    // v0.14：穿透 open shadow root 收集画布（影子内组件图表同捕获）
    const canvases = (window.__xy && window.__xy.allDeep) ? window.__xy.allDeep(document.body, 'canvas') : [...document.body.querySelectorAll('canvas')];
    for (const c of canvases) {
      // v0.14：指令流画布（注入后 2d 上下文且可序列化）走 canvas-ops 重放，
      // 不进位图捕获通道
      if (c.__xyStream2d && !c.__xyOpaque2d) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
      const path = window.__xy.pathOf(c);
      out.push({ id: window.__xy.idOf(c), path, x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height });
      if (out.length >= 3) break;
    }
  } catch (e) {}
  return out;
}

// 未变化画布指数退避：450ms×2^n 封顶 3600ms；一变化即复位。
// sig = { w, h, data: Buffer }；null 表示本次无法比对（按变化处理，不更新基准）
function createCanvasSigs() {
  const sigs = new Map();
  return {
    get size() { return sigs.size; },
    clear() { sigs.clear(); },
    due(key, now) {
      const st = sigs.get(key);
      return !(st && st.nextAt && now < st.nextAt);
    },
    // 返回画面是否变化
    record(key, sig, now) {
      const st = sigs.get(key);
      if (sig && st && st.w === sig.w && st.h === sig.h && st.data.equals(sig.data)) {
        st.unchanged++;
        st.nextAt = now + Math.min(3600, 450 * Math.pow(2, st.unchanged));
        return false;
      }
      if (sig) sigs.set(key, { ...sig, unchanged: 0, nextAt: 0 });
      else if (st) { st.unchanged = 0; st.nextAt = 0; }
      return true;
    },
  };
}

module.exports = { listCanvases, createCanvasSigs };
