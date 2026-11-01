#!/usr/bin/env bash
# Writes the dependency-health summary from already generated report files.

set -euo pipefail

REPORT_DIR="${1:-dist/ci/dependency-health}"
PROVENANCE_FILE="${2:-docs/provenance-inventory.md}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

mkdir -p "$REPORT_DIR"

repository="${GITHUB_REPOSITORY:-$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || printf 'local/repository')}"
ref_name="${GITHUB_REF_NAME:-$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || printf 'detached')}"
git_sha="${GITHUB_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
node_version="$(node --version)"
yarn_version="$(yarn --version)"
rust_version="$(rustc --version)"

lock_digest() {
  local relative_path="$1"
  sha256sum "$REPO_ROOT/$relative_path" | cut -d' ' -f1
}

count_matches() {
  local pattern="$1"
  local file="$2"

  if [ ! -f "$file" ]; then
    printf '0'
    return
  fi

  (grep -E -i "$pattern" "$file" || true) | wc -l | tr -d '[:space:]'
}

{
  echo "# Dependency Health Summary"
  echo
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "## Source Identity"
  echo
  echo "- repository: $repository"
  echo "- ref: $ref_name"
  echo "- commit: $git_sha"
  echo "- Node.js: $node_version"
  echo "- Yarn: $yarn_version"
  echo "- Rust: $rust_version"
  echo
  echo "## Dependency Inputs"
  echo
  echo "| Path | SHA-256 |"
  echo "| --- | --- |"
  for relative_path in yarn.lock Cargo.lock server/Cargo.lock; do
    printf '| `%s` | `%s` |\n' "$relative_path" "$(lock_digest "$relative_path")"
  done
  echo
  echo "## Reports"
  echo
  find "$REPORT_DIR" -maxdepth 1 -type f ! -name summary.md -exec basename {} \; \
    | sort \
    | sed 's/^/- /'
  echo
  echo "## Provenance Counters"
  echo
  printf -- "- release-blocking markers: "
  count_matches "release-blocking" "$PROVENANCE_FILE"
  echo
  printf -- "- U0 markers: "
  count_matches "(^|[^[:alnum:]_])U0([^[:alnum:]_]|$)" "$PROVENANCE_FILE"
  echo
  printf -- "- A1/A2 markers: "
  count_matches "(^|[^[:alnum:]_])(A1|A2)([^[:alnum:]_]|$)" "$PROVENANCE_FILE"
  echo
} >"$REPORT_DIR/summary.md"
