#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:allocator}
evidence=${EVIDENCE_DIR:-"$repo/artifacts/jemalloc-long/$(date +%Y%m%d-%H%M%S)"}
mkdir -p "$evidence"
evidence=$(cd -- "$evidence" && pwd)
node - "$repo" "$evidence/plan.json" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [root, target] = process.argv.slice(2);
const { mappingCycles } = require(path.join(root, 'tools/memory-trace.cjs'));
const traceStorage = process.env.MEMORY_TRACE_STORAGE || 'memory';
if (!['memory', 'disk'].includes(traceStorage)) throw Error('Invalid MEMORY_TRACE_STORAGE');
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'tools/fixtures', name), 'utf8'));
const plan = { ...read('frame-memory-plan.json'), ...read('frame-memory-long-plan.json'),
  allocator: 'jemalloc', finalTrim: false,
  traceStorage, mappingCycles: mappingCycles(process.env.MEMORY_MAP_CYCLES),
  nativeStatsLimit: 'jemalloc allocated/active/resident are allocator statistics, not whole-process RSS or allocation stack ownership',
  finalDiagnostics: ['15 seconds idle', 'two full GC calls', '3 seconds idle'],
  scope: 'One 30-cycle jemalloc host-profile follow-up; terminal GC excluded from normal memory budgets',
};
plan.hostEnvironment = { MALLOC_ARENA_MAX: '2', VIPS_CONCURRENCY: '1',
  LD_PRELOAD: '/usr/lib/x86_64-linux-gnu/libjemalloc.so.2',
  MALLOC_CONF: 'narenas:2,background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000' };
if (plan.mappingCycles.some(cycle => cycle > plan.cycles)) throw Error('Mapping cycle exceeds workload');
plan.sourceHashes = Object.fromEntries(['server.js', 'client/index.html', 'lib/sessions.js', 'tools/fixtures/capacity.html',
  'tools/profile-client.cjs', 'tools/memory-host.cjs', 'tools/memory-client.cjs', 'tools/verify-docker-memory.sh',
  'tools/native-memory.c', 'tools/memory-trace.cjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
fs.writeFileSync(target, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
NODE
[[ ! -e "$evidence/default" ]] || exit 2
preload=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
conf=narenas:2,background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000
docker run --rm --network none --memory 512m --cpus 1 -e MEMORY_EXPECT_ALLOCATOR=jemalloc \
  -e "LD_PRELOAD=$preload" -e "MALLOC_CONF=$conf" "$image" node tools/verify-allocator.cjs > "$evidence/preflight.json"
IMAGE="$image" MEMORY_CYCLES=30 MEMORY_GROUP=default MEMORY_NATIVE_PROBE=1 MEMORY_FINAL_DIAGNOSTICS=1 \
  MEMORY_SKIP_TRIM=1 MEMORY_MAPS=1 MEMORY_LD_PRELOAD="$preload" MEMORY_MALLOC_CONF="$conf" \
  EVIDENCE_DIR="$evidence/default" bash "$repo/tools/verify-docker-memory.sh" > "$evidence/driver.log" 2>&1
node "$repo/tools/summarize-memory.cjs" "$evidence"
