# Document synchronization incidents

[Documentation](../../README.md) / [Operations](../README.md) / [Operations runbooks](./README.md)

Diagnose looping document loads, rising API memory, repeated sync-busy responses
and reconnect failures. Correlate bounded operational signals without recording
document content or credentials.

## Establish the affected release

Record the deployed API and Web artifact versions, the affected time window and
current dependency health. Check that clients use the intended frontend build.
Use [client update control](../administration/client-updates.md) when a coordinated
reload is necessary; preserve unsynchronized work before any cache action.

## Contain and measure

1. Inspect API memory, queue state and Socket-role Redis health.
2. Compare document load/push counters while the affected workspace is idle.
3. Enable the existing WebSocket log group with an automatic reversion window,
   following [Logging](../observability/logging.md).
4. Observe a single affected operation and correlate its terminal outcome.
5. After recovery, confirm load, edit, synchronization, reload and reconnect.

At rest, sustained load/push activity can indicate a client feedback loop.
Container network traffic also includes heartbeats and background services;
correlate it with persisted sync counters before diagnosing a loop. Keep tokens,
cookies, raw Yjs data, document text and SQL parameters out of diagnostic records.

## Correlate one live load

Temporarily enable the existing `websocket` log group at `DEBUG` with an
auto-revert window. Follow one `sync_operation_id` from
`doc_sync.load.started` to exactly one terminal event:

- `doc_sync.load.completed`
- `doc_sync.load.rejected`
- `doc_sync.load.cancelled`

Record only the fixed outcome, `space_type`, `is_root`, input/output bytes,
update count, decoder wait, and materialization duration. Do not retain raw
payloads, state vectors, document content, or session/socket identifiers.

## Metrics checks

Use the Collab series documented in [Business metrics](../observability/metrics.md):

- `doc_sync_load_total` by `outcome`;
- input/output byte totals;
- decoder wait and materialization duration totals;
- `doc_sync_cancel_total` by fixed reason.
- `doc_sync_connection_admission_total` by `client_kind`, `outcome`, and fixed
  `reason`.

Normal idle behavior is no counter movement. Normal editing is dominated by
`success`; sustained `busy` indicates duplicate client work or decoder
saturation. Repeated `failed` with no typed protocol outcome requires server
log correlation. Do not add ID labels to make an incident easier to search.

## Failure interpretation

| Symptom                                            | Likely boundary                                    | Required action                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_STATE_VECTOR`                             | Client transport/state corruption                  | Confirm Base64 and Yjs-v1 generation; no server full-load fallback is allowed.                                              |
| Sustained `SYNC_BUSY`                              | Duplicate per-document client reconcile            | Check client version and reconnect behavior before changing concurrency.                                                    |
| High decoder wait                                  | Shared four-permit decoder saturation              | Compare load and external-write rates; retain the shared bound.                                                             |
| High input with small tail expected                | Snapshot/compaction or client checkpoint issue     | Check compaction health and the client state-vector response; preserve bounded diagnostic logs.                             |
| Cancellation on disconnect/session revoke/shutdown | Expected lifecycle cleanup                         | Confirm the job registry releases and a new authenticated socket starts with fresh state.                                   |
| Rising RSS across three identical quiet samples    | Materialization copy or detached worker regression | Stop the rollout and preserve memory/log evidence for a reproducible issue report.                                          |
| Repeated `rate_limited` connects                   | Client/account reconnect storm                     | Confirm client exponential backoff honors `retryAfterMs`; do not raise the default before identifying the reconnect source. |
| `temporarily_unavailable` on new connects          | Socket-role Redis unavailable                      | Restore Socket-role Redis and verify new connection admission.                                                              |

## Recovery and escalation

Restore failed dependencies before changing capacity. Retain typed protocol
errors, operation correlation, counter deltas and memory measurements. If the
same failure persists, report the deployed versions and bounded reproduction.
Avoid browser-data deletion while edits remain unsynchronized.

Continue with [Sync and workers](./sync-and-workers.md),
[Redis document cache](../observability/redis-document-cache.md) and
[Multi-instance operations](../deployment/multi-instance.md).
