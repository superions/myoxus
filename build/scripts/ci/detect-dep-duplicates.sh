#!/usr/bin/env bash
# detect-dep-duplicates.sh — find packages resolved to multiple versions in yarn.lock
#
# Parses yarn.lock for packages that appear at 2+ different resolved versions.
# Outputs a human-readable report and optionally writes docs/dev/dep-duplicates-report.md
#
# Usage:
#   ./build/scripts/ci/detect-dep-duplicates.sh              # print table only
#   ./build/scripts/ci/detect-dep-duplicates.sh --report     # also write markdown report
#   ./build/scripts/ci/detect-dep-duplicates.sh --json       # JSON output

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
YARN_LOCK="$REPO_ROOT/yarn.lock"
TRIAGE_FILE="$REPO_ROOT/docs/dev/dep-duplicates-triage.tsv"
WRITE_REPORT=false
JSON_OUT=false
THRESHOLD=1  # report packages with > THRESHOLD versions

# A tracked dependency report describes the lockfile snapshot, not the wall
# clock of the runner. Binding the date to the lockfile commit keeps repeated
# release checks byte-stable until dependency inputs actually change.
SNAPSHOT_DATE="$(git -C "$REPO_ROOT" log -1 --format=%cs -- yarn.lock)"
if [[ -z "$SNAPSHOT_DATE" ]]; then
  echo "ERROR: cannot resolve the yarn.lock snapshot date" >&2
  exit 1
fi

for arg in "$@"; do
  case "$arg" in
    --report) WRITE_REPORT=true ;;
    --json) JSON_OUT=true ;;
    --threshold=*) THRESHOLD="${arg#*=}" ;;
  esac
done

if [[ ! -f "$YARN_LOCK" ]]; then
  echo "ERROR: yarn.lock not found at $YARN_LOCK" >&2
  exit 1
fi

# Parse yarn.lock: extract (package_name, resolved_version) pairs
# yarn.lock format:
#   "pkg@^1.0.0, pkg@^1.2.0":     <- spec line (quoted or unquoted)
#     version: "1.4.0"             <- resolved version
#   or:
#   pkg@npm:^1.0.0:               <- unquoted spec line
#     version: 1.4.0

tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT

# Use python for reliable yarn.lock parsing (awk struggles with multi-spec entries)
python3 - "$YARN_LOCK" <<'PYEOF' > "$tmpfile"
import sys, re, collections

lock_path = sys.argv[1]
pkg_versions = collections.defaultdict(set)
current_pkgs = []

with open(lock_path, 'r', encoding='utf-8') as f:
    for line in f:
        line = line.rstrip('\n')
        # Spec line: starts with a non-whitespace char and ends with ":"
        if line and not line.startswith(' ') and not line.startswith('#') and line.rstrip().endswith(':'):
            specs_raw = line.rstrip(':').strip('"')
            # Multiple specs separated by ", "
            specs = [s.strip().strip('"') for s in specs_raw.split(',')]
            # Extract package name: everything before @ (or @npm:, @patch: etc)
            names = set()
            for spec in specs:
                spec = spec.strip()
                # handle scoped packages like @scope/pkg@version
                if spec.startswith('@'):
                    # @scope/pkg@constraint -> @scope/pkg
                    m = re.match(r'^(@[^@]+)@', spec)
                    if m:
                        names.add(m.group(1))
                else:
                    m = re.match(r'^([^@]+)@', spec)
                    if m:
                        names.add(m.group(1))
            current_pkgs = list(names)
        # Version line inside a block
        elif current_pkgs and re.match(r'^\s+version:?\s+"?([^"]+)"?\s*$', line):
            m = re.match(r'^\s+version:?\s+"?([^"]+)"?\s*$', line)
            if m:
                version = m.group(1)
                for pkg in current_pkgs:
                    pkg_versions[pkg].add(version)
                current_pkgs = []
        # Reset on empty line
        elif not line.strip():
            current_pkgs = []

# Print: pkg\tv1,v2,...
for pkg, versions in sorted(pkg_versions.items()):
    if len(versions) > 1:
        print(f"{pkg}\t{','.join(sorted(versions))}")
PYEOF

# Count total duplicates
TOTAL=$(wc -l < "$tmpfile" | tr -d ' ')

has_resolution_for_package() {
  local pkg="$1"
  python3 - "$REPO_ROOT/package.json" "$pkg" <<'PYEOF'
import json
import re
import sys

package_json_path = sys.argv[1]
target = sys.argv[2]

with open(package_json_path, encoding="utf-8") as f:
    resolutions = json.load(f).get("resolutions", {})


def resolution_package_name(key: str) -> str:
    # Yarn resolution keys can be plain package names (`typescript`) or
    # descriptors (`pkg@npm:^1`, `@scope/pkg@npm:^1`). Only compare the
    # package identity, never arbitrary substrings.
    if key.startswith("@"):
        match = re.match(r"^(@[^/]+/[^@]+)(?:@|$)", key)
    else:
        match = re.match(r"^([^@/]+)(?:@|$)", key)
    return match.group(1) if match else key


found = any(resolution_package_name(key) == target for key in resolutions)
sys.exit(0 if found else 1)
PYEOF
}

triage_action_for_package() {
  local pkg="$1"

  [[ -f "$TRIAGE_FILE" ]] || return 1

  python3 - "$TRIAGE_FILE" "$pkg" <<'PYEOF'
import sys

triage_path = sys.argv[1]
target = sys.argv[2]

with open(triage_path, encoding="utf-8") as f:
    for raw_line in f:
        line = raw_line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t", 1)
        if len(parts) != 2:
            continue
        package, action = parts
        if package == "package":
            continue
        if package == target:
            print(action)
            sys.exit(0)

sys.exit(1)
PYEOF
}

if $JSON_OUT; then
  echo "["
  first=true
  while IFS=$'\t' read -r pkg versions; do
    $first || echo ","
    first=false
    IFS=',' read -ra ver_arr <<< "$versions"
    ver_json=$(printf '"%s",' "${ver_arr[@]}" | sed 's/,$//')
    printf '  {"package":"%s","versions":[%s]}' "$pkg" "$ver_json"
  done < "$tmpfile"
  echo ""
  echo "]"
  exit 0
fi

# Human-readable table
echo "=== Yarn Dependency Duplicates Report ==="
echo "Generated: $SNAPSHOT_DATE"
echo "Source: yarn.lock"
echo ""
printf "%-50s %s\n" "PACKAGE" "VERSIONS"
printf "%-50s %s\n" "--------------------------------------------------" "-------------------------"
while IFS=$'\t' read -r pkg versions; do
  printf "%-50s %s\n" "$pkg" "$versions"
done < "$tmpfile"
echo ""
echo "Total packages with duplicate versions: $TOTAL"

if [[ "$TOTAL" -eq 0 ]]; then
  echo "No duplicates found — yarn resolutions are consistent."
else
  echo ""
  echo "Note: Some duplicates are expected (incompatible peer requirements)."
  echo "Review the list and consider adding yarn 'resolutions' entries for packages"
  echo "where a single version is safe."
fi

# Write markdown report if requested
if $WRITE_REPORT; then
  REPORT_FILE="$REPO_ROOT/docs/dev/dep-duplicates-report.md"
  echo ""
  echo "Writing report to: $REPORT_FILE"
  mkdir -p "$(dirname "$REPORT_FILE")"
  {
    echo "# Dependency Duplicates Report"
    echo ""
    echo "**Auto-generated by \`build/scripts/ci/detect-dep-duplicates.sh --report\`**"
    echo ""
    echo "Lockfile snapshot: $SNAPSHOT_DATE"
    echo ""
    echo "---"
    echo ""
    echo "## Summary"
    echo ""
    echo "Packages resolved to multiple versions in \`yarn.lock\`: **$TOTAL**"
    echo ""
    echo "Target: < 10 duplicates."
    echo ""
    echo "### Triage Summary"
    echo ""
    if [[ -f "$TRIAGE_FILE" ]]; then
      python3 - "$tmpfile" "$TRIAGE_FILE" <<'PYEOF'
import collections
import sys

duplicates_path = sys.argv[1]
triage_path = sys.argv[2]

with open(duplicates_path, encoding="utf-8") as f:
    packages = [line.split("\t", 1)[0] for line in f if line.strip()]

triage = {}
with open(triage_path, encoding="utf-8") as f:
    for raw_line in f:
        line = raw_line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t", 1)
        if len(parts) != 2 or parts[0] == "package":
            continue
        triage[parts[0]] = parts[1]

counts = collections.Counter()
for package in packages:
    action = triage.get(package, "Review")
    counts[action.split(":", 1)[0]] += 1

for label in ("High", "Medium", "Low", "Accept", "Has resolution", "Review"):
    if counts[label]:
        print(f"- **{label}**: {counts[label]}")
PYEOF
    else
      echo "- **Review**: $TOTAL"
    fi
    echo ""
    echo "---"
    echo ""
    echo "## Cleanup Priority"
    echo ""
    echo "This section is emitted by the report generator so it stays attached to"
    echo "fresh duplicate scans. It describes the cleanup order; it does not mean"
    echo "the next priority should be applied without review."
    echo ""
    echo "### Recommended Order"
    echo ""
    echo "| Priority | Area | Status | Suggested cleanup |"
    echo "| --- | --- | --- | --- |"
    echo "| P0 | Report accuracy and guardrails | Implemented in the generator. \`Has resolution\` now matches exact resolution package identities, including Yarn descriptor keys such as \`pkg@npm:^1\` and \`@scope/pkg@npm:^1\`; substring false positives such as \`glob\` matching \`globalthis\` are avoided. | Keep this behavior covered when editing \`build/scripts/ci/detect-dep-duplicates.sh\`. Re-run this report after resolution changes. |"
    echo "| P1 | Direct workspace pins with large fan-out | Implemented for Electron build tooling. \`@myoxus/electron\` pins Electron \`44.4.5\`, \`@electron/packager 20.3.0\`, and \`esbuild 0.28.2\`; the dependency policy rejects mixed toolchain patch lines. | Keep Electron, Packager, esbuild, Vite, and Vitest aligned through exact manifest and lock-policy contracts. Require the Forgejo dependency-health and platform packaging workflows after every Electron update. |"
    echo "| P1 | Patch/minor skew inside one ecosystem | Needs package-by-package review. Current examples include OpenTelemetry core \`2.6.x\`/\`2.7.x\`, \`fsevents\` \`2.3.2\`/\`2.3.3\`, and same-major helper skews such as \`stylis\` \`4.2.x\`/\`4.3.x\`. | Prefer upgrading owning top-level packages over broad \`resolutions\`. Use resolutions only when \`yarn why\` shows compatible ranges and tests cover the consumer. |"
    echo "| P2 | Security-sensitive parser/server/runtime packages | Review separately because several are split by real major-version boundaries. Examples: \`express\` 4/5, \`body-parser\` 1/2, \`send\` 0/1, \`serve-static\` 1/2, \`path-to-regexp\` 0/6/8, \`cookie\` 0/1, \`raw-body\` 2/3, \`node-fetch\` 2/3, \`ws\` patch skew. | Do not force Express 4/5 or \`node-fetch\` 2/3 together with resolutions; track which roots require the older major and upgrade those roots when available. |"
    echo "| P2 | CLI/build-tool families with many major versions | Usually dev-only and often intentionally multi-major. Examples: Inquirer 8/12 plus \`@inquirer/*\` 3/4/5, \`commander\` 2/5/7/8/9/11/12/13, \`glob\` 7/8/10/11/13, \`fs-extra\` 7/8/9/10/11, \`rimraf\` 2/3/6, \`minimatch\` 3/5/9/10. | Reduce direct workspace pins first. For transitive older majors, prefer upgrading the parent package; avoid resolutions across majors unless the parent's range already allows the target. |"
    echo "| P3 | Low-risk duplicate noise | Accept temporarily. These are low blast-radius rows or duplicates caused by optional/platform packages. Examples: ANSI/string-width/color helper stacks, \`source-map\`, \`yallist\`, \`emoji-regex\`, \`fsevents\`, platform-specific binary packages. | Revisit after P0-P2 work lowers the count enough that remaining rows are reviewable. |"
    echo ""
    echo "### First Cleanup Batch"
    echo ""
    echo "1. P0 is done: regenerate this report whenever resolution entries change."
    echo "2. P1 direct Electron build tooling is done: \`esbuild\` and \`electron\` are aligned, and native module build scripts are available."
    echo "3. Discuss the remaining P1 ecosystem skews separately, especially Sentry and OpenTelemetry, because they span multiple app surfaces."
    echo "4. Audit server/parser packages separately and record accepted cross-major duplicates instead of forcing them."
    echo "5. After each batch, regenerate this report from the committed lock snapshot and require the changed-path Forgejo dependency-health and affected package workflows."
    echo ""
    echo "---"
    echo ""
    echo "## Duplicate Packages"
    echo ""
    echo "Triage source: \`docs/dev/dep-duplicates-triage.tsv\`"
    echo ""
    echo "| Package | Versions | Review |"
    echo "| --- | --- | --- |"
    while IFS=$'\t' read -r pkg versions; do
      action="Review"
      if action_from_triage="$(triage_action_for_package "$pkg" 2>/dev/null)"; then
        action="$action_from_triage"
      elif grep -q "\"resolutions\"" "$REPO_ROOT/package.json" 2>/dev/null; then
        if has_resolution_for_package "$pkg" 2>/dev/null; then
          action="Has resolution"
        fi
      fi
      echo "| \`$pkg\` | \`${versions//,/\`, \`}\` | $action |"
    done < "$tmpfile"
    echo ""
    echo "---"
    echo ""
    echo "## Interpretation"
    echo ""
    echo "- **Has resolution**: covered by a \`resolutions\` entry in root \`package.json\`"
    echo "- **Low**: likely cheap cleanup after checking the owning parent package and compatible ranges"
    echo "- **Medium**: package-family or tooling cleanup; reduce through parent upgrades and targeted tests"
    echo "- **High**: runtime, parser, server, native, or true major-version split; avoid cross-major resolutions"
    echo "- **Accept**: expected optional/platform/legacy duplicate unless the owning parent changes"
    echo "- **Review**: no triage entry yet; classify before changing versions"
    echo ""
    echo "### When to add a resolution"
    echo ""
    echo "1. Both versions are semver-compatible (same major) — safe to pin to the higher one"
    echo "2. The library is security-sensitive (auth, crypto, parsing) — prefer single version"
    echo "3. The duplicate significantly increases bundle size"
    echo ""
    echo "### When to accept the duplicate"
    echo ""
    echo "1. Different major versions with breaking API changes — leave as-is"
    echo "2. Peer-dependency constraints from two different major library versions"
    echo ""
    echo "---"
    echo ""
    echo "_Re-generate this report: \`build/scripts/ci/detect-dep-duplicates.sh --report\`_"
  } > "$REPORT_FILE"
  if command -v yarn >/dev/null 2>&1; then
    (
      cd "$REPO_ROOT"
      yarn exec prettier --ignore-unknown --write "$REPORT_FILE" >/dev/null 2>&1
    ) || true
  fi
  echo "Done."
fi
