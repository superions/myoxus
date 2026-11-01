# Database import and export

[Documentation](../../../README.md) / [Operations](../../README.md) / [Data operations](../README.md) / [Database operations](./README.md)

Move database data with CSV or the versioned JSON format, and use PostgreSQL backups to recover the complete installation.

<details>
<summary>On this page</summary>

- [CSV import and export](#csv-import-and-export)
- [CSV advanced dialects and mapping](#csv-advanced-dialects-and-mapping)
- [JSON snapshot import/export advanced contract](#json-snapshot-importexport-advanced-contract)
- [Notion import operations](#notion-import-operations)
- [Full legacy workspace import](#full-legacy-workspace-import)

</details>

## Workspace Tasks and managed Projects

Open Workspace Tasks through Tasks to reach its native CSV/JSON export and
content-import controls. JSON preserves the supported native content and graph
contract; CSV preserves the documented field projection, not Task identity,
relations, receipts or reminder recovery. Use installation backups for complete
recovery.

Managed Project import/copy selects the admitted server definition/variant;
portable source facts cannot override Fields, roles, Views, installed versions
or system roles. Copying Workspace Tasks creates an ordinary Project. In-place
import retains the protected root/schema and changes admitted contents only;
preview and apply reject incompatible shapes without silent field loss. Generic
schema import remains independent. Whole-container Move/Extract/purge of the
default is rejected; authorized whole-workspace cleanup remains available.

## CSV import and export

CSV import has two steps:

1. Preview parses the file, infers field types and returns diagnostics without
   creating any Database, Row, content document or Cell value.
2. Apply import creates a new server-side database, fields, rows and cell
   values. CSV never creates implicit Row documents and reports
   `createdDocCount = 0`.

CSV export returns content directly in the GraphQL response together with
`fileName`, `contentType`, `rowCount`, `columnCount`, `databaseId` and `viewId`.
It does not issue signed blob URLs.

URL, Email and Phone columns are imported as editable fields when detected by
header name or sampled values. Metadata projection headers such as Created Time,
Created By, Updated Time and Updated By are accepted in preview/apply only as
read-only diagnostics: import skips those values and returns structured warnings
instead of writing spoofed row metadata. Export renders all simple property
fields, including metadata projections, from the server-owned row read model.

Queued CSV imports retain their native Database identity and complete result
in the existing job record, atomically with the imported contents. Duplicate
delivery or a lost commit response reads that result instead of creating a
second Database. A storage failure with no confirmed result remains uncertain;
do not replace it with a new job merely because an error was returned. Explicit
cancellation keeps the existing provenance-based compensation path.

## CSV advanced dialects and mapping

The advanced CSV contract layers production-grade CSV import/export on top of
the server-owned preview/apply flow. That flow covers dialect detection, header
behaviour and quoted/multiline values; It extends export options, adds
mapping-template storage and finalizes the multi-step wizard contract.

### Advanced export options

`workspace.databaseCsvExport(databaseId, options: DatabaseCsvExportOptionsInput)`
and the `exportDatabaseCsv(input: ExportDatabaseCsvInput)` mutation take the
unified `DatabaseCsvExportOptions` payload, which records the dialect and
presentation choices required for a reproducible later import:

| Field           | Type                                 | Purpose                                                                                                     |
| --------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `dialect`       | `DatabaseCsvDialectInput`            | Same dialect contract as preview and apply (delimiter, quote, escape, double quote, custom delimiter byte). |
| `includeHeader` | `Boolean`                            | When `false`, the export omits the header row. Defaults to `true`.                                          |
| `quoteStrategy` | `Minimal` / `All`                    | `All` quotes every field so positional round-trips survive any cell content.                                |
| `localeMode`    | `Machine` / `Localized`              | Localized renders `42 €` for `de-DE` and `12,3` decimals; default is `Machine`.                             |
| `locale`        | `String?`                            | Required when `localeMode=Localized`. Currently keyed on `en-US`, `de-DE`/`-AT`/`-CH`, `fr-FR`/`-CH`/`-BE`. |
| `target`        | `Database` / `View` / `SelectedRows` | `SelectedRows` filters by `rowIds`; `View` requires `viewId` matching an existing view.                     |
| `viewId`        | `ID?`                                | Required for `target=View`, optional for `SelectedRows`.                                                    |
| `rowIds`        | `[ID!]`                              | Required for `target=SelectedRows`; capped at 500 rows per request.                                         |

The export returns the same payload it always did, plus `target`,
`includeHeader`, `quoteStrategy`, `localeMode`, `locale` and a `warnings`
array. For `target=SelectedRows`, every requested row id that does not belong
to the database is surfaced as a `MIX_CSV_EXPORT_UNKNOWN_ROW` diagnostic so
the wizard can warn instead of silently dropping rows.

### Mapping templates (server-side)

Saved mappings live in the canonical CSV mapping-templates table. Each save is
a new revision; the
unique constraint on `(workspace_id, name) WHERE is_current = TRUE` keeps
exactly one current revision per template name. The GraphQL surface
exposes:

- `workspace.databaseCsvMappingTemplates` — current revision summary per
  template, ordered most-recently-updated first (used by the wizard's
  "reuse template" dropdown).
- `saveDatabaseCsvMappingTemplate(input)` — persists the current preview
  mapping as a named template.
- `loadDatabaseCsvMappingTemplate(input)` — fetches the current revision
  for a given name.
- `deleteDatabaseCsvMappingTemplate(input)` — removes every revision of
  a template by name.

### Wizard step surface

The 6-step wizard runs against the existing preview/apply GraphQL
endpoints; The current API formalizes the per-step inputs without breaking the
server-side contract:

1. **Detect** — `previewDatabaseCsvImport` returns the detected
   delimiter, applied dialect and confidence plus per-column inference.
2. **Structure** — same `previewDatabaseCsvImport` lets the wizard
   override delimiter, quote, escape, double-quote, `firstRowIsHeader`.
3. **Mapping** — same call lets the wizard toggle `importColumn`,
   `fieldName`, `fieldType`, `isTitle` per source column.
4. **Field types** — driven by the `mapping[].fieldType` array.
5. **Review** — preview's `errors[]` + `warnings[]`.
6. **Result** — `importDatabaseCsv` returns `createdFieldCount`,
   `createdRowCount`, `createdDocCount`, `skippedRowCount`,
   `errors[]`, `warnings[]`.

Templates are saved after step 5 with `saveDatabaseCsvMappingTemplate`
and reused from step 3 with `loadDatabaseCsvMappingTemplate`. i18n keys
cover every label and step name under
`com.myoxus.database.csv.wizard.step.*`,
`com.myoxus.database.csv.export.quote-strategy.*`,
`com.myoxus.database.csv.export.locale-mode.*`,
`com.myoxus.database.csv.export.target.*`,
`com.myoxus.database.csv.mapping-template.*`.

## JSON snapshot import/export advanced contract

JSON snapshots use one canonical format for export and import. Operators choose
the import mode, conflict strategy and confirmation for destructive changes.

### Snapshot format (`DatabaseSnapshot`)

The snapshot envelope serializes as:

```json
{
  "schemaVersion": 4,
  "exportedAt": "2026-07-08T12:34:56Z",
  "source": {
    "product": "myoxus",
    "format": "database-json-snapshot",
    "databaseId": "…",
    "exportedBy": "…"
  },
  "database": { … see below … },
  "databases": [ { … mirror of database … } ],
  "filesManifest": [
    { "blobKey": "pdb28/blob-1", "name": "spec.md", "mime": "text/markdown",
      "size": 1234, "fieldName": "Attachments", "rowId": "row_0" }
  ]
}
```

Key rules:

- `schemaVersion` is a `u32` and currently always `4`. Imports reject zero or
  snapshots with a version greater than `4` via
  `MIX_DATABASE_JSON_UNSUPPORTED_VERSION`.
- `database.fields[]` carries every field with a portable `DatabaseFieldConfig`
  payload (`{ "kind": "title" }` for primitive types, the typed relation/rollup/
  formula sub-enums for the special shapes).
- `database.rows[]` use local snapshot row ids; relation cells reference
  other rows by their local ids so the file is self-contained.
- A Row or Row template may carry an explicit portable `contentDocument` with
  a snapshot-local `documentKey`, title, canonical padded Base64 Yjs update and
  sorted `assetKeys`. Live document UUIDs and private blob keys are never
  portable identity. Preview validates without writes; Apply preallocates fresh
  document IDs and compensates all created resources on a later failure.
- `filesManifest` is one entry per distinct `blobKey` referenced from any
  `Files` cell across all rows and row templates. The entry carries
  `fieldName` and `rowId` for diagnostics.
- `databases[]` mirrors the top-level `database` payload. Import tooling
  accepts the mirror while preserving the single-database top-level contract.

### Export

`workspace.databaseJsonExport(databaseId)` (or
`exportDatabaseJson(input)`) returns a `DatabaseJsonExport` payload
(`fileName`, `contentType`, `content`). The JSON content is
`serde_json::to_string_pretty` of `DatabaseSnapshot`, sized to the
existing `csvMaxBytes` upload limit. The export always re-reads the live
record and rows, so it never lies about the source-of-truth.

### Preview

`workspace.previewDatabaseJsonImport(file, input)` parses the snapshot,
runs the schema checks and returns a `DatabaseJsonPreview` with:

| Field                       | Purpose                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `schemaVersion`             | Echoed from the snapshot (currently `4`).                                                       |
| `schemaVersionSupported`    | `true` for `1..=4`, `false` for zero or a higher version.                                       |
| `title`, `fieldCount`, …    | Counts the wizard renders on the review step.                                                   |
| `fileManifestCount`         | Number of `filesManifest` entries. The wizard surfaces this as the file count.                  |
| `exportActor`, `exportedAt` | Operator identity captured at export time.                                                      |
| `defaultMode`               | Selected preview mode (`CREATE` when omitted). |
| `defaultConflictStrategy`   | Selected preview conflict strategy (`ABORT` when omitted).                                                |
| `warnings[]`                | Soft diagnostics (e.g. `MIX_DATABASE_JSON_MISSING_FILE`).                                       |
| `errors[]`                  | Hard diagnostics (e.g. `MIX_DATABASE_JSON_UNSUPPORTED_VERSION`).                                |

### Import

`workspace.importDatabaseJson(file, input)` is the single apply entry
point. The `ImportDatabaseJsonInput` payload carries:

| Field                | Type                                     | Notes                                                                             |
| -------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| `workspaceId`        | `ID`                                     | The destination workspace.                                                        |
| `mode`               | `CREATE` / `REPLACE` / `MERGE`           | Required. Defaults to `CREATE` if omitted on the workspace.                       |
| `conflictStrategy`   | `ABORT` / `RENAME` / `OVERWRITE`         | Required for `MERGE`. Defaults to `ABORT`.                                        |
| `targetDatabaseId`   | `ID?`                                    | Required for `REPLACE` and `MERGE`.                                               |
| `fieldMapping`       | `[DatabaseJsonImportFieldMappingInput!]` | `snapshotFieldId → target`; `target` is either a target field id or `new:<name>`. |
| `confirmDestructive` | `Boolean`                                | Required `true` for `REPLACE`.                                                    |
| `dryRun`             | `Boolean`                                | If `true`, validate and report counts without persisting.                         |

The result is a `DatabaseJsonImportResult` with `mode`, `conflictStrategy`,
`dryRun`, the per-bucket counts (`createdFieldCount`, `createdRowCount`,
`updatedRowCount`, `skippedRowCount`, `missingFileCount`,
`createdTemplateCount`), and two warning lists: `warnings` (general
diagnostics such as the Replace report) and `conflictWarnings` (per-row
collisions emitted under the chosen `conflictStrategy`).

### Mode behaviour

- `CREATE` — fresh database; the bundle's rows/views/fields/templates are
  persisted in a single transaction. Missing target id is fine.
- `REPLACE` — `targetDatabaseId` is required; the operator must opt in
  with `confirmDestructive: true`. The repository deletes the existing
  database, then the bundle is persisted as a fresh create. A
  `MIX_DATABASE_JSON_REPLACE_REPORT` warning is appended with the
  pre-delete row count so the wizard can show the operator exactly what
  was dropped.
- `MERGE` — `targetDatabaseId` is required; `fieldMapping` resolves each
  snapshot field to an existing target field (by id) or to a new field
  (`new:<name>`). Rows whose snapshot has a UniqueId cell that collides
  with an existing row trigger the chosen `conflictStrategy`:
  - `ABORT` — the row is reported in `conflictWarnings` and the import
    rolls back; `MIX_DATABASE_JSON_CONFLICT` is raised.
  - `RENAME` — both copies survive; the snapshot row is allocated a fresh
    id and a `MIX_DATABASE_JSON_CONFLICT` warning is added.
  - `OVERWRITE` — the existing target row is updated in place with the
    snapshot's cells; a `MIX_DATABASE_JSON_CONFLICT` warning is added.
    Rows without a UniqueId cell always append, regardless of strategy.

### Error codes

Every error and warning carries a stable `code` so the wizard can map
diagnostics to localized labels under
`com.myoxus.database.json-import.diagnostics.*`:

| Code                                          | Meaning                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `MIX_DATABASE_JSON_INVALID`                   | Snapshot could not be parsed; underlying serde error is included in the message. |
| `MIX_DATABASE_JSON_UNSUPPORTED_VERSION`       | `schemaVersion` is a higher major than the server supports.                      |
| `MIX_DATABASE_JSON_MISSING_FILE`              | A blob reference in the manifest is not carried with the upload.                 |
| `MIX_DATABASE_JSON_CONFLICT`                  | A snapshot row collided with an existing target row.                             |
| `MIX_DATABASE_JSON_REPLACE_REPORT`            | `REPLACE` mode dropped the target's rows; informational.                         |
| `MIX_DATABASE_JSON_DESTRUCTIVE_NOT_CONFIRMED` | `REPLACE` mode was used without `confirmDestructive: true`.                      |
| `MIX_DATABASE_JSON_TARGET_REQUIRED`           | `REPLACE`/`MERGE` mode used without `targetDatabaseId`.                          |
| `MIX_DATABASE_JSON_FIELD_MAPPING_INVALID`     | A `fieldMapping` entry references an unknown snapshot or target field.           |
| `MIX_DATABASE_FIELD_INVALID`                  | Underlying field constraint (e.g. unique field name collision, type mismatch).   |

i18n keys cover the import mode selector, conflict strategy selector,
target database selector, `confirmDestructive` checkbox, dry-run toggle,
field mapping table, files manifest count, conflict warnings list and
the snapshot's `exportActor` / `exportedAt` blocks. All keys live under
`com.myoxus.database.json-import.*` and have German parity in
`de.json`.

### Operator runbook

1. **Backups before a destructive import** — operators running
   `REPLACE` should always take a fresh JSON snapshot of the target
   first; the new copy itself is the only rollback path because the
   `REPLACE` transaction is a hard delete.
2. **Carrying files with the snapshot** — the `filesManifest` is
   informational, not authoritative. To preserve a Files-field, upload
   the referenced blobs to the destination workspace before importing
   the JSON; otherwise the wizard surfaces a
   `MIX_DATABASE_JSON_MISSING_FILE` warning and the cells end up with
   broken blob links.
3. **Merge + RENAME in bulk** — when the source and target share a
   UniqueId sequence (e.g. mirrored workspaces), pick `MERGE` +
   `RENAME` to keep both copies. The wizard renders the
   `conflictWarnings` list so the operator can audit every rename.
4. **Dry run before applying** — set `dryRun: true` on the same
   `mode`/`fieldMapping` combination the operator intends to apply. The
   result's counts are computed without persisting, so a final read
   against `workspace.databases` still reflects the pre-import state.
5. **Undoing a failed merge** — because `MERGE` is append/update
   (never delete), there is no in-band undo. Re-export the target,
   compare against the pre-import snapshot, and delete the rows
   surfaced in the merge result.

## Notion import operations

Notion import is gated to the database inventory routes (`/databases`).
The legacy document-import menu no longer exposes a Notion entry point;
that constraint is enforced by
`client/libs/core/src/desktop/dialogs/import/import-dialog-ui-contract.spec.ts`
("does not expose Notion as a document import option").

### Transport

Notion import runs through the GraphQL mutations
`workspace.previewDatabaseNotionImport` and
`workspace.importDatabaseNotion`. Both take a single opaque
`NotionImportInput` document with the upload as `notionExport` plus
`options` (preview/apply mode, conflict strategy, optional target
database id). The mutations are bound to server config key
`databases.notion_max_bytes` (default `67_108_864` bytes; ~64 MiB).

The preview/apply contract mirrors the JSON snapshot contract. A
preview always returns a `DatabaseJsonPreview` with diagnostics. Apply
returns a `DatabaseJsonImportResult` with `createdFields`,
`createdRows`, `createdCellValues`, `warnings` and any
`MIX_DATABASE_NOTION_*` diagnostics surfaced through the warnings
list. Diagnostics are non-fatal by default; the importer records them
and continues.

Preview also reports matched Page, content-document, empty-Page, body-block and
rewritten-link counters. These counters expose exports whose database table
arrived without its linked Page files. Apply creates a Row content document only
for an unambiguous normalized Page-ID match; an unmatched Row deliberately stays
documentless.

### Current Notion import contract

- **Files/media apply-time upload.** The apply path now uploads each
  referenced archive entry through
  `BlobService::upload_single_part_blob` and rewrites the resulting
  `Files` cell `blobKey` to a workspace `notion/{archive}/{basename}`
  key. Success is recorded in
  `MIX_DATABASE_NOTION_ASSET_MATERIALIZED`; upload-time upload failures
  are surfaced under `MIX_DATABASE_NOTION_ASSET_REJECTED` plus the
  attached `MIX_DATABASE_NOTION_ASSET_ROLLBACK` cleanup diagnostics.
- **Apply-time rollback.** When the JSON apply step fails after assets
  have been uploaded, the importer walks the materialization record
  and soft-deletes every uploaded blob metadata row so the workspace
  blob store is left without orphan references.
- **Page-body rollback.** Page images/files reuse that same materialization
  ledger. A later Yjs, reserved-link or content-document failure returns
  `MIX_DATABASE_NOTION_BODY_APPLY_FAILED` after uploaded blobs and created
  documents have been compensated.
- **People/User workspace-member matching.** Notion People values are
  now matched against active workspace members by display name first
  and exact handle second; matched values become real `User`/`Users`
  cell values. Ambiguous or unmatched identities leave the typed `Users`
  cell empty and remain visible in row-local
  `MIX_DATABASE_NOTION_PEOPLE_AMBIGUOUS` /
  `MIX_DATABASE_NOTION_PEOPLE_UNMATCHED` diagnostics.

### Size and throughput limits

- `databases.notion_max_bytes` is the per-request cap on the raw upload.
  Larger uploads fail at the GraphQL boundary with a stable
  `MIX_DATABASE_NOTION_TOO_LARGE` error.
- Single HTML entries larger than `8 MiB` are skipped with an
  `MIX_DATABASE_NOTION_UNSUPPORTED` warning.
- Cumulative uncompressed ZIP body larger than `512 MiB` aborts the
  whole archive with `MIX_DATABASE_NOTION_UNSUPPORTED`.
- Databases with more than `50_000` rows are imported, but the row
  count is logged so the operator can confirm the cap is below the
  service limit.

### Known lossy elements

The honest loss matrix is recorded in this document under "Notion Export
Format Fidelity". Lossy elements surface
as non-fatal `MIX_DATABASE_NOTION_*` diagnostics on the preview and
again on the apply result:

| Source element                                                | Diagnostic code                                                                                                                                                                  | Severity       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Synced blocks                                                 | `MIX_DATABASE_NOTION_UNSUPPORTED`                                                                                                                                                | error          |
| Page mentions (`@Page`)                                       | `MIX_DATABASE_NOTION_DROPPED_PAGE_MENTION`                                                                                                                                       | warning        |
| Page emoji / cover                                            | `MIX_DATABASE_NOTION_DROPPED_PAGE_ICONOGRAPHY`                                                                                                                                   | warning        |
| `Formula` / `Rollup` / `Relation` / `People` / `Verification` | `MIX_DATABASE_NOTION_PROPERTY_DOWNGRADED` (with the per-kind code: `RelationDegraded`, `RollupDegraded`, `FormulaDegraded`, `PeopleDegraded`)                                    | warning        |
| Duplicate select options                                      | `MIX_DATABASE_NOTION_DUPLICATE_OPTION_NAME`                                                                                                                                      | warning        |
| Garbled / non-HTML entry pages                                | `MIX_DATABASE_NOTION_HTML_INVALID`                                                                                                                                               | error          |
| Files/media apply-time upload                                 | `MIX_DATABASE_NOTION_ASSET_MATERIALIZED` (success), `MIX_DATABASE_NOTION_ASSET_REJECTED` (failed upload), `MIX_DATABASE_NOTION_ASSET_ROLLBACK` (compensated after apply failure) | info           |
| People/User member matching                                   | `MIX_DATABASE_NOTION_PEOPLE_MATCHED` (single unambiguous match), `MIX_DATABASE_NOTION_PEOPLE_AMBIGUOUS` (>1 match), `MIX_DATABASE_NOTION_PEOPLE_UNMATCHED` (no match)            | info / warning |
| Missing/ambiguous Page body association                       | `MIX_DATABASE_NOTION_PAGE_BODY_MISSING`, `MIX_DATABASE_NOTION_PAGE_BODY_AMBIGUOUS`                                                                                               | info / warning |
| Unsupported Page-body construct                               | `MIX_DATABASE_NOTION_PAGE_BODY_UNSUPPORTED` or a construct-specific dropped diagnostic; readable fallback retained where safe                                                    | warning        |

Cross-database `Relation`/`Rollup` references are NOT preserved as
editable references — they become `Text` cells with the page name
the user originally saw on the Notion side. This is the most likely
place for an operator to be surprised; if you need those references
to remain queryable, route the import through the JSON snapshot path
instead.

### Operational runbook

1. Capture the export from Notion (`... → Export → HTML / Subpages`
   for a `.zip`, or `HTML only` for one `.html` page).
2. Open `/databases`, click the Notion import menu item on the
   empty-state button or the inventory header menu.
3. Drop the archive; preview returns within seconds for small
   databases, within a minute for archives with several thousand
   rows. Diagnostics appear inline in the preview modal.
4. Apply creates the new database; the apply result records the row,
   field, and cell counts plus any warnings.
5. If the preview reports `TooLarge`, retry with a smaller export
   (split by folder if necessary) or ask the operator to raise
   `databases.notion_max_bytes` after confirming the operator owns the
   workspace.

Notion export is implemented as a **best-effort** page-per-row HTML
set + asset manifest. The server-side adapter returns a structured
NotionHtmlExport { pages, diagnostics }` value (see the Notion Export Format
Fidelity section above). The Web download dialog or the CLI may package
the result into a ZIP if a downloadable archive is needed. For
loss-less round-trips, use the Myoxus JSON snapshot
(`databaseJsonExport`→`databaseJsonImport`); the Notion-oriented
exporter is for interoperability with a Notion workspace, not for
preserving every Notion semantic.

## Full legacy workspace import

Use **Import legacy workspace** in Web/Electron or the `myoxus-cli workspace
import` family for old SQLite and workspace snapshot ZIP payloads. Do not copy
a legacy SQLite file into application data and do not use **Restore Myoxus
backup**: backup restore is a separate current-format Electron recovery path.

### Migrate databases in existing documents

Use the Database migration commands when legacy editor-local Database blocks
already exist in documents of a server workspace. This is distinct from a full
workspace import and never creates a new workspace.

```bash
myoxus-cli database migrate-legacy-preview \
  --actor-user-id <user-id> \
  --workspace-id <workspace-id> \
  --document-id <document-id>

myoxus-cli database migrate-legacy \
  --actor-user-id <user-id> \
  --workspace-id <workspace-id> \
  --document-id <document-id>
```

Repeat `--document-id` to inspect or migrate several documents under one
all-or-blocked validation plan. Always review preview diagnostics first. A
blocking diagnostic prevents every write in that request; there is no force
flag, partial conversion or read-only legacy fallback. The actor must have
normal workspace write permission. Apply uses the document service's
appended-update path and is idempotent, so a retry does not duplicate Databases
or document updates.

### Configuration

All keys use the existing Admin configuration registry. Positive values hot
apply except worker concurrency, which is read at process startup.

| Key                                        |       Default | Restart |
| ------------------------------------------ | ------------: | :-----: |
| `workspace.import.max_upload_bytes`        | 2,147,483,648 |   no    |
| `workspace.import.max_expanded_bytes`      | 8,589,934,592 |   no    |
| `workspace.import.max_archive_entries`     |       100,000 |   no    |
| `workspace.import.max_entry_bytes`         | 2,147,483,648 |   no    |
| `workspace.import.max_compression_ratio`   |           200 |   no    |
| `workspace.import.max_sqlite_bytes`        | 2,147,483,648 |   no    |
| `workspace.import.max_documents`           |       100,000 |   no    |
| `workspace.import.max_blocks`              |     5,000,000 |   no    |
| `workspace.import.max_databases`           |        10,000 |   no    |
| `workspace.import.max_rows_per_database`   |     1,000,000 |   no    |
| `workspace.import.max_cells_per_database`  |    20,000,000 |   no    |
| `workspace.import.max_assets`              |       250,000 |   no    |
| `workspace.import.max_asset_bytes`         | 6,442,450,944 |   no    |
| `workspace.import.staging_retention_hours` |            24 |   no    |
| `workspace.import.job_timeout_seconds`     |         7,200 |   no    |
| `workspace.import.worker_concurrency`      |             1 |   yes   |

Cross-key validation requires entry bytes not to exceed expanded/upload bytes,
SQLite bytes not to exceed upload bytes and asset bytes not to exceed expanded
bytes. Global upload/document/Database field/view limits may clamp these values
further. Keep concurrency conservative because decode and product
materialization are I/O intensive.

### Lifecycle and recovery

Normal progression is `staged -> queued -> running -> previewed`, followed by a
second `queued -> running -> succeeded` operation for Apply. `failed`,
`cancelled`, `cleanup_required` and `expired` are terminal projections.

- A blocked preview performs no product write. Correct the source; do not
  override a stable diagnostic.
- Cancellation before or during materialization is durable and compensates all
  hidden product state.
- `cleanup_required` means compensation did not finish. The target remains
  hidden and retention will not delete the record. Run the permission-gated,
  idempotent cleanup operation until status becomes `failed`.
- A new import of the same bytes is allowed and receives a new target plan.
  Retrying one existing operation must not duplicate ids or product records.

```bash
myoxus-cli workspace import preview --file <path> --actor-id <user-id>
myoxus-cli workspace import apply --file <path> --actor-id <user-id>
myoxus-cli workspace import status --import-id <import-id>
myoxus-cli workspace import cleanup --import-id <import-id>
```

`cleanup` is allowed only for an operation whose durable status is
`cleanup_required`. Record that status and the import/hidden-target inventory,
and verify a current database/blob checkpoint before invoking it. Abort for any
other status or import ID. Afterward require a terminal `failed` status and no
remaining hidden product state; restore the checkpoint if cleanup affected an
unrelated target.

### Observability

Structured traces include import/job/workspace/actor ids, format, stage,
duration and aggregate counts. They must not contain source filenames, archive
paths, document titles, Yjs/cell content, credentials or signed URLs. Cleanup
retry uses the existing operational audit store/event pipeline.

Monitor these metric families:

- `workspace_import_staged_bytes_total`
- `workspace_import_queue_latency_ms_{sum,count}`
- `workspace_import_jobs_terminal_total`
- `workspace_import_blocking_diagnostics_total`
- `workspace_import_migrated_{documents,databases,rows,assets}_total`
- `workspace_import_cancellations_total`
- `workspace_import_compensation_failures_total`
- `workspace_import_cleanup_{required_total,backlog_sum,backlog_count}`
- `workspace_import_retention_purged_total`

For a stuck operation, inspect its durable status first, then API/worker logs
for the same import id and progress stage. Verify Redis worker health and queue
latency before restarting. After restart, the durable worker resumes or
compensates the same plan; never delete Redis/import rows or hidden workspaces
manually. See the
[server contract] for format and
atomicity details.

### Diagnostic actions

Diagnostic payloads contain stable codes and bounded object context, not source
paths or document/cell content. Treat every code below as blocking unless the
preview explicitly marks an omitted, non-portable category as informational.

| Code                                             | Operator action                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `MIX_WORKSPACE_IMPORT_FORMAT_UNSUPPORTED`        | Supply a supported SQLite workspace or validated snapshot ZIP; renaming a file does not change its format. |
| `MIX_WORKSPACE_IMPORT_UPLOAD_LIMIT`              | Reduce the source size or adjust the effective upload limit through Admin configuration.                   |
| `MIX_WORKSPACE_IMPORT_ARCHIVE_INVALID`           | Re-export the ZIP; do not manually remove path-safety or integrity findings.                               |
| `MIX_WORKSPACE_IMPORT_ARCHIVE_LIMIT`             | Reduce archive entries/expanded size/compression ratio or adjust the effective Admin limits.               |
| `MIX_WORKSPACE_IMPORT_SQLITE_INVALID`            | Re-export an intact SQLite workspace; truncated or writable-source recovery is unsupported.                |
| `MIX_WORKSPACE_IMPORT_SQLITE_SCHEMA_UNSUPPORTED` | Export through a supported source version; the importer never runs source migrations.                      |
| `MIX_WORKSPACE_IMPORT_SNAPSHOT_INVALID`          | Re-export the snapshot with valid JSON/Yjs content and declared object references.                         |
| `MIX_WORKSPACE_IMPORT_ASSET_MISSING`             | Restore every declared asset and preview a new import.                                                     |
| `MIX_WORKSPACE_IMPORT_DOCUMENT_INVALID`          | Repair or re-export the named document; apply cannot omit it.                                              |
| `MIX_WORKSPACE_IMPORT_DATABASE_INVALID`          | Repair the source Database payload; fields, rows, cells and views are never silently dropped.              |
| `MIX_WORKSPACE_IMPORT_DATABASE_UNSUPPORTED`      | Convert unsupported Database constructs in the source before importing.                                    |
| `MIX_WORKSPACE_IMPORT_DATABASE_VALUES_OMITTED`   | Informational: review account-bound values or deleted-column residue that could not be represented safely. |
| `MIX_WORKSPACE_IMPORT_APPLY_BLOCKED`             | Resolve all blocking preview diagnostics, then start a new validated apply.                                |
| `MIX_WORKSPACE_IMPORT_PERMISSION_DENIED`         | Use an actor with the required account/workspace permission; never bypass ACLs in SQL.                     |
| `MIX_WORKSPACE_IMPORT_CANCELLED`                 | Start a new import if cancellation was unintended; the cancelled target is compensated.                    |
| `MIX_WORKSPACE_IMPORT_CLEANUP_REQUIRED`          | Run the idempotent cleanup command and investigate the failed compensation stage before retrying import.   |
| `MIX_WORKSPACE_IMPORT_EXPIRED`                   | Start a new upload; expired staging records are not revived.                                               |
