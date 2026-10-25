#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:local}
evidence=${EVIDENCE_DIR:-"$repo/artifacts/session-revocation"}
run_id="dom-mirror-revocation-$(date +%s)-$$"
cleanup() { docker rm -f "$run_id" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$evidence"
docker image inspect "$image" --format '{{json .Id}}' > "$evidence/image.json"
docker run --rm --name "$run_id" --network none --memory 3g --cpus 2 \
  -v "$evidence:/evidence" -e EVIDENCE_DIR=/evidence \
  "$image" timeout 300 node tools/verify-session-revocation.cjs > "$evidence/run.log" 2>&1
cat "$evidence/run.log"
