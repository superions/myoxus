#!/usr/bin/env bash
# Runs the fast local Forgejo CI/CD validation bundle.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$REPO_ROOT"

echo "==> Checking CI shell syntax"
bash -n build/scripts/ci/*.sh
bash -n build/scripts/release/*.sh

echo "==> Checking release orchestrator syntax"
node --check build/scripts/release/forgejo-client-release.mjs

echo "==> Checking CI script executable modes"
bash build/scripts/ci/verify-ci-script-modes.sh

echo "==> Checking Forgejo workflow YAML"
if command -v ruby >/dev/null 2>&1; then
  workflow_files="$(mktemp)"
  trap 'rm -f "$workflow_files"' EXIT
  find .forgejo/workflows .forgejo/workflow-drafts \
    -maxdepth 1 -type f -name '*.yml' | sort >"$workflow_files"
  if [ -s "$workflow_files" ]; then
    xargs ruby -e 'require "yaml"; ARGV.each { |f| YAML.load_file(f); puts f }' <"$workflow_files"
  fi
else
  echo "Ruby is not installed; skipping local YAML parse." >&2
fi

echo "==> Running CI helper fixtures"
bash build/scripts/ci/test-ci-support-scripts.sh
node --test build/scripts/ci/test-publish-github-release.mjs
node --test build/scripts/ci/test-sync-github-issues.mjs
node build/scripts/ci/test-publish-electron-release.mjs
node --test build/scripts/ci/test-publish-distribution-overview.mjs
node --test build/scripts/ci/test-no-direct-product-svg.mjs

echo "==> Checking workflow script references"
bash build/scripts/ci/verify-workflow-script-references.sh

echo "==> Running Forgejo hygiene gate"
bash build/scripts/ci/verify-forgejo-hygiene.sh

echo "Forgejo CI local checks passed."
