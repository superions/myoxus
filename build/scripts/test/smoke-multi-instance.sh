#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Cross-node assertions for the isolated multi-instance harness.
set -euo pipefail

: "${MYOXUS_MI_API1_URL:?missing API 1 URL}"
: "${MYOXUS_MI_API2_URL:?missing API 2 URL}"
: "${MYOXUS_MI_GATEWAY_URL:?missing gateway URL}"
: "${MYOXUS_MI_ADMIN_EMAIL:?missing fixture email}"
: "${MYOXUS_MI_ADMIN_PASSWORD:?missing fixture password}"
: "${MYOXUS_MI_COOKIE_JAR:?missing cookie jar path}"

assert_json() {
  local expression="$1"
  node -e "
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      const value = JSON.parse(input);
      if (!($expression)) process.exit(1);
    });
  "
}

graphql() {
  local base_url="$1"
  local body="$2"
  curl -fsS \
    -X POST "$base_url/graphql" \
    -H "Content-Type: application/json" \
    -b "$MYOXUS_MI_COOKIE_JAR" \
    --data-binary "$body"
}

printf '%s\n' "==> direct node readiness"
curl -fsS "$MYOXUS_MI_API1_URL/ready" >/dev/null
curl -fsS "$MYOXUS_MI_API2_URL/ready" >/dev/null

printf '%s\n' "==> round-robin gateway reaches both nodes"
upstreams="$(
  for _ in 1 2 3 4 5 6 7 8; do
    curl -fsS -D - -o /dev/null -H 'Connection: close' \
      "$MYOXUS_MI_GATEWAY_URL/health" \
      | awk 'BEGIN { IGNORECASE=1 } /^X-Myoxus-Test-Upstream:/ { gsub(/\r/, "", $2); print $2 }'
  done | sort -u
)"
if [ "$(printf '%s\n' "$upstreams" | sed '/^$/d' | wc -l | tr -d ' ')" -ne 2 ]; then
  printf '%s\n' "gateway did not expose exactly two upstreams; observed:" >&2
  printf '%s\n' "$upstreams" | sed '/^$/d' >&2
  exit 1
fi

printf '%s\n' "==> sign-in on node A"
curl -fsS \
  -X POST "$MYOXUS_MI_API1_URL/api/auth/sign-in" \
  -H "Content-Type: application/json" \
  -c "$MYOXUS_MI_COOKIE_JAR" \
  --data-binary "$(node -e 'process.stdout.write(JSON.stringify({email: process.env.MYOXUS_MI_ADMIN_EMAIL, password: process.env.MYOXUS_MI_ADMIN_PASSWORD}))')" \
  | assert_json 'value?.email === process.env.MYOXUS_MI_ADMIN_EMAIL'
test -s "$MYOXUS_MI_COOKIE_JAR"

printf '%s\n' "==> node A session is valid on node B"
graphql "$MYOXUS_MI_API2_URL" \
  '{"query":"query { currentUser { email } }"}' \
  | assert_json '!value.errors && value?.data?.currentUser?.email === process.env.MYOXUS_MI_ADMIN_EMAIL'

printf '%s\n' "==> persistent config mutation on A is visible on B"
sentinel="http://multi-instance-${MYOXUS_MI_RUN_ID}.localhost"
update_body="$(
  MYOXUS_MI_SENTINEL="$sentinel" node -e '
    process.stdout.write(JSON.stringify({
      query: "mutation Update($updates: [UpdateAppConfigInput!]!) { admin { adminUpdateConfig(updates: $updates) { applied } } }",
      variables: {
        updates: [{
          module: "server",
          key: "origin",
          value: process.env.MYOXUS_MI_SENTINEL,
        }],
      },
    }));
  '
)"
graphql "$MYOXUS_MI_API1_URL" "$update_body" \
  | assert_json '!value.errors && value?.data?.admin?.adminUpdateConfig?.applied === true'

query_body='{"query":"query { admin { adminConfigValues { modules { groups { fields { path value } } } } } }"}'
MYOXUS_MI_SENTINEL="$sentinel" graphql "$MYOXUS_MI_API2_URL" "$query_body" \
  | MYOXUS_MI_SENTINEL="$sentinel" assert_json '
      !value.errors &&
      value?.data?.admin?.adminConfigValues?.modules?.some(module =>
        module.groups?.some(group =>
          group.fields?.some(field =>
            field.path === "server.origin" &&
            field.value === process.env.MYOXUS_MI_SENTINEL
          )
        )
      )
    '

printf '%s\n' "multi-instance smoke passed"
