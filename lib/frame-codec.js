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

module.exports = { frameCropInput };
