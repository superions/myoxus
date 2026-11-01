#!/usr/bin/env bash
# Verifies the dependency-health report artifact contract before runner staging.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <report-dir>" >&2
  exit 2
fi

report_dir="$1"

test -d "$report_dir"

bash "$(dirname "${BASH_SOURCE[0]}")/verify-artifact-manifest.sh" "$report_dir"

required_files=(
  ARTIFACTS.md
  android-gradle-osv.json
  cargo-audit.json
  dep-duplicates-report.md
  electron-cargo-audit.json
  electron-dependency-policy.json
  provenance-inventory.md
  release-dependency-policy.json
  summary.md
  yarn-audit.json
  yjs-compat.log
)

for file in "${required_files[@]}"; do
  if [ ! -s "$report_dir/$file" ]; then
    echo "Missing dependency-health artifact: $file" >&2
    exit 1
  fi
done

for file in "${required_files[@]}"; do
  if [ "$file" != "ARTIFACTS.md" ] && ! grep -q "\`$file\`" "$report_dir/ARTIFACTS.md"; then
    echo "ARTIFACTS.md does not list dependency-health artifact: $file" >&2
    exit 1
  fi
done

for report in android-gradle-osv.json yarn-audit.json cargo-audit.json electron-cargo-audit.json electron-dependency-policy.json release-dependency-policy.json dep-duplicates-report.md yjs-compat.log provenance-inventory.md; do
  if ! grep -q -- "- $report" "$report_dir/summary.md"; then
    echo "summary.md does not list dependency-health report: $report" >&2
    exit 1
  fi
done

grep -q 'release-blocking markers:' "$report_dir/summary.md"
grep -q 'U0 markers:' "$report_dir/summary.md"
grep -q 'A1/A2 markers:' "$report_dir/summary.md"

expected_revision="${GITHUB_SHA:-$(git rev-parse HEAD)}"
grep -Fq -- "- commit: $expected_revision" "$report_dir/summary.md"
for lockfile in yarn.lock Cargo.lock server/Cargo.lock; do
  expected_digest="$(sha256sum "$lockfile" | cut -d' ' -f1)"
  grep -Fq "| \`$lockfile\` | \`$expected_digest\` |" "$report_dir/summary.md"
done
grep -Eq -- '^- Node\.js: v[0-9]+' "$report_dir/summary.md"
grep -Eq -- '^- Yarn: [0-9]+' "$report_dir/summary.md"
grep -Eq -- '^- Rust: rustc [0-9]+' "$report_dir/summary.md"

echo "Dependency-health artifact verification passed."
