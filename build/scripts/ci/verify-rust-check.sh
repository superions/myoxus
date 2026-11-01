#!/usr/bin/env bash
# Shared local/CI Rust workspace check gate.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"

cd "$SERVER_DIR"

# Matrix checks combine feature and target shapes that do not share useful
# incremental state. Keep their disk footprint bounded and avoid spawning one
# memory-heavy rustc process per host CPU. Callers may override the job cap.
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-8}"

echo "==> Rust workspace check"
# Unit and integration test targets have dedicated gates. Checking them here
# duplicates the largest API test graph before those gates compile it again.
cargo check --workspace --all-features

echo "Rust workspace check passed."
