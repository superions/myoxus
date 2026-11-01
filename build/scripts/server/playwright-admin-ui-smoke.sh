#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PLAYWRIGHT_CONFIG_REL="tests/client/adminfrontend/e2e/playwright.config.ts"
PLAYWRIGHT_CONFIG="$REPO_ROOT/$PLAYWRIGHT_CONFIG_REL"
DOCKER_IMAGE="mcr.microsoft.com/playwright:v$(node -p "require('@playwright/test/package.json').version")-noble"

run_docker() {
  docker run --rm \
    --network host \
    --ipc=host \
    -u "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    -v "$REPO_ROOT:/work" \
    -w /work \
    "$DOCKER_IMAGE" \
    npx playwright test --config "$PLAYWRIGHT_CONFIG_REL" --reporter=list "$@"
}

cd "$REPO_ROOT"

if ! node <<'NODE'
const { chromium } = require('@playwright/test');
const executable = chromium.executablePath();
const { spawnSync } = require('node:child_process');
const result = spawnSync('ldd', [executable], { encoding: 'utf8' });
process.exit(result.status === 0 && !/not found/.test(result.stdout + result.stderr) ? 0 : 1);
NODE
then
  echo "[WARN] host Playwright browser has missing shared libraries; running ${DOCKER_IMAGE}" >&2
  run_docker "$@"
  exit $?
fi

if npx playwright test --config "$PLAYWRIGHT_CONFIG" --reporter=list "$@" \
  2> >(tee /tmp/myoxus-admin-playwright-stderr.log >&2); then
  exit 0
fi

if grep -E "error while loading shared libraries|Host system is missing dependencies|browserType.launch" /tmp/myoxus-admin-playwright-stderr.log >/dev/null 2>&1; then
  echo "[WARN] host Playwright runner cannot launch the browser; retrying in ${DOCKER_IMAGE}" >&2
  run_docker "$@"
  exit $?
fi

exit 1
