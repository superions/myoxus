# CAPTCHA — operations guide

[Documentation](../../README.md) / [Operations](../README.md) / [Security operations](./README.md)

Myoxus ships a self-hosted ALTCHA proof-of-work CAPTCHA without a required
third-party verification service. Deployment of the control does not by itself
establish privacy-law compliance.
No third-party calls are made at any point in the challenge/verify lifecycle.

The official ALTCHA v3 browser widget requires a Secure Context (HTTPS, or
browser-trusted localhost) because it uses WebCrypto. Myoxus therefore keeps
server-side verification enabled on HTTP development/LAN origins and uses a
client-side fallback solver for the same signed ALTCHA challenge instead of
mounting the widget. This is not a bypass: `/api/auth/sign-in` still requires a
valid `x-captcha-token` when `captcha.enabled=true`.

<details>
<summary>On this page</summary>

- [Setup](#setup)
- [Rotation](#rotation)
- [Tuning](#tuning)
- [Troubleshooting](#troubleshooting)
- [Monitoring](#monitoring)
- [Privacy boundary](#privacy-boundary)

</details>

## Setup

### 1. Generate an HMAC key

```bash
myoxus-cli captcha generate-key
# → one newly generated 64-character hexadecimal value
```

The output is 32 random bytes hex-encoded (64 ASCII chars). Store it in the
deployment's protected secret mechanism. Never commit it to the repository or
paste it into an incident record.

The generator emits 32 random bytes. Startup requires a non-empty key; use the
generator output rather than choosing a short human-readable value.

### 2. Configure the server

Either via YAML (`server/config/local.yaml`):

```yaml
captcha:
  enabled: true
  algorithm: SHA-256 # SHA-256 | SHA-384 | SHA-512
  challenge_expires_seconds: 60
  max_number: 100000
  rate_limit_per_ip_per_min: 30
  rate_limit_per_account_per_hour: 20
  honeypot_field_name: website
```

This YAML contains only non-sensitive policy values. Inject the generated HMAC
key through the deployment secret manager as shown below.

Or have the deployment's secret manager inject the two process-environment
values. Do not type the HMAC key into an interactive shell or store it in an
environment file:

```bash
MYOXUS__CAPTCHA__ENABLED=true
MYOXUS__CAPTCHA__HMAC_KEY=<secret-manager-reference>
```

Env-var overrides beat YAML. YAML beats `default.yaml`. The `hmac_key` is
`ConfigSource::YamlOnly` — never editable through the admin GUI.

### 3. Restart

```bash
build/scripts/server/stack-rebuild-api.sh
```

Startup will log:

```text
INFO startup_check passed name="captcha_config"
```

### 4. Verify

```bash
# Anonymous: returns 401 (must)
curl -i http://localhost:3001/api/admin/captcha/status
# Admin session required:
read -rsp 'Admin session cookie: ' MYOXUS_ADMIN_COOKIE
export MYOXUS_ADMIN_COOKIE
myoxus-cli captcha status
unset MYOXUS_ADMIN_COOKIE
```

The `hmac_key_configured` field must be `true`.

## Rotation

Rotating the HMAC key instantly invalidates every in-flight challenge. Clients
must fetch a newly signed challenge before retrying authentication.

Procedure:

1. Generate a new key: `myoxus-cli captcha generate-key`.
2. Update the deployment's protected secret backend.
3. Restart the server:
   - Docker: `build/scripts/server/stack-rebuild-api.sh`
   - systemd: `systemctl restart myoxus-api`
   - another service manager: perform its normal graceful restart.
4. Watch the rejection counters. In-flight challenges signed by the old key
   can report `captcha_invalid_signature` until clients fetch a new challenge.
   Correlate the interval with the configured challenge lifetime.

There is no two-key grace period. Schedule the restart and client retry impact
according to the operator's authentication availability policy.

## Tuning

| Key                               | Packaged default | Operator consideration                                                     |
| --------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `max_number`                      | `50000`          | Higher values increase client proof-of-work cost; measure target devices.  |
| `challenge_expires_seconds`       | `1800`           | Balance completion time against challenge lifetime.                        |
| `rate_limit_per_ip_per_min`       | `10`             | Account for shared addresses and the edge proxy's trusted-client-IP setup. |
| `rate_limit_per_account_per_hour` | `5`              | Align with the operator's authentication and recovery policy.              |
| `algorithm`                       | `SHA-256`        | Test every supported client before selecting another algorithm.            |
| `honeypot_field_name`             | `website`        | Keep server and client configuration aligned.                              |

## Troubleshooting

### "widget never appears"

Check `/api/auth/challenge`:

- `200` with `{ algorithm, challenge, salt, signature, maxnumber }` → widget
  receives the challenge. On HTTPS/localhost the official widget should render;
  on non-local HTTP the Myoxus fallback checkbox should render instead.
- `503` → `captcha.enabled=false`. Enable in config and rebuild.
- `500` → inspect the API error and startup logs. An empty key normally fails
  the startup invariant before this route can serve traffic.

### "secure context (HTTPS) required"

This message is produced by the upstream ALTCHA v3 widget when a non-local HTTP
origin is not a browser Secure Context. The Myoxus sign-in UI must not show this
message anymore: it should detect `globalThis.isSecureContext === false`, render
the fallback checkbox, solve with `hash-wasm`, and submit the normal ALTCHA
Base64 payload. If the message appears, the frontend bundle is stale or the
fallback gate regressed.

### "CAPTCHA_REPLAY after one attempt"

The user's browser is submitting the same payload twice (double-click,
network retry, router retry). Check `CaptchaService::verify` logs — if the
replay rate is high the client is retrying too aggressively. Increase
`rate_limit_per_ip_per_min` won't fix this; fix the retry logic client-side.

### "CAPTCHA_RATE_LIMITED_IP on first attempt"

The IP hash may already have counters from other users behind the same NAT or
corporate VPN. Confirm that the edge proxy overwrites, rather than appends
untrusted client values to, the forwarded-client-IP header. Then tune the
operator's CAPTCHA or edge rate policy for the shared egress. Never fabricate a
different client address to bypass the limit.

### "widget solves but server rejects CAPTCHA_EXPIRED"

The challenge reached the server after its server-issued expiry. Measure the
time between challenge fetch and submission, check retries and network delay,
and then decide whether the configured lifetime fits the supported clients.

## Monitoring

### Prometheus

```text
myoxus_captcha_verified_total      # counter, successes
myoxus_captcha_rejected_total      # counter, failures (all reasons)
myoxus_captcha_honeypot_total      # counter, honeypot triggers
```

### Alerting

Alert on sustained changes in rejected, honeypot and verified counters relative
to the deployment's normal login traffic. Also alert when the effective config
is missing or stale. The repository does not prescribe universal thresholds;
set severity and windows from the operator's traffic baseline and response
objectives.

### Audit log

Every reject lands in `admin_audit_log` with `category=Auth`,
`action=captcha.rejected`, metadata `{reason, ip_hash, account_hash, user_agent}`.
Query the reason distribution:

```sql
SELECT metadata->>'reason' AS reason, count(*)
FROM admin_audit_log
WHERE action = 'captcha.rejected'
  AND created_at > now() - interval '24 hours'
GROUP BY reason
ORDER BY count(*) DESC;
```

## Privacy boundary

The CAPTCHA pipeline stores **no raw user identifiers**. Specifically:

- Rate-limit keys are `sha256(IP)` / `sha256(lower(email))`. These are
  pseudonymous identifiers, not anonymous data; low-entropy inputs may still be
  correlated or guessed.
- Audit entries use the same hashes and retain the User-Agent header verbatim.
  Treat that metadata as potentially personal data under operator policy.
- The submitted solution payload is NEVER stored — only
  `sha256(canonical_json_payload)` in Redis for replay detection, with TTL =
  `challenge_expires_seconds`.
- CAPTCHA verification itself makes no outbound verification call and sets no
  third-party cookie. Normal Myoxus logging and telemetry remain governed by
  their separate configuration.

See the current [ALTCHA documentation](https://altcha.org/docs/v2/) for the
upstream widget and proof-of-work contract. Myoxus does not use ALTCHA Sentinel
in this deployment path.
