#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
test "$#" -ge 3 && test "$#" -le 4 || { echo "Usage: $0 <bundle-dir> <output-dir> <version> [arch]" >&2; exit 2; }
bundle="$1"
output="$2"
version="$3"
arch="${4:-x86_64}"
[[ "$version" =~ ^[0-9][A-Za-z0-9.+~]*$ ]] || { echo "Invalid RPM version: $version" >&2; exit 2; }
[[ "$arch" = x86_64 ]] || { echo "Unsupported RPM architecture: $arch" >&2; exit 2; }
command -v rpmbuild >/dev/null
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/BUILD" "$work/BUILDROOT" "$work/RPMS" "$work/SOURCES" "$work/SPECS" "$work/SRPMS"
bash "$(dirname "$0")/stage-server-package.sh" "$bundle" "$work/payload"
cat > "$work/SPECS/myoxus-server.spec" <<EOF
Name: myoxus-server
Version: $version
Release: 1
Summary: Myoxus collaborative workspace server
License: See /usr/share/doc/myoxus-server/LICENSE and THIRD_PARTY_NOTICES.md
URL: https://github.com/superions/myoxus
AutoReqProv: yes
Provides: user(myoxus), group(myoxus)
Requires: ca-certificates, /usr/bin/git, /usr/bin/ssh
Requires(pre): /usr/sbin/useradd, /usr/sbin/groupadd, /usr/bin/getent, /usr/bin/id
Requires(post): /usr/bin/install, /usr/bin/chown, /usr/bin/chmod

%description
Rust API server, administration CLI and PDF compiler. PostgreSQL with pgvector,
Redis and matching Web/Admin delivery are supplied separately.

%install
mkdir -p %{buildroot}
cp -a $work/payload/. %{buildroot}/

%pre
getent group myoxus >/dev/null || groupadd --system myoxus
id myoxus >/dev/null 2>&1 || useradd --system --gid myoxus --home-dir /var/lib/myoxus --no-create-home --shell /usr/sbin/nologin myoxus

%post
/usr/libexec/myoxus-server/setup-state

%preun
if [ \$1 -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
  systemctl stop myoxus-api.service >/dev/null 2>&1 || :
fi

%postun
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || :; fi

%files
%config(noreplace) %attr(0640,root,root) /etc/myoxus/myoxus.env
%attr(0750,root,myoxus) %dir /etc/myoxus
/usr/bin/myoxus-*
/usr/lib/systemd/system/myoxus-api.service
/usr/libexec/myoxus-server
/usr/share/myoxus
%license /usr/share/doc/myoxus-server
EOF
# Preserve the reviewed native payload, including its existing debug/strip and
# source/SBOM correspondence. RPM still derives ELF dependencies normally.
rpmbuild --define "_topdir $work" --define '_build_id_links none' \
  --define '__os_install_post %{nil}' --target "$arch" -bb "$work/SPECS/myoxus-server.spec"
mkdir -p "$output"
cp "$work/RPMS/$arch/"*.rpm "$output/"
