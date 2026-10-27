#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:local}
mode=${CAPACITY_MODE:-dom}
count=${CAPACITY_SESSIONS:-1}
[[ "$mode" == dom || "$mode" == frame ]] || exit 2
[[ "$count" == 1 || "$count" == 3 || "$count" == 6 ]] || exit 2
evidence=${EVIDENCE_DIR:-"$repo/artifacts/capacity/$mode-$count"}
mkdir -p "$evidence"
chmod a+rwx "$evidence" # 容器以 pptruser 写入证据
evidence=$(cd -- "$evidence" && pwd)
run_id="dom-mirror-capacity-$(date +%s)-$$"
server="$run_id-server"
client="$run_id-client"
cleanup() {
  result=$?
  trap - EXIT
  docker stop --time 10 "$server" >/dev/null 2>&1 || true
  docker logs "$server" > "$evidence/server.log" 2>&1 || true
  docker logs "$client" > "$evidence/client.log" 2>&1 || true
  docker inspect "$server" "$client" > "$evidence/containers.json" 2>/dev/null || true
  docker rm -f "$client" "$server" >/dev/null 2>&1 || true
  docker network rm "$run_id" >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
proxy_env=(-e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= -e ALL_PROXY= -e all_proxy=)
docker image inspect "$image" --format '{{json .Id}}' > "$evidence/image.json"
docker network create --internal "$run_id" >/dev/null
docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" -d --name "$server" --network "$run_id" --network-alias mirror \
  "${proxy_env[@]}" --memory 2g --cpus 2 \
  -v "$evidence:/evidence" -e EVIDENCE_DIR=/evidence \
  -e "CAPACITY_MODE=$mode" -e "CAPACITY_SESSIONS=$count" \
  "$image" timeout --signal=TERM 180 node tools/capacity-host.cjs >/dev/null
docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" --name "$client" --network "$run_id" --network-alias load \
  "${proxy_env[@]}" --memory 4g --cpus 4 \
  -v "$evidence:/evidence" -e EVIDENCE_DIR=/evidence \
  -e "CAPACITY_MODE=$mode" -e "CAPACITY_SESSIONS=$count" \
  "$image" timeout --signal=TERM 150 node tools/capacity-client.cjs
