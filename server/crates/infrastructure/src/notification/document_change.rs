// SPDX-License-Identifier: AGPL-3.0-or-later
//! Transactional pending-window rotation and in-app completion.

use std::collections::HashMap;

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use myoxus_application::{
  auth::{AuthError, AuthResult},
  notification::{
    NotificationCreateOutcome,
    document_change::{
      DOCUMENT_CHANGE_WINDOW_SECONDS, DocumentChangeActor, DocumentChangeBatch, DocumentChangeRecipient,
      DocumentChangeStore,
    },
  },
};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use super::SqlxNotificationRepository;

fn storage(error: sqlx::Error) -> AuthError {
  AuthError::Storage(error.to_string())
}

/// Call only after an eligible content change, under its canonical document
/// lock. Rotation and actor facts commit with that change, without network work.
pub(crate) async fn accumulate_in_tx(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Uuid,
  doc_id: Uuid,
  actor: Uuid,
  sequence: i64,
  now: DateTime<Utc>,
) -> AuthResult<()> {
  // Once expired or moved, a window is immutable even if dispatch is late.
  sqlx::query(
    "UPDATE document_change_batches SET sealed_at=$3
    WHERE doc_id=$1 AND sealed_at IS NULL AND (due_at <= $3 OR workspace_id <> $2)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(now)
  .execute(&mut **tx)
  .await
  .map_err(storage)?;
  let batch_id: Uuid = sqlx::query_scalar(
    "INSERT INTO document_change_batches
    (id, doc_id, workspace_id, started_at, last_changed_at, due_at, first_sequence, last_sequence)
    VALUES ($1,$2,$3,$4,$4,$5,$6,$6)
    ON CONFLICT (doc_id) WHERE sealed_at IS NULL DO UPDATE
      SET last_sequence=GREATEST(document_change_batches.last_sequence,EXCLUDED.last_sequence),
          last_changed_at=GREATEST(document_change_batches.last_changed_at,EXCLUDED.last_changed_at)
    RETURNING id",
  )
  .bind(Uuid::new_v4())
  .bind(doc_id)
  .bind(workspace_id)
  .bind(now)
  .bind(now + Duration::seconds(DOCUMENT_CHANGE_WINDOW_SECONDS))
  .bind(sequence)
  .fetch_one(&mut **tx)
  .await
  .map_err(storage)?;
  sqlx::query(
    "INSERT INTO document_change_batch_actors (batch_id,user_id,first_sequence,last_sequence)
    VALUES ($1,$2,$3,$3) ON CONFLICT(batch_id,user_id) DO UPDATE
      SET last_sequence=GREATEST(document_change_batch_actors.last_sequence,EXCLUDED.last_sequence)",
  )
  .bind(batch_id)
  .bind(actor)
  .bind(sequence)
  .execute(&mut **tx)
  .await
  .map_err(storage)?;
  Ok(())
}

pub struct SqlxDocumentChangeStore {
  pool: PgPool,
}

impl SqlxDocumentChangeStore {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  /// The same SQL completion is exposed to transaction/rollback tests. Lock
  /// document before batch, matching writers; all slow authority reads precede
  /// this short transaction so dispatch never holds a write lock over fanout.
  pub async fn complete_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    batch: &DocumentChangeBatch,
    recipient: Option<&DocumentChangeRecipient>,
    now: DateTime<Utc>,
  ) -> AuthResult<Option<NotificationCreateOutcome>> {
    let document = sqlx::query(
      "SELECT workspace_id,created_by,blocked,deleted_at
      FROM docs WHERE id=$1 FOR UPDATE",
    )
    .bind(batch.doc_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(storage)?;
    let exists: Option<Uuid> = sqlx::query_scalar(
      "SELECT id FROM document_change_batches
      WHERE id=$1 AND doc_id=$2 AND workspace_id=$3 AND due_at <= $4 AND sealed_at IS NOT NULL FOR UPDATE",
    )
    .bind(batch.id)
    .bind(batch.doc_id)
    .bind(batch.workspace_id)
    .bind(now)
    .fetch_optional(&mut **tx)
    .await
    .map_err(storage)?;
    if exists.is_none() {
      return Ok(None);
    }
    let recipient = recipient.filter(|recipient| {
      document.as_ref().is_some_and(|doc| {
        doc.get::<Option<Uuid>, _>("workspace_id") == Some(batch.workspace_id)
          && doc.get::<Option<Uuid>, _>("created_by") == Some(recipient.user_id)
          && !doc.get::<bool, _>("blocked")
          && doc.get::<Option<DateTime<Utc>>, _>("deleted_at").is_none()
      })
    });
    let outcome = if let Some(recipient) = recipient {
      Some(
        SqlxNotificationRepository::insert_notification(
          &mut **tx,
          recipient.user_id,
          "document_changed".into(),
          "default".into(),
          Some(format!("document_changed:{}:{}", batch.id, recipient.user_id)),
          serde_json::json!({
            "batchId":batch.id,"docId":batch.doc_id,"workspaceId":batch.workspace_id,
            "firstChangedAt":batch.started_at,"lastChangedAt":batch.last_changed_at,
            "latestActorId":recipient.latest_actor_id,"actorCount":recipient.actor_count,
          }),
          now,
        )
        .await?,
      )
    } else {
      None
    };
    sqlx::query("DELETE FROM document_change_batches WHERE id=$1")
      .bind(batch.id)
      .execute(&mut **tx)
      .await
      .map_err(storage)?;
    Ok(outcome)
  }
}

#[async_trait]
impl DocumentChangeStore for SqlxDocumentChangeStore {
  #[tracing::instrument(skip_all, fields(limit))]
  async fn due_batches(&self, now: DateTime<Utc>, limit: i64) -> AuthResult<Vec<DocumentChangeBatch>> {
    let mut tx = self.pool.begin().await.map_err(storage)?;
    let rows = sqlx::query(
      "SELECT id,doc_id,workspace_id,started_at,last_changed_at,due_at
      FROM document_change_batches WHERE due_at <= $1 ORDER BY due_at,id
      LIMIT $2 FOR UPDATE SKIP LOCKED",
    )
    .bind(now)
    .bind(limit.clamp(1, 100))
    .fetch_all(&mut *tx)
    .await
    .map_err(storage)?;
    let ids = rows.iter().map(|row| row.get::<Uuid, _>("id")).collect::<Vec<_>>();
    sqlx::query("UPDATE document_change_batches SET sealed_at=COALESCE(sealed_at,$2) WHERE id=ANY($1)")
      .bind(&ids)
      .bind(now)
      .execute(&mut *tx)
      .await
      .map_err(storage)?;
    let actor_rows = sqlx::query(
      "SELECT batch_id,user_id,first_sequence,last_sequence
      FROM document_change_batch_actors WHERE batch_id=ANY($1)",
    )
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(storage)?;
    let mut actors: HashMap<Uuid, Vec<DocumentChangeActor>> = HashMap::new();
    for row in actor_rows {
      actors
        .entry(row.get("batch_id"))
        .or_default()
        .push(DocumentChangeActor {
          user_id: row.get("user_id"),
          first_sequence: row.get("first_sequence"),
          last_sequence: row.get("last_sequence"),
        });
    }
    let batches = rows
      .into_iter()
      .map(|row| {
        let id = row.get("id");
        DocumentChangeBatch {
          id,
          doc_id: row.get("doc_id"),
          workspace_id: row.get("workspace_id"),
          started_at: row.get("started_at"),
          last_changed_at: row.get("last_changed_at"),
          due_at: row.get("due_at"),
          actors: actors.remove(&id).unwrap_or_default(),
        }
      })
      .collect();
    tx.commit().await.map_err(storage)?;
    Ok(batches)
  }

  #[tracing::instrument(skip_all, fields(batch_id = %batch.id))]
  async fn complete_batch(
    &self,
    batch: &DocumentChangeBatch,
    recipient: Option<&DocumentChangeRecipient>,
    now: DateTime<Utc>,
  ) -> AuthResult<Option<NotificationCreateOutcome>> {
    let mut tx = self.pool.begin().await.map_err(storage)?;
    let outcome = Self::complete_in_tx(&mut tx, batch, recipient, now).await?;
    tx.commit().await.map_err(storage)?;
    Ok(outcome)
  }
}
