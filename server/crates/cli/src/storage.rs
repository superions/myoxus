//! `storage` subcommand — blob storage statistics and maintenance.

use clap::{Args, Subcommand};
use serde::Serialize;
use sqlx::PgPool;
use tabled::Tabled;
use uuid::Uuid;

use crate::output::print_output;

const REFERENCE_TRACKING_REQUIRED: &str = "storage orphan detection and garbage collection are disabled until authoritative blob reference tracking is available; no data was changed";

/// Subcommands for `storage`.
#[derive(Subcommand)]
pub enum StorageCommand {
  /// Show total blob storage used per workspace (or for one workspace).
  Stats(StorageStatsArgs),
  /// Show the top N workspaces by total blob storage.
  Top(StorageTopArgs),
  /// Disabled until authoritative blob reference tracking is available.
  Orphans,
  /// Disabled until authoritative blob reference tracking is available.
  Gc(StorageGcArgs),
}

/// Arguments for `storage stats`.
#[derive(Args)]
pub struct StorageStatsArgs {
  /// Optional UUID of a specific workspace.
  #[arg(long)]
  pub workspace: Option<String>,
}

/// Arguments for `storage top`.
#[derive(Args)]
pub struct StorageTopArgs {
  /// Number of workspaces to show.
  #[arg(long, default_value = "10")]
  pub n: i64,
}

/// Arguments for `storage gc`.
#[derive(Args)]
pub struct StorageGcArgs {
  /// Compatibility flag; garbage collection is currently disabled.
  #[arg(long)]
  pub dry_run: bool,
  /// Compatibility flag; garbage collection is currently disabled.
  #[arg(long)]
  pub confirm: bool,
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// Per-workspace storage summary.
#[derive(Tabled, Serialize)]
pub struct WorkspaceStorageRow {
  /// Workspace UUID.
  pub workspace_id: String,
  /// Workspace name.
  pub workspace_name: String,
  /// Number of completed blobs.
  pub blob_count: i64,
  /// Total storage in bytes.
  pub total_size_bytes: i64,
  /// Human-readable total size in MiB.
  pub total_size_mib: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `storage` subcommand.
pub async fn run(cmd: StorageCommand, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  match cmd {
    StorageCommand::Stats(args) => stats(args, pool, json).await,
    StorageCommand::Top(args) => top(args, pool, json).await,
    StorageCommand::Orphans => orphans(pool, json).await,
    StorageCommand::Gc(args) => gc(args, pool, json).await,
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async fn stats(args: StorageStatsArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let rows: Vec<(Uuid, String, Option<i64>, Option<i64>)> = if let Some(ref ws) = args.workspace {
    let id = ws
      .parse::<Uuid>()
      .map_err(|_| anyhow::anyhow!("Invalid workspace UUID: {ws}"))?;

    sqlx::query_as(
      r#"SELECT w.id AS workspace_id, w.name AS workspace_name,
                      COUNT(b.key)::BIGINT AS blob_count,
                      COALESCE(SUM(b.size), 0)::BIGINT AS total_size_bytes
               FROM workspaces w
               LEFT JOIN blobs b ON b.workspace_id = w.id AND b.status = 'completed'
               WHERE w.id = $1 AND w.deleted_at IS NULL
               GROUP BY w.id, w.name"#,
    )
    .bind(id)
    .fetch_all(pool)
    .await?
  } else {
    sqlx::query_as(
      r#"SELECT w.id AS workspace_id, w.name AS workspace_name,
                      COUNT(b.key)::BIGINT AS blob_count,
                      COALESCE(SUM(b.size), 0)::BIGINT AS total_size_bytes
               FROM workspaces w
               LEFT JOIN blobs b ON b.workspace_id = w.id AND b.status = 'completed'
               WHERE w.deleted_at IS NULL
               GROUP BY w.id, w.name
               ORDER BY total_size_bytes DESC"#,
    )
    .fetch_all(pool)
    .await?
  };

  let display: Vec<WorkspaceStorageRow> = rows
    .into_iter()
    .map(|(workspace_id, workspace_name, blob_count, total_size_bytes)| {
      let bytes = total_size_bytes.unwrap_or(0);
      WorkspaceStorageRow {
        workspace_id: workspace_id.to_string(),
        workspace_name,
        blob_count: blob_count.unwrap_or(0),
        total_size_bytes: bytes,
        total_size_mib: format!("{:.2} MiB", bytes as f64 / (1024.0 * 1024.0)),
      }
    })
    .collect();

  print_output(&display, json);
  Ok(())
}

async fn top(args: StorageTopArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let rows: Vec<(Uuid, String, Option<i64>, Option<i64>)> = sqlx::query_as(
    r#"SELECT w.id AS workspace_id, w.name AS workspace_name,
                  COUNT(b.key)::BIGINT AS blob_count,
                  COALESCE(SUM(b.size), 0)::BIGINT AS total_size_bytes
           FROM workspaces w
           LEFT JOIN blobs b ON b.workspace_id = w.id AND b.status = 'completed'
           WHERE w.deleted_at IS NULL
           GROUP BY w.id, w.name
           ORDER BY total_size_bytes DESC
           LIMIT $1"#,
  )
  .bind(args.n)
  .fetch_all(pool)
  .await?;

  let display: Vec<WorkspaceStorageRow> = rows
    .into_iter()
    .map(|(workspace_id, workspace_name, blob_count, total_size_bytes)| {
      let bytes = total_size_bytes.unwrap_or(0);
      WorkspaceStorageRow {
        workspace_id: workspace_id.to_string(),
        workspace_name,
        blob_count: blob_count.unwrap_or(0),
        total_size_bytes: bytes,
        total_size_mib: format!("{:.2} MiB", bytes as f64 / (1024.0 * 1024.0)),
      }
    })
    .collect();

  print_output(&display, json);
  Ok(())
}

async fn orphans(_pool: &PgPool, _json: bool) -> anyhow::Result<()> {
  anyhow::bail!(REFERENCE_TRACKING_REQUIRED)
}

async fn gc(_args: StorageGcArgs, _pool: &PgPool, _json: bool) -> anyhow::Result<()> {
  anyhow::bail!(REFERENCE_TRACKING_REQUIRED)
}

#[cfg(test)]
mod tests {
  use super::*;
  use sqlx::postgres::PgPoolOptions;

  fn lazy_pool() -> PgPool {
    PgPoolOptions::new()
      .connect_lazy("postgres://localhost/myoxus_cli_storage_safety_test")
      .expect("valid lazy test pool")
  }

  fn assert_reference_tracking_error(err: anyhow::Error) {
    let message = err.to_string();
    assert!(
      message.contains("disabled until authoritative blob reference tracking"),
      "unexpected error: {message}"
    );
    assert!(message.contains("no data was changed"), "unexpected error: {message}");
  }

  #[tokio::test]
  async fn orphan_detection_fails_closed_without_querying_the_database() {
    let pool = lazy_pool();
    assert_reference_tracking_error(
      orphans(&pool, false)
        .await
        .expect_err("orphan detection must be disabled"),
    );
  }

  #[tokio::test]
  async fn garbage_collection_fails_closed_in_every_compatibility_mode() {
    let pool = lazy_pool();
    let modes = [
      StorageGcArgs {
        dry_run: false,
        confirm: false,
      },
      StorageGcArgs {
        dry_run: true,
        confirm: false,
      },
      StorageGcArgs {
        dry_run: false,
        confirm: true,
      },
      StorageGcArgs {
        dry_run: true,
        confirm: true,
      },
    ];

    for args in modes {
      assert_reference_tracking_error(
        gc(args, &pool, false)
          .await
          .expect_err("garbage collection must be disabled"),
      );
    }
  }
}
