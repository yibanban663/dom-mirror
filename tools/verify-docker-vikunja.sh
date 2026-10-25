#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:local}
test_script=${BUSINESS_TEST_SCRIPT:-verify-vikunja.cjs}
[[ "$test_script" == verify-vikunja.cjs || "$test_script" == verify-recovery.cjs || "$test_script" == profile-business.cjs ]] || exit 2
business_image=vikunja/vikunja@sha256:f7dc8428d10aef17f3075886d3c1c022f566ec456f88985f02c137f4fc534576
evidence=${EVIDENCE_DIR:-"$repo/artifacts/vikunja"}
run_id="dom-mirror-vikunja-$(date +%s)-$$"
app="$run_id-app"
server="$run_id-server"
client="$run_id-client"
server_entry=demo/server.js
server_mount=()
allocator_profile=${BUSINESS_ALLOCATOR_PROFILE:-}
[[ -z "$allocator_profile" || "$allocator_profile" == jemalloc ]] || exit 2
allocator_env=()
if [[ "$allocator_profile" == jemalloc ]]; then
  [[ "${PROFILE:-0}" != 1 ]] || exit 2
  server_entry=tools/allocator-business-host.cjs
  allocator_env=(-e LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
    -e MALLOC_CONF=narenas:2,background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000)
fi
if [[ "${PROFILE:-0}" == 1 ]]; then
  server_entry=tools/profile-server.cjs
  server_mount=(-v "$repo/tools:/app/tools:ro" -v "$repo/server.js:/app/server.js:ro")
fi
proxy_env=(-e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= -e ALL_PROXY= -e all_proxy=)
mkdir -p "$evidence"
printf 'cpus=%s\nmemoryMiB=2048\n' "${MIRROR_CPUS:-2}" > "$evidence/mirror-limits.txt"
cleanup() {
  status=$?
  trap - EXIT
  if [[ "${PROFILE:-0}" == 1 ]]; then
    docker stop --time 5 "$server" >/dev/null 2>&1 || true
    docker cp "$server:/tmp/perf-evidence/." "$evidence/" >/dev/null 2>&1 || true
  fi
  docker logs "$app" > "$evidence/app.log" 2>&1 || true
  docker logs "$server" > "$evidence/server.log" 2>&1 || true
  docker logs "$client" > "$evidence/client.log" 2>&1 || true
  docker inspect "$server" "$client" > "$evidence/containers.json" 2>/dev/null || true
  docker cp "$client:/tmp/business-evidence/." "$evidence/" >/dev/null 2>&1 || true
  docker rm -f "$client" "$server" "$app" >/dev/null 2>&1 || true
  docker network rm "$run_id" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
service_secret=$(openssl rand -hex 32)
docker network create --internal "$run_id" >/dev/null
docker run -d --name "$app" --network "$run_id" --network-alias business \
  "${proxy_env[@]}" --memory 768m --cpus 1 \
  --tmpfs /db:rw,uid=1000,gid=1000,size=128m \
  --tmpfs /app/vikunja/files:rw,uid=1000,gid=1000,size=64m \
  -e VIKUNJA_SERVICE_PUBLICURL=http://business:3456/ -e VIKUNJA_CORS_ENABLE=false \
  -e VIKUNJA_SERVICE_ENABLEREGISTRATION=true -e VIKUNJA_MAILER_ENABLED=false \
  -e "VIKUNJA_SERVICE_SECRET=$service_secret" "$business_image" >/dev/null
unset service_secret
docker exec "$app" /app/vikunja/vikunja version > "$evidence/app-version.txt"
docker image inspect "$image" --format '{{json .Id}}' > "$evidence/mirror-image.json"
printf '%s\n' "$business_image" > "$evidence/app-image.txt"
docker run -d --name "$server" --network "$run_id" --network-alias mirror \
  "${proxy_env[@]}" "${allocator_env[@]}" --memory 2g --cpus "${MIRROR_CPUS:-2}" -e PROD_PRESENTATION=1 \
  -e "PROFILE_FRAME_TICK_MS=${PROFILE_FRAME_TICK_MS:-16}" -e "PROFILE_PRESENTATION=${PROFILE_PRESENTATION:-0}" -e "PROFILE_CODEC=${PROFILE_CODEC:-production}" \
  -e "PROFILE_PATCH_MS=${PROFILE_PATCH_MS:-60}" -e "DEFAULT_MODE=${PROFILE_MODE:-dom}" "${server_mount[@]}" \
  -e "SESSION_GRACE_MS=${SESSION_GRACE_MS:-60000}" -e ORIGIN_URL=http://business:3456/ "$image" timeout 330 node "$server_entry" >/dev/null
docker exec "$server" node -e '
  (async () => {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch("http://business:3456/api/v1/info", {signal: AbortSignal.timeout(1000)})).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    process.exit(1);
  })().catch(() => process.exit(1));
'
docker run --name "$client" --network "$run_id" --memory 2g \
  "${proxy_env[@]}" -e BUSINESS_URL=http://business:3456 -e MIRROR_URL=http://mirror:8088/ \
  -e "SESSION_GRACE_MS=${SESSION_GRACE_MS:-60000}" -e EVIDENCE_DIR=/tmp/business-evidence -e "CASES=${CASES:-direct,dom,frame}" \
  -e "PROFILE_PRESENTATION=${PROFILE_PRESENTATION:-0}" -e "DIAGNOSTIC_HOLD_MS=${DIAGNOSTIC_HOLD_MS:-0}" \
  -v "$repo/tools:/app/tools:ro" --entrypoint timeout \
  "$image" 270 node "tools/$test_script"
if [[ "$allocator_profile" == jemalloc ]]; then
  docker exec "$server" node -e '
    (async () => {
      const deadline = Date.now() + Number(process.env.SESSION_GRACE_MS) + 20000;
      while (Date.now() < deadline) {
        const response = await fetch("http://127.0.0.1:8088/__allocator/status", {signal: AbortSignal.timeout(2000)});
        const state = await response.json();
        if (state.allocator.implementation !== "jemalloc" || state.sharpConcurrency !== 1 || !state.browsers.length
          || state.browsers.some(browser => browser.jemallocMapped)) throw Error("Invalid allocator or browser treatment");
        if (state.browsers.every(browser => browser.closed && !browser.connected && browser.processGone)) {
          console.log(JSON.stringify(state)); return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error("Business browsers not reclaimed");
    })().catch(error => { console.error(error); process.exit(1); });
  ' > "$evidence/allocator.json"
fi
