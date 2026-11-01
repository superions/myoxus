# Logging operations guide

[Documentation](../../README.md) / [Operations](../README.md) / [Observability](./README.md)

This guide covers day-to-day logging operations for Myoxus server administrators.

---

<details>
<summary>On this page</summary>

- [Quick start](#quick-start)
- [Debugging scenarios](#debugging-scenarios)
- [Temporary debug mode](#temporary-debug-mode)
- [Presets](#presets)
- [Log rotation](#log-rotation)
- [Disk management](#disk-management)
- [Environment variable overrides](#environment-variable-overrides)
- [Docker considerations](#docker-considerations)
- [Performance impact](#performance-impact)
- [Troubleshooting](#troubleshooting)
- [Production recommendations](#production-recommendations)

</details>

## Quick start

### Default configuration

Out of the box, Myoxus logs to **stdout only** at `info` level, with noisy dependencies (`sqlx`, `hyper`, `tungstenite`, `h2`, `rustls`) suppressed to `warn`.

To enable file logging for a native deployment, add to its non-sensitive
`config/local.yaml`:

```yaml
logging:
  level: "info"
  file_path: "/opt/myoxus/logs/myoxus.log"
  rotation: "daily"
  max_files: 7
```

The maintained Compose topology sets
`/opt/myoxus/data/logs/myoxus.log` and mounts the operator's complete data
directory:

```yaml
volumes:
  - ${MYOXUS_DATA_DIR:-./data}:/opt/myoxus/data:rw
```

### Recommended production levels

| Group               | Level | Reason                                                           |
| ------------------- | ----- | ---------------------------------------------------------------- |
| `api`               | info  | Request/response lifecycle                                       |
| `websocket`         | info  | Connection events only (debug is very noisy)                     |
| `auth`              | info  | Sign-in/sign-out events                                          |
| `database`          | warn  | Only errors and slow query warnings                              |
| `sync_protocol`     | warn  | Only transport errors                                            |
| `workers`           | info  | Job processing events                                            |
| `copilot`           | info  | Session events                                                   |
| `mcp`               | info  | MCP request events                                               |
| `public_publishing` | info  | Public routes, ACL decisions, renderer and asset materialization |
| `git_sync`          | info  | Sync run lifecycle                                               |
| `storage`           | info  | Upload/download events                                           |
| `http_internals`    | warn  | Only errors                                                      |
| `template_registry` | info  | Template import, publication, reconciliation, and drift scans    |

These are the `recommended_default` values and what the `production` preset applies.

---

## Debugging scenarios

### Admin controls

Open System > Logging (`/adminfrontend/system?tab=logging`). Module levels
apply immediately; selecting the Trace preset opens a confirmation that can
be cancelled without changing levels. Output rotation applies on selection;
File Path and Max Files apply when leaving the edited field. Reload the route
to verify the server's stored values. These controls do not use a separate
Save/Discard draft.

The native input's trailing status reports path validation without truncating
the path into a separate narrow row. Module level, auto-revert and output
controls have accessible names. Pending reads show the shared loading
skeleton; failed reads show an error with Retry, not an indefinite loading
message. Retry only revalidates the configuration query.

All logging operations are fields of `AdminRoot`. The curl examples below use
the `affine_session` cookie and the CSRF double-submit contract required for
mutations: the `myoxus_csrf_token` cookie value must also be sent in
`x-myoxus-csrf-token`. Use values from an authenticated Dev-seed admin session;
never record them in a shell history, incident report, committed file, or
process argument. Prepare one owner-only temporary curl config in the current
shell; the exit trap removes it:

```bash
MYOXUS_CURL_AUTH_CONFIG="$(mktemp)"
chmod 600 "$MYOXUS_CURL_AUTH_CONFIG"
read -rsp 'Admin session: ' MYOXUS_ADMIN_SESSION
printf '\n'
read -rsp 'CSRF token: ' MYOXUS_CSRF_TOKEN
printf '\n'
printf 'header = "Cookie: affine_session=%s; myoxus_csrf_token=%s"\nheader = "x-myoxus-csrf-token: %s"\n' \
  "$MYOXUS_ADMIN_SESSION" "$MYOXUS_CSRF_TOKEN" "$MYOXUS_CSRF_TOKEN" \
  >"$MYOXUS_CURL_AUTH_CONFIG"
unset MYOXUS_ADMIN_SESSION MYOXUS_CSRF_TOKEN
trap 'rm -f -- "$MYOXUS_CURL_AUTH_CONFIG"' EXIT
```

Prefer the matching Admin UI action for routine operation. Use the direct API
examples only for a bounded diagnostic and keep the temporary config path out
of support output.

### 1. "page loads blank after reload"

**Likely cause**: WebSocket sync failure, client cannot load the Yjs document.

```bash
# Set websocket group to DEBUG for 15 minutes
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { admin { updateLogModuleLevel(input: { group: \"websocket\", level: \"DEBUG\", autoRevertMinutes: 15 }) { group level } } }"
  }'
```

**What to look for**:

- one `doc_sync.load.started` followed by exactly one
  `doc_sync.load.completed`, `doc_sync.load.rejected`, or
  `doc_sync.load.cancelled` event with the same `sync_operation_id`;
- high `decoder_wait_ms` (shared decoder saturation), high `materialize_ms`,
  unexpected `update_count`, or output close to the configured transport bound;
- fixed outcomes such as `invalid_state_vector`, `payload_too_large`, `busy`,
  or `failed` rather than raw payload or database errors;
- one `doc_sync.push.completed` per accepted push with `persisted`,
  `exact_replay`, or `crdt_noop`; replay/no-op are DEBUG evidence of a feedback
  loop and must not appear as WARN/ERROR;
- missing workspace membership or an incorrect document access decision.
- repeated `doc_sync.connection.admission` WARN events with fixed reason
  `rate_limited` or `redis_unavailable`. Correlate by `client_kind` and the
  optional bounded client hash; never request raw session or account IDs.

Do not enable SQL parameter logging or copy document payloads into an incident
ticket. Reproduce with synthetic data. The `websocket` group already includes
the application document service, SQL document repository summaries, and Yjs
materializer; a second logger is neither necessary nor supported.

### 2. "login fails silently"

**Likely cause**: Session validation or OAuth callback issue.

```bash
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { admin { updateLogModuleLevel(input: { group: \"auth\", level: \"DEBUG\", autoRevertMinutes: 15 }) { group level } } }"
  }'
```

**What to look for**: session creation failures, expired sessions, OAuth state
mismatches, OIDC Discovery/JWKS validation failures and redacted OU sync
outcomes. Prefer the Admin Security **Test OIDC provider** action before
raising log volume; it returns redacted Discovery, JWKS and sample group-count
diagnostics without logging raw claims.

Never log client secrets, authorization codes, access tokens, ID tokens,
cookies, full UserInfo/ID-token claim payloads or complete provider group
lists. Reset `auth` to the production preset after diagnosis.

### 3. "SQL queries slow"

**Likely cause**: Missing index, pool exhaustion, long-running transactions.

```bash
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { admin { updateLogModuleLevel(input: { group: \"database\", level: \"DEBUG\", autoRevertMinutes: 5 }) { group level } } }"
  }'
```

**WARNING**: The `database` group at DEBUG enables SQLx query diagnostics and
can produce high log volume. Use a short auto-revert window and synthetic
inputs. Myoxus does not require or authorize raw SQL parameter logging; treat
any credential or payload in a log line as a security finding.

### 4. "socket.IO connection drops"

**Likely cause**: Transport-level WebSocket issue (proxy timeout, TLS error).

```bash
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { admin { updateLogModuleLevel(input: { group: \"sync_protocol\", level: \"DEBUG\", autoRevertMinutes: 10 }) { group level } } }"
  }'
```

**What to look for**: tungstenite close frames, protocol errors, handshake
failures, and `doc_sync.connection.admission`. A `rate_limited` event should
carry a retry floor between 1 and 1,000 ms. `redis_unavailable` means new
connections are correctly failing closed; verify the socket-role Redis service
instead of adding a local limiter. Existing connections should remain active.

### 5. "worker jobs not processing"

**Likely cause**: Redis queue issue, job handler crash, stall detection.

```bash
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { admin { updateLogModuleLevel(input: { group: \"workers\", level: \"DEBUG\", autoRevertMinutes: 15 }) { group level } } }"
  }'
```

**What to look for**: job dequeue events, processing errors, stall timeout messages.

### 6. "Git sync fails"

**Likely cause**: SSH key issue, remote unreachable, merge conflict.

```bash
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { admin { updateLogModuleLevel(input: { group: \"git_sync\", level: \"DEBUG\", autoRevertMinutes: 15 }) { group level } } }"
  }'
```

**What to look for**: the bounded Git error class, clone/fetch/push phase,
remote host, and credential-decryption failure category. Do not capture tokens,
private keys, or credential-bearing remote URLs.

### 7. "MCP not responding"

**Likely cause**: Auth failure, tool handler error, session mismatch.

```bash
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { admin { updateLogModuleLevel(input: { group: \"mcp\", level: \"DEBUG\", autoRevertMinutes: 15 }) { group level } } }"
  }'
```

### 8. "published pages fail"

**Likely cause**: Public ACL denial, renderer error, missing public asset
manifest entry, workspace theme CSS failure or proxy misrouting to the Web SPA.

```bash
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { admin { updateLogModuleLevel(input: { group: \"public_publishing\", level: \"DEBUG\", autoRevertMinutes: 15 }) { group level } } }"
  }'
```

**What to look for**: `workspace_id`, `doc_id`, `public_mode`,
`workspace_public`, ACL denial reason, render status, asset materialization
failures and workspace theme CSS failures. Do not log raw document content or
private asset URLs when raising this group above `info`.

---

## Temporary debug mode

The `autoRevertMinutes` parameter prevents forgotten debug levels:

```graphql
mutation {
  admin {
    updateLogModuleLevel(input: { group: "websocket", level: "DEBUG", autoRevertMinutes: 15 }) {
      group
      level
    }
  }
}
```

After 15 minutes, this example reverts the group to the level that was active
before the temporary change. The revert is recorded with
`changed_by: "system/auto-revert"` in the in-process change history. Select the
shortest window that covers the reproduction, and use the
`highVolumeWarning` field to shorten it further for noisy groups.

---

## Presets

Apply a preset to quickly switch all groups at once:

```bash
# Apply debug preset (api, websocket, auth at DEBUG, rest at defaults)
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { admin { applyLogPreset(preset: \"debug\") { group level } } }"
  }'

# Reset to production defaults
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { admin { applyLogPreset(preset: \"production\") { group level } } }"
  }'
```

Available presets:

| Preset       | Effect                                        |
| ------------ | --------------------------------------------- |
| `production` | All groups at recommended defaults            |
| `debug`      | api/websocket/auth at DEBUG, rest at defaults |
| `trace`      | All groups at TRACE (extreme volume)          |

---

## Log rotation

### Rotation modes

| Mode     | File naming                | Operator decision                                 |
| -------- | -------------------------- | ------------------------------------------------- |
| `daily`  | `myoxus.2026-03-19.log`    | Packaged rotation baseline                        |
| `hourly` | `myoxus.2026-03-19-14.log` | Bounds individual files to one configured hour    |
| `never`  | `myoxus.log`               | No rolling retention; external ownership required |

### Choosing `max_files`

| Rotation | `max_files` | Approximate retained time |
| -------- | ----------- | ------------------------- |
| daily    | 7           | 7 daily files             |
| daily    | 30          | 30 daily files            |
| hourly   | 48          | 48 hourly files           |
| hourly   | 168         | 168 hourly files          |

The rolling appender enforces `max_files` as files rotate. This is a file-count
bound, not a byte budget; measure actual volume before selecting it.

---

## Disk management

### Monitoring disk usage

Query the current disk usage via GraphQL:

```bash
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "{ admin { loggingConfig { diskUsage { totalBytes fileCount freeBytes } } } }"
  }' | jq .data.admin.loggingConfig.diskUsage
```

Example response:

```json
{
  "totalBytes": 52428800,
  "fileCount": 5,
  "freeBytes": 10737418240
}
```

### Disk full prevention

1. Set `max_files` appropriately for your rotation mode.
2. Monitor `freeBytes` from the `diskUsage` query.
3. Avoid leaving debug/trace levels active in production (use `autoRevertMinutes`).
4. If disk is critically low, apply the `production` preset and let the
   configured rotation owner prune old files. If emergency manual removal is
   unavoidable, stop the API, preserve the incident window elsewhere, remove
   only rotated files older than the approved retention boundary, and restart
   only after free space is above the operator threshold.

---

## Environment variable overrides

### At startup

| Variable                     | Description                                                   |
| ---------------------------- | ------------------------------------------------------------- |
| `RUST_LOG`                   | Standard Rust log filter. Overrides `logging.level` entirely. |
| `MYOXUS__LOGGING__LEVEL`     | Config-layer override for `logging.level`.                    |
| `MYOXUS__LOGGING__FILE_PATH` | Config-layer override for `logging.file_path`.                |
| `MYOXUS__LOGGING__ROTATION`  | Config-layer override for `logging.rotation`.                 |
| `MYOXUS__LOGGING__MAX_FILES` | Config-layer override for `logging.max_files`.                |

**Precedence**: `RUST_LOG` is checked first and bypasses the config system. If unset, the layered config applies: `default.yaml` < `${RUN_MODE}.yaml` < `local.yaml` < `MYOXUS__*` env vars.

### At runtime

**Module log levels** can be changed at runtime via the GraphQL API
(`updateLogModuleLevel`, `applyLogPreset`, `resetLogLevels`). Changes take
effect immediately. A level change without `autoRevertMinutes`, a preset, or a
reset persists the resulting canonical filter through `app_configs` so it
survives restart. A temporary change stays process-local and reverts to the
previous level; it is not persisted.

**Log output settings** (file path, rotation, max files) can be configured via
`updateLogOutput`. The mutation validates the proposed path, persists the
settings through `app_configs`, and returns `requiresRestart: true` — the
actual file writer cannot be swapped at runtime, so a server restart is needed
for output changes to take effect.

---

## Docker considerations

### Log driver

In Docker Compose, container stdout is captured by the Docker log driver. If you also enable file logging (`file_path`), you get two copies of every log line: one in Docker logs, one in the file.

**Recommended setup**:

- Use `file_path` for persistent, rotated logs (mounted as a volume).
- Use Docker `json-file` log driver with `max-size` and `max-file` limits for stdout.
- Keep the long-lived stack on the server-owned `info` filter. Use targeted
  runtime module levels with automatic reversion for diagnostics; smoke tests
  must never require a global `trace` level.

The maintained selfhost Compose file applies the same bounded driver to every
service and deliberately does not inject `MYOXUS__LOGGING__LEVEL`. The mounted
server configuration therefore remains authoritative and Admin runtime changes
are not shadowed by an environment override.

The exact `json-file` limits and bind mount are defined in the deployment
bundle's `docker-compose.selfhost.yml`; inspect that artifact rather than
copying a second Compose fragment from this guide.

### Volume mount

The log directory must be writable by the container user. The selfhost Compose
file mounts `${MYOXUS_DATA_DIR}/logs` at `/opt/myoxus/data/logs` through the
complete data-directory bind.

The server creates the directory automatically if it does not exist (`std::fs::create_dir_all`).

---

## Performance impact

Higher verbosity increases formatting, I/O, and retention pressure. The effect
depends on traffic and the selected group, so Myoxus does not publish a volume
or CPU multiplier. Treat groups whose `highVolumeWarning` is true — currently
`websocket`, `database`, `sync_protocol`, and `http_internals` — as bounded
diagnostic tools. Measure log growth during a synthetic reproduction and stop
the override if it approaches the operator's disk or ingestion threshold.

`build/scripts/server/smoke-api.sh` verifies the live Docker rotation contract
and rejects a forced global TRACE environment override. It validates logging
safety without scanning for TRACE output or changing the operational level.

---

## Troubleshooting

### "logging service not available"

The GraphQL resolver returns this error when `ApiState.logging` is `None`. This happens only in minimal test configurations. In production, `LoggingService` is always wired in during startup. If you see this in production, the server startup sequence has a bug.

### Log file not created

Check that:

1. The `file_path` directory exists or can be created.
2. The server process has write permission to the directory.
3. Use `updateLogOutput` to validate the path:

```bash
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { admin { updateLogOutput(input: { filePath: \"/opt/myoxus/logs/myoxus.log\" }) { pathValid pathError } } }"
  }' | jq .data.admin.updateLogOutput
```

### Changes lost after restart

Non-temporary runtime level changes are persisted in `app_configs`. If a
change is lost after restart, check that:

1. the GraphQL mutation did not include `autoRevertMinutes`;
2. the `app_configs` write succeeded and the Admin audit entry exists;
3. no higher-precedence `RUST_LOG` or `MYOXUS__LOGGING__LEVEL` environment
   value is fixing the startup filter.

### RUST_LOG vs config

If `RUST_LOG` is set, it takes precedence over `logging.level` in the config. However, runtime GraphQL changes override both. To avoid confusion, do not set `RUST_LOG` in production Docker environments; use `MYOXUS__LOGGING__LEVEL` instead (it participates in the config layering system).

### Viewing current levels

```bash
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "{ admin { loggingConfig { modules { group level recommendedDefault highVolumeWarning } } } }"
  }' | jq '.data.admin.loggingConfig.modules[] | {group, level, recommendedDefault, highVolumeWarning}'
```

### Viewing change history

```bash
curl -s -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "{ admin { loggingConfig { recentChanges { timestamp group previousLevel newLevel changedBy autoRevertAt } } } }"
  }' | jq .data.admin.loggingConfig.recentChanges
```

---

## Production recommendations

### Log levels

Run `info` for all Myoxus crates. Set `database` and `http_internals` to `warn` — they produce negligible output at that level and only surface actual problems. This is what the `production` preset applies.

Do not lower groups to `error` in production unless you are explicitly silencing a known-noisy issue. You will miss warnings that indicate degradation before failure.

### When to use debug

Use `debug` for a targeted investigation and always set
`autoRevertMinutes`. Choose the shortest window that covers the synthetic
reproduction; Debug is not a steady-state level.

### When to use trace

The `trace` preset raises every registered group and is inappropriate for
ordinary production diagnosis. Reproduce on an isolated stack instead. If an
incident procedure explicitly authorizes a production trace, scope it to one
group with automatic reversion, synthetic inputs, live disk monitoring, and a
post-capture secret/payload review.

### Disk management

- **Rotation**: choose `max_files` from measured file size and the approved
  incident-retention window. The packaged default is seven daily files.
- **Monitoring**: poll `diskUsage` via GraphQL and alert on the operator's log
  volume free-space threshold.
- **Hourly rotation**: use it only when measured daily files are too large for
  the operator's collection or recovery procedure; derive `max_files` from
  the approved retention window.
- **Docker log driver**: the maintained Compose file bounds stdout at `10m`
  with five files for every service. Keep an equivalent bound if the platform
  replaces that driver.

### Performance impact

Keep production at `info`/`warn` defaults. Use the preset system (`applyLogPreset(preset: "production")`) to reset after any debugging session.

### SSO callback diagnostics

The runtime-configurable `auth` group includes
`myoxus_application::organization::oidc_sync` as well as API OAuth/OIDC.
`sso.callback.failed` records a fixed phase and
allowlisted reason at WARN for every callback failure; `sso.callback.completed`
records success only after session creation. Both include duration and an
ephemeral `sso_operation_id` span field. No OAuth state is used for correlation.

Temporarily enable Auth DEBUG to inspect `sso.claims.inspected` (source, semantic
claim role, JSON type, length/count), `sso.claims.verification` (boolean only),
and `sso.claims.groups` (normalized/mapped/invalid counts). Up to eight
`sso.claims.group_preview` events per source contain salted pseudonyms and mapping
hits and the zero-based mapping-rule index. Subject/email strings also have
per-inspection pseudonyms for comparison across sources. The unlogged random salt is shared by both sources within one inspection
only; these pseudonyms cannot correlate accounts or separate login attempts.
Missing email/subject and JWT issuer/audience/expiry/type failures have explicit
redacted reasons. Full claims, raw groups, email addresses, tokens, nonces, key
IDs, endpoint URLs and raw provider error payloads must never enter these events.

The API request span records the path without query parameters and follows the
async future across polls. Gateway access logs omit query strings and Referer;
method, path, status, request ID and timings remain available. The gateway
derives the original path from `$request_uri` without its query before access
logging, so SPA fallback does not replace it with `/selfhost.html`.

Nginx request-level error logging is disabled in the gateway server block:
its built-in error formatter appends unredacted request/upstream URLs and
Referer independently of `log_format`. Diagnose request failures through the
redacted access fields, including `upstream_status`, `rt` and `urt`. Global
Nginx startup and configuration errors retain the default error log.
