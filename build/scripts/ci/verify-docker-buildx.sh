#!/usr/bin/env bash
# Verifies Docker Engine and Buildx availability on the runner host.

set -euo pipefail

command -v docker >/dev/null

docker version
docker buildx version

builder_info="$(docker buildx inspect --bootstrap)"
printf '%s\n' "$builder_info"

builder_driver="$({
  printf '%s\n' "$builder_info" |
    awk -F: '/^Driver:/ { sub(/^[[:space:]]+/, "", $2); print $2; exit }'
} || true)"

case "$builder_driver" in
  docker-container | kubernetes | remote)
    ;;
  docker)
    echo "The active Buildx builder uses the docker driver, which cannot export the release cache." >&2
    echo "Select a docker-container, kubernetes, or remote builder before running release jobs." >&2
    exit 1
    ;;
  *)
    echo "Unable to determine a cache-export-capable Buildx driver." >&2
    exit 1
    ;;
esac
