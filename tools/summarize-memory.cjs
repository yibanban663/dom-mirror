'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
if (!root) throw new Error('Usage: node tools/summarize-memory.cjs EVIDENCE_ROOT');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const plan = read(path.join(root, 'plan.json'));
const mib = bytes => bytes / 2 ** 20;
function nativeStats(row) {
  if (!row.native) return null;
  if (row.native.allocator?.implementation === 'jemalloc') return Object.fromEntries(Object.entries(row.native.allocator)
    .map(([key, value]) => typeof value === 'number' ? [key + 'MiB', mib(value)] : [key, value]));
  const xml = row.native.mallocInfo.replace(/<heap\b[\s\S]*?<\/heap>/g, '');
  const size = pattern => {
    const match = xml.match(pattern);
    if (!match) throw new Error('Missing malloc_info aggregate');
    return Number(match[1]);
  };
  const system = size(/<system type="current" size="(\d+)"/);
  const fast = size(/<total type="fast" count="\d+" size="(\d+)"/);
  const rest = size(/<total type="rest" count="\d+" size="(\d+)"/);
  const mmap = size(/<total type="mmap" count="\d+" size="(\d+)"/);
  return { arenas: (row.native.mallocInfo.match(/<heap\b/g) || []).length,
    systemMiB: mib(system), freeMiB: mib(fast + rest), mmapMiB: mib(mmap),
    inUseEstimateMiB: mib(system - fast - rest + mmap),
    privateDirtyMiB: row.native.smapsRollup.Private_Dirty / 1024,
    anonymousMiB: row.native.smapsRollup.Anonymous / 1024 };
}
function slope(values) {
  const center = (values.length - 1) / 2, mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((sum, value, i) => sum + (i - center) * (value - mean), 0)
    / values.reduce((sum, _, i) => sum + (i - center) ** 2, 0);
}
const groups = [];
for (const group of plan.groups) {
  const directory = path.join(root, group), item = { group, complete: false }; groups.push(item);
  if (!fs.existsSync(path.join(directory, 'server.json')) || !fs.existsSync(path.join(directory, 'client.json'))) continue;
  const host = read(path.join(directory, 'server.json')), client = read(path.join(directory, 'client.json'));
  const baseline = host.checkpoints.find(point => point.phase === 'baseline')?.after;
  if (!baseline) continue;
  item.baseline = { anonMiB: mib(baseline.cgroup.anon), rssMiB: mib(baseline.node.rss), heapMiB: mib(baseline.node.heapUsed),
    heapTotalMiB: mib(baseline.node.heapTotal), externalMiB: mib(baseline.node.external),
    arrayBuffersMiB: mib(baseline.node.arrayBuffers), native: nativeStats(baseline) };
  item.cycles = host.checkpoints.filter(point => point.phase === 'postIdle').map(point => {
    const before = point.before, after = point.after;
    return { cycle: point.cycle, anonMiB: mib(after.cgroup.anon), anonGrowthMiB: mib(after.cgroup.anon - baseline.cgroup.anon),
      rssMiB: mib(after.node.rss), rssAnonMiB: after.process.rssAnonKiB / 1024, heapMiB: mib(after.node.heapUsed), heapTotalMiB: mib(after.node.heapTotal),
      externalMiB: mib(after.node.external), arrayBuffersMiB: mib(after.node.arrayBuffers),
      interventionReleased: { heapMiB: mib(before.node.heapUsed - after.node.heapUsed),
        externalMiB: mib(before.node.external - after.node.external), arrayBuffersMiB: mib(before.node.arrayBuffers - after.node.arrayBuffers),
        anonMiB: mib(before.cgroup.anon - after.cgroup.anon) },
      sharpCache: after.sharpCache, sharpCounters: after.sharpCounters,
      native: nativeStats(after),
      browsersGone: point.status.browsers.every(browser => browser.closed && !browser.connected && browser.processGone) };
  });
  const tail = item.cycles.slice(-5).map(point => point.anonMiB);
  item.lastFiveAnonSlopeMiBPerCycle = tail.length >= 2 ? slope(tail) : null;
  item.lastFiveAnonSpanMiB = tail.length ? Math.max(...tail) - Math.min(...tail) : null;
  const lastTen = item.cycles.slice(-10).map(point => point.anonMiB);
  item.lastTenAnonSlopeMiBPerCycle = lastTen.length >= 2 ? slope(lastTen) : null;
  item.lastTenAnonSpanMiB = lastTen.length ? Math.max(...lastTen) - Math.min(...lastTen) : null;
  if (plan.budget) item.normalCleanupBudget = { limitMiB: plan.budget.postCleanupAnonGrowthMiB,
    passingCycles: item.cycles.filter(point => point.anonGrowthMiB <= plan.budget.postCleanupAnonGrowthMiB).length,
    allWithinBudget: item.cycles.every(point => point.anonGrowthMiB <= plan.budget.postCleanupAnonGrowthMiB) };
  item.forcedGcCalls = host.gcForcedCalls;
  item.gcEvents = host.collections.length;
  item.maxGcPauseMs = Math.max(0, ...host.collections.map(event => event.duration));
  item.peakCgroupMiB = mib(Math.max(...host.samples.map(sample => sample.cgroup.memory)));
  item.oomKillDelta = host.samples.at(-1).cgroup.oomKills - host.samples[0].cgroup.oomKills;
  item.operations = client.cycles.reduce((total, cycle) => total + cycle.operations.length, 0);
  item.sourceReceipts = client.events.length;
  item.hashes = host.hashes;
  item.image = read(path.join(directory, 'image.json'));
  item.sharpConcurrency = host.sharpConcurrency;
  item.sharpVersions = host.sharpVersions;
  item.nativeProbe = host.nativeProbe || null;
  item.finalGcCalls = host.finalGcCalls || 0;
  item.trimCalls = host.trimCalls || 0;
  item.durationMs = host.samples.at(-1).ms - baseline.ms;
  item.finalDiagnostics = host.checkpoints.filter(point => point.phase.startsWith('final')).map(point => ({
    phase: point.phase, cycle: point.cycle, trimReleased: point.trimReleased,
    gcEventsDuringCheckpoint: host.startedPerformanceMs === undefined ? null : host.collections.filter(event =>
      event.start >= host.startedPerformanceMs + point.before.ms && event.start <= host.startedPerformanceMs + point.after.ms).length,
    before: { anonMiB: mib(point.before.cgroup.anon), externalMiB: mib(point.before.node.external),
      heapMiB: mib(point.before.node.heapUsed), heapTotalMiB: mib(point.before.node.heapTotal),
      arrayBuffersMiB: mib(point.before.node.arrayBuffers), native: nativeStats(point.before) },
    after: { anonMiB: mib(point.after.cgroup.anon), externalMiB: mib(point.after.node.external),
      heapMiB: mib(point.after.node.heapUsed), heapTotalMiB: mib(point.after.node.heapTotal),
      arrayBuffersMiB: mib(point.after.node.arrayBuffers), native: nativeStats(point.after) },
  }));
  const forced = group === 'gc' || group === 'gc-cache-off';
  const cacheOff = group.includes('cache-off');
  item.treatmentValid = host.group === group && client.group === group
    && host.gcForcedCalls === (forced ? plan.cycles * 2 : 0)
    && item.cycles.every(cycle => cycle.sharpCache.items.max === (cacheOff ? 0 : host.originalCache.items.max)
      && cycle.sharpCache.memory.max === (cacheOff ? 0 : host.originalCache.memory.max));
  item.sourceMatchesPlan = Object.entries(plan.sourceHashes || {}).every(([file, hash]) => host.hashes[file] === hash);
  item.nativeTreatmentValid = !plan.nativeProbe || (host.nativeProbe?.glibc === plan.glibc
    && Object.entries(plan.hostEnvironment).every(([key, value]) => host.nativeProbe.env[key] === value)
    && host.sharpConcurrency === plan.sharpConcurrency && item.trimCalls === (plan.finalTrim === false ? 0 : 1) && item.finalGcCalls === 2
    && (!plan.allocator || host.nativeProbe.allocator.implementation === plan.allocator)
    && JSON.stringify(item.finalDiagnostics.map(point => point.phase)) === JSON.stringify(['finalIdle', 'finalGc', ...(plan.finalTrim === false ? [] : ['finalTrim']), 'finalSettled'])
    && item.finalDiagnostics.every(point => point.cycle === plan.cycles)
    && item.cycles.every(point => point.native));
  const receipts = new Map();
  for (const event of client.events) {
    if (!receipts.has(event.session)) receipts.set(event.session, []);
    receipts.get(event.session).push(event.index);
  }
  item.receiptsValid = receipts.size === plan.cycles * plan.sessions
    && [...receipts.values()].every(indices => JSON.stringify(indices) === JSON.stringify(Array.from({ length: plan.operationsPerSessionPerCycle }, (_, i) => i)));
  item.complete = client.passed && client.cycles.length === plan.cycles && item.cycles.length === plan.cycles
    && item.cycles.every((point, i) => point.cycle === i + 1) && item.receiptsValid && item.nativeTreatmentValid
    && client.cycles.every(cycle => cycle.passed && cycle.operations.length === plan.sessions * plan.operationsPerSessionPerCycle)
    && item.cycles.every(cycle => cycle.browsersGone) && item.oomKillDelta === 0 && item.treatmentValid && item.sourceMatchesPlan;
  item.error = client.error;
}
const consistentSources = new Set(groups.filter(item => item.hashes).map(item => JSON.stringify(item.hashes))).size === 1;
const consistentImages = new Set(groups.filter(item => item.image).map(item => item.image)).size === 1;
const report = { plan, groups, consistentSources, consistentImages,
  complete: groups.every(group => group.complete) && consistentSources && consistentImages };
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(report, null, 2));
for (const item of groups) console.log(JSON.stringify({ group: item.group, complete: item.complete,
  first: item.cycles?.[0], last: item.cycles?.at(-1), tailSlope: item.lastFiveAnonSlopeMiBPerCycle }));
if (!report.complete) process.exitCode = 1;
