#!/usr/bin/env bash
# P-DEPS-ROOT-A-02-L — Local cargo security audit gate.
# Mirrors the enforcement in the Forgejo cargo-audit CI job.
# Usage:
#   ./build/scripts/ci/cargo-audit-local.sh
#
# Exit codes:
#   0  — no advisories
#   1  — advisories found (or cargo-audit not installed / build failed)
#
# Install cargo-audit once:
#   cargo install --locked cargo-audit

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
AUDIT_CONFIG="$SERVER_DIR/.cargo-audit.toml"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo "=== Myoxus: cargo audit (deny warnings) ==="

CARGO_AUDIT_JSON_OUTPUT="${CARGO_AUDIT_JSON_OUTPUT:-}"

# Ensure cargo-audit is available.
if ! command -v cargo-audit &>/dev/null; then
  echo "cargo-audit not found. Installing (this may take a minute)..."
  cargo install --locked cargo-audit --version 0.22.1 --quiet
fi

cd "$SERVER_DIR"

# cargo-audit 0.22 does not load a project configuration file itself. Keep the
# reviewed exception list in the server tree and translate it into explicit CLI
# arguments so local and Forgejo runs enforce the same policy.
AUDIT_ARGS=(--deny warnings)
while IFS= read -r advisory_id; do
  AUDIT_ARGS+=(--ignore "$advisory_id")
done < <(
  grep -E '^[[:space:]]*ignore[[:space:]]*=' "$AUDIT_CONFIG" \
    | grep -oE 'RUSTSEC-[0-9]{4}-[0-9]{4}' \
    || true
)

if printf '%s\n' "${AUDIT_ARGS[@]}" | grep -qx 'RUSTSEC-2023-0071'; then
  RSA_TREE="$(cargo tree --target all --edges all --invert rsa 2>/dev/null || true)"
  if [ -n "$RSA_TREE" ]; then
    echo -e "${RED}✗ RUSTSEC-2023-0071 exception is invalid: rsa is reachable${NC}"
    printf '%s\n' "$RSA_TREE"
    exit 1
  fi
fi

set +e
if [ -n "$CARGO_AUDIT_JSON_OUTPUT" ]; then
  mkdir -p "$(dirname "$CARGO_AUDIT_JSON_OUTPUT")"
  cargo audit "${AUDIT_ARGS[@]}" --json >"$CARGO_AUDIT_JSON_OUTPUT" 2>&1
else
  cargo audit "${AUDIT_ARGS[@]}" 2>&1
fi
AUDIT_EXIT=$?
set -e

echo ""
if [ "$AUDIT_EXIT" -eq 0 ]; then
  echo -e "${GREEN}✓ cargo audit: no advisories${NC}"
  exit 0
else
  echo -e "${RED}✗ cargo audit: policy findings remain (see above)${NC}"
  if [ -n "$CARGO_AUDIT_JSON_OUTPUT" ]; then
    echo "Full report: $CARGO_AUDIT_JSON_OUTPUT"
  fi
  echo ""
  echo "To suppress a confirmed false-positive, add to server/.cargo-audit.toml:"
  echo '  [advisories]'
  echo '  ignore = ["RUSTSEC-XXXX-XXXX"]  # reason: <justification>'
  echo ""
  echo "Document every suppression in docs/dev/dependency-audit.md."
  exit 1
fi
