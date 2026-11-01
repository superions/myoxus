#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo "DMG tooling requires macOS" >&2; exit 1; }
tools="${1:?pass the task packaging-tools directory}"
requirements="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dmg-requirements.txt"
python_bin="${MYOXUS_DMG_PYTHON:-python3}"
"$python_bin" -c 'import sys; assert sys.version_info >= (3, 10), "DMG packaging requires Python 3.10+; set MYOXUS_DMG_PYTHON to an existing supported interpreter"'
if [[ ! -f "$tools/dmg/requirements.sha256" ]] || ! cmp -s <(shasum -a 256 "$requirements") "$tools/dmg/requirements.sha256"; then
  "$python_bin" -m venv "$tools/dmg"
  "$tools/dmg/bin/python3" -m pip install --disable-pip-version-check --require-hashes -r "$requirements"
  shasum -a 256 "$requirements" > "$tools/dmg/requirements.sha256"
fi
"$tools/dmg/bin/python3" -c 'from importlib.metadata import version; print("dmgbuild " + version("dmgbuild"))'
