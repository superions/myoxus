#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run the service-free tests owned by one bounded server domain.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <cargo-package> [<cargo-package> ...]" >&2
  exit 2
fi

cd "$SERVER_DIR"

export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-8}"

packages=()
for package in "$@"; do
  packages+=("--package" "$package")
done

echo "==> Rust owner unit tests: $*"
cargo test "${packages[@]}" --lib --all-features -- --nocapture

# Public HTML's service-free fidelity cases use a standalone Cargo test target.
# --lib alone silently omits them despite the rendering owner's path selection.
for package in "$@"; do
  if [ "$package" = "myoxus-public-render" ]; then
    cargo test --package "$package" --test html --all-features -- --nocapture
  fi
done

echo "Rust owner unit tests passed: $*"
