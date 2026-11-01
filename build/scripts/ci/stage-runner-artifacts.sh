#!/usr/bin/env bash
# Copies CI/release artifacts to the persistent runner artifact cache.

set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <source-dir> [artifact-kind]" >&2
  exit 2
fi

source_dir="$1"
artifact_kind="${2:-}"

test -d "$source_dir"

artifact_count="$(find "$source_dir" -type f | wc -l | tr -d '[:space:]')"
if [ "$artifact_count" -lt 1 ]; then
  echo "No artifact files found under $source_dir" >&2
  exit 1
fi

repo="${GITHUB_REPOSITORY:-local/repository}"
run_id="${GITHUB_RUN_NUMBER:-manual}"
sha="${GITHUB_SHA:-local}"
artifact_root="${CI_RUNNER_CACHE:-/var/cache/ci-runner}/artifacts/${repo}"

if [ -n "$artifact_kind" ]; then
  artifact_root="${artifact_root}/${artifact_kind}"
fi

artifact_root="${artifact_root}/${run_id}-${sha}"

mkdir -p "$artifact_root"
cp -av "$source_dir"/. "$artifact_root"/
find "$artifact_root" -maxdepth 3 -type f -print
