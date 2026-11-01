#!/usr/bin/env bash
# Post-deploy smoke test for Prometheus alert-rule files.
#
# Runs `promtool check rules` via the official `prom/prometheus` Docker image
# so no local Prometheus install is required. Validates that every
# *.yaml file under docs/ops/observability/monitoring/prometheus/ parses, has valid PromQL,
# and uses the correct rule-file schema.
#
# Covers P-Metrics-G open item: "Prometheus-Compat-Test (promtool)".
#
# Usage:
#   build/scripts/server/smoke-prometheus-rules.sh
#
# Exit code 0 = all rule files valid; non-zero = failure with details.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RULES_DIR="${REPO_ROOT}/docs/ops/observability/monitoring/prometheus"
MONITORING_DIR="${REPO_ROOT}/docs/ops/observability/monitoring"
IMAGE="${PROMTOOL_IMAGE:-prom/prometheus:latest}"

pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; FAILURES=$((FAILURES + 1)); }

FAILURES=0

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] docker is required to run promtool"
  exit 2
fi

echo "== Prometheus rule-file validation =="
echo "Rules dir: ${RULES_DIR}"
echo "Image:     ${IMAGE}"
echo

shopt -s nullglob
files=("${RULES_DIR}"/*.yaml "${RULES_DIR}"/*.yml)
if [ ${#files[@]} -eq 0 ]; then
  echo "[ERROR] no *.yaml files found in ${RULES_DIR}"
  exit 2
fi

# These series are present only as zero-valued reserved compatibility fields in
# the current metrics handler. Alerting or dashboarding on them is therefore a
# silent monitoring failure, even though the PromQL is syntactically valid.
reserved_uses=$(grep -R -n -E \
  'myoxus_worker_queue_(lag_seconds|dead_letter)|queue=\\?"search\\?"' \
  "${MONITORING_DIR}" --include='*.yaml' --include='*.yml' --include='*.json' || true)
if [ -n "${reserved_uses}" ]; then
  echo "${reserved_uses}"
  fail "monitoring assets use a reserved zero-valued worker series or unknown queue label"
else
  pass "monitoring assets avoid reserved worker series and the obsolete search queue label"
fi

for f in "${files[@]}"; do
  name="$(basename "$f")"
  output=$(docker run --rm \
    --entrypoint /bin/promtool \
    -v "${RULES_DIR}:/rules:ro" \
    "${IMAGE}" \
    check rules "/rules/${name}" 2>&1) || {
    echo "${output}"
    fail "${name}"
    continue
  }
  rules_count=$(echo "${output}" | grep -oE '[0-9]+ rules found' | head -1 || true)
  pass "${name} — ${rules_count:-checked}"
done

echo
if [ "${FAILURES}" -gt 0 ]; then
  echo "[RESULT] ${FAILURES} rule file(s) failed validation"
  exit 1
fi
echo "[RESULT] all rule files passed promtool validation"
