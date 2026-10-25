'use strict';

// Isolated diagnostic host, never part of the package's normal entrypoint.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const v8 = require('node:v8');
const { PerformanceObserver } = require('node:perf_hooks');
const puppeteer = require('puppeteer').default;
const sharp = require('sharp');
const { createMirror } = require('..');
const group = process.env.MEMORY_GROUP || 'default';
if (!['default', 'gc', 'cache-off', 'gc-cache-off'].includes(group)) throw new Error('Invalid MEMORY_GROUP');
if (typeof global.gc !== 'function') throw new Error('Run all groups with --expose-gc');
const output = process.env.EVIDENCE_DIR;
if (!output) throw new Error('EVIDENCE_DIR required');
fs.mkdirSync(output, { recursive: true });
const originalCache = sharp.cache();
const native = process.env.MEMORY_NATIVE_PROBE === '1' ? require('./native-memory.node') : null;
const finalDiagnostics = process.env.MEMORY_FINAL_DIAGNOSTICS === '1';
if (finalDiagnostics && !native) throw new Error('Final diagnostics require the native probe');
if (group.includes('cache-off')) sharp.cache(false);
const browsers = [], samples = [], checkpoints = [], collections = [];
const observer = new PerformanceObserver(list => {
  for (const entry of list.getEntries()) collections.push({ start: entry.startTime, duration: entry.duration, kind: entry.detail.kind });
});
observer.observe({ entryTypes: ['gc'] });
const launch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async options => {
  // Compare the Node allocator only; never preload it into Chromium subprocesses.
  const env = { ...process.env, ...options.env, LD_PRELOAD: '', MALLOC_CONF: '' };
  const browser = await launch({ ...options, env });
  const record = { pid: browser.process().pid, closed: false, connected: true,
    jemallocMapped: fs.readFileSync(`/proc/${browser.process().pid}/maps`, 'utf8').includes('libjemalloc') };
  browser.once('disconnected', () => { record.connected = false; });
  const close = browser.close.bind(browser);
  browser.close = async () => { await close(); record.closed = true; };
  browsers.push(record);
  return browser;
};
const mirror = createMirror({ originUrl: 'http://load:9000/', maxSessions: 3, sessionGraceMs: 3000,
  defaultMode: 'frame', obfuscate: false, getSessionIdentity: () => 'synthetic-memory', logger: { log() {} } });
const started = performance.now();
let cycle = 0, phase = 'baseline';
function fields(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => {
    const [key, value] = line.trim().split(/\s+/); return [key.replace(/:$/, ''), Number(value)];
  }));
}
function sample() {
  const stat = fields('/sys/fs/cgroup/memory.stat');
  const cpu = fields('/sys/fs/cgroup/cpu.stat');
  const processStat = fields('/proc/self/status');
  const heap = v8.getHeapStatistics();
  const row = { ms: performance.now() - started, cycle, phase, node: process.memoryUsage(),
    cgroup: { memory: Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8')), anon: stat.anon, file: stat.file,
      oomKills: fields('/sys/fs/cgroup/memory.events').oom_kill, cpuUsec: cpu.usage_usec },
    process: { rssAnonKiB: processStat.RssAnon, rssFileKiB: processStat.RssFile },
    heap: { used: heap.used_heap_size, external: heap.external_memory, nativeContexts: heap.number_of_native_contexts },
    sharpCache: sharp.cache(), sharpCounters: sharp.counters() };
  samples.push(row);
  return row;
}
function status() {
  return { launched: browsers.length, browsers: browsers.map(record => ({ ...record, processGone: !fs.existsSync('/proc/' + record.pid) })) };
}
function save() {
  const files = ['server.js', 'client/index.html', 'lib/sessions.js', 'tools/fixtures/capacity.html', 'tools/profile-client.cjs',
    'tools/memory-host.cjs', 'tools/memory-client.cjs', 'tools/verify-docker-memory.sh'];
  if (native) files.push('tools/native-memory.c');
  fs.writeFileSync(path.join(output, 'server.json'), JSON.stringify({ group, node: process.version, originalCache,
    startedPerformanceMs: started,
    sharpConcurrency: sharp.concurrency(), sharpVersions: sharp.versions, gcForcedCalls, finalGcCalls, trimCalls,
    nativeProbe: native ? { glibc: native.glibc, env: { MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX,
      VIPS_CONCURRENCY: process.env.VIPS_CONCURRENCY, LD_PRELOAD: process.env.LD_PRELOAD || '',
      MALLOC_CONF: process.env.MALLOC_CONF || '' }, allocator: native.allocatorStats(), binarySha256: crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(__dirname, 'native-memory.node'))).digest('hex') } : null,
    samples, checkpoints, collections,
    status: status(), hashes: Object.fromEntries(files.map(file => [file, crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex')])) }, null, 2));
}
let gcForcedCalls = 0, finalGcCalls = 0, trimCalls = 0;
function nativeSnapshot(row) {
  if (!native) return;
  const allocator = native.allocatorStats();
  row.native = { allocator, mallocInfo: allocator.implementation === 'glibc' ? native.snapshot() : null,
    smapsRollup: fields('/proc/self/smaps_rollup'), heapSpaces: v8.getHeapSpaceStatistics() };
}
function saveMappings() {
  if (process.env.MEMORY_MAPS !== '1') return;
  if (phase !== 'baseline' && phase !== 'finalSettled' && !(phase === 'postIdle' && cycle === Number(process.env.MEMORY_CYCLES))) return;
  const prefix = `${cycle}-${phase}`;
  fs.writeFileSync(path.join(output, prefix + '-smaps.txt'), fs.readFileSync('/proc/self/smaps'));
  fs.writeFileSync(path.join(output, prefix + '-v8.json'), JSON.stringify({ heap: v8.getHeapStatistics(), spaces: v8.getHeapSpaceStatistics(),
    processStatus: fields('/proc/self/status') }));
}
sample();
const interval = setInterval(sample, 250); interval.unref();
const server = http.createServer(async (req, res) => {
  if (req.url === '/__memory/status') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status())); return; }
  if (req.method === 'POST' && req.url.startsWith('/__memory/checkpoint/')) {
    const parts = req.url.slice('/__memory/checkpoint/'.length).split('/');
    cycle = Number(parts[0]); phase = parts[1];
    const before = sample();
    const inspectNative = phase === 'baseline' || phase === 'postIdle' || phase.startsWith('final');
    if (inspectNative) nativeSnapshot(before);
    if (phase === 'postIdle' && (group === 'gc' || group === 'gc-cache-off')) {
      for (let i = 0; i < 2; i++) { global.gc(); gcForcedCalls++; await new Promise(resolve => setImmediate(resolve)); }
    }
    let trimReleased = null;
    if (finalDiagnostics && phase === 'finalGc') {
      for (let i = 0; i < 2; i++) { global.gc(); finalGcCalls++; await new Promise(resolve => setImmediate(resolve)); }
    }
    if (finalDiagnostics && phase === 'finalTrim') { trimReleased = native.trim(); trimCalls++; }
    if (phase === 'finalGc' || phase === 'finalTrim') await new Promise(resolve => setTimeout(resolve, 100));
    const after = sample();
    if (inspectNative) nativeSnapshot(after);
    const checkpoint = { cycle, phase, before, after, trimReleased, status: status() };
    checkpoints.push(checkpoint);
    // Avoid serializing the growing full trace during measurements; that would add GC pressure.
    fs.appendFileSync(path.join(output, 'checkpoints.jsonl'), JSON.stringify(checkpoint) + '\n');
    saveMappings();
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(checkpoint)); return;
  }
  mirror.handleRequest(req, res);
});
server.on('upgrade', mirror.handleUpgrade);
server.listen(8088, '0.0.0.0');
let closing;
function close() {
  return closing ??= (async () => {
    const stopped = new Promise(resolve => server.close(resolve));
    await mirror.close(); server.closeAllConnections(); await stopped;
    clearInterval(interval); sample(); save(); observer.disconnect();
  })();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => close().catch(error => { console.error(error); process.exitCode = 1; }));
