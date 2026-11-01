#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Hard Admin frontend Vitest gate for CI/strict validation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

yarn vitest run --config client/admin/vitest.config.mts
