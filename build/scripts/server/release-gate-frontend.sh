#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Strict frontend release gate. This script remains as a human entry point, but
# stale API file-target invocations and duplicated smoke loops have been
# removed. Prefer matrix suites for local changed-path validation.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUST_DIR="$ROOT_DIR/server"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/myoxus-rust-target}"
DATABASE_URL="${DATABASE_URL:-${TEST_DATABASE_URL:-postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test}}"
TEST_DATABASE_URL="${TEST_DATABASE_URL:-$DATABASE_URL}"
# Match the canonical api.integration executor contract. The compiled GraphQL
# integration binary exceeds libtest's default thread stack in several real
# resolver paths; keeping this local avoids a developer-shell requirement.
RUST_MIN_STACK="${RUST_MIN_STACK:-16777216}"

export CARGO_TARGET_DIR DATABASE_URL TEST_DATABASE_URL RUST_MIN_STACK

run_step() {
  local name="$1"
  shift
  echo "[STEP] $name"
  "$@"
  echo "[PASS] $name"
}

run_api_filter() {
  local filter="$1"
  run_step "api integration: $filter" /bin/bash -lc \
    "cd '$RUST_DIR' && cargo test -p myoxus-api --test integration '$filter' -- --test-threads=1 --nocapture"
}

echo "[INFO] Frontend release gate uses matrix-era current commands."
echo "[INFO] For changed-path local runs prefer: build/scripts/test/run.sh --changed"

run_step "frontend selfhost smoke" /bin/bash -lc "cd '$ROOT_DIR' && build/scripts/server/smoke-frontend-selfhost.sh"
run_step "frontend container isolation guard" /bin/bash -lc "cd '$ROOT_DIR' && yarn frontend:container-isolation:check"
run_step "static frontend nginx topology" /bin/bash -lc "cd '$ROOT_DIR' && build/scripts/frontends/test-nginx-topology.sh"
run_step "branding artifact check" /bin/bash -lc "cd '$ROOT_DIR' && build/scripts/server/check-branding-artifacts.sh"
run_step "frontend hardening" /bin/bash -lc "cd '$ROOT_DIR' && build/scripts/server/smoke-frontend-hardening.sh"
run_step "frontend error contract" /bin/bash -lc "cd '$ROOT_DIR' && build/scripts/server/smoke-frontend-error-contract.sh"
run_step "frontend scope-cut" /bin/bash -lc "cd '$ROOT_DIR' && build/scripts/server/smoke-frontend-scopecut.sh"
run_step "frontend realtime fallback" /bin/bash -lc "cd '$ROOT_DIR' && build/scripts/server/smoke-frontend-realtime-fallback.sh"

run_api_filter "compat_rest_endpoints"
run_api_filter "websocket_protocol_test"
run_api_filter "graphql_copilot_test"
run_api_filter "admin_config_schema_test"
run_api_filter "admin_config_update_test"

run_step "client auth, settings and runtime-theme regression specs" /bin/bash -lc "cd '$ROOT_DIR' && yarn vitest run --project frontend-unit \
  client/admin/workspaces/admin/src/app.spec.tsx \
  client/admin/workspaces/admin/src/runtime-theme.spec.ts \
  client/admin/workspaces/admin/src/components/theme-provider.spec.tsx \
  client/admin/workspaces/admin/src/components/theme-provider.switch.spec.tsx \
  client/admin/workspaces/admin/src/modules/settings/index.spec.tsx \
  client/admin/workspaces/admin/src/modules/settings/config-input-row.spec.tsx \
  client/admin/workspaces/admin/src/modules/settings/operations/branding-assets.spec.tsx \
  client/admin/workspaces/admin/src/modules/settings/operations/branding-theme-customization.spec.tsx \
  client/admin/workspaces/admin/src/modules/branding/accent-theme.spec.tsx \
  client/admin/workspaces/admin/src/modules/settings/sensitive.spec.ts \
  client/admin/workspaces/admin/src/modules/workspaces/use-workspace-list.spec.ts \
  client/admin/workspaces/admin/src/modules/workspaces/utils.spec.ts \
  client/admin/workspaces/admin/src/modules/accounts/use-user-list.spec.ts \
  client/admin/workspaces/admin/src/modules/accounts/utils/csv-utils.spec.ts \
  client/admin/workspaces/admin/src/modules/auth/index.spec.tsx \
  client/admin/workspaces/admin/src/modules/setup/index.spec.tsx \
  client/libs/ui-facade/src/brand-asset-image.spec.tsx \
  client/web/workspaces/web/src/runtime-theme.spec.ts \
  client/apps/electron-renderer/src/app/runtime-theme.spec.ts \
  client/libs/core/src/components/theme-provider/index.spec.tsx"

run_step "web/admin ui dependency final checks" /bin/bash -lc \
  "cd '$ROOT_DIR' && yarn frontend:ui-framework-graph:final-check && yarn frontend:admin-ui-facade:final-check && node build/scripts/ci/verify-admin-ui-dependency-graph.mjs --check"
run_step "web browser smoke" /bin/bash -lc "cd '$ROOT_DIR' && build/scripts/server/playwright-frontend-smoke.sh"
run_step "admin visual facade sweep" /bin/bash -lc \
  "cd '$ROOT_DIR' && build/scripts/server/playwright-admin-ui-smoke.sh tests/design/admin-ui-facade-sweep.spec.ts tests/design/admin-ui-runtime-policy.spec.ts"

if [ -n "${MYOXUS_FRONTEND_BASE_PATH:-}" ] && [ "${MYOXUS_FRONTEND_BASE_PATH}" != "/" ]; then
  run_step "frontend basepath smoke" /bin/bash -lc \
    "cd '$ROOT_DIR' && MYOXUS_FRONTEND_BASE_PATH='${MYOXUS_FRONTEND_BASE_PATH}' build/scripts/server/smoke-frontend-basepath.sh"
fi

if [ "${MYOXUS_FRONTEND_VALIDATE_PREBUILT:-0}" = "1" ]; then
  run_step "frontends prebuilt static export" /bin/bash -lc "cd '$ROOT_DIR' && build/scripts/frontends/export-prebuilt-static.sh"
  run_step "frontends prebuilt static verification" /bin/bash -lc "cd '$ROOT_DIR' && build/scripts/frontends/verify-prebuilt-static.sh"
fi

echo "[PASS] frontend release gate complete"
