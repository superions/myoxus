#!/usr/bin/env bash
# Runs the same fast server gate locally and in Forgejo CI.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$REPO_ROOT"

echo "==> Verifying Rust runner toolchain"
bash build/scripts/ci/verify-runner-toolchain.sh --rust --rust-components

bash build/scripts/ci/verify-rust-clippy.sh
bash build/scripts/ci/verify-rust-check.sh
bash build/scripts/ci/verify-rust-unit-tests.sh

echo "Server fast checks passed."
