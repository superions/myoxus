#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WEB_DIST="$ROOT_DIR/client/web/workspaces/web/dist"
ADMIN_DIST="$ROOT_DIR/client/admin/workspaces/admin/dist"
OUT_ROOT="$ROOT_DIR/client/frontends/static"
WEB_OUT="$OUT_ROOT/web"
ADMIN_OUT="$OUT_ROOT/admin"

if [[ ! -d "$WEB_DIST" ]]; then
  echo "[FAIL] missing web dist: $WEB_DIST" >&2
  echo "       build first: yarn myoxus build -p @myoxus/web" >&2
  exit 1
fi
if [[ ! -d "$ADMIN_DIST" ]]; then
  echo "[FAIL] missing admin dist: $ADMIN_DIST" >&2
  echo "       build first: yarn myoxus build -p @myoxus/admin" >&2
  exit 1
fi

rm -rf "$OUT_ROOT"
mkdir -p "$WEB_OUT" "$ADMIN_OUT"
cat > "$OUT_ROOT/.gitignore" <<'GITIGNORE'
*.js
*.map
!sw.js

plugins
GITIGNORE
cp -a "$WEB_DIST/." "$WEB_OUT/"
cp -a "$ADMIN_DIST/." "$ADMIN_OUT/"
node "$ROOT_DIR/build/scripts/fonts/client-font-assets.mjs" copy --target-root "$OUT_ROOT"

# The browser app expects channel-specific ICO aliases. They are generated from
# the canonical favicon so the new prebuilt tree does not need duplicate source
# assets.
mkdir -p "$WEB_OUT/imgs"
for channel in stable beta internal canary; do
  cp "$WEB_OUT/favicon.ico" "$WEB_OUT/imgs/app-icon-$channel.ico"
done

for root in "$WEB_OUT" "$ADMIN_OUT"; do
  find "$root" -type d -name "__tests__" -prune -exec rm -rf {} +
  find "$root" -type f \( \
    -name "*.map" -o \
    -name "*.spec.js" -o \
    -name "*.d.ts" -o \
    -name "tsconfig.tsbuildinfo" \
  \) -delete
  find "$root" -type f -name "*.html" -exec perl -0pi -e 's/[ \t]+$//mg' {} +
done

echo "[PASS] exported static frontend artifacts"
echo "       web:    $WEB_DIST -> $WEB_OUT"
echo "       admin:  $ADMIN_DIST -> $ADMIN_OUT"
