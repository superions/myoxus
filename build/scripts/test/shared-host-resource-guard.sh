#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

mode="${1:---check}"
drop_in_dir="/etc/systemd/system/user-.slice.d"
drop_in_file="${drop_in_dir}/50-myoxus-resource-guard.conf"
target_slice="${MYOXUS_RESOURCE_GUARD_SLICE:-user-0.slice}"
memory_high="${MYOXUS_RESOURCE_GUARD_MEMORY_HIGH:-24G}"
memory_max="${MYOXUS_RESOURCE_GUARD_MEMORY_MAX:-27G}"
swap_max="${MYOXUS_RESOURCE_GUARD_SWAP_MAX:-4G}"

render() {
  printf '%s\n' \
    '[Slice]' \
    "MemoryHigh=${memory_high}" \
    "MemoryMax=${memory_max}" \
    "MemorySwapMax=${swap_max}"
}

require_systemd() {
  command -v systemctl >/dev/null 2>&1 || {
    echo "shared-host guard: systemctl is required" >&2
    exit 2
  }
}

case "${mode}" in
  --render)
    render
    ;;
  --check)
    require_systemd
    if [[ ! -f "${drop_in_file}" ]]; then
      echo "shared-host guard: missing ${drop_in_file}" >&2
      exit 1
    fi
    diff -u <(render) "${drop_in_file}"
    systemctl show "${target_slice}" \
      --property=MemoryHigh \
      --property=MemoryMax \
      --property=MemorySwapMax \
      --property=MemoryCurrent \
      --property=MemoryPeak
    ;;
  --apply)
    require_systemd
    if [[ "${EUID}" -ne 0 ]]; then
      echo "shared-host guard: --apply requires root" >&2
      exit 2
    fi
    total_kib="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
    if [[ -z "${total_kib}" || "${total_kib}" -lt 30000000 ]]; then
      echo "shared-host guard: defaults require a host with at least 30 GB RAM" >&2
      echo "set explicit MYOXUS_RESOURCE_GUARD_MEMORY_* values for another host" >&2
      exit 2
    fi
    install -d -m 0755 "${drop_in_dir}"
    temporary="$(mktemp)"
    trap 'rm -f "${temporary}"' EXIT
    render >"${temporary}"
    install -m 0644 "${temporary}" "${drop_in_file}"
    systemctl daemon-reload
    systemctl set-property "${target_slice}" \
      "MemoryHigh=${memory_high}" \
      "MemoryMax=${memory_max}" \
      "MemorySwapMax=${swap_max}"
    "${BASH_SOURCE[0]}" --check
    ;;
  *)
    echo "usage: $0 [--check|--apply|--render]" >&2
    exit 64
    ;;
esac
