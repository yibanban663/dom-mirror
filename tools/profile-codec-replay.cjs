'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const codecInput = require('./profile-codec.cjs');
const directory = process.env.PROFILE_DIR;
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, p50Ms: sorted[Math.ceil(values.length * 0.5) - 1], p95Ms: sorted[Math.ceil(values.length * 0.95) - 1] };
}
async function execute(test, reuse) {
  const decoded = await sharp(test.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const tiles = [];
  for (const rect of test.rects) tiles.push(await codecInput(test.png, decoded, reuse).extract(rect).png({ compressionLevel: 3 }).toBuffer());
  return tiles;
}
async function main() {
  if (!directory) throw new Error('Set PROFILE_DIR to an isolated captured frame directory');
  const png = fs.readFileSync(path.join(directory, 'frame-00.png'));
  const metadata = await sharp(png).metadata(), w = metadata.width, h = metadata.height;
  const cases = [
    { name: 'captured-full-frame', png, rects: [{ left: 0, top: 0, width: w, height: h }] },
    { name: 'captured-one-band', png, rects: [{ left: 0, top: 0, width: w, height: Math.min(128, h) }] },
    { name: 'captured-eight-bands', png, rects: Array.from({ length: 8 }, (_, i) => ({ left: 0, top: i * Math.floor(h / 8), width: w, height: Math.min(16, Math.floor(h / 8)) })) },
    { name: 'transparent-rgba', png: await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.5 } } }).png().toBuffer(), rects: [{ left: 4, top: 4, width: 32, height: 32 }] },
    { name: 'grayscale-fallback', png: await sharp({ create: { width: 64, height: 64, channels: 3, background: '#555' } }).toColourspace('b-w').png().toBuffer(), rects: [{ left: 4, top: 4, width: 32, height: 32 }] },
  ];
  const results = [];
  for (const test of cases) {
    if (test.name === 'grayscale-fallback') assert.equal(test.png[25], 0, 'fallback fixture must be grayscale PNG');
    if (test.name === 'transparent-rgba') assert.equal(test.png[25], 6, 'transparent fixture must be RGBA PNG');
    const original = await execute(test, false), reuse = await execute(test, true);
    for (let i = 0; i < original.length; i++) {
      const a = await sharp(original[i]).ensureAlpha().raw().toBuffer();
      const b = await sharp(reuse[i]).ensureAlpha().raw().toBuffer();
      assert.ok(a.equals(b), test.name + ' decoded tile pixels must match');
    }
    const times = { png: [], raw: [] }, cpu = { png: [], raw: [] };
    for (let i = 0; i < 23; i++) {
      for (const variant of i % 2 ? ['raw', 'png'] : ['png', 'raw']) {
        const cpuStart = process.cpuUsage(), start = performance.now();
        await execute(test, variant === 'raw');
        const elapsed = performance.now() - start, usage = process.cpuUsage(cpuStart);
        if (i >= 3) { times[variant].push(elapsed); cpu[variant].push((usage.user + usage.system) / 1000); }
      }
    }
    results.push({ name: test.name, pngColourType: test.png[25], rectCount: test.rects.length, pixelEqual: true, png: summary(times.png), raw: summary(times.raw), cpuMs: { png: summary(cpu.png), raw: summary(cpu.raw) }, pngBytes: original.reduce((n, b) => n + b.length, 0), rawBytes: reuse.reduce((n, b) => n + b.length, 0) });
  }
  const result = { pass: true, definition: 'decode RGBA once plus all crop/encode calls; excludes JS scan and network; alternating AB/BA order', results };
  fs.writeFileSync(path.join(directory, 'codec-comparison.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
