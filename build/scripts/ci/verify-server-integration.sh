#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Server DB/Redis/MinIO integration gate. Expects isolated test services.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"

: "${TEST_DATABASE_URL:=postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test}"
: "${DATABASE_URL:=$TEST_DATABASE_URL}"
: "${TEST_REDIS_URL:=redis://localhost:6380}"
: "${REDIS_URL:=$TEST_REDIS_URL}"
: "${RUST_MIN_STACK:=16777216}"

export TEST_DATABASE_URL DATABASE_URL TEST_REDIS_URL REDIS_URL RUST_MIN_STACK

# Integration config mutations may be mirrored to YAML. Give the process an
# isolated writeback target so the gate never modifies package-local or
# operator-owned YAML. Tests set exact value preconditions in their fixtures.
CONFIG_OVERLAY_DIR="$(mktemp -d)"
cp "$SERVER_DIR/config/default.yaml" "$CONFIG_OVERLAY_DIR/local.yaml"
export MYOXUS__CONFIG__WRITEBACK_PATH="$CONFIG_OVERLAY_DIR/local.yaml"
cleanup() {
  rm -rf "$CONFIG_OVERLAY_DIR"
}
trap cleanup EXIT INT TERM

cd "$SERVER_DIR"

echo "==> Shared API contracts"
# Feature matrices have their own suites. A regular stack/CI wrapper must never
# execute the entire API-hosted integration inventory.
bash "$REPO_ROOT/build/scripts/test/api-integration-domain.sh" api.integration

echo "==> DB-backed CLI binary tests"
cargo test -p myoxus-cli --bin myoxus-cli -- --nocapture

echo "==> Redis-backed worker library tests"
cargo test -p myoxus-worker --lib -- --nocapture

if [ -n "${MINIO_ENDPOINT:-}" ]; then
  echo "==> MinIO/S3 storage integration"
  : "${MINIO_BUCKET:=myoxus-ci}"
  : "${MINIO_ACCESS_KEY:=minioadmin}"
  : "${MINIO_SECRET_KEY:=minioadmin}"
  : "${MINIO_REGION:=us-east-1}"
  export MINIO_BUCKET MINIO_ACCESS_KEY MINIO_SECRET_KEY MINIO_REGION
  cargo test -p myoxus-infrastructure --test storage_minio -- --nocapture
else
  echo "==> MinIO/S3 storage integration skipped: MINIO_ENDPOINT not set"
fi

echo "Server integration checks passed."
