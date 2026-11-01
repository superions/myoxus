#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Build outside the probe's address-space limit, then run one isolated process.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"
[[ "$(uname -s)" == Linux ]] || { echo 'Yrs allocator regression requires Linux' >&2; exit 1; }
manifest="${YRS_MEMORY_BASELINE_MANIFEST:-}"
if [[ -z "$manifest" ]]; then
  node build/scripts/ci/verify-yrs-source.mjs
  manifest="$(cargo metadata --locked --manifest-path server/Cargo.toml --format-version 1 | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const pkg = JSON.parse(input).packages.find(pkg => pkg.name === "myoxus-yrs");
  if (!pkg) throw new Error("External myoxus-yrs package missing");
  console.log(pkg.manifest_path);
});')"
fi
# Cargo freshness can reuse a same-name/version standalone crate after source
# relocation. Isolate the published negative control from the patched binary.
probe_variant=patched
if [[ -n "${YRS_MEMORY_BASELINE_MANIFEST:-}" ]]; then probe_variant=baseline; fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/target}/yrs-memory/$probe_variant"
# The external package excludes allocator instrumentation from ordinary tests.
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }--cfg myoxus_memory_probes"
echo "Yrs ownership probe manifest: $manifest"
artifacts="$(mktemp)"
trap 'rm -f "$artifacts"' EXIT
build/scripts/test/cargo-diagnostic.sh --timeout-seconds 600 -- \
  test --locked --manifest-path "$manifest" --lib --no-run --message-format=json >"$artifacts"
probe="$(node --input-type=module - "$artifacts" "$manifest" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
const [artifacts, manifest] = process.argv.slice(2);
const executables = readFileSync(artifacts, 'utf8').trim().split('\n')
  .map(line => JSON.parse(line))
  .filter(item => item.reason === 'compiler-artifact' && item.executable);
assert.equal(executables.length, 1, 'expected exactly one ownership probe');
assert.equal(realpathSync(executables[0].manifest_path), realpathSync(manifest));
console.log(executables[0].executable);
JS
)"
# 1 GiB virtual memory, 60 CPU seconds, 90 wall seconds. The matrix runner owns
# process-tree cleanup, including this timeout and all descendants.
timeout --signal=TERM --kill-after=5s 90s \
  prlimit --as=1073741824 --cpu=60 -- "$probe" myoxus_ownership --test-threads=1 --nocapture
