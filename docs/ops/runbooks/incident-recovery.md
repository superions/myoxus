# Incident and recovery runbook

[Documentation](../../README.md) / [Operations](../README.md) / [Operations runbooks](./README.md)

Coordinate recovery from data-service failures, then confirm that the API, workers and clients have returned to normal operation.

<details>
<summary>On this page</summary>

- [Scope](#scope)
- [1. Triage](#1-triage)
- [2. Worker queue backlog](#2-worker-queue-backlog)
- [3. Storage incident (read/write failures)](#3-storage-incident-readwrite-failures)
- [4. Search index incident](#4-search-index-incident)
- [5. Calendar reminder incident](#5-calendar-reminder-incident)
- [6. Database incident](#6-database-incident)
- [7. Post-incident checklist](#7-post-incident-checklist)

</details>

## Scope

This runbook covers the production-relevant components:

- API health and readiness
- Worker queues (all queues)
- Storage (blob upload/download)
- Search index
- Calendar reminders
- Database

For feature-specific runbooks see: [git-sync.md](../integrations/git-sync.md), [calendar-sync.md](../integrations/calendar.md), [search.md](./search.md), [copilot-embeddings.md](../integrations/copilot-embeddings.md), [log-rotation.md](./log-rotation.md), [template-registry.md](../integrations/template-registry.md).

---

## 1. Triage

**Step 1: Check service health**

```bash
# Docker
build/scripts/server/stack-status.sh

# Or directly
curl -sS http://localhost:3001/health
curl -sS http://localhost:3001/ready | jq .
```

The `/ready` response includes a `checks` array identifying which dependency is failing.

**Step 2: Check metrics**

```bash
curl -sS http://localhost:3001/metrics \
  | jq '{request_error_rate, worker_queues}'
curl -sS http://localhost:3001/metrics/prometheus \
  | grep -E '^myoxus_(request|worker_)'
```

Key metrics:

- `myoxus_request_error_rate` is the proportion of requests ending in 4xx or
  5xx responses since process start.
- `myoxus_worker_queue_pending_ready{queue=...}` and
  `myoxus_worker_queue_failed{queue=...}` are Redis queue counts.

The exported queue-lag and dead-letter fields are currently reserved and remain
zero; do not use them as health evidence.

**Step 3: Check logs**

```bash
# Docker
build/scripts/server/stack-logs.sh api

# systemd
journalctl -u myoxus-api -n 200 --no-pager
```

Look for `ERROR` and `WARN` entries. Use the admin UI
(`/adminfrontend/system?tab=logging`) or GraphQL to increase log verbosity for a
specific subsystem without restarting.

---

## 2. Worker queue backlog

**Symptoms:**

- Growing number of `pending` jobs
- Notifications, search updates, or syncs delayed

**Diagnosis:**

Read `worker_queues` from `/metrics` and correlate the affected queue with API
logs. Jobs live in Redis; there is no canonical PostgreSQL `worker_jobs` table.
Use the queue owner's durable run table where one exists, such as
`search_reindex_runs`, Git Sync runs, PDF export jobs, or Workspace Automation
runs. Do not infer payload or retry state from Redis keys manually.

**Recovery:**

1. Identify the affected queue from the metrics snapshot and logs above.
2. Fix the root cause (see feature-specific runbooks for `git-sync`, `caldav-sync`, `indexer`, etc.).
3. If representative load evidence shows worker capacity is the bottleneck,
   change the owning queue's `job.queues.<queue>.concurrency` value through the
   validated configuration contract. For example:
   ```yaml
   # server/config/local.yaml
   job:
     queues:
       notification:
         concurrency: 8
   ```
   Queue topology is materialized at startup, so recreate the API and verify
   readiness, queue counts, error rate, and the affected user journey. Revert
   if failures or resource pressure increase.
4. After the fix, re-enqueue failed jobs if the failure was transient:
   use the owning Admin, GraphQL or CLI operation documented in
   [Worker runtime](../observability/worker-runtime.md). Myoxus intentionally
   has no unrestricted generic queue-enqueue command.

Set ready-backlog and failure thresholds from the operator's observed workload
and response objective; Myoxus does not prescribe a universal threshold. The
generic lag field is not a functional signal in the current release.

---

## 3. Storage incident (read/write failures)

**Symptoms:**

- Blob upload/download returns 5xx
- Server `/ready` shows `storage: fail`
- Logs contain `storage probe failed` or transport errors

**Diagnosis:**

```bash
# Check storage availability from inside the container
docker compose -f build/server/docker-compose.selfhost.yml exec api \
  ls -la /opt/myoxus/data/storage

# Check disk space
docker compose -f build/server/docker-compose.selfhost.yml exec api \
  df -h /opt/myoxus/data/storage
```

For S3/R2:

```bash
# Run in a shell where the approved credential provider has already injected
# short-lived credentials. Do not put keys in command history.
aws s3 ls s3://your-bucket --endpoint-url https://your-endpoint
```

**Recovery:**

1. Verify the storage backend is reachable (filesystem path or S3/R2 endpoint).
2. Fix permissions or credentials.
3. Check disk space — if `storage.min_free_space_mb` is configured and free space is below that threshold, the server refuses start.
4. After storage is restored, restart the API: `build/scripts/server/stack-rebuild-api.sh`
5. Smoke test: upload and download a test file via the API.

---

## 4. Search index incident

**Symptoms:**

- Search returns missing or stale results
- the `indexer` ready backlog is growing
- `search_content` row count diverges from active `docs` count

**Diagnosis:**

```sql
-- Compare counts
SELECT
  (SELECT COUNT(*) FROM docs
    WHERE workspace_id IS NOT NULL AND deleted_at IS NULL) AS active_docs,
  (SELECT COUNT(*) FROM search_content) AS indexed_docs;
```

Check for stuck reindex runs:

```sql
SELECT id, workspace_id, status, started_at, error_message
FROM search_reindex_runs
WHERE status = 'running'
  AND started_at < now() - interval '1 hour';
```

**Recovery:**

1. Check the `indexer` queue and the durable `search_reindex_runs` state (see
   section 2 above).
2. If the index is inconsistent, trigger a full reindex:
   ```graphql
   mutation {
     admin {
       triggerFullReindex
     }
   }
   ```
3. Monitor reindex progress:
   ```sql
   SELECT id, status, processed_count, indexed_count, updated_at, error_message
   FROM search_reindex_runs
   ORDER BY updated_at DESC
   LIMIT 10;
   ```
4. If a reindex run remains active without progress after worker recovery,
   preserve its ID and logs and follow [Search incidents](./search.md). Do not
   mutate its database status directly.

See [search.md](./search.md) for full details.

---

## 5. Calendar reminder incident

**Symptoms:**

- Reminders are delayed or not delivered
- the `calendar-reminder` ready backlog is growing

**Diagnosis:**

```sql
SELECT r.id, r.scheduled_for, r.delivered_at, d.dispatched_at
FROM calendar_reminders r
LEFT JOIN calendar_reminder_dispatch_log d ON d.reminder_id = r.id
WHERE r.scheduled_for <= now()
  AND r.delivered_at IS NULL
ORDER BY r.scheduled_for ASC
LIMIT 50;
```

These are overdue unfinished reminders. A populated `dispatched_at` with
`delivered_at IS NULL` records a pending attempt, including an interrupted worker;
it does not prove successful fanout. Successful recipient rows in
`calendar_reminder_mail_receipts` are retained across recovery.

**Recovery:**

1. Check `calendar-reminder` queue depth (section 2).
2. Correlate the failed reminder job with mail transport logs and validate mail
   configuration through the protected configuration source. Do not assume an
   SMTP cause without that evidence.
3. Distinguish the pending dispatch log, successful recipient mail receipts and
   whole-reminder `delivered_at`. Do not enqueue handcrafted mail/reminder jobs
   or edit dispatch rows or receipts.
4. When replacing the old unguarded claim implementation, coordinate a restart
   of all reminder consumers before reclaiming its retained pending claims.
   After fixing the root cause, the polling loop (every 60 seconds by default)
   picks up overdue reminders. The session guard serializes retries, reclaims
   unfinished fanout and skips completed recipients. Normal/error exits unlock;
   interrupted workers close their owned connection. No SMTP transaction remains
   open. Verify recipient receipts, consistent dispatch/reminder completion and
   the user-visible notification. SMTP acceptance before receipt persistence
   still permits redelivery after a crash.

---

## 6. Database incident

**Symptoms:**

- Server exits at startup with connection errors
- Pool exhaustion causing WebSocket disconnects
- Migration errors preventing startup

**Diagnosis:**

Check active connections:

```sql
SELECT state, wait_event_type, wait_event, COUNT(*)
FROM pg_stat_activity
WHERE datname = 'myoxus'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

Check for pool exhaustion in API logs:

```bash
build/scripts/server/stack-logs.sh api | grep -i "pool\|timed out\|timeout"
```

**Recovery:**

1. If PostgreSQL is unreachable: check `docker compose logs postgres` and verify disk space.
2. If logs and connection telemetry confirm pool exhaustion, sum the effective
   pool bounds of every API instance and other clients. Reduce workload or tune
   query/pool behavior within PostgreSQL's operator-reserved budget; do not
   raise a pool bound as an unmeasured emergency default.
3. If migrations fail, do not edit `_sqlx_migrations` or apply SQL manually.
   Follow the fail-closed ledger diagnosis and recovery procedure in
   [Database and migrations](./database-and-migrations.md#migration-errors).

See [Sync and workers](./sync-and-workers.md#websocket--sync-issues--connection-drops)
for WebSocket correlation details.

---

## 7. Post-incident checklist

After resolving an incident:

1. Add incident notes: root cause, trigger, detection time, resolution steps.
2. Re-run the relevant repository test-matrix suite and the affected synthetic
   user journey to confirm recovery.
3. Adjust alert thresholds if the incident was not caught early enough.
4. Assign a corrective action with an owner and due date when the root cause
   was a configuration gap or missing safeguard.
5. If log verbosity was increased during incident response, reset to production defaults:
   ```graphql
   mutation {
     admin {
       applyLogPreset(preset: "production") {
         group
         level
       }
     }
   }
   ```
