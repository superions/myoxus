#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

# Drain the complete job, including evidence upload, before taking its package
# lock. Taking the lock first could block a job that the runner must finish.
systemctl is-active --quiet forgejo-runner || exit 0
trap 'systemctl start forgejo-runner' EXIT
systemctl stop forgejo-runner
exec 9>/var/lib/forgejo-runner/package-maintenance.lock
flock -w 1800 9
source /etc/os-release
case "$ID" in
  ubuntu)
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --with-new-pkgs
    ;;
  fedora) dnf upgrade -y --refresh ;;
  *) echo "Unsupported install runner: $ID" >&2; exit 2 ;;
esac
node --version
test "$(node -p 'process.versions.node.split(".")[0]')" = 26
