'use strict';
// 注入到受保护页面的辅助函数（在 Chromium 页面内执行）。
// 序列化 = 剥离 script/事件属性 + canvas→位图兜底 + 静态资源 URL 重写(/m 代理) ；路径 = 基于 body 的元素 children 索引
function pageHelpers(config) {
return `(() => {
  // 滚动同步钩子（v3 事件驱动，替代帧差分通道）：页面/内部容器的任何滚动
  // 都以 80ms 节流上报（capture 能收到不冒泡的内层滚动）。必须放在 __xy 守卫
  // 之前——导航后重注入helpers时 __xy 已存在会提前 return，钩子会丢。
  if (!window.__xyScrollHooked) {
    window.__xyScrollHooked = true;
    let __xyLastPing = 0;
    const ping = (force) => {
      const now = Date.now();
      if (!force && now - __xyLastPing < 80) return;
      // 回声抑制：服务端镜像客户端上报的滚动时（__xyMirroring 窗口内），
      // 镜像写入触发的滚动事件不再回推（否则 ~RTT 后把自己拽回旧位置）
      if (!force && Date.now() - (window.__xyMirroring || 0) < 250) return;
      __xyLastPing = now;
      try { window.__xyScrollPing({ sx: Math.round(window.scrollX), sy: Math.round(window.scrollY), scrollers: (window.__xy ? window.__xy.scrollers() : []) }); } catch (e) {}
    };
    window.addEventListener('scroll', () => ping(false), true);
    window.__xyScrollPingNow = ping;
  }
  // rAF 活动计数（canvas 捕获门）：动画循环完全停转 = 页面静止，
  // canvas 不可能变化 → 零捕获。典型渲染循环即使画面不变也持续 rAF，
  // 计数只作"完全停转"的判零依据（不停转的静止画面走指数退避）。
  if (!window.__xyRafWrapped) {
    window.__xyRafWrapped = true;
    window.__xyRafCount = 0;
    const origRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => origRaf((t) => { window.__xyRafCount++; try { cb(t); } catch (e) {} });
  }
  // Shadow DOM（v0.14）：patch attachShadow——注入之后新创建的组件影子根也能被
  // 观察与序列化（变化并入现有补丁通道）。必须放在 __xy 守卫之前（重注入时守卫
  // 会提前 return，patch 只需装一次）。closed 影子根只观察，序列化仅覆盖 open。
  if (!window.__xyShadowPatched) {
    window.__xyShadowPatched = true;
    const origAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const sr = origAttach.call(this, init);
      try { if (sr && window.__xyObserveShadow) window.__xyObserveShadow(sr); } catch (e) {}
      return sr;
    };
  }
  // 同源 iframe（v0.14）：capture 捕获 iframe load（load 不冒泡但 capture 可见），
  // 新文档就绪即挂 observer——否则注入后导航/新建的 iframe 内容变化不可见。
  if (!window.__xyIframeHooked) {
    window.__xyIframeHooked = true;
    window.addEventListener('load', (e) => {
      const t = e.target;
      if (t && t.tagName === 'IFRAME' && window.__xyObserveIframe) {
        try { window.__xyObserveIframe(t); } catch (err) {}
      }
    }, true);
  }
  // canvas 2D 指令流（v0.14）：patch getContext——注入之后创建的 2d 上下文走
  // 绘制指令记录与远端重放（带宽远低于位图轮询，任意 DPR 清晰）。注入前已创建
  // 的上下文无法拦截，连同不可序列化参数（跨域图源/Path2D/滤镜）的画布一并回退
  // 到现有位图捕获。WebGL 始终走位图。必须在 __xy 守卫之前（patch 只装一次）。
  if (!window.__xyCanvasPatched && ${config.canvasStream ? 'true' : 'false'}) {
    window.__xyCanvasPatched = true;
    const XY_DRAW_METHODS = new Set(['clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'rect', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke', 'clip', 'save', 'restore', 'translate', 'rotate', 'scale', 'setTransform', 'transform', 'drawImage', 'fillText', 'strokeText', 'setLineDash', 'roundRect', 'putImageData', 'createLinearGradient', 'createRadialGradient', 'createPattern']);
    const XY_SET_PROPS = new Set(['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'globalAlpha', 'globalCompositeOperation', 'textAlign', 'textBaseline', 'lineJoin', 'lineCap', 'miterLimit', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'lineDashOffset', 'direction', 'imageSmoothingEnabled']);
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      const ctx = origGetContext.call(this, type, attrs);
      try {
        // v0.37 上下文类型记录：WebGL 族（无 preserveDrawingBuffer）合成后
        // 缓冲被清空，toDataURL 读回的是等长空白 PNG——tile 通道必须走截图。
        // 本 patch 经 evaluateOnNewDocument 先于一切页面脚本，覆盖全部上下文
        if (ctx && /webgl|webgpu/i.test(String(type))) this.__xyCtxGL = true;
        else if (ctx && String(type) === '2d') this.__xyCtx2d = true;
        if (type === '2d' && ctx && !ctx.__xyPatched && window.__xy) {
          const canvas = this;
          const gradients = [];
          let pending = [];
          let flushTimer = null;
          // v0.29：指令流字节预算——持续重绘画布（SOC 大屏实测 ~1MB/s 全量指令流）
          // 在预算内走矢量重放（静止零流量），超预算转位图捕获（region clip +
          // 帧差 + 指数退避，带宽封顶）。滚动 10s 窗口，预算 0 = 不限制。
          const OP_BUDGET = ${config.canvasOpsBudget !== 0 ? config.canvasOpsBudget : 0};
          const opWindow = []; // [{t, bytes}]
          const opaque = (why) => { try { canvas.__xyOpaque2d = true; canvas.__xyOpaqueWhy = why; } catch (e) {} };
          const ser = (v, depth) => {
            if (v === null || v === undefined) return v;
            const t2 = typeof v;
            if (t2 === 'number' || t2 === 'boolean' || t2 === 'string') return v;
            if (Array.isArray(v)) return depth > 2 ? (opaque('array-depth'), null) : v.map(x => ser(x, depth + 1));
            if (v instanceof CanvasGradient) {
              const g = v.__xyG;
              return (g === undefined) ? (opaque('grad-no-id'), null) : '@g' + g;
            }
            if (v instanceof HTMLImageElement || v instanceof HTMLCanvasElement) {
              try {
                if (v instanceof HTMLImageElement) {
                  const src = v.currentSrc || v.src;
                  if (!src || !/^data:|^https?:|^\\//.test(src)) { opaque('img-src'); return null; }
                  if (/^http/.test(src) && v.crossOrigin !== 'anonymous') { opaque('img-crossorigin'); return null; }
                  return { __img: src };
                }
                return { __img: v.toDataURL('image/png') };
              } catch (e) { opaque('img-throw'); return null; }
            }
            if (v instanceof ImageData) {
              try {
                let bin = '';
                const d8 = v.data;
                for (let i = 0; i < d8.length; i += 0x8000) bin += String.fromCharCode.apply(null, d8.subarray(i, i + 0x8000));
                return { __imgd: { w: v.width, h: v.height, b64: btoa(bin) } };
              } catch (e) { opaque('imgd-throw'); return null; }
            }
            opaque('unknown:' + Object.prototype.toString.call(v));
            return null;
          };
          const push = (op) => {
            pending.push(op);
            // 预算翻转后的持续绘制尝试持续续期 hot：定时器驱动（无 rAF）的重绘
            // 画布靠此保持位图捕获不冻结（rAF 门对 hot 画布放行）
            try { if (canvas.__xyOpaque2d && canvas.__xyOpaqueWhy === 'rate-budget') canvas.__xyBudgetHot = Date.now(); } catch (e) {}
            if (!flushTimer) flushTimer = setTimeout(() => {
              flushTimer = null;
              try {
                if (pending.length && window.__xyCanvasOps && !canvas.__xyOpaque2d) {
                  if (OP_BUDGET > 0) {
                    const now = Date.now();
                    opWindow.push({ t: now, bytes: JSON.stringify([{ id: window.__xy.idOf(canvas), reset: canvas.__xyNeedReset ? 1 : undefined, ops: pending }]).length });
                    while (opWindow.length && now - opWindow[0].t > 10000) opWindow.shift();
                    let total = 0;
                    for (const x of opWindow) total += x.bytes;
                    if (total > OP_BUDGET) { canvas.__xyBudgetHot = Date.now(); opaque('rate-budget'); }
                  }
                  // 超预算即停发指令流：位图捕获接管该画布（listCanvases 对
                  // __xyOpaque2d 放行），镜像侧 canvas→img 原位替换后走 tile 通道
                  if (!canvas.__xyOpaque2d) window.__xyCanvasOps([{ id: window.__xy.idOf(canvas), reset: canvas.__xyNeedReset ? 1 : undefined, ops: pending }]);
                }
                canvas.__xyNeedReset = false;
              } catch (e) {}
              pending = [];
            }, 60);
          };
          // 不用 Proxy 包装上下文（原生 brand check/内部路径会崩渲染进程）：
          // 直接在实例上替换绘制方法（bind 原实现，this 恒为原生对象）与
          // 拦截样式属性赋值（实例级访问器遮蔽原型访问器）。
          for (const m of XY_DRAW_METHODS) {
            const orig = ctx[m];
            if (typeof orig !== 'function') continue;
            ctx[m] = function (...args) {
              try {
                if (m === 'createLinearGradient' || m === 'createRadialGradient') {
                  const result = orig.apply(ctx, args);
                  // 渐变定义与色标都作为指令下发（客户端同序重建），返回值携带索引供样式引用
                  const idx = gradients.push({ m, a: args.map(x => ser(x, 0)) }) - 1;
                  push([m].concat(args.map(x => ser(x, 0))));
                  try {
                    result.__xyG = idx;
                    const origACS = result.addColorStop.bind(result);
                    result.addColorStop = function (off, col) {
                      try { push(['__ac', idx, ser(off, 0), ser(col, 0)]); } catch (e) {}
                      return origACS(off, col);
                    };
                  } catch (e) { opaque('grad-expando'); }
                  return result;
                }
                if (m === 'createPattern') {
                  opaque('pattern');
                  return orig.apply(ctx, args);
                }
                push([m].concat(args.map(x => ser(x, 0))));
              } catch (e) {}
              return orig.apply(ctx, args);
            };
          }
          for (const p2 of XY_SET_PROPS) {
            // 样式属性是原型访问器：用原型描述符读写原生值（own defineProperty
            // 遮蔽后不能再 ctx[p2]= 赋值——会递归触发自己的 setter）
            const proto = Object.getPrototypeOf(ctx);
            const d = Object.getOwnPropertyDescriptor(proto, p2) || Object.getOwnPropertyDescriptor(ctx, p2);
            Object.defineProperty(ctx, p2, {
              configurable: true,
              get() { return (d && d.get) ? d.get.call(ctx) : ctx['__xyV_' + p2]; },
              set(value) {
                try { push(['$' + p2, ser(value, 0)]); } catch (e) {}
                if (d && d.set) d.set.call(ctx, value);
                else { ctx['__xyV_' + p2] = value; }
              },
            });
          }
          canvas.__xyStream2d = true;
          canvas.__xyNeedReset = true;
          ctx.__xyPatched = true;
          return ctx;
        }
      } catch (e) {}
      return ctx;
    };
  }
  // 表单控件属性 setter 劫持（v0.17，rrweb 同款技术）：源站 JS 以
  // el.checked = true / el.value = x 直改状态时不产生任何属性变更，
  // MutationObserver 完全不可见——镜像会永久丢失这类状态（全选按钮/过滤器/
  // 程序化回填）。包一层原型 setter：原生赋值照常，随后把 {id,状态} 记入
  // 待发队列（60ms 合并、同节点 last-write-wins），经 __xyPatch 通道下发。
  if (!window.__xyPropPatched) {
    window.__xyPropPatched = true;
    window.__xyPropQ = new Map(); // id -> {id, checked?, value?, sel?}
    const patchProp = (proto, prop, extract) => {
      try {
        const d = Object.getOwnPropertyDescriptor(proto, prop);
        if (!d || !d.set || !d.get) return;
        Object.defineProperty(proto, prop, {
          get: d.get,
          set: function (v) {
            d.set.call(this, v);
            try {
              if (window.__xy && this.isConnected && this.form !== undefined) {
                const st = extract(this);
                if (st) {
                  // extract 可重定向主体（如 option.selected → 所属 select）
                  const owner = st.__idOf || this;
                  delete st.__idOf;
                  const oid = window.__xy.idOf(owner);
                  window.__xyPropQ.set(oid, Object.assign({ id: oid }, st));
                }
              }
            } catch (e) {}
          },
          configurable: true,
          enumerable: d.enumerable,
        });
      } catch (e) {}
    };
    patchProp(window.HTMLInputElement.prototype, 'checked', (el) => (el.type === 'checkbox' || el.type === 'radio') ? { checked: el.checked } : null);
    patchProp(window.HTMLInputElement.prototype, 'value', (el) => ({ value: String(el.value) }));
    patchProp(window.HTMLTextAreaElement.prototype, 'value', (el) => ({ value: String(el.value) }));
    patchProp(window.HTMLSelectElement.prototype, 'value', (el) => ({ value: String(el.value), sel: [...el.selectedOptions].map(o => o.value) }));
    // v0.18：多选的 option.selected 直改同样对 MutationObserver 不可见——劫持后
    // 以其所属 select 为主体入队（镜像端按 sel 数组整体应用）
    patchProp(window.HTMLOptionElement.prototype, 'selected', (el) => {
      const s = el.closest ? el.closest('select') : null;
      if (!s) return null;
      return { __idOf: s, sel: [...s.selectedOptions].map(o => o.value) };
    });
  }
  if (window.__xy) return;
  // 会话源站 origin（pageHelpersFor 按会话替换；多源会话缺省回退只影响绝对地址改写）
  const ORIGIN_PREFIX = "__XY_ORIGIN_PREFIX__";
  // /m 短式只对 ORIGIN_URL 缺省源站成立（proxyAsset 短式固定路由到它）；
  // x-rbi-origin 多源会话下发 /m/o/<b64url(origin)>，proxyAsset 按该段路由到
  // 真实源站（白名单校验），避免把 :82 的资产取到 :81 的源站
  const DEFAULT_PREFIX = "__XY_DEFAULT_PREFIX__";
  const M_BASE = (location.origin === DEFAULT_PREFIX) ? '/m' : '/m/o/' + btoa(location.origin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  // 节点 ID 登记（v0.12）：id 与 DOM 位置解耦——元素移动/插入/删除后 id 不变，
  // 补丁/滚动容器/输入锚点/画布捕获全部按 id 定位。path（children 索引串）在本
  // 版本并行下发作回退，下一版本删除。参考 rrweb Mirror 的双向映射思路重写。
  const XY_ID2NODE = new Map();
  const XY_NODE2ID = new WeakMap();
  let XY_NEXT_ID = 1;
  function idOf(node) {
    if (!node || node.nodeType !== 1) return null;
    let id = XY_NODE2ID.get(node);
    if (id === undefined) { id = XY_NEXT_ID++; XY_NODE2ID.set(node, id); XY_ID2NODE.set(id, node); }
    return id;
  }
  // 源站同源 URL → 网关代理路径。base 缺省按当前文档解析；返回 null 表示不改写
  // （data:/blob:/第三方绝对地址——与历史行为一致，第三方资源客户端直连）
  function toProxyUrl(v, base) {
    if (!v || /^(data:|blob:|#|mailto:|tel:|javascript:|about:)/i.test(v)) return null;
    if (/^\\/\\//.test(v)) return null;
    try {
      const u = new URL(v, base || location.href);
      if (u.origin !== location.origin) return null;
      return M_BASE + u.pathname + u.search;
    } catch (e) { return null; }
  }
  // v0.28 声明式 closed 宿主谓词（stamp 标记与像素捕获清单共用；XY_ELBIT=0 停用）
  // 开关走 config（vm 校验/打包宿主可能无 process 环境）
  const __xyElbitOn = ${config.elbit !== false ? 'true' : 'false'};
  window.__xyElbitPred = __xyElbitOn ? ((el) => {
    try {
      if (!el || el.nodeType !== 1) return false;
      const T = el.tagName;
      if (T === 'CANVAS' || T === 'IMG' || T === 'INPUT' || T === 'TEXTAREA' || T === 'SELECT' || T === 'IFRAME' || T === 'VIDEO' || T === 'AUDIO' || T === 'BR' || T === 'HR') return false;
      // v0.37 SVG 一律原生序列化（矢量直投）：SVG 形状（path/circle…）是叶子
      // 会被位图化——高 DPR 发虚 + 每个图标白烧 tile 捕获。ownerSVGElement
      // 命中所有 SVG 后代；<svg> 本身因有子元素自然不满足
      if (el.ownerSVGElement || T === 'SVG') return false;
      if (el.shadowRoot) return false;
      if (window.__xyClosedRoots && window.__xyClosedRoots.has(el)) return false;
      if (el.children.length || el.textContent.trim()) return false;
      const r = el.getBoundingClientRect();
      // 尺寸窗口：≥16px 的 UI 级盒子；≤3000px 排除虚拟列表 spacer
      if (r.width < 16 || r.height < 16 || r.height > 3000) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      return cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.backgroundImage === 'none' && (cs.borderTopStyle === 'none' || cs.borderTopWidth === '0px');
    } catch (e) { return false; }
  }) : (() => false);
  // v0.37 位图 holdback：canvas 位图槽位（页面绝对坐标+尺寸）→ 最近一帧非空白
  // 位图。源站图表库（ECharts 等）周期性 dispose+reinit：新画布创建到数据绘制
  // 之间有 0.5-2s 空白窗，快照恰落窗内会把"空白位图"烘焙进镜像且 tile 迟到
  // （实测仪表盘大图表反复闪黑）。序列化时空白槽回放上一好帧，真值仍由 tile
  // 通道按 id 后续覆盖（sig 变化即推），显示连续性由本缓存兜底。
  window.__xyCanvasSlotKey = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return Math.round(r.x + window.scrollX) + ',' + Math.round(r.y + window.scrollY) + ',' + Math.round(r.width) + ',' + Math.round(r.height);
    } catch (e) { return null; }
  };
  window.__xyCanvasLastGood = new Map();  // slotKey -> dataURL
  // 空白烘焙槽 → 真值捕获截止时刻。一次性标记会被空白窗第一拍（仍空白）消耗，
  // 图表绘制后 rAF 常已停转→捕获停摆（实测 29s 空洞）。10s 窗口内每拍保持
  // 优先捕获，sig 去重保证不发重复流量
  window.__xyCanvasUrgent = new Map();    // slotKey -> expireTs
  // v0.38 blob: → data: 内联（快照前调用）。预算按页面生命周期累计（导航后
  // 注入脚本重建自然清零）；同一 blob 属性只转换一次（改写后不再是 blob: 前缀）
  window.__xyBlobBudget = { bytes: 0, n: 0 };
  // 观察者级调度：任何携带 blob: 引用的变更（新增节点/属性）200ms 去抖后解析
  // ——append/attrs 直发补丁不走 structBuf flush，flush 级预检覆盖不到它们；
  // 解析改写属性自身产生的变更会经补丁通道自愈重发（终态 data:）
  window.__xyBlobTimer = null;
  window.__xyBlobDebounce = () => {
    if (window.__xyBlobTimer) return;
    window.__xyBlobTimer = setTimeout(() => {
      window.__xyBlobTimer = null;
      try { window.__xyResolveBlobs(); } catch (e) {}
    }, 200);
  };
  window.__xyBlobTouched = (recs) => {
    try {
      for (const r of recs) {
        if (r.type === 'attributes' && (r.attributeName === 'src' || r.attributeName === 'href' || r.attributeName === 'poster')) {
          const v = r.target && r.target.getAttribute && r.target.getAttribute(r.attributeName);
          if (v && v.indexOf('blob:') === 0) { window.__xyBlobDebounce(); return; }
        }
        for (const n of (r.addedNodes || [])) {
          if (n.nodeType === 1 && n.querySelector && n.querySelector('[src^="blob:"], [href^="blob:"], [poster^="blob:"]')) { window.__xyBlobDebounce(); return; }
        }
      }
    } catch (e) {}
  };
  window.__xyResolveBlobs = async () => {
    if (!document.body || window.__xyBlobBudget.n >= 40) return;
    const jobs = [];
    const collect = (root) => {
      try {
        for (const el of root.querySelectorAll('[src^="blob:"], [href^="blob:"], [poster^="blob:"]')) {
          for (const attr of ['src', 'href', 'poster']) {
            const v = el.getAttribute(attr);
            if (v && v.indexOf('blob:') === 0) jobs.push([el, attr, v]);
          }
          if (jobs.length >= 40) return;
        }
      } catch (e) {}
    };
    collect(document.body);
    try { for (const sr of window.__xyShadowRoots ? window.__xyShadowRoots() : []) collect(sr); } catch (e) {}
    for (const [el, attr, v] of jobs) {
      try {
        if (!el.isConnected || el.getAttribute(attr) !== v) continue;
        window.__xyBlobBudget.n++;
        const res = await fetch(v);
        const buf = await res.arrayBuffer();
        // MIME 判定：Response.type 是 basic/cors 元数据不是 MIME（实测踩坑）——
        // blob: 响应的 content-type 头由 Chromium 按 Blob.type 填；缺失按不可
        // 承载处理（保守剥离，绝不盲内联）
        const type = ((res.headers && res.headers.get('content-type')) || '').split(';')[0].toLowerCase();
        const carriable = /^(image|font)\\//.test(type) || type.indexOf('font') >= 0;
        if (!carriable || buf.byteLength > 786432 || window.__xyBlobBudget.bytes + buf.byteLength > 6291456) {
          el.removeAttribute(attr);
          continue;
        }
        window.__xyBlobBudget.bytes += buf.byteLength;
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        el.setAttribute(attr, 'data:' + type + ';base64,' + btoa(bin));
      } catch (e) { try { el.removeAttribute(attr); } catch (e2) {} }
    }
  };
  function fixUrl(v) {
    // v0.36 安全：javascript: 一律剥离（镜像内容视为不可信输入；此前放行 =
    // 客户端 XSS 载体——<a href="javascript:..."> 会在访客域执行）
    if (/^\\s*javascript:/i.test(v || '')) return null; // 模板字面量：\\s 才产出运行时 \s
    if (!v || /^(data:|blob:|#|mailto:|tel:|about:)/i.test(v)) return v;
    if (v.startsWith('//')) return v;
    if (v.startsWith('/')) return M_BASE + v;
    if (v.startsWith(ORIGIN_PREFIX)) return M_BASE + v.slice(ORIGIN_PREFIX.length);
    // 相对路径（pic.png、./a/b.png）：按当前文档解析后走代理——站点静态资源大量
    // 使用相对地址，不改写则客户端按镜像源解析直接 404
    const p = toProxyUrl(v, location.href);
    return p === null ? v : p;
  }
  // srcset/imagesrcset 多候选（"a.png 1x, b.png 2x"）：逐候选改写，描述符保留
  function fixSrcset(v) {
    if (!v) return v;
    return v.split(',').map((part) => {
      const t = part.trim();
      if (!t) return '';
      const sp = t.search(/\s/);
      const u = sp < 0 ? t : t.slice(0, sp);
      const rest = sp < 0 ? '' : t.slice(sp);
      const fixed = fixUrl(u);
      return fixed === u ? t : fixed + rest;
    }).filter(Boolean).join(', ');
  }
  // CSS 文本内 url(...) 改写（字体/背景图）。相对 url() 按其所属样式表地址解析
  // （link 内相对路径相对 css 文件而非页面），随后统一走 /m 代理——否则客户端按
  // 自己的源解析，webfont/背景图 404 回退默认字体，观感即"颜色不一样"。
  // image-set("x.png" 1x) 用引号串而非 url()，二次扫描覆盖（含 -webkit- 前缀）。
  function cssUrlRewrite(cssText, cssBase) {
    let out = String(cssText).replace(/url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/g, (whole, q, u) => {
      const p = toProxyUrl(u, cssBase);
      return p === null ? whole : 'url(' + q + p + q + ')';
    });
    out = out.replace(/(image-set\\(|-webkit-image-set\\()\\s*(['"])([^'"]+)\\2/g, (whole, fn, q, u) => {
      const p = toProxyUrl(u, cssBase);
      return p === null ? whole : fn + ' ' + q + p + q;
    });
    return out;
  }
  // 防抓取编码：文本码点 -> 会话 PUA 置换码点（混淆字体双映射回原字形渲染）。
  // 目标码点在补充平面（0xF0000+），源域全 BMP；域外字符原样透传。
  function encStr(s) {
    const M = window.__xyObfMap;
    if (!M || !s) return s;
    let out = '', hit = false;
    for (let i = 0; i < s.length; i++) {
      const t = M[s.charCodeAt(i)];
      if (t !== undefined) { out += String.fromCodePoint(t); hit = true; }
      else out += s[i];
    }
    return hit ? out : s;
  }
  const REDACT_ATTRIBUTES = new Set(${JSON.stringify(config.redactAttributes)});
  const MASK_INPUT_TYPES = new Set(${JSON.stringify([...config.maskInputTypes])});
  function stripAttributes(el) {
    for (const a of [...el.attributes]) {
      if (REDACT_ATTRIBUTES.has(a.name.toLowerCase())) { el.removeAttribute(a.name); continue; }
      if (/^on/i.test(a.name) || a.name === 'srcdoc' || a.name === 'formaction') { el.removeAttribute(a.name); continue; }
      // 零明文收口：aria-*/title/alt 是纯文本载体（无视觉作用），一并剥离
      if (/^(aria-(label|placeholder|description|roledescription|valuetext)|title|alt)$/i.test(a.name)) { el.removeAttribute(a.name); continue; }
      if (a.name === 'placeholder' && window.__xyObfMap && a.value) {
        try { el.setAttribute('placeholder', encStr(a.value)); } catch (e) {}
        continue;
      }
      if (a.name === 'srcset' || a.name === 'imagesrcset') {
        try { el.setAttribute(a.name, fixSrcset(a.value)); } catch (e) {}
        continue;
      }
      // xlink:href 同为 SVG javascript: 载体，一并处理；fixUrl 返回 null = 剥离
      if (a.name === 'href' || a.name === 'src' || a.name === 'action' || a.name === 'poster' || a.name === 'xlink:href') {
        try {
          const fixed = fixUrl(a.value);
          if (fixed === null) el.removeAttribute(a.name);
          else el.setAttribute(a.name, fixed);
        } catch (e) {}
      }
    }
  }
  function sanitizeData(clone, root = clone) {
    const controls = node => /^(INPUT|TEXTAREA)$/.test(node.tagName) ? [node] : [...node.querySelectorAll('input,textarea')];
    const liveControls = controls(root);
    controls(clone).forEach((control, i) => {
      const live = liveControls[i];
      if (control.tagName === 'TEXTAREA') {
        // v0.15 掩码选项：命中的输入值以等长 * 下发（对齐 hidden/password/file 的
        // 剔除语义；默认关闭，宿主按业务配置）。交互不受影响——客户端本地输入为
        // 真实值，掩码只作用于快照/补丁下发侧
        if (MASK_INPUT_TYPES.has('textarea')) { control.textContent = '*'.repeat(Math.min(32, live.value.length)); return; }
        control.textContent = live.value; return;
      }
      if (['hidden', 'password', 'file'].includes(control.type)) { control.removeAttribute('value'); return; }
      if (control.type !== 'hidden') control.setAttribute('value', MASK_INPUT_TYPES.has(control.type) ? '*'.repeat(Math.min(32, live.value.length)) : live.value);
      if (control.type === 'checkbox' || control.type === 'radio') control.toggleAttribute('checked', live.checked);
    });
    const elements = [...clone.querySelectorAll('*')];
    if (clone.nodeType === 1) elements.push(clone);
    for (const el of elements) for (const name of REDACT_ATTRIBUTES) el.removeAttribute(name);
  }
  function sanitizeClone(root) {
    // ShadowRoot 不能直接 cloneNode（Chromium 抛错，且 cloneNode 不复制影子子树）：
    // 逐子节点克隆成 fragment；live 查询（selects/controls/canvas）仍走原 root
    const clone = (root.nodeType === 11)
      ? (() => { const f = document.createDocumentFragment(); for (const c of root.childNodes) f.appendChild(c.cloneNode(true)); return f; })()
      : root.cloneNode(true);
    // 注释不参与元素路径，直接删除，避免下发非展示内容。
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach(node => node.remove());
    // selected 是运行时属性，innerHTML 不会自动带上；显式写回选中状态。
    const liveSelects = root.tagName === 'SELECT' ? [root] : [...root.querySelectorAll('select')];
    const cloneSelects = clone.tagName === 'SELECT' ? [clone] : [...clone.querySelectorAll('select')];
    cloneSelects.forEach((select, i) => {
      [...select.options].forEach((option, j) => option.toggleAttribute('selected', liveSelects[i].options[j].selected));
    });
    sanitizeData(clone, root);
    if (clone.querySelectorAll) {
      clone.querySelectorAll('script,noscript,template').forEach(n => n.remove());
      clone.querySelectorAll('*').forEach(stripAttributes);
    }
    if (clone.nodeType === 1) stripAttributes(clone);
    // 文本节点编码。TEXTAREA 跳过：输入框值是明文（客户端原样回传源站，编码会污染
    // 输入链路），靠字体端原码点保留渲染照常；STYLE 跳过：CSS 不可编码。
    if (window.__xyObfMap) {
      const walk = (node) => {
        for (const c of node.childNodes) {
          if (c.nodeType === 3) {
            if (node.tagName !== 'TEXTAREA' && node.tagName !== 'STYLE' && c.nodeValue && /[\\u3000-\\u9fff\\uff00-\\uffef]/.test(c.nodeValue)) c.nodeValue = encStr(c.nodeValue);
          } else if (c.nodeType === 1 && c.tagName !== 'TEXTAREA' && c.tagName !== 'STYLE') {
            walk(c);
          }
        }
      };
      walk(clone);
    }
    const liveCanvases = root.nodeType === 1 && root.querySelectorAll ? (root.tagName === 'CANVAS' ? [root] : [...root.querySelectorAll('canvas')]) : (root.nodeType === 11 ? [...root.querySelectorAll('canvas')] : []);
    const cloneCanvases = clone.querySelectorAll ? [...clone.querySelectorAll('canvas')] : [];
    cloneCanvases.forEach((c, i) => {
      // v0.14 指令流画布：镜像保留 <canvas>（带尺寸与标记，客户端重放绘制指令），
      // 位图兜底只覆盖非流画布（注入前创建/不可序列化/WebGL）
      try {
        if (liveCanvases[i] && liveCanvases[i].__xyStream2d && !liveCanvases[i].__xyOpaque2d) {
          c.setAttribute('data-xy-canvas-stream', '1');
          c.setAttribute('width', String(liveCanvases[i].width || 300));
          c.setAttribute('height', String(liveCanvases[i].height || 150));
          return;
        }
      } catch (e) {}
      try {
        const img = document.createElement('img');
        let dataUrl = liveCanvases[i].toDataURL('image/png');
        // v0.37 空白位图 holdback：仅 ≥64×64 的大画布（小画布/闪光灯类允许直出）。
        // 空白启发：PNG dataURL 长度 < 面积×0.06（实测 581×440 空白 5.2K、
        // 成图 78K，分界约 15K）。空白→回放上一好帧并标记 urgent（tile 通道
        // 下一拍强制捕获真值）；非空白→刷新缓存
        const cLive = liveCanvases[i];
        const area = (cLive.width || 300) * (cLive.height || 150);
        const slot = window.__xyCanvasSlotKey(cLive);
        if (area >= 4096 && slot) {
          if (dataUrl.length < area * 0.06) {
            const cached = window.__xyCanvasLastGood.get(slot);
            if (cached) dataUrl = cached;
            window.__xyCanvasUrgent.set(slot, Date.now() + 10000);
          } else {
            window.__xyCanvasLastGood.set(slot, dataUrl);
            if (window.__xyCanvasLastGood.size > 16) {
              const k0 = window.__xyCanvasLastGood.keys().next().value;
              window.__xyCanvasLastGood.delete(k0);
            }
          }
        }
        img.src = dataUrl;
        img.setAttribute('data-xy-canvas', '1');
        // 关键：源站样式表里的 canvas 选择器（如 canvas{display:block}）在镜像中匹配不到 img，
        // 不内联保留原盒子的 display/宽高，inline img 的基线空隙会让后续内容整体偏移（实测 +5px）
        const cs = getComputedStyle(liveCanvases[i]);
        img.style.cssText = 'display:' + cs.display + ';width:' + cs.width + ';height:' + cs.height;
        c.replaceWith(img);
      } catch (e) {}
    });
    // v0.12：镜像元素携带 data-xy-id。克隆树与源站树按同一跳过规则（SCRIPT/
    // NOSCRIPT/TEMPLATE、已删除的注释）并行游走；canvas→img 替换后的 img 占用
    // 原画布的 id（canvas-tile 按 id 找回镜像 img）。文本节点不参与。
    // v0.14：Shadow DOM 内联——源站元素的 open shadowRoot 以声明式
    // <template shadowrootmode="open"> 挂进克隆（客户端重解析时浏览器自动
    // attachShadow 重建影子树，样式/事件原生隔离）；影子子树递归走同一
    // sanitizeClone（嵌套 shadow 由此覆盖）。shadowrootmode 模板在对齐游走中跳过。
    if (root.nodeType === 1 || root.nodeType === 11) {
      try {
        const isShadowTpl = (c) => c.tagName === 'TEMPLATE' && c.hasAttribute && c.hasAttribute('shadowrootmode');
        const liveKids = (p) => [...p.children].filter(c => !XY_SKIP.has(c.tagName.toUpperCase()));
        const cloneKids = (p) => [...p.children].filter(c => !isShadowTpl(c));
        const stamp = (ln, cn) => {
          if (cn.nodeType !== 1 || ln.nodeType !== 1) return;
          try {
            cn.setAttribute('data-xy-id', String(idOf(ln)));
            // v0.28 声明式 closed 宿主：非破坏式标记 + 源站计算尺寸为 min 尺寸
            //（镜像端空 div 高 0，位图背景需要盒子；获得真实内容时客户端清除）。
            // 必须在 stamp 并行游走里做——live/clone 全量数组位序对照会因 clone
            // 剥 script 错位一格（实测 #gap 标记落到 #outer-button）
            try {
              if (window.__xyElbitPred && window.__xyElbitPred(ln)) {
                cn.setAttribute('data-xy-elbit', '1');
                const csE = getComputedStyle(ln);
                const wE = parseFloat(csE.width), hE = parseFloat(csE.height);
                if (Number.isFinite(wE) && wE > 0) cn.style.minWidth = wE + 'px';
                if (Number.isFinite(hE) && hE > 0) cn.style.minHeight = hE + 'px';
              }
            } catch (e) {}
            if (ln.shadowRoot) {
              const t = document.createElement('template');
              t.setAttribute('shadowrootmode', 'open');
              // DocumentFragment 无 innerHTML 属性：过一手临时 div 取序列化
              const d = document.createElement('div');
              d.appendChild(sanitizeClone(ln.shadowRoot));
              t.innerHTML = d.innerHTML;
              cn.prepend(t);
            } else if (window.__xyClosedRoots && window.__xyClosedRoots.has(ln)) {
              // v0.27 closed shadow：early hook（evaluateOnNewDocument）注册表里
              // 的引用（parse 期/注入后 attachShadow({mode:'closed'}) 均覆盖）——
              // 以声明式 shadowrootmode="closed" 内联，客户端重解析重建影子树
              const cr = window.__xyClosedRoots.get(ln);
              const t = document.createElement('template');
              t.setAttribute('shadowrootmode', 'closed');
              const d = document.createElement('div');
              d.appendChild(sanitizeClone(cr));
              t.innerHTML = d.innerHTML;
              cn.prepend(t);
            }
            // 同源 iframe 内联（v0.14）：内容序列化进 srcdoc（剥 script/事件属性
            // 与主文档同一 sanitize；样式随 link/style 进 srcdoc，资源 URL 已由
            // fixUrl 改写为 /m 代理）。跨域/不可访问 → 等尺寸占位块。
            if (ln.tagName === 'IFRAME') {
              let doc = null;
              try { doc = ln.contentDocument; } catch (e) {}
              if (doc && doc.body && doc.readyState !== 'loading') {
                const styles = [...doc.querySelectorAll('style')].map(s2 => s2.textContent).join('\\n');
                const bodyHtml = sanitizeClone(doc.body).outerHTML;
                cn.setAttribute('srcdoc', '<!doctype html><html><head><style>' + styles + '</style></head>' + bodyHtml + '</html>');
              } else if (!doc) {
                // 跨域（访问抛错/返回 null）：v0.25 优先用服务端代理抓取并
                // sanitize 的同源化内容（window.__xyXframe）作为 srcdoc；
                // 无（抓取失败/超限）回退等尺寸占位块
                const xf = (window.__xyXframe && ln.src && window.__xyXframe.has(ln.src)) ? window.__xyXframe.get(ln.src) : null;
                if (xf) {
                  cn.setAttribute('srcdoc', xf);
                } else {
                  // 跨域（访问抛错/返回 null）：占位块保留原盒子尺寸与节点 id
                  try {
                    const r = ln.getBoundingClientRect();
                    const ph = document.createElement('div');
                    ph.setAttribute('data-xy-id', String(idOf(ln)));
                    ph.setAttribute('data-xy-iframe-blocked', '1');
                    ph.style.cssText = 'box-sizing:border-box;border:1px dashed #b9c3d2;background:#f3f6fa;color:#68758c;display:flex;align-items:center;justify-content:center;font:13px sans-serif;min-height:40px;width:' + Math.round(r.width) + 'px;height:' + Math.round(r.height) + 'px';
                    ph.textContent = '跨源内容不转发（占位）';
                    cn.replaceWith(ph);
                  } catch (e) {}
                }
              }
              // 可访问但仍在 loading：本轮不内联，load 事件触发宿主 outer 补丁
            }
          } catch (e) {}
          const lc = liveKids(ln), cc = cloneKids(cn);
          const n = Math.min(lc.length, cc.length);
          for (let i = 0; i < n; i++) stamp(lc[i], cc[i]);
        };
        if (root.nodeType === 1) stamp(root, clone);
        else for (let i = 0; i < Math.min(root.children.length, clone.children.length); i++) stamp(root.children[i], clone.children[i]);
      } catch (e) {}
    }
    return clone;
  }
  // 只按元素编号：HTML 重解析会丢弃空文本、合并相邻文本，不能使用 childNodes。
  const XY_SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE']);
  const pathChildren = (node) => [...node.children].filter(c => !XY_SKIP.has(c.tagName.toUpperCase()));
const FONT_ALIGN = ${config.fontAlign !== false ? 'true' : 'false'}; // v0.35 字体环境对齐开关（顶层作用域）
        function pathOf(node) {
    const parts = [];
    let n = node;
    while (n && n !== document.body) {
      const p = n.parentElement;
      if (!p) return null;
      const index = pathChildren(p).indexOf(n);
      if (index < 0) return null;
      parts.unshift(index);
      n = p;
    }
    return n === document.body ? parts.join('/') : null;
  }
  window.__xy = {
    sanitizeClone, sanitizeData, pathOf, idOf,
    // 内部滚动容器收集：可滚动且 scrollTop/Left>0 的元素（id+偏移；path 为并行
    // 回退字段，下一版本删除）。源站 JS 自动滚动（如聊天自动滚到底）必须同步到
    // 代理，否则代理盒子停在未滚动位置，与瓦片/源站错位（实测流式后气泡整体低 4px）
    scrollers() {
      const out = [];
      try {
        for (const el of document.body.querySelectorAll('*')) {
          if ((el.scrollTop > 0 || el.scrollLeft > 0) && el.scrollHeight > el.clientHeight + 1) {
            const p = pathOf(el);
            if (p !== null) out.push({ id: idOf(el), path: p, top: Math.round(el.scrollTop), left: Math.round(el.scrollLeft) });
            if (out.length > 12) break;
          }
        }
      } catch (e) {}
      return out;
    },
    find(ref) {
      if (typeof ref === 'number') return XY_ID2NODE.get(ref) || null;
      if (ref === '' || ref === undefined || ref === null) return document.body;
      let n = document.body;
      for (const i of String(ref).split('/')) {
        n = pathChildren(n)[+i];
        if (!n) return null;
      }
      return n;
    },
    // v0.37 定点修复：镜像端补丁 id miss 时上报缺失 id，这里对每个缺失节点的
    // 父元素做一次 sanitizeClone 序列化，inner 补丁原位重建——代替全量重同步
    //（实测仪表盘 25s 内 122 次 id miss→3 次全量重建=图表闪黑+每次 2MB）。
    // 父元素过大（>4000 后代）退化为 {full:true} 交由全量兜底
    repairNodes(ids) {
      const out = [];
      try {
        for (const id of (ids || []).slice(0, 12)) {
          try {
            const el = XY_ID2NODE.get(id);
            if (!el || !el.parentElement || !el.parentElement.parentElement) continue;
            const parent = el.parentElement;
            if (parent === document.documentElement || parent === document.body && parent.querySelectorAll('*').length > 4000) { out.push({ full: true }); break; }
            const clone = sanitizeClone(parent);
            out.push({ id: idOf(parent), inner: clone.innerHTML });
            if (out.length >= 6) break;
          } catch (e) {}
        }
      } catch (e) {}
      return out;
    },
    // Shadow DOM 观察（v0.14）：MutationObserver 的 subtree 不穿透 shadow 边界，
    // 每个影子根挂独立 observer，变化并入同一补丁通道（patchOf 上溯宿主）。
    // attachShadow patch（见文件头）负责注入之后新建的影子根；这里在每次
    // 快照/导航时全量兜底收集已存在的影子根（含嵌套）。
    observeShadow(sr) {
      try {
        if (!sr || sr.__xyObs) return;
        const obs = new MutationObserver((recs) => {
          try { window.__xyBlobTouched(recs); } catch (e) {}
          const out = [];
          for (const r of recs) { try { const p2 = window.__xy.patchOf(r); if (p2) out.push(p2); } catch (e) {} }
          if (out.length) window.__xyPatch(out);
        });
        obs.observe(sr, { subtree: true, childList: true, attributes: true, characterData: true });
        sr.__xyObs = obs;
      } catch (e) {}
    },
    observeShadows() {
      try {
        const stack = [document.body];
        while (stack.length) {
          const n = stack.pop();
          if (!n || !n.querySelectorAll) continue;
          for (const el of n.querySelectorAll('*')) {
            if (el.shadowRoot) { window.__xy.observeShadow(el.shadowRoot); stack.push(el.shadowRoot); }
          }
        }
        // v0.27 closed root：early hook 注册表里的 parse 期条目补挂 observer
        //（内容变更经 patchOf 上溯宿主 → 宿主 outer 重序列化（注册表取内容））
        try {
          for (const it of (window.__xyClosedList || [])) {
            if (it.host && it.host.isConnected && it.root) window.__xy.observeShadow(it.root);
          }
        } catch (e) {}
      } catch (e) {}
    },
    // 同源 iframe 文档观察（v0.14）：load 事件（window capture 钩子）后挂 observer；
    // 内容变更经 patchOf 上溯到 frameElement（宿主 iframe）发 outer 补丁。
    observeIframe(iframeEl) {
      try {
        const doc = iframeEl && iframeEl.contentDocument;
        if (!doc || !doc.documentElement || doc.__xyObs) return;
        const obs = new MutationObserver((recs) => {
          try { window.__xyBlobTouched(recs); } catch (e) {}
          const out = [];
          for (const r of recs) { try { const p2 = window.__xy.patchOf(r); if (p2) out.push(p2); } catch (e) {} }
          if (out.length) window.__xyPatch(out);
        });
        obs.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        doc.__xyObs = obs;
      } catch (e) {}
    },
    observeIframes() {
      try {
        for (const f of document.body.querySelectorAll('iframe')) window.__xy.observeIframe(f);
      } catch (e) {}
    },
    // 递归收集（穿透 open shadow root）：canvas 捕获等按元素查询的通道
    allDeep(root, selector) {
      const out = [];
      try {
        const stack = [root];
        while (stack.length) {
          const n = stack.pop();
          if (!n || !n.querySelectorAll) continue;
          out.push(...n.querySelectorAll(selector));
          for (const el of n.querySelectorAll('*')) if (el.shadowRoot) stack.push(el.shadowRoot);
        }
      } catch (e) {}
      return out;
    },
    // v4 真文本快照：镜像 DOM 携带真实文本，客户端用源站同款 CSS/字体本地渲染
    // ——布局/动画/悬停/打字/图标全部原生，与服务端渲染零耦合（构造性一致）。
    // 快照零截图：开销与页面复杂度解耦（此前 4000 元素页瓦片级联 3 秒的根源）。
    // 防抓取不靠像素化：由编码层（字体混淆，后续挂载）承担。
    async snapshotReal(wantFrame) {
      const DPR = window.__xyDpr || 1;
      // v0.38 blob: 资源内联：blob 是会话浏览器内存对象，URL 下发到访客端必然
      // 加载失败（news.qq.com 实测 "Not allowed to load local resource"）——
      // 快照前把 src/href/poster 上的 blob 转成 data:（image/font 且 ≤768KB、
      // 页面累计 ≤6MB；超限/不可承载类型剥离——客户端本来就渲染不出）。
      // 800ms 硬超时：请求拦截环境里 blob fetch 可能悬挂，内联是增益不是门槛
      try { await Promise.race([window.__xyResolveBlobs(), new Promise((r2) => setTimeout(r2, 800))]); } catch (e) {}
      const clone = sanitizeClone(document.body);
      // v0.16：样式表按文档顺序收集（此前 style 全部前置 + link 后置会翻转
      // 同特异性规则的级联胜负——运行时注入的 <style> 覆盖被 <link> 反杀）；
      // adopted 样式表按规范排在其余作者样式之后。每段 url() 就地改写为 /m
      // 代理（相对地址按所属样式表解析），字体/背景图在客户端不再 404 回退。
      const cssNodes = [...document.querySelectorAll('style, link[rel="stylesheet"]')];
      const linkTexts = await Promise.all(cssNodes.map((n) => {
        if (n.tagName !== 'LINK') return Promise.resolve(null);
        const h = n.getAttribute('href');
        if (!h) return Promise.resolve('');
        return fetch(h).then(r => r.ok ? r.text() : '').catch((e) => { console.warn('[snapcss] fetch fail', h, String(e).slice(0, 60)); return ''; });
      }));
      // v0.17：同源 @import 服务端递归内联（深度 ≤3，防环）——镜像首帧样式完整，
      // 客户端无需二次往返拉 import（跨源 @import 原样保留，第三方直连策略一致）
      const cssInlineImports = async (text, base, depth) => {
        if (depth > 3 || text.indexOf('@import') < 0) return text;
        const re = /@import\\s+(?:url\\(\\s*)?['"]?([^'")\\s;]+)['"]?\\s*\\)?\\s*(?:[a-z/()*\\s,\\-]+)?;/g;
        let m;
        const jobs = [];
        while ((m = re.exec(text))) {
          let abs = null;
          try { abs = new URL(m[1], base).href; } catch (e) {}
          if (abs && new URL(abs).origin === location.origin) jobs.push({ whole: m[0], abs });
        }
        for (const j of jobs) {
          const t = await fetch(j.abs).then(r => r.ok ? r.text() : '').catch(() => '');
          const inlined = t ? (await cssInlineImports(t, j.abs, depth + 1)) : '';
          text = text.replace(j.whole, inlined);
        }
        return text;
      };
      const cssParts = [];
      let styleLen = 0, linkLen = 0;
      for (let i = 0; i < cssNodes.length; i++) {
        const n = cssNodes[i];
        if (n.tagName === 'LINK') {
          const h = n.getAttribute('href') || '';
          const abs = (() => { try { return new URL(h, location.href).href; } catch (e) { return null; } })();
          const t = linkTexts[i] || '';
          linkLen += t.length;
          if (t && abs) cssParts.push(cssUrlRewrite(await cssInlineImports(t, abs, 0), abs));
        } else {
          const t = n.textContent || '';
          styleLen += t.length;
          if (t) cssParts.push(cssUrlRewrite(await cssInlineImports(t, location.href, 0), location.href));
        }
      }
      // v0.15：构造样式表（new CSSStyleSheet + adoptedStyleSheets）——style/link
      // 观察器看不见，快照直接并入规则文本；1Hz 指纹含 adopted 规则数签名
      let adoptedCss = '';
      try {
        for (const sheet of (document.adoptedStyleSheets || [])) {
          try { for (const r of sheet.cssRules) adoptedCss += r.cssText + '\\n'; } catch (e) {}
        }
      } catch (e) {}
      if (adoptedCss) cssParts.push(cssUrlRewrite(adoptedCss, location.href));
      let css = cssParts.join('\\n');
      // v0.35 字体环境对齐（解释权收回）：页面字体栈中的本地系统字体在服务端
      // 容器与访客机器解析为不同物理字体——这是客户端重排布局漂移与字形不一
      // 致的总根。把本地字体名规范化为引擎投递的 Noto Sans SC（/f/noto-*，
      // 与服务端 fontconfig 解析同族同度量），两端同字库 → 排版收敛
      if (FONT_ALIGN) {
        const LOCAL_FONTS = 'PingFang SC|Hiragino Sans GB|Microsoft YaHei|微软雅黑|SimHei|黑体|SimSun|宋体|KaiTi|楷体|Source Han Sans SC|思源黑体|Source Han Serif SC|Noto Sans CJK SC|Noto Serif CJK SC|WenQuanYi[a-zA-Z ]*|Heiti SC|STHeiti|LiHei Pro|SF Pro (?:Text|Display)|Helvetica Neue|Segoe UI|Roboto|Ubuntu|Cantarell|system-ui|apple-system|BlinkMacSystemFont';
        const famRe = new RegExp('(["\\\'\\"]?)(' + LOCAL_FONTS + ')\\1', 'i');
        css = css.replace(/font-family\\s*:\\s*([^;}]+)/gi, function (m0, list) {
          const parts = String(list).split(',');
          const out = [];
          for (let pt of parts) {
            const t = pt.trim();
            if (!t) continue;
            const mm = t.match(/^(['\\\"]?)([^'\\\"]+)\\1$/);
            const name = mm ? mm[2].trim() : t;
            if (famRe.test(name) || name === 'system-ui' || name === '-apple-system' || name === 'BlinkMacSystemFont' || name === 'Segoe UI' || name === 'Roboto' || name === 'Ubuntu' || name === 'Cantarell' || name === 'Helvetica Neue') {
              if (out.indexOf('"Noto Sans SC"') < 0) out.push('"Noto Sans SC"');
            } else if (out.indexOf(pt.trim()) < 0) {
              out.push(pt.trim());
            }
          }
          return 'font-family:' + out.join(', ');
        });
        css += '\\n@font-face{font-family:"Noto Sans SC";font-style:normal;font-weight:400;font-display:block;src:url(/f/noto-regular) format("woff2")}'
          + '\\n@font-face{font-family:"Noto Sans SC";font-style:normal;font-weight:700;font-display:block;src:url(/f/noto-bold) format("woff2")}';
      }
      const hrefs = cssNodes.filter(n => n.tagName === 'LINK').map(l => l.getAttribute('href')).filter(Boolean);
      window.__xyCssDiag = { hrefs, styleLen, linkLen, kf: (css.match(/@keyframes/g) || []).length, at: Date.now(), url: location.pathname };
      let docClass = '', docAttrs = '';
      for (const root of [document.documentElement, document.body]) {
        if (!root) continue;
        const safeRoot = root.cloneNode(false);
        stripAttributes(safeRoot);
        for (const a of safeRoot.attributes || []) {
          if (/^on/i.test(a.name) || a.name === 'style' || a.name === 'id') continue;
          if (a.name === 'class') { docClass += ' ' + a.value; continue; }
          docAttrs += ' ' + a.name + '="' + String(a.value).replace(/"/g, '&quot;') + '"';
        }
      }
      // v0.20：body 继承样式还原——镜像根是 div，源站 body{} 规则不命中，裸元素
      // 此前继承的是"客户端外壳"的字体/颜色（观感偏差与文本度量偏移的
      // 成因之一）。采集 body 的可继承计算样式随快照下发，客户端写进 .xy-body。
      // line-height 特殊处理：计算值是绝对 px，会把源站的"无单位比值"语义压平
      // （14px 子元素源站 1.5×14=21px，pin 24px 后一律 24px → 表单区整体 +3px
      // 漂移，实测 password 输入框 top 462.3→465.3）。还原为比值恢复缩放语义。
      let bodyStyle = '';
      try {
        const bs = getComputedStyle(document.body);
        const parts = [];
        for (const p2 of ['font-family', 'font-size', 'letter-spacing', 'word-spacing', 'color', 'text-align', 'direction', 'white-space']) {
          const v = bs.getPropertyValue(p2);
          if (v) parts.push(p2 + ':' + v);
        }
        const lh = bs.getPropertyValue('line-height');
        const fs = parseFloat(bs.getPropertyValue('font-size'));
        if (lh === 'normal') parts.push('line-height:normal');
        else if (/px$/.test(lh) && fs > 0) parts.push('line-height:' + +(parseFloat(lh) / fs).toFixed(4));
        else if (lh) parts.push('line-height:' + lh);
        bodyStyle = parts.join(';');
      } catch (e) {}
      // frame（显式像素直出）模式：唯一保留截图的地方——整页 PNG 条带
      let frame = null;
      if (wantFrame) {
        const shotB64 = window.__xyFrameShot;
        if (shotB64) {
          const img = new Image();
          img.src = 'data:image/png;base64,' + shotB64;
          await img.decode();
          const sheet = document.createElement('canvas');
          sheet.width = img.width; sheet.height = img.height;
          sheet.getContext('2d').drawImage(img, 0, 0);
          const CAP = 12000;
          const pageH = Math.min(sheet.height / DPR, CAP);
          const bands = [];
          const BH = 512;
          for (let by = 0; by < pageH; by += BH) {
            const bh = Math.min(BH, pageH - by);
            if (bh < 2) break;
            const c3 = document.createElement('canvas');
            c3.width = sheet.width; c3.height = Math.round(bh * DPR);
            c3.getContext('2d').drawImage(sheet, 0, Math.round(by * DPR), sheet.width, c3.height, 0, 0, sheet.width, c3.height);
            bands.push({ w: sheet.width, h: c3.height, cssX: 0, cssY: by, cssW: sheet.width / DPR, cssH: bh, url: c3.toDataURL('image/png') });
          }
          frame = { pageW: sheet.width / DPR, pageH: Math.round(pageH), tiles: bands };
        }
      }
      return { css, html: clone.innerHTML, title: document.title, tiles: [], frame, sx: window.scrollX, sy: window.scrollY, scrollers: window.__xy.scrollers(), docClass: docClass.trim(), docAttrs: docAttrs.trim(), bodyStyle, bodyId: idOf(document.body) };
    },

    // Skia 文字引擎：文本不出现在镜像 DOM（占位符撑布局），文字以"引擎绘制指令"
    // （runs: 文本/坐标/字号/颜色）下发，客户端 CanvasKit(Skia-WASM) 本地任意 DPR 清晰绘制。
    // 零截图：服务端只做 DOM 测量，资源开销与纯 DOM 镜像同级。
    patchOf(record) {
      // 补丁模型：childList/characterData → 目标元素 innerHTML 重发；attributes → 元素 outerHTML 重发
      let target = record.target;
      if (target.nodeType === 3) target = target.parentElement;
      // v0.37 脱离文档的节点不发补丁：图表库 dispose/隐藏容器后仍在离体树上
      // 产出变更（实测 ECharts 隐藏图表 tooltip 周期性触发），镜像端永远没有
      // 这棵子树 → 每拍 id miss（25s 400+ 次）→ 误判漂移引发全量重同步风暴。
      // 离体内容零视觉价值，直接丢弃（ShadowRoot 记录走元素宿主路径过滤）
      if (target && target.nodeType === 1 && target.isConnected === false) return null;
      // v0.37 HEAD 级变更不发补丁：镜像只承载 body 子树（HEAD 由 css/title 通道
      // 保鲜），HEAD 属性补丁在镜像端永久 miss（实测 meta/theme-color 周期写）
      if (target === document.head) return null;
      if (!target || target === document.documentElement) {
        // html 的 class 变更是主题/状态切换（应用会周期性翻转，如在线状态指示）：
        // 走轻量 docClass 补丁直改镜像根类名。若当 full 处理会形成
        // "翻转→全量重同步→再翻转" 的重建风暴（实测内页每秒多次全量快照，
        // 重建窗口吞点击、打断输入）。
        if (target && record.type === 'attributes' && record.attributeName === 'class') {
          return { docClass: REDACT_ATTRIBUTES.has('class') ? '' : target.className };
        }
        return { full: true, why: record.type + ':docEl:' + (record.attributeName || '') + ':' + (target && target.nodeName) };
      }
      // Shadow 内变更（v0.14）：上溯到最外层 light-DOM 宿主，重发宿主 outer——
      // 镜像端整体替换宿主，声明式 template 随重解析重建影子树（嵌套 shadow
      // 由序列化递归覆盖）。innerHTML 替换不会重建已存在的 shadow root。
      try {
        if (typeof target.getRootNode === 'function' && target.getRootNode() !== document) {
          let host = target;
          while (host && typeof host.getRootNode === 'function' && host.getRootNode() !== document) {
            host = host.getRootNode().host;
          }
          if (host && host !== document.body && host.isConnected) {
            const hp = pathOf(host);
            if (hp === null) return { full: true, why: 'shadowHost:noPath' };
            return { path: hp, id: idOf(host), outer: 1 };
          }
        }
      } catch (e) {}
      // 同源 iframe 内变更（v0.14）：上溯 frameElement，重发 iframe outer（新 srcdoc）
      try {
        if (target.ownerDocument && target.ownerDocument !== document) {
          const fe = target.ownerDocument.defaultView && target.ownerDocument.defaultView.frameElement;
          if (fe && fe.isConnected) {
            const fp = pathOf(fe);
            if (fp === null) return { full: true, why: 'iframe:noPath' };
            return { path: fp, id: idOf(fe), outer: 1 };
          }
        }
      } catch (e) {}
      // 快照占位符(data-xy-space)自身的任何变更（含位置校正的 style 属性）都不是业务变更。
      // 实测：②相位给 spacer 写 style 时它还在树上，flush 时已被还原离树——
      // attributes 记录绕过了下面的 childList spacer 过滤，被当成 noPath→full→重同步→
      // 新一轮占位替换又产生同类记录 → 每 tick 自触发全量重同步的死循环（resync 风暴）。
      const isSpacerEl = (n) => n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-xy-space');
      if (isSpacerEl(target)) return null;
      // 已离树的目标无补丁意义（真实的节点增删走父容器 childList 记录，不会丢）
      if (!target.isConnected) return null;
      // 快照自身的占位替换/还原不是业务变更：跳过。否则会用父容器矩形重裁瓦片，
      // 覆盖掉刚下发快照里的正确瓦片（实测 KPI 增量被 88px 裁成 243px、图表面板被重裁覆盖）
      if (record.type === 'childList') {
        const rel = [...(record.addedNodes || []), ...(record.removedNodes || [])];
        const isSpacer = (n) => n && n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-xy-space');
        // 占位替换(text↔span)与还原(span↔原节点)两侧都可能出现 spacer，命中即跳过；
        // 业务真实变更绝不会包含 spacer 节点
        if (rel.length && rel.some(isSpacer)) return null;
      }
      // v0.17 带宽·文本节点级补丁：characterData 变更只发文本本身（此前 inner=
      // 父元素全量 innerHTML——聊天/日志流场景一字节变化发整容器）
      if (record.type === 'characterData' && record.target && record.target.nodeType === 3 && record.target.parentElement) {
        const parent = record.target.parentElement;
        const pid = idOf(parent);
        if (pid !== null) {
          let ti = -1, k = 0;
          for (const c of parent.childNodes) { if (c === record.target) { ti = k; break; } k++; }
          if (ti >= 0) return { id: pid, ti, text: String(record.target.nodeValue == null ? '' : record.target.nodeValue) };
        }
      }
      // v0.17 带宽·追加型补丁：纯末尾追加（聊天/日志/表格流常态）只发新增节点
      // （sanitizeClone 同 inner 路径——剥脚本/改写 URL/盖章 data-xy-id）。
      // 判别"真追加"：同父移动到末尾（appendChild 既有节点）也是 add-only 记录
      // （无 removal），误走捷径会在镜像里复制节点（实测 node-id 回归 move 步骤
      // 旧位置残留）。只有"未登记过的新节点"才允许走追加——已在 ID 注册表里的
      // 节点是移动/回收（React 列表复用），回落 inner 全量保正确性
      if (record.type === 'childList' && record.addedNodes.length > 0 && record.removedNodes.length === 0 && target.nodeType === 1) {
        const hasKnown = [...record.addedNodes].some((n) => n.nodeType === 1 && XY_NODE2ID.has(n));
        const ch = [...target.childNodes];
        const tail = ch.slice(ch.length - record.addedNodes.length);
        const isTail = !hasKnown && tail.length === record.addedNodes.length && tail.every((n, i) => n === record.addedNodes[i]);
        if (isTail) {
          try {
            let html = '';
            for (const n of record.addedNodes) {
              if (n.nodeType === 3) html += String(n.nodeValue == null ? '' : n.nodeValue).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              else if (n.nodeType === 8) continue;
              else html += sanitizeClone(n).outerHTML;
            }
            const aid = idOf(target);
            if (html && aid !== null) return { id: aid, append: html };
          } catch (e) {}
        }
      }
      const path = pathOf(target);
      if (path === null) return { full: true, why: record.type + ':noPath:' + target.nodeName + (target.isConnected ? '' : ':DETACHED') };
      // v3：inner/outer 仅作标记（内容由 tilesPatches 在整页截图后统一 tileize，
      // 此处克隆整段再丢弃是纯浪费）；客户端按 p.inner/p.outer !== undefined 分派。
      // v0.12：补丁携带目标 id（数值），path 并行保留一个版本。
      if (record.type === 'attributes') {
        // v0.29：属性变更走 O(1) attrs 补丁（重应用图表动画 style 每 tick 变更
        // 曾以 outer 全量重发，实测 153KB/tick 居带宽主导）。快路径必须与
        // stripAttributes/sanitizeData 同语义，否则泄漏（data-boundary 实测
        // password value 曾绕过剥离直上 wire）：
        //  1) 表单控件任意属性 → outer（value/checked 语义属 sanitizeData/__xyProp）
        //  2) URL 承载属性 → outer（/m 代理改写、srcset 逐段修复、placeholder 混淆）
        //  3) on*/srcdoc/formaction、零明文载体（aria 文本/title/alt）、redact → 剥离
        //  4) style 内 url(...) 以页面为基改写后直发
        const an = record.attributeName || '';
        const tn = target.tagName;
        if (/^(INPUT|TEXTAREA|SELECT|OPTION|BUTTON)$/.test(tn)) return { path, id: idOf(target), outer: 1 };
        if (/^(src|href|srcset|imagesrcset|poster|action|formaction|data|xlink:href|srcdoc|placeholder)$/i.test(an)) return { path, id: idOf(target), outer: 1 };
        if (/^on/i.test(an) || /^(aria-(label|placeholder|description|roledescription|valuetext)|title|alt)$/i.test(an)) return null;
        try { if (REDACT_ATTRIBUTES.has(an.toLowerCase())) return null; } catch (e) {}
        let av = target.getAttribute(an);
        if (an === 'style' && av) { try { av = cssUrlRewrite(av, location.href); } catch (e) {} }
        return { path, id: idOf(target), attrs: { [an]: av } };
      }
      return { path, id: idOf(target), inner: 1 };
    },
  };
})();`;
}

module.exports = { pageHelpers };
