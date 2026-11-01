// SPDX-License-Identifier: AGPL-3.0-or-later

//! Optimistic fences for an explicit, bounded native Task move; preview is not a reservation.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTaskMoveSelection {
  pub row_id: DatabaseRowId,
  pub expected_edit_revision: i64,
  pub cell_revisions: BTreeMap<DatabaseFieldId, i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTaskMoveInput {
  pub source_edit_revision: i64,
  pub target_edit_revision: i64,
  pub workspace_id: WorkspaceId,
  pub source_database_id: DatabaseId,
  pub target_database_id: DatabaseId,
  pub source_schema_revision: i64,
  pub target_schema_revision: i64,
  pub selection: Vec<DatabaseTaskMoveSelection>,
  pub phase_row_id: Option<DatabaseRowId>,
  pub milestone_row_id: Option<DatabaseRowId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTaskMoveBoundary {
  pub row_id: DatabaseRowId,
  pub field_id: DatabaseFieldId,
  pub related_row_id: DatabaseRowId,
  pub inbound: bool,
  pub recoverable_trash: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTaskMovePreview {
  pub input: DatabaseTaskMoveInput,
  pub eligible: bool,
  pub reasons: Vec<String>,
  pub required_related_tasks: Vec<DatabaseRowId>,
  pub boundaries: Vec<DatabaseTaskMoveBoundary>,
  pub allocates_display_ids: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTaskMoveResult {
  pub source_database_id: DatabaseId,
  pub target_database_id: DatabaseId,
  pub rows: Vec<DatabaseRowRecord>,
}
