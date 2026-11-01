#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEV_DIR="$REPO_ROOT/tmp/dev"
COMPOSE_FILE="$REPO_ROOT/build/server/docker-compose.selfhost.yml"
mkdir -p "$DEV_DIR"

POSTGRES_USER="${POSTGRES_USER:-myoxus}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-myoxus}"
POSTGRES_DB="${POSTGRES_DB:-myoxus}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"
API_HOST="${MYOXUS_DEV_API_HOST:-127.0.0.1}"
API_PORT="${MYOXUS_DEV_API_PORT:-3001}"
GATEWAY_PORT="${MYOXUS_DEV_GATEWAY_PORT:-3011}"
GATEWAY_ORIGIN="http://127.0.0.1:${GATEWAY_PORT}"
API_ORIGIN="http://${API_HOST}:${API_PORT}"
DATA_DIR="${MYOXUS_DATA_DIR:-$REPO_ROOT/build/server/data}"
RUNTIME_CONFIG_DIR="${MYOXUS_RUNTIME_CONFIG_DIR:-$DEV_DIR/runtime-config}"
DEFAULT_LOG_LEVEL="info,sqlx::query=warn,tungstenite=warn,tokio_tungstenite=warn,axum::serve=warn,hyper=warn,tower_http=warn,h2=warn,rustls=warn"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[FAIL] missing required command: $1" >&2
    exit 1
  }
}

require_free_port() {
  local port="$1"
  local name="$2"
  if command -v ss >/dev/null 2>&1 &&
    ss -ltn "sport = :$port" | grep -q LISTEN; then
    echo "[FAIL] $name port $port is already in use. Stop the conflicting process or override the port." >&2
    exit 1
  fi
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

start_api() {
  local pid_file="$DEV_DIR/api-dev.pid"
  local log_file="$DEV_DIR/api-dev.log"
  clear_stale_pid "$pid_file"
  if is_running "$pid_file"; then
    echo "[FAIL] api-dev is already running with PID $(cat "$pid_file"). Use build/scripts/server/dev-stop.sh first." >&2
    exit 1
  fi

  mkdir -p "$DATA_DIR/storage" "$DATA_DIR/logs" "$DATA_DIR/git-sync"
  echo "[INFO] starting local Rust API (log: $log_file)"
  (
    cd "$REPO_ROOT/server"
    setsid nohup env \
      RUN_MODE=development \
      RUST_MIN_STACK="${RUST_MIN_STACK:-16777216}" \
      MYOXUS__SERVER__HOST="$API_HOST" \
      MYOXUS__SERVER__PORT="$API_PORT" \
      MYOXUS__SERVER__ORIGIN="$GATEWAY_ORIGIN" \
      MYOXUS__DATABASE__URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}" \
      MYOXUS__REDIS__URL="redis://127.0.0.1:${REDIS_PORT}" \
      MYOXUS__STORAGE__ROOT="$DATA_DIR/storage" \
      MYOXUS__LOGGING__LEVEL="${MYOXUS_LOG_LEVEL:-$DEFAULT_LOG_LEVEL}" \
      MYOXUS__LOGGING__FILE_PATH="$DATA_DIR/logs/myoxus.log" \
      MYOXUS__GIT_SYNC__REPO_BASE_DIR="$DATA_DIR/git-sync" \
      MYOXUS__CONFIG__WRITEBACK_PATH="$RUNTIME_CONFIG_DIR/local.yaml" \
      cargo run -p myoxus-api --bin server >"$log_file" 2>&1 </dev/null &
    echo $! >"$pid_file"
  )
}

wait_cmd() {
  local name="$1"
  local attempts="$2"
  shift 2
  for _ in $(seq 1 "$attempts"); do
    if "$@" >/dev/null 2>&1; then
      echo "[PASS] $name ready"
      return 0
    fi
    sleep 1
  done
  echo "[FAIL] $name did not become ready" >&2
  docker compose -f "$COMPOSE_FILE" ps >&2 || true
  tail -80 "$DEV_DIR/api-dev.log" >&2 || true
  exit 1
}

wait_infra() {
  local name="$1"
  shift
  wait_cmd "$name" 90 "$@"
}

require_cmd cargo
require_cmd curl
require_cmd docker
require_cmd yarn

require_free_port "$API_PORT" "local api"

export POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB POSTGRES_PORT REDIS_PORT
export MYOXUS_RUNTIME_CONFIG_DIR="$RUNTIME_CONFIG_DIR"
# shellcheck source=build/scripts/server/prepare-selfhost-runtime.sh
source "$REPO_ROOT/build/scripts/server/prepare-selfhost-runtime.sh"

echo "[INFO] starting Docker data services only (postgres, redis)"
(cd "$REPO_ROOT/build/server" && docker compose -f "$COMPOSE_FILE" up -d postgres redis)

wait_infra "postgres" docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
wait_infra "redis" docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli ping

start_api
wait_cmd "local api $API_ORIGIN/health" "${MYOXUS_DEV_API_START_TIMEOUT:-300}" curl -fsS "$API_ORIGIN/health"

MYOXUS_DEV_BACKEND_ORIGIN="$API_ORIGIN" \
MYOXUS_DEV_GATEWAY_PORT="$GATEWAY_PORT" \
  "$REPO_ROOT/build/scripts/server/dev-frontends.sh"

cat <<MSG

[PASS] fast fullstack dev is running
  Web:          $GATEWAY_ORIGIN/
  Admin:        $GATEWAY_ORIGIN/adminfrontend/
  Local API:    $API_ORIGIN
  Data:         Docker postgres:$POSTGRES_PORT redis:$REDIS_PORT
  Logs/PIDs:    $DEV_DIR

Stop local processes with:
  build/scripts/server/dev-stop.sh
Stop local processes and data-service containers with:
  build/scripts/server/dev-stop.sh --infra
MSG
