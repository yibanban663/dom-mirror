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
      let hot = (c.__xyBudgetHot && (Date.now() - c.__xyBudgetHot < 6000)) ? 1 : undefined;
      // v0.37 空白烘焙槽（快照恰落图表 reinit 空白窗）：10s 窗口内每拍优先捕获
      // 真值（一次性标记会被空白窗第一拍消耗，图表绘制后 rAF 停转即捕获停摆）；
      // hot 同时旁路 rAF 门与 sig 退避，sig 去重保证零重复下发
      if (window.__xyCanvasSlotKey) {
        const slot = window.__xyCanvasSlotKey(c);
        const uExp = slot && window.__xyCanvasUrgent ? window.__xyCanvasUrgent.get(slot) : 0;
        if (uExp) {
          if (Date.now() < uExp) hot = 1;
          else window.__xyCanvasUrgent.delete(slot);
        }
      }
      out.push({ id: window.__xy.idOf(c), path, x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height, hot });
      if (out.length >= 3) break;
    }
    // v0.28 声明式 closed 宿主位图兜底（同一 region clip 通道；fresh=未首拍，
    // 服务端据此旁路 rAF 门保证静态 closed 内容也有首拍）
    try {
      const hosts = [...document.body.querySelectorAll('*')].filter((el) => window.__xyElbitPred && !el.ownerSVGElement && window.__xyElbitPred(el));
      for (const el of hosts) {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
        out.push({ id: window.__xy.idOf(el), path: window.__xy.pathOf(el), x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height, kind: 'elbit', fresh: !(el.__xyElbitSeen) });
        el.__xyElbitSeen = 1;
        if (out.length >= 6) break;
      }
    } catch (e) {}
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
    // 返回画面是否变化；opts.elbit=true 时变化后 nextAt ≥500ms（v0.28 声明式
    // closed 宿主节流——120ms 全页截图在重应用上打满 CPU，实测 Vikunja 卡死）
    record(key, sig, now, opts) {
      const st = sigs.get(key);
      if (sig && st && st.w === sig.w && st.h === sig.h && st.data.equals(sig.data)) {
        st.unchanged++;
        st.nextAt = now + Math.min(3600, 450 * Math.pow(2, st.unchanged));
        return false;
      }
      const floor = (opts && opts.elbit) ? now + 500 : 0;
      if (sig) sigs.set(key, { ...sig, unchanged: 0, nextAt: floor });
      else if (st) { st.unchanged = 0; st.nextAt = floor; }
      return true;
    },
  };
}

module.exports = { listCanvases, createCanvasSigs };
