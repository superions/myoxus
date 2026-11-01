#!/usr/bin/env bash
# Verifies Docker, Buildx, Compose, and basic container execution on the runner.

set -euo pipefail

bash build/scripts/ci/verify-docker-buildx.sh
docker compose version
timeout "${DOCKER_SMOKE_TIMEOUT_SECONDS:-60}" docker run --rm hello-world
