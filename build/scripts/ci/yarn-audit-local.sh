#!/usr/bin/env bash
# P-DEPS-ROOT-A-01-L — Local yarn security audit gate.
# Mirrors the severity threshold that will be enforced in the Forgejo CI job.
# Usage:
#   ./build/scripts/ci/yarn-audit-local.sh              # normal run
#   AUDIT_MIN_SEVERITY=moderate ./build/scripts/ci/yarn-audit-local.sh  # stricter
#
# Exit codes:
#   0  — no advisories at or above the threshold
#   1  — advisories found (or audit command failed)
#
# Pre-commit usage:
#   Add to .git/hooks/pre-commit:
#     bash build/scripts/ci/yarn-audit-local.sh || exit 1

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

AUDIT_MIN_SEVERITY="${AUDIT_MIN_SEVERITY:-high}"
AUDIT_OUTPUT="${AUDIT_OUTPUT:-/tmp/myoxus-yarn-audit-$(date +%s).json}"
mkdir -p "$(dirname "$AUDIT_OUTPUT")"

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=== Myoxus: yarn npm audit (severity >= ${AUDIT_MIN_SEVERITY}) ==="

# yarn npm audit exits 1 when advisories are found — capture the report and
# preserve the audit exit code even if pretty-printing succeeds or fails.
set +e
yarn npm audit --recursive --all --severity "$AUDIT_MIN_SEVERITY" --json >"$AUDIT_OUTPUT" 2>/dev/null
AUDIT_EXIT=$?

# Yarn 4 emits no NDJSON at all when the selected severity is clean. Preserve a
# non-empty, machine-readable audit artifact for that exact successful case.
# Conversely, a command/registry failure without advisory events must remain
# invalid input so the consuming closure policies fail closed.
if [ "$AUDIT_EXIT" -eq 0 ] && [ ! -s "$AUDIT_OUTPUT" ]; then
  printf '{"type":"audit-summary","metadata":{"minimumSeverity":"%s","advisories":0,"result":"clean"}}\n' \
    "$AUDIT_MIN_SEVERITY" >"$AUDIT_OUTPUT"
elif [ "$AUDIT_EXIT" -ne 0 ]; then
  if ! python3 - "$AUDIT_OUTPUT" <<'PY'
import json
import pathlib
import sys

for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        continue
    children = event.get("children")
    if isinstance(children, dict) and children.get("Issue") and children.get("Severity"):
        raise SystemExit(0)
raise SystemExit(1)
PY
  then
    printf 'audit-command-failed-without-advisory-report: exit %s\n' \
      "$AUDIT_EXIT" >>"$AUDIT_OUTPUT"
  fi
fi

python3 - <<'PY' "$AUDIT_OUTPUT" || true
import json
import pathlib
import sys

for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        continue
    value = event.get("value")
    children = event.get("children")
    if isinstance(value, str):
        issue = children.get("Issue") if isinstance(children, dict) else None
        severity = children.get("Severity") if isinstance(children, dict) else None
        if issue and severity:
            print(f"{value}: [{severity}] {issue}")
        else:
            print(value)
    elif isinstance(value, dict) and "metadata" in value:
        print(json.dumps(value["metadata"], indent=2, sort_keys=True))
PY
set -e

# Parse advisory count from JSON output (resilient fallback).
ADVISORY_COUNT=0
if [ -s "$AUDIT_OUTPUT" ]; then
  # The last JSON object in the stream contains the summary.
  ADVISORY_COUNT=$(python3 - <<'PY' "$AUDIT_OUTPUT"
import sys, json, pathlib

path = sys.argv[1]
lines = pathlib.Path(path).read_text().splitlines()
# Find last line that is valid JSON with 'metadata'
for line in reversed(lines):
    try:
        d = json.loads(line)
        if "metadata" in d:
            v = d["metadata"].get("vulnerabilities", {})
            total = sum(
                v.get(k, 0) for k in ["high", "critical", "moderate", "low", "info"]
            )
            print(total)
            sys.exit(0)
    except (json.JSONDecodeError, TypeError):
        continue
count = 0
for line in lines:
    try:
        d = json.loads(line)
    except json.JSONDecodeError:
        continue
    children = d.get("children")
    if isinstance(children, dict) and children.get("ID"):
        count += 1
print(count)
PY
  ) 2>/dev/null || ADVISORY_COUNT=0
fi

echo ""
if [ "$AUDIT_EXIT" -eq 0 ]; then
  echo -e "${GREEN}✓ No advisories at severity >= ${AUDIT_MIN_SEVERITY}${NC}"
  echo "Audit report saved to: $AUDIT_OUTPUT"
  exit 0
else
  if grep -q '^audit-command-failed-without-advisory-report:' "$AUDIT_OUTPUT"; then
    echo -e "${RED}✗ yarn audit command failed without an advisory report${NC}"
  else
    echo -e "${RED}✗ yarn audit found ${ADVISORY_COUNT} advisory/advisories at severity >= ${AUDIT_MIN_SEVERITY}${NC}"
  fi
  echo "Full report: $AUDIT_OUTPUT"
  echo "Review each locator against its consuming closure and remediate the owning dependency."
  echo "Electron runtime, release-build and mandatory-test findings have no bypass path."
  exit 1
fi
