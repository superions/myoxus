#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fast API integration sanity gate for local development. The dedicated target
# declares only the modules owning the matrix capability groups. The full
# `integration` target remains the owner of the complete API integration matrix.

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

# The matrix assigns the unchanged exact tests to capability owners. Keep one
# compiled target: splitting binaries would duplicate compile/link work.
filter_group="${1:-api}"
filter_text="$(node "$REPO_ROOT/build/scripts/test/api-standard-filters.mjs" "$filter_group")"
filters=()
while IFS= read -r filter; do
  filters+=("$filter")
done <<< "$filter_text"


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

echo "==> API integration standard group: $filter_group"
echo "    target: cargo test -p myoxus-api --test integration_quick <filter>"
echo "    db:     $TEST_DATABASE_URL"

# Cargo treats a filter that matches no tests as success. Validate the complete
# exact-filter inventory once so a renamed or removed smoke cannot silently
# weaken this gate.
# Freeze one compiled consumer for both inventory and execution. Re-entering
# Cargo after --list can block behind another checkout's build and expire the
# suite timeout before any assertion runs.
cargo test -p myoxus-api --test integration_quick --no-run \
  --message-format=json-render-diagnostics > "$CONFIG_OVERLAY_DIR/build.jsonl"
quick_test_executable="$(node --input-type=module - "$CONFIG_OVERLAY_DIR/build.jsonl" <<'NODE'
import { readFileSync } from 'node:fs';
const messages = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
const artifact = messages.findLast(message => message.reason === 'compiler-artifact'
  && message.target?.name === 'integration_quick' && message.executable);
if (!artifact) throw new Error('Cargo did not produce the API integration quick executable');
console.log(artifact.executable);
NODE
)"
available_tests="$(RUST_MIN_STACK="${RUST_MIN_STACK:-16777216}" "$quick_test_executable" --list)"
for filter in "${filters[@]}"; do
  if ! grep -Fqx "$filter: test" <<<"$available_tests"; then
    echo "ERROR: API integration quick filter selects no test: $filter" >&2
    exit 1
  fi
done

# libtest accepts multiple exact filters. Run the validated inventory serially
# in the same compiled process, without another Cargo lock acquisition.
echo "==> Running ${#filters[@]} exact API smoke tests serially"
RUST_MIN_STACK="${RUST_MIN_STACK:-16777216}" \
  "$quick_test_executable" "${filters[@]}" --exact --test-threads=1

echo "API integration quick gate passed."
