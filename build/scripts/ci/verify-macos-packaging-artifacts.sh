#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
make_root="$(cd "${1:?Artifact directory required}" && pwd)"
arch="${2:?Target architecture required}"
signature_mode="${3:-}"
case "$signature_mode" in ""|--ad-hoc) ;; *) printf 'Unsupported signature mode\n' >&2; exit 2 ;; esac
shopt -s nullglob
dmgs=("$make_root"/*.dmg)
zips=("$make_root"/*.zip)
if [ "${#dmgs[@]}" -ne 1 ] || [ "${#zips[@]}" -ne 1 ]; then
  printf 'Expected exactly one DMG and one ZIP in %s\n' "$make_root" >&2
  exit 1
fi
work="$(mktemp -d "${TMPDIR:-/tmp}/myoxus-artifact-verify.XXXXXX")"
mounted=0
cleanup() {
  status=$?
  trap - EXIT
  if [ "$mounted" -eq 1 ]; then
    if ! hdiutil detach "$work/mount" >/dev/null; then
      printf 'Could not detach verification volume %s; retained for cleanup\n' "$work/mount" >&2
      exit 1
    fi
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

verify_app() {
  source_root="$1"
  format="$2"
  apps=("$source_root"/*.app)
  if [ "${#apps[@]}" -ne 1 ] || [ ! -d "${apps[0]}" ] || [ -L "${apps[0]}" ]; then
    printf '%s must contain exactly one real application bundle\n' "$format" >&2
    return 1
  fi
  # Validate before copying, then again in a separate location. No original
  # checkout, mounted image or prepackaged directory may satisfy a bundle link.
  bash "$script_dir/verify-macos-bundle-architecture.sh" "${apps[0]}" "$arch"
  relocated="$work/relocated-$format/$(basename "${apps[0]}")"
  ditto "${apps[0]}" "$relocated"
  bash "$script_dir/verify-macos-bundle-architecture.sh" "$relocated" "$arch"
  (
    cd "$repo_root"
    yarn run -T r client/apps/electron/scripts/verify-macos-packaged-layout.ts "$relocated"
  )
  codesign --verify --deep --strict --verbose=2 "$relocated"
  if [ "$signature_mode" = --ad-hoc ]; then
    bash "$script_dir/verify-macos-adhoc-signature.sh" "$relocated"
  fi
  printf '%s relocated application verified without executing target code\n' "$format"
}

unzip -tq "${zips[0]}"
ditto -x -k "${zips[0]}" "$work/zip"
verify_app "$work/zip" zip
hdiutil verify "${dmgs[0]}"
mkdir "$work/mount"
hdiutil attach "${dmgs[0]}" -readonly -nobrowse -noautoopen -mountpoint "$work/mount" >/dev/null
mounted=1
verify_app "$work/mount" dmg
