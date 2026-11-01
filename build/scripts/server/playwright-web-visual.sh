#!/usr/bin/env bash
# Run the opt-in, owner-scoped Browser Web visual evidence suite through the
# shared frontend runner.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MYOXUS_PLAYWRIGHT_CONFIG_REL="tests/client/webfrontend/visual/playwright.config.ts"
exec "$SCRIPT_DIR/playwright-frontend-smoke.sh" "$@"
