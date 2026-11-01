//! Server-owned Document Graph domain contract.
//!
//! The graph is derived from explicit internal document references extracted
//! from Yjs. This module intentionally contains no Yjs, SQLx, GraphQL, worker
//! or client types; application services map extractor output into these
//! domain records and enforce ACL/redaction before exposing them.

use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::ids::{DocId, DocumentGraphOccurrenceId, WorkspaceId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentGraphLinkKind {
  InlineReference,
  EmbedLinkedDoc,
  EmbedSyncedDoc,
  SurfaceRef,
  DatabaseCellReference,
}

impl DocumentGraphLinkKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::InlineReference => "inline_reference",
      Self::EmbedLinkedDoc => "embed_linked_doc",
      Self::EmbedSyncedDoc => "embed_synced_doc",
      Self::SurfaceRef => "surface_ref",
      Self::DatabaseCellReference => "database_cell_reference",
    }
  }
}

impl FromStr for DocumentGraphLinkKind {
  type Err = DocumentGraphDomainError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "inline_reference" => Ok(Self::InlineReference),
      "embed_linked_doc" => Ok(Self::EmbedLinkedDoc),
      "embed_synced_doc" => Ok(Self::EmbedSyncedDoc),
      "surface_ref" => Ok(Self::SurfaceRef),
      "database_cell_reference" => Ok(Self::DatabaseCellReference),
      _ => Err(DocumentGraphDomainError::InvalidLinkKind(value.to_string())),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentGraphTargetState {
  Available,
  Redacted,
  Deleted,
  Missing,
  Unresolved,
}

impl DocumentGraphTargetState {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Available => "available",
      Self::Redacted => "redacted",
      Self::Deleted => "deleted",
      Self::Missing => "missing",
      Self::Unresolved => "unresolved",
    }
  }
}

impl FromStr for DocumentGraphTargetState {
  type Err = DocumentGraphDomainError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "available" => Ok(Self::Available),
      "redacted" => Ok(Self::Redacted),
      "deleted" => Ok(Self::Deleted),
      "missing" => Ok(Self::Missing),
      "unresolved" => Ok(Self::Unresolved),
      _ => Err(DocumentGraphDomainError::InvalidTargetState(value.to_string())),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentGraphStaleState {
  Current,
  Stale,
  Queued,
  Extracting,
  Failed,
  Deleted,
}

impl DocumentGraphStaleState {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Current => "current",
      Self::Stale => "stale",
      Self::Queued => "queued",
      Self::Extracting => "extracting",
      Self::Failed => "failed",
      Self::Deleted => "deleted",
    }
  }
}

impl FromStr for DocumentGraphStaleState {
  type Err = DocumentGraphDomainError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "current" => Ok(Self::Current),
      "stale" => Ok(Self::Stale),
      "queued" => Ok(Self::Queued),
      "extracting" => Ok(Self::Extracting),
      "failed" => Ok(Self::Failed),
      "deleted" => Ok(Self::Deleted),
      _ => Err(DocumentGraphDomainError::InvalidStaleState(value.to_string())),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentGraphDirection {
  Incoming,
  Outgoing,
  Both,
}

impl DocumentGraphDirection {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Incoming => "incoming",
      Self::Outgoing => "outgoing",
      Self::Both => "both",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGraphMetadataFilter {
  #[serde(default)]
  pub statuses: Vec<String>,
  #[serde(default)]
  pub document_types: Vec<String>,
  #[serde(default)]
  pub classifications: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGraphNode {
  pub workspace_id: WorkspaceId,
  pub doc_id: Option<DocId>,
  pub raw_doc_id: String,
  pub title: Option<String>,
  pub document_type: Option<String>,
  pub status: Option<String>,
  pub classification: Option<String>,
  pub deleted: bool,
  pub redacted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGraphOccurrence {
  pub id: DocumentGraphOccurrenceId,
  pub workspace_id: WorkspaceId,
  pub source_doc_id: DocId,
  pub source_block_id: String,
  #[serde(default)]
  pub source_position: Value,
  pub source_parent_block_id: Option<String>,
  pub source_parent_flavour: Option<String>,
  #[serde(default)]
  pub target_workspace_id: Option<WorkspaceId>,
  pub raw_target_doc_id: String,
  pub target_doc_id: Option<DocId>,
  pub link_kind: DocumentGraphLinkKind,
  pub params_json: Value,
  pub params_key: String,
  pub markdown_preview: String,
  pub target_state: DocumentGraphTargetState,
  pub extracted_at: DateTime<Utc>,
  pub source_updated_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGraphEdge {
  pub source_doc_id: DocId,
  pub target_doc_id: Option<DocId>,
  #[serde(default)]
  pub target_workspace_id: Option<WorkspaceId>,
  pub raw_target_doc_id: String,
  pub target_state: DocumentGraphTargetState,
  pub link_kind: DocumentGraphLinkKind,
  pub occurrence_count: i64,
  pub first_occurrence_preview: Option<String>,
  pub stale_state: DocumentGraphStaleState,
  #[serde(default)]
  pub occurrences: Vec<DocumentGraphOccurrence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGraphIndexState {
  pub workspace_id: WorkspaceId,
  pub doc_id: DocId,
  pub source_updated_at: Option<DateTime<Utc>>,
  pub indexed_at: Option<DateTime<Utc>>,
  pub queued_at: Option<DateTime<Utc>>,
  pub started_at: Option<DateTime<Utc>>,
  pub failed_at: Option<DateTime<Utc>>,
  pub stale_state: DocumentGraphStaleState,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
  pub attempt_count: i32,
  pub occurrence_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGraphPage {
  pub first: i64,
  pub offset: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGraphQuery {
  pub focus_doc_id: Option<DocId>,
  pub direction: DocumentGraphDirection,
  pub page: DocumentGraphPage,
  pub metadata_filter: Option<DocumentGraphMetadataFilter>,
  pub include_occurrences: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGraphReadModel {
  pub nodes: Vec<DocumentGraphNode>,
  pub edges: Vec<DocumentGraphEdge>,
  /// Typed Database context is kept separate from Yjs occurrences because a
  /// Row is not a synthetic document source.
  #[serde(default)]
  pub database_references: Vec<crate::database::DatabaseDocumentReference>,
  pub index_summary: DocumentGraphIndexSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGraphIndexSummary {
  pub workspace_id: WorkspaceId,
  pub current_count: i64,
  pub stale_count: i64,
  pub queued_count: i64,
  pub extracting_count: i64,
  pub failed_count: i64,
  pub deleted_count: i64,
  pub missing_state_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentGraphReindexReason {
  DocUpdated,
  DocDeleted,
  SnapshotCompacted,
  MetadataUpdated,
  Manual,
  CatchUp,
}

impl DocumentGraphReindexReason {
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::DocUpdated => "doc_updated",
      Self::DocDeleted => "doc_deleted",
      Self::SnapshotCompacted => "snapshot_compacted",
      Self::MetadataUpdated => "metadata_updated",
      Self::Manual => "manual",
      Self::CatchUp => "catch_up",
    }
  }
}

impl FromStr for DocumentGraphReindexReason {
  type Err = DocumentGraphDomainError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "doc_updated" => Ok(Self::DocUpdated),
      "doc_deleted" => Ok(Self::DocDeleted),
      "snapshot_compacted" => Ok(Self::SnapshotCompacted),
      "metadata_updated" => Ok(Self::MetadataUpdated),
      "manual" => Ok(Self::Manual),
      "catch_up" => Ok(Self::CatchUp),
      _ => Err(DocumentGraphDomainError::InvalidReindexReason(value.to_string())),
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGraphReindexJob {
  pub workspace_id: Option<WorkspaceId>,
  pub doc_id: Option<DocId>,
  pub limit: Option<i64>,
  pub workspace_limit: Option<i64>,
  pub reason: DocumentGraphReindexReason,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum DocumentGraphDomainError {
  #[error("invalid document graph link kind: {0}")]
  InvalidLinkKind(String),
  #[error("invalid document graph target state: {0}")]
  InvalidTargetState(String),
  #[error("invalid document graph stale state: {0}")]
  InvalidStaleState(String),
  #[error("invalid document graph reindex reason: {0}")]
  InvalidReindexReason(String),
}
