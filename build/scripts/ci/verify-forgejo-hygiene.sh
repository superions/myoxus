#!/usr/bin/env bash
# Verifies the active Forgejo workflow and curated GitHub metadata sets while
# blocking hosted-build/AFFiNE CI regressions.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$REPO_ROOT"

expected="$(mktemp)"
actual="$(mktemp)"
expected_github="$(mktemp)"
actual_github="$(mktemp)"
trap 'rm -f "$expected" "$actual" "$expected_github" "$actual_github"' EXIT

printf '%s\n' \
  artifact-transfer-contract.yml \
  dependency-health.yml \
  electron-packaging.yml \
  frontend-quality.yml \
  graphql-codegen.yml \
  merge-check.yml \
  policy-docs.yml \
  pr-check.yml \
  publish-github-release.yml \
  recover-container-release.yml \
  recover-desktop-release.yml \
  refresh-desktop-dependencies.yml \
  release-desktop.yml \
  release-linux.yml \
  renovate.yml \
  repository-preflight.yml \
  runner-maintenance.yml \
  runner-smoke.yml \
  server-build.yml \
  server-fast.yml \
  server-integration.yml \
  sync-github-issues.yml \
  windows-release-contract.yml \
  >"$expected"

find .forgejo/workflows -maxdepth 1 -type f -name '*.yml' -exec basename {} \; \
  | sort \
  >"$actual"

diff -u "$expected" "$actual"

printf '%s\n' \
  .github/ISSUE_TEMPLATE/bug_report.yml \
  .github/ISSUE_TEMPLATE/config.yml \
  .github/ISSUE_TEMPLATE/feature_request.yml \
  .github/PULL_REQUEST_TEMPLATE.md \
  .github/copilot-instructions.md \
  >"$expected_github"

if [ -d .github ]; then
  find .github -type f -print | sort >"$actual_github"
  if find .github -type l -print -quit | grep -q .; then
    echo "Symlinks are not allowed in the curated GitHub metadata boundary." >&2
    exit 1
  fi
else
  : >"$actual_github"
fi

diff -u "$expected_github" "$actual_github"

if grep -R -E \
  "\\.github/|ubuntu-latest|macos-latest|windows-latest|actions/setup|dtolnay|Swatinem|docker/|softprops|actions/cache|(^|[^[:alnum:]_.-])myoxus-build([^[:alnum:]_.-]|$)|/var/cache/myoxus(/|[[:space:]\"']|$)|/var/cache/ci-build" \
  .forgejo; then
  exit 1
fi

if grep -R -E \
  --exclude=verify-forgejo-hygiene.sh \
  --exclude=verify-public-source-export.mjs \
  "\\.github/|actions/setup|ubuntu-latest|macos-latest|windows-latest|dtolnay|Swatinem|softprops|actions/cache|(^|[^[:alnum:]_.-])myoxus-build([^[:alnum:]_.-]|$)|/var/cache/myoxus(/|[[:space:]\"']|$)|/var/cache/ci-build" \
  docs/dev build/scripts/ci; then
  exit 1
fi

bash build/scripts/ci/verify-forgejo-action-allowlist.sh
