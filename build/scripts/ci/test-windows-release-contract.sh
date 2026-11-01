#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Proves the Windows release inventory/sealing path without building or publishing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"
cd "$REPO_ROOT"

mode="${1:-full}"
if [ "$mode" != full ] && [ "$mode" != --inventory-only ]; then
  echo "Usage: $0 [--inventory-only]" >&2
  exit 2
fi

test "$(git check-attr eol -- "$0" | awk '{print $3}')" = lf
if git ls-files --eol '*.sh' | awk '$2 != "w/lf" { print; failed = 1 } END { exit failed }'; then
  :
else
  echo "Tracked shell scripts were not materialized with LF line endings." >&2
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

release_dir="$work_dir/windows-release"
no_find_dir="$work_dir/no-find"
mkdir -p "$release_dir/windows" "$release_dir/sbom" "$no_find_dir"

printf 'fixture-exe' \
  >"$release_dir/windows/myoxus-0.40.0-stable-windows-x64.exe"
printf 'fixture-zip' \
  >"$release_dir/windows/myoxus-0.40.0-stable-windows-x64.zip"
cat >"$release_dir/sbom/myoxus-desktop-0.40.0.cdx.json" <<'EOF'
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.5",
  "version": 1,
  "metadata": {
    "component": {
      "type": "application",
      "name": "myoxus-desktop",
      "version": "0.40.0"
    }
  },
  "components": [
    { "type": "framework", "name": "electron", "version": "44.4.5" },
    { "type": "library", "name": "mediabunny", "version": "1.50.9" }
  ]
}
EOF
cat >"$no_find_dir/find" <<'EOF'
#!/usr/bin/env bash
echo "platform find must not be used" >&2
exit 97
EOF
chmod +x "$no_find_dir/find"

if [ "$mode" = full ]; then
  SOURCE_DATE_EPOCH=0 node build/scripts/ci/write-desktop-release-metadata.mjs \
    --release-dir "$release_dir" \
    --version 0.40.0 \
    --channel stable \
    --scope windows \
    --source-commit 0000000000000000000000000000000000000000 \
    --source-repository myoxus/myoxus \
    --builder-id https://git.blume29.de/myoxus/myoxus/actions/runs/42 \
    --run-id 42 \
    --sbom "$release_dir/sbom/myoxus-desktop-0.40.0.cdx.json"
else
  printf '{"scope":"windows"}\n' >"$release_dir/desktop-release.json"
  printf '{"sourceCommit":"%040d"}\n' 0 \
    >"$release_dir/desktop-provenance.json"
  printf 'version: 0.41.0\n' >"$release_dir/latest.yml"
fi

PATH="$no_find_dir:$PATH" \
  GITHUB_REPOSITORY=local/repo \
  GITHUB_RUN_NUMBER=42 \
  GITHUB_SHA=0000000000000000000000000000000000000000 \
  GITHUB_REF_NAME=windows-client-v0.40.0 \
  RELEASE_REF=windows-client-v0.40.0 \
  bash build/scripts/ci/write-release-summary.sh "$release_dir"
PATH="$no_find_dir:$PATH" \
  bash build/scripts/ci/write-artifact-manifest.sh "$release_dir"
PATH="$no_find_dir:$PATH" \
  bash build/scripts/ci/write-sha256sums.sh "$release_dir"
if [ "$mode" = full ]; then
  PATH="$no_find_dir:$PATH" \
    bash build/scripts/ci/verify-release-artifacts.sh \
      "$release_dir" --require-publishable
else
  PATH="$no_find_dir:$PATH" \
    bash build/scripts/ci/verify-artifact-manifest.sh "$release_dir"
  PATH="$no_find_dir:$PATH" \
    bash build/scripts/ci/verify-sha256sums.sh "$release_dir"
fi

grep -q 'windows/myoxus-0.40.0-stable-windows-x64.exe' \
  "$release_dir/RELEASE.md"
grep -q 'windows/myoxus-0.40.0-stable-windows-x64.zip' \
  "$release_dir/ARTIFACTS.md"

echo "Windows release contract passed without a product build or publication."
