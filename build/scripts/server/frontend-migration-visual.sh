#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Opinionated visual-review wrapper for frontend Mantine/Facade migration
# slices. It reuses the local dev frontend gateway, applies the standard
# desktop and light/dark matrix by default, and derives local seed
# credentials without printing them.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
DEV_ENV="$REPO_ROOT/tmp/dev/dev.env"
SEED_SCRIPT="$REPO_ROOT/build/scripts/test/seed-test-users.sh"

usage() {
  cat <<'EOF'
Usage:
  build/scripts/server/frontend-migration-visual.sh --url=<route> --name=<slug> [capture options]

Defaults:
  - ensures the local dev frontends via frontend-dev-ensure.sh;
  - captures desktop:1440x1000 only;
  - captures light and dark themes;
  - authenticates with the local dev Admin seed user unless --no-auth,
    --auth, --storage-state or explicit MYOXUS_VISUAL_* credentials are used;
  - writes to output/playwright/frontend-migration-<name>-<timestamp>/.

Pass-through examples:
  --wait-selector='[data-myoxus-ui-role="page-list"]'
  --probe='toolbar=[data-myoxus-ui-role="toolbar-surface"]'
  --require-probe='toolbar=[data-myoxus-ui-role="toolbar-surface"]'
  --expect-zero='legacy=.old-class'
  --local-storage='app_config={"onBoarding":true}'
  --click-selector='[data-testid="open-filter"]'

Add --theme=system when the resolved system-preference state is part of the
acceptance matrix. The app must resolve it to light or dark in the DOM.

Use --help on build/scripts/server/capture-web-route-visual.sh for the complete
pass-through API.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

has_arg() {
  local name="$1"
  shift
  for arg in "$@"; do
    if [[ "$arg" == "$name" || "$arg" == "$name="* ]]; then
      return 0
    fi
  done
  return 1
}

value_arg() {
  local name="$1"
  local fallback="$2"
  shift 2
  local value="$fallback"
  local expect_value=0
  for arg in "$@"; do
    if [[ "$expect_value" -eq 1 ]]; then
      value="$arg"
      expect_value=0
      continue
    fi
    if [[ "$arg" == "$name" ]]; then
      expect_value=1
    elif [[ "$arg" == "$name="* ]]; then
      value="${arg#*=}"
    fi
  done
  printf '%s' "$value"
}

derive_name_from_url() {
  local url="$1"
  local slug
  slug="${url#/}"
  slug="${slug%%\?*}"
  slug="${slug//[^[:alnum:]._-]/-}"
  slug="${slug#-}"
  slug="${slug%-}"
  printf '%s' "${slug:-web-route}"
}

derive_seed_credentials() {
  local line email password
  line="$(sed -n 's/^#   Admin:[[:space:]]*\([^[:space:]]*\)[[:space:]]*\/[[:space:]]*\([^[:space:]]*\).*/\1 \2/p' "$SEED_SCRIPT" | head -1)"
  if [[ -z "$line" ]]; then
    echo "[FAIL] could not derive local Admin seed credentials from $SEED_SCRIPT" >&2
    exit 1
  fi
  read -r email password <<<"$line"
  export MYOXUS_VISUAL_EMAIL="${MYOXUS_VISUAL_EMAIL:-$email}"
  export MYOXUS_VISUAL_PASSWORD="${MYOXUS_VISUAL_PASSWORD:-$password}"
}

auth_disabled=0
capture_args=()
for arg in "$@"; do
  if [[ "$arg" == "--no-auth" ]]; then
    auth_disabled=1
    continue
  fi
  capture_args+=("$arg")
done

url="$(value_arg "--url" "" "$@")"
name="$(value_arg "--name" "" "$@")"
if [[ -z "$name" ]]; then
  name="$(derive_name_from_url "$url")"
fi

if ! has_arg "--output-dir" "$@"; then
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  capture_args+=("--output-dir" "output/playwright/frontend-migration-${name}-${timestamp}")
fi

if ! has_arg "--viewport" "$@"; then
  capture_args+=("--viewport" "desktop:1440x1000")
fi

if ! has_arg "--theme" "$@"; then
  capture_args+=("--theme" "light")
  capture_args+=("--theme" "dark")
fi

if ! has_arg "--base-url" "$@"; then
  "$SCRIPT_DIR/frontend-dev-ensure.sh"
  if [[ -f "$DEV_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$DEV_ENV"
  fi
  export MYOXUS_FRONTEND_BASE_URL="${MYOXUS_FRONTEND_BASE_URL:-${MYOXUS_DEV_GATEWAY_ORIGIN:-http://127.0.0.1:3011}}"
fi

if [[ "$auth_disabled" -eq 1 ]]; then
  unset MYOXUS_VISUAL_EMAIL
  unset MYOXUS_VISUAL_PASSWORD
elif has_arg "--auth" "$@" &&
  [[ -z "${MYOXUS_VISUAL_EMAIL:-}" || -z "${MYOXUS_VISUAL_PASSWORD:-}" ]]; then
  derive_seed_credentials
elif ! has_arg "--auth" "$@" &&
  ! has_arg "--storage-state" "$@" &&
  [[ -z "${MYOXUS_VISUAL_EMAIL:-}" || -z "${MYOXUS_VISUAL_PASSWORD:-}" ]]; then
  derive_seed_credentials
  capture_args+=("--auth")
fi

echo "[INFO] frontend visual base: ${MYOXUS_FRONTEND_BASE_URL:-http://127.0.0.1:3011}"
echo "[INFO] frontend visual name: $name"

"$SCRIPT_DIR/capture-web-route-visual.sh" "${capture_args[@]}"
