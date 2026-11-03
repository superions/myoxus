# Sync and worker troubleshooting

[Documentation](../../README.md) / [Operations](../README.md) / [Operations runbooks](./README.md)

Diagnose collaboration delivery and background jobs using the owning queue, worker and connection state.

## Calendar reminder scheduling cutover

This cutover requires an operator-authorized all-instance stop, not a rolling
upgrade. Stop every old API/worker admission owner before starting the new
binary. Do not flush Redis or remove actual `calendar.processReminder` jobs.
Remove `worker.polling.calendar_reminder_interval_ms` from operator YAML/ENV
before startup; the forward migration removes its persisted database override.

Normal startup migrations transfer existing reminder settings into native
definitions, preserving delivery IDs, `scheduled_for`, `delivered_at`, dispatch
claims and per-recipient mail receipts. Before workers start, startup initializes
the shared timing fingerprints/cursors under a replica lock. Each root commits
independently; an interrupted startup resumes its uninitialized roots.
Only after this SQL transfer does startup remove pending repeat jobs named
`calendar.enqueueReminders` from the Calendar reminder queue and delete its
unprefixed `cron:calendar-reminder:calendar.enqueueReminders` tracking key.
Other jobs and queues remain intact. A cleanup failure fails startup; repair
the reported source/queue problem and restart rather than restoring the scan.

Verify the startup initialization/retirement messages and the native/shared
state before releasing traffic:

```sql
SELECT count(*) AS definitions,
       count(s.id) AS shared_schedules,
       count(*) FILTER (WHERE s.target_json->>'source_fingerprint' IS NULL) AS uninitialized
FROM calendar_reminder_definitions d
LEFT JOIN scheduling_schedules s ON s.id=d.id;
```

`definitions` and `shared_schedules` must match and `uninitialized` must be zero.
Inspect `blocked_reason` on affected schedules rather than interpreting a
blocked rule as an empty recurrence. The existing outbox cadence and shared
`worker.cron_tick_interval_seconds` admission throttle own new timing;
`calendar.processReminder` retains its queue retry/backoff and native fanout
receipts. Successful SMTP acceptance before a recipient receipt is committed
still has the usual at-least-once transport window.

## Database reminder scheduling cutover

Use an operator-authorized all-instance stop: no old API/worker may continue
admitting or editing reminders when the new binary starts. Remove
`worker.polling.database_reminder_interval_ms` and `databases.reminder_batch_size`
from operator YAML/ENV. Migration1091 removes their persisted overrides.

Normal startup migrates each native reminder's trigger/revision into its shared
one-shot with the same ID and owner. Pending `scheduled`/legacy `claimed` rows
remain eligible; native fired/cancelled history and queued notification envelopes
retain their generation/trigger. Old exclusive claim columns and expiry indexes
are removed, not shadowed by another lease system. Migration is atomic; an
interrupted migration retries through the ordinary ledger path.

Before workers start, retire only pending repeat jobs named
`database.fireReminders` on the `database` queue and its unprefixed
`cron:database:database.fireReminders` tracking key. Existing
`notification.sendDatabaseRowReminder` jobs and other Database jobs stay intact.
Cleanup is idempotent; an interruption resumes on restart. Do not flush Redis.

Verify native/shared ownership after startup:

```sql
SELECT r.status, s.lifecycle, count(*)
FROM database_row_reminders r
JOIN scheduling_schedules s ON s.id=r.id
WHERE s.target_json->>'kind'='database_reminder'
GROUP BY r.status,s.lifecycle;
```

Pending sources have active one-shots until admission; fired/cancelled sources
have ended one-shots. Native API `triggerAt`/`scheduleRevision` project shared
`next_due_at`/`generation`, including completion history. A fired receipt means
durable outbox admission, not final recipient delivery. Queue outages retain
the pending outbox; lost enqueue ACKs replay the stable job. Notification
consumption still rechecks generation, target, membership and Task-open state.
Inspect `blocked_reason` for unavailable local managed descriptors; do not
cancel or rewrite their intent as if this were permanent target deletion.

## Git Cron scheduling cutover

Use an operator-authorized all-instance stop; no old API or worker may continue
selecting native Cron cursors. Normal startup migration1092 transfers each
profile's next/pending UTC slots into the shared `GitCron` owner, preserving
profile IDs and both fall-back UTC instants. It also links existing accepted
Cron Runs to shared occurrences and emits handoffs for existing Pending Runs.
Migration and its ledger update commit atomically; interruption retries through
normal startup. No operator import command or Redis scan is needed.

Do **not** remove `git-sync.scheduleTick`, its pending jobs or tracking key in
this cutover: that tick still owns polling, token rotation and Pending-Run
transport recovery. Only its Cron-admission branch is removed. Existing queued
`git-sync.syncRun` identities, attempts and retry policy remain intact.

```sql
SELECT p.id,p.enabled,p.cron_expression,p.cron_timezone,p.cron_misfire_policy,
       s.lifecycle,s.next_due_at,s.pending_due_at,s.next_admission_at,s.blocked_reason
FROM git_sync_profiles p
JOIN scheduling_schedules s ON s.id=p.id
WHERE p.trigger_mode='Cron';
```

Enabled Cron sources have active schedules; disabled sources retain ended timing
state. A pending missed slot may precede the next nominal due time; a busy owner
uses bounded admission backoff without changing that missed UTC instant. Global
Git disablement blocks/retries admission without rewriting cursors. Current
server policy is resolved from the same live configuration used by requests and
workers, not a startup permission snapshot. Profile edits advance the generation
only when timing or native ownership changes; unrelated edits preserve the
current locked cursor. Native Run/profile lifecycle fences stale queue deliveries.

## Git polling scheduling cutover

Use an operator-authorized all-instance stop before migration1093: no old API
may run the former30-second polling selector. Normal startup transfers every
native Polling profile's latest Run activity into one shared interval target.
The anchor is the latest start **or finish** across all sources and statuses,
including manual/failed Runs. A never-run source starts immediately due; disabled
or invalid-disabled sources remain ended. Native `pollingIntervalSecs` stays
the editable setting; shared `interval_seconds` is its locked projection.

```sql
SELECT p.id,p.enabled,p.polling_interval_secs,s.id AS schedule_id,
       s.lifecycle,s.interval_seconds,s.activity_at,s.next_due_at,s.blocked_reason
FROM git_sync_profiles p
JOIN scheduling_schedules s ON s.target_json->>'kind'='git_polling'
  AND s.target_json->>'profile_id'=p.id::text
WHERE p.trigger_mode='Polling';
```

Pending/Running Polling Runs retain native identities and existing jobs. Their
shared receipts/handoffs do not reset queue attempts/backoff. The existing native
Pending-Run dispatcher still recovers deliveries independently of new admission.
Subsequent native Run activity reanchors timing atomically, not by a due sweep.
Busy sources use bounded admission backoff; inspect native Run and rotation state
before treating a delayed poll as a lost timer.

Do not retire `git-sync.scheduleTick` or its Redis records here: credential
rotation and history-capture wake-up still use it until their owning cutover.
No Redis flush, unrelated-key scan or operator migration command is required.
Migration and ledger update are atomic; an interrupted startup retries normally.

## Git rotation and tick retirement

Use an operator-authorized all-instance stop before migration1094. No old API
or worker may admit rotations while the new binary starts. Normal migration
creates credential-identity `GitRotation` one-shots from native expiry,
renew-before configuration, state and UTC-day retry facts; it never copies a
credential payload into scheduling. Existing Rotating attempts retain their
attempt IDs and receive frozen shared receipts and outbox intents, not new
provider requests. Inconsistent native rotating identities fail startup for
operator resolution rather than silently inventing a replacement attempt.

After all three Git timing transfers, startup retires only pending repeat jobs
named `git-sync.scheduleTick` and its unprefixed
`cron:git-sync:git-sync.scheduleTick` tracking key. The bounded cleanup is
idempotent and resumes after interruption. Do not flush Redis or remove actual
`git-sync.syncRun` / `git-sync.tokenRotation` jobs: active leases, attempts and
backoff still belong to those native deliveries. A cleanup failure fails startup.

```sql
SELECT c.id AS credential_id,r.profile_id,r.state,r.enabled,
       s.lifecycle,s.generation,s.next_due_at,s.blocked_reason
FROM git_token_rotation r
JOIN git_sync_profiles p ON p.id=r.profile_id
JOIN git_sync_credentials c ON c.id=p.credential_id
JOIN scheduling_schedules s ON s.id=c.id
WHERE s.target_json->>'kind'='git_rotation';
```

Do not select encrypted credential data for timing diagnosis. A disabled,
Rotating or ManualIntervention source has an ended clock; its native status and
existing queue job explain the next operator/delivery action. A pre-request
Failed source waits until both expiry eligibility and the next UTC day. A busy
or inaccessible credential retains a blocked/backed-off intent until native
eligibility returns. Current steward selection, provider policy and encryption
remain native. Unknown provider outcome is never an automatic retry permission.

The native Pending-Run dispatcher also recovers unassigned HistoryCapture
receipts under current policy. It does not need the retired tick; it drains
durable data-driven intent rather than calculating another clock rule.

## Registered-worker timing cutover

Use an operator-authorized all-instance stop before the registered Cron/interval
cutover. Do not leave old schedulers running. Normal SQL startup applies1095/1096;
then the bounded importer reads only the35registered destinations, including
disabled metrics definitions. It inspects matching pending repeat identities
and exact unprefixed `cron:{queue}:{job_name}` timestamps, never unrelated Redis
keys. No CLI, backup, flush or separate migration container is required.

Initialization holds a PostgreSQL session lock through import and full registration,
before workers/delayed promotion/shared admission begin. Every source's SQL commit
precedes its duplicate/tracking cleanup. An interrupted startup resumes normally;
do not delete retained jobs or manually reset the SQL cursor. Only unstarted
same-slot copies are deduplicated. Active/retrying jobs, native queue IDs, payloads,
attempts and backoff survive. Ordinary delayed/retry work without the matching
repeat identity is untouched. Read/count/byte/time budget failures abort startup
visibly instead of silently truncating the transfer.

```sql
SELECT s.target_json->>'job' AS registered_job,s.lifecycle,s.generation,
       s.next_due_at,s.next_admission_at,s.blocked_reason,
       count(o.id) FILTER(WHERE o.nominal_json->>'kind'='native_repeat') AS imported_native_jobs
FROM scheduling_schedules s
LEFT JOIN scheduling_occurrences o ON o.schedule_id=s.id
WHERE s.target_json->>'kind'='registered_job'
GROUP BY s.id ORDER BY registered_job;
```

There are35closed roots. Disabled metrics persistence has ended definitions,
not missing registration. Existing queued/tracked future slots suppress another
startup slot; their native handlers still apply current startup enablement.
For new work, SQL/outbox accepts one future slot using the stable native job ID.
Native delayed promotion executes it at its UTC due time. Missed unqueued Cron
slots are skipped; fixed intervals calculate from current admission/startup time
rather than replaying backlog. Thus `next_admission_at` can precede the nominal
due instant while SQL is preparing the next delayed delivery.

No legacy public repeat type, registration loop, tracking helper or Redis leader
remains. Keep heartbeat/stall/retry processes running after startup; those are
native delivery mechanisms, not competing recurring timing owners.

## WebSocket / sync issues — connection drops

### Symptom: repeated "ping timeout" or "io client disconnect" in logs, client sync broken

Connection-pool exhaustion is one possible cause, alongside proxy timeouts,
Redis/socket fanout failures, process restarts, and client/network loss. Start
from the correlated API and proxy signals instead of assuming one cause.

**What happens:**

- WebSocket ACK handlers (e.g. `space:load-doc`) wait for a pool connection before responding.
- If the configured pool is exhausted, an ACK handler can wait up to
  `database.acquire_timeout_seconds` for a connection.
- The client receives no ACK within its timeout window, disconnects, and immediately reconnects.
- The reconnect loop drains the pool further, creating a feedback loop.

**Diagnosis:**

Check `pg_stat_activity` to see if connections are saturated:

```sql
SELECT state, wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE datname = 'myoxus'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

Compare the connection count with the effective pool sizes across all API
instances and with PostgreSQL's connection budget. `pg_stat_activity` alone
does not prove that an application pool is exhausted.

Check the API logs for `pool timed out` or `PoolTimedOut`:

```bash
docker compose -f build/server/docker-compose.selfhost.yml logs api | grep -i "pool\|timed out\|timeout"
```

**Fix:**

1. Inspect the effective `database.max_connections` and the number of API
   instances. Size the combined pools below the database's operator-reserved
   connection budget; do not assume that the packaged default is correct for
   every topology.

2. Compare `database.acquire_timeout_seconds` with observed database latency and
   client/proxy timeouts. Change it only with an explicit failure and load test.

3. Correlate slow or blocked PostgreSQL queries with the owning request or
   worker log. Queue state itself lives in Redis; do not look for or create a
   PostgreSQL `worker_jobs` table.

4. If the pool is the measured bottleneck, tune query/index behavior and the
   pool together. Preserve connections for database administration and other
   clients; the sum of all API pools is not the entire PostgreSQL budget.

---

## Redis WebSocket cross-instance issues

**Symptoms:** In one logical deployment with multiple API instances, document
or Database changes made through one instance are not visible to clients on
another instance. Workspace-session or notification-acknowledgement state
differs between instances.

Document and Database realtime use Redis workspace fanout. Native Calendar
mutations use a local fast path plus that Redis fanout, and XWS notification
wakeups cross nodes; their durable rows remain authoritative in PostgreSQL.
Awareness and active Copilot stream state remain process-local and do not have
general cross-node replay. The configuration steps below restore the shipped
fanout paths but do not turn those transient states into durable data.

**Diagnosis:**

1. Check whether the affected API instance passed startup and which
   startup-check snapshot it exposes. By default the `socket` role shares the
   main Redis URL:

   ```bash
   # In the API container
   curl -sS http://localhost:3001/ready | jq '.checks'
   ```

   `/ready` does not re-run the Redis probe on every request. A green response
   after startup therefore does not prove current Pub/Sub connectivity.

2. Verify current Redis connectivity with the platform's credential-safe
   Redis probe and inspect API logs for `redis pubsub` reconnect or publish
   warnings. The broadcast channel format is
   `{namespace}:ws:broadcast:{workspace_id}`:

   ```bash
   redis-cli --host localhost --port 6379 \
     PUBSUB CHANNELS "myoxus:socket:ws:broadcast:*"
   ```

3. Check that every API instance in the logical deployment uses the same Redis
   URL and namespace for the `socket` role. Different values mean no shared
   Pub/Sub.

4. Look for Redis connection errors in the API logs:
   ```bash
   docker compose -f build/server/docker-compose.selfhost.yml logs api | grep -i "redis.*socket\|ws.*failed\|RedisWsAdapter"
   ```

**Resolution:**

1. Ensure `redis.roles.socket.url` points to the same logical Redis service
   for all API instances in the deployment.

2. If the socket-role Redis adapter is absent or its admission operation fails,
   new connections fail closed with `temporarily_unavailable`. Connections
   admitted before a later Redis failure can retain process-local delivery, but
   cross-instance membership/fanout is degraded. Restore Redis rather than
   adding a process-local admission fallback.

3. Workspace session entries are removed on a normal disconnect. A hard
   process crash can leave stale members; correlate them with the process ID
   and current connection metrics instead of treating the Redis Set as a
   canonical user-presence source.

See also:
[Multi-Instance-Cluster](../deployment/multi-instance.md) guide.

---
