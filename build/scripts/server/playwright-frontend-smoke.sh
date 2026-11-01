#!/usr/bin/env bash
# Run the web frontend Playwright smoke suite. Prefer the host runner for speed,
# but fall back to the official Playwright Docker image when the host browser
# cannot start because required system libraries are missing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# The runner owns host/Docker fallback and timeout handling for Browser Web
# served-stack Playwright suites. Keep the default on the runtime smoke suite,
# and let opt-in visual/editor wrappers point it at their dedicated configs.
PLAYWRIGHT_CONFIG_REL="${MYOXUS_PLAYWRIGHT_CONFIG_REL:-tests/client/webfrontend/smoke/playwright.config.ts}"
PLAYWRIGHT_CONFIG="$REPO_ROOT/$PLAYWRIGHT_CONFIG_REL"
DOCKER_IMAGE="mcr.microsoft.com/playwright:v$(node -p "require('@playwright/test/package.json').version")-noble"
MIN_DISK_MB="${PLAYWRIGHT_MIN_DISK_MB:-4096}"
OUTER_TIMEOUT_SECONDS="${MYOXUS_PLAYWRIGHT_TIMEOUT_SECONDS:-1200}"
RUNNER_DRY_RUN=false

if [ "${1:-}" = "--runner-dry-run" ]; then
  RUNNER_DRY_RUN=true
  shift
fi

cd "$REPO_ROOT"

HOST_LOG="$(mktemp)"
RUN_LOG=""
cleanup() {
  rm -f "$HOST_LOG"
  if [ -n "${RUN_LOG:-}" ]; then
    rm -f "$RUN_LOG"
  fi
}
trap cleanup EXIT

available_mb() {
  df -Pm "$1" | awk 'NR == 2 { print $4 }'
}

check_disk_space() {
  local docker_root
  docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
  if [ -z "$docker_root" ] || [ ! -e "$docker_root" ]; then
    docker_root="/"
  fi

  local docker_avail tmp_avail
  docker_avail="$(available_mb "$docker_root")"
  tmp_avail="$(available_mb "${TMPDIR:-/tmp}")"

  if [ "$docker_avail" -lt "$MIN_DISK_MB" ]; then
    echo "[FAIL] Playwright smoke requires at least ${MIN_DISK_MB} MiB free on Docker root (${docker_root}); only ${docker_avail} MiB available." >&2
    echo "[HINT] Free Docker build cache first, for example: docker builder prune -af" >&2
    exit 1
  fi

  if [ "$tmp_avail" -lt 1024 ]; then
    echo "[FAIL] Playwright smoke requires at least 1024 MiB free in TMPDIR (${TMPDIR:-/tmp}); only ${tmp_avail} MiB available." >&2
    exit 1
  fi
}

playwright_log_has_reported_failures() {
  [ -n "${RUN_LOG:-}" ] &&
    [ -f "$RUN_LOG" ] &&
    perl -pe 's/\e\[[0-9;?]*[\/ -]*[@-~]//g' "$RUN_LOG" |
      grep -Eq '^[[:space:]]*[1-9][0-9]*[[:space:]]+failed\b'
}

print_timeout_failure() {
  local runner="$1"
  local container_name="${2:-}"

  echo "[FAIL] Playwright ${runner} runner exceeded ${OUTER_TIMEOUT_SECONDS}s timeout." >&2
  if [ -n "$container_name" ]; then
    docker rm -f "$container_name" >/dev/null 2>&1 || true
    echo "[INFO] cleaned up timed-out container: ${container_name}" >&2
  fi
  if [ -n "${RUN_LOG:-}" ] && [ -s "$RUN_LOG" ]; then
    echo "[INFO] last Playwright output:" >&2
    tail -120 "$RUN_LOG" >&2 || true
  fi
}

run_timed() {
  local runner="$1"
  local container_name="$2"
  shift 2

  RUN_LOG="$(mktemp)"
  set +e
  local timeout_bin=""
  if command -v timeout >/dev/null 2>&1; then
    timeout_bin="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    timeout_bin="gtimeout"
  fi

  if [ -n "$timeout_bin" ]; then
    "$timeout_bin" --kill-after=15s "$OUTER_TIMEOUT_SECONDS" "$@" \
      > >(tee "$RUN_LOG") 2>&1
  else
    echo "[WARN] timeout command unavailable; running Playwright ${runner} runner without outer timeout" >&2
    "$@" > >(tee "$RUN_LOG") 2>&1
  fi
  local status=$?
  set -e

  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    print_timeout_failure "$runner" "$container_name"
  fi
  if [ "$status" -eq 0 ] && playwright_log_has_reported_failures; then
    echo "[FAIL] Playwright reported failed tests despite zero process exit." >&2
    echo "[INFO] last Playwright output:" >&2
    tail -120 "$RUN_LOG" >&2 || true
    return 1
  fi
  return "$status"
}

detect_host_runner() {
  if [ "${MYOXUS_PLAYWRIGHT_FORCE_DOCKER:-}" = "1" ]; then
    echo "docker|forced by MYOXUS_PLAYWRIGHT_FORCE_DOCKER=1"
    return
  fi

  if [ "${MYOXUS_PLAYWRIGHT_ASSUME_HOST_USABLE:-}" = "1" ]; then
    echo "host|assumed usable by MYOXUS_PLAYWRIGHT_ASSUME_HOST_USABLE=1"
    return
  fi

  local host_browser
  host_browser="$(
    node - <<'NODE' 2>/dev/null || true
const { chromium } = require('@playwright/test');
process.stdout.write(chromium.executablePath());
NODE
  )"

  if [ -z "$host_browser" ] || [ ! -x "$host_browser" ]; then
    echo "docker|host chromium executable not found"
    return
  fi

  if ! command -v ldd >/dev/null 2>&1; then
    echo "docker|ldd unavailable; cannot verify host browser shared libraries"
    return
  fi

  local missing_libs
  missing_libs="$(ldd "$host_browser" 2>/dev/null | awk '/not found/ { print $1 }' | paste -sd, - | sed 's/,/, /g')"
  if [ -n "$missing_libs" ]; then
    echo "docker|host browser missing shared libraries: ${missing_libs}"
    return
  fi

  echo "host|host chromium usable: ${host_browser}"
}

run_docker() {
  check_disk_space
  local container_name="myoxus-playwright-smoke-$(date +%s)-$$"
  local docker_args=(
    run --rm
    --name "$container_name"
    --network host
    --ipc=host
    -u "$(id -u):$(id -g)"
    -e HOME=/tmp
    -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
  )
  if [ -n "${MYOXUS_FRONTEND_BASE_URL:-}" ]; then
    docker_args+=(
      -e "MYOXUS_FRONTEND_BASE_URL=${MYOXUS_FRONTEND_BASE_URL}"
    )
  fi
  if [ -n "${MYOXUS_API_BASE_URL:-}" ]; then
    docker_args+=(-e "MYOXUS_API_BASE_URL=${MYOXUS_API_BASE_URL}")
  fi
  docker_args+=(
    -v "$REPO_ROOT:/work"
    -w /work
    "$DOCKER_IMAGE"
    npx playwright test --config "$PLAYWRIGHT_CONFIG_REL" --reporter=list "$@"
  )
  run_timed "docker" "$container_name" docker "${docker_args[@]}"
}

check_disk_space

RUNNER_DECISION="$(detect_host_runner)"
RUNNER="${RUNNER_DECISION%%|*}"
RUNNER_REASON="${RUNNER_DECISION#*|}"

if [ "$RUNNER_DRY_RUN" = true ]; then
  echo "runner=${RUNNER}"
  echo "reason=${RUNNER_REASON}"
  echo "docker_image=${DOCKER_IMAGE}"
  echo "playwright_config=${PLAYWRIGHT_CONFIG_REL}"
  echo "timeout_seconds=${OUTER_TIMEOUT_SECONDS}"
  exit 0
fi

if [ "${MYOXUS_PLAYWRIGHT_RESULT_SELF_TEST:-}" = "reported-failure-zero" ]; then
  RUN_LOG="$(mktemp)"
  printf '  \033[31m1 failed\033[39m\n  12 passed\n' > "$RUN_LOG"
  if playwright_log_has_reported_failures; then
    echo "[FAIL] Playwright reported failed tests despite zero process exit." >&2
    exit 1
  fi
  echo "[FAIL] result self-test did not detect failed Playwright summary" >&2
  exit 2
fi

echo "[INFO] Playwright runner: ${RUNNER} (${RUNNER_REASON})"

if [ "$RUNNER" = "docker" ]; then
  echo "[WARN] host Playwright runner unavailable; running ${DOCKER_IMAGE}" >&2
  if run_docker "$@"; then
    exit 0
  else
    status=$?
    exit "$status"
  fi
fi

if run_timed "host" "" npx playwright test --config "$PLAYWRIGHT_CONFIG" --reporter=list "$@" \
  > >(tee "$HOST_LOG") 2>&1; then
  exit 0
fi

if grep -qE "error while loading shared libraries|Host system is missing dependencies|browserType\\.launch" "$HOST_LOG"; then
  echo "[WARN] host Playwright runner cannot launch the browser; retrying in ${DOCKER_IMAGE}" >&2
  if run_docker "$@"; then
    exit 0
  else
    status=$?
    exit "$status"
  fi
fi

echo "[FAIL] Playwright smoke tests FAILED — app has runtime JS errors!" >&2
exit 1
