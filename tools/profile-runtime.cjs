'use strict';
// Loaded only by profile-server.cjs; never enabled in the normal server entrypoint.
const fs = require('node:fs');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const codecInput = require('./profile-codec.cjs');
const output = process.env.PROFILE_DIR || '/tmp/perf-evidence';
fs.mkdirSync(output, { recursive: true });
const samples = new Map(), resources = [];
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
const started = performance.now(), cpuStart = process.cpuUsage();
let frameCount = 0, frameSequence = 0;
const enters = new Map(), sourceMarkers = new Map();
const frameCounts = { received: 0, overwritten: 0, consumed: 0 };

function record(name, ms, bytes) {
  if (!samples.has(name)) samples.set(name, { ms: [], bytes: 0 });
  const s = samples.get(name);
  s.ms.push(ms);
  s.bytes += bytes || 0;
}
function sampleResources() {
  const row = { elapsedMs: performance.now() - started, nodeRssBytes: process.memoryUsage().rss };
  try {
    row.cgroupMemoryBytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
    const cpu = Object.fromEntries(fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').trim().split('\n').map(line => line.split(' ')));
    row.cgroupCpuUsec = Number(cpu.usage_usec);
    row.cgroupThrottledUsec = Number(cpu.throttled_usec);
  } catch {}
  resources.push(row);
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] || 0;
  return { count: sorted.length, totalMs: values.reduce((a, b) => a + b, 0), p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
}
sampleResources();
setInterval(sampleResources, 500).unref();
process.once('exit', () => {
  sampleResources();
  const cpu = process.cpuUsage(cpuStart);
  const stages = Object.fromEntries([...samples].map(([name, s]) => [name, { ...distribution(s.ms), bytes: s.bytes }]));
  fs.writeFileSync(path.join(output, 'server-profile.json'), JSON.stringify({
    frameTickMs: Number(process.env.PROFILE_FRAME_TICK_MS || 16), codec: process.env.PROFILE_CODEC || 'production', presentationProbe: process.env.PROFILE_PRESENTATION === '1', nodeVersion: process.version, arch: process.arch, patchDelayMs: Number(process.env.PROFILE_PATCH_MS || 60),
    elapsedMs: performance.now() - started, nodeCpuMs: (cpu.user + cpu.system) / 1000,
    eventLoopDelay: { p50Ms: histogram.percentile(50) / 1e6, p95Ms: histogram.percentile(95) / 1e6, maxMs: histogram.max / 1e6 },
    stages, resources, frameCounts,
  }, null, 2));
});
module.exports = {
  record,
  queued(raw, receivedAt) {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m && m.type === 'key' && m.action === 'down' && m.key === 'Enter' && Number.isInteger(m._profileOp)) {
      enters.set(m._profileOp, { receivedAt, handledAt: performance.now() });
    }
  },
  sourceMarker(value) {
    if (Number.isInteger(value.index) && Number.isFinite(value.fromKeyMs)) sourceMarkers.set(value.index, { fromKeyMs: value.fromKeyMs, receivedAt: performance.now() });
  },
  receivedFrame(overwritten) {
    frameCounts.received++;
    if (overwritten) frameCounts.overwritten++;
    return { seq: ++frameSequence, receivedAt: performance.now() };
  },
  consumedFrame() { frameCounts.consumed++; },
  traceFrame(data, info, pf, consumeAt) {
    if (info.width <= 1260 || info.height <= 20) return null;
    const offset = (20 * info.width + 1260) * info.channels;
    if (data[offset + 1] !== 139 || data[offset + 2] !== 67) return null;
    const op = (data[offset] - 24) / 7 - 1, enter = enters.get(op);
    if (!Number.isInteger(op) || !enter || !pf.profile) return null;
    return {
      op, seq: pf.profile.seq,
      commandQueueMs: enter.handledAt - enter.receivedAt,
      handleToFrameMs: pf.profile.receivedAt - enter.handledAt,
      frameQueueMs: consumeAt - pf.profile.receivedAt,
      processingMs: performance.now() - consumeAt,
      enterReceivedToSerializeMs: performance.now() - enter.receivedAt,
      sourceKeyToMarkerMs: sourceMarkers.get(op)?.fromKeyMs ?? null,
      markerCallbackToFrameMs: sourceMarkers.has(op) ? pf.profile.receivedAt - sourceMarkers.get(op).receivedAt : null,
    };
  },
  codecInput(png, decoded) { return codecInput(png, decoded, process.env.PROFILE_CODEC !== 'png'); },
  async measure(name, action) {
    const start = performance.now();
    try { return await action(); } finally { record(name, performance.now() - start); }
  },
  json(value) {
    const start = performance.now();
    const payload = JSON.stringify(value);
    record('json.' + value.type, performance.now() - start, Buffer.byteLength(payload));
    return payload;
  },
  capture(b64) {
    if (frameCount >= 12) return;
    fs.writeFileSync(path.join(output, 'frame-' + String(frameCount++).padStart(2, '0') + '.png'), Buffer.from(b64, 'base64'));
  },
};
