#!/usr/bin/env bash
# list-native-modules.sh — detect native modules in the Electron workspace
#
# Outputs a table of packages that require native compilation (NAPI-RS, binding.gyp,
# or postinstall/install scripts that trigger node-gyp).
#
# Usage:
#   ./build/scripts/electron/list-native-modules.sh
#   ./build/scripts/electron/list-native-modules.sh --json

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
JSON_OUT=false
[[ "${1:-}" == "--json" ]] && JSON_OUT=true

cd "$REPO_ROOT"

echo "Scanning for native modules in $REPO_ROOT ..."
echo ""

found=()

# --- 1. NAPI-RS packages (have "napi" key in package.json) ---
while IFS= read -r -d '' pkg; do
  if node -e "const p=require('$pkg'); if(p.napi) process.exit(0); process.exit(1);" 2>/dev/null; then
    name=$(node -e "const p=require('$pkg'); console.log(p.name || '?')")
    version=$(node -e "const p=require('$pkg'); console.log(p.version || '?')")
    binary=$(node -e "const p=require('$pkg'); console.log(p.napi?.binaryName || '?')")
    dir=$(dirname "$pkg")
    found+=("napi-rs|$name|$version|$binary|$dir")
  fi
done < <(find client libs virgultum -name "package.json" -not -path "*/node_modules/*" -print0 2>/dev/null)

# --- 2. binding.gyp packages ---
while IFS= read -r gyp; do
  dir=$(dirname "$gyp")
  pkg="$dir/package.json"
  if [[ -f "$pkg" ]]; then
    name=$(node -e "const p=require('./$pkg'); console.log(p.name || '?')" 2>/dev/null || echo "?")
    version=$(node -e "const p=require('./$pkg'); console.log(p.version || '?')" 2>/dev/null || echo "?")
    found+=("gyp|$name|$version|(node-gyp)|$dir")
  fi
done < <(find client libs virgultum -name "binding.gyp" -not -path "*/node_modules/*" 2>/dev/null)

# --- 3. Packages with prebuilds/ directory ---
while IFS= read -r prebuilds; do
  dir=$(dirname "$prebuilds")
  pkg="$dir/package.json"
  if [[ -f "$pkg" ]]; then
    name=$(node -e "const p=require('./$pkg'); console.log(p.name || '?')" 2>/dev/null || echo "?")
    version=$(node -e "const p=require('./$pkg'); console.log(p.version || '?')" 2>/dev/null || echo "?")
    found+=("prebuilds|$name|$version|(prebuilt binaries)|$dir")
  fi
done < <(find client libs virgultum -type d -name "prebuilds" -not -path "*/node_modules/*" 2>/dev/null)

if $JSON_OUT; then
  echo "["
  first=true
  for entry in "${found[@]}"; do
    IFS='|' read -r type name version binary dir <<< "$entry"
    $first || echo ","
    first=false
    printf '  {"type":"%s","name":"%s","version":"%s","binary":"%s","dir":"%s"}' \
      "$type" "$name" "$version" "$binary" "$dir"
  done
  echo ""
  echo "]"
else
  printf "%-12s %-35s %-10s %-25s %s\n" "TYPE" "NAME" "VERSION" "BINARY/BUILD" "PATH"
  printf "%-12s %-35s %-10s %-25s %s\n" "------------" "-----------------------------------" "----------" "-------------------------" "----"
  for entry in "${found[@]}"; do
    IFS='|' read -r type name version binary dir <<< "$entry"
    printf "%-12s %-35s %-10s %-25s %s\n" "$type" "$name" "$version" "$binary" "$dir"
  done
  echo ""
  echo "Total native modules found: ${#found[@]}"
fi
