#!/usr/bin/env bash
# Writes a human-readable summary for native server build artifacts.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <server-build-dir>" >&2
  exit 2
fi

build_dir="$1"
summary_path="$build_dir/SERVER_BUILD.md"
bundle_root="$build_dir/bundle"
archive_dir="$build_dir/archives"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

test -d "$build_dir"
test -d "$bundle_root"

binary_count="$(find "$bundle_root" -path '*/bin/*' -type f | wc -l | tr -d '[:space:]')"
if [ "$binary_count" -lt 1 ]; then
  echo "No server binaries found under $bundle_root" >&2
  exit 1
fi

rust_version="unavailable"
if command -v rustc >/dev/null 2>&1; then
  rust_version="$(rustc --version)"
fi

# Local release-gate runs are first-class evidence. Resolve their source
# identity from Git instead of replacing the commit and branch with "local".
repository="${GITHUB_REPOSITORY:-$(git -C "$repo_root" remote get-url origin 2>/dev/null || printf 'local/repository')}"
ref_name="${GITHUB_REF_NAME:-$(git -C "$repo_root" symbolic-ref --quiet --short HEAD 2>/dev/null || printf 'detached')}"
git_sha="${SERVER_BUILD_REVISION:-${GITHUB_SHA:-$(git -C "$repo_root" rev-parse HEAD)}}"

{
  echo "# Native Server Build"
  echo
  echo "- generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- repository: $repository"
  echo "- ref: $ref_name"
  echo "- sha: $git_sha"
  echo "- packaging-sha: ${GITHUB_SHA:-$(git -C "$repo_root" rev-parse HEAD)}"
  echo "- run: ${GITHUB_RUN_NUMBER:-local}"
  echo "- rust: $rust_version"
  echo
  echo "## Binaries"
  echo
  echo "| Path | Bytes |"
  echo "| --- | ---: |"
  find "$bundle_root" -path '*/bin/*' -type f -print \
    | sort \
    | while IFS= read -r file; do
      rel="${file#"$build_dir"/}"
      bytes="$(wc -c <"$file" | tr -d '[:space:]')"
      printf '| `%s` | %s |\n' "$rel" "$bytes"
    done
  if [ -d "$archive_dir" ]; then
    echo
    echo "## Archives"
    echo
    echo "| Path | Bytes |"
    echo "| --- | ---: |"
    find "$archive_dir" -maxdepth 1 -type f -print \
      | sort \
      | while IFS= read -r file; do
        rel="${file#"$build_dir"/}"
        bytes="$(wc -c <"$file" | tr -d '[:space:]')"
        printf '| `%s` | %s |\n' "$rel" "$bytes"
      done
  fi
  echo
  echo "## Packages"
  echo
  find "$build_dir/packages" -type f \( -name '*.deb' -o -name '*.rpm' \) -print | sort
} >"$summary_path"

test -s "$summary_path"
