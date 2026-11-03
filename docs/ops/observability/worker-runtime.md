# Worker runtime

[Documentation](../../README.md) / [Operations](../README.md) / [Observability](./README.md)

Background job processing for the Myoxus server. Workers run inside the same API process and process jobs from Redis-backed queues.

---

<details>
<summary>On this page</summary>

- [Overview](#overview)
- [Job queues](#job-queues)
- [Configuration](#configuration)
- [Operational monitoring](#operational-monitoring)
- [Queue-specific notes](#queue-specific-notes)
- [Key invariants](#key-invariants)
- [Related guides](#related-guides)

</details>

## Overview

The worker system decouples slow or high-volume workloads from synchronous request handlers. All workers are co-located in the API process — there is no separate worker container. Redis is the queue backend (BullMQ-compatible protocol).

**Worker jobs are idempotent by design.** A job may be retried up to `attempts`
times (default: 5) with exponential backoff before it remains in the Redis
permanently-failed set. Workspace Automation additionally projects its own
durable dead-letter state; there is no generic cross-queue DLQ record.

---

## Job queues

| Queue                         | Default Concurrency | Purpose                                          |
| ----------------------------- | ------------------- | ------------------------------------------------ |
| `copilot`                     | 2                   | LLM embedding and AI response jobs               |
| `doc`                         | 1                   | Document maintenance (cleanup, orphan detection) |
| `indexer`                     | 3                   | Full-text search indexing (delta + full reindex) |
| `document-graph`              | 1                   | Document graph extraction and reindexing         |
| `notification`                | 4                   | Email and in-app notification dispatch           |
| `nightly`                     | 1                   | Scheduled nightly maintenance tasks              |
| `workspace`                   | 2 (fixed)           | Workspace maintenance                            |
| `workspace-import`            | 1                   | Durable workspace import pipeline                |
| `telemetry-flush`             | 1 (fixed)           | Buffered telemetry persistence                   |
| `metrics-flush`               | 1 (fixed)           | Buffered business-metrics persistence            |
| `calendar-reminder`           | 2                   | CalDAV/Google Calendar reminder dispatch         |
| `git-sync`                    | 1                   | Git repository synchronisation runs              |
| `template-registry`           | 1                   | Template bundle import and drift reconciliation  |
| `caldav-sync`                 | 1                   | CalDAV calendar data pull (read-only)            |
| `google-calendar-sync`        | 1                   | Google Calendar sync via OAuth                   |
| `pdf-export`                  | 1                   | Asynchronous PDF rendering                       |
| `workspace-automation`        | 1                   | Database automation runs and webhooks            |
| `workspace-content-operation` | 1                   | Server-owned workspace content operations        |
| `database`                    | 1                   | Database projections, search and reminder claims |

---

## Configuration

### Queue concurrency

Override concurrency per queue in `server/config/local.yaml`:

```yaml
job:
  queues:
    indexer:
      concurrency: 5 # increase for large workspaces
    notification:
      concurrency: 8 # increase for high-notification deployments
    workspace-automation:
      concurrency: 2 # raise the packaged default of 1 after load testing
    caldav-sync:
      concurrency: 2 # increase for many simultaneous calendar syncs
```

ENV override (single value only): `MYOXUS__JOB__QUEUES__INDEXER__CONCURRENCY=5`

### Retry policy

Global retry defaults (applies to all queues unless overridden):

```yaml
job:
  queue:
    attempts: 5 # max retries before DLQ
    backoff:
      type: "exponential"
      delay: 1000 # initial delay in ms (doubles each retry)
    removeOnComplete: true # remove job record on success
    removeOnFail:
      age: 86400 # keep failed jobs for 24 hours
      count: 500 # keep at most 500 failed jobs
```

### Polling intervals

Background polling intervals for auto-triggered jobs:

```yaml
worker:
  polling:
    doc_maintenance_interval_ms: 120000 # 2 minutes
    indexer_auto_index_interval_ms: 30000 # 30 seconds
    caldav_sync_interval_ms: 900000 # 15 minutes
    google_calendar_sync_interval_ms: 900000 # 15 minutes
  cron_tick_interval_seconds: 30
```

ENV overrides:

```bash
MYOXUS__WORKER__POLLING__CALDAV_SYNC_INTERVAL_MS=300000      # 5 minutes
MYOXUS__WORKER__POLLING__GOOGLE_CALENDAR_SYNC_INTERVAL_MS=300000
MYOXUS__WORKER__POLLING__WORKSPACE_AUTOMATION_RETRY_INTERVAL_MS=30000
```

---

## Operational monitoring

### Check queue depth and status

```bash
curl -sS http://localhost:3001/metrics | jq '.worker_queues'
```

The API reads Redis queue counts and returns `pendingReady` and `failed` for
the same complete queue catalog as the Admin Queue page (all queues listed
above, including idle queues). Startup rejects a registered worker queue
missing from that catalog. Interpret growth
against the deployment's measured arrival rate and completion time; Myoxus
does not define one universal healthy count.
The `deadLetter` and `queueLagSeconds` response fields are reserved and
currently remain zero; do not alert on them.

The Admin Queue job detail also reads the durable PostgreSQL operation for
`workspace-content-operation`. A historical Redis `completed` job can therefore
show a failed product operation explicitly. New terminal product failures enter
the Redis failed set. Use the feature-owned retry/cleanup actions, not a raw
Redis retry, to restart or compensate a terminal workspace operation.

### Check stalled or stuck jobs

The Redis queue runtime heartbeats active jobs and returns failed attempts to
its retry path. Use bounded API logs to correlate a job ID, queue, attempt, and
failure class. Where the owning feature has a durable SQL run table, inspect
that table through its documented Admin/CLI operation. There is no canonical
PostgreSQL `worker_jobs` table to query or repair.

### Monitor dead-letter queue

`failed` in `/metrics` is the Redis permanently-failed set count. Inspect it
through the owning feature's run state and logs. Workspace Automation has a
separate durable dead-letter contract and dedicated Admin/CLI operations;
other queues must not be treated as if they shared that table or schema.

### Re-enqueue failed work

After fixing the root cause, use the queue owner's authenticated operation.
There is no generic `myoxus-cli job enqueue` escape hatch because arbitrary
queue payloads would bypass application validation and authorization.

```graphql
mutation {
  admin {
    triggerWorkspaceReindex(workspaceId: "...")
    triggerFullReindex
  }
}
```

Git Sync is triggered with its profile-aware Web/Admin operation or
`myoxus-cli git-sync trigger <profile-uuid>`; a workspace-only queue payload
is not a valid substitute.

Calendar sync is scheduled by the server polling owner. After credential or
network recovery, wait for the next configured poll and verify the
`caldav-sync` queue and provider logs. Myoxus does not expose a manual calendar
enqueue command.

---

## Queue-specific notes

### `indexer` — full-text search

The indexer runs on a 30-second polling loop by default. A manual full reindex:

```graphql
mutation {
  admin {
    triggerFullReindex
  }
}
```

Monitor progress via `search_reindex_runs` (see [search.md](../runbooks/search.md)).

### `git-sync` — Git repository sync

Git sync runs are created by the profile's trigger mode (Manual, Polling, or Webhook). Each run processes exactly one workspace profile. Stuck runs in `Running` state can be cancelled via GraphQL. See [git-sync.md](../integrations/git-sync.md) for full details.

### `template-registry` — template bundle import and drift

Template registry jobs handle:

- Importing new template bundles (ZIP uploads via Admin → Templates)
- Drift detection and reconciliation (compares live workspace state against registered templates)
- Hourly drift scans (`drift_scan_interval_seconds: 3600`)

See [template-registry.md](../integrations/template-registry.md) for operator procedures.

### `workspace-automation` — database automation runs

Workspace Automation jobs are created by server-side Database events.
The worker evaluates trigger idempotency, executes actions, records audit
events and moves exhausted retries into the visible run dead-letter state.

Job names:

- `workspaceAutomation.evaluateTrigger`
- `workspaceAutomation.executeAction`
- `workspaceAutomation.deliverWebhook`

Operational commands:

```bash
myoxus-cli automation run-status <run-id> --actor-user-id <user-uuid>
# REDIS_URL or MYOXUS__REDIS__URL is supplied by the protected runtime environment.
myoxus-cli automation retry <run-id> --actor-user-id <user-uuid>
myoxus-cli automation disable <automation-id> --actor-user-id <user-uuid>
myoxus-cli automation dead-letter-list --workspace-id <workspace-id> --actor-user-id <user-uuid> --json
```

`retry` restores the old database run state if Redis enqueueing fails. Use the
database detail route Automations panel for user-facing disabled/run evidence,
and use API logs with `workspace_id`, `automation_id`, `run_id`,
`trigger_type`, `action_type`, `idempotency_key`, `attempt_count`,
`dead_letter` and `duration_ms` for operator diagnosis.

### `caldav-sync` / `google-calendar-sync` — calendar pull

Read-only calendar pull with server-wins conflict resolution. Polls at the configured interval. Each user's calendar credentials are stored encrypted per workspace. See [calendar-sync.md](../integrations/calendar.md) for setup.

### `calendar-reminder` — reminder dispatch

Dispatches calendar event reminders to users and checks every minute for due
reminders. A reminder-scoped PostgreSQL session lock serializes attempts.
`calendar_reminder_dispatch_log` records a pending attempt when the reminder's
`delivered_at` is NULL; it is not proof of completed fanout.
`calendar_reminder_mail_receipts` protects successful email recipients during
retry, while `calendar_reminders.delivered_at` protects whole-reminder completion.
Final dispatch-log and reminder timestamps are committed together. SMTP holds
an idle connection, with no SQL transaction. Worker cancellation closes that
connection; normal/error exits explicitly unlock, so retries can reclaim a
pending attempt without clearing successful recipients.

When upgrading from the old unguarded claim implementation, coordinate a restart
of all reminder consumers before reclaiming its retained pending claims. Let the
normal polling/retry path recover them; do not fabricate mail jobs or edit receipts.
SMTP acceptance before receipt persistence can still be redelivered after a crash.

### Personal Database Row reminder admission and notification delivery

Shared SQL admission commits one occurrence, native fired receipt and outbox
intent transactionally. The outbox hands off a stable-ID
`notification.sendDatabaseRowReminder` job; the notification worker then
revalidates the exact reminder revision, trigger, recipient membership and Row
visibility before calling `NotificationService`. Rescheduled, cancelled,
deleted or inaccessible targets are successful stale no-ops. The stable
`database.row.reminder:{reminderId}:{triggerAtUnix}` idempotency key makes a
replayed handoff idempotent without duplicating notifications.

Monitor shared scheduling/outbox blocked state and the existing `notification`
queue depth/completed/failed counters. Logs include bounded identifiers and
`database_reminder_stale_dispatch` reason labels, never Cell content. After a
Redis outage, restore Redis and let committed outbox intents hand off normally.
There are no native due/expired-claim sweeps; notification failures use the
existing queue retry/DLQ policy. Do not update reminder rows manually unless a
verified backup-recovery procedure requires it.

### `notification` — email and in-app notifications

Handles workspace invitation emails, mentions, Database Row reminders and
system alerts. In-app notifications do not require SMTP; optional email uses
the recipient locale and canonical `server.origin` deep link. Failed jobs use
the configured notification queue retry policy.

### `copilot` — embedding pipeline

Generates pgvector embeddings for document content. Requires a configured embedding endpoint (`copilot.embedding.endpoint`). See [copilot-embeddings.md](../integrations/copilot-embeddings.md).

---

## Key invariants

- Jobs must be idempotent — retries must produce the same outcome as the first run.
- Lease-based concurrency ensures no queue exceeds its configured concurrency.
- Define queue backlog and failure alerts from measured workload policy. The
  current generic endpoint exposes ready and permanently failed counts, not a
  functional lag or dead-letter series.
- When a feature component is disabled or not configured, its worker queue processes no jobs and the API surface degrades gracefully without errors for unrelated components.

---

## Related guides

- [Queue and sync recovery](../runbooks/sync-and-workers.md)
- [Metrics](./metrics.md)
- [Integration runbooks](../integrations/README.md)
