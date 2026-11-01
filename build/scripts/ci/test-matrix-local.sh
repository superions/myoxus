#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Deprecated compatibility wrapper. The canonical test matrix runner lives at
# build/scripts/test/run.sh. This path intentionally no longer runs a hidden
# yarn build/test/typecheck monolith.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

echo "[INFO] build/scripts/ci/test-matrix-local.sh is deprecated."
echo "[INFO] canonical runner: build/scripts/test/run.sh"

exec "$REPO_ROOT/build/scripts/test/run.sh" "$@"
