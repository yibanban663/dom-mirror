'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.argv[2];
if (!root) throw Error('Usage: node tools/summarize-v8-pair.cjs EVIDENCE_ROOT');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const protocol = read(path.join(root, 'protocol.json'));
assert.deepEqual(protocol.order, ['default', 'semi4']);
assert.deepEqual(protocol.images.default.RootFS, protocol.images.semi4.RootFS);
const runs = protocol.order.map(name => {
  const directory = path.join(root, name), result = read(path.join(directory, 'v8-summary.json'));
  const report = result.report, group = report.groups[0], plan = report.plan;
  const containers = read(path.join(directory, 'default/containers.json'));
  assert.ok(result.complete && report.complete);
  assert.equal(plan.cycles, 30);
  assert.equal(plan.v8Profile.trace, '0');
  assert.equal(plan.v8Profile.maxSemiSpaceMiB, name === 'semi4' ? '4' : null);
  assert.equal(plan.image, protocol.images[name].Id);
  assert.equal(group.operations, 900);
  assert.equal(group.sourceReceipts, 900);
  assert.equal(group.forcedGcCalls, 0);
  assert.equal(group.finalGcCalls, 2);
  assert.equal(group.trimCalls, 0);
  assert.ok(!containers[1].Config.Env.some(value => value.startsWith('NODE_OPTIONS=') && value !== 'NODE_OPTIONS='));
  const client = read(path.join(directory, 'default/client.json'));
  const percentile = values => {
    assert.ok(values.length && values.every(Number.isFinite));
    return values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  };
  const operations = client.cycles.flatMap(cycle => cycle.operations);
  const domP95Ms = percentile(operations.map(operation => operation.domMs));
  const paintP95Ms = percentile(operations.map(operation => operation.paintOpportunityMs));
  return { name, result, domP95Ms, paintP95Ms, hostWindow: { started: containers[0].State.StartedAt, finished: containers[0].State.FinishedAt },
    gates: { normalAnon: group.normalCleanupBudget.allWithinBudget, peak: group.peakCgroupMiB <= protocol.budgets.memoryPeakMiB,
      dom: domP95Ms <= protocol.budgets.domP95Ms, paint: paintP95Ms <= protocol.budgets.frameDrawP95Ms } };
});
const [control, candidate] = runs;
const normalizedPlan = run => {
  const { image, v8Profile, ...plan } = run.result.report.plan;
  return { ...plan, v8Profile: { trace: v8Profile.trace } };
};
assert.deepEqual(normalizedPlan(control), normalizedPlan(candidate));
assert.deepEqual(control.result.report.groups[0].hashes, candidate.result.report.groups[0].hashes);
assert.equal(control.result.report.groups[0].nativeProbe.binarySha256, candidate.result.report.groups[0].nativeProbe.binarySha256);
assert.equal(control.result.startup.node, candidate.result.startup.node);
assert.equal(control.result.startup.v8, candidate.result.startup.v8);
assert.deepEqual(control.result.startup.execArgv, candidate.result.startup.execArgv.filter(arg => arg !== '--max-semi-space-size=4'));
assert.ok(Date.parse(control.hostWindow.finished) <= Date.parse(candidate.hostWindow.started));
const result = { complete: true, scope: 'Untraced matched startup profiles; fixed three-session lifecycle workload, not full capacity or production qualification',
  sameFilesystemAndSources: true, protocol, runs, candidateGatesPassed: Object.values(candidate.gates).every(Boolean) };
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ complete: true, candidateGatesPassed: result.candidateGatesPassed,
  runs: runs.map(run => ({ name: run.name, gates: run.gates, budget: run.result.report.groups[0].normalCleanupBudget })) }));
