#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run on the labelled Swarm state node before docker stack deploy.
set -euo pipefail

STATE_ROOT="${MYOXUS_SWARM_STATE_ROOT:?Set MYOXUS_SWARM_STATE_ROOT to an absolute path}"
TEMPLATE_HOST_DIR="${MYOXUS_TEMPLATE_HOST_DIR:-$STATE_ROOT/templates}"
API_USER="${MYOXUS_API_USER:-1000:1000}"
API_UID="${API_USER%%:*}"
API_GID="${API_USER#*:}"
SERVER_IMAGE="${MYOXUS_IMAGE_PREFIX:-git.blume29.de/myoxus}/myoxus:${MYOXUS_SERVER_IMAGE_TAG:?Set MYOXUS_SERVER_IMAGE_TAG to the selected server release or commit tag}"

[[ "$STATE_ROOT" = /* ]] || {
  echo "[FAIL] MYOXUS_SWARM_STATE_ROOT must be absolute" >&2
  exit 1
}
[[ "$API_UID" =~ ^[0-9]+$ && "$API_GID" =~ ^[0-9]+$ ]] || {
  echo "[FAIL] MYOXUS_API_USER must be numeric UID:GID" >&2
  exit 1
}
[[ "$EUID" -eq 0 ]] || {
  echo "[FAIL] run this preflight as root on the labelled Swarm state node" >&2
  exit 1
}
[[ "$TEMPLATE_HOST_DIR" = /* && "$(realpath -m "$TEMPLATE_HOST_DIR")" = "$(realpath -m "$STATE_ROOT")/"* ]] || {
  echo "[FAIL] template host directory must stay inside the owning Swarm state root" >&2
  exit 1
}
docker image inspect "$SERVER_IMAGE" >/dev/null || {
  echo "[FAIL] pull the selected server image on the state node before running this preflight" >&2
  exit 1
}

install -d -m 0750 \
  "$STATE_ROOT/postgres" \
  "$STATE_ROOT/redis" \
  "$STATE_ROOT/data/storage" \
  "$STATE_ROOT/data/logs" \
  "$STATE_ROOT/data/git-sync" \
  "$STATE_ROOT/runtime-config" \
  "$STATE_ROOT/style" \
  "$STATE_ROOT/frontends" \
  "$STATE_ROOT/pdf-fonts"
if [[ ! -e "$STATE_ROOT/runtime-config/local.yaml" ]]; then
  printf '{}\n' >"$STATE_ROOT/runtime-config/local.yaml"
fi

chown -R "$API_UID:$API_GID" \
  "$STATE_ROOT/data" \
  "$STATE_ROOT/runtime-config" \
  "$STATE_ROOT/style" \
  "$STATE_ROOT/pdf-fonts"
chmod 0700 "$STATE_ROOT/runtime-config"
chmod 0600 "$STATE_ROOT/runtime-config/local.yaml"
chmod 0750 "$STATE_ROOT/style"

for path in data runtime-config style pdf-fonts; do
  owner="$(stat -c '%u:%g' "$STATE_ROOT/$path")"
  [[ "$owner" = "$API_UID:$API_GID" ]] || {
    echo "[FAIL] $STATE_ROOT/$path is owned by $owner, expected $API_UID:$API_GID" >&2
    exit 1
  }
done

bash "$(dirname "${BASH_SOURCE[0]}")/prepare-templates.sh" \
  --server-image "$SERVER_IMAGE" --output "$TEMPLATE_HOST_DIR" --owner "$API_USER"
docker run --rm --user "$API_USER" \
  -v "$TEMPLATE_HOST_DIR:/templates:ro" alpine:3.20 \
  sh -ec 'test -d /templates/mail && test -f /templates/features/catalog.yaml; unreadable=$(find -L /templates ! -type d ! -exec test -r {} \; -print); test -z "$unreadable" || { printf "Unreadable template paths: %s\n" "$unreadable" >&2; exit 1; }'

echo "[PASS] Swarm state directories are prepared for API UID:GID $API_UID:$API_GID"
