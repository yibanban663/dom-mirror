// lib/displaylist.js — DL 模式页面采集器（注入 Chromium 执行）
// 导出：函数源码字符串。server.js 以 page.evaluate(`(${DL_COLLECTOR})(${VW},${VH})`) 调用。
// 设计对齐 lib/page-helpers.js 的注入模式；指令集 v1：
//   rr  矩形（纯色/圆角/边框）      rrg 线性渐变矩形
//   tx  文本（字体/字重/颜色/基线）  im  图片引用（src 由服务端转 /m/* 代理）
//   svg 内联矢量（outerHTML 序列化，客户端 data-URL 真渲染）
//   sh  box-shadow 近似（客户端 shadow 重绘）
// 绘制序：三层桶（负 z → 正常流 → 提升 z），桶内 DOM 序——修复 POC 的整层错位。
'use strict';

const DL_COLLECTOR = String.raw`(async function dlCollect(vw, vh) {
  // ---- 增量门：MutationObserver 常驻标记，无变化时立即跳过全页扫描 ----
  if (!window.__xyDlObs) {
    window.__xyDlDirty = true;
    const mark = () => { window.__xyDlDirty = true; };
    try {
      window.__xyDlObs = new MutationObserver(mark);
      window.__xyDlObs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      for (const ev of ['scroll', 'resize', 'transitionend', 'animationend']) addEventListener(ev, mark, true);
      setInterval(mark, 5000); // 兜底：周期性全量对账，防漏标
    } catch (e) { window.__xyDlDirty = true; }
  }
  if (!window.__xyDlDirty) return { skip: true };
  window.__xyDlDirty = false;

  const out = [];
  let autoId = 0, svgRz = 0;
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
    return { a: 'tx', x: R(r.left), y: R(r.top + r.height * 0.8), t: text.slice(0, 160),
             s: R(parseFloat(cs.fontSize) || 14), w: (+cs.fontWeight >= 600) ? 700 : 400,
             f: (cs.fontFamily || 'sans-serif').split(',')[0].replace(/["']/g, '').trim(),
             c: col(cs.color), ls: R(parseFloat(cs.letterSpacing) || 0) || undefined,
             align: cs.textAlign === 'center' || cs.textAlign === 'right' ? cs.textAlign : undefined };
  }

  const body = document.body || document.documentElement;
  const all = body.querySelectorAll('*');
  for (let i = 0; i < all.length && out.length < 4000; i++) {
    const el = all[i];
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta' || tag === 'noscript') continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || !clip(rect)) continue;

    if (!el.dataset.xydl) el.dataset.xydl = 'd' + (autoId++);
    const id = el.dataset.xydl;
    seenIds.add(id);

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
        const xml = new XMLSerializer().serializeToString(el);
        if (xml.length <= 32768) {
          const c = document.createElement('canvas');
          c.width = Math.min(w, 512); c.height = Math.min(h, 512);
          const cx = c.getContext('2d');
          const si = new Image();
          si.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
          await Promise.race([si.decode(), new Promise((_, rej) => setTimeout(() => rej(new Error('svg decode timeout')), 800))]);
          cx.drawImage(si, 0, 0, c.width, c.height);
          const png = c.toDataURL('image/png');
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
    if ((tag === 'input' || tag === 'textarea') && el.placeholder && !el.value) {
      ops.push({ a: 'tx', x: R(rect.left + 14), y: R(rect.top + rect.height * 0.72), t: String(el.placeholder).slice(0, 80),
                 s: R(parseFloat(cs.fontSize) || 14), w: 400, f: 'sans-serif', c: 'rgba(120,130,145,1)' });
    }
    if (ops.length) out.push({ id, z: layer * 100000 + i, ops });
  }
  return { w: vw, h: vh, items: out, base: getComputedStyle(body).backgroundColor || '#fff', dirty: true };

  function txOpHelper(rect, text, cs) {
    return { a: 'tx', x: R(rect.left + 4), y: R(rect.top + rect.height * 0.7), t: text.slice(0, 40),
             s: 12, w: 400, f: 'sans-serif', c: '#889' };
  }
})`;

module.exports = { DL_COLLECTOR };
