#!/bin/sh
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu

# Release assets remain read-only. Only the generated runtime config is replaced.
validate_timeout() {
  name="$1"
  value="$2"
  case "$value" in
    ''|*[!0-9]*) echo "$name must be positive integral seconds" >&2; exit 1 ;;
  esac
  value="$(printf '%s' "$value" | sed 's/^0*//')"
  # Shipped 64-bit Nginx parses milliseconds into a signed machine integer.
  if [ -z "$value" ] || ! awk -v value="$value" 'BEGIN {
    limit="9223372036854775";
    exit !(length(value)<length(limit) || (length(value)==length(limit) && "x" value <= "x" limit))
  }'; then
    echo "$name is zero or exceeds the Nginx millisecond timer limit" >&2
    exit 1
  fi
  printf '%s' "$value"
}
READ_TIMEOUT="$(validate_timeout MYOXUS_SOCKET_IO_PROXY_READ_TIMEOUT_SECONDS "${MYOXUS_SOCKET_IO_PROXY_READ_TIMEOUT_SECONDS-300}")"
SEND_TIMEOUT="$(validate_timeout MYOXUS_SOCKET_IO_PROXY_SEND_TIMEOUT_SECONDS "${MYOXUS_SOCKET_IO_PROXY_SEND_TIMEOUT_SECONDS-300}")"
RUNTIME_CONFIG="/etc/nginx/conf.d/default.conf"
CANDIDATE="${RUNTIME_CONFIG}.tmp.$$"
trap 'rm -f "$CANDIDATE"' EXIT HUP INT TERM
# Substitute only these deployment inputs; Nginx $variables are preserved.
sed -e "s/@MYOXUS_SOCKET_IO_PROXY_READ_TIMEOUT_SECONDS@/$READ_TIMEOUT/g" \
    -e "s/@MYOXUS_SOCKET_IO_PROXY_SEND_TIMEOUT_SECONDS@/$SEND_TIMEOUT/g" \
    /etc/nginx/myoxus.conf.template > "$CANDIDATE"
mv "$CANDIDATE" "$RUNTIME_CONFIG"

OUT_FILE="/etc/nginx/basepath-extra.conf"
BASE_PATH="${MYOXUS_FRONTEND_BASE_PATH:-}"

: > "$OUT_FILE"

if [ -z "$BASE_PATH" ] || [ "$BASE_PATH" = "/" ]; then
  exit 0
fi

# /adminfrontend is already a first-class route at the frontend root. Rendering a
# duplicate basepath block for it would create ambiguous admin locations.
if [ "$BASE_PATH" = "/adminfrontend" ]; then
  exit 0
fi

case "$BASE_PATH" in
  /*) ;;
  *)
    echo "MYOXUS_FRONTEND_BASE_PATH must start with '/'" >&2
    exit 1
    ;;
esac

BASE_PATH="${BASE_PATH%/}"

cat > "$OUT_FILE" <<EOC
# generated Myoxus frontend basepath config for ${BASE_PATH}
location = ${BASE_PATH} {
  return 302 ${BASE_PATH}/;
}

location = ${BASE_PATH}/admin {
  return 302 ${BASE_PATH}/adminfrontend/;
}

location = ${BASE_PATH}/admin/index.html {
  return 302 ${BASE_PATH}/adminfrontend/;
}

location = ${BASE_PATH}/adminfrontend {
  return 302 ${BASE_PATH}/adminfrontend/;
}

location = ${BASE_PATH}/adminfrontend/index.html {
  return 302 ${BASE_PATH}/adminfrontend/;
}

location = ${BASE_PATH}/adminfrontend/accounts {
  return 308 ${BASE_PATH}/adminfrontend/organization?tab=members;
}

location = ${BASE_PATH}/adminfrontend/about {
  return 308 ${BASE_PATH}/adminfrontend/system;
}

location = ${BASE_PATH}/adminfrontend/orphaned-workspaces {
  return 308 ${BASE_PATH}/adminfrontend/storage?tab=orphaned;
}

location = ${BASE_PATH}/adminfrontend/logging {
  return 308 ${BASE_PATH}/adminfrontend/system?tab=logging;
}

location ~* ^${BASE_PATH}/(billing|pricing|upgrade|subscription|subscriptions|seat|seats|license|licenses|checkout|portal)(/|$) {
  return 302 ${BASE_PATH}/;
}

location ~* ^${BASE_PATH}/admin/(billing|pricing|upgrade|subscription|subscriptions|seat|seats|license|licenses|checkout|portal)(/|$) {
  return 302 ${BASE_PATH}/adminfrontend/;
}

location ~* ^${BASE_PATH}/adminfrontend/(billing|pricing|upgrade|subscription|subscriptions|seat|seats|license|licenses|checkout|portal)(/|$) {
  return 302 ${BASE_PATH}/adminfrontend/;
}

location = ${BASE_PATH}/health {
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  add_header Content-Type text/plain;
  return 200 "ok";
}

location = ${BASE_PATH}/ready {
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  add_header Cache-Control "no-store" always;
  rewrite ^${BASE_PATH}/ready$ /ready break;
  proxy_pass http://myoxus_api;
  proxy_http_version 1.1;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Request-ID \$request_id;
}

location = ${BASE_PATH}/graphql {
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  rewrite ^${BASE_PATH}/graphql$ /graphql break;
  proxy_pass http://myoxus_api;
  proxy_http_version 1.1;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Request-ID \$request_id;
}

location = ${BASE_PATH}/mcp {
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  rewrite ^${BASE_PATH}/mcp$ /mcp break;
  proxy_pass http://myoxus_api;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_request_buffering off;
  proxy_cache off;
  proxy_read_timeout 300s;
  proxy_send_timeout 300s;
  proxy_set_header Host \$host;
  proxy_set_header Authorization \$http_authorization;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Request-ID \$request_id;
}

location = ${BASE_PATH}/info {
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  rewrite ^${BASE_PATH}/info$ /info break;
  proxy_pass http://myoxus_api;
  proxy_http_version 1.1;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Request-ID \$request_id;
}

location ^~ ${BASE_PATH}/api/fonts/ {
  root /usr/share/nginx/frontends;
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  add_header Cache-Control "public, max-age=31536000, immutable";
  rewrite ^${BASE_PATH}/api/fonts/(.*)$ /api/fonts/\$1 break;
  try_files \$uri =404;
}

location ${BASE_PATH}/api/copilot/ {
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  rewrite ^${BASE_PATH}/api/copilot/(.*)$ /api/copilot/\$1 break;
  proxy_pass http://myoxus_api;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 300s;
  proxy_send_timeout 300s;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Request-ID \$request_id;
}

location ${BASE_PATH}/api/ {
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  rewrite ^${BASE_PATH}/api/(.*)$ /api/\$1 break;
  proxy_pass http://myoxus_api;
  proxy_http_version 1.1;
  proxy_read_timeout 120s;
  proxy_send_timeout 120s;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Request-ID \$request_id;
}

location ^~ ${BASE_PATH}/public/ {
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  rewrite ^${BASE_PATH}/public/(.*)$ /public/\$1 break;
  proxy_pass http://myoxus_api;
  proxy_http_version 1.1;
  proxy_read_timeout 120s;
  proxy_send_timeout 120s;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Request-ID \$request_id;
}

location ^~ ${BASE_PATH}/public-assets/ {
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  rewrite ^${BASE_PATH}/public-assets/(.*)$ /public-assets/\$1 break;
  proxy_pass http://myoxus_api;
  proxy_http_version 1.1;
  proxy_read_timeout 120s;
  proxy_send_timeout 120s;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Request-ID \$request_id;
}

location ^~ ${BASE_PATH}/share/ {
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  rewrite ^${BASE_PATH}/share/(.*)$ /share/\$1 break;
  proxy_pass http://myoxus_api;
  proxy_http_version 1.1;
  proxy_read_timeout 120s;
  proxy_send_timeout 120s;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Request-ID \$request_id;
}

location = ${BASE_PATH}/socket.io {
  return 301 ${BASE_PATH}/socket.io/\$is_args\$args;
}

location ${BASE_PATH}/socket.io/ {
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  rewrite ^${BASE_PATH}/socket.io/(.*)$ /socket.io/\$1 break;
  proxy_pass http://myoxus_api;
  proxy_http_version 1.1;
  proxy_read_timeout ${READ_TIMEOUT}s;
  proxy_send_timeout ${SEND_TIMEOUT}s;
  proxy_set_header Upgrade \$http_upgrade;
  proxy_set_header Connection \$connection_upgrade;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Request-ID \$request_id;
}

location = ${BASE_PATH}/style/logo.svg {
  alias /usr/share/nginx/frontends/canonical-style/logo.svg;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Cache-Control "public, max-age=300";
}

location = ${BASE_PATH}/style/product-mark.svg {
  alias /usr/share/nginx/frontends/canonical-style/product-mark.svg;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Cache-Control "public, max-age=300";
}

location ${BASE_PATH}/style/ {
  root /usr/share/nginx/frontends;
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  add_header Cache-Control "public, max-age=300";
  rewrite ^${BASE_PATH}/style/(.*)$ /style/\$1 break;
  try_files \$uri =404;
}

location ${BASE_PATH}/qa/ {
  root /usr/share/nginx;
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  add_header Cache-Control "no-store";
  rewrite ^${BASE_PATH}/qa/(.*)$ /qa/\$1 break;
  try_files \$uri =404;
}

location ${BASE_PATH}/admin/ {
  rewrite ^${BASE_PATH}/admin/(.*)$ ${BASE_PATH}/adminfrontend/\$1 permanent;
}

location = ${BASE_PATH}/adminfrontend/ {
  root /usr/share/nginx/frontends/admin;
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  add_header Cache-Control "no-store";
  try_files /selfhost.html =404;
}

location ${BASE_PATH}/adminfrontend/ {
  gzip on;

  location ~* \.(?:avif|br|cjs|css|gif|gz|html|ico|jpe?g|js|json|map|mjs|mp4|otf|pdf|png|svg|ttf|txt|wasm|webmanifest|webm|webp|woff2?|xml|zip)\$ {
    rewrite ^${BASE_PATH}/adminfrontend/(.*)\$ /\$1 break;
    root /usr/share/nginx/frontends/admin;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Cache-Control "no-store";
    try_files \$uri =404;
  }

  rewrite ^${BASE_PATH}/adminfrontend/(.*)$ /\$1 break;
  root /usr/share/nginx/frontends/admin;
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  add_header Cache-Control "no-store";
  try_files \$uri @myoxus_admin_spa;
}

location ~ ^${BASE_PATH}/workspace/.+ {
  add_header Set-Cookie "myoxus_redirect=\$request_uri; Path=${BASE_PATH}/; Max-Age=300; SameSite=Lax" always;
  return 302 ${BASE_PATH}/;
}

location ${BASE_PATH}/ {
  gzip on;

  location ~* \.(?:avif|br|cjs|css|gif|gz|html|ico|jpe?g|js|json|map|mjs|mp4|otf|pdf|png|svg|ttf|txt|wasm|webmanifest|webm|webp|woff2?|xml|zip)\$ {
    rewrite ^${BASE_PATH}/(.*)\$ /\$1 break;
    root /usr/share/nginx/frontends/web;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Cache-Control "no-store";
    try_files \$uri =404;
  }

  rewrite ^${BASE_PATH}/(.*)$ /\$1 break;
  root /usr/share/nginx/frontends/web;
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  add_header Cache-Control "no-store";
  try_files \$uri \$uri/ @myoxus_web_spa;
}
EOC
