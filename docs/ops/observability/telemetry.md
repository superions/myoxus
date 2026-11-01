# Operating the telemetry pipeline

[Documentation](../../README.md) / [Operations](../README.md) / [Observability](./README.md)

Configure product-event collection, retention and aggregation. This guide
covers telemetry health and recovery alongside the user's privacy choices.

<details>
<summary>On this page</summary>

- [1. What lands where](#1-what-lands-where)
- [2. Toggles](#2-toggles)
- [3. Verifying the pipeline is healthy](#3-verifying-the-pipeline-is-healthy)
- [4. Troubleshooting](#4-troubleshooting)
- [5. Monitoring](#5-monitoring)
- [6. Sampling strategy](#6-sampling-strategy)
- [7. Emergency kill-switch](#7-emergency-kill-switch)

</details>

## 1. What lands where

| Component        | Storage                               | Retention                                               |
| ---------------- | ------------------------------------- | ------------------------------------------------------- |
| Raw events       | Postgres `telemetry_events`           | `telemetry.retention_raw_days` (default **14 d**)       |
| Daily aggregates | Postgres `telemetry_daily`            | `telemetry.retention_daily_days` (default **90 d**)     |
| Dedupe markers   | Redis `telemetry:dedupe:<event_id>`   | `telemetry.dedupe_ttl_hours * 3600 s` (default **1 h**) |
| Live counters    | Process memory, exposed on `/metrics` | Reset on process restart                                |

Measure `telemetry_events` and `telemetry_daily` in the operator's own
workload before choosing a storage budget. Event payload size and index growth
vary with the enabled categories. Lower `retention_raw_days` when raw-event
growth exceeds the operator-defined budget; daily rollups remain available for
their independently configured retention window.

---

## 2. Toggles

Telemetry settings live under `telemetry.*` in the Admin UI and configuration
store. The running ingest service and scheduled jobs use the startup snapshot,
so restart the API after changing these values. Saving an Admin value without
restarting only persists it for the next process start.

| Key                                          | Purpose                                                                                                                                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry.enabled`                          | Global master switch. `false` → `/collect` returns 503.                                                                                                                                                                                      |
| `telemetry.categories.<name>`                | Per-category allowlist. Unknown/false → fail-closed.                                                                                                                                                                                         |
| `telemetry.sampling_rates.<name>`            | `[0.0, 1.0]`. `0.0` ⇒ drop all; `1.0` ⇒ keep all.                                                                                                                                                                                            |
| `telemetry.batch_max_events`                 | Max events drained per flush (default 500).                                                                                                                                                                                                  |
| `telemetry.flush_interval_seconds`           | Scheduled flush cadence (default 60 s).                                                                                                                                                                                                      |
| `telemetry.dedupe_ttl_hours`                 | Redis dedupe window (default 1).                                                                                                                                                                                                             |
| `telemetry.retention_raw_days`               | Retention for raw events (default 14).                                                                                                                                                                                                       |
| `telemetry.retention_daily_days`             | Retention for daily rollups (default 90).                                                                                                                                                                                                    |
| `telemetry.ingest_rate_limit_per_ip_per_min` | Server-enforced HTTP requests per IP in fixed UTC minute windows (default 600; minimum 1), including authenticated callers. Independent of `throttle.enabled`; excess requests return 429 with `Retry-After`. Restart the API after changes. |

The budget counts HTTP requests, so a batch consumes one slot regardless of
its event count. Replicas share counters through the existing Redis throttle
store. Client identification uses the API's existing proxy trust boundary;
telemetry counter keys contain only an IP digest and expire at the minute
boundary (rounded up to seconds). Without a usable IP, callers share an
unknown-client budget; changing User-Agent cannot create another slot.
When the Redis counter or its expiry cannot be established, ingestion returns
503 with `{"error":"telemetry_throttle_unavailable"}` and enqueues no events.
Globally disabled telemetry keeps its existing 503 acknowledgment.

---

## 3. Verifying the pipeline is healthy

```bash
# Policy snapshot the client will see
curl -sS http://localhost:3001/api/telemetry/status | jq

# Send a synthetic event (adjust origin for your deployment)
curl -sS -X POST http://localhost:3001/api/telemetry/collect \
  -H 'content-type: application/json' \
  -d '{"events":[{"eventId":"smoke-'"$(date +%s)"'","schemaVersion":1,
       "eventName":"pageView","category":"page_view","context":{"page":"/probe"}}]}'
# → {"ok": true, "accepted": 1, "dropped": 0}

# Force a flush (normally scheduled every 60 s)
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
curl -sS -X POST http://localhost:3001/graphql \
  --config "$MYOXUS_CURL_AUTH_CONFIG" \
  -H 'content-type: application/json' \
  --data '{"query":"mutation { admin { flushTelemetry { buffered inserted } } }"}' | jq

# Verify DB row
psql -c "SELECT event_name, category, received_at FROM telemetry_events
         ORDER BY received_at DESC LIMIT 5;"

# Prometheus counters (accepted + flushed + rejected[reason])
curl -sS http://localhost:3001/metrics | grep myoxus_telemetry_
```

---

## 4. Troubleshooting

### Events don't reach the DB

1. `curl /api/telemetry/status` — is `enabled:true` and the category
   listed with a non-zero sampling rate?
2. Check logs for `telemetry event accepted` (TRACE) vs
   `hot buffer overflow` (WARN) vs `flush_batch:` (error) messages.
3. `grep myoxus_telemetry /metrics` — `offered_total` rising but
   `accepted_total` stuck ⇒ a rejection reason is in
   `rejected_total{reason="…"}`.
4. Inspect the hot buffer via Admin GraphQL with the authenticated session
   cookie:

   ```bash
   curl -sS -X POST http://localhost:3001/graphql \
     --config "$MYOXUS_CURL_AUTH_CONFIG" \
     -H 'content-type: application/json' \
     --data '{"query":"query { admin { telemetryStatus { enabled hotBufferLen persisted24h dailyRollups7d dedupeHitRate } } }"}' | jq
   ```

   Prepare `MYOXUS_CURL_AUTH_CONFIG` with the owner-only procedure in the
   verification section if this is a fresh diagnostic shell.

### Dedupe too aggressive

Symptom: legitimate events show up as `dropped` on repeat POSTs within the
TTL window. Either raise `telemetry.dedupe_ttl_hours` (rarely needed) or
confirm the client is generating a fresh `eventId` per event — **not** per
session.

### Disk pressure from `telemetry_events`

- Lower `telemetry.retention_raw_days` (minimum **1** — the worker clamps),
  restart the API, and wait for the scheduled 00:15 UTC retention job.
- Do not publish a hand-crafted Redis queue payload. The authenticated Admin
  `flushTelemetry` operation drains only the hot ingest buffer; it does not run
  retention.

### Duplicate rollup rows

The `telemetry_daily` primary key is `(day, category, event_name)` and rollup
uses `ON CONFLICT DO UPDATE`. A duplicate-key or uniqueness failure therefore
indicates schema damage or a migration mismatch. Stop writes, capture the
database logs and migration ledger, and follow the
[database and migrations runbook](../runbooks/database-and-migrations.md)
before changing data.

---

## 5. Monitoring

Prometheus metric reference:

```text
myoxus_frontend_events_total                    # accepted events since startup
myoxus_telemetry_offered_total                  # all events seen by ingest
myoxus_telemetry_rejected_total{reason="disabled|category|sampled|duplicate|invalid"}
myoxus_telemetry_buffer_overflow_total          # hot buffer dropped
myoxus_telemetry_flushed_total                  # rows persisted by worker
myoxus_frontend_event_count{event="..."}        # top-50 by name
myoxus_frontend_page_views_total{page="..."}
myoxus_frontend_doc_operations_total{op="..."}
myoxus_frontend_errors_total{type="..."}
```

Alert on offered events without corresponding flush progress, any buffer
overflow, and raw events older than the configured retention window. Choose
evaluation windows from the configured flush cadence and the operator's alert
policy; Myoxus does not prescribe an SLO or paging threshold.

---

## 6. Sampling strategy

`sampling_rates` applies **per category at ingest**. Lowering a rate saves
both DB writes and Prometheus cardinality; it does not save client→server
bandwidth (the client may also pre-sample using `/status`).

When to sample:

Keep security and error categories at full capture when they are enabled.
Choose lower rates for high-volume usage categories only after measuring the
effect on the operator's dashboards and investigation needs. This is an
operator policy; Myoxus does not define a production sampling target.

Do **not** raise a rate above 1.0; the clamp at `[0.0, 1.0]` silently caps
it and a value above 1.0 is almost always a misconfiguration.

---

## 7. Emergency kill-switch

If a runaway client is flooding `/collect`:

1. Admin GUI → **Telemetry** → set `enabled = false` and save, or run
   `myoxus-cli config set telemetry.enabled false`.
2. Restart the API. Its shutdown handler first drains the in-flight buffer.
3. Verify `/api/telemetry/status` reports `enabled:false` and a synthetic
   `/api/telemetry/collect` request returns `503`.
4. After fixing the root cause, re-enable telemetry, restart again, and repeat
   the status and synthetic-event checks.
