#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
echo "[INFO] build/scripts/web/verify-prebuilt-static.sh is a compatibility wrapper." >&2
echo "[INFO] canonical root: client/frontends/static/{web,admin}" >&2
exec "$ROOT_DIR/build/scripts/frontends/verify-prebuilt-static.sh" "$@"
