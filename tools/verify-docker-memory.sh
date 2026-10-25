#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:local}
group=${MEMORY_GROUP:-default}
cycles=${MEMORY_CYCLES:-10}
[[ "$cycles" =~ ^[0-9]+$ ]] && (( cycles >= 1 && cycles <= 60 )) || exit 2
client_timeout=$((cycles * 45 + 90))
server_timeout=$((client_timeout + 30))
[[ "$group" == default || "$group" == gc || "$group" == cache-off || "$group" == gc-cache-off ]] || exit 2
evidence=${EVIDENCE_DIR:-"$repo/artifacts/frame-memory/$group"}
mkdir -p "$evidence"
evidence=$(cd -- "$evidence" && pwd)
run_id="dom-mirror-memory-$(date +%s)-$$"
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
diagnostic_env=(-e "MEMORY_CYCLES=$cycles" -e "MEMORY_NATIVE_PROBE=${MEMORY_NATIVE_PROBE:-0}"
  -e "MEMORY_FINAL_DIAGNOSTICS=${MEMORY_FINAL_DIAGNOSTICS:-0}" -e "MEMORY_SKIP_TRIM=${MEMORY_SKIP_TRIM:-0}" -e "MEMORY_MAPS=${MEMORY_MAPS:-0}")
allocator_env=(-e "LD_PRELOAD=${MEMORY_LD_PRELOAD:-}" -e "MALLOC_CONF=${MEMORY_MALLOC_CONF:-}")
docker image inspect "$image" --format '{{json .Id}}' > "$evidence/image.json"
docker network create --internal "$run_id" >/dev/null
docker run -d --name "$server" --network "$run_id" --network-alias mirror \
  "${proxy_env[@]}" "${diagnostic_env[@]}" "${allocator_env[@]}" --memory 2g --cpus 2 -v "$evidence:/evidence" \
  -e EVIDENCE_DIR=/evidence -e "MEMORY_GROUP=$group" \
  "$image" timeout --signal=TERM "$server_timeout" node --expose-gc tools/memory-host.cjs >/dev/null
docker run --name "$client" --network "$run_id" --network-alias load \
  "${proxy_env[@]}" "${diagnostic_env[@]}" --memory 4g --cpus 4 -v "$evidence:/evidence" \
  -e EVIDENCE_DIR=/evidence -e "MEMORY_GROUP=$group" \
  "$image" timeout --signal=TERM "$client_timeout" node tools/memory-client.cjs
