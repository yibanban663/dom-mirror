'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const output = process.env.PROFILE_DIR;
const { scanDirtyRows: js } = require('../lib/frame-codec');
function measure(action) {
  const values = [];
  for (let i = 0; i < 60; i++) {
    const start = performance.now();
    action();
    if (i >= 10) values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  return { count: values.length, p50Ms: values[24], p95Ms: values[47] };
}
async function main() {
  if (!output) throw new Error('Set PROFILE_DIR to captured frames and compiled kernels');
  const wasm = (await WebAssembly.instantiate(fs.readFileSync(path.join(output, 'scan.wasm')))).instance.exports;
  const frames = [];
  for (const name of fs.readdirSync(output).filter(n => /^frame-\d+\.png$/.test(n)).sort()) {
    frames.push(await sharp(path.join(output, name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }));
  }
  if (frames.length < 2) throw new Error('Need at least two captured frames');
  const { width: w, height: h } = frames[0].info, size = w * h * 4;
  const a = wasm.alloc(size), b = wasm.alloc(size), out = wasm.alloc(h);
  const memory = new Uint8Array(wasm.memory.buffer);
  const pairs = [{ name: 'unchanged', a: frames[0].data, b: Buffer.from(frames[0].data) }];
  for (let i = 1; i < frames.length; i++) {
    assert.equal(frames[i].data.length, size);
    pairs.push({ name: 'captured-' + i, a: frames[i].data, b: frames[i - 1].data });
  }
  const threshold = Buffer.from(frames[0].data), alpha = Buffer.from(frames[0].data), edge = Buffer.from(frames[0].data);
  threshold[0] = threshold[0] < 253 ? threshold[0] + 2 : threshold[0] - 2;
  alpha[3] ^= 255;
  edge[size - 4] = edge[size - 4] > 127 ? 0 : 255;
  pairs.push({ name: 'threshold-2', a: threshold, b: frames[0].data }, { name: 'alpha-only', a: alpha, b: frames[0].data }, { name: 'last-pixel', a: edge, b: frames[0].data });
  // Warm the original JS kernel across all cases before comparing it to AOT code.
  for (let i = 0; i < 1500; i++) {
    const p = pairs[i % pairs.length];
    js(p.a, p.b, w, h, 4);
    memory.set(p.a, a); memory.set(p.b, b);
    wasm.scan(a, b, out, w, h);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-mirror-scan-'));
  const results = [];
  try {
    for (const pair of pairs) {
      const expected = js(pair.a, pair.b, w, h, 4);
      memory.set(pair.a, a); memory.set(pair.b, b);
      const changedRows = wasm.scan(a, b, out, w, h);
      assert.deepEqual(memory.slice(out, out + h), expected.dirtyRows, pair.name + ' row mask');
      assert.equal(changedRows > 0, expected.any, pair.name + ' changed flag');
      const jsTime = measure(() => js(pair.a, pair.b, w, h, 4));
      const wasmKernel = measure(() => wasm.scan(a, b, out, w, h));
      const wasmWithCopies = measure(() => {
        memory.set(pair.a, a); memory.set(pair.b, b);
        wasm.scan(a, b, out, w, h);
        memory.slice(out, out + h);
      });
      const wasmRetainedPrevious = measure(() => {
        // Previous decoded frame already resides in Wasm memory; copy only the new one.
        memory.set(pair.a, a);
        wasm.scan(a, b, out, w, h);
        memory.slice(out, out + h);
      });
      const afile = path.join(temporary, 'a.raw'), bfile = path.join(temporary, 'b.raw');
      fs.writeFileSync(afile, pair.a); fs.writeFileSync(bfile, pair.b);
      const native = spawnSync(path.join(output, 'scan-native'), [String(w), String(h), afile, bfile], { encoding: 'utf8', timeout: 10000 });
      if (native.status !== 0) throw new Error('Native kernel failed: ' + native.stderr);
      const nativeKernel = JSON.parse(native.stdout);
      assert.equal(nativeKernel.changedRows, changedRows);
      results.push({ name: pair.name, changedRows, js: jsTime, wasmKernel, wasmWithCopies, wasmRetainedPrevious, nativeKernel });
    }
    fs.writeFileSync(path.join(output, 'scan-comparison.json'), JSON.stringify({ width: w, height: h, copiedInputBytes: { bothFrames: size * 2, retainedPrevious: size }, pass: true, results }, null, 2));
    console.log(JSON.stringify({ pass: true, pairs: results.length, results }));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
