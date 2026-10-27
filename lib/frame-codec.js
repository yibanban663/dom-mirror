'use strict';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function frameCropInput(sharp, png, decoded) {
  // Only reuse plain Chromium RGB(A) PNGs. Preserve the original pipeline for
  // transparency keys, colour metadata and other formats/encodings.
  const plain = png.length >= 41 && png.subarray(0, 8).equals(PNG_SIGNATURE)
    && png.readUInt32BE(8) === 13 && png.toString('ascii', 12, 16) === 'IHDR'
    && png[24] === 8 && (png[25] === 2 || png[25] === 6)
    && png[26] === 0 && png[27] === 0 && png[28] === 0
    && png.toString('ascii', 37, 41) === 'IDAT';
  if (!plain) return sharp(png);
  const pipeline = sharp(decoded.data, { raw: {
    width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels,
  } });
  return png[25] === 2 ? pipeline.removeAlpha() : pipeline;
}

// 逐像素比较找脏行（Uint32 视图加速；行级先筛再列级细化）。data/prevRaw 为同尺寸 raw 帧
function scanDirtyRows(data, prevRaw, W, H, CH) {
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
  return { dirtyRows, any };
}

// 行程合并成矩形（按连续脏行段，列取整行宽——screencast 帧内横向裁剪收益小
// 且增加编码次数；行段合并上限 8 段防碎片）
function dirtyRects(dirtyRows, W, H) {
  const rects = [];
  let y0 = -1;
  for (let y = 0; y <= H; y++) {
    const d2 = y < H && dirtyRows[y];
    if (d2 && y0 < 0) y0 = y;
    else if (!d2 && y0 >= 0) { rects.push([0, y0, W, y - y0]); y0 = -1; }
  }
  // 超过 8 段合并为整帧一张
  return rects.length > 8 ? [[0, 0, W, H]] : rects;
}

module.exports = { frameCropInput, scanDirtyRows, dirtyRects };
