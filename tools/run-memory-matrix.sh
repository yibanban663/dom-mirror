#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
evidence=${EVIDENCE_DIR:-"$repo/artifacts/frame-memory/$(date +%Y%m%d-%H%M%S)"}
mkdir -p "$evidence"
evidence=$(cd -- "$evidence" && pwd)
node - "$repo" "$evidence/plan.json" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [root, target] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(path.join(root, 'tools/fixtures/frame-memory-plan.json'), 'utf8'));
plan.sourceHashes = Object.fromEntries(['server.js', 'client/index.html', 'lib/sessions.js', 'tools/fixtures/capacity.html',
  'tools/profile-client.cjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
fs.writeFileSync(target, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
NODE
for group in default gc cache-off gc-cache-off; do
  [[ ! -e "$evidence/$group" ]] || { printf 'Refusing to overwrite %s\n' "$evidence/$group" >&2; exit 2; }
  printf 'Memory group: %s\n' "$group"
  if ! MEMORY_GROUP="$group" EVIDENCE_DIR="$evidence/$group" \
    bash "$repo/tools/verify-docker-memory.sh" > "$evidence/$group-driver.log" 2>&1; then
    printf 'Group failed; controls stopped. Inspect %s\n' "$evidence/$group-driver.log" >&2
    exit 1
  fi
done
node "$repo/tools/summarize-memory.cjs" "$evidence"
