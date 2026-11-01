#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Accepts registry-hosted commit images, repairs narrowly allowlisted registry
# debris, and only then promotes semantic or moving tags to the same digests.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
registry="${REGISTRY:?REGISTRY is required}"
github_sha="${GITHUB_SHA:?GITHUB_SHA is required}"
build_server="${BUILD_SERVER_REQUESTED:-false}"
build_frontends="${BUILD_FRONTENDS_REQUESTED:-false}"
server_release_ref="${SERVER_RELEASE_REF:-${SERVER_VERSION_INPUT:-}}"
frontend_release_ref="${FRONTEND_RELEASE_REF:-${FRONTEND_VERSION_INPUT:-}}"
case "${GITHUB_REF_NAME:-}" in
  publish-wip)
    server_release_ref=wip
    frontend_release_ref=wip
    ;;
  reconcile-registry-*)
    github_sha="${GITHUB_REF_NAME#reconcile-registry-}"
    server_release_ref=wip
    frontend_release_ref=wip
    ;;
  server-v*) server_release_ref="${GITHUB_REF_NAME#server-v}" ;;
  frontends-v*) frontend_release_ref="${GITHUB_REF_NAME#frontends-v}" ;;
esac
if [ "${RECOVER_SERVER_RELEASE:-false}" = true ]; then
  [ "$build_server" = true ] && [ "$build_frontends" != true ] || {
    echo "Server release recovery must select only the server component" >&2
    exit 2
  }
  [ -n "$server_release_ref" ] || {
    echo "SERVER_VERSION_INPUT is required for server release recovery" >&2
    exit 2
  }
  recovery_tag="server-v${server_release_ref}"
  git fetch origin "refs/tags/${recovery_tag}:refs/tags/${recovery_tag}"
  github_sha="$(git rev-list -n 1 "$recovery_tag")"
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "RELEASE_SOURCE_SHA=$github_sha" >>"$GITHUB_ENV"
  fi
fi
owner="myoxus"
tag_prefix="${registry}/${owner}"
evidence_dir="${RELEASE_EVIDENCE_DIR:-$repo_root/output/release-evidence/$github_sha}"

case "$registry" in
  *://*|*/*|*@*|*[[:space:]]*)
    echo "REGISTRY must contain only a host and optional port" >&2
    exit 2
    ;;
esac
printf '%s' "$github_sha" | grep -Eq '^[0-9a-f]{40}$' || {
  echo "GITHUB_SHA must be a full lowercase 40-character commit SHA" >&2
  exit 2
}
if [ "$build_server" != true ] && [ "$build_frontends" != true ]; then
  echo "At least one container component must be selected for acceptance" >&2
  exit 2
fi
[ "$build_server" != true ] || [ -n "$server_release_ref" ] || {
  echo "SERVER_RELEASE_REF is required for server acceptance" >&2
  exit 2
}
[ "$build_frontends" != true ] || [ -n "$frontend_release_ref" ] || {
  echo "FRONTEND_RELEASE_REF is required for frontend acceptance" >&2
  exit 2
}

mkdir -p "$evidence_dir"
temporary_root="$(mktemp -d)"
cleanup() {
  local exit_code=$?
  rm -rf "$temporary_root"
  local summary_file="${FORGEJO_STEP_SUMMARY:-${GITHUB_STEP_SUMMARY:-}}"
  if [ -n "$summary_file" ]; then
    {
      printf '### Container acceptance and promotion\n\n'
      printf -- '- Source: `%s`\n- Result: `%s` (exit %s)\n' "$github_sha" \
        "$([ "$exit_code" = 0 ] && echo success || echo failure)" "$exit_code"
      for component in server frontends; do
        local evidence="$evidence_dir/$component-promoted.json"
        if [ -f "$evidence" ]; then
          printf '\n#### %s: accepted digests\n\n' "$component"
          node - "$evidence" <<'NODE'
const evidence = JSON.parse(require("fs").readFileSync(process.argv[2]));
for (const item of evidence.packages) {
  console.log(`- \`${evidence.registryHost}/${evidence.owner}/${item.image}:${item.promotionTag}\` — \`${item.promotionDigest}\``);
}
NODE
        fi
      done
      printf '\nPromotion uses existing images only; no build is performed.\n'
    } >>"$summary_file" || true
  fi
  return "$exit_code"
}
trap cleanup EXIT

verify_with_retry() {
  local images="$1"
  local stage="$2"
  local promotion_tag="$3"
  local evidence="$4"
  local attempt
  local -a args
  for attempt in $(seq 1 12); do
    args=(
      --registry-host "$registry"
      --owner "$owner"
      --images "$images"
      --stage "$stage"
      --commit "$github_sha"
      --evidence "$evidence"
    )
    [ "$stage" != promoted ] || args+=(--promotion-tag "$promotion_tag")
    if node "$repo_root/build/scripts/ci/verify-container-registry-contract.mjs" "${args[@]}"; then
      return 0
    fi
    [ "$attempt" -eq 12 ] || sleep 10
  done
  return 1
}

if [ "$build_server" = true ]; then
  verify_with_retry \
    myoxus commit "" "$evidence_dir/server-commit.json"
fi
if [ "$build_frontends" = true ]; then
  verify_with_retry \
    myoxus-web-frontend,myoxus-admin-frontend commit "" \
    "$evidence_dir/frontends-commit.json"

  # The shared materializer is the consuming acceptance gate for the exact
  # registry pair. It rejects mixed OCI/release identities before installation.
  "${CONTAINER_SOURCE_ROOT:-$repo_root}/build/scripts/frontends/materialize-static-artifacts.sh" \
    --web-image "$tag_prefix/myoxus-web-frontend:$github_sha" \
    --admin-image "$tag_prefix/myoxus-admin-frontend:$github_sha" \
    --output "$temporary_root/frontends" \
    --pull
fi

CONFIRM_REGISTRY_REPAIR=remove-sha256-pseudo-versions \
  node "$repo_root/build/scripts/ci/repair-container-registry.mjs" \
  --registry-host "$registry" \
  --owner "$owner" \
  --evidence "$evidence_dir/registry-repair.json"

promote() {
  local image="$1"
  local release_ref="$2"
  local expected_previous=""
  case "$image" in
    myoxus) expected_previous="${REPAIR_SERVER_PREVIOUS_DIGEST:-}" ;;
    myoxus-web-frontend) expected_previous="${REPAIR_WEB_PREVIOUS_DIGEST:-}" ;;
    myoxus-admin-frontend) expected_previous="${REPAIR_ADMIN_PREVIOUS_DIGEST:-}" ;;
  esac
  if [ "${REPAIR_RELEASE_VERSION:-}" = "$release_ref" ]; then
    [ -n "$expected_previous" ] || {
      echo "Authorized repair $release_ref is missing the expected previous digest for $image" >&2
      return 1
    }
    IMAGE="$image" \
      TAG_PREFIX="$tag_prefix" \
      RELEASE_REF="$release_ref" \
      GITHUB_SHA="$github_sha" \
      ALLOW_RELEASE_TAG_REPAIR="$release_ref" \
      REPAIR_EXPECTED_PREVIOUS_DIGEST="$expected_previous" \
      "$repo_root/build/scripts/ci/promote-container-image.sh"
  else
    IMAGE="$image" \
      TAG_PREFIX="$tag_prefix" \
      RELEASE_REF="$release_ref" \
      GITHUB_SHA="$github_sha" \
      "$repo_root/build/scripts/ci/promote-container-image.sh"
  fi
}

if [ "$build_server" = true ]; then
  promote myoxus "$server_release_ref"
  verify_with_retry \
    myoxus promoted "$server_release_ref" "$evidence_dir/server-promoted.json"
fi
if [ "$build_frontends" = true ]; then
  promote myoxus-web-frontend "$frontend_release_ref"
  promote myoxus-admin-frontend "$frontend_release_ref"
  verify_with_retry \
    myoxus-web-frontend,myoxus-admin-frontend promoted \
    "$frontend_release_ref" "$evidence_dir/frontends-promoted.json"
fi

echo "[PASS] accepted and promoted container evidence: $evidence_dir"
