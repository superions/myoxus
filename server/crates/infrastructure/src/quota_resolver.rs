// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared workspace storage quota resolution for the infrastructure layer.
//!
//! Provides a single function [`resolve_effective_quota`] that encapsulates
//! the workspace query and priority chain defined
//! in [`myoxus_application::quota::effective_quota_bytes`]:
//!
//! 1. `workspaces.storage_quota_bytes` (workspace-level override)
//! 2. `config_default_mb` (server config, non-zero)
//! 3. 0 = unlimited
//!
//! ## Why a shared module?
//!
//! This module centralises quota resolution so blob, document, and workspace
//! publication enforcement use the same workspace-owned policy.
//!
//! ## Caching contract
//!
//! The cache layer (`QuotaCache`) sits **above** this function: callers try the
//! cache first and only call `resolve_effective_quota` on a cache miss.  The
//! resolved value is then written back to the cache by the caller.

use sqlx::{PgPool, Row};
use tracing::{debug, instrument, trace, warn};
use uuid::Uuid;

// ─── WorkspaceQuotaSnapshot ───────────────────────────────────────────────────

/// Full quota state snapshot for a single workspace.
///
/// Combines raw DB values, computed effective quota, and usage into a single
/// struct so callers (GraphQL resolvers) can present all quota fields without
/// any additional round-trips.
///
/// `None` on `workspace_override_bytes` means the column is NULL.
/// A value of `0` on `effective_bytes` means unlimited.
#[derive(Debug, Clone)]
pub struct WorkspaceQuotaSnapshot {
  /// `workspaces.storage_quota_bytes` — workspace-level override (NULL if unset).
  pub workspace_override_bytes: Option<i64>,
  /// `workspace_storage_stats.snapshot_size` (bytes, 0 if not tracked).
  pub snapshot_bytes: i64,
  /// `workspace_storage_stats.blob_size` (bytes, 0 if not tracked).
  pub blob_bytes: i64,
  /// Resolved effective quota in bytes (0 = unlimited), following the three-level hierarchy.
  pub effective_bytes: i64,
  /// The config default that was used for resolution (MB, 0 = unlimited at config level).
  pub config_default_mb: u64,
}

impl WorkspaceQuotaSnapshot {
  /// Total current usage in bytes (snapshot + blob).
  #[inline]
  pub fn used_bytes(&self) -> i64 {
    self.snapshot_bytes.saturating_add(self.blob_bytes).max(0)
  }
}

/// Resolve a full [`WorkspaceQuotaSnapshot`] for a workspace in a single DB round-trip.
///
/// Fetches workspace-level override and storage usage in one query, then applies the resolution
/// hierarchy to produce [`WorkspaceQuotaSnapshot::effective_bytes`].
///
/// Returns `None` if the workspace does not exist.
/// On DB error, logs a warning and returns `None`.
///
/// # Arguments
///
/// * `pool` — PostgreSQL connection pool.
/// * `workspace_id` — The workspace to snapshot.
/// * `default_workspace_quota_mb` — Config default in MB (0 = unlimited).
#[instrument(skip(pool), level = "debug")]
pub async fn resolve_workspace_quota_full(
  pool: &PgPool,
  workspace_id: Uuid,
  default_workspace_quota_mb: u64,
) -> Option<WorkspaceQuotaSnapshot> {
  trace!(
    workspace_id = %workspace_id,
    default_workspace_quota_mb,
    "resolve_workspace_quota_full: starting"
  );

  let result = sqlx::query(
    r#"
    SELECT
        w.storage_quota_bytes                   AS workspace_quota_bytes,
        COALESCE(s.snapshot_size, 0)::BIGINT    AS snapshot_bytes,
        COALESCE(s.blob_size,    0)::BIGINT     AS blob_bytes
    FROM workspaces w
    LEFT JOIN workspace_storage_stats s ON s.workspace_id = w.id
    WHERE w.id = $1 AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
    "#,
  )
  .bind(workspace_id)
  .fetch_optional(pool)
  .await;

  match result {
    Ok(Some(row)) => {
      let workspace_override: Option<i64> = row.get("workspace_quota_bytes");
      let snapshot_bytes: i64 = row.get("snapshot_bytes");
      let blob_bytes: i64 = row.get("blob_bytes");
      let effective = myoxus_application::quota::effective_quota_bytes(workspace_override, default_workspace_quota_mb);

      debug!(
        workspace_id = %workspace_id,
        workspace_override = ?workspace_override,
        config_default_mb = default_workspace_quota_mb,
        effective_bytes = effective,
        snapshot_bytes,
        blob_bytes,
        "resolve_workspace_quota_full: snapshot resolved"
      );

      Some(WorkspaceQuotaSnapshot {
        workspace_override_bytes: workspace_override,
        snapshot_bytes,
        blob_bytes,
        effective_bytes: effective as i64,
        config_default_mb: default_workspace_quota_mb,
      })
    }
    Ok(None) => {
      warn!(workspace_id = %workspace_id, "resolve_workspace_quota_full: workspace not found");
      None
    }
    Err(err) => {
      warn!(
        workspace_id = %workspace_id,
        error = %err,
        "resolve_workspace_quota_full: DB error"
      );
      None
    }
  }
}

/// Resolve the effective storage quota for a workspace.
///
/// Returns the effective quota in **bytes** (0 = unlimited).
///
/// On database error, logs a warning and returns the config default (converted
/// to bytes) rather than propagating the error — quota enforcement must not
/// prevent uploads when the DB is temporarily unreachable.
///
/// # Arguments
///
/// * `pool` — PostgreSQL connection pool.
/// * `workspace_id` — The workspace to resolve quota for.
/// * `config_default_mb` — Global workspace default in MB.
#[instrument(skip(pool), level = "debug")]
pub async fn resolve_effective_quota(pool: &PgPool, workspace_id: Uuid, config_default_mb: u64) -> u64 {
  trace!(workspace_id = %workspace_id, config_default_mb, "resolving effective quota");

  let result = sqlx::query(
    r#"
    SELECT
        w.storage_quota_bytes AS workspace_quota_bytes
    FROM workspaces w
    WHERE w.id = $1 AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
    "#,
  )
  .bind(workspace_id)
  .fetch_optional(pool)
  .await;

  match result {
    Ok(Some(row)) => {
      let ws_quota: Option<i64> = row.get("workspace_quota_bytes");
      let effective = myoxus_application::quota::effective_quota_bytes(ws_quota, config_default_mb);
      debug!(
        workspace_id = %workspace_id,
        ws_quota = ?ws_quota,
        config_default_mb,
        effective_bytes = effective,
        "quota resolved"
      );
      effective
    }
    Ok(None) => {
      // Workspace not found — treat as unlimited so we don't block writes.
      warn!(workspace_id = %workspace_id, "resolve_effective_quota: workspace not found, treating as unlimited");
      0
    }
    Err(err) => {
      warn!(
        workspace_id = %workspace_id,
        error = %err,
        "resolve_effective_quota: DB error, falling back to config default"
      );
      // Graceful degradation: fall back to config default.
      if config_default_mb > 0 {
        config_default_mb * 1024 * 1024
      } else {
        0
      }
    }
  }
}

/// Fetch current storage usage for a workspace from `workspace_storage_stats`.
///
/// Returns `(snapshot_bytes, blob_bytes)`. Both default to 0 if the row does
/// not exist yet.  On DB error, logs a warning and returns `(0, 0)` — the
/// caller falls back to an unlocked / best-effort quota check.
#[instrument(skip(pool), level = "debug")]
pub async fn get_workspace_usage(pool: &PgPool, workspace_id: Uuid) -> (u64, u64) {
  let result = sqlx::query(
    r#"
    SELECT
        COALESCE(snapshot_size, 0) AS snapshot_bytes,
        COALESCE(blob_size, 0)     AS blob_bytes
    FROM workspace_storage_stats
    WHERE workspace_id = $1
    "#,
  )
  .bind(workspace_id)
  .fetch_optional(pool)
  .await;

  match result {
    Ok(Some(row)) => {
      let snapshot: i64 = row.get("snapshot_bytes");
      let blob: i64 = row.get("blob_bytes");
      (snapshot.max(0) as u64, blob.max(0) as u64)
    }
    Ok(None) => (0, 0),
    Err(err) => {
      warn!(workspace_id = %workspace_id, error = %err, "get_workspace_usage: DB error, returning (0, 0)");
      (0, 0)
    }
  }
}

#[cfg(test)]
mod tests {

  use myoxus_application::quota::effective_quota_bytes;

  /// Unit test: effective_quota_bytes covers our resolution logic.
  /// Integration tests against real DB are in crates/api/tests/inv_workspace_quota_test.rs.
  #[test]
  fn effective_quota_bytes_workspace_wins() {
    assert_eq!(effective_quota_bytes(Some(100), 300), 100);
  }

  #[test]
  fn effective_quota_bytes_config_wins_when_no_overrides() {
    assert_eq!(effective_quota_bytes(None, 512), 512 * 1024 * 1024);
  }

  #[test]
  fn effective_quota_bytes_unlimited_when_all_zero() {
    assert_eq!(effective_quota_bytes(None, 0), 0);
  }
}
