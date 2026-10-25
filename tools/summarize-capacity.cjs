'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
if (!root) throw new Error('Usage: node tools/summarize-capacity.cjs EVIDENCE_ROOT');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const plan = read(path.join(root, 'plan.json'));
const mib = bytes => bytes / 1024 / 1024;
function distribution(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return { count: sorted.length, p50: at(.5), p95: at(.95), max: at(1) };
}
function phaseUsage(resources, phase, client = false) {
  const samples = resources.filter(row => row.phase === phase);
  if (samples.length < 2) return null;
  const first = samples[0], last = samples.at(-1);
  return { durationMs: last.ms - first.ms,
    averageCores: ((client ? last.cpuUsec - first.cpuUsec : last.cpu.usage_usec - first.cpu.usage_usec) / 1000) / (last.ms - first.ms),
    peakMiB: mib(Math.max(...samples.map(row => row.memory))),
    throttledMs: client ? null : (last.cpu.throttled_usec - first.cpu.throttled_usec) / 1000 };
}
const cases = [];
for (const mode of plan.matrix.modes) for (const count of plan.matrix.sessions) for (let repeat = 1; repeat <= plan.matrix.repetitions; repeat++) {
  const name = `${mode}-${count}-${repeat}`, directory = path.join(root, name);
  const item = { name, mode, count, repeat, complete: false };
  cases.push(item);
  if (!fs.existsSync(path.join(directory, 'client.json')) || !fs.existsSync(path.join(directory, 'server.json'))) {
    item.error = 'Missing client or server evidence'; continue;
  }
  const client = read(path.join(directory, 'client.json')), server = read(path.join(directory, 'server.json'));
  const measured = client.operations.filter(row => row.measured);
  item.functionalPass = client.passed;
  item.cold = distribution(client.cold.map(row => row.ms));
  item.dom = distribution(measured.map(row => row.domMs).filter(Number.isFinite));
  item.draw = distribution(measured.map(row => row.drawMs).filter(Number.isFinite));
  item.paintOpportunity = distribution(measured.map(row => row.paintOpportunityMs).filter(Number.isFinite));
  item.worstUserP95Ms = Math.max(...Array.from({ length: count }, (_, user) => distribution(measured.filter(row => row.user === user)
    .map(row => mode === 'dom' ? row.domMs : row.drawMs).filter(Number.isFinite)).p95 ?? Infinity));
  item.measuredServer = phaseUsage(server.resources, 'measured');
  item.measuredClient = phaseUsage(client.clientResources, 'measured', true);
  item.coldServer = phaseUsage(server.resources, 'cold');
  item.peakMiB = mib(Math.max(...server.resources.map(row => row.memory)));
  const baseline = server.resources.filter(row => row.phase === 'baseline').at(-1);
  const reclaimed = server.resources.filter(row => row.phase === 'cleanup').at(-1);
  item.baselineAnonMiB = baseline ? mib(baseline.memoryStat.anon) : null;
  item.reclaimedAnonMiB = reclaimed ? mib(reclaimed.memoryStat.anon) : null;
  item.anonGrowthMiB = baseline && reclaimed ? mib(reclaimed.memoryStat.anon - baseline.memoryStat.anon) : null;
  item.oomKillDelta = server.resources.at(-1).events.oom_kill - server.resources[0].events.oom_kill;
  item.wsDownMiB = mib((client.bytes || []).reduce((total, row) => total + row.received, 0));
  item.totalSourceOperations = client.events.length;
  item.measuredOperations = measured.length;
  item.achievedOperationsPerSecond = count * 20 / (client.measuredDurationMs / 1000);
  item.reclaimed = client.reclaimed;
  item.hashes = server.hashes;
  item.image = read(path.join(directory, 'image.json'));
  item.complete = client.passed && measured.length === count * plan.workload.measuredPerSession;
  item.budget = { cold: item.cold.max <= plan.budgets.coldReadyMaxMs,
    latency: item.worstUserP95Ms <= (mode === 'dom' ? plan.budgets.domP95Ms : plan.budgets.frameDrawP95Ms),
    memory: item.peakMiB <= plan.budgets.memoryPeakMiB,
    cleanup: item.anonGrowthMiB !== null && item.anonGrowthMiB <= plan.budgets.postCleanupAnonGrowthMiB,
    noOom: item.oomKillDelta === 0 };
  item.withinBudget = item.complete && Object.values(item.budget).every(Boolean);
}
const consistentSources = new Set(cases.filter(item => item.complete).map(item => JSON.stringify(item.hashes))).size === 1;
const consistentImages = new Set(cases.filter(item => item.complete).map(item => item.image)).size === 1;
const report = { plan, cases, consistentSources, consistentImages,
  complete: cases.every(item => item.complete) && consistentSources && consistentImages,
  allWithinBudget: cases.every(item => item.withinBudget) && consistentSources && consistentImages };
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(report, null, 2));
for (const item of cases) console.log(JSON.stringify({ name: item.name, complete: item.complete, withinBudget: item.withinBudget,
  coldMax: item.cold?.max, worstP95: item.worstUserP95Ms, memoryMiB: item.peakMiB, cpu: item.measuredServer?.averageCores,
  growthMiB: item.anonGrowthMiB, budget: item.budget }));
if (!report.complete) process.exitCode = 1;
