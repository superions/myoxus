#!/usr/bin/env bash
# Writes a compact release build summary into the release artifact directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if [ $# -ne 1 ]; then
  echo "Usage: $0 <release-dir>" >&2
  exit 2
fi

release_dir="$1"
summary_path="$release_dir/RELEASE.md"

test -d "$release_dir"

list_release_files() {
  bash "$SCRIPT_DIR/list-artifact-files.sh" "$release_dir"
}

{
  echo "# Release Build Summary"
  echo
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "- repository: ${GITHUB_REPOSITORY:-local/repository}"
  echo "- run: ${GITHUB_RUN_NUMBER:-manual}"
  echo "- sha: ${GITHUB_SHA:-local}"
  echo "- ref: ${GITHUB_REF_NAME:-manual}"
  echo "- release ref: ${RELEASE_REF:-${GITHUB_REF_NAME:-manual}}"
  echo "- publish containers: ${PUBLISH_CONTAINERS:-false}"
  echo
  echo "## Linux Packages"
  echo
  if [ -d "$release_dir/linux" ]; then
    list_release_files | while IFS= read -r file; do
      relative="${file#"$release_dir"/}"
      case "$relative" in
        linux/*.deb | linux/*.rpm | linux/*.flatpak)
          printf -- "- %s\n" "$relative"
          ;;
      esac
    done
  fi
  echo
  echo "## macOS Packages"
  echo
  if [ -d "$release_dir/macos" ]; then
    list_release_files | while IFS= read -r file; do
      relative="${file#"$release_dir"/}"
      case "$relative" in
        macos/*.dmg | macos/*.zip)
          printf -- "- %s\n" "$relative"
          ;;
      esac
    done
  fi
  echo
  echo "## Windows Packages"
  echo
  if [ -d "$release_dir/windows" ]; then
    list_release_files | while IFS= read -r file; do
      relative="${file#"$release_dir"/}"
      case "$relative" in
        windows/*.exe | windows/*.zip)
          printf -- "- %s\n" "$relative"
          ;;
      esac
    done
  fi
  echo
  echo "## SBOMs"
  echo
  if [ -d "$release_dir/sbom" ]; then
    list_release_files | while IFS= read -r file; do
      relative="${file#"$release_dir"/}"
      case "$relative" in
        sbom/*.cdx.json)
          printf -- "- %s\n" "$relative"
          ;;
      esac
    done
  fi
} >"$summary_path"

test -s "$summary_path"
