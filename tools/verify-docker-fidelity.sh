#!/usr/bin/env bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:local}
evidence=${EVIDENCE_DIR:-"$repo/artifacts/fidelity"}
run_id="dom-mirror-fidelity-$(date +%s)-$$"
server_ok="$run_id-ok"
server_trap="$run_id-trap"
client="$run_id-client"
proxy_env=(-e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= -e ALL_PROXY= -e all_proxy=)
mkdir -p "$evidence"

cleanup() {
  status=$?
  trap - EXIT
  docker logs "$server_ok" > "$evidence/server-ok.log" 2>&1 || true
  docker logs "$server_trap" > "$evidence/server-trap.log" 2>&1 || true
  docker logs "$client" > "$evidence/client.log" 2>&1 || true
  docker cp "$client:/tmp/fidelity-evidence/." "$evidence/" >/dev/null 2>&1 || true
  docker rm -f "$client" "$server_ok" "$server_trap" >/dev/null 2>&1 || true
  docker network rm "$run_id" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker network create --internal "$run_id" >/dev/null
# 两台引擎：健康 + XY_FIDELITY_TRAP=1（服务端测量扰动，模拟站点改版漂移）
docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" -d --name "$server_ok" --network "$run_id" --network-alias ok \
  "${proxy_env[@]}" --memory 2g --cpus 2 -e PROD_PRESENTATION=1 -e MAX_SESSIONS=8 \
  -e ORIGIN_URL=http://127.0.0.1:8077/fidelity.html \
  "$image" timeout 300 node demo/server.js >/dev/null
docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" -d --name "$server_trap" --network "$run_id" --network-alias trap \
  "${proxy_env[@]}" --memory 2g --cpus 2 -e PROD_PRESENTATION=1 -e MAX_SESSIONS=8 \
  -e ORIGIN_URL=http://127.0.0.1:8077/fidelity.html -e XY_FIDELITY_TRAP=1 -e XY_FIDELITY_DOWNGRADE=1 \
  "$image" timeout 300 node demo/server.js >/dev/null
for f in fidelity.html img.png; do
  docker cp "$repo/test/fixtures/$f" "$server_ok:/app/protected/$f"
  docker cp "$repo/test/fixtures/$f" "$server_trap:/app/protected/$f"
done

for srv in "$server_ok" "$server_trap"; do
  docker exec "$srv" node -e '
    (async () => {
      for (let i = 0; i < 40; i++) {
        try { if ((await fetch("http://127.0.0.1:8088/", {signal: AbortSignal.timeout(1000)})).ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      process.exit(1);
    })().catch(() => process.exit(1));
  '
done

run_client() { # $1 mode  $2 alias
  docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" --rm --network "$run_id" --memory 1g \
    "${proxy_env[@]}" \
    -e MIRROR_URL="http://$2:8088/" -e FIDELITY_MODE="$1" -e EVIDENCE_DIR=/tmp/fidelity-evidence \
    --entrypoint timeout "$image" 240 node tools/verify-fidelity.cjs
}

run_client ok ok
run_client trap trap

# 引擎侧日志断言（消息级断言在 cjs 内）；容器 stdout 刷进 docker log store
# 有秒级时滞，带重试
log_wait() { # $1 容器  $2 模式
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if docker logs "$1" 2>&1 | grep -aq "$2"; then return 0; fi
    sleep 1
  done
  echo "FAIL: $1 无匹配日志: $2"; docker logs "$1" 2>&1 | grep -a fidelity | tail -5; return 1
}
log_wait "$server_ok" '\[fidelity\] layout ok'
log_wait "$server_trap" '\[fidelity\] downgrade dom->frame'
log_wait "$server_trap" '\[fidelity\] origin cooldown' 
echo 'FIDELITY-DOCKER-PASS'
