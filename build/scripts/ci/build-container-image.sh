#!/usr/bin/env bash
# Builds one release container image with Buildx and the shared runner cache.

set -euo pipefail

tools_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
if [ -n "${CONTAINER_SOURCE_ROOT:-}" ]; then
  cd "$CONTAINER_SOURCE_ROOT"
fi
build_mode="${CONTAINER_BUILD_MODE:-build}"
case "$build_mode" in
  build|publish-only) ;;
  *) echo "CONTAINER_BUILD_MODE must be build or publish-only" >&2; exit 2 ;;
esac
dockerfile="${DOCKERFILE:?DOCKERFILE is required}"
image="${IMAGE:?IMAGE is required}"
artifact="${ARTIFACT:?ARTIFACT is required}"
tag_prefix="${TAG_PREFIX:?TAG_PREFIX is required}"
github_sha="${GITHUB_SHA:?GITHUB_SHA is required}"
[[ "$github_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "Release container builds require the full checked-out commit SHA" >&2
  exit 2
}
publish_containers="${PUBLISH_CONTAINERS:-false}"
[ "$build_mode" != publish-only ] || [ "$publish_containers" = true ] || {
  echo "publish-only requires PUBLISH_CONTAINERS=true" >&2
  exit 2
}
export_development_image="${EXPORT_DEVELOPMENT_IMAGE:-false}"
case "$export_development_image" in
  true)
    [ "$publish_containers" = false ] || {
      echo "Development image export requires non-publishing mode" >&2
      exit 2
    }
    ;;
  false) ;;
  *) echo "EXPORT_DEVELOPMENT_IMAGE must be true or false" >&2; exit 2 ;;
esac
commit_image="${tag_prefix}/${image}:${github_sha}"

case "$artifact" in
  server)
    release_role=server
    version_build_arg=MYOXUS_SERVER_VERSION
    ;;
  web-frontend)
    release_role=web
    version_build_arg=MYOXUS_CLIENT_VERSION
    ;;
  admin-frontend)
    release_role=admin
    version_build_arg=MYOXUS_CLIENT_VERSION
    ;;
  *)
    echo "Unsupported release artifact role: $artifact" >&2
    exit 2
    ;;
esac

# Resolve the semantic product version from its authoritative repository source.
# The commit-only build must not infer product identity from a later promotion
# tag such as wip.
product_version="$(
  node "$tools_root/build/scripts/release/write-release-identity.mjs" \
    --role "$release_role" \
    --revision "$github_sha" \
    --print-version
)"
source_date_epoch="$(git show -s --format=%ct "$github_sha")"
container_evidence_dir="${CONTAINER_EVIDENCE_DIR:-dist/container-build/${artifact}}"
bash "$tools_root/build/scripts/ci/prepare-artifact-dir.sh" "$container_evidence_dir"

runner_cache="${CI_RUNNER_CACHE:-/var/cache/ci-runner}"
cache_root="${runner_cache}/buildkit/${artifact}"
cache_new="${cache_root}-new"
cache_lock="${runner_cache}/locks/container-build.lock"
cache_min_free_gib="${CI_BUILDKIT_CACHE_MIN_FREE_GIB:-24}"
# Static scratch artifacts need intermediate builder layers in the exported cache.
default_cache_export_mode=min
if [ "$release_role" != server ]; then
  default_cache_export_mode=max
fi
cache_export_mode="${CI_BUILDKIT_CACHE_EXPORT_MODE:-$default_cache_export_mode}"
artifact_lock="${runner_cache}/locks/container-${artifact}.lock"
recovery_dir="${runner_cache}/container-recovery/${artifact}/${github_sha}"
recovery_receipt="$recovery_dir/image-id"
retention_container="myoxus-release-retained-${artifact}-${github_sha}"

case "$cache_min_free_gib" in
  ''|*[!0-9]*)
    echo "CI_BUILDKIT_CACHE_MIN_FREE_GIB must be a non-negative integer" >&2
    exit 2
    ;;
esac
case "$cache_export_mode" in
  min|max) ;;
  *)
    echo "CI_BUILDKIT_CACHE_EXPORT_MODE must be min or max" >&2
    exit 2
    ;;
esac

mkdir -p "$(dirname "$cache_root")" "$(dirname "$cache_lock")"
# Preserve image/cache ownership for this artifact while other artifacts verify
# or push their completed image after releasing the shared build budget.
exec 8>"$artifact_lock"
flock 8
reuse_image=false
preserve_image=false
image_id=""
registry_digest="not published"
# A receipt binds recovery to the exact previously checked image, not merely a
# mutable Docker tag. Never fall back to a build when retained state is missing.
if [ -f "$recovery_receipt" ]; then
  preserve_image=true
  image_id="$(cat "$recovery_receipt")"
  actual_id="$(docker image inspect --format '{{.Id}}' "$commit_image")"
  [ "$image_id" = "$actual_id" ] || {
    echo "Retained image identity changed: $recovery_receipt" >&2
    exit 1
  }
  reuse_image=true
elif [ "$build_mode" = publish-only ]; then
  docker pull "$commit_image" || {
    echo "No retained or published commit image; publish-only will not build: $commit_image" >&2
    exit 1
  }
  reuse_image=true
elif [ "$publish_containers" = true ] && docker pull "$commit_image"; then
  # A later evidence/staging failure may occur after the upload completed.
  reuse_image=true
fi

if [ "$reuse_image" = false ]; then
  # Shared locking keeps new jobs compatible with older jobs that still take
  # this lock exclusively. Separate slots cap heavy builds at two per runner.
  exec 9>"$cache_lock"
  echo "Waiting for a runner container-build slot (maximum two builds)"
  flock -s 9
  while :; do
    for build_slot in 1 2; do
      exec 10>"${runner_cache}/locks/container-build-slot-${build_slot}.lock"
      if flock -n 10; then
        echo "Acquired runner container-build slot ${build_slot}"
        break 2
      fi
    done
    sleep 1
  done
fi

cache_export_active=true
cleanup_build_cache_export() {
  if $cache_export_active; then
    rm -rf -- "$cache_new"
  fi
}
identity_tmp=""
identity_container=""
runtime_image=""
cleanup_identity() {
  [ -z "$identity_container" ] || docker rm -f "$identity_container" >/dev/null 2>&1 || true
  [ -z "$identity_tmp" ] || rm -rf "$identity_tmp"
}
cleanup_loaded_image() {
  docker image rm "$commit_image" >/dev/null 2>&1 || true
}
cleanup_container_build() {
  local exit_code=$?
  # Cleanup must never turn a failed build or identity check into success.
  trap - EXIT
  [ -z "$runtime_image" ] || docker image rm "$runtime_image" >/dev/null 2>&1 || true
  if [ "$preserve_image" = true ]; then
    echo "Retained exact image for publication without rebuilding: $commit_image ($image_id)"
    echo "Recovery receipt: $recovery_receipt"
  else
    cleanup_loaded_image
  fi
  cleanup_identity
  cleanup_build_cache_export
  summary_file="${FORGEJO_STEP_SUMMARY:-${GITHUB_STEP_SUMMARY:-}}"
  if [ -n "$summary_file" ]; then
    {
      printf '### Container %s\n\n' "$artifact"
      printf -- '- Version: `%s`\n- Source: `%s`\n' "$product_version" "$github_sha"
      printf -- '- Result: `%s` (exit %s)\n' "$([ "$exit_code" = 0 ] && echo success || echo failure)" "$exit_code"
      printf -- '- Existing image reused: `%s`\n- Image: `%s`\n' "$reuse_image" "$commit_image"
      printf -- '- Image ID: `%s`\n- Registry digest: `%s`\n' "${image_id:-unavailable}" "$registry_digest"
      if [ "$preserve_image" = true ]; then
        printf -- '- Retained on runner: `%s`\n- Publish without build: `release-containers.sh publish-%s %s`\n' \
          "$recovery_receipt" "$([ "$release_role" = server ] && echo server || echo frontends)" "$product_version"
      fi
      printf '\n'
    } >>"$summary_file" || true
  fi
  exit "$exit_code"
}
trap cleanup_container_build EXIT
cleanup_build_cache_export

if [ "$reuse_image" = false ]; then
  available_kib="$(df -Pk "$(dirname "$cache_root")" | awk 'NR == 2 { print $4 }')"
  required_kib="$((cache_min_free_gib * 1024 * 1024))"
  container_build_args=(
    --pull
    --platform linux/amd64
    --file "$dockerfile"
    --build-arg "GITHUB_SHA=${github_sha}"
    --build-arg "SOURCE_DATE_EPOCH=${source_date_epoch}"
    --build-arg "${version_build_arg}=${product_version}"
    --tag "$commit_image"
  )
  if [ -n "${MYOXUS_SOURCE_PROVENANCE:-}" ] && [ "$release_role" = server ]; then
    source_provenance_sha256="$(sha256sum "$MYOXUS_SOURCE_PROVENANCE" | awk '{print $1}')"
    container_build_args+=(--secret "id=myoxus_source_provenance,src=$MYOXUS_SOURCE_PROVENANCE")
    container_build_args+=(--build-arg "MYOXUS_SOURCE_PROVENANCE_SHA256=$source_provenance_sha256")
  fi
  if [ -d "$cache_root" ] && [ "$available_kib" -lt "$required_kib" ]; then
    echo "Free space is below ${cache_min_free_gib} GiB; discarding the rebuildable ${artifact} cache"
    rm -rf -- "$cache_root"
  fi
  if [ -d "$cache_root" ]; then
    container_build_args+=(--cache-from "type=local,src=${cache_root}")
  fi

  if [ "$release_role" = server ]; then
    # Refresh the libgcc preparation in both passes; the Distroless parent is
    # refreshed by --pull. Final assembly must not restore an older OS layer.
    container_build_args+=(--no-cache-filter runtime-files,server-runtime)
    # Host environment does not cross the BuildKit boundary automatically.
    if [ -n "${CARGO_BUILD_JOBS:-}" ]; then
      container_build_args+=(--build-arg "CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}")
    fi
    runtime_image="myoxus-runtime-check:${github_sha}"
    # Build only the OS target, never the Rust builder.
    docker buildx build --pull --platform linux/amd64 --file "$dockerfile" \
      --target server-runtime --no-cache-filter runtime-files,server-runtime \
      --build-arg "GITHUB_SHA=${github_sha}" \
      --build-arg "SOURCE_DATE_EPOCH=${source_date_epoch}" \
      --build-arg "${version_build_arg}=${product_version}" \
      --tag "$runtime_image" --load .
    bash build/scripts/ci/scan-server-dependencies.sh \
      "$runtime_image" dist/container-security/runtime --image
  fi

  docker buildx build \
    "${container_build_args[@]}" \
    --cache-to "type=local,dest=${cache_new},mode=${cache_export_mode}" \
    --load \
    .
  rm -rf -- "$cache_root"
  mv "$cache_new" "$cache_root"
  cache_export_active=false
  # Release the build slot before verification/upload. The artifact lock still
  # protects its image/cache, and the compatibility lock covers only heavy work.
  flock -u 10
  flock -u 9
else
  echo "Using completed commit image without a build: $commit_image"
  cache_export_active=false
fi

identity_tmp="$(mktemp -d)"
docker image inspect "$commit_image" >"$identity_tmp/image-inspect.json"
image_id="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1]))[0].Id)' "$identity_tmp/image-inspect.json")"
# Recovery uses current orchestration but the tagged source's identity/legal
# contracts, so older shipped images retain their original source labels.
if [ "$release_role" = server ]; then
  node build/scripts/ci/verify-built-release-identity.mjs \
    --role server \
    --revision "$github_sha" \
    --server-manifest server/Cargo.toml \
    --image-inspect "$identity_tmp/image-inspect.json"
else
  identity_container="$(docker create "$commit_image" /__myoxus_static_artifact_only__)"
  docker cp "$identity_container:/myoxus-artifact/release.json" "$identity_tmp/release.json"
  docker rm "$identity_container" >/dev/null
  identity_container=""
  node build/scripts/ci/verify-built-release-identity.mjs \
    --role "$release_role" \
    --revision "$github_sha" \
    --root-manifest package.json \
    --release-json "$identity_tmp/release.json" \
    --image-inspect "$identity_tmp/image-inspect.json"
fi

if [ "$release_role" = server ]; then
  if [ "$publish_containers" = "true" ]; then
    bash build/scripts/ci/verify-server-container-legal.sh \
      "$commit_image" "$github_sha" "$identity_tmp/server-local"
  fi
fi

if [ "$release_role" = server ]; then
  # Scan the exact loaded result, including non-publishing verification builds.
  bash "$tools_root/build/scripts/ci/scan-server-dependencies.sh" \
    "$commit_image" dist/container-security/final --image
fi
if [ "$publish_containers" = "true" ]; then
  mkdir -p "$recovery_dir"
  printf '%s\n' "$image_id" >"$recovery_receipt.tmp"
  mv "$recovery_receipt.tmp" "$recovery_receipt"
  # Only checked results survive failure. Keep the receipt through all remaining
  # provenance work too, so a later failure can resume the same image.
  preserve_image=true
  # Docker image prune --all preserves images referenced by stopped containers.
  # This holder is never started and is removed only after publication succeeds.
  if docker container inspect "$retention_container" >/dev/null 2>&1; then
    [ "$(docker container inspect --format '{{.Image}}' "$retention_container")" = "$image_id" ] || {
      echo "Recovery holder refers to a different image: $retention_container" >&2
      exit 1
    }
  else
    docker create --name "$retention_container" "$image_id" /__myoxus_recovery_only__ >/dev/null
  fi
  docker push "$commit_image"
  registry_digest="$(docker image inspect --format '{{join .RepoDigests ", "}}' "$commit_image")"
fi

if [ "$release_role" = server ]; then
  verifier_args=("$commit_image" "$github_sha" "$container_evidence_dir")
  if [ "$publish_containers" = "true" ]; then
    verifier_args+=(--require-registry-digest)
  fi
  bash build/scripts/ci/verify-server-container-legal.sh "${verifier_args[@]}"
else
  cp "$identity_tmp/image-inspect.json" "$container_evidence_dir/${release_role}-image-inspect.json"
  cp "$identity_tmp/release.json" "$container_evidence_dir/${release_role}-release.json"
fi

if [ -n "${MYOXUS_SOURCE_PROVENANCE:-}" ]; then
  cp "$MYOXUS_SOURCE_PROVENANCE" "$container_evidence_dir/release-provenance.json"
fi

node "$tools_root/build/scripts/ci/verify-container-build-evidence.mjs" \
  --evidence-dir "$container_evidence_dir" \
  --role "$release_role" \
  --revision "$github_sha" \
  --version "$product_version" \
  --publish-mode "$publish_containers" >/dev/null
bash "$tools_root/build/scripts/ci/write-artifact-manifest.sh" "$container_evidence_dir"
bash "$tools_root/build/scripts/ci/write-sha256sums.sh" "$container_evidence_dir"
node "$tools_root/build/scripts/ci/verify-container-build-evidence.mjs" \
  --evidence-dir "$container_evidence_dir" \
  --role "$release_role" \
  --revision "$github_sha" \
  --version "$product_version" \
  --publish-mode "$publish_containers" >/dev/null
bash "$tools_root/build/scripts/ci/verify-artifact-manifest.sh" "$container_evidence_dir" >/dev/null
bash "$tools_root/build/scripts/ci/verify-sha256sums.sh" "$container_evidence_dir" >/dev/null

# A non-publishing development qualification must be operable without rebuilding
# on a development host. Keep the transferable image separate from sealed OCI
# provenance; neither this path nor artifact upload promotes a registry tag.
if [ "$export_development_image" = true ]; then
  development_dir="dist/development-images/${artifact}"
  bash build/scripts/ci/prepare-artifact-dir.sh "$development_dir"
  docker image save "$commit_image" | gzip -1 >"$development_dir/image.tar.gz"
  cp -a "$container_evidence_dir" "$development_dir/provenance"
  bash build/scripts/ci/write-artifact-manifest.sh "$development_dir"
  bash build/scripts/ci/write-sha256sums.sh "$development_dir"
  bash build/scripts/ci/verify-sha256sums.sh "$development_dir" >/dev/null
fi

# The registry now owns the complete image and evidence. Failed uploads never
# reach this cleanup; their tagged image and receipt remain available.
if [ "$publish_containers" = true ]; then
  docker rm "$retention_container" >/dev/null
  rm -f "$recovery_receipt"
  rmdir "$recovery_dir"
  preserve_image=false
fi
