#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Complete capability partition of the shared API integration binary.
# Tests and their shared compile target remain unchanged.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
STACK_UP="$REPO_ROOT/build/scripts/test/stack-up.sh"
STACK_DOWN="$REPO_ROOT/build/scripts/test/stack-down.sh"

: "${TEST_DATABASE_URL:=postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test}"
: "${TEST_REDIS_URL:=redis://localhost:6380}"
: "${DATABASE_URL:=$TEST_DATABASE_URL}"

export TEST_DATABASE_URL TEST_REDIS_URL DATABASE_URL
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-8}"

filter_group="${1:?Expected an integration capability suite ID}"
# Reject invalid ownership before acquiring any test services.
node "$REPO_ROOT/build/scripts/test/api-integration-domain.mjs" "$filter_group"

# Keep config writeback mutations out of package-local or operator-owned YAML.
# Source discovery stays production-shaped; tests set exact value
# preconditions in their fixtures.
CONFIG_OVERLAY_DIR="$(mktemp -d)"
cp "$SERVER_DIR/config/default.yaml" "$CONFIG_OVERLAY_DIR/local.yaml"
export MYOXUS__CONFIG__WRITEBACK_PATH="$CONFIG_OVERLAY_DIR/local.yaml"

started_test_stack=0
cleanup() {
  if [ "$started_test_stack" -eq 1 ]; then
    "$STACK_DOWN"
  fi
  rm -rf "$CONFIG_OVERLAY_DIR"
}
trap cleanup EXIT INT TERM

if ! docker inspect myoxus-test-postgres --format='{{.State.Health.Status}}' 2>/dev/null |
  grep -qx healthy ||
  ! docker inspect myoxus-test-redis --format='{{.State.Health.Status}}' 2>/dev/null |
    grep -qx healthy; then
  echo "==> Starting isolated Postgres/Redis test services"
  "$STACK_UP"
  started_test_stack=1
fi


cd "$SERVER_DIR"

echo "==> API integration capability: $filter_group"
echo "    target: cargo test -p myoxus-api --test integration <filter>"
echo "    db:     $TEST_DATABASE_URL"

# Cargo treats a filter that matches no tests as success. Validate the complete
# exact-filter inventory once so a renamed or removed smoke cannot silently
# weaken this gate.
available_tests="$({
  RUST_MIN_STACK="${RUST_MIN_STACK:-16777216}" \
    cargo test -p myoxus-api --test integration -- --list
})"
filter_text="$(printf '%s\n' "$available_tests" | node "$REPO_ROOT/build/scripts/test/api-integration-domain.mjs" "$filter_group" --select-tests)"
filters=()
while IFS= read -r filter; do
  filters+=("$filter")
done <<< "$filter_text"

# Template closeout also owns the existing private HTML consuming contract;
# reuse the same compiled binary without admitting the complete MCP module.
if [ "$filter_group" = server.templates.integration ]; then
  private_html_filter=mcp_create_page_test::inv_mcp_compat_document_projection_preserves_structured_html_and_raw_yjs
  grep -Fxq -- "$private_html_filter: test" <<< "$available_tests"
  filters+=("$private_html_filter")
fi

# libtest accepts multiple exact filters. Run the unchanged inventory serially
# in one process instead of repeating Cargo dependency checks for every case.
echo "==> Running ${#filters[@]} exact capability tests serially"
RUST_MIN_STACK="${RUST_MIN_STACK:-16777216}" \
  cargo test -p myoxus-api --test integration -- "${filters[@]}" --exact --test-threads=1

# The Database owner exercises references, reminder coupling and initial-state rollback;
# lib-only infrastructure gates do not execute these SQL targets.
if [ "$filter_group" = server.database.integration ]; then
  cargo test -p myoxus-infrastructure --test database_document_references_test --test database_row_reminders_test --test database_delete_test -- --test-threads=1
fi

# Search's vector/FTS fusion is a SQL target, not an infrastructure library test.
if [ "$filter_group" = server.search.integration ]; then
  cargo test -p myoxus-infrastructure --test search_repository_fts_test -- --test-threads=1
fi

echo "API integration capability passed."
