#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run the GraphQL codegen drift gate against a reproducible local API stack.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
START_STACK=false
STACK_STARTED=false
CODEGEN_ORIGIN="${MYOXUS_CODEGEN_SERVER_ORIGIN:-http://127.0.0.1:3001}"

for arg in "$@"; do
  case "$arg" in
    --start-stack) START_STACK=true ;;
    --help|-h)
      cat <<'USAGE'
Usage: build/scripts/ci/verify-graphql-codegen-stack.sh [--start-stack]

Without --start-stack, the script requires an already healthy API at localhost:3001.
With --start-stack, it starts the selfhost stack first and stops only the stack it started.
MYOXUS_CODEGEN_SERVER_ORIGIN selects an existing isolated API; it is never auto-started.
USAGE
      exit 0
      ;;
    *)
      echo "[FAIL] unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

cd "$REPO_ROOT"

api_healthy() {
  curl -fsS "${CODEGEN_ORIGIN%/}/health" >/dev/null 2>&1
}

cleanup() {
  if [ "$STACK_STARTED" = true ]; then
    bash build/scripts/server/stack-down.sh
  fi
}
trap cleanup EXIT

if ! api_healthy; then
  if [ "$START_STACK" != true ] || [ -n "${MYOXUS_CODEGEN_SERVER_ORIGIN:-}" ]; then
    echo "[FAIL] API is not healthy at ${CODEGEN_ORIGIN%/}/health" >&2
    echo "Start the selected API first; --start-stack only starts the default selfhost API." >&2
    exit 1
  fi
  echo "[INFO] API is not healthy; starting selfhost stack for codegen gate..."
  STACK_STARTED=true
  bash build/scripts/server/stack-up.sh --rebuild
fi

if ! api_healthy; then
  echo "[FAIL] API at ${CODEGEN_ORIGIN%/} did not become healthy for GraphQL codegen verification" >&2
  exit 1
fi

if [ -n "${MYOXUS_GRAPHQL_SCHEMA_OUTPUT:-}" ]; then
  mkdir -p "$(dirname "$MYOXUS_GRAPHQL_SCHEMA_OUTPUT")"
  SCHEMA_URL="${CODEGEN_ORIGIN%/}/graphql" \
    SCHEMA_PATH="$MYOXUS_GRAPHQL_SCHEMA_OUTPUT" \
    node --input-type=module <<'NODE'
import { buildClientSchema, getIntrospectionQuery, printSchema } from 'graphql';
import { writeFileSync } from 'node:fs';

const response = await fetch(process.env.SCHEMA_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: getIntrospectionQuery() }),
});
if (!response.ok) {
  throw new Error(`GraphQL introspection failed: ${response.status} ${response.statusText}`);
}
const payload = await response.json();
if (payload.errors) {
  throw new Error(`GraphQL introspection returned errors: ${JSON.stringify(payload.errors)}`);
}
writeFileSync(
  process.env.SCHEMA_PATH,
  printSchema(buildClientSchema(payload.data)),
);
NODE
fi

MYOXUS_CODEGEN_REQUIRE_SERVER=1 bash build/scripts/test/verify-codegen.sh --require-server
