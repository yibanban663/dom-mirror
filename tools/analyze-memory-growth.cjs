'use strict';
// Offline only: no Chromium, allocator mutation, or access to a running host.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readTrace } = require('./memory-trace.cjs');
const mib = bytes => bytes / 2 ** 20;

function analyze(directory) {
  const input = path.join(directory, 'server.json');
  const raw = fs.readFileSync(input);
  const host = readTrace(directory, JSON.parse(raw));
  const points = host.checkpoints.filter(point => point.phase === 'postIdle');
  assert.ok(points.length >= 2, 'Need repeated normal checkpoints');
  assert.deepEqual(points.map(point => point.cycle), Array.from({ length: points.length }, (_, i) => i + 1));
  assert.equal(host.gcForcedCalls, 0, 'Analyze normal cycles without forced GC');
  const baseline = host.checkpoints.find(point => point.phase === 'baseline').after;
  const series = points.map((point, index) => {
    const row = point.after;
    assert.equal(row.native.allocator.implementation, 'jemalloc');
    assert.ok(point.status.browsers.every(browser => browser.closed && !browser.connected && browser.processGone));
    const previous = index ? points[index - 1].after : baseline;
    const physical = value => mib(value.native.heapSpaces.reduce((total, space) => total + space.physical_space_size, 0));
    const gcThrough = value => host.collections.filter(event => event.start <= host.startedPerformanceMs + value.ms).length;
    return { cycle: point.cycle, anonGrowthMiB: mib(row.cgroup.anon - baseline.cgroup.anon),
      anonMiB: mib(row.cgroup.anon), nodeAnonMiB: row.process.rssAnonKiB / 1024,
      heapUsedMiB: mib(row.node.heapUsed), heapCapacityMiB: mib(row.node.heapTotal),
      v8PhysicalMiB: physical(row), externalMiB: mib(row.node.external), arrayBuffersMiB: mib(row.node.arrayBuffers),
      jemallocAllocatedMiB: mib(row.native.allocator.allocated), jemallocResidentMiB: mib(row.native.allocator.resident),
      nativeContexts: row.heap.nativeContexts,
      changeSincePrevious: { anonMiB: mib(row.cgroup.anon - previous.cgroup.anon),
        v8PhysicalMiB: physical(row) - physical(previous),
        jemallocResidentMiB: mib(row.native.allocator.resident - previous.native.allocator.resident) },
      gcEventsSincePrevious: gcThrough(row) - gcThrough(previous),
      traceRecordsThroughCheckpoint: { samples: host.samples.filter(sample => sample.ms <= row.ms).length,
        checkpoints: host.checkpoints.indexOf(point) + 1, gcEvents: gcThrough(row), browsers: point.status.browsers.length } };
  });
  return { scope: 'Offline checkpoint correlation, not allocation ownership or a new workload measurement',
    inputHashes: Object.fromEntries(['server.json', ...(host.traceStorage === 'disk'
      ? ['samples.jsonl', 'checkpoints.jsonl', 'collections.jsonl'] : [])].map(file => [file,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex')])), sourceHashes: host.hashes,
    traceStorage: host.traceStorage || 'memory',
    traceRecords: { samples: host.samples.length, checkpoints: host.checkpoints.length, collections: host.collections.length,
      browsers: host.status.browsers.length },
    series, finalDiagnostics: host.checkpoints.filter(point => point.phase.startsWith('final')).map(point => ({
      phase: point.phase, anonMiB: mib(point.after.cgroup.anon), heapUsedMiB: mib(point.after.node.heapUsed),
      heapCapacityMiB: mib(point.after.node.heapTotal),
      v8PhysicalMiB: mib(point.after.native.heapSpaces.reduce((sum, space) => sum + space.physical_space_size, 0)),
      jemallocResidentMiB: mib(point.after.native.allocator.resident) })),
    limitations: ['Allocator and V8 statistics may overlap; do not add or subtract them to assign mapping ownership',
      'Trace record counts do not measure their resident size; original evidence has no cycle-18 full smaps or allocation stacks',
      'Disk mode still allocates temporary serialization buffers, holds browser scalar records and checkpoint request state, and adds synchronous I/O'] };
}
if (require.main === module) {
  if (!process.argv[2] || !process.argv[3]) throw Error('Usage: node tools/analyze-memory-growth.cjs GROUP_DIRECTORY OUTPUT_JSON');
  fs.writeFileSync(process.argv[3], JSON.stringify(analyze(process.argv[2]), null, 2) + '\n', { flag: 'wx' });
}
module.exports = { analyze };
