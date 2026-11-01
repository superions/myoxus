// SPDX-License-Identifier: AGPL-3.0-or-later
//! SQL history expiration never owns operational bindings, fences or receipts
//! for an unfinished publication. Every batch rechecks ownership under the same
//! profile row lock used by run and lifecycle admission.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use sqlx::{Postgres, Transaction};

use super::*;

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncHistoryCleanupBatch {
  pub deleted: BTreeMap<String, u64>,
  pub protected_profiles: u64,
  pub busy_profiles: u64,
}

impl GitSyncHistoryCleanupBatch {
  pub fn deleted_rows(&self) -> u64 {
    self.deleted.values().sum()
  }
}

impl SqlxGitSyncStore {
  /// Keyset inventory includes disabled profiles and needs no mirror presence.
  pub async fn history_cleanup_profile_ids(&self, after: Option<Uuid>) -> GitSyncResult<Vec<Uuid>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("SET LOCAL statement_timeout = '1000ms'")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let ids =
      sqlx::query_scalar("SELECT id FROM git_sync_profiles WHERE $1::uuid IS NULL OR id>$1 ORDER BY id LIMIT 1000")
        .bind(after)
        .fetch_all(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(ids)
  }

  /// One database-time cutoff for the entire nightly pass, not one per table.
  pub async fn history_retention_cutoff(&self, days: u32) -> GitSyncResult<DateTime<Utc>> {
    if !(1..=30).contains(&days) {
      return Err(GitSyncStoreError::Validation(
        "git_sync.retention_days must be in 1..=30".into(),
      ));
    }
    sqlx::query_scalar("SELECT CURRENT_TIMESTAMP - make_interval(days => $1)")
      .bind(days as i32)
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  /// Delete at most `limit` auxiliary rows, without allowing parent cascades to
  /// remove retained children. Busy or recovery-owned profiles are skipped.
  #[instrument(skip(self), fields(%profile_id, %cutoff))]
  pub async fn cleanup_auxiliary_history(
    &self,
    profile_id: Uuid,
    cutoff: DateTime<Utc>,
    limit: u32,
  ) -> GitSyncResult<GitSyncHistoryCleanupBatch> {
    let mut report = GitSyncHistoryCleanupBatch::default();
    let Some(mut tx) = self.begin_history_cleanup(profile_id, limit, &mut report).await? else {
      return Ok(report);
    };
    // Each static query binds the same profile/cutoff/remaining batch budget.
    // Run references retain newer or uncertain work, but not an old last-run
    // summary's already-expired provenance.
    for (kind, query) in AUXILIARY_DELETES {
      let remaining = u64::from(limit).saturating_sub(report.deleted_rows());
      if remaining == 0 {
        break;
      }
      let deleted = sqlx::query(query)
        .bind(profile_id)
        .bind(cutoff)
        .bind(remaining as i64)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .rows_affected();
      report.deleted.insert((*kind).into(), deleted);
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(report)
  }

  /// Auxiliary cleanup must precede this pass. Every retained child, including
  /// a newer child of an old run, blocks parent deletion independently of FKs.
  #[instrument(skip(self), fields(%profile_id, %cutoff))]
  pub async fn cleanup_terminal_runs(
    &self,
    profile_id: Uuid,
    cutoff: DateTime<Utc>,
    limit: u32,
  ) -> GitSyncResult<GitSyncHistoryCleanupBatch> {
    let mut report = GitSyncHistoryCleanupBatch::default();
    let Some(mut tx) = self.begin_history_cleanup(profile_id, limit, &mut report).await? else {
      return Ok(report);
    };
    // Last-run summaries survive, but their expired provenance is not an
    // unbounded archive. Recovery references protect both summary and links.
    let links = format!(
      "{EXPIRED_UNREFERENCED_RUNS}
      DELETE FROM git_sync_version_links WHERE id IN (
        SELECT v.id FROM git_sync_version_links v JOIN expired r ON r.id=v.run_id
        WHERE v.profile_id=$1 AND v.created_at<$2 ORDER BY v.created_at,v.id LIMIT $3)"
    );
    let deleted = sqlx::query(&links)
      .bind(profile_id)
      .bind(cutoff)
      .bind(i64::from(limit))
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .rows_affected();
    report.deleted.insert("versionLinks".into(), deleted);
    let remaining = u64::from(limit) - deleted;
    if remaining > 0 {
      let runs = format!(
        "{EXPIRED_UNREFERENCED_RUNS}
        DELETE FROM git_sync_runs WHERE id IN (
          SELECT r.id FROM expired r
          WHERE r.id<>(SELECT id FROM git_sync_runs WHERE profile_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1)
            AND NOT EXISTS(SELECT 1 FROM git_sync_version_links v WHERE v.run_id=r.id)
          ORDER BY r.finished_at,r.id LIMIT $3)"
      );
      let deleted = sqlx::query(&runs)
        .bind(profile_id)
        .bind(cutoff)
        .bind(remaining as i64)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .rows_affected();
      report.deleted.insert("runs".into(), deleted);
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(report)
  }

  async fn begin_history_cleanup(
    &self,
    profile_id: Uuid,
    limit: u32,
    report: &mut GitSyncHistoryCleanupBatch,
  ) -> GitSyncResult<Option<Transaction<'_, Postgres>>> {
    if !(1..=1_000).contains(&limit) {
      return Err(GitSyncStoreError::Validation(
        "Git-Sync cleanup batch must be in 1..=1000".into(),
      ));
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("SET LOCAL statement_timeout = '1000ms'")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query("SET LOCAL lock_timeout = '100ms'")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let locked = sqlx::query_scalar::<_, Uuid>("SELECT id FROM git_sync_profiles WHERE id=$1 FOR UPDATE SKIP LOCKED")
      .bind(profile_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    if locked.is_none() {
      report.busy_profiles = 1;
      return Ok(None);
    }
    let protected: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM git_sync_runs WHERE profile_id=$1
         AND (status IN ('Pending','Running') OR reconciliation_required))
       OR EXISTS(SELECT 1 FROM git_sync_bootstrap_attempts WHERE profile_id=$1
         AND (phase IN ('Prepared','RemoteApplied') OR (phase='Failed' AND observed_remote_oid IS NOT NULL)))
       OR EXISTS(SELECT 1 FROM git_sync_blob_promotions WHERE profile_id=$1)
       OR EXISTS(SELECT 1 FROM workspace_content_extract_targets e
         JOIN git_sync_profiles p ON p.id=$1
         WHERE e.git_sync_pending AND (e.target_workspace_id=p.workspace_id
           OR e.git_sync_plan->>'sourceProfileId'=p.id::text))",
    )
    .bind(profile_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if protected {
      report.protected_profiles = 1;
      return Ok(None);
    }
    Ok(Some(tx))
  }
}

// No cascade is used as a retention decision. The auxiliary pass must have
// explicitly removed every eligible child first; non-FK receipt references
// matter just as much as RESTRICT/CASCADE/SET NULL references.
const EXPIRED_UNREFERENCED_RUNS: &str = "WITH expired AS (
  SELECT r.id,r.finished_at FROM git_sync_runs r WHERE r.profile_id=$1
    AND r.status IN ('Completed','Failed','Cancelled') AND r.finished_at<$2
    AND NOT r.reconciliation_required
    AND NOT EXISTS(SELECT 1 FROM git_sync_file_conflicts c WHERE c.run_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM git_sync_partial_sessions s WHERE r.id IN (s.created_run_id,s.last_run_id))
    AND NOT EXISTS(SELECT 1 FROM git_sync_partial_items i WHERE i.last_run_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM git_sync_history_capture_receipts c WHERE c.assigned_run_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM git_sync_blob_promotions b WHERE b.run_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM git_sync_webhook_deliveries w WHERE w.run_id=r.id)
)";

const AUXILIARY_DELETES: &[(&str, &str)] = &[
  (
    "documentConflicts",
    "DELETE FROM git_sync_conflicts WHERE id IN (
    SELECT id FROM git_sync_conflicts WHERE profile_id=$1 AND resolution<>'Open'
      AND resolved_at<$2 ORDER BY resolved_at,id LIMIT $3)",
  ),
  (
    "fileConflicts",
    "DELETE FROM git_sync_file_conflicts WHERE id IN (
    SELECT c.id FROM git_sync_file_conflicts c WHERE c.profile_id=$1 AND c.resolution<>'Open'
      AND c.resolved_at<$2 AND NOT EXISTS(SELECT 1 FROM git_sync_runs r WHERE r.id=c.run_id
        AND (r.status NOT IN ('Completed','Failed','Cancelled') OR r.finished_at IS NULL
          OR r.finished_at>=$2 OR r.reconciliation_required))
    ORDER BY c.resolved_at,c.id LIMIT $3)",
  ),
  (
    "partialItems",
    "DELETE FROM git_sync_partial_items WHERE id IN (
    SELECT i.id FROM git_sync_partial_items i JOIN git_sync_partial_sessions s ON s.id=i.session_id
    WHERE i.profile_id=$1 AND s.status IN ('Completed','CompletedWithFailures','Cancelled')
      AND COALESCE(s.completed_at,s.updated_at)<$2
      AND i.status IN ('Completed','Failed','Conflicted') AND i.updated_at<$2
      AND NOT EXISTS(SELECT 1 FROM git_sync_runs r WHERE r.id IN (s.created_run_id,s.last_run_id,i.last_run_id)
        AND (r.status NOT IN ('Completed','Failed','Cancelled') OR r.finished_at IS NULL
          OR r.finished_at>=$2 OR r.reconciliation_required))
    ORDER BY i.updated_at,i.id LIMIT $3)",
  ),
  (
    "partialSessions",
    "DELETE FROM git_sync_partial_sessions WHERE id IN (
    SELECT s.id FROM git_sync_partial_sessions s WHERE s.profile_id=$1
      AND s.status IN ('Completed','CompletedWithFailures','Cancelled')
      AND COALESCE(s.completed_at,s.updated_at)<$2
      AND NOT EXISTS(SELECT 1 FROM git_sync_partial_items i WHERE i.session_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM git_sync_runs r WHERE r.id IN (s.created_run_id,s.last_run_id)
        AND (r.status NOT IN ('Completed','Failed','Cancelled') OR r.finished_at IS NULL
          OR r.finished_at>=$2 OR r.reconciliation_required))
    ORDER BY COALESCE(s.completed_at,s.updated_at),s.id LIMIT $3)",
  ),
  (
    "bootstrapAttempts",
    "DELETE FROM git_sync_bootstrap_attempts WHERE id IN (
    SELECT id FROM git_sync_bootstrap_attempts WHERE profile_id=$1
      AND (phase='Completed' OR (phase='Failed' AND observed_remote_oid IS NULL))
      AND COALESCE(completed_at,updated_at)<$2
    ORDER BY COALESCE(completed_at,updated_at),id LIMIT $3)",
  ),
  (
    "webhookReceipts",
    "DELETE FROM git_sync_webhook_deliveries WHERE id IN (
    SELECT w.id FROM git_sync_webhook_deliveries w WHERE w.profile_id=$1 AND w.received_at<$2
      AND ((NOT w.accepted AND w.rejection_reason IS NOT NULL AND w.run_id IS NULL)
        OR EXISTS(SELECT 1 FROM git_sync_runs r WHERE r.id=w.run_id
          AND r.status IN ('Completed','Failed','Cancelled') AND r.finished_at<$2 AND NOT r.reconciliation_required))
    ORDER BY w.received_at,w.id LIMIT $3)",
  ),
  (
    "captureReceipts",
    "DELETE FROM git_sync_history_capture_receipts WHERE (profile_id,history_id) IN (
    SELECT c.profile_id,c.history_id FROM git_sync_history_capture_receipts c
    WHERE c.profile_id=$1 AND c.created_at<$2 AND COALESCE(c.discarded_at,c.assigned_at,c.created_at)<$2
      AND ((c.discarded_at<$2 AND c.assigned_run_id IS NULL)
        OR EXISTS(SELECT 1 FROM git_sync_runs r WHERE r.id=c.assigned_run_id
          AND r.status IN ('Completed','Failed','Cancelled') AND r.finished_at<$2 AND NOT r.reconciliation_required))
    ORDER BY c.created_at,c.history_id LIMIT $3)",
  ),
];
