#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
CONTAINER_RELEASE="$REPO_ROOT/build/scripts/release/release-containers.sh"
CLIENT_RELEASE="$REPO_ROOT/build/scripts/release/release-clients.sh"

usage() {
  cat <<'EOF'
Usage:
  build/scripts/release/release.sh containers [version]
  build/scripts/release/release.sh clients [version] [clients|linux|windows|macos]
  build/scripts/release/release.sh verify-containers <version>
  build/scripts/release/release.sh verify-clients <version> [clients|linux|windows|macos]

Commands:
  containers         Publish and verify Server/Web/Admin OCI images; without
                     a version, use the next unused container patch version.
  clients            Update and check desktop dependencies in Forgejo, publish
                     one desktop source tag from the resulting commit, then
                     dispatch, wait for and verify Linux, Windows and macOS.
                     Without a version, select the next unused desktop patch.
  verify-containers  Verify existing Server/Web/Admin OCI images.
  verify-clients     Verify existing selected client releases.

Container and client releases are intentionally separate commands. Product
builds and test suites run only in Forgejo; this script only delegates release
orchestration. Successful stable publications converge in the metadata-only
public distribution overview without copying or rebuilding artifacts.
EOF
}

validate_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
    echo "Release failed: version must be a complete semantic version, got '$1'" >&2
    exit 1
  }
}

main() {
  local command="${1:-}"
  local version="${2:-}"
  local scope="${3:-clients}"
  test -n "$command" && test "$#" -le 3 && \
    { test "$command" = containers || test "$command" = clients || test -n "$version"; } || {
    usage
    exit 2
  }
  if [ "$#" -eq 3 ] && [ "$command" != clients ] && [ "$command" != verify-clients ]; then
    usage
    exit 2
  fi
  if test -n "$version"; then validate_version "$version"; fi
  cd "$REPO_ROOT"

  case "$command" in
    containers)
      "$CONTAINER_RELEASE" release "$version"
      ;;
    clients)
      "$CLIENT_RELEASE" release "$version" "$scope"
      ;;
    verify-containers)
      "$CONTAINER_RELEASE" verify "$version"
      ;;
    verify-clients)
      "$CLIENT_RELEASE" verify "$version" "$scope"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
