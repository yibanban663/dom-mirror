'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readTrace } = require('./memory-trace.cjs');
const { analyze } = require('./analyze-memory-growth.cjs');
const root = process.argv[2];
if (!root) throw Error('Usage: node tools/summarize-trace-pair.cjs EVIDENCE_ROOT');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const protocol = read(path.join(root, 'protocol.json'));
assert.deepEqual([...protocol.order].sort(), ['disk', 'memory']);
const runs = ['memory', 'disk'].map(storage => {
  const directory = path.join(root, storage), groupDirectory = path.join(directory, 'default');
  const report = read(path.join(directory, 'summary.json')), group = report.groups[0];
  const metadata = read(path.join(groupDirectory, 'server.json'));
  const host = readTrace(groupDirectory, metadata);
  const containers = read(path.join(groupDirectory, 'containers.json'));
  const preflight = read(path.join(directory, 'preflight.json'));
  const client = read(path.join(groupDirectory, 'client.json'));
  assert.equal(report.complete, true);
  assert.equal(report.plan.traceStorage, storage);
  assert.equal(group.image, protocol.mirrorImage);
  assert.equal(report.plan.cycles, 30);
  assert.ok([16, 17, 18, 19, 20].every(cycle => report.plan.mappingCycles.includes(cycle)));
  assert.equal(group.operations, 900);
  assert.equal(group.sourceReceipts, 900);
  assert.equal(group.forcedGcCalls, 0);
  assert.equal(group.finalGcCalls, 2);
  assert.equal(group.trimCalls, 0);
  assert.equal(host.status.browsers.length, 90);
  assert.ok(host.status.browsers.every(browser => browser.closed && !browser.connected && browser.processGone && browser.jemallocMapped === false));
  assert.ok(preflight.passed && preflight.mapped && preflight.allocator === 'jemalloc' && preflight.allocatedDelta >= preflight.liveBufferBytes);
  assert.equal(preflight.liveBufferBytes, 64 * 2 ** 20);
  for (const [index, cpus, memoryGiB] of [[0, 2, 2], [1, 4, 4]]) {
    assert.equal(containers[index].State.Running, false);
    assert.equal(containers[index].State.OOMKilled, false);
    assert.equal(containers[index].State.ExitCode, 0);
    assert.equal(containers[index].Image, group.image);
    assert.equal(containers[index].HostConfig.NanoCpus, cpus * 1e9);
    assert.equal(containers[index].HostConfig.Memory, memoryGiB * 2 ** 30);
  }
  assert.ok(!containers[1].Config.Env.some(value => value.startsWith('LD_PRELOAD=') && value !== 'LD_PRELOAD='));
  const phases = ['0-baseline', ...report.plan.mappingCycles.map(cycle => `${cycle}-postIdle`), '30-postIdle', '30-finalSettled'];
  const mappings = Object.fromEntries([...new Set(phases)].map(phase => [phase, JSON.parse(execFileSync(process.execPath,
    [path.join(__dirname, 'summarize-allocator.cjs'), '--maps', path.join(groupDirectory, phase + '-smaps.txt')], { encoding: 'utf8' }))]));
  const timings = client.cycles.flatMap(cycle => cycle.operations.map(operation => {
    assert.ok(Number.isFinite(operation.domMs) && Number.isFinite(operation.paintOpportunityMs));
    return Math.max(operation.domMs, operation.paintOpportunityMs);
  })).sort((a, b) => a - b);
  const percentile = fraction => timings[Math.ceil(timings.length * fraction) - 1];
  return { storage, report, preflight, nativeBinarySha256: host.nativeProbe.binarySha256, mappings,
    confirmationTimingMs: { scope: 'Arm to both DOM and canvas/rAF confirmation; descriptive only, no latency qualification',
      count: timings.length, median: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: timings.at(-1) },
    jsonlBytes: Object.fromEntries(['samples', 'checkpoints', 'collections'].map(kind => {
      const file = path.join(groupDirectory, kind + '.jsonl'); return [kind, fs.existsSync(file) ? fs.statSync(file).size : 0];
    })),
    peakCgroupFileMiB: Math.max(...host.samples.map(sample => sample.cgroup.file)) / 2 ** 20,
    hostWindow: { started: containers[0].State.StartedAt, finished: containers[0].State.FinishedAt },
    traceCounts: host.traceCounts,
    retainedTraceRows: Object.fromEntries(['samples', 'checkpoints', 'collections'].map(kind => [kind, metadata[kind].length])),
    analysis: analyze(groupDirectory) };
});
const [memory, disk] = runs;
const normalizedPlan = run => { const { traceStorage, ...plan } = run.report.plan; return plan; };
assert.deepEqual(normalizedPlan(memory), normalizedPlan(disk));
assert.deepEqual(memory.report.groups[0].hashes, disk.report.groups[0].hashes);
assert.equal(memory.report.groups[0].image, disk.report.groups[0].image);
assert.equal(memory.nativeBinarySha256, disk.nativeBinarySha256);
const [first, second] = protocol.order.map(storage => runs.find(run => run.storage === storage));
assert.ok(Date.parse(first.hostWindow.finished) <= Date.parse(second.hostWindow.started), 'Profiles must run in declared order without overlap');
const result = { scope: 'Matched thirty-cycle trace storage profiles; terminal GC excluded from normal memory budgets',
  complete: true, samePlanExceptStorage: true, sameImageAndSources: true, protocol, runs };
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(runs.map(run => ({ storage: run.storage, budget: run.report.groups[0].normalCleanupBudget,
  lastGrowthMiB: run.report.groups[0].cycles.at(-1).anonGrowthMiB }))));
