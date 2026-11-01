#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEV_DIR="$REPO_ROOT/tmp/dev"
GATEWAY_ORIGIN="${MYOXUS_DEV_GATEWAY_ORIGIN:-http://127.0.0.1:${MYOXUS_DEV_GATEWAY_PORT:-3011}}"

if [[ -f "$DEV_DIR/dev.env" ]]; then
  # shellcheck disable=SC1090
  source "$DEV_DIR/dev.env"
  GATEWAY_ORIGIN="${MYOXUS_DEV_GATEWAY_ORIGIN:-$GATEWAY_ORIGIN}"
fi

echo "[INFO] dev dir: $DEV_DIR"
for name in web-dev admin-dev api-dev dev-gateway; do
  pid_file="$DEV_DIR/${name}.pid"
  if [[ -s "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "[PASS] $name running PID $(cat "$pid_file")"
  else
    echo "[INFO] $name not running"
  fi
done

if curl -fsS "$GATEWAY_ORIGIN/health" >/dev/null 2>&1; then
  echo "[PASS] dev gateway health: $GATEWAY_ORIGIN/health"
else
  echo "[INFO] dev gateway health not reachable: $GATEWAY_ORIGIN/health"
fi
