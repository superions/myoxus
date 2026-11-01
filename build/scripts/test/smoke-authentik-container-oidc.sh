#!/usr/bin/env bash
# Reproducible live Authentik OIDC smoke for the Myoxus OU-sync fixture.
#
# The server integration tests own Myoxus' in-process OIDC -> OU reconciliation
# assertions. This smoke owns the external IdP boundary: a real Authentik
# container is bootstrapped from the same fixture matrix, then a real browser
# completes an authorization-code login and verifies that Authentik emits the
# group claim Myoxus consumes. Keeping this boundary separate prevents
# Authentik-specific provisioning details from leaking into product auth code.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FIXTURE="$ROOT_DIR/server/crates/api/tests/fixtures/authentik_oidc_ou_matrix.json"
WORK_DIR="${MYOXUS_AUTHENTIK_SMOKE_DIR:-/tmp/myoxus-authentik-oidc-smoke}"
ARTIFACT_DIR="${MYOXUS_AUTHENTIK_SMOKE_ARTIFACT_DIR:-$ROOT_DIR/output/authentik-oidc-smoke}"
AUTHENTIK_IMAGE="${MYOXUS_AUTHENTIK_IMAGE:-ghcr.io/goauthentik/server:2026.5.3}"
AUTHENTIK_BASE_URL="${MYOXUS_AUTHENTIK_BASE_URL:-http://localhost:19000}"
AUTHENTIK_TOKEN="${MYOXUS_AUTHENTIK_BOOTSTRAP_TOKEN:-myoxus-authentik-bootstrap-token-test-only}"
AUTHENTIK_PASSWORD="${MYOXUS_AUTHENTIK_BOOTSTRAP_PASSWORD:-MyoxusAuthentikTest2026!}"
TEST_USER_PASSWORD="${MYOXUS_AUTHENTIK_TEST_USER_PASSWORD:-MyoxusOidcSmoke2026!}"
COMPOSE_FILE="$WORK_DIR/compose.yml"
BOOTSTRAP_JSON="$WORK_DIR/bootstrap.json"
LOGIN_SUMMARY="$ARTIFACT_DIR/live-login-summary.json"

pass() { printf '  [PASS] %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1" >&2; exit 1; }

cleanup() {
  rm -f "$WORK_DIR/callback.json" "$WORK_DIR/token.json"
  if [ "${MYOXUS_KEEP_AUTHENTIK_SMOKE:-0}" != "1" ] && [ -f "$COMPOSE_FILE" ]; then
    docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command missing: $1"
}

require_command docker
require_command python3
require_command jq
require_command curl
require_command node

if [ -n "${MYOXUS_AUTHENTIK_CALLBACK_URL:-}" ]; then
  CALLBACK_URL="$MYOXUS_AUTHENTIK_CALLBACK_URL"
else
  CALLBACK_PORT="$(python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
  CALLBACK_URL="http://127.0.0.1:${CALLBACK_PORT}/api/oauth/callback"
fi

if [ ! -d "$ROOT_DIR/node_modules/playwright" ]; then
  fail "Playwright is not installed in node_modules; run yarn install before this smoke"
fi

mkdir -p "$WORK_DIR" "$ARTIFACT_DIR"

cat >"$COMPOSE_FILE" <<YAML
services:
  postgresql:
    image: docker.io/library/postgres:16-alpine
    environment:
      POSTGRES_DB: authentik
      POSTGRES_USER: authentik
      POSTGRES_PASSWORD: myoxus_authentik_pg_test
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -d authentik -U authentik"]
      interval: 5s
      timeout: 5s
      retries: 20
  redis:
    image: docker.io/library/redis:8-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 20
  server:
    image: ${AUTHENTIK_IMAGE}
    command: server
    environment:
      AUTHENTIK_SECRET_KEY: myoxus-authentik-secret-key-test-only-20260624
      AUTHENTIK_REDIS__HOST: redis
      AUTHENTIK_POSTGRESQL__HOST: postgresql
      AUTHENTIK_POSTGRESQL__USER: authentik
      AUTHENTIK_POSTGRESQL__NAME: authentik
      AUTHENTIK_POSTGRESQL__PASSWORD: myoxus_authentik_pg_test
      AUTHENTIK_BOOTSTRAP_PASSWORD: ${AUTHENTIK_PASSWORD}
      AUTHENTIK_BOOTSTRAP_TOKEN: ${AUTHENTIK_TOKEN}
      AUTHENTIK_BOOTSTRAP_EMAIL: admin@example.test
    ports:
      - "19000:9000"
    depends_on:
      postgresql:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "ak healthcheck || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 30
  worker:
    image: ${AUTHENTIK_IMAGE}
    command: worker
    environment:
      AUTHENTIK_SECRET_KEY: myoxus-authentik-secret-key-test-only-20260624
      AUTHENTIK_REDIS__HOST: redis
      AUTHENTIK_POSTGRESQL__HOST: postgresql
      AUTHENTIK_POSTGRESQL__USER: authentik
      AUTHENTIK_POSTGRESQL__NAME: authentik
      AUTHENTIK_POSTGRESQL__PASSWORD: myoxus_authentik_pg_test
    depends_on:
      postgresql:
        condition: service_healthy
      redis:
        condition: service_healthy
YAML

echo "=== Myoxus Authentik Container OIDC Smoke ==="
echo "Fixture: $FIXTURE"
echo "Artifacts: $ARTIFACT_DIR"
echo ""

echo "1. Start isolated Authentik stack"
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" pull --quiet
docker compose -f "$COMPOSE_FILE" up -d
for _ in $(seq 1 90); do
  if curl -fsS "$AUTHENTIK_BASE_URL/-/health/live/" >/dev/null 2>&1; then
    pass "Authentik live health endpoint is ready"
    break
  fi
  sleep 2
done
curl -fsS "$AUTHENTIK_BASE_URL/-/health/live/" >/dev/null || {
  docker compose -f "$COMPOSE_FILE" logs --tail=120 server >&2 || true
  fail "Authentik did not become ready"
}
for _ in $(seq 1 90); do
  if curl -fsS -H "Authorization: Bearer $AUTHENTIK_TOKEN" "$AUTHENTIK_BASE_URL/api/v3/core/users/me/" >/dev/null 2>&1; then
    pass "Authentik bootstrap token is ready"
    break
  fi
  sleep 2
done
curl -fsS -H "Authorization: Bearer $AUTHENTIK_TOKEN" "$AUTHENTIK_BASE_URL/api/v3/core/users/me/" >/dev/null || {
  docker compose -f "$COMPOSE_FILE" logs --tail=160 server >&2 || true
  fail "Authentik bootstrap token did not become usable"
}
echo ""

echo "2. Bootstrap Authentik fixture"
python3 - "$FIXTURE" "$AUTHENTIK_BASE_URL" "$AUTHENTIK_TOKEN" "$CALLBACK_URL" "$TEST_USER_PASSWORD" "$BOOTSTRAP_JSON" <<'PY'
import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

fixture_path, base_url, token, callback_url, user_password, output_path = sys.argv[1:]
with open(fixture_path, "r", encoding="utf-8") as handle:
    fixture = json.load(handle)

headers = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json",
}

def request(method, path, payload=None, query=None, expect=(200, 201, 204)):
    url = f"{base_url}/api/v3{path}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query, doseq=True)}"
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    for attempt in range(30):
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                body = response.read()
                if response.status not in expect:
                    raise RuntimeError(f"{method} {path} returned {response.status}: {body[:400]!r}")
                if not body:
                    return None
                return json.loads(body.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            if exc.code not in (502, 503, 504) or attempt == 29:
                raise RuntimeError(f"{method} {path} returned {exc.code}: {body[:800]}") from exc
            time.sleep(2)
        except urllib.error.URLError:
            if attempt == 29:
                raise
            time.sleep(2)

def find_flow(slug):
    for _ in range(60):
        data = request("GET", "/flows/instances/", query={"search": slug, "page_size": 20})
        for item in data["results"]:
            if item["slug"] == slug:
                return item["pk"]
        time.sleep(2)
    raise RuntimeError(f"flow not found: {slug}")

def find_mapping(managed):
    for _ in range(60):
        data = request("GET", "/propertymappings/all/", query={"page_size": 100})
        for item in data["results"]:
            if item.get("managed") == managed:
                return item["pk"]
        time.sleep(2)
    raise RuntimeError(f"property mapping not found: {managed}")

authorization_flow = find_flow("default-provider-authorization-implicit-consent")
invalidation_flow = find_flow("default-provider-invalidation-flow")
property_mappings = [
    find_mapping("goauthentik.io/providers/oauth2/scope-openid"),
    find_mapping("goauthentik.io/providers/oauth2/scope-profile"),
    find_mapping("goauthentik.io/providers/oauth2/scope-email"),
]

group_ids = {}
for group in fixture["groups"]:
    created = request("POST", "/core/groups/", {
        "name": group["name"],
        "is_superuser": False,
        "attributes": {"myoxusOidcSmoke": True},
    })
    group_ids[group["name"]] = created["pk"]

users = {}
for user in fixture["users"]:
    created = request("POST", "/core/users/", {
        "username": user["username"],
        "name": user["username"].replace("-", " ").title(),
        "email": user["email"],
        "is_active": True,
        "attributes": {"myoxusOidcSmoke": True},
    })
    users[user["username"]] = {
        "pk": created["pk"],
        "email": user["email"],
        "expectedGroups": user.get("groups") or [],
        "expectedDenied": bool(user.get("expectedDenied")),
    }
    request("POST", f"/core/users/{created['pk']}/set_password/", {"password": user_password}, expect=(204,))
    for group_name in user.get("groups") or []:
        request("POST", f"/core/groups/{group_ids[group_name]}/add_user/", {"pk": created["pk"]}, expect=(204,))

client_id = "myoxus-authentik-smoke-client"
client_secret = "myoxus-authentik-smoke-secret"
provider = request("POST", "/providers/oauth2/", {
    "name": "myoxus-authentik-smoke-provider",
    "authorization_flow": authorization_flow,
    "invalidation_flow": invalidation_flow,
    "property_mappings": property_mappings,
    "client_type": "confidential",
    "client_id": client_id,
    "client_secret": client_secret,
    "grant_types": ["authorization_code"],
    "include_claims_in_id_token": True,
    "redirect_uris": [{
        "matching_mode": "strict",
        "url": callback_url,
        "redirect_uri_type": "authorization",
    }],
    "sub_mode": "user_uuid",
    "issuer_mode": "per_provider",
    "access_code_validity": "minutes=5",
    "access_token_validity": "minutes=30",
    "refresh_token_validity": "days=1",
    "refresh_token_threshold": "minutes=30",
})
request("POST", "/core/applications/", {
    "name": "Myoxus Authentik Smoke",
    "slug": "myoxus-authentik-smoke",
    "provider": provider["pk"],
    "meta_launch_url": callback_url.rsplit("/api/oauth/callback", 1)[0],
    "policy_engine_mode": "any",
    "meta_hide": True,
})

representative = next(user for user in fixture["users"] if user.get("groups"))
result = {
    "baseUrl": base_url,
    "clientId": client_id,
    "clientSecret": client_secret,
    "callbackUrl": callback_url,
    "applicationSlug": "myoxus-authentik-smoke",
    "providerInfoUrl": f"{base_url}/application/o/myoxus-authentik-smoke/.well-known/openid-configuration",
    "authorizeUrl": f"{base_url}/application/o/authorize/",
    "tokenUrl": f"{base_url}/application/o/token/",
    "userinfoUrl": f"{base_url}/application/o/userinfo/",
    "representativeUsername": representative["username"],
    "representativePassword": user_password,
    "representativeExpectedGroups": representative.get("groups") or [],
    "counts": {
        "users": len(fixture["users"]),
        "groups": len(fixture["groups"]),
        "mappedGroups": len([group for group in fixture["groups"] if group.get("mapped")]),
    },
}
with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(result, handle, indent=2, sort_keys=True)
print(json.dumps({
    "users": result["counts"]["users"],
    "groups": result["counts"]["groups"],
    "representativeUsername": result["representativeUsername"],
    "representativeExpectedGroups": result["representativeExpectedGroups"],
}))
PY
pass "bootstrapped 50 users, 10 groups, OAuth2 provider, and application"
echo ""

echo "3. OIDC discovery"
DISCOVERY_JSON="$(curl -fsS "$(jq -r .providerInfoUrl "$BOOTSTRAP_JSON")")"
DISCOVERY_JSON="$DISCOVERY_JSON" python3 - <<'PY'
import json
import os
import sys
data = json.loads(os.environ["DISCOVERY_JSON"])
for key in ("issuer", "authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri"):
    value = data.get(key)
    assert isinstance(value, str) and value, f"missing discovery field: {key}"
assert "/application/o/authorize/" in data["authorization_endpoint"]
assert "/application/o/token/" in data["token_endpoint"]
assert "/application/o/userinfo/" in data["userinfo_endpoint"]
print("discovery-ok")
PY
pass "live Authentik discovery exposes the OIDC endpoints"
echo ""

echo "4. Browser authorization-code login and groups claim"
cat >"$WORK_DIR/live-login.js" <<'JS'
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');

const baseUrl = process.env.AUTHENTIK_BASE_URL;
const clientId = process.env.AUTHENTIK_CLIENT_ID;
const clientSecret = process.env.AUTHENTIK_CLIENT_SECRET;
const callbackUrl = process.env.AUTHENTIK_CALLBACK_URL;
const username = process.env.AUTHENTIK_USERNAME;
const password = process.env.AUTHENTIK_PASSWORD;
const expectedGroups = JSON.parse(process.env.AUTHENTIK_EXPECTED_GROUPS);
const artifactDir = process.env.AUTHENTIK_ARTIFACT_DIR;

function redactUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.searchParams.has('code')) url.searchParams.set('code', '<redacted>');
  return url.toString();
}

async function waitForCallback(timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, callbackUrl);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      clearTimeout(timer);
      server.close();
      resolve(Object.fromEntries(url.searchParams.entries()));
    });
    server.on('error', reject);
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`callback was not received within ${timeoutMs}ms`));
    }, timeoutMs);
    server.listen(new URL(callbackUrl).port, new URL(callbackUrl).hostname);
  });
}

(async () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  let browser;
  let page;
  try {
  const callbackPromise = waitForCallback().catch((error) => error);
  const state = `state-${Date.now()}`;
  const nonce = `nonce-${Date.now()}`;
  const authorizeUrl = new URL('/application/o/authorize/', baseUrl);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'openid profile email');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('nonce', nonce);

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(authorizeUrl.toString(), { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="uidField"]').fill(username);
  await page.keyboard.press('Enter');
  await page.locator('input[name="password"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('input[name="password"]').fill(password);
  await page.keyboard.press('Enter');
  const continueButton = page.locator('button:has-text("Continue")').first();
  await continueButton.waitFor({ state: 'visible', timeout: 45000 });
  await continueButton.click();
  await page.waitForTimeout(500);
  const authorizeButton = page.locator('button:has-text("Authorize"), button:has-text("Allow")').first();
  if (await authorizeButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await authorizeButton.click();
  }
  const callback = await callbackPromise;
  if (callback instanceof Error) {
    throw callback;
  }
  await page.screenshot({ path: `${artifactDir}/authentik-callback.png`, fullPage: true });
  await browser.close();

  if (!callback.code || callback.state !== state) {
    throw new Error(`invalid callback: ${JSON.stringify({ hasCode: Boolean(callback.code), state: callback.state })}`);
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenResponse = await fetch(new URL('/application/o/token/', baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: callbackUrl,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }
  const token = await tokenResponse.json();
  const userinfoResponse = await fetch(new URL('/application/o/userinfo/', baseUrl), {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!userinfoResponse.ok) {
    throw new Error(`userinfo failed: ${userinfoResponse.status} ${await userinfoResponse.text()}`);
  }
  const userinfo = await userinfoResponse.json();
  const actualGroups = Array.isArray(userinfo.groups) ? userinfo.groups : [];
  for (const group of expectedGroups) {
    if (!actualGroups.includes(group)) {
      throw new Error(`missing group claim ${group}; actual=${JSON.stringify(actualGroups)}`);
    }
  }
  fs.writeFileSync(`${artifactDir}/live-login-summary.json`, JSON.stringify({
    callbackUrl: redactUrl(`${callbackUrl}?${new URLSearchParams(callback).toString()}`),
    username,
    email: userinfo.email,
    expectedGroups,
    actualGroups,
    hasAccessToken: typeof token.access_token === 'string',
    hasIdToken: typeof token.id_token === 'string',
  }, null, 2));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: `${artifactDir}/authentik-login-failure.png`, fullPage: true }).catch(() => {});
      const body = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
      fs.writeFileSync(`${artifactDir}/live-login-failure.json`, JSON.stringify({
        message: error.message,
        url: page.url(),
        body: body.slice(0, 2000),
      }, null, 2));
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    throw error;
  }
})();
JS

AUTHENTIK_BASE_URL="$(jq -r .baseUrl "$BOOTSTRAP_JSON")" \
AUTHENTIK_CLIENT_ID="$(jq -r .clientId "$BOOTSTRAP_JSON")" \
AUTHENTIK_CLIENT_SECRET="$(jq -r .clientSecret "$BOOTSTRAP_JSON")" \
AUTHENTIK_CALLBACK_URL="$(jq -r .callbackUrl "$BOOTSTRAP_JSON")" \
AUTHENTIK_USERNAME="$(jq -r .representativeUsername "$BOOTSTRAP_JSON")" \
AUTHENTIK_PASSWORD="$(jq -r .representativePassword "$BOOTSTRAP_JSON")" \
AUTHENTIK_EXPECTED_GROUPS="$(jq -c .representativeExpectedGroups "$BOOTSTRAP_JSON")" \
AUTHENTIK_ARTIFACT_DIR="$ARTIFACT_DIR" \
NODE_PATH="$ROOT_DIR/node_modules" \
node "$WORK_DIR/live-login.js"

test -f "$LOGIN_SUMMARY" || fail "missing browser login summary"
jq '{username,email,expectedGroups,actualGroups,hasAccessToken,hasIdToken,callbackUrl}' "$LOGIN_SUMMARY"
pass "browser login returned an authorization code and userinfo groups claim"
echo ""

rm -f "$WORK_DIR/live-login.js" "$BOOTSTRAP_JSON"
echo "=== Authentik Container OIDC Smoke: PASS ==="
