#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

if [[ "${MYOXUS_RUN_LEGACY_LOCAL_WEB_E2E:-}" != "1" ]]; then
  cat >&2 <<'MSG'
The tests/client/webfrontend/local Playwright suite is quarantined.

Reason:
  Browser Web no longer creates or persists local workspaces. This legacy suite
  still starts the web dev server and expects an unauthenticated local editor,
  so it now lands on Sign in before product assertions can run.

Current gates:
  Use tests/client/webfrontend/smoke or tests/client/webfrontend/flow for
  Browser Web validation.
  Move true local/offline workspace flows to Electron/Desktop coverage.

Explicit legacy run:
  MYOXUS_RUN_LEGACY_LOCAL_WEB_E2E=1 yarn workspace @myoxus-test/myoxus-local e2e -- <playwright args>
MSG
  exit 2
fi

yarn playwright test "$@"
