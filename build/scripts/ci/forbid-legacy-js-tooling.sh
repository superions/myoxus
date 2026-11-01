#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# forbid-legacy-js-tooling.sh — hard gate for forbidden legacy JS tooling versions
#
# Checks:
#   1. yarn.lock resolved versions (no forbidden old majors may appear)
#   2. Workspace package.json direct declarations (no workspace may declare a
#      forbidden version range)
#   3. Root package.json resolutions (masking old versions is not allowed)
#   4. Active build scripts (no affine-branded build commands)
#   5. Active product links (no AFFiNE/ToEverything runtime links in active paths)
#   6. Client-side PDF tooling reintroduction (pdfmake / pdf-lib / pdf-viewer
#      imports + adapter class names) — P9 forbids in client/ and virgultum/
#   7. PDF feature flag identifiers (enable_pdfmake_export /
#      enable_pdf_embed_preview) — P9 always-on contract
#
# Exit codes:
#   0 — all checks pass
#   1 — one or more blocking violations found
#
# Usage:
#   build/scripts/ci/forbid-legacy-js-tooling.sh
#   build/scripts/ci/forbid-legacy-js-tooling.sh --warn-only   # print violations but exit 0
#   build/scripts/ci/forbid-legacy-js-tooling.sh --json        # JSON output
#
# Allowlist: docs/dev/dep-allowlist.md (format documented there)
# Reference:  docs/dev/dependency-audit.md

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
YARN_LOCK="$REPO_ROOT/yarn.lock"
ROOT_PKG="$REPO_ROOT/package.json"

WARN_ONLY=false
JSON_OUT=false

for arg in "$@"; do
  case "$arg" in
    --warn-only) WARN_ONLY=true ;;
    --json) JSON_OUT=true ;;
  esac
done

# ── Allowlist ────────────────────────────────────────────────────────────────
# Format: "PACKAGE|VERSION_PATTERN|reason|owner|review_date"
# Add new entries here with mandatory reason, owner and review date.
ALLOWLIST=()
# (currently empty — all violations are blocking)

# ── Forbidden resolved versions in yarn.lock ─────────────────────────────────
# Pattern format: "PACKAGE_NAME VERSION_PREFIX" — matches resolved version lines
# in yarn.lock that start with the given prefix.
FORBIDDEN_RESOLVED=(
  "vite 4."
  "vite 5."
  "vite-node 1."
  "@vanilla-extract/integration 6."
  "@vanilla-extract/vite-plugin 3."
  "vite-plugin-dts 2."
  "react-router-dom 6."
  "react-router 6."
)

# ── Forbidden workspace direct declarations ───────────────────────────────────
# Pattern format: "PACKAGE_NAME FORBIDDEN_SEMVER_PREFIX" — any workspace
# package.json that declares this package with the given version prefix is a
# violation (covers ^, ~, = prefixes).
FORBIDDEN_DECLARED=(
  "vite ^4."
  "vite ^5."
  "vite ~4."
  "vite ~5."
  "@vanilla-extract/vite-plugin ^3."
  "@vanilla-extract/vite-plugin ~3."
  "vite-plugin-dts ^2."
  "vite-plugin-dts ~2."
  "react-router-dom ^6."
  "react-router-dom ~6."
  "react-router ^6."
  "react-router ~6."
  # P9 (2026-04-27): client-side PDF export moved to server-side Typst.
  # Empty version prefix matches any caret/tilde/exact range.
  "pdfmake "
  "@types/pdfmake "
  "pdf-lib "
  # P9 #318 (2026-04-27): removed viewer package replaced by pdfjs-dist.
  # `@toeverything/pdf-viewer` referenced upstream-branded CDN assets and
  # had no text-layer/find-bar/thumbnail support — superseded.
  "@toeverything/pdf-viewer "
)

# ── Forbidden active build commands ──────────────────────────────────────────
# Checked in package.json "scripts" fields across all workspaces.
FORBIDDEN_BUILD_PATTERNS=(
  "affine bundle"
  '"affine"'
)

# ── Forbidden product links in active source paths ────────────────────────────
# Checked with rg across the active client, tools and build roots.
FORBIDDEN_PRODUCT_LINKS=(
  "affine\\.pro[^a-z]"
  "affine\\.run[^a-z]"
  "cdn\\.affine\\.pro[^a-z]"
  "affine\\.fail[^a-z]"
  "toeverything\\.info[^a-z]"
)

# ── Forbidden client-side PDF-tooling imports / class names ───────────────────
# After P9 (2026-04-27) the client-side pdfmake adapter is gone. PDF export
# runs server-side via Typst (`server/crates/pdf_export`). Reintroducing any
# of these patterns in `client/` or `virgultum/` is blocking.
FORBIDDEN_PDF_PATTERNS=(
  "from\\s+['\"]pdfmake"
  "import\\s+['\"]pdfmake"
  "require\\(['\"]pdfmake"
  "from\\s+['\"]pdfmake/"
  "from\\s+['\"]@types/pdfmake"
  "from\\s+['\"]pdf-lib"
  "import\\s+['\"]pdf-lib"
  "require\\(['\"]pdf-lib"
  "from\\s+['\"]@toeverything/pdf-viewer"
  "import\\s+['\"]@toeverything/pdf-viewer"
  "require\\(['\"]@toeverything/pdf-viewer"
  "class\\s+PdfAdapter\\b"
  "class\\s+PdfTransformer\\b"
)

# ── Forbidden client-side PDF feature-flag identifiers ───────────────────────
# After P9 the export and viewer feature flags are removed (always-on path).
# Any reintroduction of these flag identifiers in source is blocking.
# Reference: docs/dev/clients/pdf-export-architecture.md §10.
FORBIDDEN_PDF_FLAGS=(
  "enable_pdfmake_export"
  "enablePdfmakeExport"
  "enable_pdf_embed_preview"
  "enablePdfEmbedPreview"
)

VIOLATIONS=()
WARNINGS=()

# ── Helper ────────────────────────────────────────────────────────────────────
is_allowlisted() {
  local pkg="$1" ver="$2"
  for entry in "${ALLOWLIST[@]}"; do
    local a_pkg a_ver
    a_pkg="$(echo "$entry" | cut -d'|' -f1)"
    a_ver="$(echo "$entry" | cut -d'|' -f2)"
    if [[ "$pkg" == "$a_pkg" && "$ver" == "$a_ver"* ]]; then
      return 0
    fi
  done
  return 1
}

add_violation() {
  VIOLATIONS+=("$1")
}

add_warning() {
  WARNINGS+=("$1")
}

# ── Check 1: yarn.lock resolved versions ────────────────────────────────────
if [[ ! -f "$YARN_LOCK" ]]; then
  echo "ERROR: yarn.lock not found at $YARN_LOCK" >&2
  exit 1
fi

while IFS= read -r result_line; do
  [[ -z "$result_line" ]] && continue
  pkg="$(echo "$result_line" | cut -d' ' -f1)"
  ver="$(echo "$result_line" | cut -d' ' -f2)"
  is_allowlisted "$pkg" "$ver" && continue
  add_violation "yarn.lock resolved forbidden version: ${pkg}@${ver}"
done < <(python3 - "$YARN_LOCK" <<'PYEOF'
import sys, re

lock_path = sys.argv[1]
forbidden = [
    ("vite", "4."),
    ("vite", "5."),
    ("vite-node", "1."),
    ("@vanilla-extract/integration", "6."),
    ("@vanilla-extract/vite-plugin", "3."),
    ("vite-plugin-dts", "2."),
    ("react-router-dom", "6."),
    ("react-router", "6."),
]

with open(lock_path, encoding="utf-8") as f:
    content = f.read()

blocks = re.split(r'\n(?="|\w)', content)
for block in blocks:
    lines = block.strip().splitlines()
    if not lines:
        continue
    # Extract package name from spec line (first line)
    spec_line = lines[0].rstrip(":")
    # Remove quotes
    spec_line = spec_line.strip('"')
    # Get first spec (before comma)
    first_spec = spec_line.split(",")[0].strip().strip('"')
    # Extract package name (before @version or @npm:)
    m = re.match(r'^(@?[^@]+)@', first_spec)
    if not m:
        continue
    pkg_name = m.group(1)
    # Find resolved version in block
    ver_match = re.search(r'^\s+version:\s+"?([^"\n]+)"?', block, re.MULTILINE)
    if not ver_match:
        continue
    resolved = ver_match.group(1).strip()
    for (fpkg, fprefix) in forbidden:
        if pkg_name == fpkg and resolved.startswith(fprefix):
            print(f"{pkg_name} {resolved}")
PYEOF
)

# ── Check 2: workspace package.json direct declarations ─────────────────────
PKG_FILES=()
while IFS= read -r pkg_file; do
  PKG_FILES+=("$pkg_file")
done < <(find "$REPO_ROOT" \
  -not -path "$REPO_ROOT/node_modules/*" \
  -not -path "$REPO_ROOT/.yarn/*" \
  -not -path "$REPO_ROOT/.claude/*" \
  -name "package.json" -type f 2>/dev/null)

while IFS=$'\t' read -r rel_path dep_name dep_ver; do
  [[ -z "${rel_path:-}" ]] && continue
  is_allowlisted "$dep_name" "$dep_ver" && continue
  add_violation "$rel_path declares forbidden version: ${dep_name}@${dep_ver}"
done < <(python3 - "$REPO_ROOT" "${#FORBIDDEN_DECLARED[@]}" "${FORBIDDEN_DECLARED[@]}" "${PKG_FILES[@]}" <<'PYEOF'
import json
import os
import sys

repo_root = sys.argv[1]
forbidden_count = int(sys.argv[2])
forbidden = []
for raw in sys.argv[3 : 3 + forbidden_count]:
    name, _, prefix = raw.partition(" ")
    forbidden.append((name, prefix))
pkg_files = sys.argv[3 + forbidden_count :]

seen = set()
for pkg_file in pkg_files:
    if "/.claude/" in pkg_file:
        continue
    rel_path = os.path.relpath(pkg_file, repo_root)
    try:
        with open(pkg_file, encoding="utf-8") as f:
            pkg = json.load(f)
    except Exception:
        continue
    for section in ("dependencies", "devDependencies", "peerDependencies"):
        for dep_name, dep_ver in pkg.get(section, {}).items():
            for forbidden_name, forbidden_prefix in forbidden:
                if dep_name == forbidden_name and str(dep_ver).startswith(forbidden_prefix):
                    key = (rel_path, dep_name, str(dep_ver))
                    if key not in seen:
                        seen.add(key)
                        print("\t".join(key))
PYEOF
)

# ── Check 3: root resolutions masking old versions ───────────────────────────
while IFS= read -r res_entry; do
  [[ -z "$res_entry" ]] && continue
  pkg_spec="$(echo "$res_entry" | cut -d$'\t' -f1)"
  res_ver="$(echo "$res_entry" | cut -d$'\t' -f2)"
  # Strip version specifier from spec to get package name
  pkg_name="$(echo "$pkg_spec" | sed 's/@[^@]*$//' | sed 's/^@//' | sed 's/^/@/')"
  # Re-add @ if it was a scoped package
  [[ "$pkg_spec" == @* ]] && pkg_name="@${pkg_name#@}"
  for forbidden in "${FORBIDDEN_DECLARED[@]}"; do
    f_name="$(echo "$forbidden" | cut -d' ' -f1)"
    f_prefix="$(echo "$forbidden" | cut -d' ' -f2)"
    if [[ "$pkg_spec" == "$f_name"* && "$res_ver" == "$f_prefix"* ]]; then
      add_violation "root resolutions masks forbidden version: ${pkg_spec} -> ${res_ver}"
    fi
  done
done < <(python3 - "$ROOT_PKG" <<'PYEOF'
import sys, json
try:
    with open(sys.argv[1]) as f:
        pkg = json.load(f)
    for name, ver in pkg.get("resolutions", {}).items():
        print(f"{name}\t{ver}")
except Exception:
    pass
PYEOF
)

# ── Check 4: active build scripts with forbidden patterns ────────────────────
while IFS=$'\t' read -r rel_path script_name pattern; do
  [[ -z "${rel_path:-}" ]] && continue
  add_violation "$rel_path script '$script_name' uses forbidden pattern: $pattern"
done < <(python3 - "$REPO_ROOT" "${#FORBIDDEN_BUILD_PATTERNS[@]}" "${FORBIDDEN_BUILD_PATTERNS[@]}" "${PKG_FILES[@]}" <<'PYEOF'
import json
import os
import sys

repo_root = sys.argv[1]
pattern_count = int(sys.argv[2])
patterns = sys.argv[3 : 3 + pattern_count]
pkg_files = sys.argv[3 + pattern_count :]

for pkg_file in pkg_files:
    if "/.claude/" in pkg_file:
        continue
    rel_path = os.path.relpath(pkg_file, repo_root)
    try:
        with open(pkg_file, encoding="utf-8") as f:
            pkg = json.load(f)
    except Exception:
        continue
    for script_name, command in pkg.get("scripts", {}).items():
        command = str(command)
        for pattern in patterns:
            if pattern in command:
                print(f"{rel_path}\t{script_name}\t{pattern}")
PYEOF
)

# ── Check 5: active product links in source paths ────────────────────────────
SCAN_PATHS=(
  "$REPO_ROOT/client"
  "$REPO_ROOT/tools"
  "$REPO_ROOT/build"
)
SCAN_EXCLUDE_PATHS=(
  "$REPO_ROOT/client/frontends/static"
  "$REPO_ROOT/packages"
  "node_modules"
  ".yarn"
  "*.lock"
  "dist"
  ".claude"
)

for pattern in "${FORBIDDEN_PRODUCT_LINKS[@]}"; do
  exclude_args=()
  for ex in "${SCAN_EXCLUDE_PATHS[@]}"; do
    exclude_args+=("--exclude-dir=$ex" "--exclude=$ex")
  done
  # Use grep -r for broad scan, limit to first 5 hits per pattern
  hits="$(grep -r -l --include="*.ts" --include="*.tsx" \
    --include="*.json" --include="*.yaml" --include="*.yml" \
    --include="*.sh" --include="*.md" \
    --exclude-dir=node_modules --exclude-dir=.yarn --exclude-dir=packages \
    --exclude-dir=static --exclude-dir=dist --exclude-dir=.claude \
    --exclude-dir=web-static \
    -E "$pattern" "${SCAN_PATHS[@]}" 2>/dev/null | head -5 || true)"
  if [[ -n "$hits" ]]; then
    while IFS= read -r hit_file; do
      rel_hit="${hit_file#$REPO_ROOT/}"
      add_warning "active product link '$pattern' found in: $rel_hit"
    done <<< "$hits"
  fi
done

# ── Check 6: forbidden client-side PDF tooling re-introduction ───────────────
# After P9 the pdfmake adapter and its transformer are deleted. Reintroducing
# `pdfmake` imports or a `PdfAdapter` / `PdfTransformer` class anywhere under
# `client/` or `virgultum/` is a blocking violation.
PDF_SCAN_PATHS=(
  "$REPO_ROOT/client"
  "$REPO_ROOT/virgultum"
)

for pattern in "${FORBIDDEN_PDF_PATTERNS[@]}"; do
  for scan_root in "${PDF_SCAN_PATHS[@]}"; do
    [[ -d "$scan_root" ]] || continue
    # Source-only scan: exclude prebuilt artefacts (static/, web-static/, dist/,
    # lib/) and node_modules. The pdfmake package itself remains in the lockfile
    # until #316 — we only forbid *source code* reintroduction here.
    hits="$(grep -r -l \
      --include="*.ts" --include="*.tsx" --include="*.mjs" \
      --exclude-dir=node_modules --exclude-dir=.yarn \
      --exclude-dir=dist --exclude-dir=lib --exclude-dir=.claude \
      --exclude-dir=static --exclude-dir=web-static \
      --exclude-dir=__tests__ \
      -E "$pattern" "$scan_root" 2>/dev/null | head -5 || true)"
    if [[ -n "$hits" ]]; then
      while IFS= read -r hit_file; do
        rel_hit="${hit_file#$REPO_ROOT/}"
        add_violation "client-side PDF tooling reintroduced (P9 forbids '$pattern'): $rel_hit"
      done <<< "$hits"
    fi
  done
done

# ── Check 7: forbidden client-side PDF feature-flag identifiers ──────────────
# Reintroducing `enable_pdfmake_export` / `enable_pdf_embed_preview` in source
# (TS, TSX, MJS, Rust, YAML config) breaks the always-on contract from P9.
# Docs (markdown) and historical todos remain free to reference these strings.
PDF_FLAG_SCAN_PATHS=(
  "$REPO_ROOT/client"
  "$REPO_ROOT/virgultum"
  "$REPO_ROOT/server/src"
  "$REPO_ROOT/server/crates"
  "$REPO_ROOT/server/config"
)

for flag in "${FORBIDDEN_PDF_FLAGS[@]}"; do
  for scan_root in "${PDF_FLAG_SCAN_PATHS[@]}"; do
    [[ -d "$scan_root" ]] || continue
    hits="$(grep -r -l \
      --include="*.ts" --include="*.tsx" --include="*.mjs" \
      --include="*.rs" --include="*.yaml" --include="*.yml" \
      --include="*.json" \
      --exclude-dir=node_modules --exclude-dir=.yarn \
      --exclude-dir=dist --exclude-dir=lib --exclude-dir=.claude \
      --exclude-dir=static --exclude-dir=web-static \
      --exclude-dir=__tests__ --exclude-dir=target \
      -F "$flag" "$scan_root" 2>/dev/null | head -5 || true)"
    if [[ -n "$hits" ]]; then
      while IFS= read -r hit_file; do
        rel_hit="${hit_file#$REPO_ROOT/}"
        add_violation "PDF feature flag '$flag' reintroduced (P9 forbids — always-on contract): $rel_hit"
      done <<< "$hits"
    fi
  done
done

# ── Secondary warnings (P1/P2 duplicates) ────────────────────────────────────
check_secondary() {
  local pkg="$1" prefix="$2" label="$3"
  local found
  found="$(python3 - "$YARN_LOCK" "$pkg" "$prefix" <<'PYEOF'
import sys, re
lock_path, pkg_name, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
with open(lock_path, encoding="utf-8") as f:
    content = f.read()
blocks = re.split(r'\n(?="|\w)', content)
found = set()
for block in blocks:
    lines = block.strip().splitlines()
    if not lines:
        continue
    spec_line = lines[0].rstrip(":").strip('"').split(",")[0].strip().strip('"')
    m = re.match(r'^(@?[^@]+)@', spec_line)
    if not m or m.group(1) != pkg_name:
        continue
    ver_match = re.search(r'^\s+version:\s+"?([^"\n]+)"?', block, re.MULTILINE)
    if ver_match and ver_match.group(1).startswith(prefix):
        found.add(ver_match.group(1))
if found:
    print("\n".join(sorted(found)))
PYEOF
  )"
  if [[ -n "$found" ]]; then
    add_warning "P1/P2 duplicate still present — $label: $found"
  fi
}

check_secondary "@sentry/browser" "10.40." "Sentry 10.40/10.47 mix"
# Electron Packager and app-builder retain their independently supported
# signer/downloader majors; retired Forge unification resolutions are forbidden.
# typescript: root resolution forces 7.0.2 across the workspace.
# zod: root resolution forces ^3.25.76 — queuedash needs ^3.x so unifying at 3 is correct.

# ── Report ────────────────────────────────────────────────────────────────────
if [[ "$JSON_OUT" == true ]]; then
  python3 - "${#VIOLATIONS[@]}" "${VIOLATIONS[@]}" "${#WARNINGS[@]}" "${WARNINGS[@]}" <<'PYEOF'
import json
import sys

violation_count = int(sys.argv[1])
violations = sys.argv[2 : 2 + violation_count]
warning_count_index = 2 + violation_count
warning_count = int(sys.argv[warning_count_index])
warnings = sys.argv[warning_count_index + 1 : warning_count_index + 1 + warning_count]
print(json.dumps({"violations": violations, "warnings": warnings}, indent=2))
PYEOF
else
  if [[ ${#VIOLATIONS[@]} -gt 0 ]]; then
    echo ""
    echo "FORBIDDEN LEGACY TOOLING — BLOCKING VIOLATIONS:"
    for v in "${VIOLATIONS[@]}"; do
      echo "  ✗ $v"
    done
  fi
  if [[ ${#WARNINGS[@]} -gt 0 ]]; then
    echo ""
    echo "LEGACY TOOLING — WARNINGS (P1/P2, non-blocking):"
    for w in "${WARNINGS[@]}"; do
      echo "  ⚠ $w"
    done
  fi
  if [[ ${#VIOLATIONS[@]} -eq 0 && ${#WARNINGS[@]} -eq 0 ]]; then
    echo "✓ No forbidden legacy tooling found."
  elif [[ ${#VIOLATIONS[@]} -eq 0 ]]; then
    echo ""
    echo "✓ No blocking violations. ${#WARNINGS[@]} warning(s) above for review."
  fi
fi

if [[ ${#VIOLATIONS[@]} -gt 0 ]]; then
  if [[ "$WARN_ONLY" == true ]]; then
    echo ""
    echo "(warn-only mode — not failing)"
    exit 0
  fi
  exit 1
fi
exit 0
