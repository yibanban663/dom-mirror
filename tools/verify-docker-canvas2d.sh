#!/usr/bin/env bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:local}
evidence=${EVIDENCE_DIR:-"$repo/artifacts/canvas2d"}
run_id="dom-mirror-c2d-$(date +%s)-$$"
server="$run_id-server"
server_b="$run_id-server-bitmap"
client="$run_id-client"
client_b="$run_id-client-bitmap"
proxy_env=(-e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= -e ALL_PROXY= -e all_proxy=)
mkdir -p "$evidence" "$evidence/bitmap"

cleanup() {
  status=$?
  trap - EXIT
  docker logs "$server" > "$evidence/server.log" 2>&1 || true
  docker logs "$client" > "$evidence/client.log" 2>&1 || true
  docker logs "$server_b" > "$evidence/bitmap/server.log" 2>&1 || true
  docker logs "$client_b" > "$evidence/bitmap/client.log" 2>&1 || true
  docker cp "$client:/tmp/c2d-evidence/." "$evidence/" >/dev/null 2>&1 || true
  docker cp "$client_b:/tmp/c2d-evidence/." "$evidence/bitmap/" >/dev/null 2>&1 || true
  docker rm -f "$client" "$server" "$client_b" "$server_b" >/dev/null 2>&1 || true
  docker network rm "$run_id" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker network create --internal "$run_id" >/dev/null
wait_http() {
  docker exec "$1" node -e '
    (async () => {
      for (let i = 0; i < 40; i++) {
        try { if ((await fetch("http://127.0.0.1:8088/", {signal: AbortSignal.timeout(1000)})).ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      process.exit(1);
    })().catch(() => process.exit(1));
  '
}
run_server() {
  docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" -d --name "$1" --network "$run_id" --network-alias "$2" \
    "${proxy_env[@]}" --memory 2g --cpus 2 -e PROD_PRESENTATION=1 \
    -e ORIGIN_URL=http://127.0.0.1:8077/canvas2d.html ${3:-} \
    "$image" timeout 150 node demo/server.js >/dev/null
  docker cp "$repo/test/fixtures/canvas2d.html" "$1:/app/protected/canvas2d.html"
  wait_http "$1"
}

run_server "$server" mirror ""
run_server "$server_b" mirror-b "-e CANVAS_STREAM=0"

docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" --name "$client" --network "$run_id" --memory 2g \
  "${proxy_env[@]}" -e MIRROR_URL=http://mirror:8088/ -e EVIDENCE_DIR=/tmp/c2d-evidence \
  --entrypoint timeout "$image" 100 node tools/verify-canvas2d.cjs
docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" --name "$client_b" --network "$run_id" --memory 2g \
  "${proxy_env[@]}" -e MIRROR_URL=http://mirror-b:8088/ -e EVIDENCE_DIR=/tmp/c2d-evidence -e EXPECT_STREAM=0 \
  --entrypoint timeout "$image" 100 node tools/verify-canvas2d.cjs

# 带宽对比报告（同 fixture 双模式下行字节；容器内 node 生成）
docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" --rm -v "$evidence:/a:ro" -v "$evidence/bitmap:/b:ro" -v "$evidence:/out" \
  "${proxy_env[@]}" --entrypoint node "$image" - '/a/result.json' '/b/result.json' <<'EOF'
const fs = require('fs');
const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const b = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const report = {
  fixture: 'test/fixtures/canvas2d.html (1 legacy canvas + 1 animated 2d canvas @120ms)',
  stream: a.bytes,
  bitmap: b.bytes,
  canvasChannelOnly: { stream: a.bytes.canvasOps, bitmap: b.bytes.canvasTile },
};
fs.writeFileSync('/out/bandwidth.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.canvasChannelOnly));
EOF
