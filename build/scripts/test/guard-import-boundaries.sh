#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P-VIRG-ARCH-H-01: Virgultum import-boundary guard.
#
# Wraps the standalone Node script
# `virgultum/editor/all/scripts/check-import-boundaries.ts`
# that enforces the package import boundaries documented
# in the H-01 closeout.
#
# The rule logic lives in
# `virgultum/editor/all/src/extensions/import-boundary-guard.ts`
# and is unit-tested directly (no subprocess). The script
# itself only walks the repo and glues the rules to
# `process.exit`; this bash wrapper is the CI / pre-commit
# entry point.
#
# Requirements: bash, node (>= 18), npx.
# Runtime: < 1 second on the full `virgultum/` tree.
#
# Usage:
#   bash build/scripts/test/guard-import-boundaries.sh
#   yarn workspace @virgultum/editor guard:import-boundaries
#
# Exit codes:
#   0  — no forbidden cross-package imports
#   1  — at least one boundary violation
#   2  — script could not find a required file (env error)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$REPO_ROOT/virgultum/editor/all/scripts/check-import-boundaries.ts"

if [ ! -f "$SCRIPT" ]; then
  echo "ERROR: import-boundaries script not found: $SCRIPT"
  exit 2
fi

if ! command -v npx &>/dev/null; then
  echo "ERROR: npx not found — install Node.js 26 to run the import-boundary guard"
  exit 2
fi

if ! command -v node &>/dev/null; then
  echo "ERROR: node not found — install Node.js 26 to run the import-boundary guard"
  exit 2
fi

cd "$REPO_ROOT"
npx --no-install tsx "$SCRIPT"
