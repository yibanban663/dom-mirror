#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:local}
evidence=${EVIDENCE_DIR:-"$repo/artifacts/frame-baseline"}
run_id="dom-mirror-first-frame-$(date +%s)-$$"
cleanup() { docker rm -f "$run_id" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$evidence"
chmod a+rwx "$evidence" # 容器以 pptruser 写入证据
evidence=$(cd -- "$evidence" && pwd)
docker image inspect "$image" --format '{{json .Id}}' > "$evidence/image.json"
# v0.30：拦截器对帧流时序敏感（冷 runner 偶发错过 screencast 帧——本地复现
# 4 败 4 过的偶发形态）——失败重试一次（同 recovery/vikunja 加固惯例）
for attempt in 1 2; do
  docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" --rm --name "$run_id" --network none --memory 3g --cpus 2 \
    -v "$evidence:/evidence" -e EVIDENCE_DIR=/evidence \
    "$image" timeout 60 node tools/verify-frame-baseline.cjs > "$evidence/run.log" 2>&1 && break
  [ "$attempt" = 2 ] && { cat "$evidence/run.log"; exit 1; }
  echo 'RETRY frame-baseline (frame stream timing)'
done
cat "$evidence/run.log"
