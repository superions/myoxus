#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
exec "$ROOT_DIR/build/scripts/frontends/test-static-artifact-image.sh" \
  --role admin --dockerfile build/admin/Dockerfile
