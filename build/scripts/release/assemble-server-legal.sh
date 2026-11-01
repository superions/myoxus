#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

if [ $# -ne 4 ]; then
  echo "Usage: $0 <output-dir> <git-revision> <server-version> <source-date-epoch>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
output_dir="$1"
revision="$2"
version="$3"
epoch="$4"

case "$revision" in
  *[!0-9a-f]*|'') echo "Git revision must be lowercase hexadecimal" >&2; exit 2 ;;
esac
if [ "${#revision}" -ne 40 ] && [ "${#revision}" -ne 64 ]; then
  echo "Git revision must be complete" >&2
  exit 2
fi
case "$epoch" in
  *[!0-9]*|'') echo "SOURCE_DATE_EPOCH must be an integer" >&2; exit 2 ;;
esac

mkdir -p "$output_dir/sbom"
install -m 0644 "$repo_root/LICENSE" "$output_dir/LICENSE"
node "$repo_root/build/scripts/release/assemble-server-legal.mjs" \
  --repo-root "$repo_root" \
  --output "$output_dir" \
  --revision "$revision" \
  --version "$version" \
  --epoch "$epoch" \
  --source-archive-url "${MYOXUS_SOURCE_ARCHIVE_URL:-}" \
  --source-archive-sha256 "${MYOXUS_SOURCE_ARCHIVE_SHA256:-}" \
  --source-provenance "${MYOXUS_SOURCE_PROVENANCE:-}"
bash "$repo_root/build/scripts/release/generate-sbom.sh" \
  --rust-only \
  --output "$output_dir/sbom/server.cdx.json" \
  --git-revision "$revision" \
  --component-version "$version" \
  --source-date-epoch "$epoch"
if [ "${SKIP_SBOM_VALIDATION:-false}" != "true" ]; then
  bash "$repo_root/build/scripts/release/validate-sbom.sh" \
    "$output_dir/sbom/server.cdx.json"
fi

find "$output_dir" -type f -print | LC_ALL=C sort
