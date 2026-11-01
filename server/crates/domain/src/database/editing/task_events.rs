// SPDX-License-Identifier: AGPL-3.0-or-later
//! Immutable Task notification facts captured by the native editing transaction.
use crate::database::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseTaskNotificationIntent {
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
  pub actor_id: UserId,
  pub revisions: Vec<DatabaseTaskNotificationRevision>,
  pub recipients: Vec<DatabaseTaskNotificationRecipient>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseTaskNotificationRevision {
  pub field_id: DatabaseFieldId,
  pub edit_revision: i64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseTaskNotificationKind {
  Assignment,
  Changed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseTaskNotificationRecipient {
  pub user_id: UserId,
  pub kind: DatabaseTaskNotificationKind,
}

/// Transaction-local preimage and committed revision used by post-commit effects.
/// Users, Status and DateTime preimages are captured under the native Row
/// lock, not by an earlier application read. Other kinds have no preimage.
#[derive(Debug, Clone)]
pub struct DatabaseCommittedCellChange {
  pub row_id: DatabaseRowId,
  pub field_id: DatabaseFieldId,
  pub previous_value: Option<DatabaseCellValueData>,
  pub value: Option<DatabaseCellValueData>,
  pub edit_revision: i64,
}
