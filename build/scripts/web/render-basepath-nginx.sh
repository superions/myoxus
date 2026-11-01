#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)"
echo "[INFO] $0 is a compatibility wrapper for build/scripts/frontends/render-basepath-nginx.sh" >&2
exec "$ROOT_DIR/build/scripts/frontends/render-basepath-nginx.sh" "$@"
