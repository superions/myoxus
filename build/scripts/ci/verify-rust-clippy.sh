#!/usr/bin/env bash
# Shared local/CI gate for Rust formatting and Clippy warnings.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"

cd "$SERVER_DIR"

export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-8}"

echo "==> Rust format check"
cargo fmt --all -- --check

echo "==> Rust Clippy check"
cargo clippy --workspace --all-targets --all-features -- -D warnings

echo "Rust format and Clippy checks passed."
