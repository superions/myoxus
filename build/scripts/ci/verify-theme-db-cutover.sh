#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

node build/scripts/branding/verify-theme-db-cutover.mjs
node build/scripts/branding/verify-theme-font-materialization.mjs
yarn branding:theme-catalog:check
yarn branding:theme-fallback:check
yarn branding:brand-identity-fallback:check
