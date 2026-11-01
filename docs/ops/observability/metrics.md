# Operating the business-metrics pipeline

[Documentation](../../README.md) / [Operations](../README.md) / [Observability](./README.md)

Configure collection, scrape business counters, import dashboards and tune
retention. Use this guide to diagnose missing samples, flush failures and
unexpected storage growth.

<details>
<summary>On this page</summary>

- [1. What lands where](#1-what-lands-where)
- [2. Toggles](#2-toggles)
- [3. Prometheus scrape config](#3-prometheus-scrape-config)
- [4. Grafana dashboard](#4-grafana-dashboard)
- [5. Prometheus alerts](#5-prometheus-alerts)
- [6. Verifying the pipeline is healthy](#6-verifying-the-pipeline-is-healthy)
- [7. Troubleshooting](#7-troubleshooting)
- [8. Retention decisions](#8-retention-decisions)
- [9. CLI](#9-cli)
- [10. Privacy](#10-privacy)
- [11. Emergency kill-switch](#11-emergency-kill-switch)

</details>

## 1. What lands where

| Component      | Storage                                          | Retention                                          |
| -------------- | ------------------------------------------------ | -------------------------------------------------- |
| Raw samples    | Postgres `metrics_raw`                           | `metrics.retention_raw_days` (default **7 d**)     |
| Daily rollups  | Postgres `metrics_daily`                         | `metrics.retention_daily_days` (default **365 d**) |
| Recorder state | Process memory, exposed on `/metrics/prometheus` | Reset on process restart                           |
| Scrape series  | Prometheus (external)                            | Prometheus-side retention                          |

Size the metrics database from measurements on the target installation. Row
size, index overhead, active-series cardinality, and flush cadence all affect
storage growth, so the repository does not define a portable bytes-per-day
estimate. Measure `metrics_raw` and `metrics_daily` growth over a representative
window before choosing retention values. Both retention windows have a minimum
of one day; indefinite retention is not a supported configuration value.

---

## 2. Toggles

All settings live under `metrics.*` in the Admin GUI (**System > Metrics**) and
the canonical configuration registry. Admin and CLI writes use the shared
PostgreSQL writer. Live fields apply immediately on the writing instance,
propagate through Redis, and converge through a 30-second recovery poll if an
invalidation is missed. Restart-bound fields are explicitly identified below.

| Key                                    | Default  | Lifecycle | Purpose                                                                                                                                  |
| -------------------------------------- | -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics.enabled`                      | `true`   | Live      | Business-hook master switch. Operational metrics remain available when false.                                                            |
| `metrics.prometheus_enabled`           | `true`   | Live      | Include business series in `/metrics/prometheus`; operational series remain available.                                                   |
| `metrics.persistence_enabled`          | `true`   | Restart   | Persist snapshots and register flush, rollup, and retention schedules. False is Prometheus-only and performs no metrics database writes. |
| `metrics.flush_interval_seconds`       | `60`     | Restart   | Recorder-to-database flush cadence. Lower values increase freshness and write load.                                                      |
| `metrics.retention_raw_days`           | `7`      | Restart   | Retention for minute-granularity rows; minimum 1.                                                                                        |
| `metrics.retention_daily_days`         | `365`    | Restart   | Retention for daily rollups; minimum 1.                                                                                                  |
| `metrics.categories`                   | all true | Live      | Boolean allowlist for `auth`, `workspace`, `doc`, `collab`, `ai`, `pdf_export`, and `mcp`. Unknown categories fail closed.               |
| `metrics.label_workspace_id_enabled`   | `false`  | Live      | Attach the `workspace_id` label. Large deployments should keep this disabled.                                                            |
| `metrics.cardinality_limit_per_metric` | `10000`  | Live      | Cap distinct label combinations per metric; excess samples increment `myoxus_metrics_cardinality_drops_total`.                           |

OIDC sign-in is visible through the existing `auth` metrics. Myoxus does not
emit separate OIDC group/OU metrics: provider groups and OU ids are too
high-cardinality and can be sensitive. For OIDC OU sync diagnostics, use the
Admin Security provider test, the redacted admin audit events and temporary
`auth` debug logging with auto-revert.

---

## 3. Prometheus scrape config

Add the Myoxus API to your Prometheus job list. The scrape endpoint is
the same one the process-level metrics already use — business series are
just appended:

```yaml
scrape_configs:
  - job_name: myoxus
    metrics_path: /metrics/prometheus
    static_configs:
      - targets: ["myoxus-api:3001"]
```

Reload Prometheus (`curl -XPOST http://prometheus:9090/-/reload` or
`SIGHUP`). Then verify series arrive:

```bash
curl -sS http://localhost:3001/metrics/prometheus | grep myoxus_metric_
# → myoxus_metric_auth_user_signin_total  0
# → myoxus_metric_doc_created_total       0
```

---

## 4. Grafana dashboard

The canonical dashboard is `docs/ops/observability/monitoring/grafana/business-metrics-dashboard.json`
(uid `myoxus-business-metrics`).

Import procedure:

1. Grafana → **Dashboards** → **New** → **Import**.
2. Upload the JSON file or paste its content.
3. Select your Prometheus data source when prompted.
4. Save. The dashboard auto-loads with 12 panels (5 business rows +
   signin-failure ratio, captcha, recorder health, persistence).

The dashboard queries `myoxus_metric_{category}_{name}` series via
`sum(rate(…[5m])) * 60` for per-minute rates — no variables need
editing for a default scrape config.

---

## 5. Prometheus alerts

Rules live in `docs/ops/observability/monitoring/prometheus/alerts.yaml` (groups
`myoxus-ops` and `myoxus-business`, three rules). Deploy:

```bash
# Validate before copying
promtool check rules docs/ops/observability/monitoring/prometheus/alerts.yaml

# Copy into your Prometheus rule_files: directory and reload
cp docs/ops/observability/monitoring/prometheus/alerts.yaml /etc/prometheus/rules/myoxus-business.yaml
curl -XPOST http://prometheus:9090/-/reload
```

Rule summary:

| Alert                     | Condition                                                             | For | Severity |
| ------------------------- | --------------------------------------------------------------------- | --- | -------- |
| MyoxusWorkerQueueFailures | A queue's exported permanent-failure count is greater than zero.      | 0 m | critical |
| MetricsCardinalityDrops   | The recorder dropped at least one series in the last five minutes.    | 0 m | warning  |
| MetricsFlushStalled       | The last successful flush is older than twice the configured cadence. | 0 m | critical |

These rules cover product invariants only. Define workload-, sign-in-, and
CAPTCHA-specific thresholds from the deployment's measured baseline and
response policy.

---

## 6. Verifying the pipeline is healthy

```bash
# Prepare one owner-only temporary curl config without exposing credentials in
# process arguments. Remove it when this diagnostic shell exits.
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

# Admin status (auth required)
curl -sS -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "content-type: application/json" \
  --data '{"query":"query { admin { metricsStatus { enabled activeSeries persisted24h dailyRollups7d counters { offeredTotal acceptedTotal cardinalityDropsTotal } } } }"}' | jq

# Force a flush (debug)
curl -sS -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H "content-type: application/json" \
  --data '{"query":"mutation { admin { flushMetrics { buffered inserted } } }"}' | jq
# → {"data":{"admin":{"flushMetrics":{"buffered":17,"inserted":17}}}}

# DB row count (should grow after a flush)
psql -c "SELECT count(*) FROM metrics_raw;"
psql -c "SELECT metric_name, day, sum, count
         FROM metrics_daily ORDER BY day DESC LIMIT 5;"

# Recorder health counters (all-time since last process start)
curl -sS http://localhost:3001/metrics/prometheus | grep myoxus_metrics_
# → myoxus_metrics_offered_total
# → myoxus_metrics_accepted_total
# → myoxus_metrics_rejected_disabled_total
# → myoxus_metrics_cardinality_drops_total
# → myoxus_metrics_last_flush_unix_secs
# → myoxus_metrics_last_flush_count
# → myoxus_metrics_flush_interval_seconds

# Bounded document-load health (Collab category)
curl -sS http://localhost:3001/metrics/prometheus | grep myoxus_metric_collab_doc_sync_load
# Push persistence/replay outcomes (Collab category)
curl -sS http://localhost:3001/metrics/prometheus | grep myoxus_metric_collab_doc_sync_push_total
# New namespace-connection admission decisions (Collab category)
curl -sS http://localhost:3001/metrics/prometheus | grep myoxus_metric_collab_doc_sync_connection_admission_total
```

Document-sync feedback-loop queries:

```promql
# Terminal loads per outcome over five minutes
sum by (outcome) (increase(myoxus_metric_collab_doc_sync_load_total[5m]))

# Push outcomes. Replays/no-ops are expected to be zero at rest and low during
# normal editing; a sustained ratio indicates a client feedback loop.
sum by (outcome) (increase(myoxus_metric_collab_doc_sync_push_total[5m]))

sum(increase(myoxus_metric_collab_doc_sync_push_total{outcome=~"exact_replay|crdt_noop"}[5m]))
/
clamp_min(sum(increase(myoxus_metric_collab_doc_sync_push_total{outcome="persisted"}[5m])), 1)

# Duplicate/admission pressure: normally zero at rest
sum(increase(myoxus_metric_collab_doc_sync_load_total{outcome="busy"}[5m]))

# Distributed connection pressure. At rest this does not move; sustained
# rejected results require correlation with the fixed reason.
sum by (client_kind, outcome, reason) (
  increase(myoxus_metric_collab_doc_sync_connection_admission_total[5m])
)

# Average decoder wait and materialization duration by terminal outcome
sum by (outcome) (increase(myoxus_metric_collab_doc_sync_load_decoder_wait_ms_total[5m]))
/
clamp_min(sum by (outcome) (increase(myoxus_metric_collab_doc_sync_load_total[5m])), 1)

sum by (outcome) (increase(myoxus_metric_collab_doc_sync_load_materialize_ms_total[5m]))
/
clamp_min(sum by (outcome) (increase(myoxus_metric_collab_doc_sync_load_total[5m])), 1)

# Cancellation reasons; disconnect may occur normally, repeated shutdown or
# session_revoked spikes should correspond to an operator/auth action.
sum by (reason) (increase(myoxus_metric_collab_doc_sync_cancel_total{phase="load"}[5m]))
```

At rest, load, push, byte, duration, and cancellation counters do not move.
During a normal edit session, load `success` and push `persisted` dominate;
`busy`, `exact_replay`, and `crdt_noop` remain zero or transient.
Sustained `busy` indicates a client feedback loop or decoder saturation.
Rising input bytes without corresponding successful output and completion
events requires correlation through temporary `websocket=DEBUG`; never add
workspace, document, socket, session, client-instance, or operation IDs as
metric labels.

The Prometheus endpoint exposes the current recorder state, but a successful
flush can remove a completed interval from that in-memory view. For a bounded
idle or restart investigation, call `admin.flushMetrics` immediately before
and after the observation window and compare the persisted `metrics_raw.value`
sums for `doc_sync_load_total` and `doc_sync_push_total`. Compare the global
synthetic-environment `doc_updates` row count over the same timestamps. This is
an operator diagnostic against an isolated Dev/test database, not an
application query and never a reason to copy production identifiers or Yjs
payloads.

---

## 7. Troubleshooting

### Business series don't appear on `/metrics/prometheus`

1. Are both `metrics.enabled=true` and `metrics.prometheus_enabled=true`?
   Check **Admin > System > Metrics** or run `myoxus-cli config show --key metrics`.
2. Is the category enabled in the `metrics.categories` object? Unknown keys
   fail closed.
3. Has a hook fired? Trigger one: e.g. a failed login raises
   `myoxus_metric_auth_user_signin_failed_total`. Check recorder
   counters: `myoxus_metrics_offered_total` should rise.

### Flush lag — `MetricsFlushStalled` firing

1. Compare `last_flush_unix_secs` to `time()` — gap > 2× `flush_interval_seconds`?
2. Check worker logs for the job tag `metrics.flush`:
   `docker compose logs api | grep metrics.flush | tail -40`
3. Likely causes: DB saturation, advisory-lock contention (rollup/retention
   holding `0x7E1E_717E_0001_*`), or the worker crate failed to start.
   A restart of the API container re-schedules all three jobs.

### Cardinality drops (`MetricsCardinalityDrops` firing)

Symptom: `myoxus_metrics_cardinality_drops_total` increases. Means a
caller emitted more distinct label combinations than
`metrics.cardinality_limit_per_metric` allows for that metric.

1. Identify the offending metric via **Admin > Metrics > Top Series**
   (sorted by active-series count).
2. Usually one of:
   - `metrics.label_workspace_id_enabled=true` on a multi-tenant deployment;
     disable it.
   - A new hook pushes a high-cardinality label such as `user_id` or `ip`.
     Business metrics must stay low-cardinality; remove the label at
     the call site.
3. After fixing, the drop counter stops rising; existing series survive
   until their retention expires.

### Disk pressure from `metrics_raw`

- Lower `metrics.retention_raw_days` (minimum 1, enforced by the writer).
- Restart the API after lowering a retention value, then wait for the 00:20 UTC
  retention job. The worker captures its retention values at startup.
- `metrics_daily` is small. Choose a deliberate positive
  `metrics.retention_daily_days` window that matches the monitoring policy.

### Duplicate rollup rows

The `metrics_daily` primary key is `(day, metric_name, labels_hash)` and the
rollup runs `ON CONFLICT DO UPDATE`. A duplicate-key or uniqueness failure
therefore indicates schema damage or a migration mismatch. Stop writes,
capture the database logs and migration ledger, and follow the
[database and migrations runbook](../runbooks/database-and-migrations.md)
before changing data.

---

## 8. Retention decisions

Choose positive raw and daily retention values from measured table growth,
investigation needs, and the operator's approved retention policy. Myoxus does
not define capacity tiers, an SLO, or a production retention target. To use
Prometheus without the PostgreSQL archive, set
`metrics.persistence_enabled=false` and restart the API.

The retention job runs daily at **00:20 UTC**, after the scheduled rollup.

---

## 9. CLI

Operator-facing commands on the `myoxus-cli` binary (same binary as
`server/crates/cli`, available at `/usr/local/bin/myoxus-cli` in
containers):

```bash
myoxus-cli metrics snapshot           # dump last flushed metrics_raw rows
myoxus-cli metrics flush-now          # prints the canonical Admin GraphQL flush mutation for the live API
myoxus-cli metrics stats              # DB table sizes + last rollup timestamp
```

`snapshot` and `stats` connect via the same `DATABASE_URL` the server uses and
work against an offline database. `flush-now` does not perform a DB-only flush,
because the recorder buffer lives inside the API process; it prints the
canonical Admin GraphQL mutation operators should run against the live API.

---

## 10. Privacy

Business metrics are **aggregate counters** — no per-event rows, no
free-form payload, no user identifiers. The recorder strips any
`user_id`, `email`, `ip`, `session_id` label at the call site (enforced
by `inv_met10_labels_contain_no_pii`). `workspace_id` is opt-in via
`metrics.label_workspace_id_enabled` and contains only the internal UUID, never
a workspace name.

Consequences:

- `metrics_raw` and `metrics_daily` have no per-user export path because the
  recorder contract forbids user identifiers.
- Prometheus retains the same aggregate series, but its storage and access
  remain part of the operator's privacy inventory.
- If you enable `metrics.label_workspace_id_enabled`, treat the UUID-only
  label as pseudonymous data and document it in the monitoring inventory.

See `docs/ops/security/privacy.md` for the overall data map.

---

## 11. Emergency kill-switch

If a runaway caller is generating cardinality or a hook is misbehaving:

1. In **Admin > System > Metrics**, switch `enabled` off. Every hook
   becomes a no-op; `/metrics/prometheus` still exposes process-level
   counters.
2. A local operator may use
   `myoxus-cli config set metrics.enabled false`. Do not update `app_configs`
   directly: direct SQL bypasses validation, audit, writeback, and live
   invalidation.
3. To disable one category, update the complete `metrics.categories` object
   through Admin or the CLI; categories are one canonical object leaf, not
   independent database rows.
4. Before disabling persistence, run the authenticated GraphQL command printed
   by `myoxus-cli metrics flush-now` and verify its `inserted` result. The CLI
   command itself only prints the request; it cannot access the in-process
   recorder. A graceful restart flushes only while
   `metrics.persistence_enabled=true`.
5. After root cause: remove the override and re-enable.
