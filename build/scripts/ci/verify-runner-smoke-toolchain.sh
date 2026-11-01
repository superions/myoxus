#!/usr/bin/env bash
# Verifies the broad toolchain surface expected by the runner smoke workflow.

set -euo pipefail

bash build/scripts/ci/verify-runner-toolchain.sh --node --rust

command -v npm >/dev/null
command -v git >/dev/null
command -v python3 >/dev/null

npm --version
corepack --version
git --version
python3 --version
rustup show active-toolchain
