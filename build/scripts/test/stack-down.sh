#!/usr/bin/env bash
# Stop the isolated test infrastructure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_DIR="$(cd "$SCRIPT_DIR/../../server" && pwd)"
COMPOSE_PROJECT_NAME="${MYOXUS_TEST_COMPOSE_PROJECT:-myoxus-test}"

TRANSCRIPTION_ONLY=0
WITH_TRANSCRIPTION=0
COMPOSE_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --transcription-only) TRANSCRIPTION_ONLY=1 ;;
    --with-transcription) WITH_TRANSCRIPTION=1 ;;
    *) COMPOSE_ARGS+=("$arg") ;;
  esac
done

bounded_docker() {
  node --input-type=module - "$SCRIPT_DIR/process-tree-runner.mjs" "$@" <<'NODE'
import { pathToFileURL } from 'node:url';
const { runWithProcessTreeTimeout } = await import(pathToFileURL(process.argv[2]));
const result = await runWithProcessTreeTimeout('docker', process.argv.slice(3), {
  stdio: 'inherit', timeoutMs: 30000,
});
process.exitCode = result.timedOut ? 124 : (result.status ?? 1);
NODE
}

cd "$COMPOSE_DIR"
if [ "$TRANSCRIPTION_ONLY" -eq 1 ]; then
  bounded_docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml --profile transcription \
    stop --timeout 10 transcription-test transcription-model-init
  bounded_docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml --profile transcription \
    rm -f transcription-test transcription-model-init
  model_volume="${COMPOSE_PROJECT_NAME}_myoxus-test-transcription-model"
  # Inspect all project volumes first, so a missing volume is an idempotent
  # no-op while a failed Docker inspection remains a real cleanup failure.
  project_volumes="$(bounded_docker volume ls --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --format '{{.Name}}')"
  while IFS= read -r project_volume; do
    if [ "$project_volume" = "$model_volume" ]; then
      bounded_docker volume rm "$model_volume"
      break
    fi
  done <<< "$project_volumes"
  echo "✓ Test transcription fixture and its model cache removed"
elif [ "$WITH_TRANSCRIPTION" -eq 1 ]; then
  bounded_docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml --profile transcription \
    down --volumes "${COMPOSE_ARGS[@]}"
  echo "✓ Test infrastructure stopped"
else
  docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml down --volumes "${COMPOSE_ARGS[@]}"
  echo "✓ Test infrastructure stopped"
fi
