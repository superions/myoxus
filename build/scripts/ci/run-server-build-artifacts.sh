#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Matrix-owned native server build wrapper. It preserves the manual release
# artifact contract from server-build.yml while making the full command locally
# reproducible through build/scripts/test/run.sh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVER_BUILD_DIR="${SERVER_BUILD_DIR:-dist/server-build}"
SERVER_BUNDLE_NAME="${SERVER_BUNDLE_NAME:-myoxus-server-linux-x64}"
SERVER_BINARY_RENAMES="${SERVER_BINARY_RENAMES:-server:myoxus-server}"
export SERVER_BINARY_RENAMES

cd "$REPO_ROOT"

for tool in dpkg-deb dpkg-shlibdeps readelf rpmbuild rpm2cpio cpio; do
  command -v "$tool" >/dev/null || { echo "Native packaging requires $tool" >&2; exit 1; }
done
bash build/scripts/ci/verify-runner-toolchain.sh --rust --rust-components
# Public source archives have no private Git history; validate their shipped bytes.
node build/scripts/ci/verify-server-source-provenance.mjs --source-tree
bash build/scripts/release/test-server-legal.sh
bash build/scripts/ci/prepare-artifact-dir.sh "$SERVER_BUILD_DIR"

bundle_dir="$SERVER_BUILD_DIR/bundle/$SERVER_BUNDLE_NAME"
git_sha="${GITHUB_SHA:-$(git rev-parse HEAD)}"
unset SERVER_BUILD_REVISION
server_version="$(
  cargo metadata --manifest-path server/Cargo.toml --format-version=1 --no-deps \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); print(next(p["version"] for p in data["packages"] if p["name"] == "myoxus-api"))'
)"
if [ -n "${SERVER_REUSE_RUN:-}" ]; then
  [[ "$SERVER_REUSE_RUN" =~ ^[0-9]+$ ]] || { echo "Expected a native build run number" >&2; exit 2; }
  candidates=("${CI_RUNNER_CACHE:-/var/cache/ci-runner}/artifacts/${GITHUB_REPOSITORY:?}/server-build/$SERVER_REUSE_RUN-"*)
  test "${#candidates[@]}" -eq 1 && test -d "${candidates[0]}"
  previous="${candidates[0]}"
  bash build/scripts/ci/verify-sha256sums.sh "$previous" >/dev/null
  retained="$previous/bundle/$SERVER_BUNDLE_NAME"
  revision=$(jq -er '.metadata.component.properties[] | select(.name == "myoxus:git-revision") | .value' "$retained/legal/sbom/server.cdx.json")
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]]
  # Repack only when the actual compiled code/assets still match; reports and
  # packaging-only corrections do not require another compiler or SBOM run.
  git diff --exit-code "$revision" HEAD -- server vendor .cargo rust-toolchain.toml LICENSE build/dependencies \
    build/scripts/ci/collect-server-binaries.sh build/scripts/ci/collect-server-runtime-assets.sh \
    docs/ops/deployment/systemd/myoxus-api.service docs/ops/deployment/systemd/myoxus.env.example >/dev/null
  export SERVER_BUILD_REVISION="$revision"
  packaging_revision=$(sed -n 's/^- packaging-sha: //p' "$previous/SERVER_BUILD.md" 2>/dev/null || true)
  # Test/workflow-only corrections reuse the finished packages as well. Keep
  # their original summary and filenames so the packaging source stays truthful.
  if [[ "$packaging_revision" =~ ^[0-9a-f]{40}$ ]] &&
    git diff --quiet "$packaging_revision" HEAD -- build/server/packages \
      build/scripts/ci/package-server-deb.sh build/scripts/ci/package-server-rpm.sh \
      build/scripts/ci/stage-server-package.sh build/scripts/ci/create-server-bundle-archive.sh; then
    cp -a "$previous/." "$SERVER_BUILD_DIR/"
    bash build/scripts/ci/verify-server-build-artifacts.sh "$SERVER_BUILD_DIR"
    echo "Reused complete native artifacts from run $SERVER_REUSE_RUN; no compilation or repackaging."
    exit 0
  fi
  mkdir -p "$(dirname "$bundle_dir")"
  cp -a "$retained" "$bundle_dir"
else
  (
    cd server
    cargo build --workspace --bins --release --locked --all-features
  )

  bash build/scripts/ci/collect-server-binaries.sh \
    server \
    "${CARGO_TARGET_DIR:-server/target}/release" \
    "$bundle_dir/bin"
  bash build/scripts/ci/collect-server-runtime-assets.sh \
    server \
    docs/ops/deployment \
    "$bundle_dir" \
    "$bundle_dir/bin/myoxus-cli"

  source_date_epoch="${SOURCE_DATE_EPOCH:-$(git show -s --format=%ct "$git_sha")}"
  bash build/scripts/release/assemble-server-legal.sh \
    "$bundle_dir/legal" \
    "$git_sha" \
    "$server_version" \
    "$source_date_epoch"

fi

bash build/scripts/ci/create-server-bundle-archive.sh \
  "$SERVER_BUILD_DIR/bundle" \
  "$SERVER_BUNDLE_NAME" \
  "$SERVER_BUILD_DIR/archives"

package_version="${server_version}+git.${git_sha:0:12}"
bash build/scripts/ci/package-server-deb.sh \
  "$SERVER_BUILD_DIR/bundle/$SERVER_BUNDLE_NAME" \
  "$SERVER_BUILD_DIR/packages/deb" \
  "$package_version" \
  amd64
bash build/scripts/ci/package-server-rpm.sh \
  "$bundle_dir" \
  "$SERVER_BUILD_DIR/packages/rpm" \
  "$package_version" \
  x86_64

bash build/scripts/ci/write-server-build-summary.sh "$SERVER_BUILD_DIR"
bash build/scripts/ci/write-artifact-manifest.sh "$SERVER_BUILD_DIR"
bash build/scripts/ci/write-sha256sums.sh "$SERVER_BUILD_DIR"
bash build/scripts/ci/verify-server-build-artifacts.sh "$SERVER_BUILD_DIR"
