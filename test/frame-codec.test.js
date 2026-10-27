'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { frameCropInput, scanDirtyRows, dirtyRects } = require('../lib/frame-codec');

// Remove encoder density metadata to match the plain PNGs returned by CDP.
function plainPng(png) {
  const chunks = [png.subarray(0, 8)];
  for (let offset = 8; offset < png.length;) {
    const end = offset + 12 + png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) !== 'pHYs') chunks.push(png.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(chunks);
}
function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const b of body) {
    crc ^= b;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4), footer = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length); footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, footer]);
}
async function fixture(channels) {
  const data = Buffer.alloc(12 * 8 * channels);
  for (let i = 0; i < 12 * 8; i++) {
    data[i * channels] = (i * 31) % 256;
    data[i * channels + 1] = (i * 13) % 256;
    data[i * channels + 2] = (i * 7) % 256;
    if (channels === 4) data[i * channels + 3] = (i * 17) % 256;
  }
  return plainPng(await sharp(data, { raw: { width: 12, height: 8, channels } }).png().toBuffer());
}
async function compare(png, decoded) {
  for (const rect of [{ left: 0, top: 0, width: 12, height: 8 }, { left: 2, top: 1, width: 5, height: 3 }]) {
    const old = await sharp(png).extract(rect).png({ compressionLevel: 3 }).toBuffer();
    const current = await frameCropInput(sharp, png, decoded).extract(rect).png({ compressionLevel: 3 }).toBuffer();
    const a = await sharp(old).ensureAlpha().raw().toBuffer();
    const b = await sharp(current).ensureAlpha().raw().toBuffer();
    assert.ok(a.equals(b), 'all RGBA pixels must match, including alpha');
    assert.equal((await sharp(current).metadata()).channels, (await sharp(old).metadata()).channels);
  }
}
for (const channels of [3, 4]) test('plain ' + channels + '-channel PNG reuses decoded pixels without colour or alpha changes', async () => {
  const png = await fixture(channels);
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  await compare(png, decoded);
  const changed = { ...decoded, data: Buffer.alloc(decoded.data.length) };
  const output = await frameCropInput(sharp, png, changed).raw().toBuffer();
  assert.ok(output.every(value => value === 0), 'plain PNG must actually use the supplied raw buffer');
});
test('RGB transparency keys retain alpha through the original PNG path', async () => {
  const base = await fixture(3);
  const trns = chunk('tRNS', Buffer.from([0, 0, 0, 0, 0, 0]));
  const png = Buffer.concat([base.subarray(0, 33), trns, base.subarray(33)]);
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.data[3], 0, 'transparent black key is present');
  await compare(png, { ...decoded, data: Buffer.alloc(decoded.data.length) });
});
test('colour metadata, grayscale and palette PNGs preserve the original decoding path', async () => {
  const base = await fixture(4);
  const fixtures = [
    await sharp(base).withMetadata({ density: 144 }).png().toBuffer(),
    await sharp(base).toColourspace('b-w').png().toBuffer(),
    await sharp(base).png({ palette: true }).toBuffer(),
  ];
  for (const png of fixtures) {
    const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    await compare(png, { ...decoded, data: Buffer.alloc(decoded.data.length) });
  }
});

test('dirty row scan ignores alpha-only and sub-threshold changes', () => {
  const W = 3, H = 4, prev = Buffer.alloc(W * H * 4, 100);
  const next = Buffer.from(prev);
  next[3] = 0; // row 0: alpha only
  next[W * 4 + 1] = 102; // row 1: within threshold 2
  next[2 * W * 4 + 8] = 103; // row 2: last pixel over threshold
  const { dirtyRows, any } = scanDirtyRows(next, prev, W, H, 4);
  assert.deepEqual([...dirtyRows], [0, 0, 1, 0]);
  assert.equal(any, true);
  assert.equal(scanDirtyRows(prev, Buffer.from(prev), W, H, 4).any, false);
});

test('dirty rows merge into full-width runs and collapse past eight runs', () => {
  assert.deepEqual(dirtyRects(Uint8Array.from([1, 1, 0, 1]), 5, 4), [[0, 0, 5, 2], [0, 3, 5, 1]]);
  const striped = Uint8Array.from({ length: 18 }, (_, y) => y % 2);
  assert.deepEqual(dirtyRects(striped, 5, 18), [[0, 0, 5, 18]]);
});
