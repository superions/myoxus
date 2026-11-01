#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Host-side owner gate for the Rust code shipped in Electron and mobile clients.
# Cross-platform packaging remains release-matrix work; this gate proves the
# shared protocol, persistence, N-API and mobile library graph on every change.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DIAGNOSTIC="$REPO_ROOT/build/scripts/test/cargo-diagnostic.sh"

cd "$REPO_ROOT"

"$DIAGNOSTIC" --timeout-seconds 900 -- check --workspace --all-targets --locked
"$DIAGNOSTIC" --timeout-seconds 900 -- test --locked -p myoxus-doc-indexer
"$DIAGNOSTIC" --timeout-seconds 900 -- test --locked -p client_storage
"$DIAGNOSTIC" --timeout-seconds 900 -- test --locked -p myoxus_mobile_native
"$DIAGNOSTIC" --timeout-seconds 1200 -- build --locked --release -p client_storage --features napi
"$DIAGNOSTIC" --timeout-seconds 1200 -- build --locked --release -p myoxus_mobile_native
