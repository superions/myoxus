#!/usr/bin/env bash
# Resolves release container tag environment variables for Forgejo workflows.

set -euo pipefail

github_env="${GITHUB_ENV:-}"
if [ -z "$github_env" ]; then
  echo "GITHUB_ENV is required" >&2
  exit 2
fi

raw_ref="${VERSION_INPUT:-${GITHUB_REF_NAME:-manual}}"
raw_ref="${raw_ref:-manual}"
publish_requested="${PUBLISH_CONTAINERS_REQUESTED:-false}"
release_component="${RELEASE_COMPONENT:-}"

case "$raw_ref" in
  publish-wip)
    raw_ref="wip"
    ;;
  server-v*)
    if [ "$release_component" != "server" ]; then
      echo "A server release tag requires RELEASE_COMPONENT=server." >&2
      exit 1
    fi
    raw_ref="${raw_ref#server-v}"
    ;;
  frontends-v*)
    if [ "$release_component" != "frontends" ]; then
      echo "A frontends release tag requires RELEASE_COMPONENT=frontends." >&2
      exit 1
    fi
    raw_ref="${raw_ref#frontends-v}"
    ;;
esac

if [ -z "$raw_ref" ]; then
  echo "Component release tags require a version after the tag prefix." >&2
  exit 1
fi

if [ "$publish_requested" = "true" ] && [ "$raw_ref" = "manual" ]; then
  echo "Manual container publishing requires a version input." >&2
  exit 1
fi

release_ref="$(
  printf '%s' "$raw_ref" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9_.-]+/-/g; s/^[.-]+//; s/[.-]+$//'
)"
release_ref="${release_ref:-manual}"
release_ref="${release_ref:0:128}"

registry="${REGISTRY:-}"
publish_containers=false
tag_prefix="local/myoxus"
registry_owner="myoxus"

if [ "$publish_requested" = "true" ] && [ -z "$registry" ]; then
  echo "Container publishing requires the MYOXUS_REGISTRY secret." >&2
  exit 1
fi

if [ "$publish_requested" = "true" ]; then
  case "$registry" in
    *://*|*/*|*@*|*[[:space:]]*)
      echo "MYOXUS_REGISTRY must contain only a registry host and optional port, never a scheme, owner, repository, or image path." >&2
      exit 1
      ;;
  esac
  if ! printf '%s' "$registry" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$'; then
    echo "MYOXUS_REGISTRY is not a valid registry host with optional port." >&2
    exit 1
  fi
  publish_containers=true
  tag_prefix="${registry}/${registry_owner}"
fi

{
  echo "RELEASE_REF=$release_ref"
  echo "TAG_PREFIX=$tag_prefix"
  echo "REGISTRY_OWNER=$registry_owner"
  echo "PUBLISH_CONTAINERS=$publish_containers"
} >>"$github_env"
