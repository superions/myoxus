#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Verifies a digest-bound desktop artifact set before publication or transfer.

set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <release-dir> [--require-publishable]" >&2
  exit 2
fi

release_dir="$1"
publishable_arg=()
if [ "${2:-}" = "--require-publishable" ]; then
  publishable_arg=(--require-publishable)
elif [ -n "${2:-}" ]; then
  echo "Unsupported argument: $2" >&2
  exit 2
fi

test -d "$release_dir"
test -s "$release_dir/RELEASE.md"
test -s "$release_dir/ARTIFACTS.md"
test -s "$release_dir/SHA256SUMS"
test -d "$release_dir/sbom"
test -s "$release_dir/desktop-release.json"
test -s "$release_dir/desktop-provenance.json"
test -s "$release_dir/latest.yml"

bash "$(dirname "${BASH_SOURCE[0]}")/verify-artifact-manifest.sh" "$release_dir"
bash "$(dirname "${BASH_SOURCE[0]}")/verify-sha256sums.sh" "$release_dir"

if [ "${#publishable_arg[@]}" -gt 0 ]; then
  node "$(dirname "${BASH_SOURCE[0]}")/verify-desktop-release-metadata.mjs" \
    --release-dir "$release_dir" \
    "${publishable_arg[@]}"
else
  node "$(dirname "${BASH_SOURCE[0]}")/verify-desktop-release-metadata.mjs" \
    --release-dir "$release_dir"
fi

grep -q 'ARTIFACTS.md' "$release_dir/SHA256SUMS"
grep -q 'RELEASE.md' "$release_dir/SHA256SUMS"
grep -q 'sbom/' "$release_dir/RELEASE.md"
grep -q 'sbom/' "$release_dir/ARTIFACTS.md"
grep -q 'desktop-release.json' "$release_dir/ARTIFACTS.md"
grep -q 'desktop-provenance.json' "$release_dir/ARTIFACTS.md"
grep -q 'latest.yml' "$release_dir/ARTIFACTS.md"

platforms="$(
  node -e '
    const fs = require("node:fs");
    const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const platforms = [...new Set(release.artifacts.map(artifact => artifact.platform))].sort();
    if (!platforms.length || platforms.some(platform => !["linux", "macos", "windows"].includes(platform))) process.exit(1);
    process.stdout.write(platforms.join("\n"));
  ' "$release_dir/desktop-release.json"
)"
while IFS= read -r platform; do
  test -n "$platform"
  test -d "$release_dir/$platform"
  grep -q "$platform/" "$release_dir/RELEASE.md"
  grep -q "$platform/" "$release_dir/ARTIFACTS.md"
done <<<"$platforms"

echo "Release artifact verification passed."
