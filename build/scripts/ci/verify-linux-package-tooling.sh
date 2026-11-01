#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Verifies the host tools required for Electron Linux package builds.

set -euo pipefail

print_version_header() {
  local version_output
  version_output="$("$@")"
  printf '%s\n' "${version_output%%$'\n'*}"
}

targets=",${1:-${LINUX_TARGETS:-deb,rpm,flatpak}},"
if [[ "$targets" == *,deb,* ]]; then
  command -v dpkg-deb >/dev/null
fi
if [[ "$targets" == *,flatpak,* ]]; then
  command -v flatpak >/dev/null || {
    echo "flatpak is required for Flatpak package creation" >&2
    exit 1
  }
  command -v flatpak-builder >/dev/null || {
    echo "flatpak-builder is required for Flatpak package creation" >&2
    exit 1
  }
  command -v eu-strip >/dev/null || {
    echo "eu-strip from elfutils is required for Flatpak module packaging" >&2
    exit 1
  }
fi
command -v pkg-config >/dev/null

if ! pkg-config --exists libpulse libpulse-simple; then
  echo "libpulse development files are required for Linux system-audio capture" >&2
  echo "Install pkg-config and libpulse-dev (Debian/Ubuntu) or" >&2
  echo "pkgconf-pkg-config and pulseaudio-libs-devel (Fedora/RHEL-compatible)" >&2
  exit 1
fi

if [[ "$targets" == *,rpm,* ]] && ! command -v rpmbuild >/dev/null 2>&1; then
  echo "rpmbuild is required for RPM package creation; rpm alone is insufficient" >&2
  exit 1
fi

if [[ "$targets" == *,deb,* ]]; then print_version_header dpkg-deb --version; fi
if [[ "$targets" == *,flatpak,* ]]; then
  flatpak --version
  flatpak-builder --version
  print_version_header eu-strip --version
fi
pkg-config --modversion libpulse libpulse-simple
if [[ "$targets" == *,rpm,* ]]; then rpmbuild --version; fi
