#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--check" ]; }; then
  echo "Usage: build/scripts/docs/generate-server-api.sh [--check]" >&2
  exit 2
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

# Use the same no-debug profile as the matrix. Cargo owns the target location;
# its JSON output supplies the actual executable, including custom target dirs.
CARGO_PROFILE_DEV_DEBUG=0 bash build/scripts/test/cargo-diagnostic.sh \
  --timeout-seconds 600 -- build --locked --manifest-path server/Cargo.toml \
  -p myoxus-api --example export-graphql-schema --message-format=json-render-diagnostics > "$TEMP_DIR/build.jsonl"

EXPORTER="$(node --input-type=module - "$TEMP_DIR/build.jsonl" <<'NODE'
import { readFileSync } from 'node:fs';
const messages = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
const artifact = messages.findLast(message => message.target?.name === 'export-graphql-schema' && message.executable);
if (!artifact) throw new Error('Cargo did not produce the GraphQL schema exporter');
console.log(artifact.executable);
NODE
)"
"$EXPORTER" > "$TEMP_DIR/schema.graphql"
node build/scripts/docs/generate-server-api.mjs --schema "$TEMP_DIR/schema.graphql" "$@"
