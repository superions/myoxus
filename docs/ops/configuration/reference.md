# Configuration key reference

[Documentation](../../README.md) / [Operations](../README.md) / [Configuration](./README.md)

Look up configuration keys, defaults, ownership and restart behavior. Use the
[configuration guide](./README.md) for precedence, secret files and changes.

For environment-supported keys, use uppercase names with double underscores:
`server.port` becomes `MYOXUS__SERVER__PORT`. Array and file-only settings are
identified below; use the [environment format guide](./README.md#environment-variable-format)
for the complete convention.

<details>
<summary>On this page</summary>

- [tls.*](#tls)
- [server.*](#server)
- [Client update control](#client-update-control)
- [database.*](#database)
- [databases.*](#databases)
- [redis.*](#redis)
- [crypto.*](#crypto)
- [throttle.*](#throttle)
- [auth.*](#auth)
- [mail.*](#mail)
- [storage.*](#storage)
- [doc.*](#doc)
- [doc_service.*](#doc_service)
- [logging.*](#logging)
- [public_publishing.*](#public_publishing)
- [Compatibility feature files](#compatibility-feature-files)
- [oauth.*](#oauth)
- [worker.*](#worker)
- [job.*](#job)
- [copilot.*](#copilot)
- [transcription.*](#transcription)
- [calendar.*](#calendar)
- [client.*](#client)
- [i18n.*](#i18n)
- [websocket.*](#websocket)
- [mcp.*](#mcp)
- [captcha.*](#captcha)
- [flags.*](#flags)
- [metrics.*](#metrics)
- [branding.*](#branding)
- [http.*](#http)
- [cache.*](#cache)
- [template_registry.*](#template_registry)
- [telemetry.*](#telemetry)
- [indexer.*](#indexer)
- [git_sync.*](#git_sync)
- [Canonical registry inventory](#canonical-registry-inventory)
- [Complete minimal production config](#complete-minimal-production-config)
- [preview.*](#preview)

</details>

## `tls.*`

| Field                           | Default | Type and description                                                                                                                                                                                                                   |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tls.additional_ca_bundle_path` | `null`  | **string \| null**. Additional CA PEM bundle relative to runtime-config. File/ENV only, loaded before PostgreSQL. Restart every consuming process after changes. Explicit `""` selects normal public trust without legacy DB fallback. |

The deprecated `git_sync.https_ca_bundle_path` file/ENV input is accepted only
when consistent with an explicitly supplied global value. Existing DB-only
values remain readable/removable as Git-only migration state; new writes are
rejected. See [migration and loaded-state verification](../integrations/git-sync.md#additional-ca-migration).

## `server.*`

HTTP server settings.

| Field                             | Default                   | Type and description                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.host`                     | `"0.0.0.0"`               | **string**. Bind address. `0.0.0.0` listens on all interfaces. Change to `127.0.0.1` if you want to expose the API only to a local reverse proxy.                                                                                                                                                                                                                                                                                                |
| `server.port`                     | `3001`                    | **integer**. Listen port. The Docker compose file exposes this as `MYOXUS_PUBLIC_PORT` on the host.                                                                                                                                                                                                                                                                                                                                              |
| `server.origin`                   | `"http://localhost:3001"` | **string**. Public URL of this server (used for OAuth callbacks, email links, CORS). Must exactly match the scheme + host + port that the browser uses to reach the server. **MUST be set in production.**                                                                                                                                                                                                                                       |
| `server.session_ttl`              | `1296000` (15 days)       | **integer (seconds)**. Maximum session lifetime. After this period the session is unconditionally expired and the user must log in again.                                                                                                                                                                                                                                                                                                        |
| `server.session_ttr`              | `604800` (7 days)         | **integer (seconds)**. Session refresh window. If a session is used within this many seconds of expiry, it is extended automatically.                                                                                                                                                                                                                                                                                                            |
| `server.magic_link_ttl_seconds`   | `1800` (30 minutes)       | **integer (seconds)**. How long a magic-link sign-in token is valid. After expiry the user must request a new link.                                                                                                                                                                                                                                                                                                                              |
| `server.shutdown_timeout_seconds` | `5`                       | **integer (seconds)**. Graceful shutdown timeout. In-flight requests are given this many seconds to complete before the process exits.                                                                                                                                                                                                                                                                                                           |
| `server.deployment_type`          | `"standalone"`            | **`standalone` \| `cloud`**. Deployment model reported to clients via `serverConfig.deploymentType`. Drives client-side behavior only (socket transport, telemetry transport, admin UI module visibility, sign-in guards). Self-hosted deployments must keep this on `standalone` — see [Runtime overview](../deployment/runtime-overview.md#deployment-mode) for the effects table and YAML↔wire mapping. Admin changes require an API restart. |

> **Production requirement:** `server.origin` must match the URL the browser uses. If it does not, OAuth callbacks fail, email links point to the wrong host, and CORS requests from the frontend are rejected. Example: `https://myoxus.example.com` — no trailing slash, include scheme and port if non-standard.

---

## Client update control

`client.updateControl` is a reserved operational row in `app_configs`. It is
not a general runtime configuration key and must not be edited through the
Admin Config UI, YAML, environment variables, or `myoxus-cli config set`.
Operators manage it only through `myoxus-cli client-update ...`, which applies
the state-machine validation and transactional locking required for safe
repetition and concurrent commands.

The row is absent in the normal baseline until the first update-control
mutation. Do not seed it manually. If `client-update status` reports a corrupt
row, preserve the reported state for diagnosis and repair it through an
explicit operator procedure; the server does not silently treat malformed JSON
as normal operation.

Use [Browser client updates](../administration/client-updates.md) for the
operator workflow and command set.

---

## `database.*`

PostgreSQL connection settings.

**Required extension**: the database must make the `vector` extension available
to the Myoxus database owner. The central migration runner creates it during
startup. The repository container topology uses the
`pgvector/pgvector:pg16` image; native operators provide an equivalent
PostgreSQL 16 service.

pgvector is used for:

- Copilot embedding storage (`vector(1536)` columns)
- Similarity search (HNSW index, `<=>` operator)
- Hybrid search (pgvector + PostgreSQL full-text search combined)

| Field                              | Default                                                  | Type and description                                                                                                                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database.url`                     | [Bundled local URL](../../../server/config/default.yaml) | **string**. PostgreSQL connection URL. Containers use `MYOXUS__DATABASE__URL_FILE`; the entrypoint creates that file from the PostgreSQL password secret and non-sensitive host/user/database settings. **Set explicitly for bare-metal production.** |
| `database.max_connections`         | `50`                                                     | **integer**. Maximum pool size per API instance. Size the sum of every instance and other clients within measured PostgreSQL capacity and reserved operator access.                                                                                   |
| `database.min_connections`         | `2`                                                      | **integer**. Minimum pool connections kept open per API instance.                                                                                                                                                                                     |
| `database.acquire_timeout_seconds` | `5`                                                      | **integer**. Seconds to wait for a pool connection. Change it only with correlated database latency, client/proxy timeout, and failure-test evidence.                                                                                                 |

Pool exhaustion can delay WebSocket acknowledgements and appear as client
disconnects. Diagnose the combined topology before changing a bound; see
[Sync and workers](../runbooks/sync-and-workers.md#websocket--sync-issues--connection-drops).

---

## `databases.*`

Database product limits. These values are projected to the Admin UI as
`databases.*` and are restart-required. Deprecated `workspace_database.*` and
`workspaceDatabase.*` aliases remain compatibility inputs but must not be used
in new deployments or documentation examples.

| Field                                          | Default   | Type and description                                            |
| ---------------------------------------------- | --------- | --------------------------------------------------------------- |
| `databases.max_fields_per_database`            | `100`     | **integer**. Maximum fields allowed in one database.            |
| `databases.max_views_per_database`             | `25`      | **integer**. Maximum saved views allowed in one database.       |
| `databases.max_rows_per_page`                  | `500`     | **integer**. Maximum rows returned by one GraphQL page.         |
| `databases.max_cell_text_bytes`                | `16384`   | **integer**. Maximum UTF-8 text size for one cell value.        |
| `databases.csv_max_bytes`                      | `5242880` | **integer**. Maximum uploaded CSV size in bytes.                |
| `databases.csv_max_rows`                       | `10000`   | **integer**. Maximum CSV data rows accepted by import.          |
| `databases.csv_max_columns`                    | `100`     | **integer**. Maximum CSV columns accepted by import.            |
| `databases.csv_sample_rows_for_type_inference` | `100`     | **integer**. Rows sampled for CSV field type inference.         |
| `databases.max_reminders_per_user_per_cell`    | `5`       | **integer**. Maximum personal reminders per user/DateTime Cell. |
| `databases.max_reminder_offset_minutes`        | `525600`  | **integer**. Maximum reminder lead time in minutes.             |

Databases are server-authoritative. The Web client and the
`myoxus:database` editor embed read/write through GraphQL; they do not keep an
authoritative local schema or row store. See [databases.md](../data/databases/README.md).

---

## `redis.*`

Redis is a **required runtime dependency**. Startup fails if required Redis roles (`session`, `queue`, `lock`) are not reachable.

The maintained Compose profiles persist Redis through AOF and disable Redis'
additional periodic RDB save rules. Running both for a write-heavy queue causes
repeated full-dataset snapshots without adding a second independent backup.
Selfhost Compose also applies an overridable container safety ceiling via
`REDIS_MEMORY_LIMIT`/`REDIS_MEMORY_SWAP_LIMIT`; this is not a per-cache size or
TTL setting and does not replace the canonical `cache.*` tuning settings. The host
must provide `vm.overcommit_memory=1` for reliable Redis forks and AOF rewrites.

| Field                                | Default                    | Type and description                                                                                                                                                                        |
| ------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redis.url`                          | `"redis://localhost:6379"` | **string**. Default Redis connection URL. All roles without an explicit URL use this value. In Docker, the compose file overrides this to `redis://redis:6379` automatically.               |
| `redis.namespace`                    | `"myoxus"`                 | **string**. Key prefix namespace. All Redis keys are prefixed with this value. Change if sharing a Redis instance between multiple Myoxus environments (e.g. staging + prod on same Redis). |
| `redis.session_cache.enabled`        | `true`                     | **bool**. Cache sessions in Redis to reduce DB reads on every authenticated request. Disable only for debugging.                                                                            |
| `redis.session_cache.ttl_seconds`    | `300` (5 minutes)          | **integer**. Session cache TTL. After this period a cached session is re-validated against the database. Lower values increase DB load but reduce the window for stale session data.        |
| `redis.cache_ttl_quota_seconds`      | `300` (5 minutes)          | **integer**. Workspace quota limit cache TTL. Controls how often quota checks re-query the database.                                                                                        |
| `redis.cache_ttl_usage_seconds`      | `60` (1 minute)            | **integer**. Storage usage counter cache TTL. Lower value increases DB pressure but makes usage meters more responsive.                                                                     |
| `redis.cache_ttl_git_status_seconds` | `120` (2 minutes)          | **integer**. Git sync status cache TTL. Controls how stale the git-sync status shown in the UI can be.                                                                                      |

### Redis role profiles (`redis.roles.*`)

Redis is divided into five logical roles. Each role can be configured independently (e.g. pointing to different Redis instances or databases). All roles default to the main `redis.url`.

| Role                  | Purpose                                              |
| --------------------- | ---------------------------------------------------- |
| `redis.roles.cache`   | Application-level caching                            |
| `redis.roles.session` | Session storage                                      |
| `redis.roles.queue`   | Background job queue coordination                    |
| `redis.roles.socket`  | Socket.IO pub/sub for multi-instance real-time       |
| `redis.roles.lock`    | Distributed locking (e.g. preventing duplicate jobs) |

Each role config block is currently empty (`{}`), meaning all roles use the root URL. To route a role to a different URL, set `url` inside the role block:

```yaml
redis:
  url: "redis://redis-main:6379"
  roles:
    session:
      url: "redis://redis-session:6379" # separate instance for sessions
    queue: {} # uses redis.url
```

> **Multi-instance note:** The `socket` role is required for WebSocket cross-
> instance broadcast, workspace session tracking, database presence and
> notification acknowledgements. Single-node deployments continue to use
> process-local Socket.IO rooms as their fast path. In a cluster all nodes
> **must** resolve the same Redis endpoint and namespace for this role. See
> [Multi-instance deployment](../deployment/multi-instance.md).

---

## `crypto.*`

| Field                | Default                          | Type and description                                                                                                                                                                                                                              |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto.private_key` | `"myoxus-change-me-private-key"` | **string**. Encryption key for stored integration credentials and signing key for application-generated cursor and RSVP tokens. Production startup rejects the packaged placeholder. Changing the key does not revoke PostgreSQL-backed sessions. |

> **SECURITY WARNING:** The default value `myoxus-change-me-private-key` is
> public knowledge. An attacker who obtains the active key can decrypt stored
> integration credentials and forge the application tokens that use this key.
> Generate a unique key directly into an owner-only file before first start:
>
> ```bash
> install -m 600 /dev/null /protected/path/crypto-private-key
> openssl rand -hex 32 >/protected/path/crypto-private-key
> ```
>
> Provision the result through the protected crypto-key file used by the
> Docker or systemd deployment. Do not put it in YAML or shell history.
> The current release has no general in-place rotation workflow. Rotation
> requires a separately reviewed decrypt/re-encrypt plan for every stored
> credential and invalidates outstanding cursor and RSVP tokens; it does not
> invalidate PostgreSQL-backed sessions.

---

## `throttle.*`

Rate limiting settings. Rate limiting is disabled by default to avoid false positives in development. Enable for public-facing production deployments.

| Field                                | Default            | Type and description                                                                                                               |
| ------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `throttle.enabled`                   | `false`            | **bool**. Enable rate limiting. When false, all throttle configuration is ignored.                                                 |
| `throttle.throttlers.default.ttl_ms` | `60000` (1 minute) | **integer**. Default throttle window in milliseconds. Requests are counted within this sliding window.                             |
| `throttle.throttlers.default.limit`  | `120`              | **integer**. Maximum requests per window under the default policy. The operator must load-test and monitor the selected value.     |
| `throttle.throttlers.strict.ttl_ms`  | `60000` (1 minute) | **integer**. Strict throttle window in milliseconds. Applied to authentication endpoints (sign-in, magic-link).                    |
| `throttle.throttlers.strict.limit`   | `20`               | **integer**. Maximum requests per window under the strict policy. It is one control and is not a brute-force-prevention guarantee. |

---

## `auth.*`

| Field                             | Default | Type and description                                                                                                                                                                                             |
| --------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.reject_plus_aliases`        | `true`  | **boolean**. Reject email addresses that use `+` aliases unless an administrator explicitly permits them.                                                                                                        |
| `auth.password_reset_ttl_seconds` | `1800`  | **integer**. Lifetime of newly issued password-reset tokens, from `300` to `86400` seconds. The value is materialized at server startup; Admin changes require a restart and never rewrite existing expirations. |

Password-reset links always use the validated `server.origin`. Admin and
self-service callers cannot override the origin; an optional callback must be a
local path. A successful reset consumes the token once and revokes all existing
sessions for the account.

---

## `mail.*`

Email sending configuration. If `smtp_host` is not set, delivery is disabled;
the server logs only the template name and suppression status. Message bodies,
authentication links and codes are never logged. Port and transport are
independent: changing the port never changes the selected wire protocol.

| Field                             | Default                  | Type and description                                                                                                                                                                              |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mail.sender`                     | `"noreply@myoxus.local"` | **string**. From address. Set to a real address in production, e.g. `"Myoxus <noreply@example.com>"`.                                                                                             |
| `mail.smtp_host`                  | `null`                   | **string \| null**. SMTP server hostname. If null, actual delivery is disabled.                                                                                                                   |
| `mail.smtp_port`                  | `587`                    | **integer**. SMTP endpoint port. It does not imply a transport mode. Common conventions are 25/587 for STARTTLS and 465 for implicit TLS.                                                         |
| `mail.smtp_transport`             | `starttls`               | **`plain` \| `starttls` \| `implicit_tls`**. Exact wire protocol. `starttls` requires the server capability and refuses downgrade; `implicit_tls` starts TLS immediately; `plain` never upgrades. |
| `mail.smtp_verify_certificate`    | `true`                   | **boolean**. Validate the TLS certificate against trusted roots. Disable only for an explicitly isolated development endpoint.                                                                    |
| `mail.smtp_user`                  | `null`                   | **string \| null**. Authentication username. Leave both user and password null for a trusted relay or MX server that does not require authentication.                                             |
| `mail.smtp_pass`                  | `null`                   | **string \| null**. Authentication password. User and password must be either both non-empty or both null. Keep secrets out of config files.                                                      |
| `mail.fallback_domains`           | `[]`                     | **string[]**. Exact, case-insensitive recipient domains routed through `fallback_smtp`. Subdomains do not match implicitly.                                                                       |
| `mail.fallback_smtp`              | `null`                   | **object \| null**. Secondary endpoint with `host`, `port`, optional credential pair, `transport`, `verify_certificate`, and `sender`; required when fallback domains are present.                |
| `mail.enable_notification_emails` | `false`                  | **bool**. Send notification emails. Requires `smtp_host`; when false, notification events continue without email delivery.                                                                        |

The Admin **System -> Mail** page and setup wizard expose the same transport,
certificate, and optional-authentication contract. A legacy
`mailer.*.ignoreTLS=false` value migrates once to verified STARTTLS, except
port 465 which migrates to verified implicit TLS. `ignoreTLS=true` is
ambiguous and remains visible as an operator action until an explicit
transport is saved.

## Template root

| Key                  | Default         | Description                                                                                                                                     |
| -------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `templates.root_dir` | `"./templates"` | Nonempty shared root containing `mail/`, `documents/`, `pdf/`, `html/` and `databases/`. Non-sensitive, database-writable and restart-required. |

Admin **Templates -> Settings** exposes the root even when the document Registry
is disabled. Save/reset and YAML writeback use the central configuration writer.
A saved root is the configured value; the running consumers retain their startup
catalog until the API restarts. Relative roots resolve from the process working
directory. The packaged working directory is `/opt/myoxus`, so the default root
resolves to `/opt/myoxus/templates`. In Docker, use the path **inside the API
container**; saving it does not create a directory or change a mount.

Database starters load `root/databases/catalog.yaml` and its explicitly selected
immutable YAML versions and pinned Task core. File-format version and semantic
content version are distinct. Only `.yaml` sources are accepted; JSON remains an
API/snapshot representation. Every retained reference is bounded, decoded and
validated before admission. Missing/corrupt files, duplicate/unknown keys,
escaping paths and digest mismatches stop startup after normal SQL migrations;
there is no compiled or checkout fallback and no hot reload. Restart captures
one catalog shared by list and create; source loading itself modifies no instance.
The managed-definition updater separately applies supported forward transitions.

`root/assistants/catalog.yaml` selects immutable package identities/versions/digests
for existing Project creation and Task presentation. Both snapshots are admitted
together. Files own offering order, defaults, finite choices and simple typed
forms/dialogs; native code owns executable adapters and permissions. Run
`myoxus-cli templates validate-source-set --root <template-root>` for file-only
admission, adding `--against-root <installed-template-root>` to verify retained
pins and forward promotion. Delivery checks all dependencies before replacing
either catalog. No source upload, independent configuration root, dynamic-code
execution or hot reload is added.

Mail loads `root/mail` and the configured native bundles load from
`root/documents`. Required missing or invalid inputs stop startup rather than
falling back to checkout files. Normal mail delivery and Admin SMTP tests share
the same captured catalog, including when the test selects another SMTP endpoint.
PDF and HTML retain their existing loaders until their external-catalog cutover.
Changing the root does not rewrite stored documents or registered revisions.

### Mail catalog

The directory contains `en/`, `de/`, `fr/`, `es/` and `it/` language folders,
each with one HTML file per mail type and `_copy.json` for shared translated
labels. `_layout.html` owns the common design; `assets/` contains the Myoxus mark
and licensed Inter font files. Edit the subject in the HTML template's `subject`
block. Its HTML `<title>` becomes the SMTP subject, and the readable text MIME
alternative is derived from the same rendered document. Template values such as
`{{ actor }}`, `{{ workspace_name }}` and `{{ url }}` are escaped automatically.
Do not apply `safe` to recipient, actor or document data.

Recipient account preferences select the mail language, date format, time
format and time zone. Regional locale codes resolve to their base language.
Unknown languages use `i18n.default_locale`, then English. Email-change
confirmation uses the requesting account's language even when the new address
does not yet belong to an account. Fonts and the mark are included as inline
MIME resources; clients that do not support embedded web fonts use the template's
Arial/Helvetica fallback without contacting a third-party service.

Preparation upgrades deployed flat directories without deleting original files.
Known old stock files receive the new localized defaults. Modified flat files
are copied into `en/` before missing defaults are seeded; their bodies remain
customized, missing subjects and the old sign-in control delimiters are repaired.
Existing files in language folders always take precedence. Flat files remain
recovery inputs and are no longer loaded by the renderer. Invalid templates or
missing catalog files fail initialization rather than falling back to raw links.

---

## `storage.*`

Blob storage for user uploads, avatars, and document attachments.

| Field                                | Default          | Type and description                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.backend`                    | `"local"`        | **`local` \| `s3` \| `r2`**. Storage backend. Use `local` for single-node deployments. Use `s3` (AWS S3, MinIO, etc.) or `r2` (Cloudflare R2) for multi-instance or cloud deployments.                                                                                                   |
| `storage.root`                       | `"./storage"`    | **string \| null**. Local filesystem root (only for `backend: local`). Must be writable by the server process. In Docker the compose file sets this to `/opt/myoxus/data/storage`. CLI Markdown imports must use the same root when materializing embedded images for public publishing. |
| `storage.bucket`                     | `"myoxus-local"` | **string \| null**. S3/R2 bucket name. The bucket must exist before starting the server.                                                                                                                                                                                                 |
| `storage.prefix`                     | `null`           | **string \| null**. Key prefix within the bucket. Useful for sharing a bucket between multiple Myoxus environments.                                                                                                                                                                      |
| `storage.endpoint`                   | `null`           | **string \| null**. S3-compatible endpoint URL. Required for Cloudflare R2 and self-hosted S3-compatible stores (MinIO, etc.). Not needed for standard AWS S3.                                                                                                                           |
| `storage.region`                     | `null`           | **string \| null**. AWS region (e.g. `eu-west-1`). Required for AWS S3. Optional for S3-compatible services.                                                                                                                                                                             |
| `storage.access_key`                 | `null`           | **string \| null**. S3 access key ID. Pass via environment variable in production — do not commit to config files.                                                                                                                                                                       |
| `storage.secret_key`                 | `null`           | **string \| null**. S3 secret access key. Pass via environment variable in production — do not commit to config files.                                                                                                                                                                   |
| `storage.io_timeout_seconds`         | `15`             | **integer**. Timeout for individual storage I/O operations. Increase for high-latency remote storage.                                                                                                                                                                                    |
| `storage.s3_max_retries`             | `3`              | **integer**. Number of retry attempts for failed S3 operations.                                                                                                                                                                                                                          |
| `storage.default_workspace_quota_mb` | `0`              | **integer**. Per-workspace storage quota in MB. `0` means unlimited.                                                                                                                                                                                                                     |
| `storage.signed_url_ttl_seconds`     | `3600` (1 hour)  | **integer**. Signed URL expiry for blob downloads. After this period the URL is no longer valid and the client must request a fresh one.                                                                                                                                                 |
| `storage.max_upload_mb`              | `512`            | **integer**. Maximum single upload size in MB. Requests exceeding this limit receive HTTP 413.                                                                                                                                                                                           |
| `storage.multipart_threshold_mb`     | `8`              | **integer**. Uploads larger than this use multipart upload for S3-backed storage.                                                                                                                                                                                                        |
| `storage.multipart_part_size_bytes`  | `5242880` (5 MB) | **integer**. Part size for multipart uploads. S3 requires parts to be at least 5 MB (except the last).                                                                                                                                                                                   |
| `storage.multipart_max_parts`        | `10000`          | **integer**. Maximum multipart part count; the lower effective upload and provider limits still apply.                                                                                                                                                                                   |
| `storage.min_free_space_mb`          | `0`              | **integer**. Startup readiness threshold for the local backend. `0` disables the startup check; this value does not reject later writes or replace continuous monitoring.                                                                                                                |

### S3 example

```yaml
storage:
  backend: "s3"
  bucket: "my-myoxus-bucket"
  region: "eu-west-1"
```

### Cloudflare R2 example

```yaml
storage:
  backend: "r2"
  bucket: "my-myoxus-bucket"
  endpoint: "https://ACCOUNT_ID.r2.cloudflarestorage.com"
```

Inject `storage.access_key` and `storage.secret_key` through the deployment's
protected environment mechanism; never commit their values to YAML.

---

## `doc.*`

Document and sync settings.

`doc.decoder_concurrency` defaults to **8** concurrent decoders per API process.
Pulls and external writes share this gate; it is neither a cluster-wide worker
count nor a global limit on every Yrs call. Values such as **16** can improve
throughput while increasing peak memory and must be sized for the workload.
Positive integers up to the platform semaphore limit are accepted; zero,
fractions, negatives and overflow are rejected without clamping.

The normal source order applies: bundled defaults, run-mode/local YAML, runtime
overlay, environment, then database overrides. Set it in YAML, through
`MYOXUS__DOC__DECODER_CONCURRENCY`, or through the existing Admin/CLI configuration
writer. Database changes are durable but require a process restart; the active
gate is unchanged until then. Removing an override restores the underlying
source on restart. Admin shows the existing restart-required feedback.

| Field                       | Default               | Type and description                                                                                                                                                                                                                   |
| --------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc.history.enabled`       | `true`                | **bool**. Global default for automatic unnamed edit capture. Workspace overrides may explicitly enable, disable or inherit it. Disabling stops scheduling but retains evidence of uncaptured changes.                                  |
| `doc.history.interval`      | `86400000` (24 hours) | **integer (ms)**. Global automatic edit-capture interval. New values must be between 900,000 ms and 86,400,000 ms. Previously persisted positive values below the minimum resolve to 900,000 ms without rewriting the stored value.    |
| `doc.experimental.yocto`    | `false`               | **bool**. Enable experimental y-octo sync engine. Do not enable in production — this is a development flag for testing alternative Yjs implementation.                                                                                 |
| `doc.ingress.max_update_mb` | `32`                  | **integer (MiB)**. Startup-only decoded Yjs-v1 limit for every external client update. `0` and values that overflow the host byte type reject startup. This is a business ingress limit, distinct from the Socket.IO transport buffer. |

The existing document worker polls persisted due-state every 30 seconds in
bounded batches. The configured interval begins with the first accepted changed
content after the preceding capture; later edits do not postpone it. Actual
capture may lag by polling, processing, retry backoff or an outage. Intent
survives restart, but unavailable time cannot reconstruct intermediate states
that were never captured. Worker heartbeat and last successful automatic
capture are reported by the workspace settings API.

`cleanup.history_retention_days` removes only expired `doc_histories` rows that
are not referenced by any named `document_version`. Named, pinned, protected,
published and PDF-export references remain governed by the existing named-version
retention policy and keep their underlying history row while the reference
exists. Current `doc_snapshots` are outside this cleanup. Document history is
not an asset backup or an indefinite archive; operators must provide a separate
backup strategy for those requirements.

---

## `doc_service.*`

Optional remote document service for read-path offloading.

| Field                  | Default | Type and description                                                                                                                                                          |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc_service.endpoint` | `null`  | **string \| null**. Endpoint URL for the remote doc service. If null, document reads are served locally. Leave null unless you are running a dedicated document read service. |

---

## `logging.*`

See [logging.md](../observability/logging.md) for detailed logging operations guide including runtime log level changes, presets, and disk management.

| Field                 | Default                                                   | Type and description                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logging.level`       | [Bundled log filter](../../../server/config/default.yaml) | **string**. EnvFilter directive string. Supports per-module levels: `"info,sqlx::query=warn,tungstenite=warn"`. The default suppresses noisy dependencies. Also overridden by `RUST_LOG` (which takes precedence over this config key). |
| `logging.file_path`   | `null`                                                    | **string \| null**. If set, logs are written to this file in addition to stdout. The directory is created automatically. In Docker the compose file sets this to `/opt/myoxus/data/logs/myoxus.log`.                                    |
| `logging.rotation`    | `"daily"`                                                 | **`never` \| `daily` \| `hourly`**. Log file rotation strategy. With `file_path: myoxus.log`, daily files are named `myoxus.YYYY-MM-DD.log` and hourly files add `-HH`. `never` creates `myoxus.log`.                                   |
| `logging.max_files`   | `7`                                                       | **integer**. Maximum retained rolling files when rotation is enabled. The rolling appender prunes beyond this count; derive the value from observed file size and operator retention policy.                                            |
| `logging.max_history` | `20`                                                      | **integer**. Number of log-level change records to retain in the in-memory change history (visible via `loggingConfig.recentChanges` GraphQL query).                                                                                    |

---

## `public_publishing.*`

Anonymous publishing settings for `/public/{workspace_id}`,
`/public/{workspace_id}/{doc_id}` and `/public-assets/...`. These options
control delivery, cache headers and renderer features only. They do not grant
public access; document visibility is controlled by `docs.public_mode`, and
workspace index visibility is controlled by `workspaces.public`.

| Field                                                      | Default                    | Type and description                                                                                                       |
| ---------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `public_publishing.enabled`                                | `true`                     | **bool**. Master switch for anonymous public API routes.                                                                   |
| `public_publishing.dynamic_routes_enabled`                 | `true`                     | **bool**. Serve `/public/...` routes from the API. Treat this as an emergency delivery switch, not as a snapshot selector. |
| `public_publishing.static_export_root`                     | `"/var/lib/myoxus/public"` | **string**. Legacy CLI HTML snapshot root. Not used by the canonical `/public/...` delivery path.                          |
| `public_publishing.static_retention_releases`              | `5`                        | **integer**. Legacy CLI snapshot retention count. Not used by dynamic public routes.                                       |
| `public_publishing.html_cache_ttl_seconds`                 | `300`                      | **integer**. Cache TTL for dynamic public HTML responses.                                                                  |
| `public_publishing.asset_cache_max_age_seconds`            | `31536000`                 | **integer**. Cache max-age for content-hashed public assets.                                                               |
| `public_publishing.default_noindex`                        | `false`                    | **bool**. Default robots mode for public pages until document-specific SEO metadata exists.                                |
| `public_publishing.site_shell.breadcrumbs_enabled`         | `true`                     | **bool**. Render public breadcrumb navigation.                                                                             |
| `public_publishing.site_shell.toc_enabled`                 | `true`                     | **bool**. Render a table of contents from public document headings.                                                        |
| `public_publishing.site_shell.max_toc_depth`               | `3`                        | **integer**. Maximum heading depth included in the public table of contents.                                               |
| `public_publishing.site_shell.previous_next_enabled`       | `true`                     | **bool**. Render previous/next document navigation when route context provides adjacent pages.                             |
| `public_publishing.site_shell.code_copy_enabled`           | `true`                     | **bool**. Add copy controls for public code blocks.                                                                        |
| `public_publishing.site_shell.syntax_highlighting_enabled` | `true`                     | **bool**. Apply server-side syntax highlighting to public code blocks.                                                     |
| `public_publishing.site_shell.search_enabled`              | `true`                     | **bool**. Reserved for public search surfaces; dynamic public pages currently render without Pagefind.                     |
| `public_publishing.pagefind.enabled`                       | `true`                     | **bool**. Legacy CLI snapshot Pagefind switch. Not used by dynamic public routes.                                          |
| `public_publishing.pagefind.binary`                        | `"pagefind"`               | **string**. Legacy CLI snapshot Pagefind executable.                                                                       |
| `public_publishing.social_cards.enabled`                   | `true`                     | **bool**. Legacy CLI snapshot social-card switch. Not used by dynamic public routes.                                       |

Operational logging for this feature uses the existing Admin logging system
under the `public_publishing` group. Raise it temporarily to `debug` when
diagnosing public ACL decisions, renderer failures, asset materialization or
workspace theme CSS issues.

---

## Compatibility feature files

The following file paths support static capability projection. They are not
authorization sources; server permissions remain authoritative.

| Field                            | Default                     | Type and description                                                                    |
| -------------------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `compat.features.user_file`      | `"features.user.yaml"`      | **string**. Path (relative to config dir) to per-user feature flag overrides file.      |
| `compat.features.workspace_file` | `"features.workspace.yaml"` | **string**. Path (relative to config dir) to per-workspace feature flag overrides file. |

Billing, payment, subscription, seat-plan and plan-based quota values are not
supported operator configuration. Neutral wire fields that remain necessary
for an already shipped client schema are internal protocol details and must not
be used to model product policy.

---

## `oauth.*`

OAuth and OIDC provider configuration. All providers are disabled by default.

| Field                        | Default | Type and description                                                                                                                                                                      |
| ---------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth.google_client_id`     | `null`  | **string \| null**. Google OAuth client ID. Obtain from Google Cloud Console.                                                                                                             |
| `oauth.google_client_secret` | `null`  | **string \| null**. Google OAuth client secret. Pass via environment variable in production.                                                                                              |
| `oauth.github_client_id`     | `null`  | **string \| null**. GitHub OAuth client ID. Obtain from GitHub Developer Settings.                                                                                                        |
| `oauth.github_client_secret` | `null`  | **string \| null**. GitHub OAuth client secret. Pass via environment variable in production.                                                                                              |
| `oauth.providers`            | `{}`    | **map**. Generic OIDC providers (key = provider name, e.g. `oidc`). The key must match the `provider` value used in `/api/oauth/preflight` requests from the frontend. Configure in YAML. |

### Generic OIDC provider example (authentik)

```yaml
oauth:
  providers:
    oidc:
      client_id: "myoxus"
      # Inject MYOXUS__OAUTH__PROVIDERS__OIDC__CLIENT_SECRET through the
      # deployment's protected secret mechanism.
      issuer_url: "https://auth.example.com/application/o/myoxus/"
      discovery_url: "https://auth.example.com/application/o/myoxus/.well-known/openid-configuration"
      auth_url: "https://auth.example.com/application/o/myoxus/authorize/"
      token_url: "https://auth.example.com/application/o/myoxus/token/"
      userinfo_url: "https://auth.example.com/application/o/myoxus/userinfo/"
      jwks_url: "https://auth.example.com/application/o/myoxus/jwks/"
      # Scopes to request (defaults: openid, profile, email)
      scopes: ["openid", "email", "profile", "groups"]
      claims:
        subject: "sub"
        email: "email"
        emailVerified: "email_verified"
        name: "name"
        avatar: "picture"
        groups: "groups"
        groupsSource: "userinfo"
      groupMapping:
        enabled: true
        defaultRole: "member"
        removeMissingOidcMemberships: true
        missingGroupsPolicy: "deny_login"
        unknownGroups: "ignore"
        mappings:
          - providerGroup: "dept-finance"
            targetUnitId: "00000000-0000-0000-0000-000000000000"
          - providerGroup: "team-platform"
            targetUnitId: "00000000-0000-0000-0000-000000000000"
            role: "manager"
```

For Keycloak, keep the same object shape but use the realm issuer, for example
`https://keycloak.example.com/realms/myoxus`, and the realm's
`protocol/openid-connect/*` endpoints. The provider key (`oidc`, `google`,
`github`) must match the `provider` value used in `/api/oauth/preflight`
requests from the frontend.

The Admin Security page and Config Wizard store the same runtime shape in the
database using camelCase keys (`authUrl`, `tokenUrl`, `userinfoUrl`) through
`adminUpdateConfig`. Both YAML and runtime config are parsed by the same
server-side OAuth provider model. The Admin UI offers Authentik, Keycloak and
Custom presets; presets only derive conventional endpoint URLs and claim
defaults from the issuer URL, then persist the normal `oauth.providers.oidc`
object.

OIDC `groupMapping` reconciles provider groups to Myoxus organization units
only. It writes `organization_unit_member.source=oidc`, uses
`defaultRole=member` when a rule omits a role, and preserves non-OIDC
memberships. With `missingGroupsPolicy=deny_login`, a missing groups claim
blocks login before a new local OAuth account is created.

Use the Admin Security **Test OIDC provider** action after changing this config.
It performs server-side Discovery/JWKS requests and optional sample-claims
counting with an HTTPS-only URL guard, except localhost development endpoints.
The result is redacted to status flags, counts and warnings.

---

## `worker.*`

Startup-owned registered-job intervals and the shared SQL admission cadence.

Job queue configuration (concurrency, retry policy, and queue ownership) is
exclusively under `job.*`. The server rejects retired `worker.default_policy`,
`worker.queues.*`, and `worker.runtime.*` paths instead of accepting an ignored
parallel configuration.

| Field                                             | Default           | Type and description                                                                                                                                                                                  |
| ------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker.cron_tick_interval_seconds`               | `30`              | **integer**, minimum1. Shared SQL admission cadence inside the existing outbox loop. Requires API restart; it is not a Redis leader/repeat scheduler or a queue retry setting.                        |
| `worker.polling.doc_maintenance_interval_ms`      | `120000` (2 min)  | **integer**. How often to run doc maintenance (merge pending Yjs updates into the document snapshot). Lower values reduce memory pressure; higher values reduce write amplification.                  |
| `worker.polling.indexer_auto_index_interval_ms`   | `30000` (30 sec)  | **integer**. How often to trigger search auto-indexing for newly changed documents. Lower values make search results fresher but increase indexer load.                                               |
| `worker.polling.caldav_sync_interval_ms`          | `900000` (15 min) | **integer**. How often to trigger CalDAV calendar sync. Lower values increase freshness but increase load on the CalDAV server.                                                                       |
| `worker.polling.google_calendar_sync_interval_ms` | `900000` (15 min) | **integer**. How often to trigger Google Calendar sync.                                                                                                                                               |
| `worker.polling.database_projection_interval_ms`  | `30000` (30 sec)  | **integer**. How often the API schedules Database projection catch-up jobs for stale, failed or missing Rollup/Formula projections. Lower values improve freshness; higher values reduce queue churn. |

Database reminder limits `databases.max_reminders_per_user_per_cell` and
`databases.max_reminder_offset_minutes` are startup-materialized and
restart-required. Admin exposes them under Performance / Limits. Shared
`worker.cron_tick_interval_seconds` and its bounded dispatch budget own admission;
there is no reminder-specific polling interval or claim-batch setting.

Registered scheduling intervals and template drift-scan cadence are likewise
restart-bound. Admin projects pending values as restart-required rather than
promising a live timer update. Native queue attempts/backoff/retention remain
under `job.*` and are not reconfigured by a schedule edit.

---

## `job.*`

Job queue configuration covers retry policy, worker polling and per-queue
concurrency. Admin changes are persisted in `app_configs`, but every `job.*`
descriptor is restart-required: the API materializes one coherent worker
snapshot while registering queue handlers. The Admin effective-value view
reports a changed database value as `PENDING_RESTART` until the API restarts.

`job.queue` is one atomic object. Its JSON/YAML members are:

| Member               | Type              | Default         | Description                          |
| -------------------- | ----------------- | --------------- | ------------------------------------ |
| `attempts`           | integer           | `5`             | Number of retry attempts per job     |
| `backoff.type`       | string            | `"exponential"` | Retry backoff strategy               |
| `backoff.delay`      | integer (ms)      | `1000`          | Base delay for backoff               |
| `removeOnComplete`   | bool              | `true`          | Remove completed jobs from the queue |
| `removeOnFail.age`   | integer (seconds) | `86400`         | Keep failed jobs for this long       |
| `removeOnFail.count` | integer           | `500`           | Keep at most this many failed jobs   |

CLI, REST and GraphQL writers replace the complete `job.queue` object; its
members are not independent registry paths.

### Worker runtime (`job.worker`)

`job.worker` is one atomic object with a `pollTimeoutSeconds` integer member
(default `5`). It limits one bounded atomic dequeue-poll cycle. Lower values
increase shutdown responsiveness; higher values reduce Redis command volume.

### Per-queue concurrency (`job.queues.*`)

Each `job.queues.<name>` registry path owns an object of the form
`{"concurrency": <integer>}`. Queue policies can be configured independently,
but each update replaces the complete object. Values are applied when the API
process registers its queue handlers and therefore require a restart after an
Admin change.

| Queue                         | Config key                                           | Default concurrency | Description                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `copilot`                     | `job.queues.copilot.concurrency`                     | **2**               | AI title generation, embeddings, session cleanup. Low default because LLM API calls are slow and holding 10 concurrent connections is rarely needed. Increase if using a fast local model. |
| `doc`                         | `job.queues.doc.concurrency`                         | 1                   | Merge pending doc updates, summary generation. Serial processing prevents write conflicts on the same document.                                                                            |
| `indexer`                     | `job.queues.indexer.concurrency`                     | **3**               | Search index updates, auto-indexing. Higher concurrency allows indexing multiple documents in parallel.                                                                                    |
| `notification`                | `job.queues.notification.concurrency`                | **4**               | Email, invitations, mentions and Database Row reminder delivery. Concurrency is limited by SMTP connection limits.                                                                         |
| `nightly`                     | `job.queues.nightly.concurrency`                     | 1                   | Nightly cleanup jobs (orphan removal, compaction). Serial to avoid competing with production workloads.                                                                                    |
| `calendar-reminder`           | `job.queues.calendar-reminder.concurrency`           | 2                   | Calendar reminder processing and dispatch.                                                                                                                                                 |
| `git-sync`                    | `job.queues.git-sync.concurrency`                    | 1                   | Git repository synchronization (clone, push, pull). Serial to avoid concurrent git operations on the same repo.                                                                            |
| `template-registry`           | `job.queues.template-registry.concurrency`           | 1                   | Template import, reconciliation, drift scan.                                                                                                                                               |
| `caldav-sync`                 | `job.queues.caldav-sync.concurrency`                 | 1                   | CalDAV calendar synchronization.                                                                                                                                                           |
| `google-calendar-sync`        | `job.queues.google-calendar-sync.concurrency`        | 1                   | Google Calendar synchronization.                                                                                                                                                           |
| `database`                    | `job.queues.database.concurrency`                    | 1                   | Database projection, search, import/export and personal reminder claim jobs. Keep serial unless measured queue latency requires tuning.                                                    |
| `workspace-content-operation` | `job.queues.workspace-content-operation.concurrency` | 1                   | Durable cross-workspace content-operation envelopes. Semantic steps remain SQL-authoritative and idempotent.                                                                               |

### Restart lifecycle

The canonical configuration reload loop intentionally excludes `job.*` from
its live snapshot. Queue retry, polling, retention and concurrency values must
change together with worker registration, so a running process keeps its
startup `JobConfigSnapshot`. Restart every API/worker instance after changing
one of these values; mixed old/new worker policy during a rolling restart is
visible through normal instance revision monitoring.

---

## `transcription.*`

External speech recognition is independent of chat/Copilot. All fields are
live and writable through the existing Admin configuration contract; saving
requires no external-service check. Activation requires a valid explicit base
URL and model. Endpoint/model have no packaged defaults. Ordinary client
capabilities expose only sanitized status and limits.

| Field                                | Default     | Type and description                                                                                                                                       |
| ------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcription.enabled`              | `false`     | **bool**. Enable explicitly configured external speech recognition.                                                                                        |
| `transcription.endpoint`             | unset       | **string**. HTTP(S) base URL. The adapter appends `/audio/transcriptions`; reject credentials, query parameters, fragments and the complete operation URL. |
| `transcription.model`                | unset       | **string**. Operator-selected identifier; at most 256 bytes, without control characters.                                                                   |
| `transcription.api_key`              | `null`      | **string or null**. Optional protected bearer credential. Masked readback; `MYOXUS__TRANSCRIPTION__API_KEY_FILE` is the allowlisted secret-file input.     |
| `transcription.language`             | `null`      | **string or null**. Optional language hint; at most 64 bytes, without control characters.                                                                  |
| `transcription.request_timeout_ms`   | `120000`    | **integer**, 100–600000 ms. Total request deadline including retries and response reading.                                                                 |
| `transcription.max_input_bytes`      | `104857600` | **integer**, 1–1073741824 bytes. Maximum encoded audio size.                                                                                               |
| `transcription.max_response_bytes`   | `16777216`  | **integer**, 1024–67108864 bytes. Maximum external JSON response size.                                                                                     |
| `transcription.max_duration_seconds` | `7200`      | **integer**, 1–86400 seconds. Maximum duration when reported by the service.                                                                               |
| `transcription.max_concurrency`      | `2`         | **integer**, 1–64. Shared simultaneous speech-request admission, retained across live config changes.                                                      |

Canonical DB overrides retain normal priority over YAML/ENV. An explicit new
`transcription.model` key takes precedence over the deprecated
`copilot.transcription_model` ingress alias, including a new YAML/ENV value
over an old DB-only alias. Migration selects neither a speech endpoint nor
activation, and never changes chat-provider values. New writes to the retired
key are rejected; the next canonical config write retires an existing old DB row.
Protected sources and deployment locks follow the
[configuration guide](./README.md). HTTPS uses the shared `tls.*` trust policy;
internal HTTP is allowed and redirects are disabled. See
[external transcription](../integrations/transcription.md) for the API contract.

## `copilot.*`

AI/Copilot integration. All providers are disabled by default. Copilot features are available only when at least one provider is enabled with a valid API key.

| Field                        | Default                    | Type and description                                                                                                                                   |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `copilot.default_provider`   | `"openai"`                 | **string**. Provider to use by default. Must match a key under `copilot.providers`.                                                                    |
| `copilot.fallback_providers` | `["local"]`                | **list**. Providers to try in order if the default provider fails or is unavailable. Configure in YAML.                                                |
| `copilot.request_timeout_ms` | `30000` (30 sec)           | **integer**. Bounds explicit selected-context preparation and supplies legacy timeout diagnostics. Provider requests use each provider's `timeout_ms`. |
| `copilot.embedding_model`    | `"text-embedding-3-small"` | **string**. Legacy setting; productive workspace indexing and retrieval use `copilot.embedding.model`.                                                 |
| `copilot.unsplash.key`       | `null`                     | **string \| null**. Unsplash API key for image suggestions feature. Leave null to disable.                                                             |
| `copilot.exa.key`            | `null`                     | **string \| null**. Exa API key for web search integration. Leave null to disable.                                                                     |
| `copilot.storage_prefix`     | `"copilot/"`               | **string**. Prefix for Copilot-generated assets stored in blob storage.                                                                                |

### Provider configuration (`copilot.providers.*`)

Provider settings, `copilot.default_provider`, `copilot.fallback_providers` and
`copilot.request_timeout_ms` require a server restart after saving. Admin reports
this activation requirement; saving does not reconstruct live providers.

Native chat reserves bounded context preparation and retrieval time in addition
to the configured provider/fallback deadlines. The global preparation bound must
not truncate the provider's opening/body deadline. Explicit document context
works without an embedding model. Unavailable or oversized source content fails
visibly rather than being silently removed from the prompt.

Selected PDF/TXT/CSV uploads use `storage.max_upload_mb`, the configured upload
MIME policy and `mcp.document_export_max_bytes` for bounded input/extracted output.
`copilot.request_timeout_ms` also bounds each context-ingestion execution. The
existing Copilot Redis worker handles dispatch, lease recovery and retries;
no embedding provider or separate ingestion daemon is required. Linux parser
children enforce derived process resource limits and do not load server secrets.
Unsupported/no-text/malformed extraction remains failed with a redacted code.
Retry retains the durable blob; old uploads without stored bytes require reupload.

Optional `model_options` keys must match literal entries in that provider's
`models` list, including dots/slashes. Existing models-only configurations remain
valid and use provider defaults. Example for an endpoint that supports vLLM's
thinking toggle:

```yaml
models: ["model.v1/path"]
model_options:
  "model.v1/path":
    reasoning_control:
      type: enable_thinking
```

For an endpoint using standard effort instead, set `type: reasoning_effort` with
explicit distinct `on` and `off` values from `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`. Only configure values supported by that endpoint/model; there is
no support inference. Without a control the chat switch is unavailable and no
override is sent. Remove the model's option entry to restore provider defaults.

For a verified image-capable endpoint/model, the same literal model entry accepts
`supports_vision: true` (default false). This does not install or probe a model.
Admin's model switch edits that declaration while preserving reasoning settings.
Save and restart the server to activate it. Native image turns and every fallback
require the declaration; unsupported input is rejected without dropping the
images. Image bytes use the existing workspace blob upload limit and MIME policy,
not arbitrary external image URLs.

Each provider is configured as a named entry under `copilot.providers`:

| Field                                 | Default | Type and description                                                                                |
| ------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `copilot.providers.<name>.enabled`    | `false` | **bool**. Enable this provider                                                                      |
| `copilot.providers.<name>.kind`       | —       | **`openai` \| `local` \| `custom`**. Provider type (accepts `openai`, `open-ai`, `local`, `custom`) |
| `copilot.providers.<name>.endpoint`   | varies  | **string \| null**. API base URL (no trailing slash)                                                |
| `copilot.providers.<name>.api_key`    | `null`  | **string \| null**. Bearer token for API authentication                                             |
| `copilot.providers.<name>.models`     | `[]`    | **list**. Statically configured model list for `list_models`                                        |
| `copilot.providers.<name>.timeout_ms` | `30000` | **integer**. Per-request timeout for this provider                                                  |

### Embedding pipeline (`copilot.embedding.*`)

Separate startup-bound transport for indexing and query embeddings, independent
of chat fallback and its circuit breaker. Without `endpoint`, workspace retrieval
is explicitly unavailable; text chat and selected context remain usable. The
normal startup migration preserves old vectors while allowing model-specific
dimensions. A model/dimension change requires reindexing, not padding or relabeling
old values. See [embedding operations](../integrations/copilot-embeddings.md).

| Field                              | Default                    | Type and description                                                                                                         |
| ---------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `copilot.embedding.endpoint`       | `null`                     | **string \| null**. OpenAI-compatible embedding API endpoint                                                                 |
| `copilot.embedding.api_key`        | `null`                     | **string \| null**. API key for the embedding endpoint                                                                       |
| `copilot.embedding.model`          | `"text-embedding-3-small"` | **string**. Embedding model name                                                                                             |
| `copilot.embedding.dimensions`     | `1536`                     | **integer**. Expected vector dimension (1–16000); also scopes reads/readiness.                                               |
| `copilot.embedding.send_task_type` | `false`                    | **boolean**. Opt into task_type=document for indexing and task_type=query for searches. Startup-bound; does not affect chat. |
| `copilot.embedding.batch_size`     | `20`                       | **integer**. Indexing batch size, clamped to 1–100 texts per call.                                                           |

### OpenAI provider

```yaml
copilot:
  enabled: true
  providers:
    openai:
      enabled: true
      kind: "openai"
      endpoint: "https://api.openai.com/v1"
      # Inject MYOXUS__COPILOT__PROVIDERS__OPENAI__API_KEY.
      models: ["gpt-4.1", "gpt-4o-mini", "gpt-4.1-mini"]
      timeout_ms: 30000
  embedding:
    endpoint: "https://api.openai.com/v1"
    # Inject MYOXUS__COPILOT__EMBEDDING__API_KEY separately.
    model: "text-embedding-3-small"
    dimensions: 1536
```

### Local (ollama) provider

```yaml
copilot:
  providers:
    local:
      enabled: true
      kind: "local"
      endpoint: "http://localhost:11434/v1"
      api_key: null
      models: ["llama3.1"]
      timeout_ms: 30000
```

---

## `calendar.*`

Calendar integration configuration. All calendar features are disabled by default.

### Google calendar webhooks (`calendar.google_webhook.*`)

| Field                             | Default | Type and description                                                                                                                                                    |
| --------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar.google_webhook.enabled` | `false` | **bool**. Enable Google Calendar push notification webhook processing. Requires a publicly reachable webhook endpoint.                                                  |
| `calendar.google_webhook.token`   | `null`  | **string \| null**. Shared secret token for verifying Google Calendar webhook requests. Set to a random value; Google includes this in webhook payloads for validation. |

### Google calendar connection (`calendar.google`)

Set this to enable Google Calendar read/write integration:

```yaml
calendar:
  google:
    client_id: "your-google-client-id"
    # Inject MYOXUS__CALENDAR__GOOGLE__CLIENT_SECRET.
```

When `calendar.google` is `null` (the default), Google Calendar integration is disabled.

### CalDAV connection (`calendar.caldav`)

Set this to enable CalDAV calendar integration:

```yaml
calendar:
  caldav:
    server_url: "https://dav.example.com"
    # Optional: username/password for server-level auth (per-user auth is configured by users)
```

When `calendar.caldav` is `null` (the default), CalDAV integration is disabled.

---

## `client.*`

Client version control settings.

| Field                                     | Default      | Type and description                                                                                                                                                                                         |
| ----------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client.version_control.enabled`          | `true`       | **bool**. Enable client version checks. When enabled, requests from clients below the required version are rejected with an upgrade prompt.                                                                  |
| `client.version_control.required_version` | `">=0.41.5"` | **string**. Minimum acceptable client version (semver range). The default is the first release whose native and server CRDT runtimes both use yrs 0.27. Clients below this version receive an upgrade error. |

---

## `i18n.*`

Internationalization settings.

The main client UI languages are **English (`en`), German (`de`), French (`fr`)
and Spanish (`es`)**. These are the required translation targets. Other
languages, including regional variants, have optional coverage. The available
locale list controls which choices clients can offer; it is not a requirement
that every listed language has every translation. Existing installations keep
their configured languages.

Missing optional translations use the client's established language fallback,
ultimately English. Mixed-language copy in an optional locale can therefore
reflect incomplete translation coverage rather than a configuration failure.
Blank labels are defects even in optional locales; they are not the expected
language fallback.
Missing translations in EN/DE/FR/ES are defects. For reports, include the client
bundle revision, selected locale, affected screen and visible text; do not fill
resource files with English to hide missing translations.

| Field                    | Default                                                              | Type and description                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `i18n.default_locale`    | `"en"`                                                               | **string**. Default locale for the server and email templates.                                                                                                      |
| `i18n.default_currency`  | `"EUR"`                                                              | **string**. Default ISO-4217 currency for new Database Currency fields and Project cost templates. Runtime override: Admin UI -> System -> Localization.            |
| `i18n.available_locales` | `["en", "de", "fr", "it", "es", "pl", "uk", "nl", "pt-BR", "el-GR"]` | **list**. Locales available to clients. Availability does not guarantee complete translations; EN/DE/FR/ES are the required translation targets. Configure in YAML. |

---

## `websocket.*`

Socket.IO / WebSocket transport configuration. These settings control real-time collaboration transport behaviour.

| Field                                             | Default                    | Type and description                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `websocket.transports`                            | `["websocket", "polling"]` | **list**. Allowed Socket.IO transports. `websocket` is the primary transport; `polling` is the fallback where WebSocket is blocked. Remove `polling` only after verifying every supported client and ingress path with WebSocket-only transport. Configure in YAML.                           |
| `websocket.max_http_buffer_size_mb`               | `100`                      | **integer**. Maximum HTTP buffer size in MB for Socket.IO long-polling requests.                                                                                                                                                                                                              |
| `websocket.broadcast_channel_capacity`            | `4096`                     | **integer**. Internal Tokio broadcast channel capacity. Controls how many messages can be buffered per workspace channel before slow subscribers are dropped. Increase for workspaces with many concurrent editors.                                                                           |
| `websocket.ping_interval_seconds`                 | `60`                       | **integer**. Interval for WebSocket analytics aggregation ticks. It does not control Engine.IO keepalives.                                                                                                                                                                                    |
| `websocket.max_connections_per_second_per_client` | `10`                       | **integer**. Maximum new namespace connections per second for both a stable client and its authenticated account (`1..100`). The same canonical path is used by Admin and the live configuration snapshot. Redis admission fails closed for new connections; existing sockets are unaffected. |
| `websocket.eio_ping_interval_seconds`             | `60`                       | **integer**. Engine.IO interval between server ping frames.                                                                                                                                                                                                                                   |
| `websocket.eio_ping_timeout_seconds`              | `120`                      | **integer**. Time the Engine.IO server waits for a pong before disconnecting the socket.                                                                                                                                                                                                      |

---

Engine.IO intervals/timeouts are positive integral seconds, writable through
YAML, `MYOXUS__*` ENV and the existing Admin/CLI configuration operations.
Their sum in milliseconds must fit the client timer limit (`2147483647` ms).
Defaults remain 60 s / 120 s. Admin **Performance → WebSockets** shows saved
values separately from the engine values active on that API process. Restart
**every API replica** to activate saved values; removing both DB overrides
restores the remaining YAML/ENV baseline on the next startup. This does not
change live transports or hot-reload an engine. The analytics interval is a
separate startup-bound metric flush cadence, not a protocol ping interval.

The shipped frontend consumes these **deployment** ENV variables:

| Variable                                      | Default | Activation                  |
| --------------------------------------------- | ------- | --------------------------- |
| `MYOXUS_SOCKET_IO_PROXY_READ_TIMEOUT_SECONDS` | `300` s | Frontend restart/recreation |
| `MYOXUS_SOCKET_IO_PROXY_SEND_TIMEOUT_SECONDS` | `300` s | Frontend restart/recreation |

Inputs must be positive decimal integer seconds; empty, malformed, zero and
Nginx millisecond overflow values fail frontend startup. Canonical and basepath
Socket.IO routes use the same rendered inputs. These are not API DB settings:
changing a saved heartbeat does not change Nginx. Read/send timeouts at **every
hop** must be strictly greater than interval plus timeout (180 s at defaults).
Recalculate and deploy the proxy budget before increasing the heartbeat. See
[reverse-proxy configuration](../deployment/reverse-proxy.md).

## `mcp.*`

Model Context Protocol server configuration.

| Field         | Default | Type and description                                                                                                                                                                                                                                                            |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp.enabled` | `true`  | **bool**. Enable the MCP server at `/mcp`. When enabled, AI tools (Claude Desktop, Cursor, etc.) can connect to Myoxus as a context provider. Disable if you do not use MCP integrations. See [mcp/README.md](../integrations/mcp/README.md) for client configuration examples. |

---

## `captcha.*`

CAPTCHA verification for sign-up, sign-in and password-reset endpoints.
Backend: **[ALTCHA](https://altcha.org)** proof-of-work, verified locally
without a required third-party verification call or third-party cookie.

### HMAC key bootstrap

When `captcha.enabled = true` and `captcha.hmac_key` is empty, the server
generates a fresh 32-byte key (OS CSPRNG) at startup and persists it to
`server/config/local.yaml` under `captcha.hmac_key`. A startup warning is
emitted so the event is visible in logs. Set the key explicitly for:

- **Production deployments** — auto-generated keys depend on a writable config
  dir; in read-only containers (Docker prebuilt images) the key lives only in
  memory and changes on every restart, invalidating outstanding challenges.
- **Multi-replica deployments** — every replica would generate a different key;
  challenges issued by one replica cannot be verified by another.
- **Predictable rotations** — explicit env-var management gives you an audit
  trail and controlled rotation windows.

Generate a key explicitly through `myoxus-cli captcha generate-key` and have
the deployment secret manager inject `MYOXUS__CAPTCHA__HMAC_KEY`. Never type
the value into an interactive shell or commit it to YAML.

Rotating the key invalidates all pending challenges (expected behaviour).

| Field                                     | Default   | Type and description                                                                                                                                                                                                                |
| ----------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captcha.enabled`                         | `false`   | **bool**. Master switch. When false, `/api/auth/challenge` returns 503 and the verify middleware is a no-op.                                                                                                                        |
| `captcha.algorithm`                       | `SHA-256` | **string**. PoW algorithm. One of `SHA-256`, `SHA-384`, `SHA-512` (altcha-lib-rs v0.3.x). Argon2id/Scrypt are JS/Go-only.                                                                                                           |
| `captcha.hmac_key`                        | `""`      | **string**. HMAC signing key for challenge payloads. **Sensitive — never log, never expose in GUI.** When empty with `enabled=true`, server auto-generates + persists to `local.yaml` (see above). Rotate via env + server restart. |
| `captcha.challenge_expires_seconds`       | `1800`    | **u64**. Maximum age (seconds) of a challenge before verify rejects it. Range 60–86 400.                                                                                                                                            |
| `captcha.max_number`                      | `50000`   | **u64**. Solver counter upper bound. Higher values increase proof-of-work cost; measure supported clients. Range 1 000–10 000 000.                                                                                                  |
| `captcha.rate_limit_per_ip_per_min`       | `10`      | **u32**. Per-IP rate limit for captcha attempts. Range 1–10 000.                                                                                                                                                                    |
| `captcha.rate_limit_per_account_per_hour` | `5`       | **u32**. Per-account (email-hash) rate limit for captcha attempts. Range 1–10 000.                                                                                                                                                  |
| `captcha.honeypot_field_name`             | `website` | **string**. Form-field name used as bot-trap. Submissions where this field is non-empty are rejected with audit log.                                                                                                                |

---

## `flags.*`

Feature flag overrides for experimental or environment-specific behaviour.

| Field                              | Default | Type and description                                                                                                                   |
| ---------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `flags.allow_guest_demo_workspace` | `false` | **bool**. Allow unauthenticated users to access a guest demo workspace. Disabled by default. Enable only for public demo environments. |

---

## `metrics.*`

Business-metrics pipeline configuration. The pipeline
feeds Prometheus (via `/metrics/prometheus`) and persists aggregate
counters into Postgres tables `metrics_raw` and `metrics_daily`.
See the [metrics runbook](../observability/metrics.md).

| Field                                  | Default | Type and description                                                                                                                                                                      |
| -------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics.enabled`                      | `true`  | **bool**. Business-hook master switch. `false` makes business-event recording a no-op; operational JSON and Prometheus metrics remain available.                                          |
| `metrics.prometheus_enabled`           | `true`  | **bool**. Expose business series on `/metrics/prometheus`. Decoupled from `enabled` so operators can hide scrape data while keeping the DB pipeline running.                              |
| `metrics.persistence_enabled`          | `true`  | **bool**. Persist recorder snapshots to `metrics_raw`/`metrics_daily`. `false` runs Prometheus-only, registers no metrics schedules, and performs no metrics DB writes. Requires restart. |
| `metrics.flush_interval_seconds`       | `60`    | **integer**. Recorder → DB flush cadence. Lower = fresher rows and more DB writes. Requires restart.                                                                                      |
| `metrics.retention_raw_days`           | `7`     | **integer**. Retention for minute-granularity rows in `metrics_raw`. Requires restart; minimum is 1.                                                                                      |
| `metrics.retention_daily_days`         | `365`   | **integer**. Retention for daily rollups in `metrics_daily`. Requires restart; minimum is 1.                                                                                              |
| `metrics.categories.<name>`            | `true`  | **bool**. Per-category allowlist. Keys must be one of `auth`, `workspace`, `doc`, `collab`, `ai`. Unknown or false values fail closed.                                                    |
| `metrics.label_workspace_id_enabled`   | `false` | **bool**. Attach `workspace_id` label to business series. Off by default — multi-tenant deployments would blow past the cardinality limit.                                                |
| `metrics.cardinality_limit_per_metric` | `10000` | **integer**. Hard cap on distinct label combinations per metric. Excess samples drop and increment `myoxus_metrics_cardinality_drops_total`.                                              |

Admin writes canonical snake_case registry paths. `enabled`,
`prometheus_enabled`, categories, workspace labels, and the cardinality limit
apply live through the shared configuration snapshot. Persistence, flush
cadence, and retention configure startup workers and require a restart. The
Admin schema exposes that lifecycle directly; it does not maintain camelCase
aliases or a second configuration model. Environment overrides use uppercase
snake_case.

---

## `branding.*`

Branding and visual customization settings. These values are served to the frontend to apply custom colors and assets without rebuilding the client.

| Field                            | Default             | Type and description                                                                                                                                               |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `branding.accent_primary`        | `"#1E96EB"`         | **string**. Primary accent color (hex). Used for buttons, links, and highlights.                                                                                   |
| `branding.accent_secondary`      | `"#0A6DCA"`         | **string**. Secondary accent color (hex). Used for hover states and secondary UI elements.                                                                         |
| `branding.accent_primary_dark`   | `""`                | **string**. Dark-mode primary accent. If empty, `accent_primary` is used for both modes.                                                                           |
| `branding.accent_secondary_dark` | `""`                | **string**. Dark-mode secondary accent. If empty, `accent_secondary` is used for both modes.                                                                       |
| `branding.logo_url`              | `"/style/logo.svg"` | **string**. URL for the main logo. Default serves from the style directory.                                                                                        |
| `branding.product_mark_url`      | `""`                | **string**. URL for the product mark (small icon). Empty string means no product mark.                                                                             |
| `branding.style_dir`             | `"./config/style"`  | **string**. Path to branding assets served at `/style/`. Docker sets `/opt/myoxus/runtime-assets/style`; this directory is separate from immutable package config. |
| `branding.max_upload_mb`         | `1`                 | **integer**. Maximum size in MB for branding asset uploads (logo, product mark).                                                                                   |

---

## `http.*`

HTTP client configuration for outbound requests.

| Field                        | Default | Type and description                                                                                                                                                               |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.proxy_timeout_seconds` | `10`    | **integer**. Timeout in seconds for outbound HTTP requests made by the server (e.g. OAuth token exchange, webhook delivery, CalDAV requests). Increase for slow external services. |

---

## `cache.*`

Application-level in-memory cache TTL settings. These caches reduce database
load for frequently read business projections. The removed AppConfig query
cache is not part of this family; canonical configuration uses immediate local
refresh, Redis invalidation and one bounded 30-second recovery poll.

| Field                               | Default       | Type and description                                                                                                                 |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `cache.server_config_ttl_seconds`   | `300` (5 min) | **integer**. TTL for server configuration cache.                                                                                     |
| `cache.user_features_ttl_seconds`   | `120` (2 min) | **integer**. TTL for per-user feature flag cache. Lower values make feature flag changes propagate faster.                           |
| `cache.throttle_config_ttl_seconds` | `30` (30 sec) | **integer**. TTL for throttle configuration cache. Low value ensures rate limit changes take effect quickly.                         |
| `cache.user_features_max_capacity`  | `50000`       | **integer**. Maximum number of user feature flag sets to hold in the in-process LRU cache. Tune based on expected active user count. |

---

## `template_registry.*`

Template registry configuration. The template registry manages built-in and admin-imported workspace templates.

| Field                                                         | Default                                                                      | Type and description                                                                                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `template_registry.enabled`                                   | `true`                                                                       | **bool**. Enable the template registry. When false, the template import/reconcile worker does not run and template-related endpoints return empty results.                                                   |
| `template_registry.import_max_bundle_size_mb`                 | `50`                                                                         | **integer**. Maximum size in MB for a template bundle ZIP file. Uploads exceeding this limit are rejected.                                                                                                   |
| `template_registry.zip_limits.max_entries`                    | `256`                                                                        | **integer**. Maximum number of files allowed inside one template ZIP archive. Prevents ZIP bombs with many small files.                                                                                      |
| `template_registry.zip_limits.max_total_uncompressed_size_mb` | `200`                                                                        | **integer**. Maximum combined uncompressed size of all entries in one ZIP archive.                                                                                                                           |
| `template_registry.zip_limits.max_entry_uncompressed_size_mb` | `50`                                                                         | **integer**. Maximum uncompressed size of a single ZIP entry.                                                                                                                                                |
| `template_registry.zip_limits.max_compression_ratio`          | `200.0`                                                                      | **float**. Maximum allowed uncompressed/compressed ratio for a single entry. Entries exceeding this ratio are rejected as potential ZIP bombs.                                                               |
| `template_registry.zip_limits.max_path_length`                | `512`                                                                        | **integer**. Maximum allowed path length for a ZIP entry. Prevents path traversal attacks.                                                                                                                   |
| `template_registry.reconcile_default_mode`                    | [Managed updates](../integrations/template-registry.md#reconciliation-modes) | **string**. Default reconciliation mode for built-in templates. `managed_until_local_edit` means the template is kept in sync with the registry until a user edits it, at which point it becomes user-owned. |
| `template_registry.drift_scan_enabled`                        | `true`                                                                       | **bool**. Enable periodic drift scanning to detect templates that have diverged from the registry.                                                                                                           |
| `template_registry.drift_scan_interval_seconds`               | `3600` (1 hour)                                                              | **integer**. How often to run the drift scan. Lower values catch drift sooner but add database load.                                                                                                         |

Release source selection and document defaults belong to the mandatory Feature
Bundle manifest and artifact-owned release expectation. They are not Registry
configuration lists. See [bundle delivery](../integrations/document-template-bundles.md).

---

## `telemetry.*`

Privacy-oriented server-side analytics pipeline. All
events are stored in Postgres `telemetry_events` + `telemetry_daily`; there
is no third-party forwarding. See [telemetry operations](../observability/telemetry.md)
and [privacy operations](../security/privacy.md).

| Field                                        | Default    | Type and description                                                                                                                                                                                                                           |
| -------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry.enabled`                          | `true`     | **bool**. Master switch. `false` → `/collect` returns `503`, hot buffer and rollup worker stay idle.                                                                                                                                           |
| `telemetry.allowed_origins`                  | `[]`       | **list**. CORS allow-list for `/api/telemetry/collect`. Empty list falls back to the global `cors.allowed_origins`. Configure in YAML.                                                                                                         |
| `telemetry.dedupe_ttl_hours`                 | `1`        | **integer**. TTL for the Redis `SETNX` key `telemetry:dedupe:<event_id>`. Second-line guarantee: Postgres `UNIQUE (event_id)`.                                                                                                                 |
| `telemetry.dedupe_max_entries`               | `100000`   | **integer**. Cap on the in-memory dedupe LRU before cold-check fallback.                                                                                                                                                                       |
| `telemetry.batch_max_events`                 | `500`      | **integer**. Hot-buffer flush threshold — drained per scheduled tick and per overflow.                                                                                                                                                         |
| `telemetry.flush_interval_seconds`           | `60`       | **integer**. Scheduled flush cadence of the `TelemetryFlushJob`.                                                                                                                                                                               |
| `telemetry.retention_raw_days`               | `14`       | **integer**. Days raw `telemetry_events` rows are kept before the retention job deletes them. Clamped to minimum `1`.                                                                                                                          |
| `telemetry.retention_daily_days`             | `90`       | **integer**. Days `telemetry_daily` aggregates are kept. Aggregates carry no `user_id`; the operator must still approve their retention and data classification.                                                                               |
| `telemetry.categories.<name>`                | all `true` | **bool**. Per-category allowlist. Known categories: `page_view`, `doc_op`, `error`, `auth`, `admin_action`, `ai_interaction`. Unknown → fail-closed (drop).                                                                                    |
| `telemetry.sampling_rates.<name>`            | all `1.0`  | **float**. Per-category sampling in `[0.0, 1.0]`. Silently clamped. `0.0` drops everything, `1.0` keeps everything.                                                                                                                            |
| `telemetry.ingest_rate_limit_per_ip_per_min` | `600`      | **integer**. Server-enforced HTTP requests per IP in fixed UTC minute windows, including authenticated callers and independent of `throttle.enabled`. Minimum 1; excess requests return 429 with `Retry-After`. Restart the API after changes. |

Runtime changes: the ingest policy and IP budget use the API startup snapshot.
Saving `telemetry.*` through Admin or `app_configs` persists the configuration;
restart the API to apply it to collection and scheduled worker jobs.

The removed `telemetry.ga4_measurement_id` and `telemetry.ga4_api_secret` keys
are ignored. Myoxus stores accepted analytics only in the
`telemetry_events` and `telemetry_daily` tables and does not forward them to
GA4. Remove the obsolete keys from local configuration.

---

## `indexer.*`

Full-text and vector search indexer configuration.

| Field                           | Default | Type and description                                                                                                                                                                                           |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `indexer.enabled`               | `false` | **bool**. Enable the external search indexer. When false, search uses the built-in PostgreSQL FTS + pgvector hybrid search. Enable only if using an external search backend (Elasticsearch, OpenSearch, etc.). |
| `indexer.provider_type`         | `null`  | **string \| null**. External indexer provider type (e.g. `elasticsearch`).                                                                                                                                     |
| `indexer.provider_endpoint`     | `null`  | **string \| null**. External indexer endpoint URL.                                                                                                                                                             |
| `indexer.provider_api_key`      | `null`  | **string \| null**. API key for the external indexer.                                                                                                                                                          |
| `indexer.provider_username`     | `null`  | **string \| null**. Username for indexer basic auth.                                                                                                                                                           |
| `indexer.provider_password`     | `null`  | **string \| null**. Password for indexer basic auth.                                                                                                                                                           |
| `indexer.auto_index_batch_size` | `50`    | **integer**. Number of documents to index per auto-index batch.                                                                                                                                                |

---

## `git_sync.*`

Git-Sync settings for bidirectional synchronization between workspaces and Git repositories.

### Core settings (`git_sync.*`)

| Field                                    | Default                                               | Type and description                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git_sync.enabled`                       | `true`                                                | **bool**. Enable the Git-Sync feature. When false, all git-sync endpoints and UI entry points are disabled.                                                                                                                                                                                                                          |
| `git_sync.allowed_directions`            | `["bidirectional", "myoxus_to_git", "git_to_myoxus"]` | **list**. Allowed sync directions. Restrict to `myoxus_to_git` for read-only backups or `git_to_myoxus` for read-from-git workflows. Configure in YAML.                                                                                                                                                                              |
| `git_sync.allowed_auth_methods`          | `["https_token", "ssh_key"]`                          | **list**. Allowed authentication methods for git remotes. Remove `ssh_key` if SSH key management is not desired. Configure in YAML.                                                                                                                                                                                                  |
| `git_sync.allowed_hosts`                 | `[]`                                                  | **list**. Allowlist of git remote hostnames. Empty list means all hosts are allowed. Set to `["github.com", "gitlab.com"]` to restrict to specific hosts. Configure in YAML.                                                                                                                                                         |
| `git_sync.default_branch`                | `"main"`                                              | **string**. Default branch name for new git-sync repositories.                                                                                                                                                                                                                                                                       |
| `git_sync.auto_sync_allowed`             | `true`                                                | **bool**. Allow automatic scheduled sync. When false, sync is manual-only.                                                                                                                                                                                                                                                           |
| `git_sync.webhook_allowed`               | `false`                                               | **bool**. Allow webhook-triggered sync (e.g. GitHub push webhook). Disabled by default for security.                                                                                                                                                                                                                                 |
| `git_sync.ssh_host_key_policy`           | `"accept_new"`                                        | **string**. SSH host-key policy: `accept_new`, `strict`, or `insecure_no_verify`. Runtime-configurable in Admin.                                                                                                                                                                                                                     |
| `git_sync.https_certificate_policy`      | `"strict"`                                            | **string**. HTTPS X509 policy: `strict` or `insecure_no_verify`. Disabling verification requires a non-empty `allowed_hosts` list and only applies to the exact callback hostname in that list.                                                                                                                                      |
| `git_sync.https_ca_bundle_path`          | `null`                                                | **string \| null**. Optional PEM bundle path relative to the active runtime-config directory. The file is canonicalized below that directory and loaded once at startup; changing the path or bundle requires a restart.                                                                                                             |
| `git_sync.network_timeout_secs`          | `120`                                                 | **integer**. Timeout for network git operations (clone, fetch, push). Increase for large repositories or slow connections.                                                                                                                                                                                                           |
| `git_sync.local_timeout_secs`            | `30`                                                  | **integer**. Timeout for local git operations (commit, merge).                                                                                                                                                                                                                                                                       |
| `git_sync.repo_base_dir`                 | `"./storage/git-sync"`                                | **string**. Base directory for local git mirror repositories. In Docker, the compose file sets this to `/opt/myoxus/data/git-sync`.                                                                                                                                                                                                  |
| `git_sync.clone_depth`                   | `1`                                                   | **integer**. Positive shallow clone/fetch depth for network remotes. `1` minimizes storage and clone time; `0` is rejected at startup. Local `file://` remotes are cloned fully because libgit2 cannot shallow-fetch local transport.                                                                                                |
| `git_sync.push_max_retries`              | `1`                                                   | **integer**. Maximum push retry attempts on network failures.                                                                                                                                                                                                                                                                        |
| `git_sync.commit_author_name`            | `"Myoxus Sync"`                                       | **string**. Git commit author name for server-side commits.                                                                                                                                                                                                                                                                          |
| `git_sync.commit_author_email`           | `"sync@myoxus.local"`                                 | **string**. Git commit author email for server-side commits.                                                                                                                                                                                                                                                                         |
| `git_sync.parallel_conversion_threshold` | `10`                                                  | **integer**. Minimum number of documents before parallel conversion is used instead of serial.                                                                                                                                                                                                                                       |
| `git_sync.max_docs_per_sync`             | `0`                                                   | **integer**. Document/Markdown batch size for partial-sync sessions. `0` means unlimited. A positive value does not fail large workspaces; the runner creates/continues `git_sync_partial_sessions` and exposes `partialHasMore`/item counters until all planned items are processed.                                                |
| `git_sync.max_mirror_storage_mb`         | `1024`                                                | **integer**. Maximum total disk space in MB for all git mirror repos. Exceeding this blocks sync before clone/fetch. `0` disables the technical mirror-size guard; a per-profile value overrides the global value.                                                                                                                   |
| `git_sync.min_free_disk_mb`              | `500`                                                 | **integer**. Free-space threshold checked before clone/fetch. `0` disables the preflight guard; it does not replace continuous filesystem monitoring.                                                                                                                                                                                |
| `git_sync.retention_days`                | `7`                                                   | **integer, 1..30**. Terminal SQL history retention window. No unlimited/off value or per-profile override. DB overrides use the existing runtime registry and Admin writeback; removing an override restores the YAML/ENV baseline. Registration alone does not delete rows; the existing nightly Git-Sync maintenance owns cleanup. |

In the maintained container deployment,
`MYOXUS__CONFIG__WRITEBACK_PATH=/opt/myoxus/runtime-config/local.yaml` and the
whole `/opt/myoxus/runtime-config` directory is a writable mount. A bundle
configured as `git-sync/company-ca.pem` therefore belongs at
`/opt/myoxus/runtime-config/git-sync/company-ca.pem` in the API container.
The Admin UI stores only the relative path; it does not upload or rewrite the
PEM file.

### MIME policy

Controls which file types are accepted during Git-Sync operations. Configurable at runtime via Admin GUI (Git Sync > Policy > MIME Policy) without server restart.

| Field                           | Default                                                                                                                                                                   | Type and description                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git_sync.mime_allowlist_admin` | `["image/png", "image/jpeg", "image/webp", "image/svg+xml", "application/pdf", "text/plain", "text/markdown", "application/json", "application/yaml", "application/zip"]` | **list of strings**. MIME types allowed for sync. Only files matching these types are processed; others are handled per `mime_validation_mode`. Configure in YAML.                                                              |
| `git_sync.mime_blocklist_admin` | `[]`                                                                                                                                                                      | **list of strings**. MIME types explicitly blocked. **Blocklist overrides allowlist** — a type present in both lists is rejected. Empty list means no additional blocks beyond the allowlist. Configure in YAML.                |
| `git_sync.mime_validation_mode` | `"warn"`                                                                                                                                                                  | **string**. How MIME violations are handled. `"strict"` rejects the file and fails the sync step. `"warn"` allows the file but emits a warning-level log entry. Select the mode through the operator's approved content policy. |

---

## Canonical registry inventory

The detailed tables above explain the commonly operated scalar settings. The
following exact paths complete that inventory against the server-owned
`CONFIG_REGISTRY`. Structured entries are atomic object or array leaves: an
Admin, REST, or CLI write replaces that registered value and is validated as a
whole. `runtime refresh` means the setting is not marked as a specialized
immediate interaction and does not require process restart; inspect the
effective-config projection after writing it. Sensitive values remain masked in
every external projection.

| Registered path                                          | JSON type | Authoring source | Sensitive | Application     |
| -------------------------------------------------------- | --------- | ---------------- | --------- | --------------- |
| `admin_i18n.default_locale`                              | string    | Admin/REST/CLI   | no        | runtime refresh |
| `auth.allow_signup`                                      | boolean   | Admin/REST/CLI   | no        | runtime refresh |
| `auth.allow_signup_for_oauth`                            | boolean   | Admin/REST/CLI   | no        | runtime refresh |
| `auth.allowed_email_domains`                             | array     | Admin/REST/CLI   | no        | runtime refresh |
| `auth.dns_timeout_seconds`                               | number    | Admin/REST/CLI   | no        | runtime refresh |
| `auth.password_requirements`                             | object    | Admin/REST/CLI   | no        | runtime refresh |
| `auth.require_email_domain_verification`                 | boolean   | Admin/REST/CLI   | no        | runtime refresh |
| `auth.require_email_verification`                        | boolean   | Admin/REST/CLI   | no        | runtime refresh |
| `cache.doc_metadata_fixed_ttl_seconds`                   | number    | Admin/REST/CLI   | no        | immediate       |
| `cache.doc_metadata_projection_fixed_ttl_seconds`        | number    | Admin/REST/CLI   | no        | immediate       |
| `cache.doc_snapshot_fixed_ttl_seconds`                   | number    | Admin/REST/CLI   | no        | immediate       |
| `cache.doc_timestamps_fixed_ttl_seconds`                 | number    | Admin/REST/CLI   | no        | immediate       |
| `cache.server_config_fixed_ttl_seconds`                  | number    | Admin/REST/CLI   | no        | runtime refresh |
| `cache.throttle_config_fixed_ttl_seconds`                | number    | Admin/REST/CLI   | no        | runtime refresh |
| `cache.tuning_daily_enabled`                             | boolean   | Admin/REST/CLI   | no        | runtime refresh |
| `cache.tuning_hourly_enabled`                            | boolean   | Admin/REST/CLI   | no        | runtime refresh |
| `cache.user_features_fixed_ttl_seconds`                  | number    | Admin/REST/CLI   | no        | runtime refresh |
| `cache.ws_settings_fixed_ttl_seconds`                    | number    | Admin/REST/CLI   | no        | runtime refresh |
| `cleanup.history_retention_days`                         | number    | Admin/REST/CLI   | no        | runtime refresh |
| `cleanup.notification_retention_days`                    | number    | Admin/REST/CLI   | no        | runtime refresh |
| `cleanup.outbox_retention_days`                          | number    | Admin/REST/CLI   | no        | runtime refresh |
| `cleanup.pending_blob_retention_hours`                   | number    | Admin/REST/CLI   | no        | runtime refresh |
| `client.clipboard_http_fallback`                         | boolean   | Admin/REST/CLI   | no        | immediate       |
| `client.download_url`                                    | string    | Admin/REST/CLI   | no        | immediate       |
| `copilot.enabled`                                        | boolean   | Admin/REST/CLI   | no        | immediate       |
| `copilot.exa`                                            | object    | Admin/REST/CLI   | yes       | runtime refresh |
| `copilot.unsplash`                                       | object    | Admin/REST/CLI   | yes       | runtime refresh |
| `cors.allowed_custom_headers`                            | array     | Admin/REST/CLI   | no        | restart         |
| `cors.app_origins`                                       | array     | Admin/REST/CLI   | no        | restart         |
| `cors.max_age_seconds`                                   | number    | Admin/REST/CLI   | no        | restart         |
| `document_graph.enqueue_delay_ms`                        | number    | Admin/REST/CLI   | no        | restart         |
| `document_graph.max_catch_up_workspaces`                 | number    | Admin/REST/CLI   | no        | restart         |
| `document_graph.max_graph_edges`                         | number    | Admin/REST/CLI   | no        | restart         |
| `document_graph.max_graph_nodes`                         | number    | Admin/REST/CLI   | no        | restart         |
| `document_graph.max_occurrences_per_edge`                | number    | Admin/REST/CLI   | no        | restart         |
| `document_graph.max_reindex_attempts`                    | number    | Admin/REST/CLI   | no        | restart         |
| `document_graph.max_reindex_batch`                       | number    | Admin/REST/CLI   | no        | restart         |
| `document_graph.preview_max_chars`                       | number    | Admin/REST/CLI   | no        | restart         |
| `document_graph.stale_after_seconds`                     | number    | Admin/REST/CLI   | no        | restart         |
| `document_versioning.default_auto_version_on_pdf_export` | boolean   | Admin/REST/CLI   | no        | immediate       |
| `document_versioning.default_enabled`                    | boolean   | Admin/REST/CLI   | no        | immediate       |
| `document_versioning.default_retention_count`            | number    | Admin/REST/CLI   | no        | immediate       |
| `git_sync.lock_ttl_seconds`                              | number    | file/environment | no        | restart         |
| `job.queues.caldav-sync`                                 | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.calendar-reminder`                           | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.copilot`                                     | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.database`                                    | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.doc`                                         | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.document-graph`                              | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.git-sync`                                    | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.google-calendar-sync`                        | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.indexer`                                     | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.nightly`                                     | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.notification`                                | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.pdf-export`                                  | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.template-registry`                           | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.workspace-automation`                        | object    | Admin/REST/CLI   | no        | restart         |
| `job.queues.workspace-content-operation`                 | object    | Admin/REST/CLI   | no        | restart         |
| `journal.calendar_enabled`                               | boolean   | Admin/REST/CLI   | no        | runtime refresh |
| `journal.first_day_of_week`                              | string    | Admin/REST/CLI   | no        | runtime refresh |
| `journal.show_calendar_weeks`                            | boolean   | Admin/REST/CLI   | no        | runtime refresh |
| `mail.fallback_smtp.host`                                | string    | Admin/REST/CLI   | no        | restart         |
| `mail.fallback_smtp.name`                                | string    | Admin/REST/CLI   | no        | restart         |
| `mail.fallback_smtp.password`                            | string    | Admin/REST/CLI   | yes       | restart         |
| `mail.fallback_smtp.port`                                | number    | Admin/REST/CLI   | no        | restart         |
| `mail.fallback_smtp.sender`                              | string    | Admin/REST/CLI   | no        | restart         |
| `mail.fallback_smtp.transport`                           | string    | Admin/REST/CLI   | no        | restart         |
| `mail.fallback_smtp.username`                            | string    | Admin/REST/CLI   | yes       | restart         |
| `mail.fallback_smtp.verify_certificate`                  | boolean   | Admin/REST/CLI   | no        | restart         |
| `mail.smtp_name`                                         | string    | Admin/REST/CLI   | no        | restart         |
| `metrics.categories`                                     | object    | Admin/REST/CLI   | no        | immediate       |
| `oauth.providers.apple`                                  | object    | Admin/REST/CLI   | yes       | runtime refresh |
| `oauth.providers.github`                                 | object    | Admin/REST/CLI   | yes       | runtime refresh |
| `oauth.providers.google`                                 | object    | Admin/REST/CLI   | yes       | runtime refresh |
| `pdf_export.body_font_scale`                             | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.default_color_profile`                       | string    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.default_image_quality`                       | string    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.default_paper_size`                          | string    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.edgeless_snapshot.max_dim_px`                | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.edgeless_snapshot.max_size_mb`               | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.edgeless_snapshot.max_total_px`              | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.heading_font_scale`                          | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.limits.max_concurrent_per_workspace`         | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.limits.max_input_blocks`                     | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.limits.max_memory_mb`                        | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.limits.max_pages`                            | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.limits.render_timeout_seconds`               | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.max_brand_asset_size_mb`                     | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.max_dpi`                                     | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.max_font_size_mb`                            | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.max_template_size_mb`                        | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.sync_threshold_blocks`                       | number    | Admin/REST/CLI   | no        | runtime refresh |
| `pdf_export.verapdf_timeout_seconds`                     | number    | Admin/REST/CLI   | no        | restart         |
| `pdf_export.verapdf_validator_url`                       | string    | Admin/REST/CLI   | no        | restart         |
| `redis.cache_ttl_doc_metadata_projection_seconds`        | number    | Admin/REST/CLI   | no        | immediate       |
| `redis.cache_ttl_doc_metadata_seconds`                   | number    | Admin/REST/CLI   | no        | immediate       |
| `redis.cache_ttl_doc_snapshot_seconds`                   | number    | Admin/REST/CLI   | no        | immediate       |
| `redis.cache_ttl_doc_timestamps_seconds`                 | number    | Admin/REST/CLI   | no        | immediate       |
| `redis.cache_ttl_document_metadata_index_seconds`        | number    | Admin/REST/CLI   | no        | restart         |
| `redis.compaction_lock_enabled`                          | boolean   | Admin/REST/CLI   | no        | immediate       |
| `redis.compaction_lock_ttl_seconds`                      | number    | Admin/REST/CLI   | no        | immediate       |
| `redis.compaction_threshold_default`                     | number    | Admin/REST/CLI   | no        | immediate       |
| `redis.compaction_threshold_root_doc`                    | number    | Admin/REST/CLI   | no        | immediate       |
| `redis.doc_metadata_cache_enabled`                       | boolean   | Admin/REST/CLI   | no        | immediate       |
| `redis.doc_metadata_projection_cache_enabled`            | boolean   | Admin/REST/CLI   | no        | immediate       |
| `redis.doc_snapshot_cache_enabled`                       | boolean   | Admin/REST/CLI   | no        | immediate       |
| `redis.doc_snapshot_cache_max_size_mb`                   | number    | Admin/REST/CLI   | no        | immediate       |
| `redis.doc_timestamps_cache_enabled`                     | boolean   | Admin/REST/CLI   | no        | immediate       |
| `redis.doc_timestamps_cache_max_docs`                    | number    | Admin/REST/CLI   | no        | immediate       |
| `redis.doc_view_dedup_enabled`                           | boolean   | Admin/REST/CLI   | no        | immediate       |
| `redis.document_metadata_index_cache_enabled`            | boolean   | Admin/REST/CLI   | no        | restart         |
| `redis.document_metadata_index_cache_max_size_mb`        | number    | Admin/REST/CLI   | no        | restart         |
| `server.name`                                            | string    | Admin/REST/CLI   | no        | restart         |
| `telemetry.categories`                                   | object    | Admin/REST/CLI   | no        | runtime refresh |
| `telemetry.sampling_rates`                               | object    | Admin/REST/CLI   | no        | runtime refresh |
| `template_registry.builtin_bridge_enabled`               | boolean   | Admin/REST/CLI   | no        | runtime refresh |
| `worker.polling.document_graph_reindex_interval_ms`      | number    | Admin/REST/CLI   | no        | runtime refresh |
| `worker.polling.workspace_automation_retry_interval_ms`  | number    | Admin/REST/CLI   | no        | runtime refresh |
| `workspace_automation.enabled`                           | boolean   | Admin/REST/CLI   | no        | restart         |
| `workspace_automation.max_actions_per_run`               | number    | Admin/REST/CLI   | no        | restart         |
| `workspace_automation.max_retry_attempts`                | number    | Admin/REST/CLI   | no        | restart         |
| `workspace_automation.max_runs_per_minute`               | number    | Admin/REST/CLI   | no        | restart         |
| `workspace_automation.webhook_timeout_seconds`           | number    | Admin/REST/CLI   | no        | restart         |
| `workspace.import.job_timeout_seconds`                   | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_archive_entries`                   | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_asset_bytes`                       | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_assets`                            | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_blocks`                            | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_cells_per_database`                | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_compression_ratio`                 | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_databases`                         | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_documents`                         | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_entry_bytes`                       | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_expanded_bytes`                    | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_rows_per_database`                 | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_sqlite_bytes`                      | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.max_upload_bytes`                      | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.staging_retention_hours`               | number    | Admin/REST/CLI   | no        | immediate       |
| `workspace.import.worker_concurrency`                    | number    | Admin/REST/CLI   | no        | restart         |

---

## Complete minimal production config

This is a minimum non-sensitive native-host `config/local.yaml` for production
with local storage. Supply `database.url` and `crypto.private_key` through the
protected files in the systemd guide. Inject SMTP credentials through the
service manager only when authenticated SMTP is used. Container deployments
keep database and crypto secrets in their allowlisted files and put only
non-sensitive overrides in the runtime overlay.

```yaml
server:
  origin: "https://myoxus.example.com" # REQUIRED — must match public URL

redis:
  url: "redis://localhost:6379" # REQUIRED

storage:
  backend: "local"
  root: "/opt/myoxus/storage"
  min_free_space_mb: 500 # Example startup threshold; monitor continuously too

throttle:
  enabled: true # Example public-instance policy; tune limits for expected traffic

logging:
  level: "info"
  file_path: "/opt/myoxus/logs/myoxus.log"
  rotation: "daily"
  max_files: 14

mail:
  sender: "Myoxus <noreply@example.com>"
  smtp_host: "smtp.example.com"
  smtp_port: 587
  smtp_transport: starttls
  smtp_verify_certificate: true
  enable_notification_emails: true
```

### Security checklist before going live

- [ ] `server.origin` is the exact public URL (including scheme, no trailing slash)
- [ ] `crypto.private_key` is unique and not the default `myoxus-change-me-private-key`
- [ ] `database.url` and `crypto.private_key` come from protected files; any Redis authentication is owned by the selected Redis topology
- [ ] `throttle.enabled: true` for any public-facing deployment
- [ ] Authenticated SMTP keeps `mail.smtp_pass` out of the config file and passes it through `MYOXUS__MAIL__SMTP_PASS`; unauthenticated relays leave both credential fields null
- [ ] `storage.access_key` / `storage.secret_key` are passed via env vars for S3/R2

### Docker compose note

When running with Docker Compose, the entrypoint writes the database URL to
`/run/myoxus/database-url` from the PostgreSQL password secret and non-sensitive
connection fields. The crypto key is read directly from its secret file. Redis
and the public origin remain normal non-secret environment settings. Neither
`database.url` nor `crypto.private_key` belongs in the container runtime overlay.

## `preview.*`

Private Page previews use the same configuration precedence as other server
settings: Admin database override, environment (`MYOXUS__PREVIEW__...`), YAML,
then the packaged default. Removing an Admin override restores the current
file/environment baseline. Render and excerpt limits apply to newly admitted
requests immediately. Cache capacities/expiry and concurrency capacities are
constructed at startup; Admin reports those changes as pending restart.

Successful SVG and PNG responses use `private, no-cache, must-revalidate` with
representation-derived ETags and `Vary: Cookie, Authorization` in addition to
transport/CORS variants. Browsers may retain bodies but must revalidate before
reuse; 304 responses pass the same current authorization, document, theme and
asset checks as 200 responses. Failures and empty responses remain `no-store`.
Mounted cards retain ready images across visibility changes; actual remounts
use the browser HTTP cache without a separate application cache.

The process-wide output cache is shared across authorized accounts. Warm hits
skip source loading, Yjs decoding, font-byte preparation and rendering. Asset
checks include missing or incomplete images so completed uploads invalidate
previous excerpts. The existing cache capacities and TTL bound server reuse;
browser eviction can require another body transfer without another render.
Debug delivery logs distinguish artifact hits/misses, HTTP status and response
body bytes; generation logs report rendering separately.

All fields are available in **Admin > Performance > Page previews**. The form
uses the server schema for bounds, effective provenance and lifecycle, including
pending-restart state.

| Key                                       |     Default | Unit            | Lifecycle | Purpose                                                           |
| ----------------------------------------- | ----------: | --------------- | --------- | ----------------------------------------------------------------- |
| `preview.max_input_bytes`                 |  `16777216` | bytes           | live      | Maximum complete Yjs source accepted before projection.           |
| `preview.max_source_blocks`               |     `10000` | blocks          | live      | Maximum source blocks visited.                                    |
| `preview.max_projected_blocks`            |        `30` | blocks          | live      | Maximum blocks in the visible excerpt.                            |
| `preview.max_text_chars`                  |      `4000` | Unicode scalars | live      | Maximum projected text.                                           |
| `preview.max_depth`                       |        `32` | levels          | live      | Maximum block traversal depth.                                    |
| `preview.max_table_rows`                  |         `4` | rows            | live      | Maximum rows per projected table.                                 |
| `preview.max_table_columns`               |         `4` | columns         | live      | Maximum columns per projected table.                              |
| `preview.max_visuals`                     |         `1` | visuals         | live      | Maximum image/Mermaid visuals.                                    |
| `preview.max_media_bytes`                 |   `4194304` | bytes           | live      | Aggregate referenced-media budget.                                |
| `preview.max_font_bytes`                  |  `33554432` | bytes           | live      | Aggregate prepared-font budget.                                   |
| `preview.max_decoded_image_pixels`        |  `16777216` | pixels          | live      | Maximum decoded image work.                                       |
| `preview.max_svg_input_bytes`             |   `2097152` | bytes           | live      | Maximum source SVG size.                                          |
| `preview.max_mermaid_source_bytes`        |    `262144` | bytes           | live      | Mermaid source budget; also the renderer library ceiling.         |
| `preview.max_mermaid_elements`            |      `1000` | elements        | live      | Mermaid graph complexity budget.                                  |
| `preview.max_outlined_paths`              |    `100000` | paths           | live      | Maximum outlined glyph/shape paths.                               |
| `preview.max_output_svg_bytes`            |   `4194304` | bytes           | live      | Maximum serialized SVG result.                                    |
| `preview.max_png_pixels`                  |    `256000` | pixels          | live      | Maximum optional PNG raster.                                      |
| `preview.max_active_global_renders`       |         `8` | renders         | restart   | Process-wide CPU render permits.                                  |
| `preview.max_active_renders_per_actor`    |         `2` | renders         | restart   | Per-user CPU render permits.                                      |
| `preview.max_in_flight_requests`          |        `32` | requests        | restart   | Total admitted preview requests.                                  |
| `preview.output_cache_max_bytes`          | `134217728` | bytes           | restart   | Byte-weighted encoded-output cache capacity.                      |
| `preview.output_cache_max_entries`        |      `1000` | entries         | restart   | Encoded-output cache entry ceiling.                               |
| `preview.output_cache_ttl_seconds`        |       `300` | seconds         | restart   | Encoded-output cache lifetime.                                    |
| `preview.prepared_font_cache_max_bytes`   |  `67108864` | bytes           | restart   | Byte-weighted prepared-font cache capacity.                       |
| `preview.prepared_font_cache_max_entries` |         `8` | entries         | restart   | Prepared-font cache entry ceiling.                                |
| `preview.prepared_font_cache_ttl_seconds` |      `3600` | seconds         | restart   | Prepared-font cache lifetime.                                     |
| `preview.request_timeout_ms`              |      `5000` | milliseconds    | live      | End-to-end request deadline exposed to clients.                   |
| `preview.render_timeout_ms`               |      `3000` | milliseconds    | live      | CPU-render deadline; work retains permits until it really ends.   |
| `preview.failure_expiry_seconds`          |         `5` | seconds         | restart   | Short failure-cache lifetime.                                     |
| `preview.retry_count`                     |         `1` | retries         | live      | Bounded retry count for a source that changes during preparation. |

Cross-field validation requires projected blocks not to exceed visited blocks,
SVG/media and font/cache byte budgets to nest, per-actor renders not to exceed
global renders, global renders not to exceed admitted requests, and render time
not to exceed the request deadline. Invalid batches are rejected atomically.
