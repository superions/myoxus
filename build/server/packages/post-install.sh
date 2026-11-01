#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
getent group myoxus >/dev/null || groupadd --system myoxus
id myoxus >/dev/null 2>&1 || useradd --system --gid myoxus --home-dir /var/lib/myoxus --no-create-home --shell /usr/sbin/nologin myoxus
install -d -m 0750 -o root -g myoxus /etc/myoxus
for directory in /var/lib/myoxus /var/lib/myoxus/storage /var/lib/myoxus/git-sync /var/lib/myoxus/pdf-fonts /var/lib/myoxus/style /var/lib/myoxus/public /var/lib/myoxus/runtime-config /var/log/myoxus; do
  install -d -m 0750 -o myoxus -g myoxus "$directory"
done
if [ ! -e /etc/myoxus/local.yaml ]; then
  install -m 0640 -o root -g myoxus /usr/share/doc/myoxus-server/local.yaml.example /etc/myoxus/local.yaml
fi
if [ ! -e /var/lib/myoxus/runtime-config/local.yaml ]; then
  printf '{}\n' > /var/lib/myoxus/runtime-config/local.yaml
  chown myoxus:myoxus /var/lib/myoxus/runtime-config/local.yaml
  chmod 0640 /var/lib/myoxus/runtime-config/local.yaml
fi
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || true; fi
