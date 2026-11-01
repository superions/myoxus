#!/usr/bin/env bash
# Creates a compressed archive from a native server bundle directory.

set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <bundle-parent-dir> <bundle-name> <archive-dir>" >&2
  exit 2
fi

bundle_parent="$1"
bundle_name="$2"
archive_dir="$3"
bundle_dir="$bundle_parent/$bundle_name"

test -d "$bundle_dir"
test -x "$bundle_dir/bin/myoxus-server"
test -x "$bundle_dir/bin/myoxus-cli"
cmp -s "$bundle_dir/templates/features/release.yaml" "$bundle_dir/static/features/release.yaml" || {
  echo "Feature independent release expectation differs" >&2
  exit 1
}
"$bundle_dir/bin/myoxus-cli" templates feature-bundle validate-release \
  --root "$bundle_dir/templates" \
  --release-manifest "$bundle_dir/static/features/release.yaml"
for native_family in databases assistants documents; do
  test ! -e "$bundle_dir/templates/$native_family"
done

mkdir -p "$archive_dir"

if command -v zstd >/dev/null 2>&1; then
  archive_path="$archive_dir/$bundle_name.tar.zst"
  tar -C "$bundle_parent" -cf - "$bundle_name" | zstd -19 -T0 -o "$archive_path"
else
  archive_path="$archive_dir/$bundle_name.tar.gz"
  tar -C "$bundle_parent" -czf "$archive_path" "$bundle_name"
fi

test -s "$archive_path"
echo "$archive_path"
