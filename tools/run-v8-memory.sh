#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:v8-pool}
cycles=${MEMORY_CYCLES:-10}
[[ "$cycles" =~ ^[0-9]+$ ]] && (( cycles >= 1 && cycles <= 60 )) || exit 2
evidence=${EVIDENCE_DIR:-"$repo/artifacts/v8-memory/$(date +%Y%m%d-%H%M%S)"}
mkdir -p "$evidence"
evidence=$(cd -- "$evidence" && pwd)
node - "$repo" "$evidence" "$image" "$cycles" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const [repo, output, image, cycles] = process.argv.slice(2);
const info = JSON.parse(execFileSync('docker', ['image', 'inspect', image]))[0];
const env = Object.fromEntries(info.Config.Env.map(value => { const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)]; }));
const read = name => JSON.parse(fs.readFileSync(path.join(repo, 'tools/fixtures', name)));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex');
const hostEnvironment = { MALLOC_ARENA_MAX: '2', VIPS_CONCURRENCY: '1', LD_PRELOAD: '/usr/lib/x86_64-linux-gnu/libjemalloc.so.2',
  MALLOC_CONF: 'narenas:2,background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000' };
const plan = { ...read('frame-memory-plan.json'), ...read('frame-memory-long-plan.json'), cycles: Number(cycles),
  traceStorage: 'disk', mappingCycles: [], allocator: 'jemalloc', finalTrim: false, hostEnvironment,
  finalDiagnostics: ['15 seconds idle', 'two full GC calls', '3 seconds idle'],
  scope: 'Explicit V8 host profile; trace-enabled runs are diagnostic, not production capacity qualification',
  nativeStatsLimit: 'Allocator/V8/pooled counters are not disjoint resident ownership',
  image: info.Id, v8Profile: { trace: env.MEMORY_V8_TRACE || '0', maxSemiSpaceMiB: env.MEMORY_MAX_SEMI_SPACE || null },
  bootstrapHashes: Object.fromEntries(['tools/memory-v8-entry.sh', 'tools/memory-v8-preload.cjs'].map(file => [file, hash(file)])),
  sourceHashes: Object.fromEntries(['server.js', 'client/index.html', 'lib/sessions.js', 'tools/fixtures/capacity.html',
    'tools/profile-client.cjs', 'tools/memory-host.cjs', 'tools/memory-client.cjs', 'tools/verify-docker-memory.sh',
    'tools/native-memory.c', 'tools/memory-trace.cjs'].map(file => [file, hash(file)])) };
fs.writeFileSync(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
NODE
preload=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
conf=narenas:2,background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000
docker run --rm --network none --memory 512m --cpus 1 -e MEMORY_EXPECT_ALLOCATOR=jemalloc \
  -e "LD_PRELOAD=$preload" -e "MALLOC_CONF=$conf" "$image" node tools/verify-allocator.cjs > "$evidence/preflight.json"
IMAGE="$image" MEMORY_CYCLES="$cycles" MEMORY_GROUP=default MEMORY_TRACE_STORAGE=disk MEMORY_MAP_CYCLES= \
  MEMORY_NATIVE_PROBE=1 MEMORY_FINAL_DIAGNOSTICS=1 MEMORY_SKIP_TRIM=1 MEMORY_MAPS=1 \
  MEMORY_LD_PRELOAD="$preload" MEMORY_MALLOC_CONF="$conf" EVIDENCE_DIR="$evidence/default" \
  bash "$repo/tools/verify-docker-memory.sh" > "$evidence/driver.log" 2>&1
node "$repo/tools/summarize-memory.cjs" "$evidence"
node "$repo/tools/summarize-v8-memory.cjs" "$evidence"
