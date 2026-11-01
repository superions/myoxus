#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P-VIRG-ARCH-C-11 (C-FIND-07, C-FIND-08): Manifest consistency guard.
#
# Wraps the standalone Node script
# `virgultum/editor/all/scripts/check-manifest-guard.mjs`
# that mirrors the in-test `manifest-consistency-guard.ts`
# pure function. C-FIND-07 made the guard runnable
# outside the Vitest harness; C-FIND-08 made it read
# the block `package.json` `exports` map dynamically
# (so a manifest ↔ package.json drift is caught at
# CI time, not at test time).
#
# Requirements: bash, node (>= 18 for `node --experimental-vm-modules`).
# Runtime: < 1 second.
#
# Usage:
#   bash build/scripts/test/guard-manifest.sh
#   yarn workspace @virgultum/editor/all guard:manifest
#
# Exit codes:
#   0  — all manifests pass the guard
#   1  — guard raised at least one issue
#   2  — script could not find a required file (env error)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$REPO_ROOT/virgultum/editor/all/scripts/check-manifest-guard.ts"

if [ ! -f "$SCRIPT" ]; then
  echo "ERROR: manifest-guard script not found: $SCRIPT"
  exit 2
fi

if ! command -v npx &>/dev/null; then
  echo "ERROR: npx not found — install Node.js 26 to run the manifest guard"
  exit 2
fi

if ! command -v node &>/dev/null; then
  echo "ERROR: node not found — install Node.js 26 to run the manifest guard"
  exit 2
fi

cd "$REPO_ROOT"
npx --no-install tsx "$SCRIPT"
