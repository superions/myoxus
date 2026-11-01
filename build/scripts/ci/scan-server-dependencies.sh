#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Scan Cargo before compilation, or a loaded runtime/final image with --image.
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ] || { [ "$#" -eq 3 ] && [ "$3" != --image ]; }; then
  echo "Usage: scan-server-dependencies.sh <Cargo.lock|loaded-image> <output-dir> [--image]" >&2
  exit 2
fi
lockfile="$1"
output_dir="$2"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
work_dir="$(mktemp -d)"
scanner_name="myoxus-server-dependencies-$$"
cleanup() {
  docker rm -f "$scanner_name" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
# An earlier successful report must not survive an export/scanner failure.
rm -f "$output_dir/server-vulnerabilities.json"
if [ "${3:-}" != --image ] && [ -n "${SERVER_SECURITY_REF:-}" ]; then
  [[ "$SERVER_SECURITY_REF" =~ ^server-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
  git -C "$repo_root" fetch origin "refs/tags/$SERVER_SECURITY_REF:refs/tags/$SERVER_SECURITY_REF"
  git -C "$repo_root" archive "$SERVER_SECURITY_REF" server/Cargo.lock | tar -x -C "$work_dir"
  lockfile="$work_dir/server/Cargo.lock"
fi
scan_args=(--fail-on high)
if [ "${3:-}" = --image ]; then
  docker image save --output "$work_dir/image.tar" "$lockfile"
  lockfile="$work_dir/image.tar"
  source_mount="$lockfile:/source/image.tar:ro"
  scan_source=docker-archive:/source/image.tar
  # Retain unfixed findings in the report; only fixable OS High/Critical block.
  scan_args=()
else
  test -s "$lockfile"
  lockfile="$(cd "$(dirname "$lockfile")" && pwd -P)/$(basename "$lockfile")"
  source_mount="$lockfile:/source/Cargo.lock:ro"
  scan_source=dir:/source
fi
cache_dir="${CI_RUNNER_CACHE:-/var/cache/ci-runner}/grype"
mkdir -p "$cache_dir"
cache_dir="$(cd "$cache_dir" && pwd -P)"

# No Docker socket, credentials or repository checkout reach the pinned scanner.
# Update checks fail closed; a stopped database feed expires after 72 hours.
set +e
timeout --signal=TERM --kill-after=15s 300s docker run --rm \
  --name "$scanner_name" \
  --user "$(id -u):$(id -g)" --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --volume "$source_mount" \
  --volume "$output_dir:/scan" --volume "$cache_dir:/cache" \
  --env GRYPE_DB_CACHE_DIR=/cache \
  --env GRYPE_DB_AUTO_UPDATE=true \
  --env GRYPE_DB_REQUIRE_UPDATE_CHECK=true \
  --env GRYPE_DB_VALIDATE_AGE=true \
  --env GRYPE_DB_MAX_ALLOWED_BUILT_AGE=72h \
  docker.io/anchore/grype:v0.118.0@sha256:8a93fc48da96bd6ec5981279d099b69de11541dc68fdf222fb9161f8ff284af7 \
  "$scan_source" --name myoxus-server-dependencies \
  ${scan_args[@]+"${scan_args[@]}"} --output json --file /scan/server-vulnerabilities.json
status=$?
set -e
if [ -s "$output_dir/server-vulnerabilities.json" ]; then
  if ! jq -e '.descriptor.name == "grype" and (.matches | type == "array")' \
    "$output_dir/server-vulnerabilities.json" >/dev/null; then
    echo "Invalid server dependency report; build is blocked." >&2
    exit 1
  fi
  jq -r '.matches[] | select(.vulnerability.severity == "High" or .vulnerability.severity == "Critical") | "\(.vulnerability.severity) \(.vulnerability.id): \(.artifact.name) \(.artifact.version) (fixed: \(.vulnerability.fix.versions | join(", ")))"' \
    "$output_dir/server-vulnerabilities.json"
fi
if [ "$status" -ne 0 ]; then
  echo "Server dependency scan failed (status $status); build is blocked." >&2
  exit "$status"
fi
test -s "$output_dir/server-vulnerabilities.json"
if [ "${3:-}" = --image ]; then
  jq -e '.distro.name == "debian"' "$output_dir/server-vulnerabilities.json" >/dev/null || {
    echo "Missing Debian OS scan coverage; image is blocked." >&2
    exit 1
  }
  jq -e '[.matches[] | select(.artifact.type == "deb" and
    (.vulnerability.severity == "High" or .vulnerability.severity == "Critical") and
    .vulnerability.fix.state == "fixed")] | length == 0' \
    "$output_dir/server-vulnerabilities.json" >/dev/null || {
    echo "Fixable High/Critical OS vulnerabilities; image is blocked." >&2
    exit 1
  }
fi
echo "Server dependency security scan passed."
