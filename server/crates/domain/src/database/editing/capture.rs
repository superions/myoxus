// SPDX-License-Identifier: AGPL-3.0-or-later
//! Immutable native Task capture admission and origin identities.
use crate::database::*;

/// Immutable capture origin. No copied source title or content is persisted here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseTaskSource {
  pub source_workspace_id: WorkspaceId,
  pub document_id: DocId,
  pub external_id: String,
  pub block_id: Option<String>,
  pub selection_anchor: Option<String>,
}

/// Identity-only admission result, retained independently of Row/Database lifetime.
#[derive(Debug, Clone)]
pub struct DatabaseTaskCaptureReceipt {
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub request_id: Uuid,
  pub fingerprint: String,
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
  pub edit_revision: i64,
  pub source: DatabaseTaskSource,
}
