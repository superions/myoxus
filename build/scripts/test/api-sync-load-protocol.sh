#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STACK_UP="$REPO_ROOT/build/scripts/test/stack-up.sh"
STACK_DOWN="$REPO_ROOT/build/scripts/test/stack-down.sh"

: "${TEST_DATABASE_URL:=postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test}"
: "${TEST_REDIS_URL:=redis://localhost:6380}"
: "${DATABASE_URL:=$TEST_DATABASE_URL}"

export TEST_DATABASE_URL TEST_REDIS_URL DATABASE_URL

started_test_stack=0
cleanup() {
  if [ "$started_test_stack" -eq 1 ]; then
    "$STACK_DOWN"
  fi
}
trap cleanup EXIT INT TERM

# Matrix service declarations are selection metadata, not lifecycle hooks.
# Keep this owner independently executable while preserving an already-running
# isolated stack that may have been provisioned by CI or an operator.
if ! docker inspect myoxus-test-postgres --format='{{.State.Health.Status}}' 2>/dev/null |
  grep -qx healthy ||
  ! docker inspect myoxus-test-redis --format='{{.State.Health.Status}}' 2>/dev/null |
    grep -qx healthy; then
  echo "==> Starting isolated Postgres/Redis test services"
  "$STACK_UP"
  started_test_stack=1
fi

cd "$REPO_ROOT/server"
RUST_MIN_STACK="${RUST_MIN_STACK:-16777216}" \
  CARGO_PROFILE_TEST_DEBUG=0 \
  cargo test -p myoxus-api --test sync_load_protocol -- --test-threads=1 --nocapture
