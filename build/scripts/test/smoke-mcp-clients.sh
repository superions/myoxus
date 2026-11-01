#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Live MCP compatibility smoke. Credentials are required through the
# environment; the generated MCP key and all client configuration live only in
# temporary directories and are revoked before this command returns.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=build/scripts/server/lib-auth-smoke.sh
source "$REPO_ROOT/build/scripts/server/lib-auth-smoke.sh"

API_URL="${MYOXUS_API_URL:-http://localhost:3001}"
MCP_URL="${MYOXUS_MCP_URL:-$API_URL/mcp}"
EMAIL="${MYOXUS_MCP_SMOKE_EMAIL:-}"
PASSWORD="${MYOXUS_MCP_SMOKE_PASSWORD:-}"
CODEX_BIN="${MYOXUS_CODEX_BIN:-$(command -v codex || true)}"
COPILOT_BIN="${MYOXUS_COPILOT_BIN:-$(command -v copilot || true)}"

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "[FAIL] MYOXUS_MCP_SMOKE_EMAIL and MYOXUS_MCP_SMOKE_PASSWORD are required" >&2
  exit 2
fi
if [[ -z "$CODEX_BIN" || ! -x "$CODEX_BIN" ]]; then
  echo "[FAIL] Codex CLI not found; set MYOXUS_CODEX_BIN" >&2
  exit 2
fi
if [[ -z "$COPILOT_BIN" || ! -x "$COPILOT_BIN" ]]; then
  echo "[FAIL] GitHub Copilot CLI not found; set MYOXUS_COPILOT_BIN" >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/myoxus-mcp-clients.XXXXXX")"
SESSION=""
KEY_ID=""
FIXTURE_WORKSPACE_ID=""
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$SESSION" ]]; then
    if ! MYOXUS_MCP_SMOKE_SESSION="$SESSION" MYOXUS_API_URL="$API_URL" \
      MYOXUS_MCP_CLEANUP_WORKSPACE="$FIXTURE_WORKSPACE_ID" MYOXUS_MCP_CLEANUP_KEY="$KEY_ID" \
      node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
async function gql(query, variables = {}) {
  const response = await fetch(`${process.env.MYOXUS_API_URL}/graphql`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `affine_session=${process.env.MYOXUS_MCP_SMOKE_SESSION}` },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  assert(response.ok && !body.errors, `Fixture cleanup GraphQL failed: HTTP ${response.status}; ${JSON.stringify(body.errors ?? [])}`);
  return body.data;
}
const failures = [];
const workspace = process.env.MYOXUS_MCP_CLEANUP_WORKSPACE;
if (workspace) {
  try {
    // The seeded Admin owns this disposable fixture. Ordinary deleteWorkspace
    // only trashes it and is not cleanup of the native consuming journey.
    const data = await gql('mutation($id:ID!){admin{deleteWorkspace(id:$id)}}', { id: workspace });
    assert.equal(data.admin.deleteWorkspace, true);
  } catch (error) { failures.push(`permanent workspace cleanup failed for ${workspace}: ${error.message}`); }
}
const key = process.env.MYOXUS_MCP_CLEANUP_KEY;
if (key) {
  try {
    const keys = await gql('{apiKeys{listApiKeys{id}}}');
    if (keys.apiKeys.listApiKeys.some(entry => entry.id === key)) {
      const data = await gql('mutation($id:String!){apiKeys{revokeApiKey(id:$id)}}', { id: key });
      assert.equal(data.apiKeys.revokeApiKey, true);
    }
  } catch (error) { failures.push(`API key cleanup failed for ${key}: ${error.message}`); }
}
if (failures.length) throw new Error(failures.join('; '));
NODE
    then
      echo '[FAIL] MCP smoke fixture cleanup did not complete' >&2
      status=1
    fi
  fi
  unset MYOXUS_MCP_TOKEN MYOXUS_MCP_IMPORT_WORKSPACE_ID MYOXUS_MCP_SMOKE_SESSION
  rm -rf "$TMP_ROOT"
  exit "$status"
}
trap cleanup EXIT

SESSION="$(smoke_admin_sign_in "$API_URL" "$EMAIL" "$PASSWORD")"
gql() {
  curl -fsS "$API_URL/graphql" \
    -H 'content-type: application/json' \
    -H "cookie: affine_session=$SESSION" \
    --data-binary "@$1"
}

cat >"$TMP_ROOT/create-workspace.json" <<'JSON'
{"query":"mutation { createWorkspace { id } }"}
JSON
gql "$TMP_ROOT/create-workspace.json" >"$TMP_ROOT/workspace.json"
FIXTURE_WORKSPACE_ID="$(node - "$TMP_ROOT/workspace.json" <<'NODE'
const fs = require('node:fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (body.errors) throw new Error(`fixture workspace creation failed: ${JSON.stringify(body.errors)}`);
const id = body.data?.createWorkspace?.id;
if (!id) throw new Error('fixture workspace creation returned no id');
process.stdout.write(id);
NODE
)"

cat >"$TMP_ROOT/create-key.json" <<'JSON'
{"query":"mutation($name:String!,$scopes:[String!]!){apiKeys{createApiKey(name:$name,scopes:$scopes){id key scopes}}}","variables":{"name":"mcp:runtime-compatibility-smoke","scopes":["read:workspaces","read:docs","write:docs","read:calendar","write:calendar"]}}
JSON
gql "$TMP_ROOT/create-key.json" >"$TMP_ROOT/created.json"
read -r KEY_ID MCP_TOKEN < <(node - "$TMP_ROOT/created.json" <<'NODE'
const fs = require('node:fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (body.errors) throw new Error(`API-key creation failed: ${JSON.stringify(body.errors)}`);
const key = body.data?.apiKeys?.createApiKey;
if (!key?.id || !key?.key) throw new Error('API-key creation returned no key');
process.stdout.write(`${key.id} ${key.key}\n`);
NODE
)

export MYOXUS_MCP_URL="$MCP_URL" MYOXUS_MCP_TOKEN="$MCP_TOKEN"
export MYOXUS_MCP_IMPORT_WORKSPACE_ID="$FIXTURE_WORKSPACE_ID"
node "$REPO_ROOT/build/scripts/test/mcp-http-smoke.mjs" >"$TMP_ROOT/http.json"

mkdir -m 700 -p "$TMP_ROOT/codex" "$TMP_ROOT/copilot"
if ! CODEX_HOME="$TMP_ROOT/codex" "$CODEX_BIN" mcp add myoxus \
  --url "$MCP_URL" --bearer-token-env-var MYOXUS_MCP_TOKEN \
  >"$TMP_ROOT/codex-add.out" 2>"$TMP_ROOT/codex-add.err"; then
  cat "$TMP_ROOT/codex-add.err" >&2
  exit 1
fi
if ! CODEX_HOME="$TMP_ROOT/codex" "$CODEX_BIN" mcp get myoxus --json \
  >"$TMP_ROOT/codex.json" 2>"$TMP_ROOT/codex-get.err"; then
  cat "$TMP_ROOT/codex-get.err" >&2
  exit 1
fi

# Copilot expands COPILOT_MCP_* variables in remote headers. Keep the
# credential out of both the isolated config and command output.
COPILOT_HOME="$TMP_ROOT/copilot" COPILOT_MCP_MYOXUS_TOKEN="$MCP_TOKEN" \
  "$COPILOT_BIN" mcp add \
  --transport http --header 'Authorization: Bearer ${COPILOT_MCP_MYOXUS_TOKEN}' \
  --tools '*' --json myoxus "$MCP_URL" >"$TMP_ROOT/copilot-add.json"
COPILOT_HOME="$TMP_ROOT/copilot" COPILOT_MCP_MYOXUS_TOKEN="$MCP_TOKEN" \
  "$COPILOT_BIN" mcp get --json myoxus >"$TMP_ROOT/copilot.json"

node - "$MCP_URL" "$TMP_ROOT/codex.json" "$TMP_ROOT/copilot.json" <<'NODE'
const fs = require('node:fs');
const [url, codexPath, copilotPath] = process.argv.slice(2);
const codex = JSON.parse(fs.readFileSync(codexPath, 'utf8'));
const copilot = JSON.parse(fs.readFileSync(copilotPath, 'utf8'));
if (
  codex.transport?.type !== 'streamable_http' ||
  codex.transport?.url !== url ||
  codex.transport?.bearer_token_env_var !== 'MYOXUS_MCP_TOKEN'
) {
  throw new Error('Codex did not preserve the Streamable HTTP bearer-token contract');
}
const copilotConfig = copilot.myoxus;
const copilotUrl = copilotConfig?.url;
const copilotTransport = copilotConfig?.type;
if (copilotUrl !== url || !['http', 'remote'].includes(copilotTransport)) {
  throw new Error('Copilot did not preserve the remote HTTP MCP contract');
}
if (copilotConfig?.headers?.Authorization !== 'Bearer ${COPILOT_MCP_MYOXUS_TOKEN}') {
  throw new Error('Copilot did not preserve environment-backed Bearer authentication');
}
NODE

MYOXUS_CODEX_BIN="$CODEX_BIN" MYOXUS_COPILOT_BIN="$COPILOT_BIN" \
MYOXUS_API_URL="$API_URL" MYOXUS_MCP_CLIENT_HOME="$TMP_ROOT" \
MYOXUS_MCP_SMOKE_SESSION="$SESSION" MYOXUS_MCP_SMOKE_KEY_ID="$KEY_ID" \
  node "$REPO_ROOT/build/scripts/test/mcp-native-smoke.mjs" >"$TMP_ROOT/native.json"
node - "$TMP_ROOT/native.json" <<'NODE'
const fs = require('node:fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (body.keyRevoked !== true || body.clients?.length !== 2) throw new Error('Native client acceptance did not finish');
NODE
KEY_ID=""
node "$REPO_ROOT/build/scripts/test/mcp-http-smoke.mjs" --expect-unauthorized >"$TMP_ROOT/revoked-http.json"

REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)"
API_CONTAINER="${MYOXUS_MCP_API_CONTAINER:-server-api-1}"
IMAGE_ID="${MYOXUS_MCP_IMAGE_DIGEST:-$(docker inspect "$API_CONTAINER" --format '{{.Image}}' 2>/dev/null || printf unavailable)}"
SERVED_REVISION="${MYOXUS_MCP_SERVED_REVISION:-$(docker inspect "$API_CONTAINER" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || printf unavailable)}"
if [[ "$SERVED_REVISION" != "$REVISION" ]]; then
  echo "[FAIL] served revision $SERVED_REVISION does not match source revision $REVISION" >&2
  exit 1
fi
if [[ "$IMAGE_ID" == "unavailable" || -z "$IMAGE_ID" ]]; then
  echo "[FAIL] served image digest is unavailable; set MYOXUS_MCP_IMAGE_DIGEST for a remote endpoint" >&2
  exit 1
fi
API_VERSION="$(curl -fsS "$API_URL/graphql" -H 'content-type: application/json' -d '{"query":"{serverConfig{version}}"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).data.serverConfig.version))')"

node - "$TMP_ROOT/http.json" "$REVISION" "$SERVED_REVISION" "$IMAGE_ID" "$API_VERSION" "$TMP_ROOT/native.json" <<'NODE'
const fs = require('node:fs');
const [httpPath, commit, servedRevision, imageDigest, apiVersion, nativePath] = process.argv.slice(2);
const http = JSON.parse(fs.readFileSync(httpPath, 'utf8'));
const native = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
process.stdout.write(`${JSON.stringify({
  verifiedAt: new Date().toISOString(),
  commit,
  servedRevision,
  imageDigest,
  apiVersion,
  clients: [
    { name: 'generic Streamable HTTP', version: 'repository smoke', transport: 'http', auth: 'bearer', ...http, outcome: 'pass' },
    ...native.clients,
  ],
  revokedKeyRejected: true,
}, null, 2)}\n`);
NODE
