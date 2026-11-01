#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
test "$(id -u)" = 0
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source /etc/os-release
case "$ID" in
  ubuntu)
    test "$VERSION_ID" = 24.04
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb xauth dbus-x11
    install -m 0644 "$repo_root/build/ci/linux-install-runner/90myoxus-runner-updates" /etc/apt/apt.conf.d/90myoxus-runner-updates
    ;;
  fedora)
    test "$VERSION_ID" = 44
    dnf install -y xorg-x11-server-Xvfb xorg-x11-xauth dbus-x11
    ;;
  *) echo "Unsupported install runner: $ID $VERSION_ID" >&2; exit 2 ;;
esac
test "$(node -p 'process.versions.node.split(".")[0]')" = 26
touch /var/lib/forgejo-runner/package-maintenance.lock
chown forgejo-runner:forgejo-runner /var/lib/forgejo-runner/package-maintenance.lock
chmod 0644 /var/lib/forgejo-runner/package-maintenance.lock
install -m 0755 "$repo_root/build/scripts/ci/update-linux-install-runner.sh" /usr/local/sbin/myoxus-update-linux-install-runner
install -d /etc/systemd/system/forgejo-runner.service.d
install -m 0644 "$repo_root/build/ci/linux-install-runner/maintenance-drain.conf" /etc/systemd/system/forgejo-runner.service.d/maintenance-drain.conf
install -m 0644 "$repo_root/build/ci/linux-install-runner/myoxus-runner-update.service" /etc/systemd/system/myoxus-runner-update.service
install -m 0644 "$repo_root/build/ci/linux-install-runner/myoxus-runner-update.timer" /etc/systemd/system/myoxus-runner-update.timer
systemctl daemon-reload
systemctl enable --now myoxus-runner-update.timer
systemctl list-timers myoxus-runner-update.timer --no-pager
