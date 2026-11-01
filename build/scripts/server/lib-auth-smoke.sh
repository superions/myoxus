#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Shared auth helpers for live-stack smoke scripts.
#
# Local self-host stacks can enable ALTCHA on sign-in. Smoke scripts must
# exercise that real contract instead of bypassing CAPTCHA or repeatedly
# failing with CAPTCHA_MISSING_TOKEN.

captcha_token() {
  local api="$1"
  local body_file
  body_file="$(mktemp)"
  local http_code
  http_code="$(curl -sS -o "$body_file" -w "%{http_code}" \
    "$api/api/auth/challenge" \
    -H 'Accept: application/json' || true)"

  if [ "$http_code" = "503" ]; then
    rm -f "$body_file"
    return 0
  fi
  if [ "$http_code" != "200" ]; then
    echo "captcha challenge failed with HTTP $http_code: $(cat "$body_file")" >&2
    rm -f "$body_file"
    return 1
  fi

  node - "$body_file" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');

const challenge = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const algorithm = String(challenge.algorithm ?? '')
  .toLowerCase()
  .replace(/-/g, '');

if (!['sha256', 'sha384', 'sha512'].includes(algorithm)) {
  throw new Error(`Unsupported CAPTCHA algorithm for smoke script: ${challenge.algorithm}`);
}

const maxNumber = Number(challenge.maxnumber ?? 100000);
for (let number = 0; number <= maxNumber; number += 1) {
  const candidate = crypto
    .createHash(algorithm)
    .update(`${challenge.salt}${number}`)
    .digest('hex');
  if (candidate === challenge.challenge) {
    process.stdout.write(
      JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        number,
        salt: challenge.salt,
        signature: challenge.signature,
      }),
    );
    process.exit(0);
  }
}

throw new Error(`Unable to solve CAPTCHA challenge up to ${maxNumber}`);
NODE
  local rc=$?
  rm -f "$body_file"
  return "$rc"
}

smoke_admin_sign_in() {
  local api="$1"
  local email="$2"
  local password="$3"
  local headers_file
  local body_file
  headers_file="$(mktemp)"
  body_file="$(mktemp)"

  local token
  if ! token="$(captcha_token "$api")"; then
    rm -f "$headers_file" "$body_file"
    return 1
  fi

  local curl_headers=(-H 'Content-Type: application/json')
  if [ -n "$token" ]; then
    curl_headers+=(-H "x-captcha-token: $token")
  fi

  local http_code
  http_code="$(curl -sS -D "$headers_file" -o "$body_file" -w "%{http_code}" \
    "$api/api/auth/sign-in" \
    -X POST \
    "${curl_headers[@]}" \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" || true)"

  local session
  session="$(grep -i '^set-cookie:' "$headers_file" |
    sed -n 's/.*affine_session=\([^;]*\).*/\1/p' |
    head -1)"

  if [ -z "$session" ]; then
    echo "admin sign-in failed with HTTP $http_code: $(cat "$body_file")" >&2
    rm -f "$headers_file" "$body_file"
    return 1
  fi

  printf '%s\n' "$session"
  rm -f "$headers_file" "$body_file"
}
