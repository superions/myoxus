#!/usr/bin/env bash
# Verifies and prepares the runner toolchains used by Forgejo jobs.

set -euo pipefail

CHECK_NODE=false
CHECK_RUST=false
INSTALL_RUST_COMPONENTS=false

for arg in "$@"; do
  case "$arg" in
    --node) CHECK_NODE=true ;;
    --rust) CHECK_RUST=true ;;
    --rust-components) INSTALL_RUST_COMPONENTS=true ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if ! $CHECK_NODE && ! $CHECK_RUST; then
  CHECK_NODE=true
  CHECK_RUST=true
fi

if $CHECK_NODE; then
  command -v node >/dev/null
  command -v corepack >/dev/null

  node_major="$(node -p "process.versions.node.split('.')[0]")"
  test "$node_major" = "${NODE_MAJOR:-26}"

  if [ "${MYOXUS_SKIP_COREPACK_ENABLE:-0}" != 1 ]; then
    corepack enable
  fi
  corepack prepare "yarn@${YARN_VERSION:-4.18.0}" --activate

  # SWC validates every cache ancestor. A shared ~/.cache may be group-writable;
  # use a private sibling instead without changing the runner's existing caches.
  if [ "$(uname -s)" = Linux ] && [ -n "${GITHUB_ENV:-}" ]; then
    swc_native_cache="${SWC_NATIVE_BINDING_CACHE:-${HOME}/.myoxus-swc-native-cache}"
    mkdir -p "$swc_native_cache"
    chmod 700 "$swc_native_cache"
    printf 'SWC_NATIVE_BINDING_CACHE=%s\n' "$swc_native_cache" >>"$GITHUB_ENV"
  fi

  node --version
  yarn --version
fi

if $CHECK_RUST; then
  command -v rustup >/dev/null

  rust_toolchain="${RUST_TOOLCHAIN:-stable}"

  rustup toolchain install "$rust_toolchain" --profile minimal
  rustup default "$rust_toolchain"
  if $INSTALL_RUST_COMPONENTS; then
    rustup component add rustfmt clippy
    cargo_cyclonedx_version="${CARGO_CYCLONEDX_VERSION:-0.5.9}"
    installed_cyclonedx_version="$(cargo cyclonedx --version 2>/dev/null | awk '{print $NF}' || true)"
    if [ "$installed_cyclonedx_version" != "$cargo_cyclonedx_version" ]; then
      cargo install --locked --force cargo-cyclonedx --version "$cargo_cyclonedx_version"
    fi
    test "$(cargo cyclonedx --version | awk '{print $NF}')" = "$cargo_cyclonedx_version"
  fi

  rustc --version
  cargo --version
fi
