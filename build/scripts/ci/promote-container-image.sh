#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Promotes one already accepted commit image by assigning another registry tag
# to the exact pulled manifest. A local pull/tag/push preserves a single-image
# manifest digest; `buildx imagetools create` may instead wrap it in a new index.

set -euo pipefail

image="${IMAGE:?IMAGE is required}"
tag_prefix="${TAG_PREFIX:?TAG_PREFIX is required}"
release_ref="${RELEASE_REF:?RELEASE_REF is required}"
github_sha="${GITHUB_SHA:?GITHUB_SHA is required}"

printf '%s' "$github_sha" | grep -Eq '^[0-9a-f]{40}$' || {
  echo "GITHUB_SHA must be a full lowercase 40-character commit SHA" >&2
  exit 2
}
if [ "$release_ref" != wip ] && ! printf '%s' "$release_ref" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "RELEASE_REF must be wip or a complete semantic version" >&2
  exit 2
fi

source_image="${tag_prefix}/${image}:${github_sha}"
target_image="${tag_prefix}/${image}:${release_ref}"

image_digest() {
  docker buildx imagetools inspect --format '{{json .Manifest.Digest}}' "$1" 2>/dev/null | tr -d '"'
}

source_digest="$(image_digest "$source_image")"
printf '%s' "$source_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || {
  echo "Commit image has no resolvable OCI digest: $source_image" >&2
  exit 1
}

previous_digest="$(image_digest "$target_image" || true)"
if [ -n "$previous_digest" ] && [ "$previous_digest" != "$source_digest" ] && [ "$release_ref" != wip ]; then
  if [ "${ALLOW_RELEASE_TAG_REPAIR:-}" != "$release_ref" ] || [ "${REPAIR_EXPECTED_PREVIOUS_DIGEST:-}" != "$previous_digest" ]; then
    echo "Refusing to replace semantic tag $target_image: existing digest $previous_digest differs from accepted digest $source_digest" >&2
    exit 1
  fi
fi

if [ "$previous_digest" != "$source_digest" ]; then
  cleanup_local_images() {
    docker image rm "$target_image" "$source_image" >/dev/null 2>&1 || true
  }
  trap cleanup_local_images EXIT
  docker pull "$source_image"
  docker tag "$source_image" "$target_image"
  docker push "$target_image"
fi

promoted_digest="$(image_digest "$target_image")"
[ "$promoted_digest" = "$source_digest" ] || {
  echo "Promotion digest mismatch for $target_image: expected $source_digest, found ${promoted_digest:-<missing>}" >&2
  exit 1
}

printf '%s\t%s\t%s\t%s\n' "$image" "$github_sha" "$release_ref" "$source_digest"
