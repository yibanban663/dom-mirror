#!/usr/bin/env bash
set -euo pipefail
# Instrument only the diagnostic host. Client/preflight/Chromium keep their flags.
if [[ "${*: -1}" == tools/memory-host.cjs || "${*: -1}" == tools/allocator-business-host.cjs ]]; then
  node_flags=(--require /app/tools/memory-v8-preload.cjs)
  if [[ "${MEMORY_V8_TRACE:-0}" == 1 ]]; then node_flags+=(--trace-gc --trace-gc-verbose); fi
  if [[ -n "${MEMORY_MAX_SEMI_SPACE:-}" ]]; then
    [[ "$MEMORY_MAX_SEMI_SPACE" =~ ^[0-9]+$ ]] && (( MEMORY_MAX_SEMI_SPACE >= 1 && MEMORY_MAX_SEMI_SPACE <= 64 )) || exit 2
    node_flags+=("--max-semi-space-size=$MEMORY_MAX_SEMI_SPACE")
  fi
  set -- "${@:1:$#-1}" "${node_flags[@]}" "${@: -1}"
fi
exec /usr/local/bin/docker-entrypoint.sh "$@"
