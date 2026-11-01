#!/usr/bin/env bash
# Runs the syntax and focused type-aware Oxlint owners.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$REPO_ROOT"

yarn exec oxlint --quiet \
  -A react/exhaustive-deps \
  -A react-hooks-js/incompatible-library \
  -A react-hooks-js/unsupported-syntax
node build/scripts/ci/run-oxlint-type-aware.mjs
