#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:local}
evidence=${EVIDENCE_DIR:-"$repo/artifacts/session-identity"}
run_id="dom-mirror-identity-$(date +%s)-$$"
cleanup() { docker rm -f "$run_id" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$evidence"
docker image inspect "$image" --format '{{json .Id}}' > "$evidence/image.json"
docker run --rm --name "$run_id" --network none --memory 3g --cpus 2 \
  -v "$evidence:/evidence" -e EVIDENCE_DIR=/evidence -e IDENTITY_ENFORCE=1 \
  "$image" timeout 240 node tools/verify-session-identity.cjs > "$evidence/run.log" 2>&1
cat "$evidence/run.log"
