#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
evidence=${EVIDENCE_DIR:-"$repo/artifacts/package-business"}
mkdir -p "$evidence"
evidence=$(cd "$evidence" && pwd)
rm -f "$evidence/summary.json"
context=$(mktemp -d)
image="dom-mirror:package-business-$(date +%s)-$$"
cleanup() {
  status=$?
  trap - EXIT
  rm -rf "$context"
  docker image rm "$image" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --rm --user root -v "$repo:/repo:ro" -v "$context:/ctx" --entrypoint node "${IMAGE:-dom-mirror:local}" /repo/tools/prepare-package-business.cjs /ctx
cp "$context/expected.json" "$evidence/archive.json"
timeout 480 docker build --build-arg HTTP_PROXY --build-arg HTTPS_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg NO_PROXY --build-arg no_proxy \
  --build-arg "BASE_IMAGE=${IMAGE:-dom-mirror:local}" -t "$image" "$context" > "$evidence/build.log" 2>&1
docker image inspect "$image" --format '{{.Id}}' > "$evidence/consumer-image.txt"
# 负向对照需篡改 root 所有的包文件，不启动 Chromium
docker run --user root --rm -i --network none -w /consumer --entrypoint timeout "$image" 30 node \
  < "$repo/tools/verify-package-provenance.cjs" > "$evidence/provenance-negative.json"
IMAGE="$image" BUSINESS_PACKAGE_HOST=1 SESSION_GRACE_MS=2000 EVIDENCE_DIR="$evidence/core" \
  bash "$repo/tools/verify-docker-vikunja.sh"
IMAGE="$image" BUSINESS_PACKAGE_HOST=1 SESSION_GRACE_MS=2000 BUSINESS_TEST_SCRIPT=verify-recovery.cjs \
  EVIDENCE_DIR="$evidence/recovery" bash "$repo/tools/verify-docker-vikunja.sh"
node "$repo/tools/summarize-package-business.cjs" "$evidence"
