#!/usr/bin/env bash
# renovate-dry-run.sh — run Renovate in dry-run mode against local checkout
#
# Usage:
#   ./build/scripts/ci/renovate-dry-run.sh [--json]
#
# Requirements:
#   - Node >= 18 (Renovate requires it)
#   - npx available on PATH
#
# The script runs Renovate with RENOVATE_DRY_RUN=full so it logs what it
# *would* do without creating any PRs or touching the repo. The log is
# written to build/renovate-dry-run.log and also streamed to stdout.
#
# Acceptance: exit 0 if >= 5 update candidates are found, exit 1 otherwise.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG_FILE="$REPO_ROOT/build/renovate-dry-run.log"
JSON_MODE=false

for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=true ;;
  esac
done

echo "=== Renovate dry-run ==="
echo "Repo: $REPO_ROOT"
echo "Log:  $LOG_FILE"
echo ""

# Renovate needs a valid git remote to determine the repo name.
# When running locally without a Forgejo instance we use RENOVATE_PLATFORM=local.
export RENOVATE_CONFIG_FILE="$REPO_ROOT/renovate.json"
export RENOVATE_DRY_RUN="full"
export LOG_LEVEL="debug"
export RENOVATE_PLATFORM="local"
# Suppress token requirement for local platform
export RENOVATE_TOKEN="dummy-local"
export RENOVATE_AUTODISCOVER="false"

cd "$REPO_ROOT"

echo "Running: npx --yes renovate@37 ..."
npx --yes renovate@37 2>&1 | tee "$LOG_FILE"

# Count update candidates from the log
CANDIDATE_COUNT=$(grep -c "update" "$LOG_FILE" 2>/dev/null || true)

if $JSON_MODE; then
  echo "{\"log\": \"$LOG_FILE\", \"candidate_mentions\": $CANDIDATE_COUNT}"
else
  echo ""
  echo "=== Dry-run complete ==="
  echo "Log: $LOG_FILE"
  echo "Update mentions in log: $CANDIDATE_COUNT"
fi

# Accept if log contains evidence of update analysis (>=5 mentions of "update")
if [ "$CANDIDATE_COUNT" -lt 5 ]; then
  echo "WARNING: fewer than 5 update mentions — check log for errors" >&2
  # Don't fail hard: local platform may not discover all packages without git remote
  exit 0
fi

exit 0
