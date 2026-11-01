#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Focused runtime contract for the one operator-owned Nginx. Web and Admin are
# plain files; only API traffic has an upstream service.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
NGINX_IMAGE="${MYOXUS_NGINX_TEST_IMAGE:-nginx:stable-alpine}"
TMP_DIR="$(mktemp -d)"
NETWORK="myoxus-nginx-topology-$$"
API="myoxus-nginx-api-$$"
FRONTEND="myoxus-nginx-frontend-$$"
BASEPATH_FRONTEND="myoxus-nginx-basepath-$$"
INVALID_FRONTEND="myoxus-nginx-invalid-$$"

cleanup() {
  docker rm -f "$FRONTEND" "$BASEPATH_FRONTEND" "$INVALID_FRONTEND" "$API" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p \
  "$TMP_DIR/frontends/web/assets" \
  "$TMP_DIR/frontends/admin/assets" \
  "$TMP_DIR/frontends/api/fonts" \
  "$TMP_DIR/frontends/style" \
  "$TMP_DIR/frontends/canonical-style" \
  "$TMP_DIR/qa"
printf '<html>web-shell</html>\n' >"$TMP_DIR/frontends/web/selfhost.html"
printf 'web-asset\n' >"$TMP_DIR/frontends/web/assets/web.js"
printf 'web-style\n' >"$TMP_DIR/frontends/web/assets/web.css"
printf '<html>admin-shell</html>\n' >"$TMP_DIR/frontends/admin/selfhost.html"
printf 'admin-asset\n' >"$TMP_DIR/frontends/admin/assets/admin.js"
printf 'admin-style\n' >"$TMP_DIR/frontends/admin/assets/admin.css"
printf 'export const worker = true;\n' >"$TMP_DIR/frontends/admin/assets/pdf.worker.mjs"
printf 'font\n' >"$TMP_DIR/frontends/api/fonts/sample.woff2"
printf ':root { --myoxus-test: 1; }\n' >"$TMP_DIR/frontends/style/theme-fallback.css"
printf '<svg/>\n' >"$TMP_DIR/frontends/canonical-style/logo.svg"
printf '<svg/>\n' >"$TMP_DIR/frontends/canonical-style/product-mark.svg"
printf 'qa-artifact\n' >"$TMP_DIR/qa/probe.txt"

default_heartbeat="$(node --input-type=module - "$ROOT_DIR/server/config/default.yaml" <<'JS'
import {readFileSync} from 'node:fs';
const yaml=readFileSync(process.argv[2],'utf8');
const seconds=(key)=>Number(yaml.match(new RegExp(`^  ${key}: ([0-9]+)$`,'m'))?.[1]);
const interval=seconds('eio_ping_interval_seconds');
const timeout=seconds('eio_ping_timeout_seconds');
if(!Number.isSafeInteger(interval)||interval<=0||!Number.isSafeInteger(timeout)||timeout<=0) throw new Error('server heartbeat fixture');
console.log(JSON.stringify({sid:'owned-topology',upgrades:['websocket'],pingInterval:interval*1000,pingTimeout:timeout*1000}));
JS
)"
cat >"$TMP_DIR/api.conf" <<'EOF'
server {
  listen 3001;
  location /socket.io/ {
    if ($http_upgrade = websocket) { return 200 "upgrade:$http_upgrade:$http_connection:$request_uri"; }
    return 200 '0@HEARTBEAT@';
  }
  location / {
    add_header Content-Type text/plain;
    return 200 "api:$request_uri";
  }
}
EOF

sed -i "s|@HEARTBEAT@|$default_heartbeat|" "$TMP_DIR/api.conf"

docker network create "$NETWORK" >/dev/null
docker run -d --name "$API" --network "$NETWORK" --network-alias api \
  -v "$TMP_DIR/api.conf:/etc/nginx/conf.d/default.conf:ro" \
  "$NGINX_IMAGE" >/dev/null

start_frontend() {
  local name="$1"
  local base_path="$2"
  shift 2
  docker run -d --name "$name" --network "$NETWORK" \
    -p 127.0.0.1::3010 \
    -e "MYOXUS_FRONTEND_BASE_PATH=$base_path" \
    -v "$TMP_DIR/frontends:/usr/share/nginx/frontends:ro" \
    -v "$TMP_DIR/qa:/usr/share/nginx/qa:ro" \
    -v "$ROOT_DIR/client/frontends/nginx/myoxus.conf:/etc/nginx/myoxus.conf.template:ro" \
    -v "$ROOT_DIR/build/scripts/frontends/render-basepath-nginx.sh:/docker-entrypoint.d/40-render-basepath-nginx.sh:ro" \
    "$@" "$NGINX_IMAGE" >/dev/null
}

wait_url() {
  local url="$1"
  for _ in $(seq 1 30); do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

container_url() {
  local name="$1"
  local port
  port="$(docker port "$name" 3010/tcp | awk -F: 'NR == 1 {print $NF}')"
  printf 'http://127.0.0.1:%s' "$port"
}

assert_body() {
  local expected="$1"
  local url="$2"
  local actual
  actual="$(curl -fsS "$url")"
  [ "$actual" = "$expected" ] || {
    echo "[FAIL] $url returned '$actual', expected '$expected'" >&2
    exit 1
  }
}

assert_status() {
  local expected="$1"
  local url="$2"
  local actual
  actual="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$url")"
  [ "$actual" = "$expected" ] || {
    echo "[FAIL] $url returned HTTP $actual, expected $expected" >&2
    exit 1
  }
}

assert_content_type() {
  local expected="$1"
  local url="$2"
  local actual
  actual="$(curl -fsS -o /dev/null -w '%{content_type}' "$url")"
  [ "${actual%%;*}" = "$expected" ] || {
    echo "[FAIL] $url returned Content-Type '$actual', expected '$expected'" >&2
    exit 1
  }
}

assert_socket_budget() {
  local name="$1" url="$2" base_path="$3" read="$4" send="$5"
  docker exec "$name" nginx -T >"$TMP_DIR/loaded.conf" 2>"$TMP_DIR/nginx-test.log"
  curl -fsS "$url$base_path/socket.io/?EIO=4&transport=polling" >"$TMP_DIR/heartbeat.json"
  node --input-type=module - "$TMP_DIR/loaded.conf" "$TMP_DIR/heartbeat.json" "$base_path" "$read" "$send" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const [configFile,heartbeatFile,base,expectedRead,expectedSend]=process.argv.slice(2);
const config=readFileSync(configFile,'utf8');
const handshake=JSON.parse(readFileSync(heartbeatFile,'utf8').slice(1));
const sum=(handshake.pingInterval+handshake.pingTimeout)/1000;
function loadedBudget(route){
 const begin=config.indexOf(`location ${route}/socket.io/ {`);
 assert(begin>=0,'actual Socket.IO location');
 const block=config.slice(begin,config.indexOf('}',begin));
 return {read:Number(block.match(/proxy_read_timeout ([0-9]+)s;/)?.[1]),
 send:Number(block.match(/proxy_send_timeout ([0-9]+)s;/)?.[1])};
}
function assertCoverage(budget){assert(budget.read>sum,'read timeout must exceed tested heartbeat sum');assert(budget.send>sum,'send timeout must exceed tested heartbeat sum');}
for(const route of new Set(['',base])){
 const budget=loadedBudget(route);
 assert.equal(budget.read,Number(expectedRead));assert.equal(budget.send,Number(expectedSend));assertCoverage(budget);
}
JS
  local upstream_headers
  upstream_headers="$(curl -fsS -H 'Upgrade: websocket' -H 'Connection: Upgrade' "$url$base_path/socket.io/?EIO=4&transport=websocket")"
  [ "$upstream_headers" = 'upgrade:websocket:upgrade:/socket.io/?EIO=4&transport=websocket' ] || {
    echo '[FAIL] Socket.IO upgrade headers or query forwarding' >&2; exit 1;
  }
}

start_frontend "$FRONTEND" ""
FRONTEND_URL="$(container_url "$FRONTEND")"
wait_url "$FRONTEND_URL/health" || {
  docker logs "$FRONTEND" >&2
  exit 1
}

assert_body "ok" "$FRONTEND_URL/health"
assert_socket_budget "$FRONTEND" "$FRONTEND_URL" "" 300 300
assert_body "<html>web-shell</html>" "$FRONTEND_URL/"
assert_body "<html>web-shell</html>" "$FRONTEND_URL/settings/profile"
assert_body "web-asset" "$FRONTEND_URL/assets/web.js"
assert_body "web-style" "$FRONTEND_URL/assets/web.css"
assert_body "<html>admin-shell</html>" "$FRONTEND_URL/adminfrontend/"
assert_body "<html>admin-shell</html>" "$FRONTEND_URL/adminfrontend/organization"
assert_body "admin-asset" "$FRONTEND_URL/adminfrontend/assets/admin.js"
assert_body "admin-style" "$FRONTEND_URL/adminfrontend/assets/admin.css"
assert_content_type "application/javascript" "$FRONTEND_URL/adminfrontend/assets/pdf.worker.mjs"
assert_content_type "text/css" "$FRONTEND_URL/adminfrontend/assets/admin.css"
assert_status 404 "$FRONTEND_URL/assets/missing.js"
assert_status 404 "$FRONTEND_URL/assets/missing.css"
assert_status 404 "$FRONTEND_URL/assets/web.js.map"
assert_status 404 "$FRONTEND_URL/adminfrontend/assets/missing.js"
assert_status 404 "$FRONTEND_URL/adminfrontend/assets/missing.css"
assert_status 404 "$FRONTEND_URL/adminfrontend/assets/admin.js.map"
assert_body "font" "$FRONTEND_URL/api/fonts/sample.woff2"
assert_body ":root { --myoxus-test: 1; }" "$FRONTEND_URL/style/theme-fallback.css"
assert_body "qa-artifact" "$FRONTEND_URL/qa/probe.txt"
assert_body "api:/graphql" "$FRONTEND_URL/graphql"
assert_body "api:/mcp" "$FRONTEND_URL/mcp"

# The fixture's duplicate Content-Type deliberately produces an upstream warning.
# Neither access nor request-error output may copy its URL or Referer credentials.
assert_body "<html>web-shell</html>" "$FRONTEND_URL/logging-probe?token=QUERY_CREDENTIAL_SENTINEL"
curl -fsS -H 'Referer: https://example.test/?token=REFERER_CREDENTIAL_SENTINEL' \
  "$FRONTEND_URL/graphql?token=QUERY_CREDENTIAL_SENTINEL" >"$TMP_DIR/logging-response"
[ "$(cat "$TMP_DIR/logging-response")" = 'api:/graphql?token=QUERY_CREDENTIAL_SENTINEL' ] || {
  echo '[FAIL] logging redaction changed the upstream request' >&2
  exit 1
}
docker logs "$FRONTEND" >"$TMP_DIR/access.log" 2>&1
if grep -Eq 'QUERY_CREDENTIAL_SENTINEL|REFERER_CREDENTIAL_SENTINEL' "$TMP_DIR/access.log"; then
  echo '[FAIL] credentials reached gateway logs' >&2
  grep -E 'QUERY_CREDENTIAL_SENTINEL|REFERER_CREDENTIAL_SENTINEL' "$TMP_DIR/access.log" >&2
  exit 1
fi
grep -Eq '"GET /graphql HTTP/1.1" 200 .*req_id=[a-f0-9]+ .*rt=' "$TMP_DIR/access.log" || {
  echo '[FAIL] gateway request diagnostics are missing' >&2
  exit 1
}
grep -q '"GET /logging-probe HTTP/1.1" 200 ' "$TMP_DIR/access.log" || {
  echo '[FAIL] SPA fallback replaced the original request path in logs' >&2
  exit 1
}

# Reload the same upstream fixture with a non-default 2 s + 3 s heartbeat.
# Keep the bind-mounted inode; atomic host replacement would leave Nginx
# reading the original fixture even after reload.
node --input-type=module - "$TMP_DIR/api.conf" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const path=process.argv[2];
writeFileSync(path,readFileSync(path,'utf8').replace(/"pingInterval":[0-9]+/,'"pingInterval":2000').replace(/"pingTimeout":[0-9]+/,'"pingTimeout":3000'));
JS
docker exec "$API" nginx -s reload
start_frontend "$BASEPATH_FRONTEND" "/myoxus" -e MYOXUS_SOCKET_IO_PROXY_READ_TIMEOUT_SECONDS=8 -e MYOXUS_SOCKET_IO_PROXY_SEND_TIMEOUT_SECONDS=9
BASEPATH_URL="$(container_url "$BASEPATH_FRONTEND")"
wait_url "$BASEPATH_URL/myoxus/health" || {
  docker logs "$BASEPATH_FRONTEND" >&2
  exit 1
}
assert_body "ok" "$BASEPATH_URL/myoxus/health"
assert_socket_budget "$BASEPATH_FRONTEND" "$BASEPATH_URL" "/myoxus" 8 9
assert_body "<html>web-shell</html>" "$BASEPATH_URL/myoxus/"
assert_body "<html>web-shell</html>" "$BASEPATH_URL/myoxus/settings/profile"
assert_body "web-asset" "$BASEPATH_URL/myoxus/assets/web.js"
assert_body "web-style" "$BASEPATH_URL/myoxus/assets/web.css"
assert_body "<html>admin-shell</html>" "$BASEPATH_URL/myoxus/adminfrontend/"
assert_body "<html>admin-shell</html>" "$BASEPATH_URL/myoxus/adminfrontend/organization"
assert_body "admin-asset" "$BASEPATH_URL/myoxus/adminfrontend/assets/admin.js"
assert_body "admin-style" "$BASEPATH_URL/myoxus/adminfrontend/assets/admin.css"
assert_content_type "application/javascript" "$BASEPATH_URL/myoxus/adminfrontend/assets/pdf.worker.mjs"
assert_status 404 "$BASEPATH_URL/myoxus/assets/missing.js"
assert_status 404 "$BASEPATH_URL/myoxus/assets/missing.css"
assert_status 404 "$BASEPATH_URL/myoxus/assets/web.js.map"
assert_status 404 "$BASEPATH_URL/myoxus/adminfrontend/assets/missing.js"
assert_status 404 "$BASEPATH_URL/myoxus/adminfrontend/assets/missing.css"
assert_status 404 "$BASEPATH_URL/myoxus/adminfrontend/assets/admin.js.map"
assert_body "font" "$BASEPATH_URL/myoxus/api/fonts/sample.woff2"
assert_body ":root { --myoxus-test: 1; }" "$BASEPATH_URL/myoxus/style/theme-fallback.css"
assert_body "qa-artifact" "$BASEPATH_URL/myoxus/qa/probe.txt"
assert_body "api:/graphql" "$BASEPATH_URL/myoxus/graphql"
assert_body "api:/mcp" "$BASEPATH_URL/myoxus/mcp"

# Exercise access-log redaction through the real gateway, including Referer.
curl -fsSI -H 'Referer: https://example.test/oauth/callback?state=SSO_REFERER_SENTINEL' \
  "$FRONTEND_URL/health?code=SSO_QUERY_SENTINEL" >/dev/null
for attempt in $(seq 1 20); do
  logs="$(docker logs "$FRONTEND" 2>&1)"
  [[ "$logs" == *'HEAD /health'* ]] && break
  sleep 0.1
done
if [[ "$logs" == *SSO_QUERY_SENTINEL* || "$logs" == *SSO_REFERER_SENTINEL* ]]; then
  echo "[FAIL] gateway access logs exposed SSO query or Referer" >&2
  exit 1
fi
[[ "$logs" == *'HEAD /health HTTP/'* ]] || { echo "[FAIL] access-log probe produced no request evidence" >&2; exit 1; }

# Invalid deployment values must fail startup, not load a hidden fallback.
for name in MYOXUS_SOCKET_IO_PROXY_READ_TIMEOUT_SECONDS MYOXUS_SOCKET_IO_PROXY_SEND_TIMEOUT_SECONDS; do
  for value in '' 0 invalid 9223372036854776; do
    start_frontend "$INVALID_FRONTEND" "" -e "$name=$value"
    for attempt in $(seq 1 30); do
      status="$(docker inspect "$INVALID_FRONTEND" --format '{{.State.Status}}')"
      [ "$status" = exited ] && break
      sleep 0.1
    done
    [ "$status" = exited ] || { echo '[FAIL] invalid timeout did not stop startup' >&2; exit 1; }
    [ "$(docker inspect "$INVALID_FRONTEND" --format '{{.State.ExitCode}}')" != 0 ] || { echo '[FAIL] invalid timeout accepted' >&2; exit 1; }
    docker logs "$INVALID_FRONTEND" 2>&1 | grep -q "$name" || { echo '[FAIL] missing timeout diagnostic' >&2; exit 1; }
    docker rm "$INVALID_FRONTEND" >/dev/null
  done
done

echo "[PASS] one-Nginx static frontend topology"
