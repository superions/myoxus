#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# P-FONT-COVERAGE-03: bundle Google-Fonts assets for the PDF + UI pipeline.
#
# Pulls per family:
#   - Full TTF (variable font when upstream provides one, else static
#     instances per the body-weights matrix in families.json).
#   - Subsetted WOFF2s via the Google Fonts CSS API (one file per
#     (family, weight, style, subset) — Decision 1).
#
# Output:
#   - server/static/fonts/<files>
#   - server/static/fonts/manifest.json (rewritten — Decision 8 schema)
#
# The script is idempotent: files with a matching sha256 are skipped.
# Network access to fonts.google.com + fonts.googleapis.com is required.
#
# Usage:
#   build/scripts/fonts/fetch-fonts.sh                # fetch everything
#   build/scripts/fonts/fetch-fonts.sh --dry-run      # plan, no downloads
#   build/scripts/fonts/fetch-fonts.sh --only Inter   # one family
#   build/scripts/fonts/fetch-fonts.sh --no-ttf       # only WOFF2 subsets
#   build/scripts/fonts/fetch-fonts.sh --no-woff2     # only TTF/VF
#   build/scripts/fonts/fetch-fonts.sh --no-color
#
# Requirements: python3, fonttools + brotli (same parser stack as the
# audit step), `unzip`, `curl`. Network: outbound HTTPS.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

if ! command -v python3 >/dev/null; then
  echo "fetch-fonts: python3 not found" >&2
  exit 2
fi
if ! command -v unzip >/dev/null; then
  echo "fetch-fonts: unzip not found" >&2
  exit 2
fi
if ! command -v curl >/dev/null; then
  echo "fetch-fonts: curl not found" >&2
  exit 2
fi
if ! python3 -c "import fontTools, brotli" 2>/dev/null; then
  echo "fetch-fonts: python packages 'fonttools' and 'brotli' are required" >&2
  echo "  install: pip install fonttools brotli" >&2
  exit 2
fi

exec python3 "${SCRIPT_DIR}/_fetch_fonts.py" "$@"
