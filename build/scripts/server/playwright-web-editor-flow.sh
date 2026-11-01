#!/usr/bin/env bash
# Run the Browser Web editor-host Playwright suite through the shared frontend
# runner so host/Docker fallback, timeout handling and Playwright summary
# validation stay identical to `web.smoke`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MYOXUS_PLAYWRIGHT_CONFIG_REL="tests/client/webfrontend/editor-flow/playwright.config.ts"
exec "$SCRIPT_DIR/playwright-frontend-smoke.sh" "$@"
