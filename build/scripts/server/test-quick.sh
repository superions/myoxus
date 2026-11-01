#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Compatibility wrapper for the matrix-owned API quick integration gate.
# The historical implementation called non-existent Cargo test targets and
# parsed summary text. Keep this path only as a safe redirect.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

echo "[INFO] build/scripts/server/test-quick.sh is a compatibility wrapper."
echo "[INFO] canonical suite: api.integration.quick"

exec "$REPO_ROOT/build/scripts/test/run.sh" --suite api.integration.quick "$@"
