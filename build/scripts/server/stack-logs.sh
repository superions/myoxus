#!/usr/bin/env bash
# Stream or tail logs from one or all selfhost stack services.
# Run from anywhere in the repo.
#
# Usage:
#   build/scripts/server/stack-logs.sh [service] [--tail N]
#
# Examples:
#   build/scripts/server/stack-logs.sh           # follow all services
#   build/scripts/server/stack-logs.sh api        # follow API logs only
#   build/scripts/server/stack-logs.sh api --tail 100  # last 100 lines then follow

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/build/server/docker-compose.selfhost.yml"

docker compose -f "$COMPOSE_FILE" logs -f "$@"
