#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$script_dir/verify-macos-bundle-closure.mjs" "${1:?App bundle required}" "${2:?Target architecture required}"
