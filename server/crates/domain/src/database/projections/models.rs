// SPDX-License-Identifier: AGPL-3.0-or-later
//! Rebuildable reference and computed-value projection inputs.
use crate::database::{
  DatabaseCellValueData, DatabaseFieldType, DatabaseFormulaFieldConfig, DatabaseRollupFieldConfig,
};
use crate::ids::{DatabaseFieldId, DatabaseId, DatabaseRowId, DocId, WorkspaceId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

/// Rebuildable source kind for a Database Row -> document reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseDocumentReferenceKind {
  RowContentDocument,
  DocumentLinkField,
  TaskSource,
}

impl DatabaseDocumentReferenceKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::RowContentDocument => "row_content_document",
      Self::DocumentLinkField => "document_link_field",
      Self::TaskSource => "task_source",
    }
  }
}

impl FromStr for DatabaseDocumentReferenceKind {
  type Err = &'static str;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "row_content_document" => Ok(Self::RowContentDocument),
      "document_link_field" => Ok(Self::DocumentLinkField),
      "task_source" => Ok(Self::TaskSource),
      _ => Err("invalid database document reference kind"),
    }
  }
}

/// Permission-neutral repository projection. Application services may expose
/// its Row/field context only after workspace and target-document ACL checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDocumentReference {
  #[serde(default)]
  pub target_workspace_id: Option<WorkspaceId>,
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub database_title: String,
  pub row_id: DatabaseRowId,
  pub row_title: String,
  pub field_id: Option<DatabaseFieldId>,
  pub field_name: Option<String>,
  pub reference_kind: DatabaseDocumentReferenceKind,
  pub raw_target_doc_id: String,
  pub resolved_target_doc_id: Option<DocId>,
  pub refreshed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DatabaseDocumentReferenceRefresh {
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRollupProjectionTask {
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
  pub field_id: DatabaseFieldId,
  pub config: DatabaseRollupFieldConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRollupTargetValue {
  pub target_row_id: DatabaseRowId,
  pub value: Option<DatabaseCellValueData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFormulaProjectionTask {
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
  pub field_id: DatabaseFieldId,
  pub config: DatabaseFormulaFieldConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFormulaSourceValue {
  pub field_id: DatabaseFieldId,
  pub field_type: DatabaseFieldType,
  pub value: Option<DatabaseCellValueData>,
}
