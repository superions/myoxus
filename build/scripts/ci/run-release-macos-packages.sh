#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
cd "$repo_root"
test "${GITHUB_REPOSITORY:?}" = myoxus/myoxus
test "${GITHUB_REF:?}" = "refs/tags/clients-v${MYOXUS_RELEASE_VERSION:?}"
test "$(git rev-parse HEAD)" = "${GITHUB_SHA:?}"
test -z "$(git status --short)"
node build/scripts/ci/verify-component-release-version.mjs \
  --component desktop --release-ref "$MYOXUS_RELEASE_VERSION"
for secret in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  test -z "${!secret:-}" || {
    printf 'Normal macOS client publication must not consume %s\n' "$secret" >&2
    exit 1
  }
done
. build/scripts/ci/verify-macos-electron-toolchain.sh x64
. build/scripts/ci/verify-macos-electron-toolchain.sh arm64
yarn install --immutable
yarn playwright install chromium

release_dir=dist/release-macos
test ! -e "$release_dir"
mkdir -p "$release_dir/macos" "$release_dir/sbom" output/macos-client-release
signatures="$PWD/output/macos-client-release/signatures.json"
printf '{}\n' >"$signatures"
export BUILD_TYPE="${BUILD_TYPE:?}" DISTRIBUTION=desktop MYOXUS_ENV=production
product=Myoxus
if [ "$BUILD_TYPE" != stable ]; then product="Myoxus-$BUILD_TYPE"; fi

# One owning runner builds the complete platform set; no partial release or
# cross-run artifact merge can publish only one architecture.
for arch in x64 arm64; do
  yarn workspace @myoxus/electron package --platform darwin --arch "$arch"
  app="client/apps/electron/out/$BUILD_TYPE/$product-darwin-$arch/$product.app"
  bash build/scripts/ci/verify-macos-bundle-architecture.sh "$app" "$arch"
  bash build/scripts/ci/verify-macos-adhoc-signature.sh "$app"
  SKIP_PACKAGE=1 yarn workspace @myoxus/electron make --platform darwin --arch "$arch"
  make_root="client/apps/electron/out/$BUILD_TYPE/make/desktop-darwin-$arch"
  bash build/scripts/ci/verify-macos-packaging-artifacts.sh "$make_root" "$arch" --ad-hoc
  if [ "$arch" = x64 ]; then
    CARGO_BUILD_TARGET=x86_64-apple-darwin \
      build/scripts/test/run.sh --suite electron.vitest --strict
  else
    node build/scripts/ci/macos-build-only-evidence.mjs \
      "$make_root" output/macos-client-release/arm64
  fi
  for format in dmg zip; do
    name="myoxus-$MYOXUS_RELEASE_VERSION-$BUILD_TYPE-macos-$arch.$format"
    test -s "$make_root/$name"
    cp "$make_root/$name" "$release_dir/macos/$name"
    node --input-type=module - "$signatures" "$release_dir/macos/$name" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const [evidencePath, artifact] = process.argv.slice(2);
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
evidence[path.basename(artifact)] = {
  status: "ad-hoc",
  verifier: "codesign",
  sha256: crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex"),
};
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
NODE
  done
done

source_epoch="$(git show -s --format=%ct "$GITHUB_SHA")"
sbom="$release_dir/sbom/myoxus-desktop-$MYOXUS_RELEASE_VERSION.cdx.json"
bash build/scripts/release/generate-sbom.sh \
  --typescript-only --output "$sbom" --git-revision "$GITHUB_SHA" \
  --component-version "$MYOXUS_RELEASE_VERSION" --source-date-epoch "$source_epoch"
SOURCE_DATE_EPOCH="$source_epoch" \
  node build/scripts/ci/write-desktop-release-metadata.mjs \
    --release-dir "$release_dir" --version "$MYOXUS_RELEASE_VERSION" \
    --channel "$BUILD_TYPE" --scope macos --source-commit "$GITHUB_SHA" \
    --source-repository "$GITHUB_REPOSITORY" \
    --builder-id "https://git.blume29.de/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_NUMBER" \
    --run-id "$GITHUB_RUN_NUMBER" --sbom "$sbom" --signature-evidence "$signatures"
bash build/scripts/ci/write-release-summary.sh "$release_dir"
printf '\n## macOS coverage\n\nAd-hoc signed; no Apple Developer ID or notarization.\nBoth architectures: relocated DMG/ZIP, native dependency closure, architecture and signatures verified.\nx64: native Electron unit suite passed.\nARM64: cross-built on x64; native runtime and update tests NOT RUN.\n' >>"$release_dir/RELEASE.md"
bash build/scripts/ci/write-artifact-manifest.sh "$release_dir"
bash build/scripts/ci/write-sha256sums.sh "$release_dir"
bash build/scripts/ci/verify-release-artifacts.sh "$release_dir" --require-publishable
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf 'macOS x64 and ARM64: verified DMG/ZIP and release metadata. ARM64 native runtime tests NOT RUN. Ad-hoc signing, no notarization.\n' >>"$GITHUB_STEP_SUMMARY"
fi
