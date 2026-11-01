#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Matrix-owned dependency/provenance report wrapper. Repository-wide audit
# tools preserve known debt as reports, while explicit hard policies such as
# the Electron closure audit propagate their failure through the blocking
# matrix suite.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REPORT_DIR="${REPORT_DIR:-dist/ci/dependency-health}"

cd "$REPO_ROOT"

bash build/scripts/ci/verify-runner-toolchain.sh --node --rust
bash build/scripts/ci/prepare-artifact-dir.sh "$REPORT_DIR"

run_report_step() {
  local label="$1"
  shift
  echo "==> $label"
  set +e
  "$@"
  local status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    echo "dependency-health: $label reported status $status; preserving report-only step semantics" >&2
  fi
}

run_policy_step() {
  local label="$1"
  shift
  echo "==> $label"
  "$@"
}

run_report_step "Yarn audit report" \
  env AUDIT_MIN_SEVERITY=moderate \
  AUDIT_OUTPUT="$REPORT_DIR/yarn-audit.json" \
  bash build/scripts/ci/yarn-audit-local.sh

node build/scripts/ci/verify-native-dependency-locks.mjs
"${PYTHON:-python3}" build/scripts/dependencies/materialize-electron-updater.py --check
node build/scripts/ci/verify-electron-updater-source.mjs
"${PYTHON:-python3}" build/scripts/dependencies/materialize-paste-consumers.py --check
node build/scripts/ci/verify-paste-consumers.mjs
node --test build/scripts/ci/test-client-render-dependencies.mjs
GRADLE_OSV_OUTPUT="$REPORT_DIR/android-gradle-osv.json" \
  node build/scripts/ci/audit-gradle-locks-osv.mjs

# The React Router 7 advisory is limited to its unstable RSC mode. Build every
# shipping client target so the general policy can prove that the mode is also
# absent from emitted code rather than trusting source declarations alone.
for package in @myoxus/web @myoxus/admin @myoxus/electron-renderer; do
  echo "==> Build dependency-policy artifact: $package"
  yarn myoxus bundle -p "$package"
done

run_policy_step "General release dependency policy" \
  node build/scripts/ci/verify-release-dependency-policy.mjs \
  --audit-file "$REPORT_DIR/yarn-audit.json" \
  --report "$REPORT_DIR/release-dependency-policy.json"

# The general client policy and Electron's stricter Main/Preload/build policy
# are complementary. Neither policy can downgrade the other's finding.
run_policy_step "Electron dependency policy" \
  node build/scripts/ci/verify-electron-dependency-policy.mjs \
  --audit-file "$REPORT_DIR/yarn-audit.json" \
  --report "$REPORT_DIR/electron-dependency-policy.json"

# RUSTSEC-2026-0197 is currently unpatched upstream. Its only accepted
# classification is a reproducible non-callability proof; unlike broad audit
# reporting, this source guard is therefore blocking.
node build/scripts/ci/verify-merman-cgmath-reachability.mjs

run_report_step "Duplicate dependency report" \
  bash build/scripts/ci/detect-dep-duplicates.sh --report
cp -v docs/dev/dep-duplicates-report.md "$REPORT_DIR/dep-duplicates-report.md"

run_report_step "Yjs compatibility report" \
  bash -c 'bash build/scripts/ci/yjs-compat-local.sh 2>&1 | tee "$1/yjs-compat.log"' bash "$REPORT_DIR"

run_report_step "Cargo audit report" \
  bash -c 'cd server && CARGO_AUDIT_JSON_OUTPUT="../$1/cargo-audit.json" bash ../build/scripts/ci/cargo-audit-local.sh' bash "$REPORT_DIR"

# The root Cargo workspace is client-native code. Its release decision uses
# only dependencies reachable from the three Electron N-API roots per target;
# server Cargo audit remains a separate report above.
bash build/scripts/ci/audit-electron-cargo-targets.sh "$REPORT_DIR/electron-cargo"
cp "$REPORT_DIR/electron-cargo/summary.json" "$REPORT_DIR/electron-cargo-audit.json"

cp -v docs/provenance-inventory.md "$REPORT_DIR/provenance-inventory.md"
bash build/scripts/ci/write-dependency-health-summary.sh \
  "$REPORT_DIR" \
  docs/provenance-inventory.md
bash build/scripts/ci/write-artifact-manifest.sh "$REPORT_DIR"
bash build/scripts/ci/verify-dependency-health-artifacts.sh "$REPORT_DIR"
