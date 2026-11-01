#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Owns the complete lifecycle of the isolated multi-instance test topology.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/build/server/docker-compose.multi-instance.yml"
RUN_ID="${MYOXUS_MI_RUN_ID_OVERRIDE:-$(
  node -e 'process.stdout.write(`${process.pid}-${require("node:crypto").randomBytes(5).toString("hex")}`)'
)}"
case "$RUN_ID" in
  '' | *[!a-zA-Z0-9_-]*)
    printf '%s\n' "MYOXUS_MI_RUN_ID_OVERRIDE contains unsupported characters" >&2
    exit 2
    ;;
esac
PROJECT="myoxus-mi-$RUN_ID"
FIXTURE_ROOT="$(mktemp -d)"
IMAGE="myoxus-server-mi-test:$RUN_ID"
SUCCESS=0

export MYOXUS_MI_PROJECT="$PROJECT"
export MYOXUS_MI_IMAGE="$IMAGE"
export MYOXUS_MI_POSTGRES_PASSWORD_FILE="$FIXTURE_ROOT/postgres-password"
export MYOXUS_MI_CRYPTO_PRIVATE_KEY_FILE="$FIXTURE_ROOT/crypto-private-key"
export MYOXUS_MI_ADMIN_EMAIL="mi-$RUN_ID@example.test"
export MYOXUS_MI_ADMIN_PASSWORD="$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))'
)"
export MYOXUS_MI_COOKIE_JAR="$FIXTURE_ROOT/cookies"
export MYOXUS_MI_RUN_ID="$RUN_ID"

COMPOSE=(docker compose -p "$PROJECT" -f "$COMPOSE_FILE")

cleanup() {
  local exit_code=$?
  trap - EXIT
  if [ "$exit_code" -ne 0 ] || [ "$SUCCESS" -ne 1 ]; then
    printf '%s\n' "==> bounded multi-instance diagnostics" >&2
    "${COMPOSE[@]}" ps >&2 2>/dev/null || true
    "${COMPOSE[@]}" logs --no-color --tail 200 >&2 2>/dev/null || true
  fi
  "${COMPOSE[@]}" down -v --remove-orphans --timeout 10 >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$FIXTURE_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s\n' "$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
)" >"$MYOXUS_MI_POSTGRES_PASSWORD_FILE"
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' \
  >"$MYOXUS_MI_CRYPTO_PRIVATE_KEY_FILE"
chmod 600 "$MYOXUS_MI_POSTGRES_PASSWORD_FILE" "$MYOXUS_MI_CRYPTO_PRIVATE_KEY_FILE"

revision=localdev
if [ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  revision="$(git -C "$REPO_ROOT" rev-parse HEAD)"
fi
server_version="$(
  node "$REPO_ROOT/build/scripts/release/write-release-identity.mjs" \
    --repo "$REPO_ROOT" \
    --role server \
    --revision "$revision" \
    --print-version
)"

printf '%s\n' "==> validate isolated compose topology"
"${COMPOSE[@]}" config --quiet

printf '%s\n' "==> build one server image for both API nodes"
if [ -n "${MYOXUS_MI_PREBUILT_IMAGE:-}" ]; then
  # Explicit diagnostic reuse avoids rebuilding unchanged runtime inputs.
  # The caller owns revision/input review; the isolated tag is still cleaned up.
  docker image inspect "$MYOXUS_MI_PREBUILT_IMAGE" >/dev/null
  docker tag "$MYOXUS_MI_PREBUILT_IMAGE" "$IMAGE"
else
  docker build \
  --build-arg "CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-8}" \
  --build-arg "GITHUB_SHA=$revision" \
  --build-arg "MYOXUS_SERVER_VERSION=$server_version" \
  --build-arg "SOURCE_DATE_EPOCH=0" \
  -f "$REPO_ROOT/build/server/Dockerfile" \
  -t "$IMAGE" \
  "$REPO_ROOT"
fi

printf '%s\n' "==> start isolated two-node topology"
"${COMPOSE[@]}" up -d --wait --wait-timeout 240
if [ "${MYOXUS_MI_FAIL_AFTER_START:-0}" = "1" ]; then
  printf '%s\n' "intentional multi-instance lifecycle failure" >&2
  exit 42
fi

printf '%s\n' "==> verify XWS durable recovery and post-commit transports on both API nodes"
for service in api-1 api-2; do
  service_logs="$("${COMPOSE[@]}" logs --no-color "$service")"
  if ! grep -Fq "XWS durable queue recovery and Redis post-commit fanout wired" <<<"$service_logs"; then
    printf '%s\n' "$service did not wire XWS durable recovery and post-commit transports" >&2
    exit 1
  fi
done

published_port() {
  local service="$1"
  local container_port="$2"
  local endpoint
  endpoint="$("${COMPOSE[@]}" port "$service" "$container_port" | tail -n 1)"
  endpoint="${endpoint##*:}"
  case "$endpoint" in
    '' | *[!0-9]*)
      printf '%s\n' "invalid published port for $service: $endpoint" >&2
      return 1
      ;;
  esac
  printf '%s' "$endpoint"
}

export MYOXUS_MI_API1_URL="http://127.0.0.1:$(published_port api-1 3001)"
export MYOXUS_MI_API2_URL="http://127.0.0.1:$(published_port api-2 3001)"
export MYOXUS_MI_GATEWAY_URL="http://127.0.0.1:$(published_port gateway 8080)"

printf '%s\n' "==> provision ephemeral administrator"
"${COMPOSE[@]}" run --rm -T --no-deps api-1 \
  myoxus-cli users create --email "$MYOXUS_MI_ADMIN_EMAIL" --name "Multi-instance fixture" \
  >/dev/null
printf '%s\n' "$MYOXUS_MI_ADMIN_PASSWORD" \
  | "${COMPOSE[@]}" run --rm -T --no-deps api-1 \
      myoxus-cli users set-password "$MYOXUS_MI_ADMIN_EMAIL" --password-stdin \
      >/dev/null
"${COMPOSE[@]}" run --rm -T --no-deps api-1 \
  myoxus-cli users set-admin "$MYOXUS_MI_ADMIN_EMAIL" >/dev/null

outsider_email="outsider-$RUN_ID@example.test"
"${COMPOSE[@]}" run --rm -T --no-deps api-1 \
  myoxus-cli users create --email "$outsider_email" --name "Unrelated fixture" >/dev/null
printf '%s\n' "$MYOXUS_MI_ADMIN_PASSWORD" \
  | "${COMPOSE[@]}" run --rm -T --no-deps api-1 \
      myoxus-cli users set-password "$outsider_email" --password-stdin >/dev/null

printf '%s\n' "==> shared storage is visible from both nodes"
storage_marker="multi-instance-$RUN_ID"
api1_container="$("${COMPOSE[@]}" ps -q api-1)"
api2_container="$("${COMPOSE[@]}" ps -q api-2)"
# File tools stay outside the shell-free server. Match its shipped UID:GID so
# the probe still verifies application access, not root's volume permissions.
printf '%s' "$storage_marker" \
  | docker run --rm -i --network none --user 1000:999 \
      --volumes-from "$api1_container" alpine:3.20 sh -c \
      'cat > /opt/myoxus/data/storage/.multi-instance-probe'
observed_marker="$(
  docker run --rm --network none --user 1000:999 \
    --volumes-from "$api2_container" alpine:3.20 \
    cat /opt/myoxus/data/storage/.multi-instance-probe
)"
test "$observed_marker" = "$storage_marker"
docker run --rm --network none --user 1000:999 \
  --volumes-from "$api2_container" alpine:3.20 \
  rm -f /opt/myoxus/data/storage/.multi-instance-probe

"$SCRIPT_DIR/smoke-multi-instance.sh"
node "$SCRIPT_DIR/smoke-multi-instance-realtime.mjs"

SUCCESS=1
printf '%s\n' "multi-instance lifecycle gate passed"
