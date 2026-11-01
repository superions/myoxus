#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: build/scripts/server/capture-admin-visual-baseline.sh [options]

Capture authenticated desktop Admin routes from the served development instance.
  --base-url URL          Served Admin origin
  --output-dir DIR        Screenshot and report destination
  --matrix FILE           Route matrix (defaults to the canonical Admin matrix)
  --routes IDS            Comma-separated route IDs from the matrix
  --themes MODES          Comma-separated light, dark or system modes
  --viewport WIDTHxHEIGHT Desktop viewport (default: 1440x1100)
  --viewport-only 1       Capture only the visible viewport
  --require-clean 1       Reject a dirty served source checkout

MYOXUS_ADMIN_API_BASE_URL selects the API used for normal Admin sign-in.
MYOXUS_ADMIN_SESSION may supply an existing session without signing in again.
EOF
  exit 0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
BASE_URL="${MYOXUS_ADMIN_BASE_URL:-${MYOXUS_FRONTEND_BASE_URL:-http://127.0.0.1:3011}}"
API_BASE="${MYOXUS_ADMIN_API_BASE_URL:-http://127.0.0.1:3001}"
EMAIL="${E2E_ADMIN_EMAIL:-${MYOXUS_ADMIN_EMAIL:-admin@myoxus.local}}"
PASSWORD="${E2E_ADMIN_PASSWORD:-${MYOXUS_ADMIN_PASSWORD:-AdminMyoxus2026}}"

cd "$REPO_ROOT"

if [ -z "${MYOXUS_ADMIN_SESSION:-}" ]; then
  # Reuse the canonical smoke auth helper so ALTCHA/local CAPTCHA behavior stays real.
  # shellcheck source=/dev/null
  . "$SCRIPT_DIR/lib-auth-smoke.sh"
  export MYOXUS_ADMIN_SESSION
  MYOXUS_ADMIN_SESSION="$(smoke_admin_sign_in "$API_BASE" "$EMAIL" "$PASSWORD")"
fi

if [ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ]; then
  for candidate in /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -x "$candidate" ]; then
      export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$candidate"
      break
    fi
  done
fi

export MYOXUS_ADMIN_BASE_URL="$BASE_URL"
node "$SCRIPT_DIR/capture-admin-visual-baseline.mjs" "$@"
