#!/usr/bin/env bash
set -euo pipefail

# 通用性基准：六类业务形态，逐 case 独立镜像服务 + 等价断言（会话隔离，避免串扰）
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${IMAGE:-dom-mirror:local}
evidence=${EVIDENCE_DIR:-"$repo/artifacts/generality"}
run_id="dom-mirror-gen-$(date +%s)-$$"
server="$run_id-server"
client="$run_id-client"
proxy_env=(-e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= -e ALL_PROXY= -e all_proxy=)
mkdir -p "$evidence"

cleanup() {
  status=$?
  trap - EXIT
  docker logs "$server" > "$evidence/server-last.log" 2>&1 || true
  docker rm -f "$client" "$server" "$xframe_container" >/dev/null 2>&1 || true
  docker network rm "$run_id" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker network create --internal "$run_id" >/dev/null

overall=0
xframe_container=""
for c in ${CASES:-forms editor media layout style canvas dnd vlist nav anim warm xiframe cshadow audio}; do
  docker rm -f "$server" >/dev/null 2>&1 || true
  case "$c" in
    forms) page=gen-forms.html ;; editor) page=gen-editor.html ;; media) page=gen-media-pix.html ;;
    layout) page=gen-layout.html ;; style) page=gen-style.html ;; canvas) page=gen-canvas-key.html ;;
    dnd) page=gen-dnd.html ;; vlist) page=gen-vlist.html ;; nav) page=gen-forms.html ;; anim) page=gen-anim.html ;; warm) page=gen-style.html ;; xiframe) page=gen-xiframe.html ;; cshadow) page=gen-cshadow.html ;; audio) page=gen-media-audio.html ;;
    *) exit 2 ;;
  esac
  # xiframe 需要第二源站（跨源嵌入目标）：origin-b 静态容器
  if [ "$c" = "xiframe" ]; then
    docker rm -f "$run_id-originb" >/dev/null 2>&1 || true
    docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" -d --name "$run_id-originb" --network "$run_id" --network-alias origin-b \
      "${proxy_env[@]}" \
      -v "$repo/test/fixtures/origin-b:/origin-b:ro" \
      --entrypoint timeout "$image" 240 node tools/origin-static.cjs /origin-b 8000 >/dev/null
    xframe_container="$run_id-originb"
  fi
  # warm 连续访问断言：默认 60s 恢复宽限会让第二访客撞 SESSION_LIMIT——该用例短宽限。
  # 必须在 server 容器启动前设置（-e 取值在 docker run 时求值）
  if [ "$c" = "warm" ]; then SESSION_GRACE_MS=3000; else SESSION_GRACE_MS=60000; fi
  export SESSION_GRACE_MS
  docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" -d --name "$server" --network "$run_id" --network-alias mirror \
    "${proxy_env[@]}" \
    --memory 2g --cpus 2 -e PROD_PRESENTATION=1 -e MAX_SESSIONS=2 \
    -e SESSION_GRACE_MS="${SESSION_GRACE_MS:-60000}" \
    -e SESSION_WARMUP="${SESSION_WARMUP:-1}" -e ORIGIN_ASSET_CACHE_MB="${ORIGIN_ASSET_CACHE_MB:-32}" \
    -e XFRAME_ALLOWED_ORIGINS=http://origin-b:8000 -e XFRAME_REFRESH_MS="${XFRAME_REFRESH_MS:-15000}" \
    -e ORIGIN_URL="http://127.0.0.1:8077/$page" \
    "$image" timeout 240 node demo/server.js >/dev/null
  for f in gen-forms.html gen-editor.html gen-media-pix.html gen-layout.html gen-style.html \
           gen-style-base.css gen-style-imp.css gen-style-late.css gen-canvas-key.html gen-dnd.html gen-vlist.html gen-xiframe.html gen-anim.html gen-cshadow.html gen-media-audio.html \
           pic-a.png pic-b.png pic-c.png; do
    docker cp "$repo/test/fixtures/$f" "$server:/app/protected/$f"
  done
  docker exec "$server" node -e '
    (async () => {
      for (let i = 0; i < 40; i++) {
        try { if ((await fetch("http://127.0.0.1:8088/", {signal: AbortSignal.timeout(1000)})).ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      process.exit(1);
    })().catch(() => process.exit(1));
  '
  if [ "$c" = "xiframe" ]; then
    export XFRAME_REFRESH_MS=4000   # 动态刷新断言：4s 重抓（tick 每 5s 换版本）
  else
    unset XFRAME_REFRESH_MS
  fi
  if docker run --security-opt "seccomp=$repo/docker/seccomp-chromium.json" --rm --name "$client" --network "$run_id" --memory 2g \
    "${proxy_env[@]}" \
    -e CASE="$c" -e MIRROR_URL=http://mirror:8088/ -e EVIDENCE_DIR=/tmp/ev \
    --entrypoint timeout "$image" 200 node tools/verify-generality.cjs > "$evidence/$c.json" 2> "$evidence/$c.err"; then
    echo "gen_${c}_OK"
    # v0.21 RUM 通道断言：forms 会话必须产生 [rum] 心跳或 [rum-beacon] 尾包日志
    # v0.32 镜像复用可观测断言：warm 会话必须出现热页取走与资产缓存命中日志
    if [ "$c" = "warm" ]; then
      warmtake=$(docker logs "$server" 2>&1 | grep -c '\[warm  \] take' || true)
      warmcache=$(docker logs "$server" 2>&1 | grep -cE '\[cache \] (m-)?hit' || true)
      if [ "$warmtake" -ge 1 ] && [ "$warmcache" -ge 1 ]; then
        echo "gen_warmtake_OK(${warmtake}) gen_warmcache_OK(${warmcache})"
      else
        echo "gen_warmtake_FAIL($warmtake) gen_warmcache_FAIL($warmcache)"
        docker logs "$server" 2>&1 | grep -E 'warm|cache' | tail -6
        overall=1
      fi
    fi
    if [ "$c" = "forms" ]; then
      # 尾包在客户端浏览器关闭（pagehide）时才发出，可能晚于客户端容器退出：轮询等待
      rum_seen=0
      for _ in $(seq 1 25); do
        if docker logs "$server" 2>&1 | grep -qE '\[rum(-beacon)?\]'; then rum_seen=1; break; fi
        sleep 0.2
      done
      if [ "$rum_seen" = 1 ]; then
        echo "gen_rum_OK"
      else
        echo "gen_rum_FAIL"
        docker logs "$server" 2>&1 | tail -5
        overall=1
      fi
    fi
  else
    echo "gen_${c}_FAIL"
    cat "$evidence/$c.json" || true
    head -3 "$evidence/$c.err" || true
    docker logs "$server" > "$evidence/server-$c.log" 2>&1 || true
    overall=1
  fi
done
exit $overall
