// SPDX-License-Identifier: AGPL-3.0-or-later
//! Transaction-local capture bookkeeping. Callers hold all affected scoped
//! document advisory locks before touching document or intent rows.

use chrono::{DateTime, Duration, Utc};
use myoxus_application::document_version::{GlobalEditCaptureSettings, normalize_legacy_edit_capture_interval};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub(crate) fn lock_key(workspace_id: Uuid, doc_id: Uuid) -> String {
  format!("workspace-document:{workspace_id}:{doc_id}")
}

/// Discovery takes no row lock. Revalidate after acquiring all old/current
/// scoped locks; a busy or concurrently moved identity waits for another pass.
pub(crate) async fn try_lock_current_owner(
  tx: &mut Transaction<'_, Postgres>,
  doc: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
  let owner: Option<Uuid> = sqlx::query_scalar("SELECT workspace_id FROM docs WHERE id=$1")
    .bind(doc)
    .fetch_optional(&mut **tx)
    .await?;
  let Some(owner) = owner else {
    return Ok(None);
  };
  let mut scopes =
    sqlx::query_scalar::<_, Uuid>("SELECT workspace_id FROM document_edit_capture_state WHERE doc_id=$1")
      .bind(doc)
      .fetch_all(&mut **tx)
      .await?;
  scopes.push(owner);
  scopes.sort();
  scopes.dedup();
  for scope in &scopes {
    if !sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(lock_key(*scope, doc))
      .fetch_one(&mut **tx)
      .await?
    {
      return Ok(None);
    }
  }
  let current: Option<Uuid> = sqlx::query_scalar("SELECT workspace_id FROM docs WHERE id=$1 FOR UPDATE")
    .bind(doc)
    .fetch_optional(&mut **tx)
    .await?;
  if current != Some(owner) {
    return Ok(None);
  }
  let current_scopes =
    sqlx::query_scalar::<_, Uuid>("SELECT workspace_id FROM document_edit_capture_state WHERE doc_id=$1")
      .bind(doc)
      .fetch_all(&mut **tx)
      .await?;
  Ok(
    current_scopes
      .iter()
      .all(|scope| scopes.contains(scope))
      .then_some(owner),
  )
}

pub(crate) async fn eligible(
  tx: &mut Transaction<'_, Postgres>,
  workspace: Uuid,
  doc: Uuid,
) -> Result<bool, sqlx::Error> {
  sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM docs d LEFT JOIN page_registration_evidence e
    ON e.workspace_id=d.workspace_id AND e.doc_id=d.id WHERE d.workspace_id=$1 AND d.id=$2
    AND d.deleted_at IS NULL AND NOT d.is_workspace_root AND d.id<>d.workspace_id
    AND d.external_id NOT LIKE 'db$%' AND d.external_id NOT LIKE 'userdata$%'
    AND COALESCE(e.state,'legacy')<>'deleted')",
  )
  .bind(workspace)
  .bind(doc)
  .fetch_one(&mut **tx)
  .await
}

pub(crate) async fn mark_dirty(
  tx: &mut Transaction<'_, Postgres>,
  workspace: Uuid,
  doc: Uuid,
  revision: i64,
) -> Result<bool, sqlx::Error> {
  if !eligible(tx, workspace, doc).await? {
    return Ok(false);
  }
  sqlx::query(
    "INSERT INTO document_edit_capture_state
    (workspace_id,doc_id,dirty_revision,first_pending_at,updated_at) VALUES($1,$2,$3,now(),now())
    ON CONFLICT(workspace_id,doc_id) DO UPDATE SET
    dirty_revision=GREATEST(document_edit_capture_state.dirty_revision,EXCLUDED.dirty_revision),
    first_pending_at=CASE WHEN document_edit_capture_state.configured_enabled IS TRUE
      AND document_edit_capture_state.lifecycle_active IS TRUE
      THEN COALESCE(document_edit_capture_state.first_pending_at,now())
      ELSE document_edit_capture_state.first_pending_at END, updated_at=now()",
  )
  .bind(workspace)
  .bind(doc)
  .bind(revision)
  .execute(&mut **tx)
  .await?;
  Ok(true)
}

pub(crate) async fn acknowledge(
  tx: &mut Transaction<'_, Postgres>,
  workspace: Uuid,
  doc: Uuid,
  revision: i64,
  hash: &[u8],
  automatic_at: Option<DateTime<Utc>>,
  now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
  sqlx::query(
    "UPDATE document_edit_capture_state SET dirty_revision=GREATEST(dirty_revision,$3),
    last_captured_revision=$3,last_captured_content_hash=$4,
    last_capture_at=COALESCE($5,last_capture_at),first_pending_at=NULL,due_at=NULL,
    retry_count=0,next_retry_at=NULL,updated_at=$6 WHERE workspace_id=$1 AND doc_id=$2",
  )
  .bind(workspace)
  .bind(doc)
  .bind(revision)
  .bind(hash)
  .bind(automatic_at)
  .bind(now)
  .execute(&mut **tx)
  .await?;
  Ok(())
}

/// Resolve the same supported policy as workspace settings, inside the ownership
/// transaction. Unknown acknowledgements stay unknown; repair never reads the
/// current content revision or manufactures a captured revision.
pub(crate) async fn rebind(
  tx: &mut Transaction<'_, Postgres>,
  workspace: Uuid,
  doc: Uuid,
  global: &GlobalEditCaptureSettings,
  now: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
  let owner: Option<Uuid> = sqlx::query_scalar("SELECT workspace_id FROM docs WHERE id=$1 FOR UPDATE")
    .bind(doc)
    .fetch_optional(&mut **tx)
    .await?;
  if owner != Some(workspace) {
    return Ok(false);
  }
  let rows = sqlx::query("SELECT * FROM document_edit_capture_state WHERE doc_id=$1 ORDER BY workspace_id FOR UPDATE")
    .bind(doc)
    .fetch_all(&mut **tx)
    .await?;
  if rows.is_empty() {
    return Ok(false);
  }
  let policy=sqlx::query("SELECT edit_capture_enabled,edit_capture_interval_ms FROM document_versioning_workspace_settings WHERE workspace_id=$1")
    .bind(workspace).fetch_optional(&mut **tx).await?;
  let enabled = policy
    .as_ref()
    .and_then(|r| r.get::<Option<bool>, _>("edit_capture_enabled"))
    .unwrap_or(global.enabled);
  let raw_interval = policy
    .as_ref()
    .and_then(|r| r.get::<Option<i64>, _>("edit_capture_interval_ms"))
    .unwrap_or(global.interval_ms);
  let interval = normalize_legacy_edit_capture_interval(raw_interval)
    .map_err(|_| sqlx::Error::Protocol("invalid automatic capture interval".into()))?
    .0;
  let active = eligible(tx, workspace, doc).await?;
  let dirty = rows.iter().map(|r| r.get::<i64, _>("dirty_revision")).max().unwrap();
  // Select an acknowledgement as a pair, never independently maximize its
  // hash. A null acknowledgement cannot be promoted to the current revision.
  let acknowledgement = rows
    .iter()
    .filter(|r| r.get::<Option<i64>, _>("last_captured_revision").is_some())
    .max_by_key(|r| {
      (
        r.get::<Option<i64>, _>("last_captured_revision"),
        r.get::<DateTime<Utc>, _>("updated_at"),
        r.get::<Uuid, _>("workspace_id"),
      )
    });
  let captured = acknowledgement.and_then(|r| r.get::<Option<i64>, _>("last_captured_revision"));
  let hash = acknowledgement.and_then(|r| r.get::<Option<Vec<u8>>, _>("last_captured_content_hash"));
  let last_capture = rows
    .iter()
    .filter_map(|r| r.get::<Option<DateTime<Utc>>, _>("last_capture_at"))
    .max();
  let pending = dirty > captured.unwrap_or(-1);
  let runnable = enabled && active && pending;
  let pending_rows = rows
    .iter()
    .filter(|r| r.get::<i64, _>("dirty_revision") > r.get::<Option<i64>, _>("last_captured_revision").unwrap_or(-1))
    .collect::<Vec<_>>();
  // Settings can change between polling passes. An old owner's fresh disable
  // must break continuity even if its cached configured flag still says true.
  let scopes = rows
    .iter()
    .map(|r| r.get::<Uuid, _>("workspace_id"))
    .collect::<Vec<_>>();
  let enabled_scopes = sqlx::query_scalar::<_, Uuid>(
    "SELECT w.id FROM workspaces w
    LEFT JOIN document_versioning_workspace_settings s ON s.workspace_id=w.id
    WHERE w.id=ANY($1) AND COALESCE(s.edit_capture_enabled,$2)",
  )
  .bind(&scopes)
  .bind(global.enabled)
  .fetch_all(&mut **tx)
  .await?;
  let continuous = pending_rows.iter().all(|r| {
    enabled_scopes.contains(&r.get::<Uuid, _>("workspace_id"))
      && ((r.get::<Option<bool>, _>("configured_enabled") == Some(true)
        && r.get::<Option<bool>, _>("lifecycle_active") == Some(true))
        || (r.get::<Option<bool>, _>("configured_enabled").is_none()
          && r.get::<Option<bool>, _>("lifecycle_active").is_none()))
  });
  let anchor = runnable.then(|| {
    if continuous {
      pending_rows
        .iter()
        .filter_map(|r| r.get::<Option<DateTime<Utc>>, _>("first_pending_at"))
        .min()
        .unwrap_or(now)
    } else {
      now
    }
  });
  sqlx::query("DELETE FROM document_edit_capture_state WHERE doc_id=$1 AND workspace_id<>$2")
    .bind(doc)
    .bind(workspace)
    .execute(&mut **tx)
    .await?;
  sqlx::query("INSERT INTO document_edit_capture_state
    (workspace_id,doc_id,dirty_revision,last_captured_revision,last_captured_content_hash,last_capture_at,
     first_pending_at,due_at,configured_enabled,configured_interval_ms,lifecycle_active,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(workspace_id,doc_id) DO UPDATE SET dirty_revision=EXCLUDED.dirty_revision,
    last_captured_revision=EXCLUDED.last_captured_revision,last_captured_content_hash=EXCLUDED.last_captured_content_hash,
    last_capture_at=EXCLUDED.last_capture_at,first_pending_at=EXCLUDED.first_pending_at,due_at=EXCLUDED.due_at,
    configured_enabled=EXCLUDED.configured_enabled,configured_interval_ms=EXCLUDED.configured_interval_ms,
    lifecycle_active=EXCLUDED.lifecycle_active,retry_count=0,next_retry_at=NULL,updated_at=EXCLUDED.updated_at")
    .bind(workspace).bind(doc).bind(dirty).bind(captured).bind(hash).bind(last_capture)
    .bind(anchor).bind(anchor.map(|a| a+Duration::milliseconds(interval))).bind(enabled).bind(interval).bind(active).bind(now)
    .execute(&mut **tx).await?;
  Ok(true)
}
