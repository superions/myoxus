// SPDX-License-Identifier: AGPL-3.0-or-later

//! The single authoritative Myoxus database migration runner.
//!
//! Fresh databases use the normal SQLx baseline. Databases already on baseline
//! 1000 use the append-only forward chain; every other non-empty ledger or
//! schema state fails before the transaction can persist a migration write.

use sqlx::migrate::{MigrateError, Migrator};
use sqlx::{PgConnection, PgPool, Row};
use thiserror::Error;
use tracing::{info, instrument};

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

#[derive(Debug, Error)]
pub enum MigrationRunError {
  #[error("migration database operation failed")]
  Database(#[source] sqlx::Error),
  #[error(
    "canonical database migration failed (class={class}, highest={highest}); the transaction was rolled back; restore a known-good database and retry"
  )]
  Canonical {
    class: &'static str,
    highest: String,
    #[source]
    source: MigrateError,
  },
  #[error(
    "unsupported migration ledger (class={class}, highest={highest}); restore an empty or baseline-1000 Myoxus database and do not edit _sqlx_migrations manually"
  )]
  UnsupportedLedger { class: &'static str, highest: String },
  #[error(
    "database schema does not match the canonical Myoxus baseline (class={class}, highest={highest}, invariant={invariant}); restore a known-good database instead of editing schema or ledger metadata"
  )]
  SchemaInvariant {
    class: &'static str,
    highest: String,
    invariant: &'static str,
  },
}

#[derive(Debug)]
struct AppliedMigration {
  version: i64,
  description: String,
  success: bool,
  checksum: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LedgerClass {
  Empty,
  Baseline,
}

impl LedgerClass {
  const fn label(self) -> &'static str {
    match self {
      Self::Empty => "empty",
      Self::Baseline => "baseline",
    }
  }
}

/// Read-only classification against this binary's canonical migration inventory.
/// Pending versions are normal forward work, not an altered/unknown ledger.
#[derive(Debug)]
pub struct MigrationInspection {
  pub ledger_class: &'static str,
  pub highest_applied: Option<i64>,
  pub pending_versions: Vec<i64>,
}

/// Inspect one consistent snapshot without creating a ledger, taking the
/// migration advisory lock, running SQL migrations or repairing schema.
/// Schema/privilege readiness remains a separate startup-owned check.
#[instrument(skip_all)]
pub async fn inspect(pool: &PgPool) -> Result<MigrationInspection, MigrationRunError> {
  let mut transaction = pool.begin().await.map_err(MigrationRunError::Database)?;
  sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    .execute(&mut *transaction)
    .await
    .map_err(MigrationRunError::Database)?;
  let inspection = inspect_connection(&mut transaction).await?;
  transaction.rollback().await.map_err(MigrationRunError::Database)?;
  Ok(inspection)
}

/// Inspect within the caller's existing snapshot. Recovery preflight uses this
/// read-only operation so ledger, schema capabilities and planning cannot come
/// from different database states. The caller owns transaction isolation.
#[instrument(skip_all)]
pub async fn inspect_connection(connection: &mut PgConnection) -> Result<MigrationInspection, MigrationRunError> {
  let ledger_exists: bool = sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
    .fetch_one(&mut *connection)
    .await
    .map_err(MigrationRunError::Database)?;
  let applied = if ledger_exists {
    read_applied(connection).await?
  } else {
    Vec::new()
  };
  let class = classify(connection, ledger_exists, &applied).await?;
  Ok(MigrationInspection {
    ledger_class: class.label(),
    highest_applied: applied.last().map(|migration| migration.version),
    pending_versions: MIGRATOR
      .iter()
      .skip(applied.len())
      .map(|migration| migration.version)
      .collect(),
  })
}

/// Apply the canonical baseline and normal forward migrations under one
/// transaction-scoped advisory lock.
#[instrument(skip_all)]
pub async fn run(pool: &PgPool) -> Result<(), MigrationRunError> {
  let mut transaction = pool.begin().await.map_err(MigrationRunError::Database)?;
  sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('myoxus:migrations:v1', 0))")
    .execute(&mut *transaction)
    .await
    .map_err(MigrationRunError::Database)?;

  let ledger_exists: bool = sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
    .fetch_one(&mut *transaction)
    .await
    .map_err(MigrationRunError::Database)?;
  let applied = if ledger_exists {
    read_applied(&mut transaction).await?
  } else {
    Vec::new()
  };
  let highest = applied.last().map(|migration| migration.version);
  let highest_label = highest.map_or_else(|| "none".to_owned(), |version| version.to_string());
  let class = classify(&mut transaction, ledger_exists, &applied).await?;
  info!(
    ledger_class = class.label(),
    highest_version = highest,
    "classified database migration ledger"
  );

  if class == LedgerClass::Empty {
    ensure_migrations_table(&mut transaction).await?;
  }
  MIGRATOR
    .run_direct(&mut *transaction)
    .await
    .map_err(|source| MigrationRunError::Canonical {
      class: class.label(),
      highest: highest_label.clone(),
      source,
    })?;
  validate_final_invariants(&mut transaction, class, &highest_label).await?;

  transaction.commit().await.map_err(MigrationRunError::Database)?;
  info!(ledger_class = class.label(), "database migration run completed");
  Ok(())
}

async fn ensure_migrations_table(connection: &mut PgConnection) -> Result<(), MigrationRunError> {
  sqlx::raw_sql(
    "CREATE TABLE IF NOT EXISTS _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), success BOOLEAN NOT NULL, checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL)",
  )
  .execute(&mut *connection)
  .await
  .map_err(MigrationRunError::Database)?;
  Ok(())
}

async fn read_applied(connection: &mut PgConnection) -> Result<Vec<AppliedMigration>, MigrationRunError> {
  let rows = sqlx::query("SELECT version, description, success, checksum FROM _sqlx_migrations ORDER BY version")
    .fetch_all(&mut *connection)
    .await
    .map_err(MigrationRunError::Database)?;
  Ok(
    rows
      .into_iter()
      .map(|row| AppliedMigration {
        version: row.get("version"),
        description: row.get("description"),
        success: row.get("success"),
        checksum: row.get("checksum"),
      })
      .collect(),
  )
}

async fn classify(
  connection: &mut PgConnection,
  ledger_exists: bool,
  applied: &[AppliedMigration],
) -> Result<LedgerClass, MigrationRunError> {
  if applied.is_empty() {
    let relation_count: i64 = sqlx::query_scalar(
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S') AND c.relname <> '_sqlx_migrations'",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(MigrationRunError::Database)?;
    if relation_count == 0 {
      return Ok(LedgerClass::Empty);
    }
    return Err(unsupported(
      if ledger_exists {
        "empty-ledger-with-schema"
      } else {
        "schema-without-ledger"
      },
      None,
    ));
  }

  let active = MIGRATOR.iter().collect::<Vec<_>>();
  let baseline_present = applied.iter().any(|migration| migration.version == 1000);
  if baseline_present
    && applied.len() <= active.len()
    && applied.iter().zip(active).all(|(migration, expected)| {
      migration.success
        && migration.version == expected.version
        && migration.description == expected.description.as_ref()
        && migration.checksum.as_slice() == expected.checksum.as_ref()
    })
  {
    return Ok(LedgerClass::Baseline);
  }

  Err(unsupported(
    if baseline_present {
      "invalid-baseline-ledger"
    } else {
      "unknown-pre-baseline-ledger"
    },
    applied.last().map(|migration| migration.version),
  ))
}

async fn validate_final_invariants(
  connection: &mut PgConnection,
  class: LedgerClass,
  highest: &str,
) -> Result<(), MigrationRunError> {
  // This runs after the complete forward chain, inside the migration transaction.
  // Inventory describes the current head, not the ledger version at entry.
  let table_count: i64 = sqlx::query_scalar(
    "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_sqlx_migrations'",
  )
  .fetch_one(&mut *connection)
  .await
  .map_err(MigrationRunError::Database)?;
  if table_count != 227 {
    return Err(MigrationRunError::SchemaInvariant {
      class: class.label(),
      highest: highest.to_owned(),
      invariant: "public table inventory",
    });
  }

  let required_relations: i64 = sqlx::query_scalar(
    "SELECT count(*) FROM unnest(ARRAY['users','workspaces','docs','doc_updates','doc_snapshots','blobs','search_content','workspace_' || 'databases','workspace_' || 'database_rows','workspace_' || 'database_cell_values','workspace_tag_retired_ids','organization','organization_unit','git_sync_profiles','git_sync_scope_exclusions','git_sync_bootstrap_attempts','git_token_rotation','git_sync_history_capture_receipts','pdf_workspace_template_assignments','app_configs','page_registration_evidence','document_edit_capture_state','document_edit_capture_runtime','document_history_capture_request','workspace_document_metadata_index_revision','workspace_database_page_inventory_revision','document_change_batches','document_change_batch_actors','calendar_mail_state','calendar_mail_receipts','calendar_reminder_mail_receipts','database_row_source_links','database_task_capture_receipts','workspace_starter_applications','sayiir_workflow_snapshots','sayiir_workflow_snapshot_history','sayiir_workflow_tasks','sayiir_workflow_signals','sayiir_workflow_claims','sayiir_workflow_events']) name WHERE to_regclass('public.' || name) IS NOT NULL",
  )
  .fetch_one(&mut *connection)
  .await
  .map_err(MigrationRunError::Database)?;
  if required_relations != 40 {
    return Err(MigrationRunError::SchemaInvariant {
      class: class.label(),
      highest: highest.to_owned(),
      invariant: "required relation set",
    });
  }

  let database_constraints: i64 = sqlx::query_scalar(
    "SELECT count(*) FROM pg_constraint WHERE conname IN ('fk_workspace_database_cells_row_database','fk_workspace_database_cells_field_database','fk_workspace_database_relations_source_row_database','fk_workspace_database_relations_source_field_database','fk_workspace_database_relations_target_row_database') AND convalidated",
  )
  .fetch_one(&mut *connection)
  .await
  .map_err(MigrationRunError::Database)?;
  if database_constraints != 5 {
    return Err(MigrationRunError::SchemaInvariant {
      class: class.label(),
      highest: highest.to_owned(),
      invariant: "database membership constraints",
    });
  }

  let gantt_view_kind: bool = sqlx::query_scalar(
    "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_' || 'database_views_view_kind_check' AND convalidated AND pg_get_constraintdef(oid) LIKE '%gantt%')",
  )
  .fetch_one(&mut *connection)
  .await
  .map_err(MigrationRunError::Database)?;
  if !gantt_view_kind {
    return Err(MigrationRunError::SchemaInvariant {
      class: class.label(),
      highest: highest.to_owned(),
      invariant: "database Gantt view kind",
    });
  }

  let pdf_actor_set_null: bool = sqlx::query_scalar(
    "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pdf_workspace_template_assignments_assigned_by_fkey' AND confdeltype = 'n' AND convalidated)",
  )
  .fetch_one(&mut *connection)
  .await
  .map_err(MigrationRunError::Database)?;
  if !pdf_actor_set_null {
    return Err(MigrationRunError::SchemaInvariant {
      class: class.label(),
      highest: highest.to_owned(),
      invariant: "PDF assignment actor lifecycle",
    });
  }

  let locale_contract: bool = sqlx::query_scalar(
    "SELECT EXISTS (SELECT 1 FROM app_configs WHERE id = 'i18n.default_locale') AND NOT EXISTS (SELECT 1 FROM app_configs WHERE id = 'i18n.defaultLocale') AND to_regprocedure('public.document_metadata_default_language_id()') IS NOT NULL",
  )
  .fetch_one(&mut *connection)
  .await
  .map_err(MigrationRunError::Database)?;
  if !locale_contract {
    return Err(MigrationRunError::SchemaInvariant {
      class: class.label(),
      highest: highest.to_owned(),
      invariant: "canonical locale configuration",
    });
  }

  let invalid_presets: i64 =
    sqlx::query_scalar("SELECT count(*) FROM organization_unit_type WHERE is_preset AND NOT can_own_workspaces")
      .fetch_one(&mut *connection)
      .await
      .map_err(MigrationRunError::Database)?;
  if invalid_presets != 0 {
    return Err(MigrationRunError::SchemaInvariant {
      class: class.label(),
      highest: highest.to_owned(),
      invariant: "preset workspace ownership",
    });
  }
  Ok(())
}

fn unsupported(class: &'static str, highest: Option<i64>) -> MigrationRunError {
  MigrationRunError::UnsupportedLedger {
    class,
    highest: highest.map_or_else(|| "none".to_owned(), |version| version.to_string()),
  }
}
