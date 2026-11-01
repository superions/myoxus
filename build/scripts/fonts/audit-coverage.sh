#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# P-FONT-COVERAGE-01: enumerate fonts in server/static/fonts/ and detect
# Unicode subset coverage. Optional --validate compares against manifest.json
# (file presence + sha256).
#
# Usage:
#   build/scripts/fonts/audit-coverage.sh                 # human table
#   build/scripts/fonts/audit-coverage.sh --validate      # also gate on manifest
#   build/scripts/fonts/audit-coverage.sh --json          # JSON output
#   build/scripts/fonts/audit-coverage.sh --no-color      # plain text

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

if ! command -v python3 >/dev/null; then
  echo "audit-coverage: python3 not found" >&2
  exit 2
fi

if ! python3 -c "import fontTools, brotli" 2>/dev/null; then
  echo "audit-coverage: python packages 'fonttools' and 'brotli' are required" >&2
  echo "  install: pip install fonttools brotli" >&2
  exit 2
fi

exec python3 "${SCRIPT_DIR}/_audit_coverage.py" "$@"
