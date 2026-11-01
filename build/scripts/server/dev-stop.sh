#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
DEV_DIR="$REPO_ROOT/tmp/dev"
COMPOSE_FILE="$REPO_ROOT/build/server/docker-compose.selfhost.yml"
STOP_INFRA=false

# Command names alone do not establish ownership on shared development hosts.
# Restrict managed PID files and orphan discovery to this physical checkout.
belongs_to_checkout() {
  local pid="$1" cwd
  if [[ -d "/proc/$pid" ]]; then
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  else
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
  fi
  [[ "$cwd" == "$REPO_ROOT" || "$cwd" == "$REPO_ROOT/"* ]]
}

stop_owned_process() {
  local pid="$1" signal="${2:-TERM}" pgid member all_owned=true
  belongs_to_checkout "$pid" || return 0
  pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')"
  [[ -n "$pgid" ]] || return 0
  while read -r member; do
    belongs_to_checkout "$member" || all_owned=false
  done < <(ps -axo pid=,pgid= | awk -v group="$pgid" '$2 == group { print $1 }')
  if [[ "$all_owned" == true ]]; then
    kill -s "$signal" -- "-$pgid" 2>/dev/null || true
  else
    kill -s "$signal" "$pid" 2>/dev/null || true
  fi
}

if [[ "${1:-}" == "--infra" ]]; then
  STOP_INFRA=true
fi

if [[ -d "$DEV_DIR" ]]; then
  for name in dev-gateway admin-dev web-dev api-dev; do
    pid_file="$DEV_DIR/${name}.pid"
    if [[ -s "$pid_file" ]]; then
      pid="$(cat "$pid_file")"
      if kill -0 "$pid" 2>/dev/null && belongs_to_checkout "$pid"; then
        echo "[INFO] stopping $name (PGID $pid)"
        stop_owned_process "$pid"
      fi
    fi
  done

  sleep 2

  for name in dev-gateway admin-dev web-dev api-dev; do
    pid_file="$DEV_DIR/${name}.pid"
    if [[ -s "$pid_file" ]]; then
      pid="$(cat "$pid_file")"
      if kill -0 "$pid" 2>/dev/null && belongs_to_checkout "$pid"; then
        echo "[WARN] force stopping $name (PGID $pid)"
        stop_owned_process "$pid" KILL
      fi
      rm -f "$pid_file"
    fi
  done
fi

for pattern in \
  "node build/scripts/server/dev-gateway.mjs" \
  "myoxus bundle --dev --package @myoxus/web" \
  "myoxus bundle --dev --package @myoxus/admin" \
  "myoxus.ts bundle --dev --package @myoxus/web" \
  "myoxus.ts bundle --dev --package @myoxus/admin" \
  "cargo run -p myoxus-api --bin server"; do
  while read -r pid pgid; do
    [[ -n "${pid:-}" && -n "${pgid:-}" ]] || continue
    belongs_to_checkout "$pid" || continue
    echo "[WARN] stopping unmanaged dev process matching: $pattern (PGID $pgid)"
    stop_owned_process "$pid"
  done < <(pgrep -f "$pattern" | while read -r pid; do ps -o pid=,pgid= -p "$pid"; done)
done

if [[ "$STOP_INFRA" == true ]]; then
  echo "[INFO] stopping Docker data services postgres/redis"
  (cd "$REPO_ROOT/build/server" && docker compose -f "$COMPOSE_FILE" stop postgres redis >/dev/null)
fi

echo "[PASS] dev processes stopped"
