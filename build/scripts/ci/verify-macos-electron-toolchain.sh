#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

case "${1:-}" in
  x64) target=x86_64-apple-darwin ;;
  arm64) target=aarch64-apple-darwin ;;
  *) printf 'Expected target architecture x64 or arm64\n' >&2; exit 2 ;;
esac
test "$(uname -s)" = Darwin
case "$(uname -m)" in
  x86_64|arm64) ;;
  *) printf 'Unsupported macOS build host\n' >&2; exit 1 ;;
esac

if command -v brew >/dev/null 2>&1; then
  brew_bin="$(command -v brew)"
elif test -x /usr/local/bin/brew; then
  brew_bin=/usr/local/bin/brew
elif test -x /opt/homebrew/bin/brew; then
  brew_bin=/opt/homebrew/bin/brew
else
  printf 'Homebrew is required on the macOS Electron runner\n' >&2
  exit 1
fi
brew_prefix="$($brew_bin --prefix)"
node_prefix="$($brew_bin --prefix node)"
corepack_bin="$brew_prefix/var/myoxus-ci-tools/node_modules/.bin"
test -x "$node_prefix/bin/node"
test -x "$corepack_bin/corepack"
export PATH="$corepack_bin:$node_prefix/bin:$PATH"
# Select the same Python for preflight and the isolated, hash-pinned DMG tools.
dmg_python="${MYOXUS_DMG_PYTHON:-$brew_prefix/bin/python3}"
if [[ -z "${MYOXUS_DMG_PYTHON:-}" ]]; then
  # An older default symlink must not hide an already installed supported Python.
  for candidate in "$dmg_python" \
    "$brew_prefix"/bin/python3.[0-9]* \
    "$brew_prefix"/opt/python*/bin/python3* \
    "$(command -v python3)"; do
    [[ "$candidate" == *-config ]] && continue
    if test -x "$candidate" && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
      dmg_python="$candidate"
      break
    fi
  done
fi
"$dmg_python" -c 'import sys; assert sys.version_info >= (3, 10), "DMG packaging requires Python 3.10+; set MYOXUS_DMG_PYTHON to an existing supported interpreter"'
export MYOXUS_DMG_PYTHON="$dmg_python"
export COREPACK_HOME="${HOME}/Library/Caches/node/corepack"
export MYOXUS_SKIP_COREPACK_ENABLE=1
mkdir -p "$COREPACK_HOME"
test -w "$COREPACK_HOME"
if test -n "${GITHUB_PATH:-}"; then
  printf '%s\n%s\n' "$node_prefix/bin" "$corepack_bin" >> "$GITHUB_PATH"
fi
if test -n "${GITHUB_ENV:-}"; then
  printf 'COREPACK_HOME=%s\nMYOXUS_SKIP_COREPACK_ENABLE=1\nMYOXUS_DMG_PYTHON=%s\n' "$COREPACK_HOME" "$MYOXUS_DMG_PYTHON" >> "$GITHUB_ENV"
fi

sw_vers
xcrun --find clang
xcrun --sdk macosx --show-sdk-path
command -v codesign
command -v hdiutil
command -v lipo
NODE_MAJOR=26 YARN_VERSION=4.18.0 bash build/scripts/ci/verify-runner-toolchain.sh --node --rust
rustup target add "$target"

# A private checkout umask must not change Yarn's reviewed file-package hash.
node build/scripts/ci/verify-electron-updater-source.mjs --prepare
