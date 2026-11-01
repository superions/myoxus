#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs only on the existing isolated Ubuntu/Fedora installation guests.
set -euo pipefail
test "$#" -eq 2 || { echo "Usage: $0 <artifacts> <deb|rpm>" >&2; exit 2; }
artifacts=$(cd "$1" && pwd)
format="$2"
test "$(id -un)" = forgejo-runner || { echo "Run as the installation runner" >&2; exit 1; }
. /etc/os-release
case "$ID:$format" in
  ubuntu:deb|fedora:rpm) ;;
  *) echo 'Native installation checks require the dedicated installation guest' >&2; exit 1 ;;
esac
package=$(find "$artifacts/packages/$format" -maxdepth 1 -name "*.$format" -print -quit)
test -s "$package"
(cd "$artifacts"; sha256sum --check --ignore-missing SHA256SUMS >/dev/null)
# Never replace a pre-existing installation or unique operator configuration.
for path in /etc/myoxus /var/lib/myoxus /var/log/myoxus /usr/share/myoxus /usr/bin/myoxus-server /usr/bin/myoxus-cli /usr/bin/myoxus-pdf-compiler /usr/libexec/myoxus-server /usr/share/doc/myoxus-server /usr/lib/systemd/system/myoxus-api.service; do
  if sudo test -e "$path"; then echo "Existing native installation: $path" >&2; exit 1; fi
done
if [ "$format" = deb ]; then
  if dpkg-query -W -f='${db:Status-Status}\n' myoxus-server 2>/dev/null | grep -q .; then echo "Existing package metadata" >&2; exit 1; fi
else
  if rpm -q myoxus-server >/dev/null 2>&1; then echo "Existing package metadata" >&2; exit 1; fi
fi
created_user=false
created_group=false
getent passwd myoxus >/dev/null || created_user=true
getent group myoxus >/dev/null || created_group=true
cleanup_needed=true
package_present=true
cleanup() {
  if $cleanup_needed; then
    if $package_present; then
      if [ "$format" = deb ]; then sudo apt-get remove -y myoxus-server; else sudo dnf remove -y myoxus-server; fi
    fi
    if [ "$format" = deb ]; then sudo dpkg --purge myoxus-server; fi
    # None of these paths existed at admission; retain unrelated guest state.
    sudo rm -rf /etc/myoxus /var/lib/myoxus /var/log/myoxus
    if $created_user && id myoxus >/dev/null 2>&1; then sudo userdel myoxus; fi
    if $created_group && getent group myoxus >/dev/null; then sudo groupdel myoxus; fi
    cleanup_needed=false
  fi
}
trap cleanup EXIT
if [ "$format" = deb ]; then sudo apt-get install -y "$package"; else sudo dnf install -y "$package"; fi
test "$(systemctl is-active myoxus-api || true)" = inactive
/usr/bin/myoxus-cli --version
for binary in myoxus-server myoxus-cli myoxus-pdf-compiler; do
  dependencies=$(ldd "/usr/bin/$binary")
  if grep -q 'not found' <<< "$dependencies"; then printf '%s\n' "$dependencies"; exit 1; fi
done
sudo systemd-analyze verify /usr/lib/systemd/system/myoxus-api.service
sudo -u myoxus -g myoxus test ! -w /etc/myoxus/local.yaml
sudo -u myoxus -g myoxus test ! -w /etc/myoxus
sudo -u myoxus -g myoxus sh -c 'printf "{\"packageCheck\":true}\n" > /var/lib/myoxus/runtime-config/local.yaml'
for directory in storage pdf-fonts style git-sync public; do
  sudo -u myoxus -g myoxus test -w "/var/lib/myoxus/$directory"
done
sudo sh -c 'printf "# operator marker\n" >> /etc/myoxus/local.yaml'
if [ "$format" = deb ]; then
  sudo apt-get install -y --reinstall "$package"
else
  sudo dnf reinstall -y "$package"
fi
sudo grep -q 'operator marker' /etc/myoxus/local.yaml
sudo grep -q packageCheck /var/lib/myoxus/runtime-config/local.yaml
if [ "$format" = deb ]; then sudo apt-get remove -y myoxus-server; else sudo dnf remove -y myoxus-server; fi
package_present=false
sudo grep -q 'operator marker' /etc/myoxus/local.yaml
sudo grep -q packageCheck /var/lib/myoxus/runtime-config/local.yaml
cleanup
echo "Native $format installation, dependency loading, permissions, reinstall and removal passed on $(hostname)."
