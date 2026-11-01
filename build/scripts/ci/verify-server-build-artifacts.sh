#!/usr/bin/env bash
# Verifies the native server build artifact contract before runner staging.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <server-build-dir>" >&2
  exit 2
fi

build_dir="$(cd "$1" && pwd)"
bundle_root="$build_dir/bundle"
archive_dir="$build_dir/archives"
deb_dir="$build_dir/packages/deb"
rpm_dir="$build_dir/packages/rpm"

test -d "$build_dir"
test -d "$bundle_root"
test -d "$archive_dir"
test -d "$deb_dir"
test -d "$rpm_dir"
test -s "$build_dir/SERVER_BUILD.md"
test -s "$build_dir/ARTIFACTS.md"
test -s "$build_dir/SHA256SUMS"

bundle_dir="$(find "$bundle_root" -mindepth 1 -maxdepth 1 -type d | sort | head -1)"
if [ -z "$bundle_dir" ]; then
  echo "No server bundle directory found under $bundle_root" >&2
  exit 1
fi

test -x "$bundle_dir/bin/myoxus-server"
test -x "$bundle_dir/bin/myoxus-cli"
test -x "$bundle_dir/bin/myoxus-pdf-compiler"
test -s "$bundle_dir/config/default.yaml"
test -s "$bundle_dir/config/local.yaml.example"
test -d "$bundle_dir/templates/mail"
test -s "$bundle_dir/templates/features/catalog.yaml"
cmp -s "$bundle_dir/templates/features/release.yaml" "$bundle_dir/static/features/release.yaml"
"$bundle_dir/bin/myoxus-cli" templates feature-bundle validate-release \
  --root "$bundle_dir/templates" \
  --release-manifest "$bundle_dir/static/features/release.yaml"
for native_family in databases assistants documents; do
  test ! -e "$bundle_dir/templates/$native_family"
done
test -s "$bundle_dir/static/fonts/manifest.json"
test -s "$bundle_dir/static/icc/sRGB-v4.icc"
test -s "$bundle_dir/systemd/myoxus-api.service"
test -s "$bundle_dir/systemd/myoxus.env.example"
legal_dir="$bundle_dir/legal"
test -s "$legal_dir/LICENSE"
test -s "$legal_dir/THIRD_PARTY_NOTICES.md"
test -s "$legal_dir/SOURCE.md"
test -s "$legal_dir/provenance/components.json"
test -s "$legal_dir/sbom/server.cdx.json"
cmp -s LICENSE "$legal_dir/LICENSE"
cmp -s server/provenance/components.json "$legal_dir/provenance/components.json"

expected_revision="${SERVER_BUILD_REVISION:-${GITHUB_SHA:-$(git rev-parse HEAD)}}"
expected_version="$(cargo metadata --manifest-path server/Cargo.toml --format-version=1 --no-deps | python3 -c 'import json,sys; print(next(p["version"] for p in json.load(sys.stdin)["packages"] if p["name"] == "myoxus-api"))')"
grep -Fq "Git revision: \`$expected_revision\`" "$legal_dir/SOURCE.md"
grep -Fq "Server version: \`$expected_version\`" "$legal_dir/SOURCE.md"
jq -e --arg revision "$expected_revision" --arg version "$expected_version" '
  .metadata.component.name == "myoxus-server" and
  .metadata.component.version == $version and
  any(.metadata.component.properties[]; .name == "myoxus:git-revision" and .value == $revision) and
  any(.metadata.component.properties[]; .name == "myoxus:sbom-scope" and .value == "cargo-application")
' "$legal_dir/sbom/server.cdx.json" >/dev/null
bash build/scripts/release/validate-sbom.sh "$legal_dir/sbom/server.cdx.json" >/dev/null

if [ -e "$bundle_dir/config/local.yaml" ]; then
  echo "Operator-local config must not be bundled: $bundle_dir/config/local.yaml" >&2
  exit 1
fi

binary_count="$(find "$bundle_dir/bin" -maxdepth 1 -type f -perm -111 | wc -l | tr -d '[:space:]')"
if [ "$binary_count" -lt 1 ]; then
  echo "No executable server binaries found under $bundle_dir/bin" >&2
  exit 1
fi

archive_count="$(find "$archive_dir" -maxdepth 1 -type f \( -name '*.tar.zst' -o -name '*.tar.gz' \) | wc -l | tr -d '[:space:]')"
if [ "$archive_count" -lt 1 ]; then
  echo "No compressed server bundle archive found under $archive_dir" >&2
  exit 1
fi
archive_path="$(find "$archive_dir" -maxdepth 1 -type f \( -name '*.tar.zst' -o -name '*.tar.gz' \) | sort | head -1)"
verification_tmp="$(mktemp -d)"
trap 'rm -rf "$verification_tmp"' EXIT
archive_listing="$verification_tmp/archive-contents.txt"
tar -tf "$archive_path" > "$archive_listing"
grep -q '/legal/sbom/server.cdx.json$' "$archive_listing"
grep -q '/legal/provenance/components.json$' "$archive_listing"
archive_contents="$verification_tmp/archive"
mkdir -p "$archive_contents"
tar -xf "$archive_path" -C "$archive_contents"
archive_bundle="$archive_contents/$(basename "$bundle_dir")"
cmp -s "$archive_bundle/static/features/release.yaml" "$bundle_dir/static/features/release.yaml"
cmp -s "$archive_bundle/templates/features/release.yaml" "$archive_bundle/static/features/release.yaml"
"$archive_bundle/bin/myoxus-cli" templates feature-bundle validate-release \
  --root "$archive_bundle/templates" \
  --release-manifest "$archive_bundle/static/features/release.yaml"
for native_family in databases assistants documents; do
  test ! -e "$archive_bundle/templates/$native_family"
done

deb_count="$(find "$deb_dir" -maxdepth 1 -type f -name '*.deb' | wc -l | tr -d '[:space:]')"
if [ "$deb_count" -lt 1 ]; then
  echo "No Debian server package found under $deb_dir" >&2
  exit 1
fi
deb_path="$(find "$deb_dir" -maxdepth 1 -type f -name '*.deb' | sort | head -1)"
deb_contents="$verification_tmp/deb"
mkdir -p "$deb_contents"
dpkg-deb --extract "$deb_path" "$deb_contents"
deb_legal="$deb_contents/usr/share/doc/myoxus-server"
for relative_path in LICENSE THIRD_PARTY_NOTICES.md SOURCE.md provenance/components.json sbom/server.cdx.json; do
  test -s "$deb_legal/$relative_path"
  cmp -s "$legal_dir/$relative_path" "$deb_legal/$relative_path"
done


rpm_path="$(find "$rpm_dir" -maxdepth 1 -type f -name '*.rpm' | sort | head -1)"
test -n "$rpm_path"
rpm -qp --provides "$rpm_path" > "$verification_tmp/rpm-provides.txt"
grep -Fxq 'group(myoxus)' "$verification_tmp/rpm-provides.txt"
mkdir -p "$verification_tmp/rpm"
(cd "$verification_tmp/rpm"; rpm2cpio "$rpm_path" | cpio -idm --quiet)
for package_root in "$deb_contents" "$verification_tmp/rpm"; do
  for binary in myoxus-server myoxus-cli myoxus-pdf-compiler; do
    cmp -s "$bundle_dir/bin/$binary" "$package_root/usr/bin/$binary"
  done
  while IFS= read -r -d '' file; do
    cmp -s "$file" "$package_root/usr/share/doc/myoxus-server/${file#"$legal_dir"/}"
  done < <(find "$legal_dir" -type f -print0)
  for asset in static/fonts/manifest.json static/icc/sRGB-v4.icc static/features/release.yaml templates/features/release.yaml; do
    cmp -s "$bundle_dir/$asset" "$package_root/usr/share/myoxus/$asset"
  done
  "$package_root/usr/bin/myoxus-cli" templates feature-bundle validate-release \
    --root "$package_root/usr/share/myoxus/templates" \
    --release-manifest "$package_root/usr/share/myoxus/static/features/release.yaml"
  for family in databases assistants documents; do test ! -e "$package_root/usr/share/myoxus/templates/$family"; done
  test "$(readlink "$package_root/usr/share/myoxus/config/local.yaml")" = /etc/myoxus/local.yaml
  grep -q '^MYOXUS__CONFIG__WRITEBACK_PATH=/var/lib/myoxus/runtime-config/local.yaml$' "$package_root/etc/myoxus/myoxus.env"
done
grep -q 'packages/rpm/.*\.rpm' "$build_dir/ARTIFACTS.md"

if ! grep -q 'bundle/.*/bin/myoxus-server' "$build_dir/SERVER_BUILD.md"; then
  echo "SERVER_BUILD.md does not list server binaries." >&2
  exit 1
fi

if ! grep -Fq -- "- sha: $expected_revision" "$build_dir/SERVER_BUILD.md"; then
  echo "SERVER_BUILD.md is not bound to source revision $expected_revision." >&2
  exit 1
fi

if ! grep -q 'archives/.*\.tar\.' "$build_dir/ARTIFACTS.md"; then
  echo "ARTIFACTS.md does not list the server bundle archive." >&2
  exit 1
fi

if ! grep -q 'packages/deb/.*\.deb' "$build_dir/ARTIFACTS.md"; then
  echo "ARTIFACTS.md does not list the Debian server package." >&2
  exit 1
fi

if ! grep -q 'bundle/.*/static/fonts/manifest.json' "$build_dir/ARTIFACTS.md"; then
  echo "ARTIFACTS.md does not list server binaries." >&2
  exit 1
fi

bash build/scripts/ci/verify-artifact-manifest.sh "$build_dir" >/dev/null
bash build/scripts/ci/verify-sha256sums.sh "$build_dir" >/dev/null

echo "Server build artifact verification passed."
