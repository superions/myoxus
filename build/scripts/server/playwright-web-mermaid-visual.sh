#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Phase 3B Mermaid Page viewport visual owner. Family-specific visual evidence
# remains with the corresponding Mermaid phase.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/playwright-web-visual.sh" \
  tests/client/webfrontend/visual/tests/mermaid-page-viewport.evidence.spec.ts \
  "$@"
