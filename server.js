'use strict';
/**
 * dom-mirror 可嵌入 DOM 镜像引擎。进程、端口与 Demo 由宿主管理。
 *
 * 两种模式（客户端可运行时切换）：
 *  - dom   : 真文本 DOM 镜像（默认）——服务端序列化 DOM+CSS，客户端原生渲染
 *            （布局/CSS 动画/悬停/输入全部本地 60fps），增量补丁事件驱动，
 *            结构补丁事件驱动；可选字体混淆（PUA 双映射）
 *  - frame : 像素直出兜底——合成器帧驱动差分，整页 PNG 条带下发（无视频编解码）
 *
 * 链路：客户端浏览器 <--WS--> 宿主接入 --CDP--> 无头Chromium --HTTP--> 配置源站
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const puppeteer = require('puppeteer').default;
const { assetUrl, selectOrigin } = require('./lib/policy');
const { SessionStore } = require('./lib/sessions');
const { frameCropInput } = require('./lib/frame-codec');

const { normalizeOptions } = require('./lib/options');
const { createStaticFiles } = require('./lib/static');
const { createTimers } = require('./lib/timers');

function createMirror(options) {
const config = normalizeOptions(options);
const {
  originUrl: ORIGIN_URL, width: VIEW_W, height: VIEW_H,
  maxSessions: MAX_SESSIONS, sessionGraceMs: SESSION_GRACE_MS,
  allowedOrigins: ALLOWED_ORIGINS, defaultMode: DEFAULT_MODE,
} = config;
const UPLOAD_MAX = config.upload.maxBytes;
const UPLOAD_EXTS = new Set(config.upload.extensions);
const DOWNLOAD_MAX = config.download.maxBytes;
const ORIGIN_BASE = new URL(ORIGIN_URL);
const logger = config.logger;
let sharp = null; try { sharp = require('sharp'); } catch (e) { logger.log('[sharp ] unavailable:', e.message); }
const CHROME_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  '--force-color-profile=srgb', '--font-render-hinting=none',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
];
let closed = false;
let closePromise;
const sessionTasks = new Set();
const cleanups = new Set();
const requests = new Set();
function trackRequest(req) {
  requests.add(req);
  req.once('close', () => requests.delete(req));
  return req;
}

// ---------- DOM 镜像：注入到受保护页面的辅助函数 ----------
// 序列化 = 剥离 script/事件属性 + canvas→位图兜底 + 静态资源 URL 重写(/m 代理) ；路径 = 基于 body 的元素 children 索引
const PAGE_HELPERS = `(() => {
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
        if (type === '2d' && ctx && !ctx.__xyPatched && window.__xy) {
          const canvas = this;
          const gradients = [];
          let pending = [];
          let flushTimer = null;
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
            if (!flushTimer) flushTimer = setTimeout(() => {
              flushTimer = null;
              try {
                if (pending.length && window.__xyCanvasOps && !canvas.__xyOpaque2d) window.__xyCanvasOps([{ id: window.__xy.idOf(canvas), reset: canvas.__xyNeedReset ? 1 : undefined, ops: pending }]);
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
  function fixUrl(v) {
    if (!v || /^(data:|blob:|#|mailto:|tel:|javascript:|about:)/i.test(v)) return v;
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
      if (a.name === 'href' || a.name === 'src' || a.name === 'action' || a.name === 'poster') {
        try { el.setAttribute(a.name, fixUrl(a.value)); } catch (e) {}
      }
    }
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
    const controls = node => /^(INPUT|TEXTAREA)$/.test(node.tagName) ? [node] : [...node.querySelectorAll('input,textarea')];
    const liveControls = controls(root);
    controls(clone).forEach((control, i) => {
      const live = liveControls[i];
      if (control.tagName === 'TEXTAREA') {
        // v0.15 掩码选项：命中的输入值以等长 * 下发（对齐 hidden/password/file 的
        // 剔除语义；默认关闭，宿主按业务配置）。交互不受影响——客户端本地输入为
        // 真实值，掩码只作用于快照/补丁下发侧
        if (live.type === 'text' && MASK_INPUT_TYPES.has('textarea')) { control.textContent = '*'.repeat(Math.min(32, live.value.length)); return; }
        control.textContent = live.value; return;
      }
      if (['hidden', 'password', 'file'].includes(control.type)) { control.removeAttribute('value'); return; }
      if (control.type !== 'hidden') control.setAttribute('value', MASK_INPUT_TYPES.has(control.type) ? '*'.repeat(Math.min(32, live.value.length)) : live.value);
      if (control.type === 'checkbox' || control.type === 'radio') control.toggleAttribute('checked', live.checked);
    });
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
        img.src = liveCanvases[i].toDataURL('image/png');
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
            if (ln.shadowRoot) {
              const t = document.createElement('template');
              t.setAttribute('shadowrootmode', 'open');
              // DocumentFragment 无 innerHTML 属性：过一手临时 div 取序列化
              const d = document.createElement('div');
              d.appendChild(sanitizeClone(ln.shadowRoot));
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
    sanitizeClone, pathOf, idOf,
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
    // Shadow DOM 观察（v0.14）：MutationObserver 的 subtree 不穿透 shadow 边界，
    // 每个影子根挂独立 observer，变化并入同一补丁通道（patchOf 上溯宿主）。
    // attachShadow patch（见文件头）负责注入之后新建的影子根；这里在每次
    // 快照/导航时全量兜底收集已存在的影子根（含嵌套）。
    observeShadow(sr) {
      try {
        if (!sr || sr.__xyObs) return;
        const obs = new MutationObserver((recs) => {
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
      } catch (e) {}
    },
    // 同源 iframe 文档观察（v0.14）：load 事件（window capture 钩子）后挂 observer；
    // 内容变更经 patchOf 上溯到 frameElement（宿主 iframe）发 outer 补丁。
    observeIframe(iframeEl) {
      try {
        const doc = iframeEl && iframeEl.contentDocument;
        if (!doc || !doc.documentElement || doc.__xyObs) return;
        const obs = new MutationObserver((recs) => {
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
      const css = cssParts.join('\\n');
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
      if (record.type === 'attributes') return { path, id: idOf(target), outer: 1 };
      return { path, id: idOf(target), inner: 1 };
    },
  };
})();`;
// 会话级 PAGE_HELPERS：按 sessionOrigin 替换源站前缀（多源会话的绝对地址改写与
// /m/o/<b64> 资产下发都依赖它；替换失败时运行态回退仅影响绝对地址）。第二个
// 占位符固定替换为 ORIGIN_URL 缺省源站——短式 /m 只路由到它。
function pageHelpersFor(originPrefix) {
  const esc = JSON.stringify(String(originPrefix)).slice(1, -1);
  return PAGE_HELPERS
    .split('__XY_DEFAULT_PREFIX__').join(JSON.stringify(ORIGIN_BASE.origin).slice(1, -1))
    .split('__XY_ORIGIN_PREFIX__').join(esc);
}

// ---------- 静态文件 ----------
const { sendFile, staticHandler, clear: clearStaticFiles } = createStaticFiles();

// ---------- Chromium：每会话独立实例 ----------
// 共享单例下多标签并发截图会间歇产出错位/幽灵瓦片（像素级实测：瓦片内容与坐标
// 张冠李戴）。使用独立实例；实际容量由宿主按业务测量。
async function launchSessionBrowser() {
  const b = await puppeteer.launch({
    headless: true,
    args: CHROME_ARGS,
    defaultViewport: { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1 },
    ...config.launchOptions,
  });
  b.on('disconnected', () => logger.log('[chrome] session browser disconnected'));
  logger.log('[chrome] per-session launched:', await b.version());
  return b;
}

const KEYMAP = {
  Backspace: 8, Enter: 13, Tab: 9, Escape: 27, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35,
};

// ---------- HTTP + WS ----------
// /m/* —— 扩展名及响应类型受限的静态资源代理，不解析或剔除资源内数据。
// 多源会话（x-rbi-origin 白名单）资产以 /m/o/<b64url(origin)>/path 下发，
// 短式 /m/path 固定路由到 ORIGIN_URL 缺省源站（历史形态，缓存友好）。
const ORIGIN_ALLOWED = new Set([ORIGIN_BASE.origin, ...ALLOWED_ORIGINS.map(x => String(x).replace(/\/+$/, ''))]);
const httpBoth = { http: require('http'), https: require('https') };
const httpOrigin = ORIGIN_BASE.protocol === 'https:' ? httpBoth.https : httpBoth.http;
// /m 代理路径 → 绝对 URL（obf 网站字体下载等 Node 侧消费方使用）；非代理形态原样返回
function unproxyAsset(u) {
  const s = String(u);
  let mo = s.match(/^\/m\/o\/([A-Za-z0-9_-]+)(\/[^\s?#]*)?(\?[^\s#]*)?$/);
  if (mo) {
    let org = ''; try { org = Buffer.from(mo[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return s; }
    return org + (mo[2] || '/') + (mo[3] || '');
  }
  mo = s.match(/^\/m(\/[^\s?#]*)(\?[^\s#]*)?$/);
  if (mo) return ORIGIN_URL.replace(/\/+$/, '') + mo[1] + (mo[2] || '');
  return s;
}
// v0.25 跨源 iframe 同源化：会话作用域资产代理。secret 为每会话随机值（同 obf
// 字体路由的安全模型），注册表只收该会话源站页面实际嵌入过的源——防开放代理/
// SSRF；扩展名与响应类型限制与 /m 一致
const xframeOrigins = new Map(); // secret -> Set(origin)
function proxyXframeAsset(req, res) {
  let rest = req.url.slice(5); // 去 /m/x/
  const mo = rest.match(/^([0-9a-f]{8,64})\/([A-Za-z0-9_-]+)(\/[^\s?#]*)(\?[^\s#]*)?$/);
  if (!mo) { res.writeHead(403); res.end('xframe route'); return; }
  const allowed = xframeOrigins.get(mo[1]);
  let org = '';
  try { org = Buffer.from(mo[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) {}
  if (!allowed || !org || !allowed.has(org)) { res.writeHead(403); res.end('xframe origin'); return; }
  const mod = org.startsWith('https:') ? httpBoth.https : httpBoth.http;
  let base;
  try { base = new URL(org + '/'); } catch (e) { res.writeHead(403); res.end('xframe origin'); return; }
  const u = assetUrl(mo[3] + (mo[4] || ''), base);
  if (!u) { res.writeHead(403); res.end('asset allowlist'); return; }
  const upstream = trackRequest(mod.get(u, { headers: { 'user-agent': 'rbi-mirror-asset', accept: req.headers.accept || '*/*' } }, (up) => {
    const ct = (up.headers['content-type'] || '').toLowerCase();
    if ((up.statusCode || 502) < 200 || (up.statusCode || 502) >= 300 || /text\/html|json|javascript|xml/.test(ct)) {
      up.resume();
      res.writeHead(403); res.end('asset allowlist');
      return;
    }
    res.writeHead(up.statusCode || 502, {
      'content-type': up.headers['content-type'] || 'application/octet-stream',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    });
    up.on('error', () => res.destroy());
    up.pipe(res);
  }));
  upstream.setTimeout(12000, () => upstream.destroy(new Error('asset timeout')));
  upstream.on('error', () => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502); res.end('bad gateway');
  });
}
function proxyAsset(req, res) {
  // 白名单：只代理表现层静态资源（CSS url() 引用的图片/字体等）。
  // 不加白名单时 GET /m/ 可直接拉到源站整页明文（含页面内密钥）——击穿"数据不出站"
  let rest = req.url.slice(2);
  let base = ORIGIN_BASE;
  const mo = rest.match(/^\/o\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (mo) {
    let org = null;
    try { org = new URL(Buffer.from(mo[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (e) {}
    if (!org || !/^https?:$/.test(org.protocol) || !ORIGIN_ALLOWED.has(org.origin)) { res.writeHead(403); res.end('asset origin'); return; }
    base = new URL(org.origin + '/');
    rest = mo[2] || '/';
  }
  const mod = base.protocol === 'https:' ? httpBoth.https : httpBoth.http;
  const u = assetUrl(rest, base);
  if (!u) { res.writeHead(403); res.end('asset allowlist'); return; }
  const upstream = trackRequest(mod.get(u, { headers: { 'user-agent': 'rbi-mirror-asset', accept: req.headers.accept || '*/*' } }, (up) => {
    const ct = (up.headers['content-type'] || '').toLowerCase();
    if ((up.statusCode || 502) < 200 || (up.statusCode || 502) >= 300 || /text\/html|json|javascript|xml/.test(ct)) {
      up.resume();
      res.writeHead(403); res.end('asset allowlist');
      return;
    }
    res.writeHead(up.statusCode || 502, {
      'content-type': up.headers['content-type'] || 'application/octet-stream',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    });
    up.on('error', () => res.destroy());
    up.pipe(res);
  }));
  upstream.setTimeout(12000, () => upstream.destroy(new Error('asset timeout')));
  upstream.on('error', () => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502); res.end('bad gateway');
  });
}

// ---------- 防抓取编码层：字体混淆（会话种子池轮换） ----------
// 原理：镜像文本以 PUA 码点（0xF0000+，随会话种子置换）下发；混淆字体的 cmap 把
// PUA 码点双映射回原字形（原码点保留）——渲染与原生逐位一致（CFF 轮廓原样），
// 但 DOM 文本/复制/爬虫拿到的是乱码。ASCII/西文不混淆（等宽代码块、数字原样），
// 域=CJK 标点(3000-303F)+基本区(4E00-9FFF)+全角(FF00-FFEF)。
// 字体由 tools/build_obf_font.py 在构建期烘焙（种子池 assets/obf/），会话创建即生效
// （零预热）；种子池可扩容，动态按会话构建走同脚本（python3-fonttools）。
const OBF_ON = config.obfuscate;
const OBF_POOL_DIR = path.join(__dirname, 'assets', 'obf');
const OBF_FAMILIES = ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', 'Source Han Sans SC'];
const obfPool = [];
try {
  for (const f of fs.readdirSync(OBF_POOL_DIR).filter(x => /^reg-s\d+\.json$/.test(x)).sort()) {
    const seed = f.match(/s(\d+)\./)[1];
    const permRaw = JSON.parse(fs.readFileSync(path.join(OBF_POOL_DIR, f), 'utf8'));
    const plain = {};
    for (const k of Object.keys(permRaw)) plain[parseInt(k, 16)] = parseInt(permRaw[k], 16);
    obfPool.push({ seed, plain, permJson: path.join(OBF_POOL_DIR, f), reg: path.join(OBF_POOL_DIR, f.replace('.json', '.woff2')), bold: path.join(OBF_POOL_DIR, 'bold-s' + seed + '.woff2') });
  }
  logger.log(`[obf   ] pool: ${obfPool.length} seeds ${OBF_ON ? 'ON' : 'OFF'}${obfPool.length ? '' : '（assets/obf 缺失）'}`);
} catch (e) { logger.log('[obf   ] pool unavailable:', e.message); }
let obfRR = 0;
const obfSessions = new Map();   // sid -> pool entry（含 .siteFonts 网站字体孪生）
const obfFontCache = new Map();  // 文件路径 -> Buffer（LRU≤8，~3-8MB/项）
const obfTwinCache = new Map();  // url|seed -> Buffer（网站字体 PUA 孪生，LRU≤12）
// 下载源站字体文件（同源静态资源，服务端代取）
function obfFetchFont(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    try {
      // 多源会话的网站字体可能跨协议（ORIGIN_URL 与 x-rbi-origin 源不同）
      const mod = String(url).startsWith('https:') ? httpBoth.https : httpBoth.http;
      const req = trackRequest(mod.get(url, { timeout: timeoutMs }, (r) => {
        if ((r.statusCode || 0) >= 400) { r.resume(); resolve(null); return; }
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve(Buffer.concat(chunks)));
        r.on('error', () => resolve(null));
      }));
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch (e) { resolve(null); }
  });
}
// 网站自有字体（艺术字/品牌字/图标字）的 PUA 孪生构建：把会话置换码点追加进
// 网站字体自身的 cmap——被编码的艺术字文本由【网站原字体】渲染，逐位还原。
const { execFile } = require('child_process');
const execFileP = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 20000 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
});
async function buildObfTwin(ent, url) {
  const key = url + '|' + ent.seed;
  if (obfTwinCache.has(key)) return obfTwinCache.get(key);
  const buf = await obfFetchFont(url);
  if (!buf || buf.length < 500) return null;
  const h = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  const src = `/tmp/obf-twin-${h}.src`;
  const out = `/tmp/obf-twin-${h}.woff2`;
  require('fs').writeFileSync(src, buf);
  const r = await execFileP('python3', [path.join(__dirname, 'tools', 'build_obf_twins.py'), src, ent.permJson, out]);
  if (!r.ok || !fs.existsSync(out)) { logger.log('[obf   ] twin build fail:', url.slice(-40), r.stdout.slice(0, 80)); return null; }
  const outBuf = fs.readFileSync(out);
  if (obfTwinCache.size >= 12) obfTwinCache.delete(obfTwinCache.keys().next().value);
  obfTwinCache.set(key, outBuf);
  return outBuf;
}
// 通用兜底字体族（页面 CSS 提取不到时的保险；PUA 专用面只接 U+F0000-10FFFF，
// 对未编码字符零影响——任何站点的明文字符一律走访客本机字体，与原生一致）
const OBF_FAMS_DEFAULT = [
  'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Microsoft YaHei UI', '微软雅黑', '微软雅黑 UI',
  'Noto Sans SC', 'Noto Sans CJK SC', 'Source Han Sans SC', 'Source Han Sans CN', '思源黑体',
  'Segoe UI', 'Helvetica Neue', 'Arial', 'SimHei', 'SimSun', '黑体', '宋体',
  'WenQuanYi Micro Hei', 'Droid Sans Fallback',
];
const OBF_FAM_SKIP = new Set(['inherit', 'initial', 'unset', 'revert', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'ui-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'BlinkMacSystemFont', 'math', 'emoji', 'fangsong', 'STKaiti', 'STSong']);
function nextObfSession() {
  if (!OBF_ON || !obfPool.length) return null;
  const sid = crypto.randomUUID().slice(0, 8);
  const ent = obfPool[obfRR++ % obfPool.length];
  obfSessions.set(sid, ent);
  return { sid, plain: ent.plain };
}
// 从页面 CSS 提取全部 font-family 族名（通用引擎：不写死站点字体栈）
function obfFamiliesFromCss(css) {
  const found = new Set(OBF_FAMS_DEFAULT);
  const re = /font-family\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(css || ''))) {
    for (const raw of m[1].split(',')) {
      const f = raw.trim().replace(/^['"]|['"]$/g, '').trim();
      if (f && f.length <= 48 && !OBF_FAM_SKIP.has(f.toLowerCase()) && !f.startsWith('var(')) found.add(f);
    }
    if (found.size > 90) break;
  }
  return [...found].slice(0, 90);
}
// PUA 专用 @font-face：unicode-range 只接 U+F0000-10FFFF——混淆字体仅渲染被编码的
// 码点，页面其余字符（英文/数字/标点/未编码 CJK）全部走访客本机字体 → 与原生一致。
function obfFacesCss(sid, fams) {
  return fams.map(f =>
    '@font-face{font-family:"' + f + '";src:url(/m/obf/' + sid + '/reg.woff2) format("woff2");font-weight:400;font-display:block;unicode-range:U+F0000-10FFFF}'
    + '@font-face{font-family:"' + f + '";src:url(/m/obf/' + sid + '/bold.woff2) format("woff2");font-weight:700;font-display:block;unicode-range:U+F0000-10FFFF}').join('');
}

function handleRequest(req, res) {
  if (closed) { res.writeHead(503); res.end('mirror closed'); return; }
  if (req.url && req.url.startsWith('/m/obf/')) {
    // 会话混淆字体（池内种子轮换；URL 含会话 id，跨会话不可互换）。
    // site-<i> = 网站自有字体的 PUA 孪生（艺术字逐位还原）
    const mSite = String(req.url).match(/^\/m\/obf\/([0-9a-z-]{4,40})\/site-(\d+)\.woff2$/);
    if (mSite) {
      const ent = obfSessions.get(mSite[1]);
      const sf = ent && ent.siteFonts && ent.siteFonts[+mSite[2]];
      if (!sf) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'private, max-age=3600' });
      res.end(sf.buf);
      return;
    }
    const m2 = String(req.url).match(/^\/m\/obf\/([0-9a-z-]{4,40})\/(reg|bold)\.woff2$/);
    const ent = m2 && obfSessions.get(m2[1]);
    if (!ent) { res.writeHead(404); res.end(); return; }
    let buf = obfFontCache.get(m2[2] === 'bold' ? ent.bold : ent.reg);
    if (!buf) {
      try { buf = fs.readFileSync(m2[2] === 'bold' ? ent.bold : ent.reg); }
      catch (e) { res.writeHead(404); res.end(); return; }
      if (obfFontCache.size >= 8) obfFontCache.delete(obfFontCache.keys().next().value);
      obfFontCache.set(m2[2] === 'bold' ? ent.bold : ent.reg, buf);
    }
    res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=86400, immutable' });
    res.end(buf);
    return;
  }
  // v0.21 RUM 尾包：pagehide 时 sendBeacon('/rum')（text/plain，同源免预检）。
  // 只落日志聚合，不解析内容、无跨源暴露
  if (req.method === 'POST' && String(req.url).split('?')[0] === '/rum') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) { body = body.slice(0, 8192); req.destroy(); } });
    req.on('end', () => {
      try { logger.log('[rum-beacon] ' + body); } catch (e) {}
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    });
    return;
  }
  if (req.url && req.url.startsWith('/m/x/')) return proxyXframeAsset(req, res);
  if (req.url && req.url.startsWith('/m/')) return proxyAsset(req, res);
  if (req.url === '/f/noto-regular' || req.url === '/f/noto-bold') {
    // 与服务端渲染同源的字体下发（WOFF2）：客户端文字度量与像素渲染一致
    // CORS：源站页面（服务端 Chrome 内）注入的 @font-face 会跨源加载这两个文件
    res.setHeader('access-control-allow-origin', '*');
    // 演进：fontconfig TTC(21MB×2) → 提取 SC 单面 OTF → 与 Regular 同覆盖子集 + WOFF2（6.1/10.2MB）
    sendFile(req, res, path.join(__dirname, 'assets', req.url.endsWith('-bold') ? 'NotoSansSC-Bold.woff2' : 'NotoSansSC-Regular.woff2'),
      'font/woff2', 'public, max-age=86400, immutable');
    return;
  }
  return staticHandler(path.join(__dirname, 'client'))(req, res);
}
// permessage-deflate：JSON 快照/补丁文本高度重复，deflate 通常 5-10× 缩减
// （阈值 512B，小帧不压省 CPU）；浏览器 WS 客户端普遍支持，握手透明协商
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: { threshold: 512 } });
const identities = new WeakMap();
function handleUpgrade(req, socket, head) {
  if (closed) { socket.destroy(); return; }
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; }
  catch { socket.destroy(); return; }
  if (pathname !== '/ws') { socket.destroy(); return; }
  if (config.getSessionIdentity) {
    try {
      const identity = config.getSessionIdentity(req);
      if (identity && typeof identity.then === 'function') {
        Promise.resolve(identity).catch(() => {});
        throw new TypeError('getSessionIdentity must be synchronous');
      }
      if (typeof identity !== 'string' || !identity.trim()) throw new TypeError('missing session identity');
      identities.set(req, identity);
    } catch {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
  }
  try { req.rbiOrigin = selectOrigin(req.headers['x-rbi-origin'], ORIGIN_URL, ALLOWED_ORIGINS); }
  catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

// ---------- 会话 ----------
const sessionStore = new SessionStore({ limit: MAX_SESSIONS, graceMs: SESSION_GRACE_MS });
const sessionLifecycles = new WeakMap();
const socketIdentities = new WeakMap();
let sessions = 0;
wss.on('connection', (socket, req) => {
  socketIdentities.set(socket, identities.get(req));
  socket.on('error', () => {});
  const reject = (code) => {
    const messages = {
      SESSION_EXPIRED: '会话已过期或不可恢复，请核对上次提交结果后重新开始',
      SESSION_BUSY: '原连接尚未释放，正在重试',
      SESSION_LIMIT: '会话已满，请稍后重试',
      INVALID_HANDSHAKE: '连接握手无效，请重新开始',
    };
    const terminal = code === 'SESSION_EXPIRED' || code === 'INVALID_HANDSHAKE';
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'error', code, terminal, msg: messages[code] }));
    socket.close(terminal ? 1008 : 1013);
  };
  const timer = setTimeout(() => reject('INVALID_HANDSHAKE'), 3000);
  socket.once('close', () => clearTimeout(timer));
  socket.once('message', raw => {
    clearTimeout(timer);
    if (closed || socket.readyState !== 1) return;
    let hello;
    try { hello = JSON.parse(raw.toString()); } catch { reject('INVALID_HANDSHAKE'); return; }
    if (!hello || hello.type !== 'hello') { reject('INVALID_HANDSHAKE'); return; }
    const scope = JSON.stringify([req.rbiOrigin || ORIGIN_URL, req.headers.origin || '', identities.get(req) ?? null]);
    let claimed;
    try { claimed = sessionStore.claim(hello.resume, scope, socket); }
    catch (error) { reject(error.message); return; }
    const { session, resumed } = claimed;
    if (!resumed) wss.emit('session', session, req);
    session.send(JSON.stringify({ type: 'session', token: session.token, resumed, graceMs: SESSION_GRACE_MS }));
    session.emit('message', raw);
    if (resumed) session.emit('resume');
  });
});
wss.on('session', (ws, req) => {
  const lifecycle = { identity: identities.get(req) };
  sessionLifecycles.set(ws, lifecycle);
  const task = runSession(ws, req, lifecycle);
  lifecycle.task = task;
  sessionTasks.add(task);
  task.finally(() => sessionTasks.delete(task)).catch(error => logger.log('[sess  ] setup failed:', error.message));
});
async function runSession(ws, req, lifecycle) {
  const timers = createTimers();
  const { setTimeout, clearTimeout, setInterval, clearInterval } = timers;
  sessions++;
  logger.log(`[sess  ] open (${sessions}/${MAX_SESSIONS})`);

  let page = null, cdp = null, mode = DEFAULT_MODE;
  let sessionBrowser = null;
  const obfSess = nextObfSession(); // 防抓取字体混淆（dom 模式启用；无池则 null 透明降级）
  let lastInputAt = 0, inputLatMs = null, frameTimes = [], statTimer = null;
  // v0.13 文件传输：会话临时目录（上传暂存/下载落地），会话结束即删除
  let sessionUploadDir = null, sessionDownloadDir = null;
  let browserCdpDetached = null;
  const sessionUploads = new Map();   // tid -> {name,size,got,chunks,fid}
  const sessionDownloads = new Map(); // guid -> {name,received}

  const sendJson = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

  // 逻辑会话终止时清理；普通 WS 断线由 SessionStore 保留到恢复或过期。
  // setup 期间也要登记清理，避免浏览器晚启动后泄漏。
  let dead = false;
  let helloIv = null;
  let lastCssSig = null; // 样式表集合指纹（1Hz 兜底比对；每次全量快照后置 null 重定基线）
  let lastCssSent = null; // v0.17 带宽：最近一次快照下发 css（相同则省略；hello/恢复后置 null 必发全量）
  let driftStreak = 0, lastDriftHeal = 0; // v0.18 分歧自愈：连续漂移计数与限频
  let xframeSecret = null; // v0.25 跨源 iframe 资产代理的会话作用域密钥
  let xframeTimer = null; // v0.26 跨源 iframe 周期刷新（变化推 outer 补丁）
  let cleanupPromise;
  let cancelHello = () => {};
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    dead = true;
    cancelHello();
    timers.clear();
    cleanupPromise = (async () => {
      sessions--;
      if (obfSess) obfSessions.delete(obfSess.sid);
      if (xframeSecret) xframeOrigins.delete(xframeSecret);
      if (xframeTimer) { clearInterval(xframeTimer); xframeTimer = null; }
      domActive = false;
      await Promise.allSettled([page?.close(), sessionBrowser?.close()]);
      sessionUploads.clear();
      sessionDownloads.clear();
      if (browserCdpDetached) browserCdpDetached();
      await Promise.allSettled([
        sessionUploadDir ? fsp.rm(sessionUploadDir, { recursive: true, force: true }) : null,
        sessionDownloadDir ? fsp.rm(sessionDownloadDir, { recursive: true, force: true }) : null,
      ]);
      logger.log(`[sess  ] close (${sessions}/${MAX_SESSIONS})`);
    })();
    cleanupPromise.finally(() => cleanups.delete(cleanup)).catch(() => {});
    return cleanupPromise;
  };
  cleanups.add(cleanup);
  lifecycle.cleanup = cleanup;
  ws.on('close', cleanup);
  ws.on('error', () => {});

  // 会话源站：WAF proxy-endpoint 转发时注入 x-rbi-origin（受信内网头）；直连演示用 ORIGIN_URL
  const sessionOrigin = req.rbiOrigin || ORIGIN_URL;
    let sessHelpers;
    try { sessHelpers = pageHelpersFor(new URL(sessionOrigin).origin); }
    catch (e) { sessHelpers = pageHelpersFor(ORIGIN_BASE.origin); }
    logger.log('[sess  ] origin =', sessionOrigin);
    let prodMode = (sessionOrigin !== ORIGIN_URL) || config.presentation === 'embedded'; // 网关模式/专用实例：访客端隐藏演示壳，只呈现业务页面

  // 交互后的节流全量重同步定时器
  let domResyncTimer = null;
  // 动画/悬停跟随：脏区域差分循环（仅 frame 模式）
  let diffTimer = null, diffBusy = false, diffTick = 0;
  // v3 dom 模式：canvas 元素按需捕获 / 结构补丁合并窗 / 滚动同步去重
  let canvasTimer = null;
  let structTimer = null; const structBuf = new Map();
  const lastPatchSent = new Map();
  let lastScrollKey = '';
  let statLastChunks = 0;
  let canvasSigsReset = null; // 全量重同步后 canvas 捕获基准失效（画面已变）
  // 消息队列必须先于一切 await 挂上：ws 库不缓存无监听期间到达的消息，
  // 冷启动（Chrome 拉起数秒）期间的 hello/mode 一旦错过就永久丢失
  const queue = [];
  let dispatchReady = false;
  const handleCommand = async (m) => {
    switch (m.type) {
          case 'ping': {
            sendJson({ type: 'pong', t: m.t });
            // v0.21 RUM：客户端 10s 心跳携带真实会话性能数据（帧时间/交互延迟/
            // 字节分布），落日志聚合（[rum] 行）；sendBeacon 尾包走 POST /rum
            if (m.rum && typeof m.rum === 'object') {
              try { logger.log('[rum] ' + JSON.stringify(m.rum)); } catch (e) {}
            }
            // v0.18：分歧检测（Timelapse/Dolos 思想）——客户端 ping 携带镜像元素
            // 指纹，与源站比对；持续漂移两拍且距上次自愈 >10s → 自动全量重同步。
            // 把"镜像悄悄坏了"变成"自愈+可观测"（sstats 前打一行日志）
            if (m.fp !== undefined && Number.isFinite(m.fp) && mode === 'dom' && domActive && !dead) {
              try {
                const srvFp = await page.evaluate(() => document.body.getElementsByTagName('*').length - document.body.querySelectorAll('script, [data-xy-space]').length);
                const drift = Math.abs(srvFp - m.fp);
                if (drift > Math.max(2, srvFp * 0.02)) {
                  driftStreak++;
                  if (driftStreak >= 2 && Date.now() - lastDriftHeal > 10000) {
                    lastDriftHeal = Date.now();
                    driftStreak = 0;
                    logger.log(`[drift ] self-heal: server=${srvFp} mirror=${m.fp} delta=${drift}`);
                    startDomMirror().catch(() => {});
                  }
                } else driftStreak = 0;
              } catch (e) {}
            }
            break;
          }
          case 'hello': {
            // 会话中 DPR/视口变化（缩放、跨屏、拉窗口）：重新模拟并全量重发瓦片；
            // hello 同时是断线恢复握手——客户端 css 缓存已丢，置空必发全量
            lastCssSent = null;
            const nd = Math.max(1, Math.min(3, parseFloat(m.dpr) || DPR));
            const nw = Math.max(320, Math.min(2560, parseInt(m.w, 10) || viewW));
            const nh = Math.max(240, Math.min(1600, parseInt(m.h, 10) || viewH));
            const changed = (nd !== DPR || nw !== viewW || nh !== viewH) && page;
            DPR = nd; viewW = nw; viewH = nh;
            if (changed) {
              try {
                await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewW, height: viewH, deviceScaleFactor: DPR, mobile: false });
                if (mode === 'dom' || mode === 'frame') await startDomMirror();
                sendJson({ type: 'meta', w: viewW, h: viewH, prod: prodMode });
              } catch (e) {}
            }
            break;
          }
          case 'mode': {
            // dom（真文本镜像，默认）↔ frame（像素直出兜底）双向可切
            const next = ['dom', 'frame'].includes(m.mode) ? m.mode : 'dom';
            // frame → dom：帧差分循环与帧流必须死亡（dom 无帧率不变式）
            if (mode === 'frame' && next !== 'frame') {
              if (diffTimer) { clearInterval(diffTimer); diffTimer = null; }
              cdp.send('Page.stopScreencast').catch(() => {});
            }
            mode = next;
            try {
              await cdp.send('Page.stopScreencast').catch(() => {});
              await startDomMirror();
              sendJson({ type: 'mode', mode });
            } catch (e) {
              sendJson({ type: 'error', msg: `模式 ${next} 启动失败: ${e.message}` });
            }
            break;
          }
          case 'dom': {
            // 客户端镜像 DOM 上的真实交互 → 服务端真实页面元素（v0.12：按 id 定位）
            noteInput();
            if (m.kind === 'click') logger.log('[dbg] dom click ref=' + (m.id !== undefined ? '#' + m.id : m.path));
            const ok = await page.evaluate((kind, ref, value) => {
              let el = window.__xy.find(ref);
              // 镜像里的文字占位符(data-xy-space)与源站文本节点同位：文本节点不能 click，
              // 映射到父元素——真实浏览器里文本上的点击本来就落在父元素
              if (el && el.nodeType === 3) el = el.parentElement;
              if (!el) return false;
              if (kind === 'click') {
                el.click();
                // 真实用户点击会移动焦点；合成 el.click() 不会。不聚焦的话，
                // 后续 CDP 键事件（Enter 发送/提交、Esc、方向键）会落到 body 上，
                // 页面自身的 keydown 监听（如聊天框回车发送）永远收不到。
                // 点击非可聚焦元素时，真实浏览器会把焦点移回 body（原焦点元素失焦）。
                const t = el.tagName;
                const focusable = el.focus && !el.disabled && (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || t === 'BUTTON' || t === 'A' || el.isContentEditable);
                if (focusable) {
                  try { el.focus(); } catch (e) {}
                } else {
                  try { const ae = document.activeElement; if (ae && ae !== document.body && ae.blur) ae.blur(); } catch (e) {}
                }
                return true;
              }
              if (kind === 'ce') {
                // contenteditable 内容同步（v0.17）：客户端本地原生编辑保流畅，内容
                // 整体回传；此处 setInnerHTML + 派发 input，编辑器应用逻辑照常响应。
                // 不派发 change（CE 规范 change 仅失焦），避免框架重复提交。
                try { if (el.focus && !el.disabled) el.focus(); } catch (e) {}
                el.innerHTML = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
              }
              // React/Vue 受控输入：必须用原型原生 setter 改值，否则框架值追踪器忽略
              // 合成 input 事件，state 不更新 → 表单提交的是空值（实测生产站点
              // 键入即焦点（仅 input 事件）：真实浏览器里用户在某字段打字，该字段必为焦点；
              // 同步焦点后，后续 CDP 键事件（Enter 发送/提交、Esc、方向键）才落在正确元素上。
              // change 事件在失焦时触发——此刻聚焦等于"用户刚离开又被拉回"，禁止
              if (kind === 'input') { try { if (el.focus && !el.disabled) el.focus(); } catch (e) {} }
              const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
                : window.HTMLInputElement.prototype;
              const desc = Object.getOwnPropertyDescriptor(proto, 'value');
              if (desc && desc.set) desc.set.call(el, value); else el.value = value;
              el.dispatchEvent(new Event(kind, { bubbles: true }));
              return true;
            }, m.kind, m.id !== undefined ? m.id : m.path, m.kind === 'ce' ? m.html : m.value);
            if (!ok && mode === 'dom') {
              // 防御不变式：失败只做瓦片化全量重同步；明文快照在任何模式下都不下发
              await startDomMirror().catch(() => {});
            }
            // 输入后不再做防抖全量重发：差分循环（140ms）+ 结构补丁已覆盖一切视觉
            // 跟进，而全量重建会吞掉重建窗口内的点击（实测登录按钮点击落在 700ms
            // 防抖重建里被静默丢弃 → 登录"点了没反应"）。结构漂移由元素数指纹兜底。
            break;
          }
          case 'mouse': {
            if (m.action !== 'move') noteInput();
            let mx = m.x, my = m.y;
            // 锚点平移：客户端镜像布局与服务端有偏差（字体度量/宽度差），纯坐标会
            // 点错位置。以按下时的目标元素为锚：服务端实测该元素矩形，与客户端
            // 记录的镜像矩形做同一平移——整个手势期间偏移恒定，滑块/拖放语义成立
            if (m.apath !== undefined && m.apath !== null || m.aid !== undefined && m.aid !== null) {
              const tr = await page.evaluate((ref, ax, ay) => {
                try {
                  let el = window.__xy ? window.__xy.find(ref) : null;
                  if (el && el.nodeType === 3) el = el.parentElement;
                  if (!el || !el.getBoundingClientRect) return null;
                  const r = el.getBoundingClientRect();
                  // v0.14：iframe 内元素的视口坐标是 iframe 坐标系，CDP 派发需要
                  // 主视口坐标——沿 frameElement 链逐层累加 iframe 偏移（嵌套覆盖）
                  let offX = 0, offY = 0;
                  let node = el;
                  while (node && node.ownerDocument && node.ownerDocument !== document) {
                    const fe = node.ownerDocument.defaultView && node.ownerDocument.defaultView.frameElement;
                    if (!fe) break;
                    const fr = fe.getBoundingClientRect();
                    offX += fr.left; offY += fr.top;
                    node = fe;
                  }
                  return { dx: r.left + offX - ax, dy: r.top + offY - ay };
                } catch (e) { return null; }
              }, m.aid !== undefined ? m.aid : m.apath, m.ax, m.ay).catch(() => null);
              if (tr) { mx += tr.dx; my += tr.dy; }
            }
            const common = { x: mx, y: my, button: m.button || 'left' };
            if (m.action === 'move') await cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mouseMoved', buttons: m.buttons || 0 });
            else if (m.action === 'down') await cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mousePressed', clickCount: 1, buttons: 1 });
            else if (m.action === 'up') await cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mouseReleased', clickCount: 1, buttons: 1 });
            else if (m.action === 'wheel') {
              await cdp.send('Input.dispatchMouseEvent', { ...common, type: 'mouseWheel', deltaX: m.dx || 0, deltaY: m.dy || 0 });
            }
            break;
          }
          case 'key': {
            noteInput();
            const k = m.key;
            if (KEYMAP[k]) {
              const args = { type: m.action === 'up' ? 'keyUp' : 'keyDown', key: k, code: k, windowsVirtualKeyCode: KEYMAP[k], nativeVirtualKeyCode: KEYMAP[k] };
              if (m.action !== 'up' && k === 'Enter') args.text = '\r';
              await cdp.send('Input.dispatchKeyEvent', args);
            } else if (m.text) {
              if (m.action !== 'up') await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: m.text, key: m.text, unmodifiedText: m.text });
              else await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: m.text });
            }
            break;
          }
          case 'dnd': {
            // HTML5 拖拽（v0.19）：客户端镜像上 dragstart/over/drop → 源站合成
            // DragEvent（DataTransfer 带 text/plain 载荷，drop 时可读取）。
            // dragover/drop 目标按坐标命中（elementFromPoint），与原生语义一致
            noteInput();
            try {
              await page.evaluate((kind, x, y, id, text, types) => {
                const mk = (t, el) => {
                  const dt = new DataTransfer();
                  if (text !== undefined && text !== null) { try { dt.setData('text/plain', String(text)); } catch (e) {} }
                  const ev = new DragEvent(t, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt });
                  (el || document.body).dispatchEvent(ev);
                  return ev;
                };
                if (kind === 'start') {
                  const el = id !== undefined ? window.__xy.find(id) : document.elementFromPoint(x, y);
                  if (el) mk('dragstart', el);
                } else if (kind === 'over' || kind === 'drop' || kind === 'end') {
                  const el = document.elementFromPoint(x, y) || document.body;
                  mk(kind === 'over' ? 'dragover' : kind === 'drop' ? 'drop' : 'dragend', el);
                }
              }, m.kind, Math.round(m.x || 0), Math.round(m.y || 0), m.id, m.text, m.types).catch(() => {});
            } catch (e) {}
            break;
          }
          case 'touch': {
            // 触摸（v0.19）：客户端 touchstart/move/end → CDP dispatchTouchEvent。
            // 源站按访客真实触点响应（移动端访客的列表滑动/长按等手势语义）
            noteInput();
            try {
              const pts = Array.isArray(m.pts) ? m.pts.map((p) => ({ x: Math.round(p[0]), y: Math.round(p[1] )})) : [];
              const type = m.kind === 'start' ? 'touchStart' : m.kind === 'move' ? 'touchMove' : 'touchEnd';
              const args = { type, touchPoints: pts };
              if (type === 'touchEnd') { args.touchPoints = []; args.releaseTouchPoints = pts; }
              await cdp.send('Input.dispatchTouchEvent', args);
            } catch (e) {}
            break;
          }
          case 'composition': {
            // IME 组合镜像（v0.13）：客户端 compositionstart/update → CDP
            // imeSetComposition 把候选串写进源站焦点字段（远端可见拼音过程）
            noteInput();
            try {
              if (m.id !== undefined || m.path !== undefined) {
                await page.evaluate((ref) => {
                  const el = window.__xy.find(ref);
                  if (el && el.focus && !el.disabled) el.focus();
                }, m.id !== undefined ? m.id : m.path).catch(() => {});
              }
              const text = String(m.text || '');
              const len = [...text].length;
              let s = Math.max(0, Math.min(parseInt(m.s, 10) || 0, len));
              let e = Math.max(s, Math.min(parseInt(m.e, 10) || 0, len));
              await cdp.send('Input.imeSetComposition', { text, selectionStart: s, selectionEnd: e });
            } catch (err) { sendJson({ type: 'error', msg: 'composition failed: ' + err.message }); }
            break;
          }
          case 'composition-commit': {
            // IME 上屏（v0.13）：compositionend → CDP insertText 键入最终文本
            noteInput();
            try {
              if (m.id !== undefined || m.path !== undefined) {
                await page.evaluate((ref) => {
                  const el = window.__xy.find(ref);
                  if (el && el.focus && !el.disabled) el.focus();
                }, m.id !== undefined ? m.id : m.path).catch(() => {});
              }
              await cdp.send('Input.insertText', { text: String(m.text || '') });
            } catch (err) { sendJson({ type: 'error', msg: 'composition commit failed: ' + err.message }); }
            break;
          }
          case 'upload-begin': {
            // 镜像文件上传（v0.13）：客户端 File → WS 分块 → 会话临时目录 →
            // puppeteer uploadFile（DOM.setFileInputFiles）→ 远端 change
            const tid = String(m.tid || '');
            const name = path.basename(String(m.name || ''));
            const size = parseInt(m.size, 10);
            const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
            if (!tid || !name || !ext || !UPLOAD_EXTS.has(ext.toLowerCase())) {
              sendJson({ type: 'upload-accept', tid, ok: false, error: 'extension not allowed' });
              break;
            }
            if (!Number.isFinite(size) || size < 0 || size > UPLOAD_MAX) {
              sendJson({ type: 'upload-accept', tid, ok: false, error: 'size limit ' + UPLOAD_MAX });
              break;
            }
            sessionUploads.set(tid, { name, size, got: 0, chunks: [], fid: m.fid });
            sendJson({ type: 'upload-accept', tid, ok: true, maxChunk: 48 * 1024 });
            break;
          }
          case 'upload-chunk': {
            const st = sessionUploads.get(String(m.tid || ''));
            if (!st) break;
            try {
              const buf = Buffer.from(String(m.b64 || ''), 'base64');
              st.got += buf.length;
              if (st.got > st.size || st.got > UPLOAD_MAX) {
                sessionUploads.delete(m.tid);
                sendJson({ type: 'upload-end', tid: m.tid, ok: false, error: 'size mismatch' });
                break;
              }
              st.chunks.push(buf);
            } catch { sessionUploads.delete(m.tid); }
            break;
          }
          case 'upload-end': {
            const tid = String(m.tid || '');
            const st = sessionUploads.get(tid);
            if (!st) break;
            sessionUploads.delete(tid);
            noteInput();
            try {
              const buf = Buffer.concat(st.chunks);
              if (buf.length !== st.size) throw new Error('size mismatch');
              if (!sessionUploadDir) sessionUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-upload-'));
              // 会话私有目录 + name 已 basename 收口：直接用原文件名，远端页面
              // 读到的 files[0].name 与访客本地选择一致（uuid 前缀会污染业务文件名）
              const fp = path.join(sessionUploadDir, st.name);
              fs.writeFileSync(fp, buf);
              // 按 id 找回源站 file input，CDP 设置文件并触发 change
              const ref = st.fid;
              const handle = await page.evaluateHandle((r) => window.__xy.find(r), ref);
              const el = handle.asElement ? handle.asElement() : null;
              if (!el || !el.uploadFile) { await handle.dispose(); throw new Error('file input not found'); }
              await el.uploadFile(fp);
              await handle.dispose();
              await page.evaluate((r) => {
                const el2 = window.__xy.find(r);
                if (el2) el2.dispatchEvent(new Event('change', { bubbles: true }));
              }, ref).catch(() => {});
              logger.log('[up    ] stored:', st.name, buf.length, 'bytes');
              sendJson({ type: 'upload-end', tid, ok: true, name: st.name, size: buf.length });
            } catch (err) {
              sendJson({ type: 'upload-end', tid, ok: false, error: String(err && err.message || err) });
            }
            break;
          }
          case 'scrolltop':
            await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
            break;
          case 'repaint': {
            // 本地投机孔回落：客户端孔关闭后请求该区域按服务端当前画面重绘
            // （单张瓦片，消除 putImageData 复原与服务端瓦片的竞态）
            noteInput();
            try {
              const shotR = await cdp.send('Page.captureScreenshot', { format: 'png' });
              const tileR = await page.evaluate((b64, x, y, w, h, d) => {
                return new Promise((res) => {
                  const im = new Image();
                  im.onload = () => {
                    const vx = Math.round((x - window.scrollX) * d), vy = Math.round((y - window.scrollY) * d);
                    const vw = Math.min(Math.round(w * d), im.width - vx), vh = Math.min(Math.round(h * d), im.height - vy);
                    if (vw < 1 || vh < 1 || vx < 0 || vy < 0) { res(null); return; }
                    const c = document.createElement('canvas');
                    c.width = vw; c.height = vh;
                    c.getContext('2d').drawImage(im, vx, vy, vw, vh, 0, 0, vw, vh);
                    res({ w: vw, h: vh, cssX: x, cssY: y, cssW: vw / d, cssH: vh / d, url: c.toDataURL('image/png') });
                  };
                  im.onerror = () => res(null);
                  im.src = 'data:image/png;base64,' + b64;
                });
              }, shotR.data, Math.max(0, m.x || 0), Math.max(0, m.y || 0), Math.max(2, m.w || 2), Math.max(2, m.h || 2), DPR).catch(() => null);
              if (tileR && ws.readyState === 1) {
                const pr = JSON.stringify({ type: 'anim-tiles', tiles: [tileR] });
                ws.send(pr);
                ws._bytes = (ws._bytes || 0) + pr.length;
              }
            } catch (e) {}
            break;
          }
          case 'scroll': {
            // v3 dom 模式：客户端本地原生滚动（零延迟），滚动位置上报到服务端——
            // 服务端页面跟到同位置（懒加载/锚点/后续补丁裁剪坐标才正确），
            // 内部滚动容器一并同步
            noteInput();
            await page.evaluate((x, y, inner) => {
              window.__xyMirroring = Date.now(); // 镜像写入窗口：ping 侧不再回推
              try { window.scrollTo(x, y); } catch (e) {}
              for (const s of (inner || [])) {
                try {
                  // v0.12：条目为 {id,top,left}（旧元组 [ref,top,left] 仅在过渡期兼容）
                  const ref = Array.isArray(s) ? s[0] : (s.id !== undefined ? s.id : s.path);
                  const top = Array.isArray(s) ? s[1] : s.top;
                  const left = Array.isArray(s) ? s[2] : s.left;
                  const el = window.__xy ? window.__xy.find(ref) : null;
                  if (el) { el.scrollTop = top; el.scrollLeft = left; }
                } catch (e) {}
              }
            }, m.x || 0, m.y || 0, m.inner || []).catch(() => {});
            // 键同步：服务端镜像后的页面滚动钩子会产出同位置 ping，
            // 去重键先记为本次上报值，避免 RTT 后回拽
            lastScrollKey = (m.x || 0) + ',' + (m.y || 0) + ',' + JSON.stringify(m.inner || []);
            break;
          }
        }
  };
  const handleRaw = async (raw) => {
    if (dead) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    try {
      await handleCommand(m);
    } catch (e) { sendJson({ type: 'error', msg: '事件处理异常: ' + e.message }); }
  };
  let cmdChain = Promise.resolve();
  const enqueue = (raw) => { cmdChain = cmdChain.then(() => handleRaw(raw)).catch(() => {}); };
  ws.on('message', (raw) => { if (dispatchReady) enqueue(raw); else queue.push(Buffer.from(raw)); });
  const noteInput = () => { lastInputAt = Date.now(); };
  ws.on('resume', () => {
    if (!dispatchReady) return; // 初始化中的会话仍由首次快照完成同步
    cmdChain = cmdChain.then(async () => {
      if (dead || ws.readyState !== 1) return;
      if (domStarting) await domStarting;
      sendJson({ type: 'meta', w: viewW, h: viewH, title: await page.title(), maxSessions: MAX_SESSIONS, mode, prod: prodMode });
      structBuf.clear(); lastPatchSent.clear();
      clearTimeout(fullDebounceT); fullDebounceT = null; lastFullDoneAt = 0;
      await startDomMirror();
      sendJson({ type: 'sync-ready' });
    }).catch(() => ws.close(1011, 'resume failed'));
  });


  // ---------- DOM 镜像通道 ----------
  let domActive = false, domExposed = false;
  let DPR = 1;
  let viewW = VIEW_W, viewH = VIEW_H;
  let pendingFrame = null, lastFrameAt = 0, lastFrameAt2 = 0; // 合成器帧回调缓存（编码-解码范式帧源）
  let domStartAt = 0; // 全量快照起点（死锁自愈计时）
  let patchChain = Promise.resolve();

  let domStarting = null;
  // 全链路超时：截图/evaluate 在复杂页面可能挂起（实测 34 秒死锁——domStarting
  // 永真 → 差分循环被 guard 跳过 → 视觉更新全停，直到全量重同步偶然复活）。
  // 所有重操作的 await 必须有超时兜底。
  const withTimeout = (p2, ms, tag2) => Promise.race([
    p2,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + (tag2 || 'op'))), ms)),
  ]);
  let lastFullDoneAt = 0, fullDebounceT = null, pendingFull = false;
  function startDomMirror() {
    if (dead || ws.readyState !== 1) return Promise.resolve();
    // 重入保护：多个调用点（模式切换/交互回退/补丁重同步）可能并发到达；
    // 两个 snapshotTiles 在同一 live 页上交错会让彼此的底板含占位空白。
    // 被吞触发必须补发（pendingFull）：full 补丁（如 head 注入懒加载样式表的
    // noPath:HEAD）到达时若正有快照在飞，直接 return 会把触发消费掉且无人重排
    // ——实测 Assistant css 注入被吞一次后镜像动画样式永久缺失。
    if (domStarting) { pendingFull = true; return domStarting; }
    // 防抖：SPA 登录/路由切换会连发全量触发（head 注入样式 noPath:HEAD、
    // +600/+1500ms 导航重试、补丁 miss 客户端重同步），实测 4 秒内 6 次全量
    // 快照——重建窗口互相吞点击、镜像反复闪旧页。700ms 窗口内合并为一次。
    const since = Date.now() - lastFullDoneAt;
    if (since < 700) {
      if (!fullDebounceT) {
        fullDebounceT = setTimeout(() => { fullDebounceT = null; startDomMirror(); }, 700 - since + 30);
      }
      return Promise.resolve();
    }
    domStartAt = Date.now();
    logger.log('[dbg] startDomMirror <- ' + (new Error().stack.split('\n')[2] || '?').trim().replace(/^at /, ''));
    domStarting = (async () => {
      try { await doStartDomMirror(); }
      finally {
        domStarting = null; lastFullDoneAt = Date.now();
        if (pendingFull) {
          pendingFull = false;
          fullDebounceT = setTimeout(() => { fullDebounceT = null; startDomMirror().catch(() => {}); }, 60);
        }
      }
    })();
    return domStarting;
  }
  async function doStartDomMirror() {
    await page.evaluate(sessHelpers);
    if (obfSess && mode === 'dom') {
      // 编码表注入源站页（sanitizeClone 序列化时置换文本码点）
      await page.evaluate((m) => { window.__xyObfMap = m; }, obfSess.plain).catch(() => {});
    }
    if (!domExposed) {
      await page.exposeFunction('__xyPatch', (patches) => {
        if (!domActive || ws.readyState !== 1) return;
        // 串行化处理，避免并发截图竞态
          patchChain = patchChain.then(async () => {
          try {
          // 轻量主题补丁：html class 变更直改镜像根类名，不进重同步链
          const dcPatch = patches.find(p => p && p.docClass !== undefined);
          if (dcPatch) sendJson({ type: 'doc-class', cls: dcPatch.docClass });
          let rest = patches.filter(p => p && p.docClass === undefined);
          // v0.17：属性补丁（程序化 checked/value）直发，不进结构差分
          const propPatches = rest.filter(p => p.__xyProp);
          if (propPatches.length && domActive && ws.readyState === 1) {
            sendJson({ type: 'dom-props', props: propPatches.map(p => p.__xyProp) });
          }
          rest = rest.filter(p => p.__xyProp === undefined && p.__xySel === undefined && p.text === undefined && p.append === undefined);
          // v0.17：选区补丁单独下发
          const selPatch = patches.find(p => p && p.__xySel);
          if (selPatch && domActive && ws.readyState === 1) sendJson({ type: 'dom-sel', ...selPatch.__xySel });
          // v0.18：焦点同步单独下发
          const focusPatch = patches.find(p => p && p.__xyFocus);
          if (focusPatch && domActive && ws.readyState === 1) sendJson({ type: 'focus-sync', id: focusPatch.__xyFocus.id });
          rest = rest.filter(p => p.__xyFocus === undefined);
          // v0.17 带宽：文本节点级/追加型补丁直发（O(增量) 而非 O(容器)）；
          // 追加先行——同批中文本补丁可能指向刚追加内容的子节点，顺序保证注册先于定位
          const appendPatches = patches.filter(p => p && p.append !== undefined);
          const textPatches = patches.filter(p => p && p.text !== undefined);
          if ((appendPatches.length || textPatches.length) && domActive && ws.readyState === 1) {
            sendJson({ type: 'dom-patches', patches: appendPatches.concat(textPatches) });
          }
          if (!rest.length) return;
            if (rest.some(p => p && p.full)) {
              logger.log('[dbg] full patch why:', patches.filter(p => p && p.full).map(p => p.why || '?').slice(0, 3).join(' | ').slice(0, 200));
              // 全量重同步也必须走瓦片化路径（明文快照在瓦片模式下是防御漏洞）
              await startDomMirror();
              return;
            }
            // v3：dom 与 frame 同路径——结构+瓦片补丁（均零明文）。60ms 合并窗 +
            // 同路径去重（流式回复逐字变更只保留最新态），每批一次整页截图统一
            // tileize。事件驱动：静止页零消息、零流量，不存在任何帧率概念。
            for (const p of rest) {
              if (!p || (p.id === undefined && p.path === undefined)) continue;
              const key = (p.id !== undefined) ? '#' + p.id : p.path;
              // outer 含子树：同目标 outer 与 inner 在合并窗内相遇时保留 outer
              const kind2 = (p.outer !== undefined) ? 'outer' : 'inner';
              if (kind2 === 'inner' && structBuf.get(key) === 'outer') continue;
              structBuf.set(key, kind2);
            }
            if (structTimer) return;
            structTimer = setTimeout(async () => {
              structTimer = null;
              if (dead || ws.readyState !== 1) { structBuf.clear(); return; }
              const batch = [...structBuf.entries()].map(([key, kind2]) => ({ key, [kind2]: 1 }));
              structBuf.clear();
              // 异步兜底：截图超时/导航销毁上下文一旦以 unhandled rejection
              // 冒泡会击穿整个网关进程（Node>=15 默认退出）
              try { await tilesPatches(batch); } catch (e) { logger.log('[patch] batch err:', e && e.message); }
            }, 60);
          } catch (e) {}
        });
      });
      try {
        await page.exposeFunction('__xyScrollPing', (st) => {
          if (!domActive || ws.readyState !== 1 || mode !== 'dom') return;
          const key = st.sx + ',' + st.sy + ',' + JSON.stringify(st.scrollers || []);
          if (key === lastScrollKey) return;
          lastScrollKey = key;
          sendJson({ type: 'scroll-sync', sx: st.sx, sy: st.sy, scrolls: st.scrollers || [] });
        });
      } catch (e) {}
      // v0.14：canvas 2D 指令流上行通道（60ms 合并批量下发 canvas-ops）
      try {
        await page.exposeFunction('__xyCanvasOps', (batches) => {
          if (!domActive || ws.readyState !== 1 || mode !== 'dom') return;
          if (!Array.isArray(batches)) return;
          const payload = JSON.stringify({ type: 'canvas-ops', batches });
          if (payload.length > 512 * 1024) return; // 防御：异常巨批丢弃（正常批 << 64KiB）
          ws.send(payload);
          ws._bytes = (ws._bytes || 0) + payload.length;
          ws._chunks = (ws._chunks || 0) + 1;
        });
      } catch (e) {}
      domExposed = true;
    }
    domActive = true;
    // observer 先挂后拍（关键顺序）：原实现快照之后才挂 observer，快照期间二次
    // 导航（POST→302→落地页）会让快照发出旧内容且新文档上无任何 observer——
    // 该会话从此零补丁零触发（实测 css 永久冻结的一种成因）。先挂可观测窗口
    // 覆盖整个快照期；PAGE_HELPERS 注入加超时防导航竞态悬挂。
    await withTimeout(page.evaluate(sessHelpers), 8000, 'helpers').catch((e) => {
      logger.log('[dom   ] helpers inject fail:', e && e.message);
    });
    await page.evaluate(() => {
      if (window.__xyObs) window.__xyObs.disconnect();
      window.__xyObs = new MutationObserver((recs) => {
        const out = [];
        for (const r of recs) { try { const p2 = window.__xy.patchOf(r); if (p2) out.push(p2); } catch (e) {} }
        if (out.length) window.__xyPatch(out);
      });
      window.__xyObs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      // v0.17：属性 setter 劫持队列（程序化 checked/value 变更）60ms 合并下发
      if (window.__xyPropTimer) clearInterval(window.__xyPropTimer);
      window.__xyPropTimer = setInterval(() => {
        if (!window.__xyPropQ || !window.__xyPropQ.size) return;
        const out = [...window.__xyPropQ.values()];
        window.__xyPropQ.clear();
        window.__xyPatch(out.map((p) => ({ __xyProp: p })));
      }, 60);
      // v0.17：媒体元素状态（播放/暂停/seek/音量/进度）并入同一通道；
      // timeupdate 1s 节流（暂停/seek/音量事件即时）
      if (!window.__xyMediaHooked) {
        window.__xyMediaHooked = true;
        let lastT = 0;
        const mediaPing = (el) => {
          try {
            if (!el || !el.tagName || !/^(VIDEO|AUDIO)$/.test(el.tagName)) return;
            if (!window.__xy || !window.__xyPropQ) return;
            const id = window.__xy.idOf(el);
            if (id === null) return;
            window.__xyPropQ.set(id, { id, media: { paused: el.paused, t: el.currentTime, muted: el.muted, vol: el.volume } });
          } catch (e) {}
        };
        for (const ev of ['play', 'pause', 'seeked', 'volumechange']) window.addEventListener(ev, (e) => mediaPing(e.target), true);
        window.addEventListener('timeupdate', (e) => {
          const now = Date.now();
          if (now - lastT < 1000) return;
          lastT = now;
          mediaPing(e.target);
        }, true);
      }
      // v0.17：选区镜像——selectionchange 150ms 节流。镜像内容在客户端 shadow
      // root 内，文档级 Selection API 无法跨边界设置；改为下发选区矩形
      // （Range.getClientRects + 滚动偏移 → 页面坐标），客户端绝对定位高亮层
      // 呈现（随镜像文档流滚动）。搜索高亮/表格选择类业务由此跟随。
      if (!window.__xySelHooked) {
        window.__xySelHooked = true;
        let selT = null, lastSelKey = '';
        document.addEventListener('selectionchange', () => {
          if (selT) return;
          selT = setTimeout(() => {
            selT = null;
            try {
              const s = document.getSelection();
              if (!s || s.rangeCount === 0 || s.isCollapsed) return;
              const r = s.getRangeAt(0);
              const rects = [];
              for (const rc of r.getClientRects()) {
                if (rects.length >= 200) break;
                if (rc.width < 1 || rc.height < 1) continue;
                rects.push([Math.round(rc.left + window.scrollX), Math.round(rc.top + window.scrollY), Math.round(rc.width), Math.round(rc.height)]);
              }
              if (!rects.length) return;
              const key = JSON.stringify(rects);
              if (key === lastSelKey) return;
              lastSelKey = key;
              window.__xyPatch([{ __xySel: { rects } }]);
            } catch (e) {}
          }, 150);
        });
      }
      // v0.18：焦点同步——源站 JS 聚焦字段（autofocus/校验定位）时镜像跟随光标。
      // 300ms 节流；body/无焦点发 null
      if (!window.__xyFocusHooked) {
        window.__xyFocusHooked = true;
        let fT = null, lastF = undefined;
        const ping = () => {
          fT = null;
          try {
            const ae = document.activeElement;
            const id = (ae && ae !== document.body && ae !== document.documentElement && window.__xy) ? window.__xy.idOf(ae) : null;
            if (id === lastF) return;
            lastF = id;
            window.__xyPatch([{ __xyFocus: { id } }]);
          } catch (e) {}
        };
        window.addEventListener('focusin', () => { if (!fT) fT = setTimeout(ping, 300); }, true);
        window.addEventListener('focusout', () => { if (!fT) fT = setTimeout(ping, 300); }, true);
      }
      // v0.14：现存 shadow root 全量兜底观察（attachShadow patch 覆盖此后新建的）
      if (window.__xy && window.__xy.observeShadows) window.__xy.observeShadows();
      // v0.14：现存同源 iframe 文档观察（load 钩子覆盖此后加载的）
      if (window.__xy && window.__xy.observeIframes) window.__xy.observeIframes();
    }).catch(() => {});
  // v0.26：force=true 重抓既有条目（周期刷新通道）；返回内容发生变化的 url 列表
  async function prepareXframes(force) {
      // v0.26 prepareXframes(force)：跨源 iframe 同源化——服务端代理抓取（无访客凭据，6s/512KB，仅
      // text/html）→ 页内 sanitize（剥 script/事件属性，资产 URL 改写为
      // /m/x/<secret>/<b64(origin)>）→ 存 window.__xyXframe，sanitizeClone 的
      // iframe 分支用它替代占位块。secret 每会话随机；origin 注册表限定"本会话
      // 源站实际嵌入过的源"（防开放代理）。抓取失败保持占位回退
      let xframeChanged = [];
      try {
        const xfCand = await page.evaluate((force) => {
          try {
            if (!window.__xyXframe) window.__xyXframe = new Map();
            const out = [];
            for (const f of document.body.querySelectorAll('iframe')) {
              const s = f.src || '';
              if (!/^https?:/i.test(s)) continue;
              let same = false;
              try { same = new URL(s).origin === location.origin; } catch (e) {}
              if (same || (!force && window.__xyXframe.has(s)) || window.__xyXframe.size >= 16) continue;
              out.push(s);
            }
            return out;
          } catch (e) { return []; }
        }, !!force);
        if (xfCand.length) {
          if (!xframeSecret) {
            xframeSecret = crypto.randomBytes(12).toString('hex');
            if (!xframeOrigins.has(xframeSecret)) xframeOrigins.set(xframeSecret, new Set());
          }
          const origins = xframeOrigins.get(xframeSecret);
          const htmls = [];
          for (const raw of xfCand) {
            try {
              const abs = new URL(raw, sessionOrigin).href;
              const mod = abs.startsWith('https:') ? httpBoth.https : httpBoth.http;
              const html = await new Promise((resolve) => {
                const req = trackRequest(mod.get(abs, { timeout: 6000, headers: { 'user-agent': 'rbi-mirror-xframe', accept: 'text/html' } }, (r) => {
                  const ct = (r.headers['content-type'] || '').toLowerCase();
                  if ((r.statusCode || 502) < 200 || (r.statusCode || 502) >= 300 || !/text\/html/.test(ct)) { r.resume(); resolve(null); return; }
                  let len = 0;
                  const chunks = [];
                  r.on('data', (c) => { len += c.length; if (len > 512 * 1024) { r.destroy(); resolve(null); } else chunks.push(c); });
                  r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                  r.on('error', () => resolve(null));
                }));
                req.on('error', () => resolve(null));
                req.on('timeout', () => { req.destroy(); resolve(null); });
              });
              if (html) { origins.add(new URL(abs).origin); htmls.push({ url: abs, html }); }
            } catch (e) {}
          }
          if (htmls.length) {
            await page.evaluate((list, secret) => {
              const changed = [];
              const XP = '/m/x/' + secret + '/';
              const b64 = (s2) => btoa(s2).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
              for (const item of list) {
                try {
                  const doc = new DOMParser().parseFromString(item.html, 'text/html');
                  doc.querySelectorAll('script, link[rel="preload"], link[rel="prefetch"]').forEach((n2) => n2.remove());
                  const ifrOrigin = new URL(item.url).origin;
                  const toProxy = (v) => {
                    if (!v || /^(data:|blob:|#|mailto:|tel:|javascript:|about:)/i.test(v) || /^\/\//.test('' + v)) return v;
                    try {
                      const abs = new URL(v, item.url);
                      if (abs.origin === ifrOrigin) return XP + b64(ifrOrigin) + abs.pathname + abs.search;
                      return v;
                    } catch (e) { return v; }
                  };
                  for (const el of doc.querySelectorAll('*')) {
                    for (const a of [...el.attributes]) {
                      if (/^on/i.test(a.name) || a.name === 'srcdoc' || a.name === 'formaction' || a.name === 'integrity') { el.removeAttribute(a.name); continue; }
                      if (a.name === 'src' || a.name === 'href' || a.name === 'poster') {
                        try { el.setAttribute(a.name, toProxy(a.value)); } catch (e) {}
                      } else if (a.name === 'srcset') {
                        try { el.setAttribute('srcset', a.value.split(',').map((p2) => { const t2 = p2.trim(); const sp = t2.search(/\s/); const u2 = sp < 0 ? t2 : t2.slice(0, sp); return toProxy(u2) + (sp < 0 ? '' : t2.slice(sp)); }).join(', ')); } catch (e) {}
                      } else if (a.name === 'style') {
                        try { el.setAttribute('style', a.value.replace(/url\((['"]?)([^'")]+)\1\)/g, (w2, q2, u3) => { const p3 = toProxy(u3); return p3 === u3 ? w2 : 'url(' + q2 + p3 + q2 + ')'; })); } catch (e) {}
                      }
                    }
                  }
                  const styles = [...doc.querySelectorAll('style')].map((s3) => s3.textContent).join('\\n');
                  const sd = '<!doctype html><html><head><style>' + styles + '</style></head>' + doc.body.innerHTML + '</html>';
                  const prevSd = window.__xyXframe.get(item.url);
                  window.__xyXframe.set(item.url, sd);
                  if (prevSd !== undefined && prevSd !== sd) changed.push(item.url);
                } catch (e) {}
              }
              return changed;
            }, htmls, xframeSecret).then((ch) => { xframeChanged = ch || []; }).catch(() => {});
          }
        }
      } catch (e) {}
      return xframeChanged;
  }
    // v0.25/0.26：跨源 iframe 同源化内容预取（首拍全量），周期刷新定时器对
    // 变化条目推宿主 outer 补丁（客户端整替 iframe，srcdoc 随新内容到达）
    try { await prepareXframes(false); } catch (e) {}
    if (!xframeTimer) {
      xframeTimer = setInterval(async () => {
        if (mode !== 'dom' || !domActive || dead || !page || ws.readyState !== 1) return;
        try {
          const changed = await prepareXframes(true);
          if (!changed || !changed.length) return;
          const patches = await withTimeout(page.evaluate((urls) => {
            const out = [];
            for (const f of document.body.querySelectorAll('iframe')) {
              if (urls.includes(f.src)) out.push({ id: window.__xy.idOf(f), outer: window.__xy.sanitizeClone(f).outerHTML });
            }
            return out;
          }, changed), 5000, 'xframePush').catch(() => null);
          if (patches && patches.length && ws.readyState === 1) sendJson({ type: 'dom-patches', patches });
        } catch (e) {}
      }, Number(process.env.XFRAME_REFRESH_MS || 15000));
    }
    // v4：dom 快照零截图（文本/输入框外观由客户端原生渲染，字体由源站 CSS 自带）。
    // frame 模式仍需整页截图作条带底板。
    await page.evaluate((d) => { window.__xyDpr = d; }, DPR);
    if (mode === 'frame') {
      try {
        const shotF = await withTimeout(cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }), 8000, 'frameSheet');
        await page.evaluate((b64) => { window.__xyFrameShot = b64; }, shotF.data);
      } catch (e) { await page.evaluate(() => { window.__xyFrameShot = null; }).catch(() => {}); }
    }
    const snap = await withTimeout(page.evaluate((wf) => window.__xy.snapshotReal(wf), mode === 'frame'), 10000, 'snapshot');
    try {
      const diag = await page.evaluate(() => window.__xyCssDiag || null);
      if (diag) logger.log(`[snapcss] ${diag.url} links=${diag.hrefs.length}(${diag.hrefs.map(h => h.split('/').pop()).join(',')}) kf=${diag.kf} cssLen=${diag.styleLen + diag.linkLen}`);
    } catch (e) {}
    try {
      const foc = await page.evaluate(() => document.activeElement ? (document.activeElement.tagName + '#' + (document.activeElement.id || '')) : 'none');
      logger.log('[dom   ] post-snapshot focus:', foc);
    } catch (e) {}
    let siteFaces = '';
    if (obfSess && mode === 'dom') {
      // 网站自有 @font-face（艺术字/品牌字）：解析 family/weight/src 字体 URL，
      // 为每个字体构建 PUA 孪生（构建失败则优雅跳过——该族 PUA 文本落到栈内
      // 后续 MiSans 面，普通黑体渲染而非豆腐）
      const ent = obfSessions.get(obfSess.sid);
      const siteFonts = [];
      const ffRe = /@font-face\s*\{([^}]*)\}/g;
      let fm;
      while ((fm = ffRe.exec(snap.css)) && siteFonts.length < 6) {
        const blk = fm[1];
        const fam = (blk.match(/font-family\s*:\s*['"]?([^;'"]+?)['"]?\s*(?:;|$)/) || [])[1];
        let url = (blk.match(/src\s*:[^;]*?url\((['"]?)([^)'"]+?\.(?:woff2|woff|ttf|otf))\1/i) || [])[2];
        if (!fam || !url || /^data:/i.test(url)) continue;
        try { url = new URL(unproxyAsset(url), sessionOrigin).href; } catch (e) { continue; }
        const wRaw = ((blk.match(/font-weight\s*:\s*([^;]+)/) || [])[1] || '400').trim();
        const w = /^\d+$/.test(wRaw) ? wRaw : '400';
        if (siteFonts.some(x => x.fam === fam && x.w === w)) continue;
        siteFonts.push({ fam, w, url });
      }
      const built = [];
      for (const sf of siteFonts) {
        const buf = await buildObfTwin(ent, sf.url);
        if (buf && buf.length > 500) built.push({ fam: sf.fam, w: sf.w, buf });
      }
      if (built.length) {
        ent.siteFonts = built;
        siteFaces = built.map((x, i) =>
          '@font-face{font-family:"' + x.fam.replace(/"/g, '') + '";src:url(/m/obf/' + obfSess.sid + '/site-' + i + '.woff2) format("woff2");font-weight:' + x.w + ';font-display:block;unicode-range:U+F0000-10FFFF}').join('');
        logger.log(`[obf   ] site-font twins: ${built.map(x => x.fam + '/' + Math.round(x.buf.length / 1024) + 'KB').join(', ')}`);
      } else ent.siteFonts = null;
    }
    const obfCssBlock = (obfSess && mode === 'dom') ? (obfFacesCss(obfSess.sid, obfFamiliesFromCss(snap.css)) + siteFaces) : '';
    // css 内 url() 已在快照采集时按所属样式表基址改写为 /m(/m/o) 代理路径。
    // v0.17 带宽：css 与上次快照相同（SPA 路由切换常态）则不再重发——导航兜底
    // 重拍的快照从 ~css+html 缩到 ~html；hello（含断线恢复）后重置必发全量
    const cssFixed = snap.css + obfCssBlock;
    const cssSame = (lastCssSent !== null && lastCssSent === cssFixed);
    if (!cssSame) lastCssSent = cssFixed;
    const payload = JSON.stringify(Object.assign({ type: 'dom-snapshot', css: cssSame ? undefined : cssFixed, cssSame: cssSame || undefined, html: snap.html, title: snap.title, w: viewW, h: viewH, tiles: snap.tiles || [], frame: snap.frame || null, docClass: snap.docClass || '', docAttrs: snap.docAttrs || '', bodyStyle: snap.bodyStyle || '', sx: snap.sx || 0, sy: snap.sy || 0, scrollers: snap.scrollers || [], bodyId: snap.bodyId }));
    ws.send(payload);
    ws._bytes = (ws._bytes || 0) + payload.length;
    ws._chunks = (ws._chunks || 0) + 1;
    logger.log('[dom   ] mirror started');
    lastCssSig = null; // 快照即最新基线，下一拍重定（含懒加载样式表）
    // v3：dom 模式无帧流（客户端本地渲染，更新全部事件驱动——补丁/滚动同步/
    // canvas 元素捕获）；帧差分通道仅属于显式 frame（像素直出）模式
    if (mode === 'frame') {
      startDiffLoop();
      // captureBeyondViewport 截图会中断 Page.screencast 帧流——重启
      cdp.send('Page.stopScreencast').catch(() => {});
      setTimeout(() => { if (mode === 'frame') cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }).catch(() => {}); }, 80);
    } else {
      if (canvasSigsReset) canvasSigsReset(); // 重同步后旧基准必然失配（防"画面变化但比对为同"冻结）
      startCanvasWatch();
    }
  }

  // 结构+瓦片补丁（v3）：一批变更合并为一次整页截图；每个变更子树在页面内
  // tileize（文本→带服务端像素背景的等大占位，元素锚定）后以 inner/outer 下发。
  // 客户端替换后瓦片随镜像文档流排版——无坐标、无图层、无帧率，零明文。
  async function tilesPatches(patches) {
    if (patches.some(p => p && p.full)) { await startDomMirror(); return; }
    // 祖先后代去重：祖先 innerHTML 已含后代最终态；按深度排序祖先优先，
    // 后到的祖先会移除已收入的其后代（深度沿用 path 计算；id 版本 path 恒存在）
    const sorted = [...patches].filter(p => p && p.key !== undefined && (p.inner !== undefined || p.outer !== undefined))
      .sort((a, b) => String(a.path ?? '').split('/').length - String(b.path ?? '').split('/').length);
    const items = [];
    for (const p of sorted) {
      const pp = String(p.path ?? p.key);
      if (items.some(q => pp === q.path || pp.startsWith(q.path + '/'))) continue;
      for (let k = items.length - 1; k >= 0; k--) {
        if (items[k].path.startsWith(pp + '/')) items.splice(k, 1);
      }
      items.push({ key: p.key, path: pp, outer: p.outer !== undefined ? 1 : undefined, inner: p.outer !== undefined ? undefined : 1 });
    }
    if (!items.length) return;
    const out = await withTimeout(page.evaluate((list) => {
      const out2 = [];
      // v0.23 窗口平移检测：inner 补丁先与上次下发的子元素序列比对——虚拟滚动
      // 整窗重建的形态是 old.slice(k) ≡ new 前段（下移，删头+尾部新增）或反向
      // （上移）。命中则发 O(增量) 的 delHead+append / prepend+delTail，不命中
      // 回退整段 inner。prev 序列按容器 id 记忆（≤32 容器防内存）
      if (!window.__xyKids) window.__xyKids = new Map();
      for (const it of list) {
        try {
          const ref = (it.key !== undefined && String(it.key)[0] === '#') ? Number(String(it.key).slice(1)) : it.path;
          let live = window.__xy.find(ref);
          if (!live) continue;
          if (live.nodeType === 3) live = live.parentElement;
          if (!live || live.nodeType !== 1) continue;
          const cl = window.__xy.sanitizeClone(live);
          if (it.outer !== undefined) {
            const html = cl.outerHTML;
            if (html) out2.push({ id: ref, path: it.path, outer: html });
            continue;
          }
          const kids = [...cl.children].map(c2 => c2.outerHTML);
          // 比对用规范化串：虚拟滚动每轮整窗重建，data-xy-id 随元素新建而变化，
          // 内容本体相同——剥离 id 属性后比对（发送内容保留原串，新行携带新 id）
          const norm = (h2) => h2.replace(/ data-xy-id="\d+"/g, '');
          const kidsN = kids.map(norm);
          const kidsKey = (typeof ref === 'number' ? '#' + ref : 'p' + it.path) + ':kids';
          const prev = window.__xyKids.get(kidsKey);
          if (prev && prev.length >= 4 && kidsN.length >= 4 && window.__xyKids.size <= 32) {
            // 下移检测：old.slice(k) ≡ new[0..len-k)
            let shift = 0;
            for (let k = 1; k <= prev.length - 4; k++) {
              if (prev.slice(k).every((h3, i) => h3 === kidsN[i]) && prev.length - k <= kidsN.length) { shift = k; break; }
            }
            if (shift > 0) {
              const tail = kids.slice(prev.length - shift).join('');
              window.__xyKids.set(kidsKey, kidsN);
              if (tail) out2.push({ id: typeof ref === 'number' ? ref : undefined, path: it.path, delHead: shift, append: tail });
              else out2.push({ id: typeof ref === 'number' ? ref : undefined, path: it.path, delHead: shift });
              continue;
            }
            // 上移检测：new 尾段 ≡ old[0..len-k)
            let shift2 = 0;
            for (let k = 1; k <= prev.length - 4; k++) {
              if (prev.slice(0, prev.length - k).every((h3, i) => h3 === kidsN[i + k]) && prev.length - k <= kidsN.length) { shift2 = k; break; }
            }
            if (shift2 > 0) {
              const head = kids.slice(0, shift2).join('');
              window.__xyKids.set(kidsKey, kidsN);
              if (head) out2.push({ id: typeof ref === 'number' ? ref : undefined, path: it.path, prepend: head, delTail: shift2 });
              else out2.push({ id: typeof ref === 'number' ? ref : undefined, path: it.path, delTail: shift2 });
              continue;
            }
            // v0.24 LCS 子序列编辑脚本（kidKeep/kidIns）：覆盖窗口边界与混合
            // 批次形态（纯平移检测的回退场景）。规范化串整数化后 O(n·m) DP
            // （n,m≤64），keep=旧序索引（客户端按新序重排并复用保留节点），
            // ins=[新序位置, 原始 html]。仅元素子节点容器可用（文本节点不参与
            // children 序列，混入会丢内容）；编码比整窗省 30%+ 才启用
            const elOnly = [...cl.childNodes].every((n2) => n2.nodeType === 1);
            if (elOnly && kidsN.length <= 64 && prev.length <= 64) {
              const idMap = new Map();
              const a = prev.map((s2) => { if (!idMap.has(s2)) idMap.set(s2, idMap.size); return idMap.get(s2); });
              const b = kidsN.map((s2) => { if (!idMap.has(s2)) idMap.set(s2, idMap.size); return idMap.get(s2); });
              const n2 = a.length, m2 = b.length;
              const dp = [];
              for (let i2 = 0; i2 <= n2; i2++) dp.push(new Int32Array(m2 + 1));
              for (let i2 = n2 - 1; i2 >= 0; i2--) for (let j2 = m2 - 1; j2 >= 0; j2--) dp[i2][j2] = a[i2] === b[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
              const keepIdx = [];
              const keptNew = [];
              let i3 = 0, j3 = 0;
              while (i3 < n2 && j3 < m2) {
                if (a[i3] === b[j3]) { keepIdx.push(i3); keptNew.push(j3); i3++; j3++; }
                else if (dp[i3 + 1][j3] >= dp[i3][j3 + 1]) i3++;
                else j3++;
              }
              const keptSet = new Set(keptNew);
              const insOps = [];
              for (let jj = 0; jj < m2; jj++) if (!keptSet.has(jj)) insOps.push([jj, kids[jj]]);
              const encSize = keepIdx.length * 3 + insOps.reduce((s3, x2) => s3 + x2[1].length + 6, 0) + 40;
              const innerLen = cl.innerHTML.length;
              if (keepIdx.length >= 2 && encSize < innerLen * 0.7) {
                window.__xyKids.set(kidsKey, kidsN);
                out2.push({ id: typeof ref === 'number' ? ref : undefined, path: it.path, kidKeep: keepIdx, kidIns: insOps, kidTotal: m2 });
                continue;
              }
            }
          }
          window.__xyKids.set(kidsKey, kidsN);
          const html = cl.innerHTML;
          if (html) out2.push({ id: typeof ref === 'number' ? ref : undefined, path: it.path, inner: html });
        } catch (e) {}
      }
      return out2;
    }, items), 5000, 'patchReal').catch((e) => { logger.log('[patch] real err:', e && e.message); return null; });
    if (!out || !out.length) return;
    if (ws.readyState !== 1) return;
    // 轮询自更新常产生逐字节相同的结果（像素一致 → data URL 一致）：
    // 与上次已下发比对，全同批次直接跳过（省带宽与客户端重排）
    if (lastPatchSent.size > 500) lastPatchSent.clear();
    const out2 = out.filter(p => {
      const key = (p.id !== undefined ? 'o#' + p.id : 'p:' + (p.path ?? '')) + (p.outer !== undefined ? ':o' : ':i');
      // v0.23：inner 去重用规范化串（剥离 data-xy-id）——虚拟滚动整窗重建时
      // 内容相同但元素新建导致 id 全变，原文比对必然 miss 而重复整窗下发
      const html = p.outer !== undefined ? p.outer : (p.inner !== undefined ? p.inner.replace(/ data-xy-id="\d+"/g, '') : JSON.stringify(p));
      if (lastPatchSent.get(key) === html) return false;
      lastPatchSent.set(key, html);
      return true;
    });
    if (!out2.length) return;
    const payload = JSON.stringify({ type: 'dom-patches', patches: out2 });
    ws.send(payload);
    ws._bytes = (ws._bytes || 0) + payload.length;
    ws._chunks = (ws._chunks || 0) + 1;
  }

  // v3 dom 模式：canvas 元素按需捕获。仅当页面存在视口内 canvas 时才截图，
  // 且逐元素比对像素（sharp raw 或字节级），无变化零下发——静止 canvas（软件
  // GL 下的 WebGL）零流量。v0.22 自适应节奏：可见动画画布升到 ~8fps 快档
  // （120ms tick），静止画布指数退避不变；rAF 门改相邻 tick 差分（无 260ms
  // 阻塞），捕获列表 600ms 缓存，每秒捕获总数预算 12 封顶 CPU
  function startCanvasWatch() {
    if (canvasTimer) return;
    const lastSigs = new Map();
    canvasSigsReset = () => { lastSigs.clear(); };
    let canvasBusy = false;
    let rafLast = { n: -1, at: 0 };
    let listCache = { at: 0, list: null };
    const captureTimes = [];
    canvasTimer = setInterval(async () => {
      if (canvasBusy) return;
      if (mode !== 'dom' || !domActive || dead || !page || !cdp || ws.readyState !== 1) return;
      canvasBusy = true;
      try {
        const now = Date.now();
        // 捕获列表 600ms 缓存（坐标为页面绝对值，滚动安全；可见性过滤随之）
        if (!listCache.list || now - listCache.at > 600) {
          const fresh = await withTimeout(page.evaluate(() => {
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
          }), 1500, 'canvasList').catch(() => null);
          if (fresh === null) return;
          listCache = { at: now, list: fresh };
        }
        const list = listCache.list;
        if (!list.length) { if (lastSigs.size) lastSigs.clear(); return; }
        // rAF 活动门（轻量差分版）：相邻 tick 采样 __xyRafCount，300ms 无增量
        // = 动画循环停转 → canvas 必然静止零捕获（静止 canvas 的持续捕获曾是
        // CPU 大头：实测 34-47%）
        const rafN = await withTimeout(page.evaluate(() => window.__xyRafCount || 0), 400, 'rafN').catch(() => null);
        if (rafN === null) return;
        if (rafN === rafLast.n) { if (Date.now() - rafLast.at > 300) return; }
        else rafLast = { n: rafN, at: Date.now() };
        const nowMs = Date.now();
        while (captureTimes.length && nowMs - captureTimes[0] > 1000) captureTimes.shift();
        for (const it of list) {
          // 未变化画布指数退避：450ms→900→1800→3600 封顶；一变化即复位
          // （v0.14：键改为节点 id——影子内画布 path 可为 null）
          const sigKey = it.id !== undefined ? it.id : it.path;
          const st0 = lastSigs.get(sigKey);
          if (st0 && st0.nextAt && nowMs < st0.nextAt) continue;
          // 每秒捕获预算（≤12）：快档动画画布不挤占整页；预算内按列表序优先
          if (captureTimes.length >= 12) break;
          const shot = await withTimeout(cdp.send('Page.captureScreenshot', {
            format: 'png',
            clip: { x: it.x, y: it.y, width: it.w, height: it.h, scale: DPR },
            captureBeyondViewport: true,
          }), 3000, 'canvasShot').catch(() => null);
          if (!shot) continue;
          captureTimes.push(Date.now());
          let changed = true;
          try {
            if (sharp) {
              const { info, data } = await sharp(Buffer.from(shot.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
              const prev = lastSigs.get(sigKey);
              if (prev && prev.w === info.width && prev.h === info.height && prev.data && prev.data.equals(data)) changed = false;
              else if (prev) { prev.w = info.width; prev.h = info.height; prev.data = data; }
              else lastSigs.set(sigKey, { w: info.width, h: info.height, data, unchanged: 0, nextAt: 0 });
            } else {
              const prev = lastSigs.get(sigKey);
              if (prev && prev.b64 === shot.data) changed = false;
              else if (prev) prev.b64 = shot.data;
              else lastSigs.set(sigKey, { b64: shot.data, unchanged: 0, nextAt: 0 });
            }
          } catch (e) {}
          if (!changed) {
            const st = lastSigs.get(sigKey);
            if (st) { st.unchanged = (st.unchanged || 0) + 1; st.nextAt = Date.now() + Math.min(3600, 450 * Math.pow(2, st.unchanged)); }
            continue;
          }
          const st2 = lastSigs.get(sigKey);
          if (st2) { st2.unchanged = 0; st2.nextAt = 0; }
          if (ws.readyState === 1) {
            const pl = JSON.stringify({ type: 'canvas-tile', id: it.id, path: it.path, url: 'data:image/png;base64,' + shot.data });
            ws.send(pl);
            ws._bytes = (ws._bytes || 0) + pl.length;
            ws._chunks = (ws._chunks || 0) + 1;
          }
        }
      } catch (e) {} finally { canvasBusy = false; }
    }, 120);
  }

  async function stopDomMirror() {
    domActive = false;
    try { await page.evaluate(() => { if (window.__xyObs) { window.__xyObs.disconnect(); window.__xyObs = null; } }); } catch {}
  }

  // 动画/悬停跟随：视口差分循环（dom 模式）。全量快照/交互重同步期间跳过，
  // 首帧只建基准；无变化零下发。瓦片为不透明底板裁片，位移动画的新旧位置都在
  // 差分区域内，客户端直接覆盖即可，无需清理旧瓦片。
  function startDiffLoop() {
    // 编码-解码范式差分通道 v2（仅 frame 像素直出模式）：合成器帧回调 → sharp
    // 进程内解码/比较/裁剪/编码。dom 模式不进入此通道——dom 是客户端本地渲染，
    // 更新全部事件驱动（补丁/滚动/元素捕获），不存在帧率。
    if (diffTimer || mode !== 'frame') return;
    if (mode === 'frame') {
      cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }).catch(() => {});
    }
    let prevRaw = null, prevW = 0, prevH = 0;   // 上一帧 raw 像素（BGRA）
    let lastAnnSX = 0, lastAnnSY = 0, lastScrolls = '[]', lastHoles = '[]';
    let metaAt = 0, meta = { holes: [], scrollers: [], sx: 0, sy: 0 };

    const diffFrame = async (b64) => {
      if (!sharp) return null;
      // ensureAlpha：合成器 PNG 可能为 3 通道（RGB），Uint32 视图按 4 字节/像素索引
      // 会越界读 undefined → 恒等误判（实测 tiles=0 的根因）。恒定 RGBA 后视图对齐。
      const framePng = Buffer.from(b64, 'base64');
      const img = sharp(framePng).ensureAlpha();
      const { info, data } = await img.raw().toBuffer({ resolveWithObject: true });
      const W = info.width, H = info.height, CH = info.channels;
      if (!prevRaw || prevW !== W || prevH !== H) {
        prevRaw = data; prevW = W; prevH = H;
        return { tiles: [{ w: W, h: H, cssX: Math.round(meta.sx || 0), cssY: Math.round(meta.sy || 0),
          cssW: W / DPR, cssH: H / DPR, url: 'data:image/png;base64,' + b64 }], full: true };
      }
      // 逐像素比较找脏行/列（Uint32 视图加速；行级先筛再列级细化）
      const dirtyRows = new Uint8Array(H);
      let any = false;
      const a = new Uint32Array(data.buffer, data.byteOffset, (data.length / 4) | 0);
      const b = new Uint32Array(prevRaw.buffer, prevRaw.byteOffset, (prevRaw.length / 4) | 0);
      const w32 = W >> 2; // 每行 Uint32 数（4 像素/步，TH 兜底用通道级复检）
      for (let y = 0; y < H; y++) {
        const off = y * W;
        for (let x = 0; x < W; x++) {
          if (a[off + x] !== b[off + x]) {
            // Uint32 不等但可能只是 alpha 位——通道级复检（阈值 2）
            const p = (off + x) * CH, q = p - CH + 3;
            void q;
            const dd = data, pp = prevRaw;
            if (Math.abs(dd[p] - pp[p]) > 2 || Math.abs(dd[p + 1] - pp[p + 1]) > 2 || Math.abs(dd[p + 2] - pp[p + 2]) > 2) { dirtyRows[y] = 1; any = true; break; }
          }
        }
      }
      prevRaw = data; prevW = W; prevH = H;
      if (!any) return { tiles: [] };
      // 行程合并成矩形（按连续脏行段，列取整行宽——screencast 帧内横向裁剪收益小
      // 且增加编码次数；行段合并上限 8 段防碎片）
      const rects = [];
      let y0 = -1;
      for (let y = 0; y <= H; y++) {
        const d2 = y < H && dirtyRows[y];
        if (d2 && y0 < 0) y0 = y;
        else if (!d2 && y0 >= 0) { rects.push([0, y0, W, y - y0]); y0 = -1; }
      }
      if (rects.length > 8) {
        // 合并为整帧一张
        rects.length = 0;
        rects.push([0, 0, W, H]);
      }
      const tiles = [];
      for (const [rx, ry, rw, rh] of rects) {
        if (rw < 2 || rh < 2) continue;
        const png = await frameCropInput(sharp, framePng, { info, data }).extract({ left: rx, top: ry, width: rw, height: rh }).png({ compressionLevel: 3 }).toBuffer();
        tiles.push({ w: rw, h: rh, cssX: Math.round(rx / DPR) + Math.round(meta.sx || 0), cssY: Math.round(ry / DPR) + Math.round(meta.sy || 0), cssW: rw / DPR, cssH: rh / DPR, url: 'data:image/png;base64,' + png.toString('base64') });
      }
      return { tiles };
    };

    const fetchMeta = async (inputActive) => {
      // 轻量 evaluate：只拿 holes/scrollers/scroll 位置（无大参数）
      try {
        const r = await Promise.race([
          page.evaluate((ia) => {
            const out = { holes: [], scrollers: [], sx: window.scrollX, sy: window.scrollY };
            try { out.scrollers = window.__xy.scrollers(); } catch (e) {}
            try {
              const maskAnims = true;
              let area = 0;
              const push = (r2, el) => {
                if (r2.width < 2 || r2.height < 2) return;
                if (el && (el.textContent || '').trim()) return;
                const d = window.__xyDpr || 1;
                const x0 = Math.max(0, Math.floor(r2.left * d)), y0 = Math.max(0, Math.floor(r2.top * d));
                const W2 = window.innerWidth * d, H2 = window.innerHeight * d;
                const x1 = Math.min(W2, Math.ceil((r2.left + r2.width) * d)), y1 = Math.min(H2, Math.ceil((r2.top + r2.height) * d));
                if (x1 <= x0 || y1 <= y0) return;
                out.holes.push([Math.round(x0 / d) + Math.round(window.scrollX), Math.round(y0 / d) + Math.round(window.scrollY), Math.round((x1 - x0) / d), Math.round((y1 - y0) / d)]);
                area += (x1 - x0) * (y1 - y0);
              };
              for (const a2 of document.getAnimations()) {
                if (a2.playState !== 'running') continue;
                const el = a2.effect && a2.effect.target;
                if (!el || !el.getBoundingClientRect) continue;
                if (el.querySelector && el.querySelector('canvas, svg, video, iframe')) continue;
                push(el.getBoundingClientRect(), el);
              }
              const ae = document.activeElement;
              if (ia && ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && !ae.disabled) push(ae.getBoundingClientRect(), null);
              if (area > window.innerWidth * window.innerHeight * 0.8) out.holes = [];
            } catch (e) {}
            return out;
          }, inputActive),
          new Promise((_, rej) => setTimeout(() => rej(new Error('meta timeout')), 1500)),
        ]).catch(() => null);
        if (r) meta = r;
      } catch (e) {}
    };
    let pfSeen = 0, pfLogged = 0;
    diffTimer = setInterval(async () => {
      if (diffBusy) return;
      if (dead || mode !== 'frame' || !domActive || !page || !cdp || ws.readyState !== 1) return;
      pfSeen++; if (pfSeen % 62 === 0) { logger.log('[diffv2] tick ok, pfLogged=' + pfLogged); pfLogged = 0; }
      if (domStarting) {
        if (!domStartAt) domStartAt = Date.now();
        else if (Date.now() - domStartAt > 8000) { domStarting = null; domStartAt = 0; }
        else return;
      } else domStartAt = 0;
      const pf = pendingFrame;
      pendingFrame = null;
      // 帧流 watchdog：有活动（近期输入/动画周期内）但 5 秒无帧 = 帧流已断，重启
      if (!pf) {
        if (Date.now() - lastFrameAt2 > 5000 && (Date.now() - lastInputAt) < 60000) {
          lastFrameAt2 = Date.now();
          cdp.send('Page.stopScreencast').catch(() => {});
          cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }).catch(() => {});
          logger.log('[diffv2] screencast watchdog restarted');
        }
        return;
      }
      lastFrameAt2 = Date.now();
      pfLogged++;
      diffBusy = true;
      try {
        // 每 ~200ms 刷新一次 meta（holes/scrollers/scroll）
        const now = Date.now();
        if (now - metaAt > 200) { metaAt = now; fetchMeta(!!lastInputAt && (Date.now() - lastInputAt < 800)); }
        const out = await diffFrame(pf.data).catch((e2) => { logger.log('[diffv2] frame err:', e2 && e2.message); return null; });
        if (!out) return;
        const holesNow = JSON.stringify(meta.holes || []);
        const holesMoved = holesNow !== lastHoles;
        const scrollsNow = JSON.stringify(meta.scrollers || []);
        const innerMoved = scrollsNow !== lastScrolls;
        const scrollMoved = Math.abs((meta.sx || 0) - lastAnnSX) > 1 || Math.abs((meta.sy || 0) - lastAnnSY) > 1;
        if ((out.tiles && out.tiles.length) || scrollMoved || innerMoved || holesMoved) {
          const payload = JSON.stringify({ type: 'anim-tiles', tiles: out.tiles || [], holes: meta.holes || [], sx: meta.sx || 0, sy: meta.sy || 0, scrolls: meta.scrollers || [] });
          if (ws.readyState === 1) {
            ws.send(payload);
            ws._bytes = (ws._bytes || 0) + payload.length;
            ws._chunks = (ws._chunks || 0) + 1;
            lastAnnSX = meta.sx || 0; lastAnnSY = meta.sy || 0; lastScrolls = scrollsNow; lastHoles = holesNow;
          }
        }
      } catch (e) {}
      finally { diffBusy = false; }
    }, 16);
  }

  try {
    const b = await launchSessionBrowser();
    if (dead) { await b.close(); return; }
    sessionBrowser = b;
    b.on('disconnected', () => {
      if (dead) return;
      sendJson({ type: 'error', code: 'SESSION_EXPIRED', terminal: true, msg: '服务端浏览器已关闭，请核对上次提交结果后重新开始' });
      ws.close(1011, 'browser closed');
    });
    page = await b.newPage();
    if (dead) { await page.close(); return; }
    cdp = await page.createCDPSession();
    if (dead) return;
    // 临时诊断：会话页面的 API 请求状态（定位登录后数据不加载问题）
    page.on('response', (r) => {
      try {
        const u = r.url();
        if (r.status() >= 300 || /assistant|api|auth/.test(u)) {
          logger.log('[net   ]', r.status(), r.request().method(), u.slice(0, 90));
        }
      } catch (e) {}
    });
    page.on('pageerror', (e) => { try { logger.log('[pageerr]', String(e && e.message).slice(0, 140)); } catch (e2) {} });

    // 下载通道（v0.13）：源站下载落地会话临时目录，完成后按 ≤48KiB 分块回传并
    // 立即删除服务端文件。文件名 basename 收口 + resolve 目录包含校验（防逃逸）。
    try {
      const browserCdp = await sessionBrowser.target().createCDPSession();
      sessionDownloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-dl-'));
      await browserCdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow', downloadPath: sessionDownloadDir, eventsEnabled: true,
      });
      browserCdpDetached = () => browserCdp.detach().catch(() => {});
    } catch (e) { logger.log('[dl    ] behavior set fail:', e.message); }
    // CDP 事件按域分发：Page.downloadWillBegin/Progress 需要 Page.enable，
    // puppeteer 的独立 CDP 会话默认不启用事件域
    await cdp.send('Page.enable').catch(() => {});
    cdp.on('Page.downloadWillBegin', (ev) => {
      if (dead || ws.readyState !== 1) return;
      const name = path.basename(String(ev.suggestedFilename || 'download.bin'));
      logger.log('[dl    ] willBegin:', name);
      sessionDownloads.set(ev.guid, { name, received: 0 });
      sendJson({ type: 'download-begin', id: ev.guid, name });
    });
    cdp.on('Page.downloadProgress', (ev) => {
      const st = sessionDownloads.get(ev.guid);
      if (!st) return;
      if (ev.state === 'inProgress') { st.received = ev.receivedBytes || 0; return; }
      sessionDownloads.delete(ev.guid);
      if (ev.state === 'canceled') {
        sendJson({ type: 'download-end', id: ev.guid, ok: false, error: 'canceled' });
        return;
      }
      if (ev.state !== 'completed' || dead || ws.readyState !== 1) return;
      (async () => {
        try {
          const dir = path.resolve(sessionDownloadDir);
          const fp = path.resolve(sessionDownloadDir, st.name);
          if (fp !== dir && !fp.startsWith(dir + path.sep)) throw new Error('bad download path');
          const buf = await fsp.readFile(fp);
          await fsp.rm(fp, { force: true }).catch(() => {});
          if (buf.length > DOWNLOAD_MAX) throw new Error('size limit ' + DOWNLOAD_MAX);
          sendJson({ type: 'download-begin', id: ev.guid, name: st.name, size: buf.length });
          const CHUNK = 48 * 1024;
          for (let off = 0; off < buf.length; off += CHUNK) {
            if (dead || ws.readyState !== 1) return;
            sendJson({ type: 'download-chunk', id: ev.guid, b64: buf.subarray(off, off + CHUNK).toString('base64') });
          }
          sendJson({ type: 'download-end', id: ev.guid, ok: true, name: st.name, size: buf.length });
          logger.log('[dl    ] delivered:', st.name, buf.length, 'bytes');
        } catch (err) {
          sendJson({ type: 'download-end', id: ev.guid, ok: false, error: String(err && err.message || err) });
        }
      })();
    });


    cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
      try {
        const now = Date.now();
        if (lastInputAt) { inputLatMs = now - lastInputAt; lastInputAt = 0; }
        frameTimes.push(now);
        // 编码-解码范式（frame 模式）：合成器每帧变化即推（60fps 帧回调驱动差分）。
        // 帧存 pendingFrame，差分循环 32ms 消费；立即 ack 保持帧流。
        // 静止时无帧 = 零 CPU 零流量。dom 模式不订阅帧流，不会走到这里。
        pendingFrame = { data, at: now };
        setTimeout(() => { cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {}); }, 0);
      } catch (e) { /* session may be closing */ }
    });

    statTimer = setInterval(() => {
      if (dead || ws.readyState !== 1) return;
      const now = Date.now();
      frameTimes = frameTimes.filter(t => now - t < 1000);
      const mr = (ws._chunks || 0) - statLastChunks; statLastChunks = ws._chunks || 0;
      // v3：dom 无帧流——上报下行消息速率（帧语义只属于像素流模式）；
      // 每秒兜底触发一次滚动同步 ping（捕获监听遗漏的初始态/漂移）
      if (mode === 'dom' && domActive) { page.evaluate(() => { if (window.__xyScrollPingNow) window.__xyScrollPingNow(true); }).catch(() => {}); }
      // 结构指纹 + CSS 集合指纹（必须在 .then 内取值再上报：elCount 闭包竞态
      // 曾使 sstats.els 恒为 0、客户端 els-drift 重同步雷达整体失活）。
      // CSS 兜底：SPA 懒加载样式表注入 head 可能错过 observer（导航竞态/触发
      // 被吞）——实测 Assistant css（17 个入场 keyframes）不下发则镜像动画全灭。
      // 集合变化即触发全量重同步；成功快照后由 doStartDomMirror 重定基线，
      // 失败则保持脏态每秒重试，不提前更新基线。
      if ((mode === 'dom' || mode === 'frame') && domActive && !domStarting) {
        page.evaluate(() => document.body ? document.body.querySelectorAll(':not(script):not(noscript):not(template)').length : 0)
          .then(async (n) => {
            let sig = null;
            try {
              sig = await page.evaluate(() => {
                const links = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href')).filter(Boolean);
                // v0.15：adoptedStyleSheets 内容哈希签名（replace/replaceSync 改内容
                // 不一定改规则数，逐规则字符级哈希；1Hz 一次开销可忽略）
                let adopted = '';
                try {
                  for (const s2 of (document.adoptedStyleSheets || [])) {
                    try {
                      for (const r of s2.cssRules) {
                        const t = r.cssText;
                        let h = 0;
                        for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
                        adopted += h.toString(36) + ',';
                      }
                    } catch (e) {}
                  }
                } catch (e) {}
                return links.join('|') + '#' + document.querySelectorAll('style').length + '#' + adopted;
              });
            } catch (e) {}
            if (sig !== null) {
              if (lastCssSig === null) lastCssSig = sig;
              else if (sig !== lastCssSig) {
                logger.log('[snapcss] set changed:', String(lastCssSig).slice(0, 90), '->', sig.slice(0, 90));
                startDomMirror().catch(() => {});
              }
            }
            sendJson({ type: 'sstats', fps: frameTimes.length, mr, inLat: inputLatMs, mode, els: n });
          })
          .catch(() => sendJson({ type: 'sstats', fps: frameTimes.length, mr, inLat: inputLatMs, mode, els: 0 }));
      } else {
        sendJson({ type: 'sstats', fps: frameTimes.length, mr, inLat: inputLatMs, mode, els: 0 });
      }
    }, 1000);

    // 主框架导航（登录跳转/表单提交等）：重新注入镜像管线并全量重发，
    // 否则登录成功跳转后镜像冻结在旧页面（访客视角=点了没反应）。
    // SPA 登录后是异步引导：立即快照只拍到骨架，内容 1-3 秒后才到——
    // 补丁路径与骨架代理碰撞错位且不报 miss。导航后 +2.5s/+7s 定时重拍兜底。
    page.on('framenavigated', (frame) => {
      try {
        if (frame !== page.mainFrame()) return;
        if (!domActive || ws.readyState !== 1) return;
        navChain = navChain.then(async () => {
          try {
            await page.evaluate(sessHelpers).catch(() => {});
            if (mode === 'dom' || mode === 'frame') await startDomMirror();
            for (const d of [600, 1500]) {
              setTimeout(() => {
                if (dead || !domActive || ws.readyState !== 1) return;
                startDomMirror().catch(() => {});
              }, d);
            }
          } catch (e) {}
        });
      } catch (e) {}
    });
    let navChain = Promise.resolve();

    // 等客户端上报 DPR（超时回落 1）：服务端按访客 DPR 渲染 → 瓦片 1:1 显示 → 构造性一致
    const hello = await new Promise((res) => {
      cancelHello = () => res({ dpr: 1 });
      if (dead) { cancelHello(); return; }
      const t = setTimeout(() => { clearInterval(helloIv); res({ dpr: 1 }); }, 3000);
      helloIv = setInterval(() => {
        const i = queue.findIndex((r) => { try { return JSON.parse(r.toString()).type === 'hello'; } catch { return false; } });
        if (i >= 0) {
          clearInterval(helloIv); clearTimeout(t);
          try { res(JSON.parse(queue.splice(i, 1)[0].toString())); } catch { res({ dpr: 1 }); }
        }
      }, 100);
    });
    if (dead) return;
    DPR = Math.max(1, Math.min(3, parseFloat(hello.dpr) || 1));
    // 首次 hello 同时带回访客视口：服务端按访客真实视口渲染，镜像才与直连构图一致
    if (hello.w) viewW = Math.max(320, Math.min(2560, parseInt(hello.w, 10) || viewW));
    if (hello.h) viewH = Math.max(240, Math.min(1600, parseInt(hello.h, 10) || viewH));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewW, height: viewH, deviceScaleFactor: DPR, mobile: false });
    await page.goto(sessionOrigin, { waitUntil: 'networkidle0', timeout: 20000 });
    sendJson({ type: 'meta', w: viewW, h: viewH, title: await page.title(), maxSessions: MAX_SESSIONS, mode, prod: prodMode });
    if (mode === 'dom' || mode === 'frame') await startDomMirror();

    dispatchReady = true;
    for (const raw of queue.splice(0)) enqueue(raw);
    sendJson({ type: 'sync-ready' });

  } catch (e) {
    sendJson({ type: 'error', msg: '会话建立失败: ' + e.message });
    try { await cleanup(); } catch {}
    try { ws.close(); } catch {}
  }
}

function waitForRevokedClose(socket) {
  if (!socket || socket.readyState === 3) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => socket.terminate(), 1000);
    timer.unref();
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

async function revokeSessions(selected) {
  const pending = [];
  for (const session of selected) {
    const socket = session.socket;
    session.close(4001, 'SESSION_REVOKED');
    pending.push(waitForRevokedClose(socket));
    const lifecycle = sessionLifecycles.get(session);
    pending.push(lifecycle?.task, lifecycle?.cleanup());
  }
  await Promise.allSettled(pending);
  return selected.length;
}

async function revokeSession(token) {
  if (typeof token !== 'string' || !token.trim()) throw new TypeError('token must be a non-empty string');
  const session = sessionStore.entries.get(token);
  return (await revokeSessions(session ? [session] : [])) > 0;
}

async function revokeIdentity(identity) {
  if (typeof identity !== 'string' || !identity.trim()) throw new TypeError('identity must be a non-empty string');
  const selected = [...sessionStore.entries.values()].filter(session => sessionLifecycles.get(session)?.identity === identity);
  const result = revokeSessions(selected);
  const pending = [result];
  // Includes authenticated transports that have not sent their first hello yet.
  for (const socket of wss.clients) {
    if (socketIdentities.get(socket) === identity && socket.readyState === 1) {
      socket.close(4001, 'SESSION_REVOKED');
      pending.push(waitForRevokedClose(socket));
    }
  }
  await Promise.all(pending);
  return result;
}

function close() {
  if (closePromise) return closePromise;
  closed = true;
  closePromise = (async () => {
    for (const session of [...sessionStore.entries.values()]) session.close(1001, 'mirror closing');
    for (const socket of wss.clients) socket.terminate();
    for (const request of requests) request.destroy();
    await Promise.allSettled([...sessionTasks, ...[...cleanups].map(cleanup => cleanup())]);
    await new Promise(resolve => wss.close(resolve));
    obfSessions.clear();
    obfFontCache.clear();
    obfTwinCache.clear();
    clearStaticFiles();
  })();
  return closePromise;
}

return { handleRequest, handleUpgrade, revokeSession, revokeIdentity, close };
}

module.exports = { createMirror };
