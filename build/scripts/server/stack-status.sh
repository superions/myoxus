#!/usr/bin/env bash
# Show the current status of all selfhost stack services.
# Run from anywhere in the repo.
#
# Usage:
#   build/scripts/server/stack-status.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/build/server/docker-compose.selfhost.yml"
API_PORT="${MYOXUS_PUBLIC_PORT:-3001}"
FRONTEND_PORT="${MYOXUS_FRONTEND_PORT:-3010}"

echo "=== Container status ==="
docker compose -f "$COMPOSE_FILE" ps

echo
echo "=== Health probes ==="
for endpoint in \
  "API health     http://127.0.0.1:${API_PORT}/health" \
  "API ready      http://127.0.0.1:${API_PORT}/ready" \
  "Frontend health http://127.0.0.1:${FRONTEND_PORT}/health"; do
  label="${endpoint%% http*}"
  url="${endpoint##* }"
  code=$(curl -o /dev/null -s -w '%{http_code}' "$url" 2>/dev/null || echo "ERR")
  if [[ "$code" == "200" ]]; then
    echo "  [OK]   $label → $code"
  else
    echo "  [FAIL] $label → $code"
  fi
done
