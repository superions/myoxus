#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/build/server/docker-compose.selfhost.yml"
OUTPUT_DIR="${MYOXUS_UPDATE_E2E_OUTPUT_DIR:-$ROOT_DIR/output/playwright/client-update-control}"
WORKSPACE_NAME="${MYOXUS_UPDATE_E2E_WORKSPACE_NAME:-Beta}"
API_CONTAINER=""

fail() {
  printf 'client.update-control: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -z "$API_CONTAINER" ]] || ! docker inspect "$API_CONTAINER" >/dev/null 2>&1; then
    return
  fi

  local current operation phase
  if [[ "$(docker inspect -f '{{.State.Running}}' "$API_CONTAINER" 2>/dev/null || true)" != "true" ]]; then
    docker start "$API_CONTAINER" >/dev/null 2>&1 || true
    sleep 2
  fi
  current="$(docker exec "$API_CONTAINER" myoxus-cli client-update status --json 2>/dev/null || true)"
  operation="$(node -e 'const x=JSON.parse(process.argv[1]||"{}"); process.stdout.write(x.operationId??"")' "$current" 2>/dev/null || true)"
  phase="$(node -e 'const x=JSON.parse(process.argv[1]||"{}"); process.stdout.write(x.phase??"")' "$current" 2>/dev/null || true)"
  if [[ "$phase" != "normal" && -n "$operation" ]]; then
    docker exec "$API_CONTAINER" myoxus-cli client-update update-abort \
      --operation-id "$operation" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "${MYOXUS_VISUAL_EMAIL:-}" || -z "${MYOXUS_VISUAL_PASSWORD:-}" ]]; then
  SEED_CREDENTIALS="$(
    sed -n 's|^#   Admin:[[:space:]]*\([^[:space:]]*\)[[:space:]]*/[[:space:]]*\([^[:space:]]*\).*|\1 \2|p' \
      "$ROOT_DIR/build/scripts/test/seed-test-users.sh" |
      head -1
  )"
  [[ -n "$SEED_CREDENTIALS" ]] ||
    fail "local seed credentials could not be derived from seed-test-users.sh"
  read -r MYOXUS_VISUAL_EMAIL MYOXUS_VISUAL_PASSWORD <<<"$SEED_CREDENTIALS"
  export MYOXUS_VISUAL_EMAIL MYOXUS_VISUAL_PASSWORD
fi

"$ROOT_DIR/build/scripts/server/stack-status.sh" >/dev/null ||
  fail "the local development stack is not healthy"

API_CONTAINER="$(
  docker compose -f "$COMPOSE_FILE" ps -q api
)"
[[ -n "$API_CONTAINER" ]] || fail "the local API container is not running"

WORKSPACES="$(
  docker exec "$API_CONTAINER" myoxus-cli workspaces list --json
)"
WORKSPACE_ID="${MYOXUS_UPDATE_E2E_WORKSPACE_ID:-$(
  node -e '
    const rows = JSON.parse(process.argv[1]);
    const match = rows.find(row => row.name === process.argv[2]);
    if (match) process.stdout.write(match.id);
  ' "$WORKSPACES" "$WORKSPACE_NAME"
)}"
[[ -n "$WORKSPACE_ID" ]] ||
  fail "workspace '$WORKSPACE_NAME' was not found; set MYOXUS_UPDATE_E2E_WORKSPACE_ID explicitly"

INITIAL_STATUS="$(
  docker exec "$API_CONTAINER" myoxus-cli client-update status --json
)"
INITIAL_PHASE="$(
  node -e 'process.stdout.write(JSON.parse(process.argv[1]).phase)' "$INITIAL_STATUS"
)"
[[ "$INITIAL_PHASE" == "normal" ]] ||
  fail "client update control must be normal before the E2E journey"

rm -rf "$OUTPUT_DIR/profile"
mkdir -p "$OUTPUT_DIR"

export MYOXUS_UPDATE_E2E_API_CONTAINER="$API_CONTAINER"
export MYOXUS_UPDATE_E2E_WORKSPACE_ID="$WORKSPACE_ID"
export MYOXUS_UPDATE_E2E_OUTPUT_DIR="$OUTPUT_DIR"

cd "$ROOT_DIR"
node build/scripts/test/client-update-control-e2e.mjs

FINAL_PHASE="$(
  docker exec "$API_CONTAINER" myoxus-cli client-update status --json |
    node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).phase))'
)"
[[ "$FINAL_PHASE" == "normal" ]] ||
  fail "the E2E journey did not restore the normal server phase"

printf 'client.update-control: PASS (%s)\n' "$OUTPUT_DIR/report.json"
