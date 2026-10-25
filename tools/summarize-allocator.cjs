'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
if (!root) throw new Error('Usage: node tools/summarize-allocator.cjs EVIDENCE_ROOT');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function mappings(file) {
  const regions = [];
  let current;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const head = line.match(/^([0-9a-f]+)-([0-9a-f]+) (\S+) [0-9a-f]+ \S+ \d+\s*(.*)$/);
    if (head) { current = { address: head[1], permissions: head[3], name: head[4] || '(unnamed)' }; regions.push(current); continue; }
    const field = line.match(/^(Size|Rss|Anonymous|Private_Dirty):\s+(\d+) kB/);
    if (field && current) current[field[1]] = Number(field[2]) / 1024;
  }
  const categories = {};
  if (!regions.length || regions.some(region => !['Size', 'Rss', 'Anonymous', 'Private_Dirty'].every(key => Number.isFinite(region[key])))) {
    throw new Error('Incomplete smaps: ' + file);
  }
  for (const region of regions) {
    const category = region.name === '[heap]' ? 'mainHeap' : region.name === '[stack]' ? 'mainStack'
      : region.name === '(unnamed)' ? (region.permissions.includes('x') ? 'unnamedExecutable' : 'unnamed')
      : region.name.startsWith('/') ? 'fileBacked' : 'namedOther';
    categories[category] ??= { rssMiB: 0, anonMiB: 0, sizeMiB: 0, count: 0 };
    const group = categories[category]; group.rssMiB += region.Rss; group.anonMiB += region.Anonymous;
    group.sizeMiB += region.Size; group.count++;
  }
  return { regions: regions.length, categories,
    rssMiB: regions.reduce((sum, region) => sum + region.Rss, 0),
    anonMiB: regions.reduce((sum, region) => sum + region.Anonymous, 0),
    topAnonymous: regions.toSorted((a, b) => b.Anonymous - a.Anonymous).slice(0, 12) };
}
if (root === '--maps') { console.log(JSON.stringify(mappings(process.argv[3]), null, 2)); process.exit(0); }
const profiles = [];
for (const allocator of ['glibc', 'jemalloc']) {
  const directory = path.join(root, allocator), report = read(path.join(directory, 'summary.json'));
  const host = read(path.join(directory, 'default/server.json'));
  const containers = read(path.join(directory, 'default/containers.json'));
  const preflight = read(path.join(directory, 'preflight.json'));
  const controlsValid = preflight.passed && preflight.allocator === allocator
    && host.nativeProbe.allocator.implementation === allocator
    && host.status.browsers.length === 30 && host.status.browsers.every(browser => browser.jemallocMapped === false)
    && containers.every(container => !container.State.OOMKilled)
    && !containers[1].Config.Env.some(env => env.startsWith('LD_PRELOAD=') && env !== 'LD_PRELOAD=');
  const snapshots = {};
  for (const phase of ['0-baseline', '10-postIdle', '10-finalSettled']) {
    snapshots[phase] = { ...mappings(path.join(directory, 'default', phase + '-smaps.txt')),
      v8: read(path.join(directory, 'default', phase + '-v8.json')) };
  }
  const mapped = fs.readFileSync(path.join(directory, 'default/10-postIdle-smaps.txt'), 'utf8').includes('libjemalloc');
  profiles.push({ allocator, controlsValid: controlsValid && mapped === (allocator === 'jemalloc'), preflight, report, mappings: snapshots });
}
const consistentSources = new Set(profiles.map(p => JSON.stringify(p.report.groups[0].hashes))).size === 1;
const consistentImages = new Set(profiles.map(p => p.report.groups[0].image)).size === 1;
const result = { scope: 'Ten cycles per profile; glibc arena=2 versus jemalloc with background decay; no trim; terminal GC excluded from normal budget',
  profiles, consistentSources, consistentImages,
  complete: consistentSources && consistentImages && profiles.every(p => p.controlsValid && p.report.complete) };
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ complete: result.complete, profiles: profiles.map(p => ({ allocator: p.allocator,
  lastAnon: p.report.groups[0].cycles.at(-1).anonMiB, budget: p.report.groups[0].normalCleanupBudget })) }));
if (!result.complete) process.exitCode = 1;
