// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL due-state repository for automatic document history capture.

use super::edit_capture_state;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_application::document_version::{
  DocumentEditCaptureRepository, EditCaptureRunSummary, GlobalEditCaptureSettings,
};
use myoxus_domain::repositories::{RepoResult, RepositoryError};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use tracing::{instrument, warn};
use uuid::Uuid;
use yrs::{ReadTxn, Transact};

const MIN_INTERVAL_MS: i64 = 900_000;
const MAX_INTERVAL_MS: i64 = 86_400_000;

#[derive(Clone)]
pub struct PgDocumentEditCaptureRepository {
  pool: PgPool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureOutcome {
  Captured,
  Unchanged,
  Skipped,
}

impl PgDocumentEditCaptureRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn storage(error: sqlx::Error) -> RepositoryError {
    RepositoryError::Storage(error.to_string())
  }

  async fn materialize(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> RepoResult<(Vec<u8>, i64)> {
    let snapshot =
      sqlx::query("SELECT payload, last_sequence FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $2")
        .bind(workspace_id)
        .bind(doc_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::storage)?;
    let (payload, last_sequence) = snapshot
      .map(|row| (row.get::<Vec<u8>, _>("payload"), row.get::<i64, _>("last_sequence")))
      .unwrap_or_else(|| (Vec::new(), -1));
    let tail = sqlx::query(
      "SELECT sequence, payload FROM doc_updates
       WHERE workspace_id = $1 AND doc_id = $2 AND sequence > $3
       ORDER BY sequence ASC",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(last_sequence)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::storage)?;
    let revision = tail
      .last()
      .map(|row| row.get::<i64, _>("sequence"))
      .unwrap_or(last_sequence.max(0));
    let mut updates = Vec::with_capacity(tail.len() + usize::from(!payload.is_empty()));
    if !payload.is_empty() {
      updates.push(payload);
    }
    updates.extend(tail.into_iter().map(|row| row.get::<Vec<u8>, _>("payload")));
    let state = if updates.is_empty() {
      yrs::Doc::new().transact().encode_diff_v1(&yrs::StateVector::default())
    } else {
      yjs::merge_updates(updates).map_err(|_| RepositoryError::Storage("persisted Yjs state is invalid".to_string()))?
    };
    Ok((state, revision))
  }

  async fn record_failure(&self, workspace_id: Uuid, doc_id: Uuid, now: DateTime<Utc>) -> RepoResult<()> {
    sqlx::query(
      "UPDATE document_edit_capture_state
       SET retry_count = LEAST(retry_count + 1, 16),
           next_retry_at = $3 + make_interval(secs => LEAST(3600, 30 * (1 << LEAST(retry_count, 7)))),
           updated_at = $3
       WHERE workspace_id = $1 AND doc_id = $2",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(now)
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?;
    Ok(())
  }

  async fn capture_one(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    global: &GlobalEditCaptureSettings,
    now: DateTime<Utc>,
  ) -> RepoResult<CaptureOutcome> {
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    if edit_capture_state::try_lock_current_owner(&mut tx, doc_id)
      .await
      .map_err(Self::storage)?
      != Some(workspace_id)
    {
      return Ok(CaptureOutcome::Skipped);
    }
    let state = sqlx::query(
      "SELECT s.last_captured_content_hash, s.first_pending_at,
              s.configured_enabled, s.configured_interval_ms, s.lifecycle_active,
              COALESCE(w.edit_capture_enabled, $4) AS effective_enabled,
              GREATEST(COALESCE(w.edit_capture_interval_ms, $5), $6) AS effective_interval_ms,
              (d.deleted_at IS NULL AND NOT d.is_workspace_root AND d.id <> d.workspace_id
               AND d.external_id NOT LIKE 'db$%' AND d.external_id NOT LIKE 'userdata$%'
               AND COALESCE(e.state, 'legacy') <> 'deleted') AS effective_lifecycle_active
       FROM document_edit_capture_state s
       JOIN docs d ON d.workspace_id = s.workspace_id AND d.id = s.doc_id
       LEFT JOIN document_versioning_workspace_settings w ON w.workspace_id = s.workspace_id
       LEFT JOIN page_registration_evidence e
         ON e.workspace_id = d.workspace_id AND e.doc_id = d.id
       WHERE s.workspace_id = $1 AND s.doc_id = $2
         AND s.due_at <= $3
         AND (s.next_retry_at IS NULL OR s.next_retry_at <= $3)
       FOR UPDATE OF s",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(now)
    .bind(global.enabled)
    .bind(global.interval_ms.clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS))
    .bind(MIN_INTERVAL_MS)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage)?;
    let Some(state) = state else {
      tx.rollback().await.map_err(Self::storage)?;
      return Ok(CaptureOutcome::Skipped);
    };

    let enabled: bool = state.get("effective_enabled");
    let active: bool = state.get("effective_lifecycle_active");
    let interval_ms: i64 = state.get("effective_interval_ms");
    let configured_enabled = state.get::<Option<bool>, _>("configured_enabled");
    let configured_interval_ms = state.get::<Option<i64>, _>("configured_interval_ms");
    let lifecycle_active = state.get::<Option<bool>, _>("lifecycle_active");
    if configured_enabled != Some(enabled)
      || configured_interval_ms != Some(interval_ms)
      || lifecycle_active != Some(active)
      || !enabled
      || !active
    {
      edit_capture_state::rebind(&mut tx, workspace_id, doc_id, global, now)
        .await
        .map_err(Self::storage)?;
      tx.commit().await.map_err(Self::storage)?;
      return Ok(CaptureOutcome::Skipped);
    }

    let (snapshot, revision) = Self::materialize(&mut tx, workspace_id, doc_id).await?;
    let hash = Sha256::digest(&snapshot).to_vec();
    let prior_hash = state.get::<Option<Vec<u8>>, _>("last_captured_content_hash");
    let changed = prior_hash.as_deref() != Some(hash.as_slice());
    if changed {
      let history_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at, origin, actor_id, reference_workspace_id)
         VALUES ($1, $2, $3, $4, 'automatic', NULL, $2) RETURNING id",
      )
      .bind(doc_id)
      .bind(workspace_id)
      .bind(&snapshot)
      .bind(now)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::storage)?;
      crate::history_git_sync::record_history_capture(&mut tx, workspace_id, history_id)
        .await
        .map_err(Self::storage)?;
    }
    edit_capture_state::acknowledge(
      &mut tx,
      workspace_id,
      doc_id,
      revision,
      &hash,
      changed.then_some(now),
      now,
    )
    .await
    .map_err(Self::storage)?;
    tx.commit().await.map_err(Self::storage)?;
    Ok(if changed {
      CaptureOutcome::Captured
    } else {
      CaptureOutcome::Unchanged
    })
  }
}

#[async_trait]
impl DocumentEditCaptureRepository for PgDocumentEditCaptureRepository {
  #[instrument(skip(self, global), fields(global_enabled = global.enabled, global_interval_ms = global.interval_ms))]
  async fn reconcile(&self, global: &GlobalEditCaptureSettings, now: DateTime<Utc>, limit: i64) -> RepoResult<usize> {
    let global_interval = global.interval_ms.clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS);
    // Candidate discovery holds no row locks. Acquire every scoped document
    // lock first, then recheck ownership; busy documents wait for a later pass.
    let candidates = sqlx::query(
      "SELECT s.doc_id, MIN(s.updated_at) AS oldest
       FROM document_edit_capture_state s JOIN docs d ON d.id=s.doc_id
       LEFT JOIN document_versioning_workspace_settings w ON w.workspace_id=d.workspace_id
       LEFT JOIN page_registration_evidence e ON e.workspace_id=d.workspace_id AND e.doc_id=d.id
       WHERE s.workspace_id<>d.workspace_id OR (
         s.dirty_revision>COALESCE(s.last_captured_revision,-1) AND (
         s.configured_enabled IS DISTINCT FROM COALESCE(w.edit_capture_enabled,$1)
         OR s.configured_interval_ms IS DISTINCT FROM GREATEST(COALESCE(w.edit_capture_interval_ms,$2),$3)
         OR s.lifecycle_active IS DISTINCT FROM (d.deleted_at IS NULL AND NOT d.is_workspace_root
           AND d.id<>d.workspace_id AND d.external_id NOT LIKE 'db$%' AND d.external_id NOT LIKE 'userdata$%'
           AND COALESCE(e.state,'legacy')<>'deleted')
         OR (s.due_at IS NULL AND COALESCE(w.edit_capture_enabled,$1) AND d.deleted_at IS NULL
           AND NOT d.is_workspace_root AND d.id<>d.workspace_id AND d.external_id NOT LIKE 'db$%'
           AND d.external_id NOT LIKE 'userdata$%' AND COALESCE(e.state,'legacy')<>'deleted')))
       GROUP BY s.doc_id ORDER BY oldest,s.doc_id LIMIT $4",
    )
    .bind(global.enabled)
    .bind(global_interval)
    .bind(MIN_INTERVAL_MS)
    .bind(limit.max(1))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)?;
    let mut repaired = 0;
    for row in candidates {
      let doc_id: Uuid = row.get("doc_id");
      let mut tx = self.pool.begin().await.map_err(Self::storage)?;
      let Some(owner) = edit_capture_state::try_lock_current_owner(&mut tx, doc_id)
        .await
        .map_err(Self::storage)?
      else {
        continue;
      };
      if edit_capture_state::rebind(&mut tx, owner, doc_id, global, now)
        .await
        .map_err(Self::storage)?
      {
        repaired += 1;
      }
      tx.commit().await.map_err(Self::storage)?;
    }
    Ok(repaired)
  }

  #[instrument(skip(self))]
  async fn capture_due(
    &self,
    global: &GlobalEditCaptureSettings,
    now: DateTime<Utc>,
    limit: i64,
  ) -> RepoResult<EditCaptureRunSummary> {
    let candidates = sqlx::query(
      "SELECT s.workspace_id, s.doc_id
       FROM document_edit_capture_state s JOIN docs d ON d.id=s.doc_id AND d.workspace_id=s.workspace_id
       WHERE s.due_at <= $1 AND (s.next_retry_at IS NULL OR s.next_retry_at <= $1)
       ORDER BY s.due_at, s.workspace_id, s.doc_id
       LIMIT $2",
    )
    .bind(now)
    .bind(limit.max(1))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)?;
    let mut summary = EditCaptureRunSummary::default();
    for row in candidates {
      let workspace_id = row.get("workspace_id");
      let doc_id = row.get("doc_id");
      summary.examined += 1;
      match self.capture_one(workspace_id, doc_id, global, now).await {
        Ok(CaptureOutcome::Captured) => summary.captured += 1,
        Ok(CaptureOutcome::Unchanged) => summary.unchanged += 1,
        Ok(CaptureOutcome::Skipped) => summary.skipped += 1,
        Err(error) => {
          summary.failed += 1;
          warn!(%workspace_id, %doc_id, %error, "automatic document history capture failed; retry retained");
          self.record_failure(workspace_id, doc_id, now).await?;
        }
      }
    }
    Ok(summary)
  }

  async fn record_heartbeat(&self, now: DateTime<Utc>) -> RepoResult<()> {
    sqlx::query(
      "INSERT INTO document_edit_capture_runtime (singleton, last_poll_at)
       VALUES (true, $1)
       ON CONFLICT (singleton) DO UPDATE SET last_poll_at = EXCLUDED.last_poll_at",
    )
    .bind(now)
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?;
    Ok(())
  }
}
