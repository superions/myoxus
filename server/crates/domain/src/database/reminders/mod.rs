// SPDX-License-Identifier: AGPL-3.0-or-later
//! Personal reminder commands and generation-fenced native delivery persistence.
use crate::database::*;
use crate::repositories::RepoResult;
use async_trait::async_trait;

#[async_trait]
pub trait DatabaseReminderRepository: Send + Sync {
  /// Create or reschedule one user's personal reminder for a DateTime Cell.
  /// The implementation validates the redundant workspace/database/Row/field
  /// hierarchy in the same transaction as the write.
  async fn upsert_database_row_reminder(&self, reminder: DatabaseRowReminder) -> RepoResult<DatabaseRowReminder>;

  async fn list_database_row_reminders(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    user_id: UserId,
  ) -> RepoResult<Vec<DatabaseRowReminder>>;

  /// Internal lifecycle view across owners. This port is never projected as a
  /// product API; it exists only to reschedule a shared DateTime Cell change.
  async fn list_live_database_row_reminders_for_cell(
    &self,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
  ) -> RepoResult<Vec<DatabaseRowReminder>>;

  /// Cancel a live reminder owned by `user_id`. Returns `false` when no live
  /// reminder with this owner and Database exists.
  async fn cancel_database_row_reminder(
    &self,
    database_id: DatabaseId,
    reminder_id: Uuid,
    user_id: UserId,
    cancelled_at: DateTime<Utc>,
  ) -> RepoResult<bool>;

  /// Revalidate the dispatch envelope against the current target and
  /// membership immediately before notification persistence.
  async fn get_database_row_reminder_dispatch(
    &self,
    reminder_id: Uuid,
    schedule_revision: i64,
    trigger_at: DateTime<Utc>,
    user_id: UserId,
  ) -> RepoResult<Option<DatabaseRowReminderDispatch>>;

  /// Read the same native target/ACL/Task facts before shared admission, while
  /// the reminder is still scheduled or carries an interrupted legacy claim.
  /// This is read-only and never makes an unadmitted envelope deliverable.
  async fn prepare_database_row_reminder_dispatch(
    &self,
    reminder_id: Uuid,
    schedule_revision: i64,
    trigger_at: DateTime<Utc>,
    user_id: UserId,
  ) -> RepoResult<Option<DatabaseRowReminderDispatch>>;

  async fn cancel_database_row_reminder_generation(
    &self,
    reminder_id: Uuid,
    schedule_revision: i64,
    cancelled_at: DateTime<Utc>,
  ) -> RepoResult<bool>;
}

mod models;
pub use models::*;
