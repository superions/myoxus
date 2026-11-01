#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

app="${1:?App bundle required}"
codesign --verify --deep --strict --verbose=2 "$app"
# Drain codesign completely before matching; grep -q in a pipe can cause SIGPIPE.
signature="$(codesign -dv --verbose=4 "$app" 2>&1)"
if ! grep -q '^Signature=adhoc$' <<< "$signature"; then
  printf 'Unsigned-test app does not have an ad-hoc signature\n' >&2
  exit 1
fi
if grep -q '^Authority=' <<< "$signature"; then
  printf 'Unsigned-test app unexpectedly has a distribution authority\n' >&2
  exit 1
fi
printf 'Verified complete ad-hoc signature for %s\n' "$app"
