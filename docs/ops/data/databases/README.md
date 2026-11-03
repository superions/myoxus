# Database operations

[Documentation](../../../README.md) / [Operations](../../README.md) / [Data operations](../README.md)

Operate the server-backed databases that organize workspace records, projects
and structured knowledge. PostgreSQL owns their data and permissions; the Rust
server provides queries, mutations and background processing.

| Task                                                         | Guide                                                                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Move data through CSV, JSON or supported workspace imports   | [Import and export](./import-export.md)                                                                          |
| Inspect search, paging, workers and bulk operations          | [Queries and maintenance](./query-and-maintenance.md)                                                            |
| Diagnose views, collaboration, row content and notifications | [Collaboration and recovery](./collaboration-and-recovery.md)                                                    |
| Inspect or reconcile the shared workspace tag catalog        | [Workspace tags and label recovery](../../administration/workspace-content.md#workspace-tags-and-label-recovery) |

<details>
<summary>On this page</summary>

- [Runtime configuration](#runtime-configuration)
- [Data and ACL model](#data-and-acl-model)
- [Workspace tag operations](#workspace-tag-operations)
- [Database activity stream](#database-activity-stream)
- [Web client surfaces](#web-client-surfaces)

</details>

## Runtime configuration

YAML and environment configuration uses the canonical `databases.*` namespace.
The Admin UI exposes the settings named below. The config parser still accepts
the dated serde aliases `workspaceDatabase` / `workspace_database` and the
queue alias `workspace-database`, emits a startup warning, and always projects
canonical names back to Admin/runtime output. New deployment configuration must
not use those aliases.

All Database limit settings are restart-required.

| Setting · YAML and Admin                                                                                     | Default    | Purpose                                               |
| ------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------- |
| `databases.max_fields_per_database`<br>Admin: `databases.maxFieldsPerDatabase`                               | 100        | Maximum Fields in one Database.                       |
| `databases.max_views_per_database`<br>Admin: `databases.maxViewsPerDatabase`                                 | 25         | Maximum saved Views.                                  |
| `databases.default_rows_per_page`<br>Admin: not exposed                                                      | 100        | Default Row page size when the client omits `first`.  |
| `databases.max_rows_per_page`<br>Admin: `databases.maxRowsPerPage`                                           | 500        | Hard Row page-size clamp.                             |
| `databases.max_cell_text_bytes`<br>Admin: `databases.maxCellTextBytes`                                       | 16,384     | Maximum UTF-8 text/RichText projection size per Cell. |
| `databases.csv_max_bytes`<br>Admin: `databases.csvMaxBytes`                                                  | 5,242,880  | Maximum CSV/JSON upload size.                         |
| `databases.csv_max_rows`<br>Admin: `databases.csvMaxRows`                                                    | 10,000     | Maximum synchronous imported Rows.                    |
| `databases.csv_max_columns`<br>Admin: `databases.csvMaxColumns`                                              | 100        | Maximum import columns.                               |
| `databases.csv_sample_rows_for_type_inference`<br>Admin: `databases.csvSampleRowsForTypeInference`           | 100        | Rows sampled for CSV type inference.                  |
| `databases.notion_max_bytes`<br>Admin: not exposed                                                           | 67,108,864 | Maximum Notion HTML/ZIP payload.                      |
| `databases.max_reminders_per_user_per_cell`<br>Admin: `databases.maxRemindersPerUserPerCell`                 | 5          | Live personal Reminders per user/Cell.                |
| `databases.max_reminder_offset_minutes`<br>Admin: `databases.maxReminderOffsetMinutes`                       | 525,600    | Maximum personal Reminder lead time.                  |
| `i18n.default_currency`<br>Admin: `i18n.defaultCurrency`                                                     | `EUR`      | ISO-4217 default for new Currency Fields/templates.   |
| `job.queues.database`                                                                                        | object     | Canonical queue policy object.                        |
| `job.queues.database.concurrency`                                                                            | 1          | Worker concurrency for the canonical Database queue.  |
| `worker.polling.database_projection_interval_ms`<br>Admin: `serverTuning.workerDatabaseProjectionIntervalMs` | 30,000     | Projection catch-up interval.                         |

Example override:

```yaml
databases:
  max_fields_per_database: 100
  max_views_per_database: 25
  default_rows_per_page: 100
  max_rows_per_page: 500
  max_cell_text_bytes: 16384
  csv_max_bytes: 5242880
  csv_max_rows: 10000
  csv_max_columns: 100
  csv_sample_rows_for_type_inference: 100
  notion_max_bytes: 67108864
  max_reminders_per_user_per_cell: 5
  max_reminder_offset_minutes: 525600
i18n:
  default_currency: EUR
job:
  queues:
    database:
      concurrency: 1
worker:
  polling:
    database_projection_interval_ms: 30000
```

Environment variables follow the standard double-underscore convention, for
example `MYOXUS__DATABASES__CSV_MAX_BYTES`.

Workspace Automations use their own restart-required limits plus the shared
worker queue configuration:

| Setting · YAML and Admin                                                                                                  | Default | Purpose                                     |
| ------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------- |
| `workspace_automation.enabled`<br>Admin: `workspaceAutomation.enabled`                                                    | true    | Enable Workspace Automation evaluation.     |
| `workspace_automation.max_actions_per_run`<br>Admin: `workspaceAutomation.maxActionsPerRun`                               | 10      | Maximum actions executed for one run.       |
| `workspace_automation.max_runs_per_minute`<br>Admin: `workspaceAutomation.maxRunsPerMinute`                               | 120     | Per-workspace run creation rate limit.      |
| `workspace_automation.webhook_timeout_seconds`<br>Admin: `workspaceAutomation.webhookTimeoutSeconds`                      | 10      | Outbound webhook request timeout.           |
| `workspace_automation.max_retry_attempts`<br>Admin: `workspaceAutomation.maxRetryAttempts`                                | 5       | Attempts before dead-letter state.          |
| `job.queues.workspace-automation.concurrency`                                                                             | 2       | Runtime-reloadable worker concurrency.      |
| `worker.polling.workspace_automation_retry_interval_ms`<br>Admin: `serverTuning.workerWorkspaceAutomationRetryIntervalMs` | 30000   | Retry polling interval for automation jobs. |

## Data and ACL model

| Area                 | Operating contract                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authority**        | Schema, fields, rows, cells and views are stored on the server                                                                                |
| **Access**           | Workspace permissions govern database use; manager actions require the corresponding server permission                                        |
| **Linked documents** | Row content and DocumentLink cells refer to normal workspace documents; deleting a row, database or association leaves those documents intact |
| **Relations**        | Relations connect rows within the workspace; projected labels respect document access                                                         |
| **Computed fields**  | Formula and Rollup values are server projections, maintained through the database queue                                                       |
| **Views**            | Table, Kanban, List, Gallery, Calendar and Timeline are saved server records; personal view state belongs to the current account              |
| **Row templates**    | Database-local bindings use the Template Registry; one enabled binding can be the database default                                            |
| **Exports**          | Exported rows, fields and labels follow the caller’s access                                                                                   |

Calendar and Timeline require suitable date fields. Gallery uses its supported
text-card presentation. See [Import and export](./import-export.md) for format
behavior and [Collaboration and recovery](./collaboration-and-recovery.md) for
conflict, missing-field and access diagnosis.

## Workspace tag operations

Documents and database Tags cells share the authoritative `workspace_tags`
catalog. Archive is reversible; permanent deletion uses the authenticated
lifecycle for an already archived tag. The server removes affected assignments
and records retired identities as part of that operation.

Use [Workspace tags and label recovery](../../administration/workspace-content.md#workspace-tags-and-label-recovery)
for catalog inspection, historical identity mappings and revision-bound repair.

## Database activity stream

| Record             | Storage                    | Audience              |
| ------------------ | -------------------------- | --------------------- |
| Operator audit     | `admin_audit_log`          | Administrators        |
| Workspace activity | `database_activity_events` | Workspace members     |
| Notifications      | `notifications`            | Individual recipients |

Bulk edits record an operation-level activity summary with the affected row
outcomes. Activity is best-effort telemetry; committed database records remain
the authority. [Queries and maintenance](./query-and-maintenance.md#activity-audit-and-search-reindex)
explains the bulk audit contract; [Collaboration and recovery](./collaboration-and-recovery.md#troubleshooting)
owns activity-growth and notification checks.

## Web client surfaces

| Surface                     | Use                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------ |
| **Database inventory**      | Create databases or projects from the server starter-template catalog and import CSV |
| **All Pages and organizer** | Find databases alongside documents; organize them in folders and favorites           |
| **Database detail**         | Edit fields, rows and views; search, filter, sort, group and export                  |
| **Side Peek**               | Inspect a row and create or attach its optional content document                     |
| **Editor embed**            | Work with a server database inside a document through the same permissions and data  |
| **Automations**             | Configure available workflows and inspect recent runs                                |

Personal view changes offer **Reset**; eligible editors can **Save to view**.
Check the deployed version and API responses when expected controls or records
are missing, then continue with the recovery guide.
