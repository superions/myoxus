// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseRowReminderStatus", rename_items = "PascalCase")]
pub enum DatabaseRowReminderStatusType {
  Scheduled,
  Claimed,
  Fired,
  Cancelled,
}

impl From<domain::DatabaseRowReminderStatus> for DatabaseRowReminderStatusType {
  fn from(value: domain::DatabaseRowReminderStatus) -> Self {
    match value {
      domain::DatabaseRowReminderStatus::Scheduled => Self::Scheduled,
      domain::DatabaseRowReminderStatus::Claimed => Self::Claimed,
      domain::DatabaseRowReminderStatus::Fired => Self::Fired,
      domain::DatabaseRowReminderStatus::Cancelled => Self::Cancelled,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRowReminder")]
pub struct DatabaseRowReminderObjectType {
  pub id: ID,
  pub database_id: ID,
  pub row_id: ID,
  pub field_id: ID,
  pub offset_minutes: i64,
  pub trigger_at: DateTime<Utc>,
  pub status: DatabaseRowReminderStatusType,
  pub schedule_revision: i64,
}

#[derive(InputObject)]
pub struct SetDatabaseRowReminderInput {
  pub database_id: ID,
  pub row_id: ID,
  pub field_id: ID,
  pub offset_minutes: i64,
}

#[derive(InputObject)]
pub struct DeleteDatabaseRowReminderInput {
  pub database_id: ID,
  pub reminder_id: ID,
}

fn map_database_row_reminder(reminder: domain::DatabaseRowReminder) -> DatabaseRowReminderObjectType {
  DatabaseRowReminderObjectType {
    id: ID::from(reminder.id.to_string()),
    database_id: ID::from(reminder.database_id.to_string()),
    row_id: ID::from(reminder.row_id.to_string()),
    field_id: ID::from(reminder.field_id.to_string()),
    offset_minutes: reminder.offset_minutes,
    trigger_at: reminder.trigger_at,
    status: reminder.status.into(),
    schedule_revision: reminder.schedule_revision,
  }
}

pub(crate) async fn list_database_row_reminders(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
  row_id: ID,
  field_id: ID,
) -> Result<Vec<DatabaseRowReminderObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&database_id, "databaseId")?;
  let row_id = parse_uuid_id(&row_id, "rowId")?;
  let field_id = parse_uuid_id(&field_id, "fieldId")?;
  let record = service(&state)?
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  if record.database.workspace_id != workspace_id {
    return Err(database_error("MIX_DATABASE_NOT_FOUND", "database not found"));
  }
  let reminders = service(&state)?
    .reminders
    .list_database_row_reminders(snapshot.user.id, database_id, row_id, field_id)
    .await
    .map_err(map_database_error)?;
  Ok(reminders.into_iter().map(map_database_row_reminder).collect())
}

pub(crate) async fn set_database_row_reminder(
  ctx: &Context<'_>,
  input: SetDatabaseRowReminderInput,
) -> Result<DatabaseRowReminderObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let reminder = service(&state)?
    .reminders
    .set_database_row_reminder(
      snapshot.user.id,
      parse_uuid_id(&input.database_id, "databaseId")?,
      parse_uuid_id(&input.row_id, "rowId")?,
      parse_uuid_id(&input.field_id, "fieldId")?,
      input.offset_minutes,
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_database_row_reminder(reminder))
}

pub(crate) async fn delete_database_row_reminder(
  ctx: &Context<'_>,
  input: DeleteDatabaseRowReminderInput,
) -> Result<bool> {
  let (state, snapshot) = require_session(ctx).await?;
  service(&state)?
    .reminders
    .delete_database_row_reminder(
      snapshot.user.id,
      parse_uuid_id(&input.database_id, "databaseId")?,
      parse_uuid_id(&input.reminder_id, "reminderId")?,
    )
    .await
    .map_err(map_database_error)?;
  Ok(true)
}
