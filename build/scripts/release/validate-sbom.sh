#!/usr/bin/env bash
# build/scripts/release/validate-sbom.sh
#
# Validates CycloneDX SBOMs in docs/sbom/ against the CycloneDX JSON schema.
#
# Usage:
#   build/scripts/release/validate-sbom.sh [FILE...]
#
# If no files are given, validates all *.cdx.json files in docs/sbom/.
#
# Requirements: Node/npm, internet access for the pinned validator on first run
#
# P-DEPS-ROOT-D-01-T

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SBOM_DIR="$REPO_ROOT/docs/sbom"
SCHEMA_URL="https://raw.githubusercontent.com/CycloneDX/specification/1.5/schema/bom-1.5.schema.json"
SCHEMA_DIR="${XDG_CACHE_HOME:-${TMPDIR:-/tmp}}/myoxus-cyclonedx-schema-1.5"
SCHEMA_FILE="$SCHEMA_DIR/bom-1.5.schema.json"
SPDX_SCHEMA_URL="https://raw.githubusercontent.com/CycloneDX/specification/1.5/schema/spdx.schema.json"
SPDX_SCHEMA_FILE="$SCHEMA_DIR/spdx.schema.json"
JSF_SCHEMA_URL="https://raw.githubusercontent.com/CycloneDX/specification/1.5/schema/jsf-0.82.schema.json"
JSF_SCHEMA_FILE="$SCHEMA_DIR/jsf-0.82.schema.json"

# ─── Download schema if not cached ──────────────────────────────────────────

mkdir -p "$SCHEMA_DIR"
if [ ! -f "$SCHEMA_FILE" ]; then
  echo "==> Downloading CycloneDX schema 1.5 ..."
  curl -fsSL "$SCHEMA_URL" -o "$SCHEMA_FILE"
fi
if [ ! -f "$SPDX_SCHEMA_FILE" ]; then
  curl -fsSL "$SPDX_SCHEMA_URL" -o "$SPDX_SCHEMA_FILE"
fi
if [ ! -f "$JSF_SCHEMA_FILE" ]; then
  curl -fsSL "$JSF_SCHEMA_URL" -o "$JSF_SCHEMA_FILE"
fi

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

[ "$(hash_file "$SCHEMA_FILE")" = "067f7824b08653839ea050ae9e09ca48375eadc2652b0e2a299476e7db90335b" ]
[ "$(hash_file "$SPDX_SCHEMA_FILE")" = "4f6e2b05c05d26a4f2dc5879fbc2fca94b0a28db46289d0c51345621b71cfbfc" ]
[ "$(hash_file "$JSF_SCHEMA_FILE")" = "8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae" ]

# ─── Determine files to validate ────────────────────────────────────────────

FILES=()
if [ $# -gt 0 ]; then
  FILES=("$@")
else
  while IFS= read -r file; do
    FILES+=("$file")
  done < <(find "$SBOM_DIR" -maxdepth 1 -type f -name '*.cdx.json' -print 2>/dev/null | sort)
fi

if [ ${#FILES[@]} -eq 0 ]; then
  echo "==> No *.cdx.json files found in $SBOM_DIR"
  echo "    Run: build/scripts/release/generate-sbom.sh first"
  exit 1
fi

# The validator versions are intentionally pinned. Release jobs must never
# mutate the global npm installation or resolve an unbounded latest version.
AJV=(npx --yes --package=ajv-cli@5.0.0 ajv)

# ─── Validate each file ─────────────────────────────────────────────────────

PASS=0
FAIL=0
ERRORS=()

for FILE in "${FILES[@]}"; do
  BASENAME="$(basename "$FILE")"
  echo -n "    Validating $BASENAME ... "
  if "${AJV[@]}" validate \
    -s "$SCHEMA_FILE" \
    -r "$SPDX_SCHEMA_FILE" \
    -r "$JSF_SCHEMA_FILE" \
    -d "$FILE" \
    --allow-union-types \
    --validate-formats=false \
    --errors json \
    2>/dev/null; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    FAIL=$((FAIL + 1))
    ERRORS+=("$BASENAME")
  fi
done

echo ""
echo "==> Validation results: $PASS PASS, $FAIL FAIL"

if [ $FAIL -gt 0 ]; then
  echo "==> FAILED files:"
  for e in "${ERRORS[@]}"; do
    echo "    - $e"
  done
  exit 1
fi

echo "==> All SBOMs valid."
