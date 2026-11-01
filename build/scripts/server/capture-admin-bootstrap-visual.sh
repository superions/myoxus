#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
BASE_URL="${MYOXUS_ADMIN_BASE_URL:-${MYOXUS_FRONTEND_BASE_URL:-http://127.0.0.1:3011}}"

cd "$REPO_ROOT"

if [ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ]; then
  for candidate in /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -x "$candidate" ]; then
      export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$candidate"
      break
    fi
  done
fi

export MYOXUS_ADMIN_BASE_URL="$BASE_URL"
node "$SCRIPT_DIR/capture-admin-bootstrap-visual.mjs" "$@"
