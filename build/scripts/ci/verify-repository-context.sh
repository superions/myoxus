#!/usr/bin/env bash
# Verifies that a Forgejo job runs inside the expected repository checkout.

set -euo pipefail

git status --short --branch
test -f package.json
test -f docs/dev/README.md
test -d .forgejo/workflows
test -d build/scripts/ci
