#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
echo "[INFO] build/scripts/server/stack-rebuild-frontend.sh is a compatibility wrapper." >&2
echo "[INFO] canonical script: build/scripts/server/stack-rebuild-frontends.sh" >&2
exec "$REPO_ROOT/build/scripts/server/stack-rebuild-frontends.sh" "$@"
