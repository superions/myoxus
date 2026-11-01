#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# audit-fonts.sh — P-FONT-COVERAGE-08 CI gate.
#
# Wraps `build/scripts/fonts/audit-coverage.sh --validate` so PRs touching
# `server/static/fonts/**` cannot land an inventory that drifts from
# `manifest.json` (file present without entry, entry without file, sha256
# mismatch).
#
# Exit codes:
#   0 — manifest in sync with disk
#   1 — drift detected (blocking unless --warn-only)
#   2 — environment / usage error (python3 / fontTools missing)
#
# Usage:
#   build/scripts/ci/audit-fonts.sh
#   build/scripts/ci/audit-fonts.sh --warn-only   # print drift but exit 0
#
# Reference: todo/pdf-refactoring.md  (P-FONT-COVERAGE-08)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
AUDIT="$REPO_ROOT/build/scripts/fonts/audit-coverage.sh"

WARN_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --warn-only) WARN_ONLY=true ;;
    -h|--help)
      sed -n '3,21p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "audit-fonts: unknown arg '$arg'" >&2
      exit 2
      ;;
  esac
done

if [[ ! -x "$AUDIT" ]]; then
  echo "audit-fonts: $AUDIT not executable" >&2
  exit 2
fi

if ! python3 - <<'PY' >/dev/null 2>&1
import brotli  # noqa: F401
import fontTools  # noqa: F401
PY
then
  FONT_AUDIT_VENV="${MYOXUS_CI_FONT_AUDIT_VENV:-/tmp/myoxus-ci-font-audit-venv}"
  if [[ ! -x "$FONT_AUDIT_VENV/bin/python" ]] || ! "$FONT_AUDIT_VENV/bin/python" - <<'PY' >/dev/null 2>&1
import brotli  # noqa: F401
import fontTools  # noqa: F401
PY
  then
    echo "audit-fonts: installing Python font audit dependencies into isolated venv: $FONT_AUDIT_VENV" >&2
    python3 -m venv "$FONT_AUDIT_VENV"
    "$FONT_AUDIT_VENV/bin/python" -m pip install --upgrade pip
    "$FONT_AUDIT_VENV/bin/python" -m pip install fonttools brotli
  else
    echo "audit-fonts: using isolated Python font audit venv: $FONT_AUDIT_VENV" >&2
  fi
  export PATH="$FONT_AUDIT_VENV/bin:$PATH"
fi

set +e
"$AUDIT" --validate --no-color
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo ""
  echo "✓ Font manifest sync OK."
  exit 0
fi

if [[ $status -eq 2 ]]; then
  echo "" >&2
  echo "audit-fonts: environment error from audit-coverage.sh" >&2
  exit 2
fi

echo ""
echo "FONT COVERAGE GATE — DRIFT DETECTED:"
echo "  • Disk and server/static/fonts/manifest.json disagree."
echo "  • Re-run locally: build/scripts/fonts/audit-coverage.sh --validate"
echo "  • Fixing manifest after a font change is part of P-FONT-COVERAGE-02 / -03."

if [[ "$WARN_ONLY" == true ]]; then
  echo ""
  echo "(warn-only mode — not failing)"
  exit 0
fi
exit 1
