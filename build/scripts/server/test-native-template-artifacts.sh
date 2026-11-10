#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Qualify native file packages from an existing image; never compile or install.
set -euo pipefail
trap 'printf "[FAIL] native template artifact check at line %s (exit %s)\n" "$LINENO" "$?" >&2' ERR
if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <already-built-server-image> <owned-fixture-parent>" >&2
  exit 2
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
image="$1"
mkdir -p "$2"
fixture_parent="$(cd "$2" && pwd)"
work="$(mktemp -d "$fixture_parent/native-artifacts.XXXXXX")"
container="myoxus-native-artifacts-$$-$RANDOM"
debian_container="$container-debian"
cleanup() {
  docker rm -fv "$container" "$debian_container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
for tool in docker dpkg-deb tar node jq; do command -v "$tool" >/dev/null; done
revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")"
test -n "$revision"
test -n "$version"
architecture="$(docker image inspect --format '{{.Architecture}}' "$image")"
snapshot="$work/image"
bundle_name=myoxus-server-native-template-fixture
build_dir="$work/build"
bundle="$build_dir/bundle/$bundle_name"
mkdir -p "$snapshot/bin" "$bundle/bin" "$work/outside"
docker create --name "$container" "$image" >/dev/null
for binary in myoxus-server myoxus-cli myoxus-pdf-compiler; do
  docker cp "$container:/usr/local/bin/$binary" "$snapshot/bin/$binary"
  test -x "$snapshot/bin/$binary"
done
for family in config static templates; do
  docker cp "$container:/opt/myoxus/$family" "$snapshot/$family"
done
docker cp "$container:/usr/share/doc/myoxus-server" "$snapshot/legal"
docker rm "$container" >/dev/null
cp -a "$snapshot/bin/." "$bundle/bin/"
cp -a "$snapshot/legal" "$bundle/legal"
# Exercise the normal source-to-pack collector with actual image binaries. The
# outer gate verifies all shipped inputs still match this image's revision.
bash "$REPO_ROOT/build/scripts/ci/collect-server-runtime-assets.sh" \
  "$REPO_ROOT/server" "$REPO_ROOT/docs/ops/deployment" "$bundle" "$bundle/bin/myoxus-cli"
for family in config templates static; do
  diff -r "$snapshot/$family" "$bundle/$family"
done

audit_feature_payload() {
  local templates="$1" static="$2"
  cmp "$snapshot/static/features/release.yaml" "$static/features/release.yaml"
  cmp "$templates/features/release.yaml" "$static/features/release.yaml"
  diff -r "$snapshot/templates/features" "$templates/features"
  for family in databases assistants documents; do
    test ! -e "$templates/$family"
  done
}
audit_native_binaries() {
  local binaries="$1" binary
  for binary in myoxus-server myoxus-cli myoxus-pdf-compiler; do
    test -x "$binaries/$binary"
    cmp "$snapshot/bin/$binary" "$binaries/$binary"
  done
}
validate_native_layout() {
  local distribution="$1"
  audit_native_binaries "$distribution/bin"
  audit_feature_payload "$distribution/templates" "$distribution/static"
  # No override: this uses current_exe/bin -> ../static, independently of CWD.
  (cd "$work/outside" && "$distribution/bin/myoxus-cli" templates validate-source-set --root "$distribution/templates")
}
validate_native_layout "$bundle"
# A valid mounted catalog cannot replace the binary-owned independent descriptor.
mv "$bundle/static/features/release.yaml" "$bundle/static/features/release.saved"
if (cd "$work/outside" && "$bundle/bin/myoxus-cli" templates validate-source-set --root "$bundle/templates") >"$work/missing-native-expectation.log" 2>&1; then
  echo "Native distribution accepted a missing independent release expectation" >&2
  exit 1
fi
mv "$bundle/static/features/release.saved" "$bundle/static/features/release.yaml"

# These existing helpers intentionally own compression choices (-19/-T0 when
# zstd exists); this fixture does not replace their actual packaging behavior.
bash "$REPO_ROOT/build/scripts/ci/create-server-bundle-archive.sh" \
  "$build_dir/bundle" "$bundle_name" "$build_dir/archives"
bash "$REPO_ROOT/build/scripts/ci/package-server-deb.sh" \
  "$bundle" "$build_dir/packages/deb" "$version+git.${revision:0:12}" "$architecture"
# This fixture owns archive/DEB native payloads, not the full release's RPM and
# publication manifests. Their exact binaries, descriptors and legal bytes are
# verified below; the full release artifact gate retains its separate contract.

mkdir "$work/archive" "$work/deb"
archives=("$build_dir/archives/"*.tar.*)
packages=("$build_dir/packages/deb/"*.deb)
test "${#archives[@]}" -eq 1
test "${#packages[@]}" -eq 1
tar -xf "${archives[0]}" -C "$work/archive"
dpkg-deb --extract "${packages[0]}" "$work/deb"
validate_native_layout "$work/archive/$bundle_name"
audit_native_binaries "$work/deb/usr/bin"
audit_feature_payload "$work/deb/usr/share/myoxus/templates" "$work/deb/usr/share/myoxus/static"
for file in LICENSE THIRD_PARTY_NOTICES.md SOURCE.md provenance/components.json sbom/server.cdx.json; do
  cmp "$snapshot/legal/$file" "$work/archive/$bundle_name/legal/$file"
  cmp "$snapshot/legal/$file" "$work/deb/usr/share/doc/myoxus-server/$file"
done

# The extracted Debian executable must use its real absolute /usr/bin resolver.
# The existing image supplies libraries only; there is no install/chroot/SQL or
# release-manifest override, and neither the network nor host filesystem writes.
debian_validate() {
  docker run --rm --name "$debian_container" --network none --read-only \
    --user "$(id -u):$(id -g)" --workdir /tmp \
    --entrypoint /usr/bin/myoxus-cli \
    -v "$work/deb/usr/bin/myoxus-cli:/usr/bin/myoxus-cli:ro" \
    -v "$work/deb/usr/share/myoxus/templates:/usr/share/myoxus/templates:ro" \
    -v "$work/deb/usr/share/myoxus/static:/usr/share/myoxus/static:ro" \
    "$image" templates validate-source-set --root /usr/share/myoxus/templates
}
debian_validate
mv "$work/deb/usr/share/myoxus/static/features/release.yaml" "$work/deb/usr/share/myoxus/static/features/release.saved"
if debian_validate >"$work/missing-debian-expectation.log" 2>&1; then
  echo "Debian distribution accepted a missing independent release expectation" >&2
  exit 1
fi
mv "$work/deb/usr/share/myoxus/static/features/release.saved" "$work/deb/usr/share/myoxus/static/features/release.yaml"
echo "Native archive/DEB Feature delivery, independent expectation and exact image payload verified."
