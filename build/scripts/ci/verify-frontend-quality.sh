#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Frontend/theme/docs quality gate split from the old monolithic quality draft.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

echo "==> Vanilla Extract cut-over guard"
yarn frontend:no-vanilla-extract:check

echo "==> Web/Admin UI framework graph guards"
yarn frontend:ui-framework-graph:final-check
yarn frontend:admin-ui-dependency-graph:check

echo "==> Frontend container isolation guard"
yarn frontend:container-isolation:check

echo "==> Theme, branding and font generated-artifact guards"
yarn branding:theme-db-cutover:check
bash build/scripts/ci/audit-fonts.sh

echo "==> Documentation gates"
yarn lint:docs:theme
python3 tools/check_docs_consistency.py

echo "==> Legacy JS tooling guard"
bash build/scripts/ci/forbid-legacy-js-tooling.sh

echo "==> Virgultum package build-script guard"
yarn virgultum:package-builds:check

echo "Frontend quality checks passed."
