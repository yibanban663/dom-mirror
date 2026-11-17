#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
evidence=${EVIDENCE_DIR:-"$repo/artifacts/frame-memory-long/$(date +%Y%m%d-%H%M%S)"}
mkdir -p "$evidence"
evidence=$(cd -- "$evidence" && pwd)
cycles=$(node - "$repo" "$evidence/plan.json" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [root, target] = process.argv.slice(2);
const read = file => JSON.parse(fs.readFileSync(path.join(root, 'tools/fixtures', file), 'utf8'));
const plan = { ...read('frame-memory-plan.json'), ...read('frame-memory-long-plan.json') };
plan.sourceHashes = Object.fromEntries(['server.js', 'client/index.html', 'lib/sessions.js', 'tools/fixtures/capacity.html',
  'tools/profile-client.cjs', 'tools/memory-host.cjs', 'tools/memory-client.cjs', 'tools/verify-docker-memory.sh',
  'tools/native-memory.c'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
fs.writeFileSync(target, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
console.log(plan.cycles);
NODE
)
[[ ! -e "$evidence/default" ]] || exit 2
MEMORY_CYCLES="$cycles" MEMORY_GROUP=default MEMORY_NATIVE_PROBE=1 MEMORY_FINAL_DIAGNOSTICS=1 \
  EVIDENCE_DIR="$evidence/default" bash "$repo/tools/verify-docker-memory.sh" > "$evidence/driver.log" 2>&1
node "$repo/tools/summarize-memory.cjs" "$evidence"
