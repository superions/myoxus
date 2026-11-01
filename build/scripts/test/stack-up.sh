#!/usr/bin/env bash
# Start the isolated test infrastructure (Postgres + Redis on separate ports).
#
# Dev stack: Postgres :5432, Redis :6379
# Test stack: Postgres :5434, Redis :6380
#
# Usage:
#   build/scripts/test/stack-up.sh
#   build/scripts/test/stack-up.sh --with-minio
#   TEST_DATABASE_URL=postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test cargo test -p myoxus-api

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_DIR="$(cd "$SCRIPT_DIR/../../server" && pwd)"
COMPOSE_PROJECT_NAME="${MYOXUS_TEST_COMPOSE_PROJECT:-myoxus-test}"
WITH_MINIO=0
WITH_TRANSCRIPTION=0

for arg in "$@"; do
  case "$arg" in
    --with-minio)
      WITH_MINIO=1
      ;;
    --with-transcription)
      WITH_TRANSCRIPTION=1
      ;;
    -h|--help)
      cat <<'EOF'
Usage: build/scripts/test/stack-up.sh [--with-minio] [--with-transcription]

Starts the isolated test infrastructure on non-dev ports:
  Postgres :5434
  Redis    :6380
  MinIO    :9000 (only with --with-minio)
  Speech   :8091 (only with --with-transcription; pinned CPU fixture)
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# Reuse the matrix process-group timeout; container cleanup remains explicit
# because killing a Docker client alone does not stop its containers.
bounded_compose() {
  local seconds="$1"
  shift
  node --input-type=module - "$SCRIPT_DIR/process-tree-runner.mjs" "$seconds" \
    compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml "$@" <<'NODE'
import { pathToFileURL } from 'node:url';
const { runWithProcessTreeTimeout } = await import(pathToFileURL(process.argv[2]));
const result = await runWithProcessTreeTimeout('docker', process.argv.slice(4), {
  stdio: 'inherit', timeoutMs: Number(process.argv[3]) * 1000,
});
process.exitCode = result.timedOut ? 124 : (result.status ?? 1);
NODE
}

start_transcription_fixture() {
  trap 'bash "$SCRIPT_DIR/stack-down.sh" --transcription-only' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  bounded_compose 600 --profile transcription up --no-deps \
    --abort-on-container-exit --exit-code-from transcription-model-init transcription-model-init
  bounded_compose 45 --profile transcription up -d --no-deps transcription-test
  local deadline_seconds=$((SECONDS + 180))
  while [ "$SECONDS" -lt "$deadline_seconds" ]; do
    local speech_state
    speech_state="$(bounded_compose 10 --profile transcription ps --all --format '{{.State}} {{.Health}}' transcription-test)"
    if [ "$speech_state" = 'running healthy' ]; then
      trap - EXIT INT TERM
      return 0
    fi
    if [[ "$speech_state" == exited* ]]; then
      bounded_compose 10 --profile transcription logs --tail 40 transcription-test
      echo "Test transcription fixture exited before becoming healthy" >&2
      return 1
    fi
    sleep 2
  done
  bounded_compose 10 --profile transcription logs --tail 40 transcription-test
  echo "Test transcription fixture did not become healthy within 180 seconds" >&2
  return 1
}

cd "$COMPOSE_DIR"
if [ "$WITH_MINIO" -eq 1 ]; then
  docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml --profile minio up -d \
    postgres-test redis-test minio-test
else
  docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml up -d postgres-test redis-test
fi

echo ""
echo "Waiting for test infrastructure..."
for i in $(seq 1 30); do
  PG=$(docker inspect myoxus-test-postgres --format='{{.State.Health.Status}}' 2>/dev/null || echo "starting")
  RD=$(docker inspect myoxus-test-redis --format='{{.State.Health.Status}}' 2>/dev/null || echo "starting")
  MN="healthy"
  if [ "$WITH_MINIO" -eq 1 ]; then
    MN=$(docker inspect myoxus-test-minio --format='{{.State.Health.Status}}' 2>/dev/null || echo "starting")
  fi
  if [ "$PG" = "healthy" ] && [ "$RD" = "healthy" ] && [ "$MN" = "healthy" ]; then
    if [ "$WITH_MINIO" -eq 1 ]; then
      docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml --profile minio run --rm minio-init
    fi
    if [ "$WITH_TRANSCRIPTION" -eq 1 ]; then
      start_transcription_fixture
    fi
    echo ""
    echo "✓ Test infrastructure ready"
    echo ""
    echo "  TEST_DATABASE_URL=postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test"
    echo "  TEST_REDIS_URL=redis://localhost:6380"
    if [ "$WITH_MINIO" -eq 1 ]; then
      echo "  MINIO_ENDPOINT=http://localhost:9000"
      echo "  MINIO_BUCKET=myoxus-ci"
      echo "  MINIO_ACCESS_KEY=minioadmin"
      echo "  MINIO_SECRET_KEY=minioadmin"
    fi
    if [ "$WITH_TRANSCRIPTION" -eq 1 ]; then
      echo "  Speech endpoint: http://127.0.0.1:${MYOXUS_TEST_TRANSCRIPTION_PORT:-8091}/v1"
      echo "  Speech model: Systran/faster-whisper-small"
      echo "  Configure these explicitly through Admin; no product defaults are changed."
    fi
    echo ""
    echo "Run tests with:"
    echo "  cd server && TEST_DATABASE_URL=postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test cargo test -p myoxus-api"
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo " timeout!"
exit 1
