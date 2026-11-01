#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Matrix-owned Linux release package wrapper. Container image jobs stay
# matrix-driven by the Forgejo workflow, while this script owns the desktop
# package artifact contract end to end.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RELEASE_DIR="${RELEASE_DIR:-dist/release}"
LINUX_TARGETS="${LINUX_TARGETS:-deb,rpm,flatpak}"
BUILD_TYPE="${BUILD_TYPE:-stable}"
RELEASE_SCOPE="${RELEASE_SCOPE:-linux}"

# This job publishes only through the explicit Forgejo Actions artifact step.
# electron-builder otherwise mistakes Forgejo's injected GITHUB_TOKEN for an
# instruction to synthesize GitHub update publishing, even with publish=never.
unset GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN KEYGEN_TOKEN BITBUCKET_TOKEN BT_TOKEN

cd "$REPO_ROOT"

bash build/scripts/ci/verify-runner-toolchain.sh --node
bash build/scripts/ci/prepare-artifact-dir.sh "$RELEASE_DIR"

unset ELECTRON_SKIP_BINARY_DOWNLOAD
yarn install --immutable
yarn playwright install chromium
yarn run preinstall

bash build/scripts/ci/verify-linux-package-tooling.sh "$LINUX_TARGETS"

normalized_linux_targets="${LINUX_TARGETS//[[:space:]]/}"
if [[ ",$normalized_linux_targets," == *,flatpak,* ]]; then
  flatpak_remote_name="${FLATPAK_REMOTE_NAME:-flathub}"
  flatpak_remote_url="${FLATPAK_REMOTE_URL:-https://dl.flathub.org/repo/flathub.flatpakrepo}"
  flatpak remote-add --if-not-exists --user \
    "$flatpak_remote_name" \
    "$flatpak_remote_url"
fi

# The package command owns renderer, Electron and native preparation exactly
# once before cutting the immutable stage consumed by every Linux packager.
DEBUG="${DEBUG:+${DEBUG},}@malept/flatpak-bundler" \
  DISTRIBUTION=desktop \
  BUILD_TYPE="$BUILD_TYPE" \
  LINUX_TARGETS="$LINUX_TARGETS" \
  yarn myoxus @myoxus/electron make-linux

bash build/scripts/ci/collect-linux-packages.sh \
  "client/apps/electron/out/$BUILD_TYPE/make" \
  "$RELEASE_DIR/linux" \
  "$LINUX_TARGETS"

case "$RELEASE_SCOPE" in
  linux|clients)
    mkdir -p "$RELEASE_DIR/sbom"
    electron_version="$(node -p "require('./client/apps/electron/package.json').version")"
    source_commit="$(git rev-parse HEAD)"
    source_date_epoch="${SOURCE_DATE_EPOCH:-$(git show -s --format=%ct "$source_commit")}"
    desktop_sbom="$RELEASE_DIR/sbom/myoxus-desktop-${electron_version}.cdx.json"
    bash build/scripts/release/generate-sbom.sh \
      --typescript-only \
      --output "$desktop_sbom" \
      --git-revision "$source_commit" \
      --component-version "$electron_version" \
      --source-date-epoch "$source_date_epoch"

    SOURCE_DATE_EPOCH="$source_date_epoch" \
      node build/scripts/ci/write-desktop-release-metadata.mjs \
      --release-dir "$RELEASE_DIR" \
      --version "$electron_version" \
      --channel "$BUILD_TYPE" \
      --scope linux \
      --source-commit "$source_commit" \
      --sbom "$desktop_sbom"

    bash build/scripts/ci/write-release-summary.sh "$RELEASE_DIR"
    bash build/scripts/ci/write-artifact-manifest.sh "$RELEASE_DIR"
    bash build/scripts/ci/write-sha256sums.sh "$RELEASE_DIR"
    bash build/scripts/ci/verify-release-artifacts.sh "$RELEASE_DIR"
    ;;
  full)
    # The full aggregator owns the one cross-platform desktop SBOM and metadata.
    ;;
  *)
    echo "Unsupported desktop release scope: $RELEASE_SCOPE" >&2
    exit 2
    ;;
esac

find "$RELEASE_DIR" -maxdepth 3 -type f -print
