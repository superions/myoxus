#!/usr/bin/env bash
# Logs in to the OCI registry only when container publish mode is enabled.

set -euo pipefail

if [ "${PUBLISH_CONTAINERS:-false}" != "true" ]; then
  echo "Registry publish disabled; keeping container images local."
  exit 0
fi

registry="${REGISTRY:-}"
registry_user="${REGISTRY_USER:-}"
registry_password="${REGISTRY_PASSWORD:-}"

if [ -z "$registry" ]; then
  echo "Container publishing requires the MYOXUS_REGISTRY secret." >&2
  exit 1
fi
if [ -z "$registry_user" ]; then
  echo "Container publishing requires the MYOXUS_REGISTRY_USER secret." >&2
  exit 1
fi
if [ -z "$registry_password" ]; then
  echo "Container publishing requires the MYOXUS_REGISTRY_PASSWORD secret." >&2
  exit 1
fi

echo "$registry_password" | docker login "$registry" -u "$registry_user" --password-stdin
