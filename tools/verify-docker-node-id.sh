#!/usr/bin/env bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:local}
evidence=${EVIDENCE_DIR:-"$repo/artifacts/node-id"}
run_id="dom-mirror-node-id-$(date +%s)-$$"
server="$run_id-server"
client="$run_id-client"
proxy_env=(-e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= -e ALL_PROXY= -e all_proxy=)
mkdir -p "$evidence"

cleanup() {
  status=$?
  trap - EXIT
  docker logs "$server" > "$evidence/server.log" 2>&1 || true
  docker logs "$client" > "$evidence/client.log" 2>&1 || true
  docker cp "$client:/tmp/node-id-evidence/." "$evidence/" >/dev/null 2>&1 || true
  docker rm -f "$client" "$server" >/dev/null 2>&1 || true
  docker network rm "$run_id" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker network create --internal "$run_id" >/dev/null
docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" -d --name "$server" --network "$run_id" --network-alias mirror \
  "${proxy_env[@]}" \
  --memory 2g --cpus 2 -e PROD_PRESENTATION=1 \
  -e ORIGIN_URL=http://127.0.0.1:8077/node-id.html \
  "$image" timeout 150 node demo/server.js >/dev/null
docker cp "$repo/test/fixtures/node-id.html" "$server:/app/protected/node-id.html"
docker exec "$server" node -e '
  (async () => {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch("http://127.0.0.1:8088/", {signal: AbortSignal.timeout(1000)})).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    process.exit(1);
  })().catch(() => process.exit(1));
'
docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" --name "$client" --network "$run_id" --memory 2g \
  "${proxy_env[@]}" \
  -e MIRROR_URL=http://mirror:8088/ -e EVIDENCE_DIR=/tmp/node-id-evidence \
  --entrypoint timeout "$image" 90 node tools/verify-node-id.cjs
