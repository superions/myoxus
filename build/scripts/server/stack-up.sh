#!/usr/bin/env bash
# Start the full selfhost stack (all services) and wait until healthy.
# Run from anywhere in the repo — thin wrapper around start-selfhost-real.sh.
#
# Usage:
#   build/scripts/server/stack-up.sh [--rebuild]
#
# Options:
#   --rebuild   Force image rebuild even if nothing changed (passes --build to compose)
#
# Environment overrides (all optional):
#   MYOXUS_PUBLIC_PORT     API port        (default: 3001)
#   MYOXUS_FRONTEND_PORT   Frontend port   (default: 3010)
#   MYOXUS_ADMIN_EMAIL     Admin email     (default: admin@myoxus.local)
#   MYOXUS_ADMIN_PASSWORD  Admin password  (default: AdminMyoxus2026)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$REPO_ROOT/build/scripts/server/start-selfhost-real.sh"

exec bash "$SCRIPT" "$@"
