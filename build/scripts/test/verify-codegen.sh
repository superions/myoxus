#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Verify that yarn codegen produces identical output to committed files.
# This prevents manual edits to generated files from going undetected.
#
# Usage:
#   build/scripts/test/verify-codegen.sh
#   build/scripts/test/verify-codegen.sh --require-server
#
# Requires: server running on port 3001, or MYOXUS_CODEGEN_SERVER_ORIGIN.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
REQUIRE_SERVER="${MYOXUS_CODEGEN_REQUIRE_SERVER:-}"
CODEGEN_ORIGIN="${MYOXUS_CODEGEN_SERVER_ORIGIN:-http://localhost:3001}"

if [ "${1:-}" = "--require-server" ]; then
  REQUIRE_SERVER=1
fi

# Check the same origin used by the schema loader.
if ! curl -fsS "${CODEGEN_ORIGIN%/}/health" > /dev/null 2>&1; then
  if [ -n "$REQUIRE_SERVER" ] || [ -n "${CI:-}" ]; then
    echo "FAIL: Server not running, but codegen verification is required." >&2
    echo "Start the current server first, then rerun:" >&2
    echo "  build/scripts/test/verify-codegen.sh --require-server" >&2
    exit 1
  fi
  echo "SKIP: Server not running (required for codegen). Start server first with:"
  echo "  build/scripts/server/stack-up.sh"
  echo "Use --require-server or MYOXUS_CODEGEN_REQUIRE_SERVER=1 in CI so this cannot skip."
  exit 0
fi

echo "Server is running. Checking codegen reproducibility..."

GRAPHQL_DIR="${ROOT_DIR}/client/libs/graphql"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Save current state
cp "${GRAPHQL_DIR}/src/graphql/index.ts" "${TMP_DIR}/codegen-index-before.ts"
cp "${GRAPHQL_DIR}/src/schema.ts" "${TMP_DIR}/codegen-schema-before.ts"
cp "${GRAPHQL_DIR}/src/operations.ts" "${TMP_DIR}/codegen-operations-before.ts"

# Run codegen
echo "Running yarn codegen in ${GRAPHQL_DIR}..."
(cd "${GRAPHQL_DIR}" && yarn codegen 2>&1)

# Compare
INDEX_CHANGED=false
SCHEMA_CHANGED=false
OPERATIONS_CHANGED=false

if ! diff -q "${TMP_DIR}/codegen-index-before.ts" "${GRAPHQL_DIR}/src/graphql/index.ts" > /dev/null 2>&1; then
  INDEX_CHANGED=true
fi

if ! diff -q "${TMP_DIR}/codegen-schema-before.ts" "${GRAPHQL_DIR}/src/schema.ts" > /dev/null 2>&1; then
  SCHEMA_CHANGED=true
fi

if ! diff -q "${TMP_DIR}/codegen-operations-before.ts" "${GRAPHQL_DIR}/src/operations.ts" > /dev/null 2>&1; then
  OPERATIONS_CHANGED=true
fi

if ! $INDEX_CHANGED && ! $SCHEMA_CHANGED && ! $OPERATIONS_CHANGED; then
  echo "PASS: Codegen output matches committed files"
  exit 0
else
  echo "FAIL: Codegen produced different output — manual edits detected or schema changed"
  if $INDEX_CHANGED; then
    echo ""
    echo "=== Changes in src/graphql/index.ts ==="
    diff "${TMP_DIR}/codegen-index-before.ts" "${GRAPHQL_DIR}/src/graphql/index.ts" | head -40 || true
  fi
  if $SCHEMA_CHANGED; then
    echo ""
    echo "=== Changes in src/schema.ts ==="
    diff "${TMP_DIR}/codegen-schema-before.ts" "${GRAPHQL_DIR}/src/schema.ts" | head -40 || true
  fi
  if $OPERATIONS_CHANGED; then
    echo ""
    echo "=== Changes in src/operations.ts ==="
    diff "${TMP_DIR}/codegen-operations-before.ts" "${GRAPHQL_DIR}/src/operations.ts" | head -40 || true
  fi
  exit 1
fi
