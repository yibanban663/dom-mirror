'use strict';
// 客户端交互 → 源站页面：无会话状态的输入派发（page.evaluate 回调在 Chromium 页面内执行）

const KEYMAP = {
  Backspace: 8, Enter: 13, Tab: 9, Escape: 27, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35,
};

const refOf = (m) => (m.id !== undefined ? m.id : m.path);

// 客户端镜像 DOM 上的真实交互 → 服务端真实页面元素（v0.12：按 id 定位）；返回是否命中
async function domAction(page, m) {
  return page.evaluate((kind, ref, value) => {
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
  }, m.kind, refOf(m), m.kind === 'ce' ? m.html : m.value);
}

async function mouse(page, cdp, m) {
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
}

async function key(cdp, m) {
  const k = m.key;
  if (KEYMAP[k]) {
    const args = { type: m.action === 'up' ? 'keyUp' : 'keyDown', key: k, code: k, windowsVirtualKeyCode: KEYMAP[k], nativeVirtualKeyCode: KEYMAP[k] };
    if (m.action !== 'up' && k === 'Enter') args.text = '\r';
    await cdp.send('Input.dispatchKeyEvent', args);
  } else if (m.text) {
    if (m.action !== 'up') await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: m.text, key: m.text, unmodifiedText: m.text });
    else await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: m.text });
  }
}

// HTML5 拖拽（v0.19）：客户端镜像上 dragstart/over/drop → 源站合成
// DragEvent（DataTransfer 带 text/plain 载荷，drop 时可读取）。
// dragover/drop 目标按坐标命中（elementFromPoint），与原生语义一致
async function dnd(page, m) {
  return page.evaluate((kind, x, y, id, text, types) => {
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
  }, m.kind, Math.round(m.x || 0), Math.round(m.y || 0), m.id, m.text, m.types);
}

// 触摸（v0.19）：客户端 touchstart/move/end → CDP dispatchTouchEvent。
// 源站按访客真实触点响应（移动端访客的列表滑动/长按等手势语义）
async function touch(cdp, m) {
  const pts = Array.isArray(m.pts) ? m.pts.map((p) => ({ x: Math.round(p[0]), y: Math.round(p[1] )})) : [];
  const type = m.kind === 'start' ? 'touchStart' : m.kind === 'move' ? 'touchMove' : 'touchEnd';
  const args = { type, touchPoints: pts };
  if (type === 'touchEnd') { args.touchPoints = []; args.releaseTouchPoints = pts; }
  return cdp.send('Input.dispatchTouchEvent', args);
}

async function focusRef(page, m) {
  if (m.id === undefined && m.path === undefined) return;
  await page.evaluate((ref) => {
    const el = window.__xy.find(ref);
    if (el && el.focus && !el.disabled) el.focus();
  }, refOf(m)).catch(() => {});
}

// IME 组合镜像（v0.13）：客户端 compositionstart/update → CDP
// imeSetComposition 把候选串写进源站焦点字段（远端可见拼音过程）
async function composition(page, cdp, m) {
  await focusRef(page, m);
  const text = String(m.text || '');
  const len = [...text].length;
  let s = Math.max(0, Math.min(parseInt(m.s, 10) || 0, len));
  let e = Math.max(s, Math.min(parseInt(m.e, 10) || 0, len));
  await cdp.send('Input.imeSetComposition', { text, selectionStart: s, selectionEnd: e });
}

// IME 上屏（v0.13）：compositionend → CDP insertText 键入最终文本
async function compositionCommit(page, cdp, m) {
  await focusRef(page, m);
  await cdp.send('Input.insertText', { text: String(m.text || '') });
}

// v3 dom 模式：客户端本地原生滚动（零延迟），滚动位置上报到服务端——
// 服务端页面跟到同位置（懒加载/锚点/后续补丁裁剪坐标才正确），
// 内部滚动容器一并同步
async function scroll(page, m) {
  return page.evaluate((x, y, inner) => {
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
  }, m.x || 0, m.y || 0, m.inner || []);
}

module.exports = { domAction, mouse, key, dnd, touch, composition, compositionCommit, scroll };
