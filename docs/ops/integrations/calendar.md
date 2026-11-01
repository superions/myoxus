# Calendar sync (CalDAV) — operations runbook

[Documentation](../../README.md) / [Operations](../README.md) / [Integrations](./README.md)

Calendar sync integrates external CalDAV and Google calendars with Myoxus
workspaces. Provider pull remains authoritative for external events; configured
workspace writeback also delivers native-event changes through the durable
Calendar pending-write queue.

<details>
<summary>On this page</summary>

- [Configuration](#configuration)
- [Verify sync status](#verify-sync-status)
- [Troubleshooting](#troubleshooting)
- [Manual sync trigger](#manual-sync-trigger)
- [Monitoring](#monitoring)

</details>

## Configuration

CalDAV and Google Calendar clients consume the global immutable startup trust
configured by `tls.additional_ca_bundle_path`, including Google token refresh
and webhook-channel renewal. The remote-write adapter uses the same roots.
Public roots, authentication and existing 30-second calendar/15-second refresh
timeouts remain unchanged. No calendar-specific CA setting is needed; restart
every worker/server after replacing the bundle. A DB-only legacy Git CA does
not supply calendar trust. See [configuration](../configuration/README.md).

### CalDAV sync interval

```yaml
worker:
  polling:
    caldav_sync_interval_ms: 900000 # 15 minutes (default)
```

Or via environment:

```bash
MYOXUS__WORKER__POLLING__CALDAV_SYNC_INTERVAL_MS=900000
```

### Job queue

CalDAV sync jobs run on the `caldav-sync` queue:

```yaml
job:
  queues:
    caldav-sync:
      concurrency: 1 # default; increase for high-volume multi-calendar setups
```

### Google calendar webhook (optional)

For push-based sync with Google Calendar:

```yaml
calendar:
  google_webhook:
    enabled: false # default
    token: null # shared verification token
```

## RSVP response pages

The existing signed email links use `/api/calendar/rsvp/{token}`. Valid links
update the participant response and return HTTP 200. Invalid/expired links,
unknown statuses and update failures return HTTP 400; an unavailable calendar
service returns HTTP 500. Tokens and authorization stay in the handler.

Edit `html/rsvp_page.html.tera` under the common `templates.root_dir` and restart
the API to capture changes. One English template owns confirmation and failure
states; it uses the global theme projection and the captured public stylesheet.
Every state is validated at catalog load before readiness. Do not add token
material to template contexts, log signed URLs or expose storage error details.
Existing documents and calendar records are not rewritten when templates move.
See [public publishing](../data/public-publishing.md#editing-html-templates).

## Verify sync status

### Check recent sync runs

```sql
SELECT workspace_id, calendar_provider, last_sync_at, sync_status, error_message
FROM calendar_sync_state
ORDER BY last_sync_at DESC
LIMIT 10;
```

### Check pending sync jobs

The general `/metrics` queue list does not currently expose the CalDAV or
Google Calendar queues. Use `calendar_sync_state` for durable per-workspace
outcomes, confirm the polling schedule was registered at API startup, and
correlate failures with credential-free API logs. Queue jobs live in Redis.

Native writeback recovery is durable in PostgreSQL:

```sql
SELECT id, event_id, operation, retry_count, next_retry_at, last_error
FROM calendar_pending_writes
ORDER BY next_retry_at NULLS FIRST;
```

Create/update rows retain their live `event_id`. A whole-event delete first
stores a credential-free routing snapshot and removes the local event
atomically; its queue row therefore has `event_id IS NULL` until the provider
confirms absence. Do not delete or rewrite these rows manually. The worker
retries with the existing bounded backoff (at most ten attempts). A provider
404/410 completes an idempotent delete, while an ETag conflict remains failed
and never force-deletes newer remote content. Deleting one occurrence is an
EXDATE update of the surviving series and does not create a detached DELETE.

## Troubleshooting

### Sync not running

1. **Check worker logs** for CalDAV polling:

   ```bash
   build/scripts/server/stack-logs.sh api | grep -i "caldav"
   ```

2. **Verify CalDAV credentials are configured**: Calendar sync requires per-user CalDAV credentials stored via the user settings GraphQL API.

3. **Check scheduler and durable outcome**: confirm the API registered the
   calendar polling schedule at startup, then inspect `calendar_sync_state`
   and credential-free provider logs. The general queue projection does not
   expose these provider queues, and Myoxus has no generic queue
   pause/unpause operator contract.

### Auth failures

CalDAV supports two auth modes:

- **Basic Auth**: username + password/app-password
- **Bearer Token**: OAuth token managed externally

Check server logs for `401` or `403` responses from the CalDAV server.

### Event parsing failures

The CalDAV parser handles VEVENT components with timezone normalization to UTC. Known limitations:

- `RRULE` is stored as opaque string (no recurrence expansion in V1)
- `DURATION`-based events are computed from `DTSTART`
- All-day events (`DATE` vs `DATE-TIME`) are flagged via `all_day: true`

Check logs for:

```bash
build/scripts/server/stack-logs.sh api | grep -i "parse_ical"
```

## Manual sync trigger

Myoxus does not expose a manual CalDAV enqueue command. After linking an
account or correcting credentials, wait for the next
`worker.polling.caldav_sync_interval_ms` cycle and verify the durable sync state
and provider logs. Restarting the API only to accelerate a poll is unnecessary
and can disrupt unrelated work.

## Monitoring

Monitor `calendar_sync_state` outcomes and correlate the account ID with
structured API logs. The current Admin/general metrics projections do not
expose CalDAV or Google Calendar queue depth, and the server does not export
dedicated CalDAV duration, processed-event, or error-counter series.

## Calendar mail delivery

Explicit product-authored event saves and native event transactions persist
scheduling intent in the existing outbox. Provider import/synchronization uses
the non-notifying save path. Imported attendee events do not acquire organizer
mail authority; external scheduling requires the calendar-account owner to be
the organizer. Native workspace scheduling uses the workspace owner as organizer.
Active workspace members participate when `all_members` is enabled; explicit
non-organizer participants otherwise receive the invitation.

Invitation/update messages carry iCalendar REQUEST attachments; detached
cancellations carry CANCEL, the same UID and a monotonically increasing
scheduling sequence. Removed attendees receive cancellation; newly added
attendees receive an invitation. Single-occurrence changes retain the master
UID with RECURRENCE-ID. Native occurrence saves commit the master exclusion,
stable override identity and mail intent together. Unchanged repeats enqueue no
mail; delivery supersession compares the same UID, recipient and occurrence,
so changes to different occurrences remain independently deliverable. Guarded whole-event deletion persists mail and existing
provider retry intent before deleting the event. An unchanged authored projection
emits no new mail. Completed receipt identities suppress queue/outbox replays.
The Application Calendar scheduling dispatcher owns current recipient/access and
preference decisions. The Calendar repository serializes each intent with the
existing advisory key as a session lock. Its owned connection remains idle with
no SQL transaction or event row lock during SMTP. Normal, suppressed and failed
dispatch explicitly unlock; cancellation/drop closes the connection, including
cancellation while acquiring the lock. Receipts and recurrence-scoped supersession
are read/written through the same Calendar guard. Storage and SMTP failures remain
retryable; malformed queue input is permanent.
SMTP delivery and SQL completion cannot be atomic: an interrupted successful SMTP
send before its receipt commits can be retried.

Scheduling mail follows `mail.enable_notification_emails` and each current
registered recipient's invitation-email preference. Disabled users, removed
workspace recipients and stale pending requests are suppressed. Unregistered
explicit attendees receive the ICS attachment without an inaccessible workspace
link. HTML/body/subject copy comes from the configured EN/DE/FR/ES/IT mail catalog.

Explicit email reminders remain available independently of the global optional
notification-email switch. Delivery resolves current provider-account recipients
or native workspace recipients, formats recipient-owned date/time/timezone
preferences and supplies the existing Journals route. All-day messages display
the calendar date. A reminder-scoped session lock serializes fanout without an
open SQL transaction during SMTP. Cancellation closes its connection; normal
and failed attempts explicitly unlock. A pending dispatch-log row with
`delivered_at IS NULL` is reclaimed under that lock; successful recipient receipts
are retained, and only unfinished recipients are sent again. Dispatch-log and
whole-reminder completion timestamps are written in one short transaction.
A completed reminder suppresses replay. SMTP acceptance before its recipient
receipt still has a redelivery window after a crash.
Saving an unchanged reminder preserves its identity and delivery status, so
editing a title or reopening and saving a dialog does not resend a completed reminder.

In the native-event dialog, choose a reminder offset and enable **Notify via
Email** to use SMTP delivery. Existing email reminders retain their channel when
the event is edited, including an immediate edit after creation.

Scheduling MIME follows [iTIP (RFC 5546)](https://www.rfc-editor.org/rfc/rfc5546);
escaping, UTC/all-day values and UTF-8 line folding follow
[iCalendar (RFC 5545)](https://www.rfc-editor.org/rfc/rfc5545).
