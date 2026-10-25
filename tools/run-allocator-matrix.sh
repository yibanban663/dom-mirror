#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
evidence=${EVIDENCE_DIR:-"$repo/artifacts/allocator/$(date +%Y%m%d-%H%M%S)"}
mkdir -p "$evidence"
evidence=$(cd -- "$evidence" && pwd)
for profile in glibc jemalloc; do
  [[ ! -e "$evidence/$profile" ]] || exit 2
  mkdir "$evidence/$profile"
  node - "$repo" "$evidence/$profile/plan.json" "$profile" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [root, target, allocator] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'tools/fixtures', name), 'utf8'));
const plan = { ...read('frame-memory-plan.json'), ...read('frame-memory-long-plan.json'),
  cycles: 10, allocator, finalTrim: false,
  finalDiagnostics: ['15 seconds idle', 'two full GC calls', '3 seconds idle'],
  scope: 'One ten-cycle run per host profile, normal budget excludes terminal GC; no production-capacity qualification',
};
plan.hostEnvironment = { MALLOC_ARENA_MAX: '2', VIPS_CONCURRENCY: '1',
  LD_PRELOAD: allocator === 'jemalloc' ? '/usr/lib/x86_64-linux-gnu/libjemalloc.so.2' : '',
  MALLOC_CONF: allocator === 'jemalloc' ? 'narenas:2,background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000' : '' };
plan.sourceHashes = Object.fromEntries(['server.js', 'client/index.html', 'lib/sessions.js', 'tools/fixtures/capacity.html',
  'tools/profile-client.cjs', 'tools/memory-host.cjs', 'tools/memory-client.cjs', 'tools/verify-docker-memory.sh',
  'tools/native-memory.c'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
fs.writeFileSync(target, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
NODE
  preload= conf=
  if [[ "$profile" == jemalloc ]]; then
    preload=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
    conf=narenas:2,background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000
  fi
  docker run --rm --network none --memory 512m --cpus 1 -e "MEMORY_EXPECT_ALLOCATOR=$profile" \
    -e "LD_PRELOAD=$preload" -e "MALLOC_CONF=$conf" "${IMAGE:-dom-mirror:allocator}" \
    node tools/verify-allocator.cjs > "$evidence/$profile/preflight.json"
  IMAGE=${IMAGE:-dom-mirror:allocator} MEMORY_CYCLES=10 MEMORY_GROUP=default MEMORY_NATIVE_PROBE=1 \
    MEMORY_FINAL_DIAGNOSTICS=1 MEMORY_SKIP_TRIM=1 MEMORY_MAPS=1 \
    MEMORY_LD_PRELOAD="$preload" MEMORY_MALLOC_CONF="$conf" EVIDENCE_DIR="$evidence/$profile/default" \
    bash "$repo/tools/verify-docker-memory.sh" > "$evidence/$profile/driver.log" 2>&1
  node "$repo/tools/summarize-memory.cjs" "$evidence/$profile"
done
node "$repo/tools/summarize-allocator.cjs" "$evidence"
