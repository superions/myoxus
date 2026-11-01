#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Lists regular artifact files without depending on a platform-specific find.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <artifact-dir>" >&2
  exit 2
fi

artifact_dir="$1"
test -d "$artifact_dir"

walk_artifact_directory() {
  local directory="$1" entry
  for entry in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then
      continue
    fi
    if [ -L "$entry" ]; then
      echo "Artifact directory contains a symbolic link: $entry" >&2
      return 1
    fi
    if [ -d "$entry" ]; then
      walk_artifact_directory "$entry"
    elif [ -f "$entry" ]; then
      case "$entry" in
        *$'\n'*)
          echo "Artifact path contains a newline" >&2
          return 1
          ;;
      esac
      printf '%s\n' "$entry"
    fi
  done
}

walk_artifact_directory "$artifact_dir" \
  | LC_ALL=C sort \
  | while IFS= read -r entry; do
    # Windows sort.exe materializes CRLF even when the surrounding Git Bash
    # scripts are checked out with LF. Never let that transport delimiter
    # become part of an artifact path consumed by manifest/hash writers.
    printf '%s\n' "${entry%$'\r'}"
  done
