#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:local}
evidence=${EVIDENCE_DIR:-"$repo/artifacts/data-boundary"}
run_id="dom-mirror-boundary-$(date +%s)-$$"
cleanup() { docker rm -f "$run_id-default" "$run_id-redacted" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$evidence"
docker image inspect "$image" --format '{{json .Id}}' > "$evidence/image.json"
for policy in default redacted; do
  redact=0
  [[ "$policy" != redacted ]] || redact=1
  mkdir -p "$evidence/$policy" && chmod a+rwx "$evidence/$policy"
  docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" --rm --name "$run_id-$policy" --network none --memory 3g --cpus 2 \
    -v "$evidence/$policy:/evidence" -e EVIDENCE_DIR=/evidence \
    -e BOUNDARY_ENFORCE=1 -e "BOUNDARY_REDACT=$redact" \
    "$image" timeout 180 node tools/verify-data-boundary.cjs > "$evidence/$policy.log" 2>&1
  cat "$evidence/$policy.log"
done
