#!/usr/bin/env bash
# Collects Electron Linux package artifacts into the release directory.

set -euo pipefail

source_dir="${1:-client/apps/electron/out/stable/make}"
target_dir="${2:-dist/release/linux}"
targets="${3:-${LINUX_TARGETS:-deb,rpm,flatpak}}"

test -d "$source_dir"
mkdir -p "$target_dir"

IFS=',' read -r -a extensions <<<"$targets"
for ext in "${extensions[@]}"; do
  ext="${ext//[[:space:]]/}"
  case "$ext" in deb | rpm | flatpak) ;; *)
    echo "Unsupported Linux package target: $ext" >&2
    exit 2
  esac
  artifacts=()
  while IFS= read -r artifact; do
    artifacts+=("$artifact")
  done < <(
    find "$source_dir/$ext" -maxdepth 1 -type f -name "*.${ext}" -print 2>/dev/null | sort
  )
  if [ "${#artifacts[@]}" -ne 1 ]; then
    echo "Expected exactly one current ${ext} artifact under $source_dir/$ext; found ${#artifacts[@]}" >&2
    exit 1
  fi
  if [[ "$(basename "${artifacts[0]}")" == *Squirrel* ]] ||
    [[ "$(basename "${artifacts[0]}")" == *.nupkg ]]; then
    echo "Forbidden package artifact: ${artifacts[0]}" >&2
    exit 1
  fi
  cp -v "${artifacts[0]}" "$target_dir/"
done

find "$target_dir" -type f -print | sort
