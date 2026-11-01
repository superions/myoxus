#!/usr/bin/env bash
# Writes a compact markdown manifest for files staged in an artifact directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <artifact-dir> [manifest-name]" >&2
  exit 2
fi

artifact_dir="${1%$'\r'}"
manifest_name="${2:-ARTIFACTS.md}"
manifest_name="${manifest_name%$'\r'}"
manifest_path="${artifact_dir}/${manifest_name}"

test -d "$artifact_dir"

list_artifact_files() {
  local file name
  while IFS= read -r file; do
    name="${file##*/}"
    if [ "$name" != "$manifest_name" ] && [ "$name" != SHA256SUMS ]; then
      printf '%s\n' "$file"
    fi
  done < <(bash "$SCRIPT_DIR/list-artifact-files.sh" "$artifact_dir")
}

artifact_count="$(
  list_artifact_files \
    | wc -l \
    | tr -d '[:space:]'
)"
if [ "$artifact_count" -lt 1 ]; then
  echo "No artifact files found under $artifact_dir" >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

{
  echo "# Artifact Manifest"
  echo
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "| Path | Bytes | SHA-256 |"
  echo "| --- | ---: | --- |"
  list_artifact_files \
    | while IFS= read -r file; do
      rel="${file#"$artifact_dir"/}"
      bytes="$(wc -c <"$file" | tr -d '[:space:]')"
      hash="$(sha256_file "$file")"
      printf '| `%s` | %s | `%s` |\n' "$rel" "$bytes" "$hash"
    done
} >"$manifest_path"

test -s "$manifest_path"
