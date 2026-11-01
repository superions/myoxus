// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};

use crate::WorkspaceImportDiagnostic;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceImportFormat {
  SqliteV1,
  SqliteDocStorage,
  SnapshotZip,
  ObsidianZip,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DecodedDocumentContent {
  YjsV1(Vec<u8>),
  SnapshotBlocks(Vec<yjs::PortableSnapshotBlock>),
  /// Validated UTF-8 Markdown retained for Application-owned preparation.
  MarkdownUtf8(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedDocument {
  pub source_id: String,
  pub title: String,
  pub mode: String,
  pub parent_source_id: Option<String>,
  pub order: String,
  /// Portable source creation timestamp in Unix milliseconds when the source
  /// format declares it. Application services decide how it is projected.
  pub created_at_ms: Option<i64>,
  /// Portable trash state from the source workspace. Apply must materialize
  /// this state instead of silently publishing or dropping trashed documents.
  pub is_trashed: bool,
  #[serde(default)]
  pub tags: Vec<String>,
  pub content: DecodedDocumentContent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedAsset {
  pub source_key: String,
  pub size_bytes: u64,
  pub content_hash: String,
}

/// Counts for explicitly non-portable source categories. Only allowlisted
/// container sizes are retained; identities and values never cross the decoder
/// boundary.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedOmittedObjectCounts {
  pub memberships: usize,
  pub sessions: usize,
  pub sharing_and_publications: usize,
  pub comments: usize,
  pub activity_and_history: usize,
  pub external_integrations_and_credentials: usize,
  /// Archive entries excluded by the selected source-format policy.
  pub excluded_entries: usize,
}

/// Neutral decoded source. Source ids are import-local identities and must
/// never be reused as live Myoxus product ids by a caller.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedWorkspace {
  pub format: WorkspaceImportFormat,
  pub title: String,
  #[serde(default)]
  pub workspace_tags: Vec<DecodedWorkspaceTag>,
  pub documents: Vec<DecodedDocument>,
  pub assets: Vec<DecodedAsset>,
  /// Explicit source directories, including empty folders. Product hierarchy
  /// planning remains an Application responsibility.
  #[serde(default)]
  pub directories: Vec<String>,
  pub omitted_counts: DecodedOmittedObjectCounts,
  pub diagnostics: Vec<WorkspaceImportDiagnostic>,
}

/// Portable source identity and metadata. Validation and target identity planning
/// belong to the Application label transfer owner, never to a live Yjs bootstrap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedWorkspaceTag {
  pub id: String,
  #[serde(alias = "value")]
  pub name: String,
  #[serde(default, alias = "color")]
  pub color_role: String,
  #[serde(default)]
  pub description: Option<String>,
  #[serde(default)]
  pub archived: bool,
  #[serde(default)]
  pub archived_at: Option<String>,
}
