#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Shared native payload; package managers own dependencies and lifecycle hooks.
set -euo pipefail
test "$#" -eq 2 || { echo "Usage: $0 <bundle-dir> <package-root>" >&2; exit 2; }
bundle="$1"
root="$2"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
for binary in myoxus-server myoxus-cli myoxus-pdf-compiler; do
  test -x "$bundle/bin/$binary"
done
for file in LICENSE THIRD_PARTY_NOTICES.md SOURCE.md provenance/components.json sbom/server.cdx.json; do
  test -s "$bundle/legal/$file"
done
test -s "$bundle/config/default.yaml"
test ! -e "$bundle/config/local.yaml"
cmp -s "$bundle/templates/features/release.yaml" "$bundle/static/features/release.yaml"
"$bundle/bin/myoxus-cli" templates feature-bundle validate-release \
  --root "$bundle/templates" --release-manifest "$bundle/static/features/release.yaml"
for family in databases assistants documents; do test ! -e "$bundle/templates/$family"; done
mkdir -p "$root/usr/bin" "$root/usr/share/myoxus" "$root/usr/share/doc/myoxus-server" \
  "$root/usr/lib/systemd/system" "$root/usr/libexec/myoxus-server" "$root/etc/myoxus"
for binary in myoxus-server myoxus-cli myoxus-pdf-compiler; do
  install -m 0755 "$bundle/bin/$binary" "$root/usr/bin/$binary"
done
for directory in config templates static; do cp -a "$bundle/$directory" "$root/usr/share/myoxus/"; done
rm -f "$root/usr/share/myoxus/config/local.yaml"
ln -s /etc/myoxus/local.yaml "$root/usr/share/myoxus/config/local.yaml"
cp -a "$bundle/legal/." "$root/usr/share/doc/myoxus-server/"
install -m 0644 "$repo_root/build/server/packages/myoxus-api.service" "$root/usr/lib/systemd/system/"
install -m 0640 "$repo_root/build/server/packages/myoxus.env" "$root/etc/myoxus/"
install -m 0644 "$repo_root/build/server/packages/local.yaml.example" "$root/usr/share/doc/myoxus-server/"
install -m 0755 "$repo_root/build/server/packages/post-install.sh" "$root/usr/libexec/myoxus-server/setup-state"
