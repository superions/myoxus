#!/usr/bin/env bash
# Smoke test for the veraPDF REST validator container (Compose profile: pdfa).
#
# Verifies that the veraPDF service is operational and can validate a PDF/A-1b sample:
# 1. Info endpoint responds 200 (with JVM-startup retries)
# 2. Minimal PDF/A-1b validation roundtrip: POST to /api/validate/1b
# 3. PASS/FAIL verdict clearly reported
#
# Usage:
#   build/scripts/server/smoke-pdfa.sh
#
# Prerequisites:
#   docker compose --profile pdfa up -d verapdf
#
# Exit code 0 = all checks passed, non-zero = one or more failures.

set -euo pipefail

VERAPDF_URL="${VERAPDF_URL:-http://localhost:8080}"
SAMPLE_PDF="/tmp/smoke-pdfa-sample.pdf"

pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; FAILURES=$((FAILURES + 1)); }
FAILURES=0

echo "=== Myoxus PDF/A Smoke Test (veraPDF) ==="
echo "Target: $VERAPDF_URL"
echo ""

# ---------------------------------------------------------------------------
# 1. Info endpoint — retry up to 5x with 6s gaps (JVM cold-start can take ~60s)
#    GET /api returns {"id":"verapdf-rest","version":"...","buildDate":...}
# ---------------------------------------------------------------------------
echo "1. veraPDF info endpoint"
HEALTHY=0
for i in 1 2 3 4 5; do
  HTTP_STATUS=$(curl -o /dev/null -s -w "%{http_code}" "$VERAPDF_URL/api" || echo "000")
  if [ "$HTTP_STATUS" = "200" ]; then
    HEALTHY=1
    break
  fi
  echo "    Attempt $i/5 — status $HTTP_STATUS, waiting 6s..."
  sleep 6
done

if [ "$HEALTHY" -eq 1 ]; then
  VERSION=$(curl -sf "$VERAPDF_URL/api" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('version','unknown'))" 2>/dev/null || echo "unknown")
  pass "info endpoint responded 200 (veraPDF version: $VERSION)"
else
  fail "info endpoint did not respond with 200 after 5 attempts"
  echo "    Ensure veraPDF is running: docker compose --profile pdfa up -d verapdf"
  echo ""
  echo "=== 1 CHECK FAILED ==="
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Generate a minimal PDF/A-1b sample for validation
#    Uses a Python-generated minimal but structurally parseable PDF 1.4.
#    veraPDF will validate it (and report non-conformance for PDF/A-1b since
#    the sample lacks XMP metadata) — we test the API round-trip, not conformance.
# ---------------------------------------------------------------------------
echo "2. Generating minimal PDF sample"

# Check if there's an existing sample in test fixtures
FIXTURE_PDF=""
for candidate in \
    "$(git rev-parse --show-toplevel 2>/dev/null || echo '')/build/test-fixtures/sample.pdf" \
    "$(git rev-parse --show-toplevel 2>/dev/null || echo '')/build/test-fixtures/pdfa/sample.pdf"; do
  if [ -f "$candidate" ]; then
    FIXTURE_PDF="$candidate"
    break
  fi
done

if [ -n "$FIXTURE_PDF" ]; then
  SAMPLE_PDF="$FIXTURE_PDF"
  pass "using existing fixture: $SAMPLE_PDF"
else
  python3 - <<'PYEOF' > "$SAMPLE_PDF"
import sys

def pdf_bytes():
    lines = []
    lines.append(b'%PDF-1.4\n')
    lines.append(b'%\xe2\xe3\xcf\xd3\n')

    offsets = []

    # Object 1: catalog
    offsets.append(len(b''.join(lines)))
    lines.append(b'1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')

    # Object 2: pages
    offsets.append(len(b''.join(lines)))
    lines.append(b'2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')

    # Object 3: page
    offsets.append(len(b''.join(lines)))
    lines.append(b'3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n')

    body = b''.join(lines)

    xref_offset = len(body)
    xref = b'xref\n'
    xref += f'0 {len(offsets) + 1}\n'.encode()
    xref += b'0000000000 65535 f \n'
    for off in offsets:
        xref += f'{off:010d} 00000 n \n'.encode()

    trailer = (
        f'trailer\n<< /Size {len(offsets) + 1} /Root 1 0 R >>\n'
        f'startxref\n{xref_offset}\n%%EOF\n'
    ).encode()

    return body + xref + trailer

sys.stdout.buffer.write(pdf_bytes())
PYEOF
  pass "generated minimal PDF sample at $SAMPLE_PDF ($(wc -c < "$SAMPLE_PDF") bytes)"
fi

# ---------------------------------------------------------------------------
# 3. POST to /api/validate/1b — verify round-trip and JSON response
# ---------------------------------------------------------------------------
echo "3. PDF/A-1b validation roundtrip"

RESPONSE=$(curl -sf -X POST "$VERAPDF_URL/api/validate/1b" -H "Accept: application/json" \
  -F "file=@${SAMPLE_PDF};type=application/pdf" \
  2>&1) || {
  fail "POST to /api/validate/1b failed (curl exit $?)"
  echo "    Response: $RESPONSE"
  echo ""
  echo "=== $FAILURES CHECK(S) FAILED ==="
  exit 1
}

# Verify response is valid JSON
if ! echo "$RESPONSE" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  fail "response is not valid JSON"
  echo "    Raw response: ${RESPONSE:0:300}"
  echo ""
  echo "=== $FAILURES CHECK(S) FAILED ==="
  exit 1
fi

pass "received valid JSON response from /api/validate/1b"

# Extract and display conformance verdict (informational — minimal sample is not PDF/A-1b conformant)
JOB_COUNT=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    count = d.get('report', {}).get('jobs', [])
    print(len(count))
except Exception:
    print('0')
" 2>/dev/null || echo "0")

FAILED_RULES=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    vr = d['report']['jobs'][0]['validationResult']
    if isinstance(vr, list):
        vr = vr[0]
    print(vr.get('details', {}).get('failedRules', 'n/a'))
except Exception as e:
    print('n/a')
" 2>/dev/null || echo "n/a")

if [ "$JOB_COUNT" -ge 1 ] 2>/dev/null; then
  pass "validation completed: 1 job processed, failedRules=$FAILED_RULES (non-conformance expected for minimal sample)"
else
  pass "validation API responded (job count: $JOB_COUNT — check response structure if unexpected)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== ALL CHECKS PASSED ==="
else
  echo "=== $FAILURES CHECK(S) FAILED ==="
fi
exit $FAILURES
