#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_ROOT/build/scripts/server/require-runtime-profile.sh" verify-build
ROOT_DIR="$REPO_ROOT/build/server"
COMPOSE_FILE="$ROOT_DIR/docker-compose.selfhost.yml"
QA_ARTIFACT_DIR="${MYOXUS_QA_ARTIFACT_DIR:-$REPO_ROOT/playwright/.qa}"

PUBLIC_HOST_DEFAULT="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
PUBLIC_HOST="${MYOXUS_PUBLIC_HOST:-${PUBLIC_HOST_DEFAULT:-127.0.0.1}}"

export POSTGRES_USER="${POSTGRES_USER:-myoxus}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-myoxus}"
export POSTGRES_DB="${POSTGRES_DB:-myoxus}"
export MYOXUS_PUBLIC_PORT="${MYOXUS_PUBLIC_PORT:-3001}"
export MYOXUS_FRONTEND_PORT="${MYOXUS_FRONTEND_PORT:-3010}"
export MYOXUS_SERVER_ORIGIN="${MYOXUS_SERVER_ORIGIN:-http://${PUBLIC_HOST}:${MYOXUS_FRONTEND_PORT}}"
export MYOXUS_API_USER="${MYOXUS_API_USER:-1000:1000}"
export MYOXUS_DATA_DIR="${MYOXUS_DATA_DIR:-$ROOT_DIR/data}"
export MYOXUS_FRONTEND_ASSET_ROOT="${MYOXUS_FRONTEND_ASSET_ROOT:-$ROOT_DIR/runtime-frontends/current}"
export MYOXUS_BUILD_REVISION=localdev
if [ -z "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
  MYOXUS_BUILD_REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf localdev)"
fi
export MYOXUS_SERVER_VERSION="$(
  node "$REPO_ROOT/build/scripts/release/write-release-identity.mjs" \
    --repo "$REPO_ROOT" \
    --role server \
    --revision "$MYOXUS_BUILD_REVISION" \
    --print-version
)"

# shellcheck source=build/scripts/server/prepare-selfhost-runtime.sh
MYOXUS_DEFER_TEMPLATE_PREPARATION=true
source "$REPO_ROOT/build/scripts/server/prepare-selfhost-runtime.sh"

ADMIN_EMAIL="${MYOXUS_ADMIN_EMAIL:-admin@myoxus.local}"
ADMIN_PASSWORD="${MYOXUS_ADMIN_PASSWORD:-AdminMyoxus2026}"
ADMIN_NAME="${MYOXUS_ADMIN_NAME:-Myoxus Admin}"

mkdir -p "$MYOXUS_DATA_DIR/storage" "$MYOXUS_DATA_DIR/logs" "$MYOXUS_DATA_DIR/git-sync"
chmod -R a+rwx "$MYOXUS_DATA_DIR" 2>/dev/null || true

# Keep the visual-review QA mount writable for host-side Playwright runs.
# Docker creates missing bind paths as root-owned directories; pre-creating and
# repairing this path avoids stale/permission-broken contact sheet publishing.
mkdir -p "$QA_ARTIFACT_DIR" 2>/dev/null || true
if [ ! -w "$QA_ARTIFACT_DIR" ]; then
  docker run --rm -v "$QA_ARTIFACT_DIR:/work" alpine:3.20 sh -lc \
    "chown $(id -u):$(id -g) /work && chmod u+rwX /work" \
    >/dev/null
fi

# Clean-slate resets and ad-hoc compose runs may leave bind-mounted data paths
# owned by a different container user. Repair ownership before starting the API;
# otherwise the rolling file appender can crash the container before /health works.
API_UID="${MYOXUS_API_USER%%:*}"
API_GID="${MYOXUS_API_USER#*:}"
if [[ "$API_UID" != "0" ]]; then
  docker run --rm -v "$MYOXUS_DATA_DIR:/data" alpine:3.20 sh -lc \
    "mkdir -p /data/storage /data/logs /data/git-sync && chown -R $API_UID:$API_GID /data/storage /data/logs /data/git-sync && chmod -R u+rwX,go+rwX /data/storage /data/logs /data/git-sync" \
    >/dev/null
fi

echo "[INFO] using compose: $COMPOSE_FILE"
echo "[INFO] data dir: $MYOXUS_DATA_DIR"
echo "[INFO] runtime config dir: $MYOXUS_RUNTIME_CONFIG_DIR"
echo "[INFO] style dir: $MYOXUS_STYLE_HOST_DIR"
echo "[INFO] template root: $MYOXUS_TEMPLATE_HOST_DIR"
echo "[INFO] frontend: http://${PUBLIC_HOST}:${MYOXUS_FRONTEND_PORT}"
echo "[INFO] api:      http://${PUBLIC_HOST}:${MYOXUS_PUBLIC_PORT}"

"$REPO_ROOT/build/scripts/frontends/build-and-materialize-local.sh"

cd "$ROOT_DIR"
docker compose -f "$COMPOSE_FILE" build api
MYOXUS_TEMPLATE_VALIDATOR_IMAGE="${MYOXUS_API_IMAGE:-myoxus-api:local}" prepare_myoxus_templates
docker compose -f "$COMPOSE_FILE" up -d --no-build

for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${MYOXUS_PUBLIC_PORT}/health" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:${MYOXUS_FRONTEND_PORT}/health" >/dev/null 2>&1; then
    echo "[PASS] API/frontend health checks passed"
    break
  fi
  if [ "$i" -eq 90 ]; then
    echo "[FAIL] services did not become healthy in time" >&2
    docker compose -f "$COMPOSE_FILE" ps >&2 || true
    exit 1
  fi
  sleep 2
done

if [ "${MYOXUS_RUNTIME_SKIP_SEED:-false}" != true ]; then
setup_code="$(curl -sS -o /tmp/myoxus-admin-setup.out -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -X POST "http://127.0.0.1:${MYOXUS_FRONTEND_PORT}/api/setup/create-admin-user" \
  --data "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\",\"name\":\"${ADMIN_NAME}\"}")"

if [[ "$setup_code" != "200" && "$setup_code" != "201" && "$setup_code" != "409" && "$setup_code" != "403" ]]; then
  echo "[FAIL] admin bootstrap failed with HTTP $setup_code" >&2
  cat /tmp/myoxus-admin-setup.out >&2 || true
  exit 1
fi

echo "[PASS] admin bootstrap endpoint returned HTTP $setup_code"
echo
echo "Myoxus selfhost is up:"
echo "  Frontend URL: http://${PUBLIC_HOST}:${MYOXUS_FRONTEND_PORT}"
echo "  Admin URL:    http://${PUBLIC_HOST}:${MYOXUS_FRONTEND_PORT}/adminfrontend/"
echo "  API URL:      http://${PUBLIC_HOST}:${MYOXUS_PUBLIC_PORT}"
echo
echo "Login credentials:"
echo "  Email:    ${ADMIN_EMAIL}"
echo "  Password: ${ADMIN_PASSWORD}"
echo
echo "Debug paths (host):"
echo "  Data dir:      ${MYOXUS_DATA_DIR}"
echo "  API logs dir:  ${MYOXUS_DATA_DIR}/logs"
echo "  API log file:  ${MYOXUS_DATA_DIR}/logs/myoxus.log"
echo "  Storage dir:   ${MYOXUS_DATA_DIR}/storage"
echo "  Git-sync dir:  ${MYOXUS_DATA_DIR}/git-sync"
echo "  Runtime config: ${MYOXUS_RUNTIME_CONFIG_DIR}"
echo "  Style dir:      ${MYOXUS_STYLE_HOST_DIR}"

fi
