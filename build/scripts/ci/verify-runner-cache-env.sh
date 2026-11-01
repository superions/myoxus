#!/usr/bin/env bash
# Verifies the self-hosted runner cache environment contract.

set -euo pipefail

cache_root="${CI_RUNNER_CACHE:-}"

test "$cache_root" = "/var/cache/ci-runner"
test "${COREPACK_HOME:-}" = "$cache_root/corepack"
test "${YARN_CACHE_FOLDER:-}" = "$cache_root/yarn"
test "${CARGO_HOME:-}" = "$cache_root/cargo"
test "${RUSTUP_HOME:-}" = "$cache_root/rustup"
test "${ELECTRON_CACHE:-}" = "$cache_root/electron"
test "${PLAYWRIGHT_BROWSERS_PATH:-}" = "$cache_root/playwright"

if [ "${RUNNER_CACHE_WRITE_SMOKE:-true}" = "true" ]; then
  install -d "$cache_root/smoke"
  date -Is >"$cache_root/smoke/last-run.txt"
  ls -la "$cache_root" "$cache_root/smoke"
fi
