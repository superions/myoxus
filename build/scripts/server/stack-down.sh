#!/usr/bin/env bash
# Stop and remove all selfhost stack containers.
# Run from anywhere in the repo.
#
# Usage:
#   build/scripts/server/stack-down.sh [--volumes]
#
# Options:
#   --volumes   Also delete persistent data volumes (postgres + redis data).
#               WARNING: this destroys all data. Use only for clean-slate resets.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_ROOT/build/scripts/server/require-runtime-profile.sh" verify
COMPOSE_FILE="$REPO_ROOT/build/server/docker-compose.selfhost.yml"

EXTRA_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--volumes" ]]; then
    [[ "$MYOXUS_RUNTIME_MODE" != maintenance ]] || { echo "Persistent maintenance volumes cannot be removed" >&2; exit 1; }
    echo "[WARN] --volumes specified: persistent data will be deleted"
    EXTRA_ARGS+=("-v")
  fi
done

if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  docker compose -f "$COMPOSE_FILE" down "${EXTRA_ARGS[@]}"
else
  docker compose -f "$COMPOSE_FILE" down
fi
echo "[INFO] stack stopped"
