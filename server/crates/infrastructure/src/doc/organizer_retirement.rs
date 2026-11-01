// SPDX-License-Identifier: AGPL-3.0-or-later
//! Final removal of Organizer links to permanently deleted document identities.

use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::doc::PageLifecycleDelta;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::{SqlxDocStore, workspace_document_lock_key};

impl SqlxDocStore {
  async fn permanently_deleted_organizer_keys_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
  ) -> AuthResult<Vec<String>> {
    sqlx::query_scalar(
      "SELECT key FROM page_registration_evidence e
       CROSS JOIN LATERAL (VALUES (e.external_id), (e.doc_id::text)) keys(key)
       WHERE e.workspace_id=$1 AND e.state='deleted'
       AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.workspace_id=$1
         AND (d.external_id=e.external_id OR d.id=e.doc_id))
       ORDER BY key",
    )
    .bind(workspace_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_db_err)
  }

  pub(super) async fn retire_deleted_organizer_links_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    organizer_id: Uuid,
  ) -> AuthResult<Option<PageLifecycleDelta>> {
    let keys = Self::permanently_deleted_organizer_keys_in_tx(tx, workspace_id).await?;
    if keys.is_empty() {
      return Ok(None);
    }
    let payload = Self::load_full_doc_in_tx(tx, workspace_id, organizer_id).await?;
    let removal = myoxus_application::organizer::remove_document_links(&payload, workspace_id, workspace_id, &keys)
      .map_err(|error| {
        tracing::error!(%workspace_id, %organizer_id, error_kind=error.diagnostic_kind(), phase="permanent_delete_cleanup", "document_delete.organizer_cleanup_failed");
        AuthError::Storage("DOC_DELETE_ORGANIZER_DECODE_FAILED: deleted folder references could not be normalized".into())
      })?;
    if removal.update.is_empty() {
      return Ok(None);
    }
    tracing::debug!(%workspace_id, %organizer_id, removed_entries=removal.entry_ids.len(), "document_delete.organizer_deleted_links_projected");
    Self::append_lifecycle_delta(tx, workspace_id, organizer_id, removal.update)
      .await
      .map(Some)
  }

  /// Remove old references automatically. No preview, operator approval or
  /// restoration: confirmed deleted identities remain deleted. Trash, Move and
  /// a merely absent SQL row are deliberately not permanent-delete evidence.
  pub async fn purge_workspace_deleted_organizer_links(&self, workspace_id: Uuid) -> AuthResult<bool> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // Conflict with a concurrent identity transfer back, not only folder edits.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let organizer_id: Option<Uuid> =
      sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2 AND deleted_at IS NULL")
        .bind(workspace_id)
        .bind(format!("db${workspace_id}$folders"))
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    let Some(organizer_id) = organizer_id else {
      return Ok(false);
    };
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(workspace_document_lock_key(workspace_id, organizer_id))
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let delta = Self::retire_deleted_organizer_links_in_tx(&mut tx, workspace_id, organizer_id).await?;
    if let Some(delta) = delta {
      Self::append_workspace_doc_broadcast_outbox(
        &mut tx,
        workspace_id,
        workspace_id,
        None,
        "organizer_permanent_delete_cleanup",
        &[delta],
      )
      .await?;
      tx.commit().await.map_err(Self::map_db_err)?;
      tracing::info!(%workspace_id, %organizer_id, phase="permanent_delete_cleanup", "document_delete.organizer_deleted_links_committed");
      Ok(true)
    } else {
      tx.rollback().await.map_err(Self::map_db_err)?;
      Ok(false)
    }
  }

  /// Startup catch-up for deletions made by older releases. Keyset pagination
  /// bounds inventory reads; each workspace commits independently and replay
  /// writes nothing. A failed workspace is logged explicitly and is not counted
  /// as cleaned, without making unrelated workspaces unavailable.
  pub async fn purge_legacy_deleted_organizer_links(&self) -> AuthResult<()> {
    let mut cursor = Uuid::nil();
    loop {
      let workspaces: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT e.workspace_id FROM page_registration_evidence e
         JOIN docs d ON d.workspace_id=e.workspace_id AND d.external_id='db$'||e.workspace_id::text||'$folders'
         WHERE e.state='deleted' AND e.workspace_id>$1 AND d.deleted_at IS NULL
         ORDER BY e.workspace_id LIMIT 100",
      )
      .bind(cursor)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
      if workspaces.is_empty() {
        return Ok(());
      }
      for workspace_id in workspaces {
        cursor = workspace_id;
        // Two API nodes may start together. A serialization loser must re-read
        // the now-current Organizer instead of reporting a false cleanup error.
        let mut result = self.purge_workspace_deleted_organizer_links(workspace_id).await;
        for _ in 0..2 {
          if result.is_ok() {
            break;
          }
          result = self.purge_workspace_deleted_organizer_links(workspace_id).await;
        }
        if result.is_err() {
          tracing::error!(%workspace_id, phase="permanent_delete_cleanup", cause="DOC_DELETE_ORGANIZER_CLEANUP_FAILED", "document_delete.organizer_startup_cleanup_failed");
        }
      }
    }
  }
}
