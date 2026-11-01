#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Verify representative Virgultum package build scripts resolve TypeScript via
# the root workspace instead of relying on package-local tsc binaries.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

packages=(
  "@virgultum/block-bookmark"
  "@virgultum/widget-slash-menu"
)

for package in "${packages[@]}"; do
  echo "==> $package build"
  yarn workspace "$package" build
done

if rg -n '"build": "tsc( |")' virgultum -g package.json; then
  echo "Found Virgultum package build scripts that call package-local tsc directly." >&2
  exit 1
fi
