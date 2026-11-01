#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
test "$#" -ge 3 && test "$#" -le 4 || { echo "Usage: $0 <bundle-dir> <output-dir> <version> [arch]" >&2; exit 2; }
bundle="$1"
output="$2"
version="$3"
arch="${4:-amd64}"
[[ "$version" =~ ^[0-9][A-Za-z0-9.+:~_-]*$ ]] || { echo "Invalid Debian version: $version" >&2; exit 2; }
[[ "$arch" = amd64 ]] || { echo "Unsupported Debian architecture: $arch" >&2; exit 2; }
command -v dpkg-deb >/dev/null
command -v dpkg-shlibdeps >/dev/null
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
root="$work/root"
bash "$(dirname "$0")/stage-server-package.sh" "$bundle" "$root"
mkdir -p "$root/DEBIAN" "$work/debian"
printf 'Source: myoxus-server\nSection: web\nPriority: optional\nMaintainer: Myoxus Maintainers <ops@myoxus.invalid>\n' > "$work/debian/control"
# Resolve the actual ELF requirements against the builder distribution. Fixture
# scripts have no ELF imports; they retain the real runtime tool dependencies.
elfs=()
for binary in "$root/usr/bin/"*; do
  if readelf -h "$binary" >/dev/null 2>&1; then elfs+=("-e$binary"); fi
done
shlibs=""
if [ "${#elfs[@]}" -gt 0 ]; then
  shlibs=$(cd "$work"; dpkg-shlibdeps -O "${elfs[@]}" | sed -n 's/^shlibs:Depends=//p')
fi
cat > "$root/DEBIAN/control" <<EOF
Package: myoxus-server
Version: $version
Section: web
Priority: optional
Architecture: $arch
Maintainer: Myoxus Maintainers <ops@myoxus.invalid>
Installed-Size: $(du -sk "$root" | awk '{print $1}')
Depends: ${shlibs:+$shlibs, }ca-certificates, passwd, git, openssh-client
Description: Myoxus collaborative workspace server
 Rust API server, administration CLI and PDF compiler. PostgreSQL with pgvector,
 Redis and matching Web/Admin delivery are supplied separately.
EOF
printf '/etc/myoxus/myoxus.env\n' > "$root/DEBIAN/conffiles"
cat > "$root/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = configure ]; then /usr/libexec/myoxus-server/setup-state; fi
EOF
cat > "$root/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = remove ] && command -v systemctl >/dev/null 2>&1; then
  systemctl stop myoxus-api.service >/dev/null 2>&1 || true
fi
EOF
cat > "$root/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || true; fi
EOF
chmod 0755 "$root/DEBIAN/postinst" "$root/DEBIAN/prerm" "$root/DEBIAN/postrm"
mkdir -p "$output"
dpkg-deb --build --root-owner-group "$root" "$output/myoxus-server_${version}_${arch}.deb"
