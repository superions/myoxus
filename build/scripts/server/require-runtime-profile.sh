#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Validate before any mkdir, chown, seed, build, Compose or materialization mutation.
profile_exports="$(node "$REPO_ROOT/build/scripts/server/runtime-profile.mjs" exports "$REPO_ROOT")" || return 1
# Exports contain only allowlisted names and shell-quoted scalar values.
eval "$profile_exports"
unset profile_exports
node "$REPO_ROOT/build/scripts/server/runtime-profile.mjs" "${1:-verify}" "$REPO_ROOT" || return 1
