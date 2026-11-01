#!/usr/bin/env bash
# Collects native Rust server binaries from a release target directory.

set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <server-dir> <release-target-dir> <output-bin-dir>" >&2
  exit 2
fi

server_dir="$1"
release_dir="$2"
output_dir="$3"

test -d "$server_dir"
test -f "$server_dir/Cargo.toml"
test -d "$release_dir"

mkdir -p "$output_dir"

if [ -n "${SERVER_BINARY_NAMES:-}" ]; then
  binary_names="$SERVER_BINARY_NAMES"
else
  binary_names="$(
    cargo metadata --manifest-path "$server_dir/Cargo.toml" --format-version=1 --no-deps \
      | python3 -c '
import json
import sys

data = json.load(sys.stdin)
names = []
for package in data["packages"]:
    for target in package.get("targets", []):
        if "bin" in target.get("kind", []):
            names.append(target["name"])

for name in sorted(set(names)):
    print(name)
'
  )"
fi

if [ -z "$binary_names" ]; then
  echo "No server binary targets discovered." >&2
  exit 1
fi

copied=0
for name in $binary_names; do
  source_path="$release_dir/$name"
  if [ ! -f "$source_path" ]; then
    echo "Missing server binary: $source_path" >&2
    exit 1
  fi

  target_name="$name"
  for rename in ${SERVER_BINARY_RENAMES:-}; do
    from="${rename%%:*}"
    to="${rename#*:}"
    if [ "$from" = "$name" ] && [ -n "$to" ] && [ "$to" != "$from" ]; then
      target_name="$to"
    fi
  done

  target_path="$output_dir/$target_name"
  cp -v "$source_path" "$target_path"
  chmod 755 "$target_path"

  if command -v strip >/dev/null 2>&1; then
    strip "$target_path" >/dev/null 2>&1 || true
  fi

  copied=$((copied + 1))
done

if [ "$copied" -lt 1 ]; then
  echo "No server binaries copied." >&2
  exit 1
fi

find "$output_dir" -maxdepth 1 -type f -print | sort
