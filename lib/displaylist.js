// lib/displaylist.js — DL 模式页面采集器（注入 Chromium 执行）
// 导出：函数源码字符串。server.js 以 page.evaluate(`(${DL_COLLECTOR})(${VW},${VH})`) 调用。
// 设计对齐 lib/page-helpers.js 的注入模式；指令集 v1：
//   rr  矩形（纯色/圆角/边框）      rrg 线性渐变矩形
//   tx  文本（字体/字重/颜色/基线）  im  图片引用（src 由服务端转 /m/* 代理）
//   svg 内联矢量（outerHTML 序列化，客户端 data-URL 真渲染）
//   sh  box-shadow 近似（客户端 shadow 重绘）
// 绘制序：三层桶（负 z → 正常流 → 提升 z），桶内 DOM 序——修复 POC 的整层错位。
// v5 区域增量采集：
//   - observer 逐条登记 dirtySet（≤600，溢出→全量）；scroll/resize/transitionend/animationend
//     及 5s 兜底定时器 → 全量；首次调用（无 observer）→ 全量
//   - 增量拍只重采 dirty 祖先去重后的子树（禁 querySelectorAll('*')；单拍 ≤300 元素，
//     截断→置 overflow 留给下一拍全量兜底，本拍返回 partial:true）
//   - z 序号持久化在 el.__xyDlSeq（全量对账 DOM 序，新元素顺延 __xyDlSeqNext）
//   - 返回 {partial, w, h, base, items, removed(离文档 id), sx, sy}；
//     可交互条目附 hit:{k:input/link/btn/area, x,y,w,h}
'use strict';

const DL_COLLECTOR = String.raw`(async function dlCollect(vw, vh) {
  const body = document.body || document.documentElement;

  // ---- v5 初始化：变更登记（dirtySet）+ 溢出/视口事件/兜底定时器（→ 全量）。首拍全量 ----
  if (!window.__xyDlObs) {
    window.__xyDlDirty = true;
    window.__xyDlOverflow = true; // 首次调用走全量，顺带建立 __xyDlSeq 基线
    window.__xyDlDirtySet = new Set();
    window.__xyDlSeqNext = 0;
    const addDirty = (el) => {
      if (!el || el.nodeType !== 1) return;
      if (window.__xyDlOverflow || !window.__xyDlDirtySet || window.__xyDlDirtySet.size >= 600) {
        window.__xyDlOverflow = true; // 超限：退化全量
        return;
      }
      window.__xyDlDirtySet.add(el);
    };
    const onMut = (muts) => {
      let any = false;
      for (const m of muts) {
        if (m.type === 'attributes' && m.attributeName === 'data-xydl') continue; // 采集器自身写 id，不自脏
        any = true;
        const t = m.target;
        if (m.type === 'childList') {
          addDirty(t && t.nodeType === 1 ? t : (t && t.parentElement));
          for (const rn of m.removedNodes) addDirty(rn); // 离文档节点 → 下一拍进 removed 对账
        } else {
          addDirty(t && t.nodeType === 1 ? t : (t && t.parentElement)); // characterData：登记父元素
        }
      }
      if (any) window.__xyDlDirty = true;
    };
    // P2：监听器用命名函数引用保存（removeEventListener 用），interval id 存变量（teardown 清理用）
    const ov = () => { window.__xyDlDirty = true; window.__xyDlOverflow = true; }; // 视口类变更 → 全量
    const dlEvs = ['scroll', 'resize', 'transitionend', 'animationend'];
    let dlIv = null;
    try {
      window.__xyDlObs = new MutationObserver(onMut);
      window.__xyDlObs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      for (const ev of dlEvs) addEventListener(ev, ov, true);
      dlIv = setInterval(ov, 5000); // 兜底：周期性全量对账，防漏标
    } catch (e) { window.__xyDlDirty = true; window.__xyDlOverflow = true; }
    // P2：常驻资源登记 teardown（预留接口，服务端暂不调用）——断开 observer、移除事件监听、
    // 清 interval、清 dirtySet；置 __xyDlObs=null 使下次采集按首装路径重建
    window.__xyDlTeardown = () => {
      try { if (window.__xyDlObs) window.__xyDlObs.disconnect(); } catch (e) {}
      for (const ev of dlEvs) { try { removeEventListener(ev, ov, true); } catch (e) {} }
      if (dlIv !== null) { clearInterval(dlIv); dlIv = null; }
      try { if (window.__xyDlDirtySet) window.__xyDlDirtySet.clear(); } catch (e) {}
      window.__xyDlObs = null;
    };
  }

  if (!window.__xyDlDirty && !window.__xyDlOverflow) {
    return { skip: true, sx: Math.round(window.scrollX || 0), sy: Math.round(window.scrollY || 0) };
  }

  // ---- 消费脏状态：先快照并清空 live 集，采集期间的新变更留给下一拍（不丢更新）----
  let needFull = !!window.__xyDlOverflow;

  // v8 修1：祖先 overflow:hidden/clip 裁剪——轮播相邻 slide 在 viewport 外、页面视口内，
  // 不裁剪会把多帧文字叠印（墨提斯 hero 实测）。每祖先 memo，每次 tick 重建。
  const __xyClipMemo = new Map();
  if (!window.__xyDlDropIds) window.__xyDlDropIds = new Set();
  // v8.2 性能：SVG 光栅化缓存——同一内容（xml 哈希+尺寸）不重复 decode/toDataURL。
  // 实测无缓存时单拍 ~2s（0.5fps），动画完全跟不上。上限 120 条 FIFO。
  if (!window.__xySvgCache) window.__xySvgCache = new Map();
  function svgCacheKey(xml, w, h) {
    let hash = 5381;
    for (let i = 0; i < xml.length; i += 7) hash = ((hash << 5) + hash + xml.charCodeAt(i)) | 0;
    return w + "x" + h + "|" + xml.length + "|" + hash;
  }
  function clipUpTo(el) {
    if (__xyClipMemo.has(el)) return __xyClipMemo.get(el);
    let box = [0, 0, vw, vh];
    const parent = el.parentElement;
    if (parent && parent !== document.documentElement) {
      const pb = clipUpTo(parent);
      box = pb.slice();
      const pcs = getComputedStyle(parent);
      const ox = pcs.overflowX, oy = pcs.overflowY;
      if (ox === 'hidden' || ox === 'clip' || oy === 'hidden' || oy === 'clip') {
        const pr = parent.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0) {
          box[0] = Math.max(box[0], pr.left); box[1] = Math.max(box[1], pr.top);
          box[2] = Math.min(box[2], pr.right); box[3] = Math.min(box[3], pr.bottom);
        }
      }
    }
    __xyClipMemo.set(el, box);
    return box;
  }
  function clippedOut(el, rect) {
    try {
      const b = clipUpTo(el);
      return rect.right <= b[0] || rect.left >= b[2] || rect.bottom <= b[1] || rect.top >= b[3];
    } catch (e) { return false; }
  }
  // v7 A2: 真基线——离屏 canvas 按源站字体实测 ascent，按 font spec 缓存
  const __xyMCanvas = document.createElement('canvas');
  const __xyMCtx = __xyMCanvas.getContext('2d');
  const __xyAscentCache = new Map();
  function txBaseline(fontSpec, sizePx, fallback) {
    if (__xyAscentCache.has(fontSpec)) return __xyAscentCache.get(fontSpec);
    let v = fallback;
    try { __xyMCtx.font = fontSpec; const m = __xyMCtx.measureText('\u56fd');
      if (m && m.fontBoundingBoxAscent) v = m.fontBoundingBoxAscent; } catch (e) {}
    __xyAscentCache.set(fontSpec, v);
    return v;
  }

  // v7 A1: 收集 @font-face（family/weight/绝对url）——全量帧随行下发
  function collectFonts() {
    const fo = []; const seen = new Set();
    try {
      for (const ss of document.styleSheets) {
        let rules; try { rules = ss.cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (const r of rules) {
          const cn = r && r.constructor && r.constructor.name;
          if (cn !== 'CSSFontFaceRule') continue;
          const st = r.style; if (!st) continue;
          const fam = (st.getPropertyValue('font-family') || '').replace(/[\"']/g, '').trim();
          const srcv = st.getPropertyValue('src') || '';
          const um = srcv.match(/url\((['\"]?)([^'\")]+\.(?:woff2|woff|ttf|otf))\1\)/i);
          if (!fam || !um) continue;
          let u = um[2];
          if (!/^https?:/i.test(u)) { try { u = new URL(u, location.href).href; } catch (e) { continue; } }
          if (u.length > 600) continue;
          const w = (st.getPropertyValue('font-weight') || '400').trim() || '400';
          const key = fam + '|' + w;
          if (seen.has(key)) continue; seen.add(key);
          fo.push({ fam, w, u });
          if (fo.length >= 10) return fo;
        }
      }
    } catch (e) {}
    return fo;
  }
  const fontsFound = needFull ? collectFonts() : undefined;


  window.__xyDlDirty = false;
  window.__xyDlOverflow = false;
  const snap = [];
  if (window.__xyDlDirtySet) {
    for (const el of window.__xyDlDirtySet) snap.push(el);
    window.__xyDlDirtySet.clear();
  }

  // ---- 分类快照：离文档 → removed id（整棵离树子树对账）；在文档 → 增量候选 ----
  const removed = [];
  const units = [];
  for (const el of snap) {
    if (!el || el.nodeType !== 1) continue;
    if (!el.isConnected) {
      const st = [el];
      while (st.length && removed.length < 600) {
        const n = st.pop();
        const rid = n.dataset ? n.dataset.xydl : '';
        if (rid && removed.indexOf(rid) < 0) removed.push(rid);
        const ch = n.children;
        if (ch) for (let k = ch.length - 1; k >= 0; k--) st.push(ch[k]);
      }
      if (removed.length >= 600) needFull = true; // 删除规模失控 → 全量重建
      continue;
    }
    units.push(el);
  }
  if (!needFull) { for (const el of units) if (!body.contains(el)) { needFull = true; break; } } // html/head 级变更 → 全量

  const out = [];
  let svgRz = 0;
  const seenIds = new Set();
  const clip = (r) => r.left < vw && r.top < vh && r.right > 0 && r.bottom > 0;
  const R = (n) => Math.round(n * 10) / 10;
  const col = (c) => (c || '').replace(/\s+/g, ' ').trim();

  function rrOp(rect, cs, forceFill) {
    const rad = parseFloat(cs.borderTopLeftRadius) || 0;
    const bg = col(cs.backgroundColor);
    const opaque = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    const bw = Math.min(parseFloat(cs.borderTopWidth) || 0, parseFloat(cs.borderBottomWidth) || 0,
                        parseFloat(cs.borderLeftWidth) || 0, parseFloat(cs.borderRightWidth) || 0);
    const bc = col(cs.borderTopColor);
    const hasB = bw > 0.5 && bc && bc !== 'rgba(0, 0, 0, 0)';
    if (!forceFill && !opaque && !hasB) return null;
    const o = { a: 'rr', x: R(rect.left), y: R(rect.top), w: R(rect.width), h: R(rect.height), r: R(Math.min(rad, Math.min(rect.width, rect.height) / 2)) };
    if (opaque) o.f = bg;
    if (hasB) { o.s = bc; o.lw = R(bw); }
    return o;
  }

  function gradOp(cs, rect) {
    const bi = cs.backgroundImage || '';
    if (bi === 'none' || !/linear-gradient\(/.test(bi)) return null;
    const m = bi.match(/linear-gradient\(([\s\S]+)\)$/);
    if (!m) return null;
    const parts = m[1].split(/,(?![^(]*\))/);
    const head = (parts[0] || '').trim();
    let ang = 180; let start = 0;
    const am = head.match(/^(-?[\d.]+)deg$/);
    if (am) { ang = +am[1]; start = 1; }
    else if (/^to bottom$/i.test(head)) { ang = 180; start = 1; }
    else if (/^to right$/i.test(head)) { ang = 90; start = 1; }
    else if (/^to top$/i.test(head)) { ang = 0; start = 1; }
    else if (/^to bottom right$/i.test(head) || /^to right bottom$/i.test(head)) { ang = 135; start = 1; }
    const stops = [];
    for (let i = start; i < parts.length && stops.length < 4; i++) {
      const s = (parts[i] || '').trim().match(/^(rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/);
      if (s) stops.push(col(s[1]));
    }
    if (stops.length < 2) return null;
    const o = { a: 'rrg', x: R(rect.left), y: R(rect.top), w: R(rect.width), h: R(rect.height), r: 0, ang, c1: stops[0], c2: stops[stops.length - 1] };
    const rad = parseFloat(cs.borderTopLeftRadius) || 0;
    if (rad > 0) o.r = R(Math.min(rad, Math.min(rect.width, rect.height) / 2));
    return o;
  }

  function bgImageOp(cs, rect) {
    const bi = cs.backgroundImage || '';
    const m = bi.match(/url\((['"]?)([^'")]+)\1\)/);
    if (!m) return null;
    let u = m[2];
    if (!/^https?:\/\//i.test(u)) { try { u = new URL(u, location.href).href; } catch (e) { return null; } }
    if (u.length > 600) return null;
    return { a: 'im', x: R(rect.left), y: R(rect.top), w: R(rect.width), h: R(rect.height),
             r: 0, src: u, fit: (cs.backgroundSize || '').indexOf('contain') >= 0 ? 'contain' : 'cover', bg: 1 };
  }

  function shadowOp(cs, rect) {
    const sh = cs.boxShadow;
    if (!sh || sh === 'none') return null;
    const m = sh.match(/^([a-z]+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?\s+((?:rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+))/);
    if (!m || m[1] !== 'rgba' && m[1][0] === '#') { /* 颜色在前的旧语法不解析 */ }
    if (!m) return null;
    const blur = +m[4]; if (blur < 2) return null;
    return { a: 'sh', x: R(rect.left), y: R(rect.top), w: R(rect.width), h: R(rect.height),
             dx: +m[2], dy: +m[3], b: blur, c: col(m[6]), inset: m[1] === 'inset' ? 1 : 0 };
  }

  function txOp(range, text, cs) {
    const r = range.getBoundingClientRect();
    if (!clip(r) || r.width < 1) return null;
    const sizePx = R(parseFloat(cs.fontSize) || 14);
    const weight = (+cs.fontWeight >= 600) ? 700 : 400;
    const fam0 = (cs.fontFamily || 'sans-serif').split(',')[0].replace(/["']/g, '').trim();
    const spec = weight + ' ' + sizePx + 'px "' + fam0 + '"';
    const base = txBaseline(spec, sizePx, r.height * 0.8);
    // v8 修3：渐变文字（background-clip:text + color:transparent）按透明色画=隐形，
    // 取背景渐变首个颜色 stop 近似（墨提斯 Logo 实测）
    let tcol = col(cs.color);
    try {
      if ((cs.color === 'rgba(0, 0, 0, 0)' || cs.color === 'transparent') && /linear-gradient\(/.test(cs.backgroundImage || '')) {
        const gm = (cs.backgroundImage || '').match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/g);
        if (gm && gm.length) tcol = col(gm[0]);
      }
    } catch (e4) {}
    return { a: 'tx', x: R(r.left), y: R(r.top + base), t: text.slice(0, 160),
             s: sizePx, w: weight,
             f: fam0,
             c: tcol, ls: R(parseFloat(cs.letterSpacing) || 0) || undefined,
             align: cs.textAlign === 'center' || cs.textAlign === 'right' ? cs.textAlign : undefined };
  }

  function txOpHelper(rect, text, cs) {
    return { a: 'tx', x: R(rect.left + 4), y: R(rect.top + rect.height * 0.7), t: text.slice(0, 40),
             s: 12, w: 400, f: 'sans-serif', c: '#889' };
  }

  // v5 hit-test：满足可交互条件才返回命中矩形（k: input/link/btn/area），不必为所有元素输出
  function hitInfo(el, tag, cs, rect) {
    let k = null;
    if (tag === 'a') k = 'link';
    else if (tag === 'input' || tag === 'textarea' || tag === 'select') k = 'input';
    else if (tag === 'button') k = 'btn';
    if (!k) {
      const tis = el.getAttribute('tabindex');
      if (tis !== null) { const ti = parseInt(tis, 10); if (!isNaN(ti) && ti >= 0) k = 'area'; }
    }
    if (!k && (cs.cursor === 'pointer' || el.onclick || el.hasAttribute('onclick'))) k = 'area';
    if (!k) return null;
    return { k, x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
  }

  // v5 单元素采集：原全页循环体抽取复用（可见性过滤 / rr/rrg/tx/im/sh / svg 光栅化 / 文本 / placeholder 全保留）
  // 返回是否继续下探子树（display:none 子树无布局，全页遍历同样不产出 → 剪枝）
  async function collectEl(el) {
    // v7.2 A3 根因修复：SVG 内部子树（text/tspan/g/path...）由 <svg> 根整体光栅化承载，
    // 逐元素采集会与光栅化 PNG 双层叠印（墨提斯 hero 信息图实测：PNG+27 个 tx 叠压）
    if (el.ownerSVGElement) return true;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta' || tag === 'noscript') return true;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden' || +cs.opacity < 0.05) {
      // v8.1：隐藏元素同样要回报 removed（原地隐藏不触发 DOM 变更事件）
      if (el.dataset && el.dataset.xydl) window.__xyDlDropIds.add(el.dataset.xydl);
      return true; // 后代仍可能 visible，继续下探
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || !clip(rect)) return true;
    if (clippedOut(el, rect)) {
      // v8.1：被裁剪的元素不再产出指令——必须回报 removed，否则客户端 store 残留旧副本叠印
      if (el.dataset && el.dataset.xydl) window.__xyDlDropIds.add(el.dataset.xydl);
      return false;
    }

    // v5：id 计数持久化，避免跨拍撞号（增量按 id 合并/删除）
    if (!el.dataset.xydl) el.dataset.xydl = 'd' + (window.__xyDlAutoId = (window.__xyDlAutoId || 0) + 1);
    const id = el.dataset.xydl;
    seenIds.add(id);

    // v5 z 序号：全量对账时写 DOM 序；增量沿用旧值，新元素顺延分配
    let seq = el.__xyDlSeq;
    if (typeof seq !== 'number') {
      if (typeof window.__xyDlSeqNext !== 'number') window.__xyDlSeqNext = 0;
      seq = el.__xyDlSeq = window.__xyDlSeqNext++;
    }

    // 层叠层级：position 非 static 或 transform 生效 → 提升桶
    const zi = cs.zIndex !== 'auto' ? (parseInt(cs.zIndex, 10) || 0) : null;
    const promoted = zi !== null || cs.position === 'fixed' || cs.position === 'absolute' ||
                     (cs.transform && cs.transform !== 'none') || +cs.opacity < 1;
    const layer = zi !== null && zi < 0 ? 0 : (promoted ? 2 : 1);

    const ops = [];
    const sh = shadowOp(cs, rect); if (sh) ops.push(sh);
    const g = gradOp(cs, rect); if (g) ops.push(g);
    const rrop = rrOp(rect, cs, !!g || undefined); if (rrop && !g) ops.push(rrop);
    const bi = bgImageOp(cs, rect); if (bi) ops.push(bi);

    if (tag === 'img') {
      let src = el.currentSrc || el.src || '';
      if (src.startsWith('data:')) src = '';
      if (src && src.length <= 600) ops.push({ a: 'im', x: R(rect.left), y: R(rect.top), w: R(rect.width), h: R(rect.height), r: 0, src, fit: 'cover' });
      else if (el.alt) ops.push(txOpHelper(rect, el.alt, cs));
    }
    if (tag === 'svg' && svgRz < 60) {
      svgRz++;
      // v3：页面内光栅化——浏览器渲染自己的 SVG（computed 样式/use 引用全保真），导出 PNG data-URL
      try {
        const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
        // v8 修2：序列化前把 computed fill/stroke/opacity/font 内联为属性——
        // class 定义的样式在独立 SVG 文档里不存在（否则图形全空）
        const clone = el.cloneNode(true);
        try {
          const sk = el.querySelectorAll('*');
          const dk = clone.querySelectorAll('*');
          const cap = Math.min(sk.length, 160);
          for (let si = 0; si < cap; si++) {
            try {
              const scs = getComputedStyle(sk[si]);
              const d = dk[si];
              if (scs.fill && scs.fill !== 'none') d.setAttribute('fill', scs.fill);
              if (scs.stroke && scs.stroke !== 'none') { d.setAttribute('stroke', scs.stroke); d.setAttribute('stroke-width', scs.strokeWidth); }
              if (+scs.opacity < 1) d.setAttribute('opacity', scs.opacity);
              if (scs.fontSize) {
                d.setAttribute('font-family', (scs.fontFamily || 'sans-serif').split(',')[0].replace(/["']/g, ''));
                d.setAttribute('font-size', scs.fontSize);
                d.setAttribute('font-weight', scs.fontWeight);
              }
            } catch (e2) {}
          }
        } catch (e3) {}
        const xml = new XMLSerializer().serializeToString(clone);
        if (xml.length <= 32768) {
          const cw = Math.min(w, 512), chh = Math.min(h, 512);
          const ckey = svgCacheKey(xml, cw, chh);
          let png = window.__xySvgCache.get(ckey);
          if (!png) {
            const c = document.createElement('canvas');
            c.width = cw; c.height = chh;
            const cx = c.getContext('2d');
            const si = new Image();
            si.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
            await Promise.race([si.decode(), new Promise((_, rej) => setTimeout(() => rej(new Error('svg decode timeout')), 800))]);
            cx.drawImage(si, 0, 0, c.width, c.height);
            png = c.toDataURL('image/png');
            if (png && png.length > 10) {
              if (window.__xySvgCache.size >= 120) { const k0 = window.__xySvgCache.keys().next().value; window.__xySvgCache.delete(k0); }
              window.__xySvgCache.set(ckey, png);
            }
          }
          if (png.length > 10 && png.length <= 65536) {
            ops.length = 0;
            ops.push({ a: 'im', x: R(rect.left), y: R(rect.top), w: R(rect.width), h: R(rect.height), r: 0, src: png, fit: 'contain' });
          }
        }
      } catch (e) { /* 光栅化失败：跳过该 svg（下一拍 dirty 重试或永久跳过） */ }
    }

    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const rng = document.createRange(); rng.selectNodeContents(n);
      const op = txOp(rng, t, cs);
      if (op) {
        if (cs.textOverflow === 'ellipsis' && rect.width > 0) {
          const approx = op.s * 0.52 * t.length;
          if (approx > rect.width * 1.05) op.t = t.slice(0, Math.max(1, Math.floor(rect.width / (op.s * 0.52)) - 1)) + '…';
        }
        ops.push(op);
      }
    }
    // v6: 输入框 value 回显——服务端 composition/键入后写 data-xydl-val 属性（observer 可见）
    if (tag === 'input' || tag === 'textarea') {
      const vv = el.getAttribute('data-xydl-val');
      if (vv) {
        const masked = (el.type === 'password') ? String.fromCharCode(0x2022).repeat(Math.min(vv.length, 20)) : vv;
        ops.push({ a: 'tx', x: R(rect.left + 14), y: R(rect.top + rect.height * 0.72), t: masked.slice(0, 80),
                   s: R(parseFloat(cs.fontSize) || 14), w: 400, f: 'sans-serif', c: col(cs.color) });
      }
    }
    if ((tag === 'input' || tag === 'textarea') && el.placeholder && !el.value) {
      ops.push({ a: 'tx', x: R(rect.left + 14), y: R(rect.top + rect.height * 0.72), t: String(el.placeholder).slice(0, 80),
                 s: R(parseFloat(cs.fontSize) || 14), w: 400, f: 'sans-serif', c: 'rgba(120,130,145,1)' });
    }
    if (ops.length) {
      const item = { id, z: layer * 100000 + seq, ops };
      const hit = hitInfo(el, tag, cs, rect);
      if (hit) item.hit = hit;
      out.push(item);
    }
    return true;
  }

  // ---- 全量拍（首次 / overflow / html 级变更 / 删除失控）：行为与旧版一致 ----
  if (needFull) {
    const all = body.querySelectorAll('*');
    for (let i = 0; i < all.length && out.length < 4000; i++) {
      const el = all[i];
      el.__xyDlSeq = i; // 全量对账：z 序号 = 当前 DOM 序
      await collectEl(el);
    }
    if (typeof window.__xyDlSeqNext !== 'number' || window.__xyDlSeqNext < all.length) window.__xyDlSeqNext = all.length;
    return { partial: false, w: vw, h: vh, items: out, base: getComputedStyle(body).backgroundColor || '#fff', removed, fonts: fontsFound,
             dirty: true, sx: Math.round(window.scrollX || 0), sy: Math.round(window.scrollY || 0) };
  }

  // ---- 增量拍：祖先去重（只留最上层）→ 逐子树重采；红线：无 querySelectorAll，单拍 ≤300 元素 ----
  const roots = units.filter((el) => !units.some((o) => o !== el && o.contains(el)));
  let visited = 0, truncated = false;
  const stack = [];
  for (const root of roots) {
    stack.push(root);
    while (stack.length) {
      if (visited >= 300) { truncated = true; break; } // 单拍上限：剩余留给下一拍全量兜底
      const el = stack.pop();
      visited++;
      if (await collectEl(el)) {
        const ch = el.children;
        for (let k = ch.length - 1; k >= 0; k--) stack.push(ch[k]);
      }
    }
    if (truncated) break;
  }
  if (truncated) window.__xyDlOverflow = true;
  try { for (const id of window.__xyDlDropIds) removed.push(id); } catch (e) {}
  if (window.__xyDlDropIds) window.__xyDlDropIds.clear();
  return { partial: true, w: vw, h: vh, base: getComputedStyle(body).backgroundColor || '#fff',
           items: out, removed, dirty: true, sx: Math.round(window.scrollX || 0), sy: Math.round(window.scrollY || 0) };
})`;

module.exports = { DL_COLLECTOR };
