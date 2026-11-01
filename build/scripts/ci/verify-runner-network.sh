#!/usr/bin/env bash
# Verifies DNS and essential network access for the self-hosted runner.

set -euo pipefail

hosts=(
  git.blume29.de
  nodejs.org
  registry.npmjs.org
  crates.io
  github.com
  code.forgejo.org
  data.forgejo.org
)

for host in "${hosts[@]}"; do
  echo "== $host"
  getent hosts "$host"
done

curl -fsS --max-time 20 https://git.blume29.de/api/v1/version || true
curl -fsS --max-time 20 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt >/tmp/node-shasums.txt
test -s /tmp/node-shasums.txt
