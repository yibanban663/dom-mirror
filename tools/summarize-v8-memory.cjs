'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { readTrace } = require('./memory-trace.cjs');
const { analyze } = require('./analyze-memory-growth.cjs');

function parsePools(log) {
  const pools = [];
  let gcMs = null;
  for (const line of log.split('\n')) {
    const time = line.match(/\]\s+([\d.]+) ms:.*pooled:/);
    if (time) gcMs = Number(time[1]);
    const pool = line.match(/Pool buffering (\d+) chunks of committed:\s+(\d+) KB/);
    if (pool && gcMs !== null) pools.push({ gcMs, chunks: Number(pool[1]), committedMiB: Number(pool[2]) / 1024 });
  }
  return pools;
}

function summarize(root) {
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const directory = path.join(root, 'default'), report = read(path.join(root, 'summary.json'));
  const plan = report.plan, group = report.groups[0];
  const startup = read(path.join(directory, 'v8-startup.json'));
  const host = readTrace(directory, read(path.join(directory, 'server.json')));
  const containers = read(path.join(directory, 'containers.json'));
  const preflight = read(path.join(root, 'preflight.json'));
  const trace = plan.v8Profile.trace === '1';
  assert.ok(['0', '1'].includes(plan.v8Profile.trace));
  assert.ok(report.complete && preflight.passed && preflight.allocator === 'jemalloc' && preflight.allocatedDelta >= 64 * 2 ** 20);
  assert.deepEqual(startup.profile, plan.v8Profile);
  assert.equal(startup.bootstrapSha256, plan.bootstrapHashes['tools/memory-v8-preload.cjs']);
  assert.equal(startup.entrySha256, plan.bootstrapHashes['tools/memory-v8-entry.sh']);
  assert.equal(group.image, plan.image);
  assert.equal(startup.execArgv.includes('--trace-gc-verbose'), trace);
  assert.equal(startup.execArgv.includes('--trace-gc'), trace);
  assert.equal(startup.execArgv.find(arg => arg.startsWith('--max-semi-space-size=')) || null,
    plan.v8Profile.maxSemiSpaceMiB ? '--max-semi-space-size=' + plan.v8Profile.maxSemiSpaceMiB : null);
  assert.equal(host.status.browsers.length, plan.cycles * plan.sessions);
  assert.ok(host.status.browsers.every(browser => browser.closed && !browser.connected && browser.processGone && browser.jemallocMapped === false));
  for (const [index, cpus, gib] of [[0, 2, 2], [1, 4, 4]]) {
    assert.equal(containers[index].State.Running, false);
    assert.equal(containers[index].State.ExitCode, 0);
    assert.equal(containers[index].State.OOMKilled, false);
    assert.equal(containers[index].Image, plan.image);
    assert.equal(containers[index].HostConfig.NanoCpus, cpus * 1e9);
    assert.equal(containers[index].HostConfig.Memory, gib * 2 ** 30);
  }
  const pools = parsePools(fs.readFileSync(path.join(directory, 'server.log'), 'utf8'));
  const frameFile = path.join(directory, 'frame-sizes.jsonl');
  const frames = fs.existsSync(frameFile) ? fs.readFileSync(frameFile, 'utf8').trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  assert.ok(trace ? pools.length > 0 && frames.length > 0 : pools.length === 0 && frames.length === 0);
  return { complete: true, scope: trace ? 'Verbose GC/pool diagnostic; not capacity qualification' : 'Untraced host-profile lifecycle run; not complete production qualification',
    report, startup, preflight, pools, maxPoolCommittedMiB: Math.max(0, ...pools.map(pool => pool.committedMiB)),
    frameSizes: { count: frames.length, maxBase64Chars: Math.max(0, ...frames.map(frame => frame.pngBase64Chars)),
      meanBase64Chars: frames.length ? frames.reduce((sum, frame) => sum + frame.pngBase64Chars, 0) / frames.length : null },
    analysis: analyze(directory),
    interpretation: 'Pool committed counters are not resident bytes or disjoint from V8/RSS. Frame lengths identify payload size, not retained references.' };
}
if (require.main === module) {
  if (!process.argv[2]) throw Error('Usage: node tools/summarize-v8-memory.cjs EVIDENCE_ROOT');
  const result = summarize(process.argv[2]);
  fs.writeFileSync(path.join(process.argv[2], 'v8-summary.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ complete: result.complete, maxPoolCommittedMiB: result.maxPoolCommittedMiB, frameSizes: result.frameSizes,
    normalBudget: result.report.groups[0].normalCleanupBudget }));
}
module.exports = { parsePools, summarize };
