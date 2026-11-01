#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Bounded entry point for focused Cargo diagnostics outside the matrix.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec node "$REPO_ROOT/build/scripts/test/run-cargo-diagnostic.mjs" "$@"
