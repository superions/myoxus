#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Forgejo pre-receive.d drop-in. Read allowed roots beside the installed hook.
set -eu
export GIT_NO_REPLACE_OBJECTS=1
roots_file="${MYOXUS_ALLOWED_ROOTS_FILE:-$(dirname "$0")/myoxus-allowed-roots}"
test -s "$roots_file" || { echo 'Missing Myoxus root policy' >&2; exit 1; }
while read -r old new ref; do
  case "$ref" in refs/replace/*) echo 'Replace refs are forbidden' >&2; exit 1;; esac
  case "$new" in 0000000000000000000000000000000000000000) continue;; esac
  commit=$(git rev-parse --verify "$new^{commit}") || exit 1
  roots=$(git rev-list --max-parents=0 "$commit") || exit 1
  test -n "$roots" || exit 1
  for root in $roots; do
    grep -Fxq "$root" "$roots_file" || {
      echo "Rejected $ref: unapproved source ancestry" >&2
      exit 1
    }
  done
done
