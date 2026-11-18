// 客户端 CanvasKit SkPicture 重放器 — 集成到 DL 模式
// 接收 {type:'skp', rect, data} WS 帧 → CanvasKit MakePicture → drawPicture（无损）
// 此文件为客户端 index.html 中 DL 段的扩展模块（IIFE 内注入）
'use strict';

// CanvasKit 加载器（懒加载 2.5MB wasm，首次 skp 帧到达时才拉）
let _ck = null, _ckLoading = null;
function ensureCanvasKit() {
  if (_ck) return Promise.resolve(_ck);
  if (_ckLoading) return _ckLoading;
  _ckLoading = new Promise((resolve, reject) => {
    // 从 unpkg/jsdelivr 拉 canvaskit（或从引擎 /f/canvaskit.wasm 本地端点）
    import('https://unpkg.com/canvaskit-wasm@0.39.1/bin/canvaskit.js')
      .then(mod => mod.default({ locateFile: f => 'https://unpkg.com/canvaskit-wasm@0.39.1/bin/' + f }))
      .then(CK => { _ck = CK; resolve(CK); })
      .catch(reject);
  });
  return _ckLoading;
}

// SkPicture 层缓存：rect → {picture, bytes}
const skpLayers = new Map();
let skpSurface = null;

// 处理 skp 帧：base64 → MakePicture → 存层 → 触发重绘
async function dlSkpFrame(j) {
  if (!j.data || !j.rect) return;
  const CK = await ensureCanvasKit();
  const buf = base64ToBuffer(j.data);
  const pic = CK.MakePicture(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  if (!pic) return;
  const key = j.rect.join('x');
  skpLayers.set(key, { picture: pic, rect: j.rect });
  // 触发 DL 画布重绘（skp 层叠加在 DL 指令层之上）
  dlReplay();
}

// SkPicture 层绘制（在 dlReplay 的指令绘制完成后调用）
function dlDrawSkpLayers(canvas) {
  if (!skpLayers.size || !_ck) return;
  const sorted = [...skpLayers.values()].sort((a, b) =>
    (a.rect[2] * a.rect[3]) - (b.rect[2] * b.rect[3]));
  for (const l of sorted) {
    canvas.save();
    canvas.translate(l.rect[0], l.rect[1]);
    canvas.drawPicture(l.picture);
    canvas.restore();
  }
}

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

// 导出（供 DL 段集成）
if (typeof window !== 'undefined') {
  window.__xyDlSkp = { dlSkpFrame, dlDrawSkpLayers, ensureCanvasKit, skpLayers };
}
