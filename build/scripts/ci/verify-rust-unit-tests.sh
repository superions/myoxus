#!/usr/bin/env bash
# Shared local/CI Rust service-free fast lib test gate.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"

cd "$SERVER_DIR"

export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-8}"

echo "==> Rust service-free lib unit tests"
cargo test --workspace --lib --all-features --exclude myoxus-worker -- --nocapture

echo "Rust service-free lib unit tests passed."
