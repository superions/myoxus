#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STATIC_ROOT="${1:-$ROOT_DIR/client/frontends/static}"
WEB_ROOT="$STATIC_ROOT/web"
ADMIN_ROOT="$STATIC_ROOT/admin"

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

[[ -f "$WEB_ROOT/selfhost.html" ]] || fail "missing web selfhost.html in $WEB_ROOT"
[[ -f "$ADMIN_ROOT/selfhost.html" ]] || fail "missing admin selfhost.html in $ADMIN_ROOT"
[[ -d "$WEB_ROOT/js" ]] || fail "missing web js dir"
[[ -d "$ADMIN_ROOT/js" ]] || fail "missing admin js dir"
node "$ROOT_DIR/build/scripts/fonts/client-font-assets.mjs" verify --target-root "$STATIC_ROOT"
[[ ! -e "$WEB_ROOT/adminfrontend" ]] || fail "web root must not contain adminfrontend/"
[[ ! -e "$ADMIN_ROOT/adminfrontend" ]] || fail "admin root must not contain nested adminfrontend/"

check_shell_branding() {
  local shell_path="$1"

  if ! grep -qi "myoxus" "$shell_path"; then
    fail "expected Myoxus branding marker in shell: $shell_path"
  fi

  # Split to avoid the guard matching its own detection string.
  local legacy_domain="affine"; local legacy_ext=".pro"
  if grep -qi "${legacy_domain}${legacy_ext}" "$shell_path"; then
    fail "found legacy upstream domain reference in shell: $shell_path"
  fi
}

check_shell_branding "$WEB_ROOT/selfhost.html"
check_shell_branding "$ADMIN_ROOT/selfhost.html"

"$ROOT_DIR/build/scripts/frontends/verify-public-static-root.sh" "$WEB_ROOT"
"$ROOT_DIR/build/scripts/frontends/verify-public-static-root.sh" "$ADMIN_ROOT"

if find "$STATIC_ROOT" -type f \( -name "*.d.ts" -o -name "tsconfig.tsbuildinfo" -o -name "*.spec.js" \) | grep -q .; then
  fail "static roots contain compiler or test artifacts"
fi

web_html_refs=$(grep -Rho "/adminfrontend/" "$WEB_ROOT"/*.html 2>/dev/null || true)
if [[ -n "$web_html_refs" ]]; then
  fail "web root HTML contains adminfrontend asset references: $web_html_refs"
fi

admin_marker_hit="$(
  find "$WEB_ROOT/js" "$WEB_ROOT/assets" -type f -name "*.js" -print0 2>/dev/null \
    | xargs -0 grep -I -l -F "adminDocumentAuditLog" 2>/dev/null \
    | head -n 1 || true
)"
if [[ -n "$admin_marker_hit" ]]; then
  fail "web root contains Admin Documents bundle markers: $admin_marker_hit"
fi

legacy_tracked="$(
  git -C "$ROOT_DIR" ls-files 'client/web/static/**' 'client/admin/static/**'
)"
if [[ -n "$legacy_tracked" ]]; then
  fail "legacy tracked static mirrors remain; use client/frontends/static only"
fi

legacy_worktree="$(
  find "$ROOT_DIR/client/web/static" "$ROOT_DIR/client/admin/static" \
    -mindepth 1 -print -quit 2>/dev/null || true
)"
if [[ -n "$legacy_worktree" ]]; then
  fail "legacy static mirror files remain in the worktree"
fi

icon_markers=("lucide""-react" "@block""suite/icons" "revendor""-icons")
for marker in "${icon_markers[@]}"; do
  if grep -R -I -l -F "$marker" "$STATIC_ROOT"; then
    fail "found legacy or external icon dependency marker in prebuilt static artifacts: $marker"
  fi
done

legacy_markers=(
  "mx-client-libs-component-src-styles-web-ui"
  "@myoxus/component"
  "client/libs/component"
)
for marker in "${legacy_markers[@]}"; do
  if grep -R -I -l -F "$marker" "$STATIC_ROOT"; then
    fail "found legacy component/UI-framework marker in prebuilt static artifacts: $marker"
  fi
done

node "$ROOT_DIR/build/scripts/admin/verify-icon-signatures.mjs" --static-dir "$ADMIN_ROOT"
node "$ROOT_DIR/build/scripts/admin/verify-documents-audit-bundle.mjs" --static-dir "$ADMIN_ROOT"

for channel in stable beta internal canary; do
  [[ -f "$WEB_ROOT/imgs/app-icon-$channel.ico" ]] || fail "missing generated web app icon for $channel"
done

printf '[PASS] verified canonical prebuilt static roots\n'
printf '       web:   %s\n' "$WEB_ROOT"
printf '       admin: %s\n' "$ADMIN_ROOT"
