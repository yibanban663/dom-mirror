#!/usr/bin/env bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:local}
evidence=${EVIDENCE_DIR:-"$repo/artifacts/assets"}
run_id="dom-mirror-assets-$(date +%s)-$$"
server="$run_id-server"
originb="$run_id-origin-b"
client="$run_id-client"
proxy_env=(-e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= -e ALL_PROXY= -e all_proxy=)
mkdir -p "$evidence"

cleanup() {
  status=$?
  trap - EXIT
  docker logs "$server" > "$evidence/server.log" 2>&1 || true
  docker logs "$originb" > "$evidence/origin-b.log" 2>&1 || true
  docker logs "$client" > "$evidence/client.log" 2>&1 || true
  docker cp "$client:/tmp/assets-evidence/." "$evidence/" >/dev/null 2>&1 || true
  docker rm -f "$client" "$originb" "$server" >/dev/null 2>&1 || true
  docker network rm "$run_id" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker network create --internal "$run_id" >/dev/null
docker run -d --name "$server" --network "$run_id" --network-alias mirror \
  "${proxy_env[@]}" \
  --memory 2g --cpus 2 -e PROD_PRESENTATION=1 -e MAX_SESSIONS=8 \
  -e ORIGIN_URL=http://127.0.0.1:8077/assets.html \
  -e RBI_ALLOWED_ORIGINS=http://origin-b:8000 \
  "$image" timeout 180 node demo/server.js >/dev/null
for f in assets.html assets.css font.woff2 img.png; do
  docker cp "$repo/test/fixtures/$f" "$server:/app/protected/$f"
done

docker run -d --name "$originb" --network "$run_id" --network-alias origin-b \
  "${proxy_env[@]}" \
  -v "$repo/test/fixtures/origin-b:/origin-b:ro" \
  --entrypoint timeout "$image" 180 node tools/origin-static.cjs /origin-b 8000 >/dev/null

docker exec "$server" node -e '
  (async () => {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch("http://127.0.0.1:8088/", {signal: AbortSignal.timeout(1000)})).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    process.exit(1);
  })().catch(() => process.exit(1));
'
docker exec "$originb" node -e '
  (async () => {
    const r = await fetch("http://127.0.0.1:8000/", {signal: AbortSignal.timeout(2000)});
    process.exit(r.ok ? 0 : 1);
  })().catch(() => process.exit(1));
'

docker run --name "$client" --network "$run_id" --memory 2g \
  "${proxy_env[@]}" \
  -e MIRROR_URL=http://mirror:8088/ -e ORIGIN_B=http://origin-b:8000 -e EVIDENCE_DIR=/tmp/assets-evidence \
  --entrypoint timeout "$image" 170 node tools/verify-assets.cjs
