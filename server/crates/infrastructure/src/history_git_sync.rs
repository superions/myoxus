// SPDX-License-Identifier: AGPL-3.0-or-later
//! Transactional handoff from document-history capture to Git-Sync.

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// Record one durable receipt and outbox event for every active profile that
/// currently selects the history-capture trigger. The profile row lock pairs
/// the captured generation with lifecycle updates in the same lock order.
pub async fn record_history_capture(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Uuid,
  history_id: i64,
) -> Result<(), sqlx::Error> {
  let profiles: Vec<(Uuid, i64)> = sqlx::query_as(
    "SELECT id, activation_generation FROM git_sync_profiles
     WHERE workspace_id = $1 AND enabled = true
       AND trigger_mode = 'HistoryCapture'
       AND sync_direction IN ('MyoxusToGit', 'Bidirectional')
     ORDER BY id FOR SHARE",
  )
  .bind(workspace_id)
  .fetch_all(&mut **tx)
  .await?;

  for (profile_id, generation) in profiles {
    let inserted = sqlx::query_scalar::<_, i64>(
      "INSERT INTO git_sync_history_capture_receipts
         (profile_id, history_id, workspace_id, activation_generation)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (profile_id, history_id) DO NOTHING
       RETURNING history_id",
    )
    .bind(profile_id)
    .bind(history_id)
    .bind(workspace_id)
    .bind(generation)
    .fetch_optional(&mut **tx)
    .await?;
    if inserted.is_some() {
      sqlx::query(
        "INSERT INTO outbox_events
           (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('git_sync_history_capture', $1, 'history_captured',
           jsonb_build_object(
             'workspaceId', $2::text,
             'profileId', $3::text,
             'historyId', $4,
             'activationGeneration', $5
           ))",
      )
      .bind(format!("{profile_id}:{history_id}"))
      .bind(workspace_id)
      .bind(profile_id)
      .bind(history_id)
      .bind(generation)
      .execute(&mut **tx)
      .await?;
    }
  }
  Ok(())
}
