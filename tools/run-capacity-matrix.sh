#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
evidence=${EVIDENCE_DIR:-"$repo/artifacts/capacity/$(date +%Y%m%d-%H%M%S)"}
mkdir -p "$evidence"
evidence=$(cd -- "$evidence" && pwd)
node - "$repo/tools/fixtures/capacity-plan.json" "$evidence/plan.json" <<'NODE'
const fs = require('node:fs'), os = require('node:os');
const [source, target] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(source, 'utf8'));
if (fs.existsSync(target)) {
  const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
  for (const key of ['matrix', 'limits', 'workload', 'budgets']) {
    if (JSON.stringify(existing[key]) !== JSON.stringify(plan[key])) throw new Error('Frozen plan differs: ' + key);
  }
} else {
  plan.host = { platform: os.platform(), release: os.release(), logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() };
  fs.writeFileSync(target, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
}
NODE
for mode in dom frame; do
  failed=0
  for count in 1 3 6; do
    for repeat in 1 2; do
      name="$mode-$count-$repeat"
      [[ ! -e "$evidence/$name" ]] || { printf 'Refusing to overwrite %s\n' "$evidence/$name" >&2; exit 2; }
      printf 'Capacity: %s\n' "$name"
      if ! CAPACITY_MODE="$mode" CAPACITY_SESSIONS="$count" EVIDENCE_DIR="$evidence/$name" \
        bash "$repo/tools/verify-docker-capacity.sh" > "$evidence/$name.log" 2>&1; then
        failed=1; break
      fi
      if ! node - "$evidence/$name/server.json" <<'NODE'
const fs = require('node:fs');
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).resources;
process.exit(rows.at(-1).events.oom_kill > rows[0].events.oom_kill ? 1 : 0);
NODE
      then failed=1; break; fi
    done
    if [[ "$failed" == 1 ]]; then
      printf 'Functional failure or OOM: stop escalation for %s; inspect %s\n' "$mode" "$evidence/$name" >&2
      break
    fi
  done
done
node "$repo/tools/summarize-capacity.cjs" "$evidence"
