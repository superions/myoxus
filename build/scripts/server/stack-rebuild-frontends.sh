#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build the two static frontend OCI artifacts, materialize them, and recreate
# the single operator-owned Nginx service. This path deliberately runs no broad
# Vitest suite; release and changed-path gates remain owned by the test matrix.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
source "$REPO_ROOT/build/scripts/server/require-runtime-profile.sh" verify-build
COMPOSE_FILE="$REPO_ROOT/build/server/docker-compose.selfhost.yml"
FRONTEND_PORT="${MYOXUS_FRONTEND_PORT:-3010}"
export MYOXUS_FRONTEND_ASSET_ROOT="${MYOXUS_FRONTEND_ASSET_ROOT:-$REPO_ROOT/build/server/runtime-frontends/current}"
BUILD_ARGS=()

case "${1:-}" in
  "") ;;
  --no-cache) BUILD_ARGS+=(--no-cache) ;;
  --help|-h)
    echo "Usage: $0 [--no-cache]"
    exit 0
    ;;
  *)
    echo "[FAIL] unknown argument: $1" >&2
    exit 2
    ;;
esac
[ "$#" -le 1 ] || { echo "[FAIL] too many arguments" >&2; exit 2; }

cd "$REPO_ROOT"
echo "[INFO] checking the static frontend delivery contract"
node build/scripts/ci/verify-frontend-container-isolation.mjs

if [ "${#BUILD_ARGS[@]}" -gt 0 ]; then
  "$REPO_ROOT/build/scripts/frontends/build-and-materialize-local.sh" \
    "${BUILD_ARGS[@]}"
else
  "$REPO_ROOT/build/scripts/frontends/build-and-materialize-local.sh"
fi

mkdir -p "$REPO_ROOT/playwright/.qa"
echo "[INFO] recreating the single frontend delivery service"
docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate frontend

echo "[INFO] waiting for http://127.0.0.1:${FRONTEND_PORT}/health"
for attempt in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${FRONTEND_PORT}/health" >/dev/null 2>&1; then
    echo "[PASS] frontend delivery is healthy after $((attempt * 2)) seconds"
    "$REPO_ROOT/build/scripts/server/smoke-frontend-selfhost.sh"
    exit 0
  fi
  sleep 2
done

echo "[FAIL] frontend delivery did not become healthy within 180 seconds" >&2
docker compose -f "$COMPOSE_FILE" ps >&2 || true
docker compose -f "$COMPOSE_FILE" logs --tail 60 frontend >&2 || true
exit 2
