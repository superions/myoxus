#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Idempotently ensure the local Web/Admin frontend development loop is running.
# This helper is intentionally container-free: normal frontend migration work
# should reuse the Rspack devservers and gateway instead of rebuilding Docker
# images for every visual review.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
DEV_DIR="$REPO_ROOT/tmp/dev"
mkdir -p "$DEV_DIR"
DEV_ENV="$DEV_DIR/dev.env"

EXPLICIT_GATEWAY_HOST="${MYOXUS_DEV_GATEWAY_HOST:-}"
EXPLICIT_GATEWAY_PORT="${MYOXUS_DEV_GATEWAY_PORT:-}"
EXPLICIT_WEB_PORT="${MYOXUS_WEB_DEV_PORT:-}"
EXPLICIT_ADMIN_PORT="${MYOXUS_ADMIN_DEV_PORT:-}"
EXPLICIT_BACKEND_ORIGIN="${MYOXUS_DEV_BACKEND_ORIGIN:-}"
EXPLICIT_GATEWAY_ORIGIN="${MYOXUS_DEV_GATEWAY_ORIGIN:-}"
EXPLICIT_WEB_ORIGIN="${MYOXUS_DEV_WEB_ORIGIN:-}"
EXPLICIT_ADMIN_ORIGIN="${MYOXUS_DEV_ADMIN_ORIGIN:-}"

if [[ -f "$DEV_ENV" ]]; then
  # Reuse prior non-default dev origins for idempotent follow-up calls, while
  # keeping explicit environment overrides authoritative for this invocation.
  # shellcheck disable=SC1090
  source "$DEV_ENV"
fi

[[ -n "$EXPLICIT_GATEWAY_HOST" ]] && MYOXUS_DEV_GATEWAY_HOST="$EXPLICIT_GATEWAY_HOST"
[[ -n "$EXPLICIT_GATEWAY_PORT" ]] && MYOXUS_DEV_GATEWAY_PORT="$EXPLICIT_GATEWAY_PORT"
[[ -n "$EXPLICIT_WEB_PORT" ]] && MYOXUS_WEB_DEV_PORT="$EXPLICIT_WEB_PORT"
[[ -n "$EXPLICIT_ADMIN_PORT" ]] && MYOXUS_ADMIN_DEV_PORT="$EXPLICIT_ADMIN_PORT"
[[ -n "$EXPLICIT_BACKEND_ORIGIN" ]] && MYOXUS_DEV_BACKEND_ORIGIN="$EXPLICIT_BACKEND_ORIGIN"
[[ -n "$EXPLICIT_GATEWAY_ORIGIN" ]] && MYOXUS_DEV_GATEWAY_ORIGIN="$EXPLICIT_GATEWAY_ORIGIN"
[[ -n "$EXPLICIT_WEB_ORIGIN" ]] && MYOXUS_DEV_WEB_ORIGIN="$EXPLICIT_WEB_ORIGIN"
[[ -n "$EXPLICIT_ADMIN_ORIGIN" ]] && MYOXUS_DEV_ADMIN_ORIGIN="$EXPLICIT_ADMIN_ORIGIN"

origin_host() {
  local origin="$1"
  local host_port="${origin#*://}"
  host_port="${host_port%%/*}"
  printf '%s' "${host_port%:*}"
}

origin_port() {
  local origin="$1"
  local fallback="$2"
  local host_port="${origin#*://}"
  host_port="${host_port%%/*}"
  if [[ "$host_port" == *:* ]]; then
    printf '%s' "${host_port##*:}"
  else
    printf '%s' "$fallback"
  fi
}

BACKEND_ORIGIN="${MYOXUS_DEV_BACKEND_ORIGIN:-http://127.0.0.1:3010}"
WEB_ORIGIN="${MYOXUS_DEV_WEB_ORIGIN:-http://127.0.0.1:${MYOXUS_WEB_DEV_PORT:-3012}}"
ADMIN_ORIGIN="${MYOXUS_DEV_ADMIN_ORIGIN:-http://127.0.0.1:${MYOXUS_ADMIN_DEV_PORT:-3013}}"
GATEWAY_ORIGIN="${MYOXUS_DEV_GATEWAY_ORIGIN:-http://${MYOXUS_DEV_GATEWAY_HOST:-127.0.0.1}:${MYOXUS_DEV_GATEWAY_PORT:-3011}}"
HOST="${MYOXUS_DEV_GATEWAY_HOST:-$(origin_host "$GATEWAY_ORIGIN")}"
GATEWAY_PORT="${MYOXUS_DEV_GATEWAY_PORT:-$(origin_port "$GATEWAY_ORIGIN" 3011)}"
WEB_PORT="${MYOXUS_WEB_DEV_PORT:-$(origin_port "$WEB_ORIGIN" 3012)}"
ADMIN_PORT="${MYOXUS_ADMIN_DEV_PORT:-$(origin_port "$ADMIN_ORIGIN" 3013)}"

usage() {
  cat <<'EOF'
Usage: build/scripts/server/frontend-dev-ensure.sh

Ensures the local Web/Admin frontend development gateway is available without
building or restarting frontend containers. Already running dev processes are
reused; missing processes are started with the standard Rspack dev commands.

Environment overrides:
  MYOXUS_DEV_BACKEND_ORIGIN   Backend/selfhost origin, default http://127.0.0.1:3010
  MYOXUS_DEV_GATEWAY_HOST     Dev gateway host, default 127.0.0.1
  MYOXUS_DEV_GATEWAY_PORT     Dev gateway port, default 3011
  MYOXUS_WEB_DEV_PORT         Web Rspack devserver port, default 3012
  MYOXUS_ADMIN_DEV_PORT       Admin Rspack devserver port, default 3013
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[FAIL] missing required command: $1" >&2
    exit 1
  }
}

is_running() {
  local pid_file="$1"
  [[ -s "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

clear_stale_pid() {
  local pid_file="$1"
  if [[ -e "$pid_file" ]] && ! is_running "$pid_file"; then
    rm -f "$pid_file"
  fi
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1 &&
    ss -ltn "sport = :$port" | grep -q LISTEN; then
    return 0
  fi
  if command -v lsof >/dev/null 2>&1 &&
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

require_free_port_for_start() {
  local port="$1"
  local name="$2"
  if port_in_use "$port"; then
    echo "[FAIL] $name port $port is already in use but no managed dev PID is running." >&2
    echo "       Inspect with build/scripts/server/dev-status.sh or stop stale processes with build/scripts/server/dev-stop.sh." >&2
    exit 1
  fi
}

write_dev_env() {
  cat >"$DEV_DIR/dev.env" <<EOF
MYOXUS_DEV_GATEWAY_ORIGIN=$GATEWAY_ORIGIN
MYOXUS_DEV_BACKEND_ORIGIN=$BACKEND_ORIGIN
MYOXUS_DEV_WEB_ORIGIN=$WEB_ORIGIN
MYOXUS_DEV_ADMIN_ORIGIN=$ADMIN_ORIGIN
EOF
}

start_process() {
  local name="$1"
  shift
  local pid_file="$DEV_DIR/${name}.pid"
  local log_file="$DEV_DIR/${name}.log"

  clear_stale_pid "$pid_file"
  if is_running "$pid_file"; then
    echo "[INFO] $name already running with PID $(cat "$pid_file")"
    return 0
  fi

  echo "[INFO] starting $name (log: $log_file)"
  (
    cd "$REPO_ROOT"
    if command -v setsid >/dev/null 2>&1; then
      setsid nohup "$@" >"$log_file" 2>&1 </dev/null &
    else
      nohup "$@" >"$log_file" 2>&1 </dev/null &
    fi
    echo $! >"$pid_file"
  )
}

wait_url() {
  local name="$1"
  local url="$2"
  local needle="${3:-}"
  for _ in $(seq 1 120); do
    if body="$(curl -fsS "$url" 2>/dev/null)"; then
      if [[ -z "$needle" || "$body" == *"$needle"* ]]; then
        echo "[PASS] $name ready at $url"
        return 0
      fi
    fi
    sleep 1
  done
  echo "[FAIL] $name did not become ready at $url" >&2
  for log in "$DEV_DIR"/*.log; do
    [[ -f "$log" ]] || continue
    echo "--- tail $log ---" >&2
    tail -40 "$log" >&2 || true
  done
  exit 1
}

ensure_running_process_is_healthy() {
  local name="$1"
  local pid_file="$DEV_DIR/${name}.pid"

  if ! is_running "$pid_file"; then
    return 0
  fi

  # Rspack can be temporarily unavailable while recompiling after a source edit;
  # the following wait_url call performs the actual readiness gate.
  echo "[INFO] reusing $name PID $(cat "$pid_file")"
}

require_cmd node
require_cmd yarn
require_cmd curl

if ! curl -fsS "$BACKEND_ORIGIN/health" >/dev/null 2>&1; then
  echo "[FAIL] backend origin is not healthy: $BACKEND_ORIGIN/health" >&2
  echo "       Start the normal stack first or pass MYOXUS_DEV_BACKEND_ORIGIN." >&2
  exit 1
fi

clear_stale_pid "$DEV_DIR/web-dev.pid"
clear_stale_pid "$DEV_DIR/admin-dev.pid"
clear_stale_pid "$DEV_DIR/dev-gateway.pid"
write_dev_env

ensure_running_process_is_healthy "web-dev"
if ! is_running "$DEV_DIR/web-dev.pid"; then
  require_free_port_for_start "$WEB_PORT" "web devserver"
  start_process web-dev env \
    MYOXUS_RSPACK_DEV_PUBLIC_PATH=/ \
    PUBLIC_PATH=/ \
    yarn myoxus bundle --dev --package @myoxus/web \
    --dev-server-host 127.0.0.1 \
    --dev-server-port "$WEB_PORT" \
    --dev-server-client-host 127.0.0.1 \
    --dev-server-client-port "$WEB_PORT" \
    --dev-server-proxy-origin "$BACKEND_ORIGIN" \
    --dev-server-public-path /
fi
wait_url "web devserver" "$WEB_ORIGIN/" "<html"

ensure_running_process_is_healthy "admin-dev"
if ! is_running "$DEV_DIR/admin-dev.pid"; then
  require_free_port_for_start "$ADMIN_PORT" "admin devserver"
  start_process admin-dev env \
    MYOXUS_RSPACK_DEV_PUBLIC_PATH=/adminfrontend/ \
    PUBLIC_PATH=/adminfrontend/ \
    yarn myoxus bundle --dev --package @myoxus/admin \
    --dev-server-host 127.0.0.1 \
    --dev-server-port "$ADMIN_PORT" \
    --dev-server-client-host 127.0.0.1 \
    --dev-server-client-port "$ADMIN_PORT" \
    --dev-server-proxy-origin "$BACKEND_ORIGIN" \
    --dev-server-public-path /adminfrontend/
fi
wait_url "admin devserver" "$ADMIN_ORIGIN/adminfrontend/" "<html"

ensure_running_process_is_healthy "dev-gateway"
if ! is_running "$DEV_DIR/dev-gateway.pid"; then
  require_free_port_for_start "$GATEWAY_PORT" "dev gateway"
  start_process dev-gateway env \
    MYOXUS_DEV_GATEWAY_HOST="$HOST" \
    MYOXUS_DEV_GATEWAY_PORT="$GATEWAY_PORT" \
    MYOXUS_DEV_WEB_ORIGIN="$WEB_ORIGIN" \
    MYOXUS_DEV_ADMIN_ORIGIN="$ADMIN_ORIGIN" \
    MYOXUS_DEV_BACKEND_ORIGIN="$BACKEND_ORIGIN" \
    node build/scripts/server/dev-gateway.mjs
fi
wait_url "dev gateway" "$GATEWAY_ORIGIN/health" "ok"
wait_url "dev gateway web" "$GATEWAY_ORIGIN/" "<html"
wait_url "dev gateway admin" "$GATEWAY_ORIGIN/adminfrontend/" "<html"

cat <<MSG

[PASS] fast frontend dev is available
  Web:          $GATEWAY_ORIGIN/
  Admin:        $GATEWAY_ORIGIN/adminfrontend/
  Dev gateway:  $GATEWAY_ORIGIN
  Backend:      $BACKEND_ORIGIN
  Logs/PIDs:    $DEV_DIR

Stop with:
  build/scripts/server/dev-stop.sh
MSG
