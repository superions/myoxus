#!/usr/bin/env bash
# Rebuild and restart only the API container from latest source code.
# Run from anywhere in the repo — uses absolute paths derived from this script's location.
#
# Usage:
#   build/scripts/server/stack-rebuild-api.sh           # fails on build errors (default)
#   build/scripts/server/stack-rebuild-api.sh --no-cache # force a diagnostic cold image build
#   build/scripts/server/stack-rebuild-api.sh --force    # deploy even if build has warnings
#
# What it does:
#   1. Builds the `api` Docker image (fails on error unless --force)
#   2. Recreates and starts the `api` container
#   3. Waits until the API health endpoint returns 200
#
# Exit codes:
#   0 — build succeeded, API is healthy
#   1 — build failed (container NOT updated, old version still running)
#   2 — build succeeded but API did not become healthy
#
# Prerequisites: postgres and redis containers must already be healthy.
# To start the full stack first: build/scripts/server/stack-up.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_ROOT/build/scripts/server/require-runtime-profile.sh" verify-build
COMPOSE_FILE="$REPO_ROOT/build/server/docker-compose.selfhost.yml"
API_PORT="${MYOXUS_PUBLIC_PORT:-3001}"
MYOXUS_DATA_DIR="${MYOXUS_DATA_DIR:-$REPO_ROOT/build/server/data}"
MYOXUS_API_USER="${MYOXUS_API_USER:-1000:1000}"
export MYOXUS_DATA_DIR MYOXUS_API_USER
export MYOXUS_BUILD_REVISION=localdev
if [ -z "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
  MYOXUS_BUILD_REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf localdev)"
fi
export MYOXUS_SERVER_VERSION="$(
  node "$REPO_ROOT/build/scripts/release/write-release-identity.mjs" \
    --repo "$REPO_ROOT" \
    --role server \
    --revision "$MYOXUS_BUILD_REVISION" \
    --print-version
)"
FORCE=false
NO_CACHE=false

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    --no-cache) NO_CACHE=true ;;
    --help | -h)
      sed -n '1,24p' "$0"
      exit 0
      ;;
    *)
      echo "[FAIL] unknown argument: $arg" >&2
      echo "Use --help for usage." >&2
      exit 1
      ;;
  esac
done

# shellcheck source=build/scripts/server/prepare-selfhost-runtime.sh
MYOXUS_DEFER_TEMPLATE_PREPARATION=true
source "$REPO_ROOT/build/scripts/server/prepare-selfhost-runtime.sh"

echo "[INFO] repo root: $REPO_ROOT"
echo "[INFO] compose:   $COMPOSE_FILE"

cd "$REPO_ROOT"

# Ensure bind-mounted runtime directories are writable by the user configured
# for the API container. This prevents rebuilds from deploying an image that
# immediately crashes on log-file creation after a root-owned clean reset.
mkdir -p "$MYOXUS_DATA_DIR/storage" "$MYOXUS_DATA_DIR/logs" "$MYOXUS_DATA_DIR/git-sync"
chmod -R a+rwx "$MYOXUS_DATA_DIR" 2>/dev/null || true
API_UID="${MYOXUS_API_USER%%:*}"
API_GID="${MYOXUS_API_USER#*:}"
if [[ "$API_UID" != "0" ]]; then
  docker run --rm -v "$MYOXUS_DATA_DIR:/data" alpine:3.20 sh -lc \
    "mkdir -p /data/storage /data/logs /data/git-sync && chown -R $API_UID:$API_GID /data/storage /data/logs /data/git-sync && chmod -R u+rwX,go+rwX /data/storage /data/logs /data/git-sync" \
    >/dev/null
fi

# Step 1: Build image — fail early if build breaks
echo "[INFO] building API image..."
BUILD_FLAGS=()
if [ "$NO_CACHE" = true ]; then
  BUILD_FLAGS+=(--no-cache)
fi
if ! {
  if [ "${#BUILD_FLAGS[@]}" -gt 0 ]; then
    docker compose -f "$COMPOSE_FILE" build "${BUILD_FLAGS[@]}" api
  else
    docker compose -f "$COMPOSE_FILE" build api
  fi
}; then
  echo "[FAIL] API build failed — container NOT updated" >&2
  if [ "$FORCE" = true ]; then
    echo "[WARN] --force: continuing despite build failure" >&2
  else
    echo "[HINT] fix the build errors, then re-run. Use --force to deploy anyway." >&2
    exit 1
  fi
fi

MYOXUS_TEMPLATE_VALIDATOR_IMAGE="${MYOXUS_API_IMAGE:-myoxus-api:local}" prepare_myoxus_templates

# Step 2: Deploy the new image
echo "[INFO] deploying API container..."
docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api

# Step 3: Health check
echo "[INFO] waiting for API health at http://127.0.0.1:${API_PORT}/health ..."
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
    echo "[PASS] API is healthy (took ${i}×2s)"

    # Nginx resolves the API container address when its config is loaded. An
    # API recreation may change that address while the served bundle stays valid.
    # Reload only this runtime profile's running frontend, without rebuilding it.
    if [[ -n "$(docker compose -f "$COMPOSE_FILE" ps --status running --quiet frontend)" ]]; then
      echo "[INFO] refreshing the served frontend API upstream..."
      docker compose -f "$COMPOSE_FILE" exec -T frontend nginx -s reload
    fi

    # Step 4: Run fast admin smoke queries (non-blocking)
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    echo ""
    echo "[INFO] running admin smoke queries..."
    "$SCRIPT_DIR/smoke-admin-queries.sh" || echo "[WARN] Admin smoke tests failed — check manually"

    exit 0
  fi
  sleep 2
done

echo "[FAIL] API did not become healthy within 120s" >&2
docker compose -f "$COMPOSE_FILE" ps >&2
docker compose -f "$COMPOSE_FILE" logs --tail 40 api >&2
exit 2
