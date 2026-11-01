#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Canonical matrix-aware test runner entry point.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec node "$REPO_ROOT/build/scripts/test/run.mjs" "$@"
