#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Document History owns its existing capture/restore and trigger journeys. It
# must not execute unrelated editor-family development specs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MYOXUS_PLAYWRIGHT_CONFIG_REL="tests/client/webfrontend/flow/playwright.config.ts"
# A real ownership-transition capture waits for the supported fifteen-minute
# interval. Leave cleanup headroom inside the matrix's 2400-second tree timeout.
export MYOXUS_PLAYWRIGHT_TIMEOUT_SECONDS="${MYOXUS_PLAYWRIGHT_TIMEOUT_SECONDS:-2300}"
exec "$SCRIPT_DIR/playwright-frontend-smoke.sh" \
  tests/client/webfrontend/flow/tests/doc-versioning/doc-versioning-web.spec.ts \
  "$@"
