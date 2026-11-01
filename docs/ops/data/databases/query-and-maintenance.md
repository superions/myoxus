# Database query and maintenance

[Documentation](../../../README.md) / [Operations](../../README.md) / [Data operations](../README.md) / [Database operations](./README.md)

Inspect database records and run bounded maintenance using the server’s permissions, paging and lifecycle rules.

<details>
<summary>On this page</summary>

- [Server-side query, search, and indexing](#server-side-query-search-and-indexing)
- [Bulk operations and transaction safety](#bulk-operations-and-transaction-safety)
- [Projection recompute operations](#projection-recompute-operations)
- [Runtime verification](#runtime-verification)

</details>

## Server-side query, search, and indexing

The view-query contract combines server-owned paging, search, and typed view
state. `databaseRows` and `databaseRowGroups` execute through
the PostgreSQL repository; Web/Core never loads all rows to emulate view state.

### Pagination contract

- Default page size: 100 rows per request. The resolver falls back to the
  `databases.default_rows_per_page` setting when the client omits `first`.
- Hard cap: 500 rows per request. Larger `first` values are clamped server-side
  against `databases.max_rows_per_page` and recorded in the GraphQL response
  shape; no error is raised.
- Cursor: `(position, id)` base64-ish tuple encoded as `"{position}|{rowId}"`.
  The first page uses no cursor; subsequent pages pass the encoded
  `(position, id)` of the last row from the previous page as `after`. The
  cursor selects rows strictly **after** the cursor in the default
  `(position ASC, id ASC)` sort order; using `before` or a manually fabricated
  cursor is unsupported.
- A response past the last row returns `rows: []` and `totalCount` equal to the
  underlying row count. The Web table view treats an empty page after a cursor
  as the end of the result set.

### Filters, sorts, and grouped-view aggregation

- The resolver validates the exhaustive typed operator/value/field matrix, then
  compiles flat or nested AND/OR filters, Table search fields and ordered
  multi-sort into bound SQL through `DatabaseRepositoryQueryPlanner`.
- The first and every subsequent page use the same repository plan. Filtered
  `totalCount` and rows share one predicate and repeatable-read boundary.
- Unknown operators fail GraphQL decoding; incompatible typed operands fail
  Application validation. SQL/repository failures propagate as stable Database
  errors. Neither case triggers an Application row-scan fallback.
- `databaseRowGroups` pushes primary/subgroup counting into repository SQL.
  Application code maps bounded aggregates to stable configured labels/order
  and adds declared empty buckets; it does not group loaded row pages.
- When a `viewId` is supplied, the server resolves the authenticated actor's
  personal search and optional exploratory sort/filter before planning. Actors
  cannot read or mutate another user's state.
- `databaseProgress` compiles that same effective query into one PostgreSQL
  aggregate plan. It returns the total and optional group buckets without
  loading the row page into Application or Web memory; Project blocked and
  overdue metrics join only the server-owned role fields required by the plan.
- The repository emits `database progress aggregate query executed` at debug
  level with Database/view IDs, query-shape counts, grouped/result counts and
  `elapsed_ms`. It deliberately excludes search text, filter values and Cell
  content. Investigate sustained latency together with PostgreSQL plans and
  Database row volume; do not raise Web page size or add a client aggregation
  fallback.

### Row search index and ACL

- The row-search table stores the per-row tsvector built from the
  row title (`setweight('A')`) and the visible cell-value text
  (`setweight('B')`). The search query uses `websearch_to_tsquery` and
  `ts_headline` for snippet rendering. Tags cells are resolved server-side;
  `workspace_tags` stores structured id/name/slug/color-role payloads while
  those values are also included in the full-text input. Document search uses
  the single canonical `search_content` projection.
- Index refresh runs on every cell write through `enqueue_index_row`. The
  debounce is 3 seconds for direct cell edits (covers, dates, numbers, etc.)
  and 0 seconds for create/delete/link/unlink so that newly visible rows show
  up in search immediately.
- Workspace membership is enforced before the FTS query runs; non-members see
  zero hits and the resolver returns an authorization error from the
  workspace gate. There is no public-search flag for row search.
- A manual reindex is exposed through the `database.reindexSearch` background
  job and through the inline `reindex_database_search` repository method.
  Reindexing rebuilds the tsvector and `database_document_references` for every
  row in a single database. Existing Admin workspace/full reindex actions
  enqueue this job for the selected Databases after document-search reindex is
  accepted.

`database_document_references` is derived and rebuildable. It contains no body,
snippet or redacted document title. Row search reports only whether a content
association exists. Document search and Links & References join Database/Row/
field labels only after workspace and document ACL checks. If a queue enqueue
fails during document deletion, the application invokes the same repository
replacement inline so stale target metadata does not survive indefinitely.
Database attachment writes use the internal document UUID, but browser previews
and routes use the actor-safe `externalId` projection. GraphQL Document Graph,
Links & References and graph-index status inputs accept that workspace-local
client key and resolve it only within the requested workspace. A UUID parse
error for an opaque client key indicates an obsolete API binary, not invalid
document data.

### Background jobs

The `database` queue owns the following job names:

| Job name                             | Payload keys                                                                   | Behaviour                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database.recomputeRollups`          | workspace_id, limit, database_limit                                            | Recomputes every stale rollup cell up to `limit` databases per call.                                                                                                                                                                                                                                                             |
| `database.recomputeFormulas`         | workspace_id, limit, database_limit                                            | Same shape as rollups, scoped to formula cells.                                                                                                                                                                                                                                                                                  |
| `database.recomputeStaleProjections` | workspace_id, limit, database_limit                                            | Catch-up job for both rollup and formula projections.                                                                                                                                                                                                                                                                            |
| `database.indexRow`                  | workspace_id, database_id, row_id                                              | Transactionally refreshes Row FTS and typed document references from canonical Row/Cells. Repository storage failures use the queue's bounded retry/backoff policy; invalid payloads and domain failures remain terminal.                                                                                                        |
| `database.reindexSearch`             | workspace_id, database_id                                                      | Rebuilds both derived projections for every Row in one Database. Repository storage failures retry from the beginning; idempotent Row upserts make replay after a partial pass safe.                                                                                                                                             |
| `database.bulkImport`                | import_job_id, workspace_id, actor_id, database_title, content_base64, options | Large CSV import. The job payload carries the `database_import_jobs` id; the worker short-circuits on `succeeded` / `cancelled`, marks `running`, dispatches to `import_csv_with_job`, then writes `succeeded` / `failed` / `cancelled`. See [Background import retry/cancel contract](#background-import-retrycancel-contract). |
| `database.bulkExport`                | import_job_id, workspace_id, actor_id, database_id                             | Large CSV export. Same lifecycle as `database.bulkImport`; the job row records the resulting `bytes` / `file_name` in `result_json`.                                                                                                                                                                                             |
| `database.fireReminders`             | limit                                                                          | Claims at most the configured bounded batch of due personal Row reminders and enqueues validated notification jobs. It uses the existing Database queue concurrency.                                                                                                                                                             |

Reminder dispatch is startup-materialized. Configure
`worker.polling.database_reminder_interval_ms`,
`databases.reminder_batch_size`,
`databases.max_reminders_per_user_per_cell` and
`databases.max_reminder_offset_minutes` through the normal config system or
Admin Performance (`Server tuning` / `Limits`), then restart the API. The
registry rejects values outside the documented bounds before restart. Queue
execution continues to use `job.queues.database.concurrency`; do not create a
Reminder-specific queue or concurrency setting.

All jobs are owned by the `database` queue. Row mutation jobs emit progress
events through the audit + notification surface (`database.row.created` /
`database.row.updated` / `database.row.deleted`) so the Web client can render
row-edit notifications without a separate transport. Internal
`database.bulkImport` / `database.bulkExport` jobs retain native idempotency,
retry and cancellation records. CSV apply and its successful job result commit
atomically; cancellation cannot turn committed success into partial cleanup.
See the [background import contract](#background-import-retrycancel-contract).

### Metrics, tracing and log fields

Database workers use the shared queue metrics endpoint. The `database` and
`workspace-automation` queue labels are exported through both JSON and
Prometheus responses; no legacy queue label is emitted.

| Metric                                                              | Database interpretation                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `myoxus_worker_queue_pending_ready{queue="database"}`               | Waiting or delayed Database jobs.                                                |
| `myoxus_worker_queue_failed{queue="database"}`                      | Permanently failed Database jobs.                                                |
| The same pending/failed metrics with `queue="workspace-automation"` | Automation execution/retry health.                                               |
| `workspace_import_*` families in the workspace-import runbook       | Full legacy workspace import only; these are not Database CSV/JSON job counters. |

There is no separate Database business-counter family. Durable CSV bulk status
comes from `database_import_jobs`; application behavior is inspected through
structured tracing and Database activity/audit records rather than inferred
from an absent counter.

| Rust tracing target                                                  | Stable non-content fields                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `myoxus_application::database` and submodules                        | `actor_id`, `workspace_id`, `database_id`, optional Row/Field/View ids, kind, counts, revision/result flags and elapsed operation context. |
| Database repository spans in `myoxus_infrastructure`                 | workspace/Database/Row ids, limits, page offsets and repository operation context.                                                         |
| `myoxus_api::graphql::auth::database`                                | bounded resolver/import failures; upload bytes may be logged as counts, never payload.                                                     |
| `myoxus_api::websocket::handlers::database` and `database_broadcast` | workspace/Database connection identity and fanout errors.                                                                                  |
| `myoxus_application::workspace_automation`                           | workspace/Database/Row ids and trigger/run state.                                                                                          |

Search text, filter values, Cell/Row content, document titles, source filenames,
blob URLs, credentials and upload bytes are forbidden log fields. Operators
should correlate by stable ids and activity/audit event keys. Normal mutation
spans log structural booleans and counts such as `renamed`,
`description_changed`, `initial_field_count`, `requested`, `succeeded` and
`failed`; errors include the stable error code at the API boundary.

### Slow-query identification

Query tracing records Database/view IDs, operator/group counts, requested page
size, elapsed time and result count. It deliberately omits search text, filter
values, row content and user display values. Slow queries are most often typed
predicates over the cell-values table. Inspect `pg_stat_statements` for:

```sql
SELECT query, calls, mean_exec_time, rows
  FROM pg_stat_statements
 WHERE query ILIKE '%cell_values%'
   AND query ILIKE '%value_json%'
 ORDER BY mean_exec_time DESC
 LIMIT 25;
```

For the row-page query itself, the same view filtered by the
`%<row_table>%` substring and ordered by `mean_exec_time` highlights
database-wide scans that do not hit the `(database_id, position)` index.

Inspect personal-state presence without printing private search/filter values:

```sql
SELECT view_id,
       user_id,
       search_text <> '' AS has_search,
       sort_json IS NOT NULL AS has_sort,
       filter_tree_json IS NOT NULL AS has_filter,
       jsonb_object_length(field_width_overrides_json) AS width_overrides,
       jsonb_array_length(collapsed_group_keys_json) AS collapsed_groups,
       edit_revision,
       updated_at
  FROM database_view_user_states
 WHERE view_id = '<view-uuid>'
 ORDER BY updated_at DESC;
```

Do not emit the JSON operands or `search_text` in support logs. Reset state via
`resetDatabaseViewUserState`; direct SQL deletion is reserved for operator
recovery after the actor/view identity has been verified.

### Indexes

The migrations ship with the following database-side indexes for row and
search performance:

- `database_rows` (storage: `<physical row table>`): `(database_id, position, id)`,
  `(database_id, row_kind, position, id)`, `(database_id, updated_at DESC)`,
  and `(doc_id)`.
- `database_cell_values` (storage: `<physical cell-value table>`): composite
  primary key `(row_id, field_id)`, `(database_id, field_id, row_id)`,
  `(row_id, database_id)`, and `(field_id)`.
- `database_row_search` (storage: `<physical row-search table>`): primary key
  `(row_id)`, `(workspace_id, database_id, updated_at DESC)`, and a GIN index on
  `tsv` for `@@` lookups.
- `database_fields` (storage: `<physical field table>`): `(database_id, position, id)`.
- `database_views` (storage: `<physical view table>`): `(database_id, position, id)`.
- `database_activity_events`: `(workspace_id, created_at)`,
  `(database_id, created_at)`, `(row_id, created_at)`, and `(actor)`.

The query planner relies on the existing `(row_id, field_id)` and
`(database_id, field_id, row_id)` cell-value indexes; the
`(database_id, position, id)` row index powers the cursor predicate. Operators
that would benefit from an additional JSONB GIN index still execute as bound
PostgreSQL predicates; they do not fall back to Application evaluation.

## Bulk operations and transaction safety

Bulk row operations are an explicit, atomic, batched API surface. Every bulk
mutation returns a `DatabaseBulkOperationResult` carrying per-row diagnostics
so the client can render a structured toast (e.g. "3 of 12 updated, 9
failed: cell invalid") without re-deriving counts.

### Supported operations

- `bulkSetDatabaseCellValue` — set the same cell value on many rows in one
  transaction.
- `bulkClearDatabaseCellValue` — clear a single cell on many rows in one
  transaction.
- `bulkApplyDatabaseCellPatches` — apply many cell writes, possibly across
  many rows and many fields, in one transaction.
- `bulkDeleteDatabaseRows` — soft-delete many rows in one transaction. A
  re-delete of an already-deleted row is idempotent (no error).
- `bulkRestoreDatabaseRows` — restore previously soft-deleted rows in one
  transaction.
- `bulkUpdateDatabaseRowPositions` — rewrite `position` for many rows in
  one transaction. Used by Kanban DnD and List manual reorder.

### Atomicity contract

Every bulk operation runs inside a single PostgreSQL transaction with
`FOR UPDATE` row locks. The contract is all-or-nothing per call:

- A per-row validation failure detected before the transaction rolls back
  the entire batch. Clients must therefore be prepared to re-render the
  selection unchanged when `transactionCommitted: false` is implied by an
  empty diagnostic stream.
- A storage failure mid-batch rolls back the entire batch.
- A partial commit is **never** produced. The
  `transaction_committed` field on the result object reflects this.

### Limits

- `DATABASE_BULK_MAX_ROWS_PER_OPERATION` (500 by default) — the maximum
  number of rows a single bulk operation may target. Requests above this
  cap are rejected with `MIX_DATABASE_LIMIT_EXCEEDED` before any SQL is
  issued.
- `DATABASE_BULK_MAX_FIELD_UPDATES_PER_OPERATION` (5,000 by default) — the
  maximum total `(row, field)` writes in a single multi-field bulk patch.
- Both limits are hardcoded constants in the domain layer so the service
  contract is stable regardless of operator tuning.

### Per-row diagnostics

The result carries two lists that together cover every requested row
exactly once:

- `succeeded` — list of row ids the operation committed.
- `failed` — list of `DatabaseBulkRowOutcome` records, each carrying a
  structured `errorCode` (a `MIX_DATABASE_*` short string) and a
  human-readable `errorMessage`.

Clients should never have to re-derive counts: `total`, `successCount` and
`failureCount` are surfaced directly.

### Activity, audit, and search reindex

Every successful bulk operation writes:

- one summary `database_activity_events` entry (`bulk.rows_updated`,
  `bulk.rows_deleted`, `bulk.rows_restored`, `bulk.row_positions_changed`)
  carrying the requested/succeeded/failed counts in its payload JSONB;
- one `audit_log` entry under the `database` category.

Per-row noise is deliberately avoided — the activity timeline stays
readable when a member edits hundreds of rows in a single action.

Bulk cell writes and bulk delete/restore also schedule a
`database.indexRow` / `database.reindexSearch` background job so the FTS
hit list stays in sync with the canonical store.

### Background import retry/cancel contract

Background `database.bulkImport` and `database.bulkExport` jobs go through a
durable record in the `database_import_jobs` table. The Redis worker is a
thin envelope around `DatabaseImportExportService::run_bulk_import_job` /
`run_bulk_export_job`; the durable record is the source of truth for
idempotency, retry and cancellation. These are internal Application/worker
capabilities; the current GraphQL, CLI and MCP file operations execute immediate
preview/apply/export. Native import enqueue supplies actor, title, CSV bytes and
typed options; export enqueue supplies the actor and native Database identity.
An explicit producer retry republishes a still-queued job with the same native
job ID after an uncertain Redis handoff. Running/succeeded jobs return their
retained record; duplicate deliveries arbitrate against that same native ID.
The producer does not create a replacement job merely because enqueue failed.
Queued import retries supply the original title/bytes/options again. The
existing native job ID fences the single committed effect, not an immutable
payload digest; source bytes remain in the queue envelope rather than a second
SQL payload store.

| Lifecycle   | Marker                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `queued`    | Default durable state on native enqueue.                                                        |
| `running`   | Worker has accepted the job; `started_at` is stamped and `attempt_count += 1`.                  |
| `succeeded` | Terminal. `result_json` carries the import summary, `finished_at` is stamped.                   |
| `failed`    | Terminal failure (or retry candidate). `last_error_code` / `last_error_message`                 |
|             | are populated. The next retry with the same idempotency key is allowed because the              |
|             | partial unique index excludes `failed` from the live window.                                    |
| `cancelled` | Operator pre-cancel or planning-time cancel. `cancelled_at` is stamped before any atomic apply. |

#### Idempotency

A partial unique index on `(workspace_id, idempotency_key)` filters to live
states (`queued` / `running` / `succeeded`). Operators who re-enqueue the
same idempotency key while a previous run is still live get the existing
record back. Duplicate deliveries share that native identity and cannot commit
another imported Database for the same job. A retry after `failed`
or `cancelled` is allowed because those statuses sit outside the partial
index.

#### Cancellation

Two windows for cancellation:

1. **Before the worker picks the job up** — the operator sets
   `cancellation_requested_at`. When the worker eventually dispatches, the
   service short-circuits and the import never runs.
2. **During planning** — between accepted source rows, the service reads
   `cancellation_requested_at`. If set, it returns before the single
   Database/row/workspace-tag transaction starts, then the worker writes
   `status = cancelled`.

The native job lock arbitrates cancellation against atomic apply. If success
has already committed, cancellation does not undo it. A second cancellation
against an already-`cancelled` record is a no-op; worker replay returns the
retained terminal result.

#### Atomic apply and provenance

After planning and validation, CSV import creates the Database, fields, rows,
cells, planned workspace tags and row provenance in one SQL transaction. The
successful native job result commits in that same transaction. A confirmed
transaction abort rolls the complete apply back; a lost commit response is
resolved through the retained job result before reporting a failure. Later
failure/cancellation writes preserve an already terminal success or
cancellation. `created_by_job_id` remains on
committed rows for exact audit and result correlation; it is not a substitute
for transactionality and is not used to repair partially committed imports.

#### Per-row diagnostics

`DatabaseCsvImportResult.failed_rows` carries a stable `rowId` plus a
structured `errorCode` / `errorMessage` pair for every accepted source row
that failed validation. The wizard surfaces the list verbatim — clients
must not have to re-derive counts.

#### Operator inspection

```sql
-- Find a job by idempotency key (or by id, or by workspace + status).
SELECT id, kind, status, attempt_count, cancellation_requested_at, cancelled_at,
       last_error_code, last_error_message, created_at, finished_at
  FROM database_import_jobs
 WHERE workspace_id = $1
   AND idempotency_key = $2;

-- Inspect what a successful import produced.
SELECT result_json
  FROM database_import_jobs
 WHERE id = $1
   AND status = 'succeeded';

-- Count rows a successful job committed (provenance/audit correlation).
SELECT COUNT(*)
  FROM <database_row_table>
 WHERE created_by_job_id = $1;

-- Detect a stuck worker: jobs that have been queued longer than 10 minutes.
SELECT id, kind, idempotency_key, created_at
  FROM database_import_jobs
 WHERE status = 'queued'
   AND created_at < NOW() - INTERVAL '10 minutes';
```

Native integrations request cancellation through
`DatabaseImportExportService::request_bulk_operation_cancellation` and inspect
`get_bulk_operation_job`. These helpers enforce current workspace permissions;
they have no registered public bulk-status/cancellation GraphQL entrypoint.
Direct status updates bypass native arbitration and must not be used for
operator recovery.

## Projection recompute operations

Formula and Rollup cells are stored projections. Normal row, cell, field and
relation mutations mark affected projections stale; the `database` worker queue
then recomputes them in bounded batches. Operators should treat a short-lived
`stale`, `queued` or `recomputePending` state as expected after bulk edits,
imports or relation target changes.

Relevant operational controls are the Database row/page/import limits and the
worker polling interval. Do not raise CSV or page limits to compensate for slow
projection recompute: first inspect worker logs, queue health and repeated
`MIX_DATABASE_FORMULA_RECOMPUTE_FAILED` / rollup validation errors. Projection
failures store stable error code/message columns so the bad field expression,
unsupported dependency, non-finite numeric result or incompatible rollup target
can be fixed without guessing from client state.

For API debugging, use normal application logs. Avoid leaving high-volume
`database` logging at `debug` or `trace` in production; see
[`logging.md`](../../observability/logging.md).

## Runtime verification

When validating a Database deployment, verify the running stack rather
than only the source tree:

1. Verify the deployed server and frontend versions using the selected
   [installation procedure](../../deployment/README.md).
2. Confirm API readiness and check `/info` directly and through the public
   origin; both should report the expected server version/flavor and
   `initialized: true`.
3. Open an authorized workspace and inspect its database inventory, a database
   detail page and a document containing a database embed.
4. Inspect browser console errors and the corresponding API logs.

Use an operator-owned temporary workspace for the functional probe. Create a temporary
Database, add typed fields and rows, exercise search/sort/pagination, export it
as CSV and JSON, and verify that the exports contain only visible fields and
rows. If Formula or Rollup fields are used, wait for their projection state to
become current and verify the `database` queue remains healthy. Inspect browser
console and API logs, then delete the temporary Database through the normal UI.

Stop at the first permission, validation, queue or export error. Preserve the
request ID and logs, leave authoritative rows untouched, and continue with
[Collaboration and recovery](./collaboration-and-recovery.md).
