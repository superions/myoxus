// SPDX-License-Identifier: AGPL-3.0-or-later
//! GraphQL transport mapping for the server-owned document audit projection.

use async_graphql::{Enum, ID, InputObject, Result, SimpleObject};
use chrono::{DateTime, Utc};
use myoxus_application::audit::{DocumentAuditEntry, DocumentAuditFilter};
use serde_json::Value;
use tracing::{debug, instrument};
use uuid::Uuid;

use crate::graphql::audit_types::{AdminAuditActorType, AuditTargetType};
use crate::state::ApiState;

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum AdminDocumentAuditGroupType {
  #[graphql(name = "document_lifecycle")]
  DocumentLifecycle,
  #[graphql(name = "metadata_policy")]
  MetadataPolicy,
  #[graphql(name = "status_schema")]
  StatusSchema,
  #[graphql(name = "status_transition")]
  StatusTransition,
  #[graphql(name = "document_type")]
  DocumentType,
  #[graphql(name = "version_policy")]
  VersionPolicy,
  #[graphql(name = "workspace_settings")]
  WorkspaceSettings,
  #[graphql(name = "document_metadata")]
  DocumentMetadata,
  #[graphql(name = "document_version")]
  DocumentVersion,
  #[graphql(name = "pdf_export")]
  PdfExport,
}

impl AdminDocumentAuditGroupType {
  fn as_key(self) -> &'static str {
    match self {
      Self::DocumentLifecycle => "document_lifecycle",
      Self::MetadataPolicy => "metadata_policy",
      Self::StatusSchema => "status_schema",
      Self::StatusTransition => "status_transition",
      Self::DocumentType => "document_type",
      Self::VersionPolicy => "version_policy",
      Self::WorkspaceSettings => "workspace_settings",
      Self::DocumentMetadata => "document_metadata",
      Self::DocumentVersion => "document_version",
      Self::PdfExport => "pdf_export",
    }
  }

  fn from_key(raw: &str) -> Option<Self> {
    match raw {
      "document_lifecycle" => Some(Self::DocumentLifecycle),
      "metadata_policy" => Some(Self::MetadataPolicy),
      "status_schema" => Some(Self::StatusSchema),
      "status_transition" => Some(Self::StatusTransition),
      "document_type" => Some(Self::DocumentType),
      "version_policy" => Some(Self::VersionPolicy),
      "workspace_settings" => Some(Self::WorkspaceSettings),
      "document_metadata" => Some(Self::DocumentMetadata),
      "document_version" => Some(Self::DocumentVersion),
      "pdf_export" => Some(Self::PdfExport),
      _ => None,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum AdminDocumentAuditSourceType {
  #[graphql(name = "admin_audit_log")]
  AdminAuditLog,
  #[graphql(name = "document_initial_sync_audit")]
  DocumentInitialSyncAudit,
  #[graphql(name = "pdf_export_render_audit")]
  PdfExportRenderAudit,
}

impl AdminDocumentAuditSourceType {
  fn from_key(raw: &str) -> Self {
    match raw {
      "document_initial_sync_audit" => Self::DocumentInitialSyncAudit,
      "pdf_export_render_audit" => Self::PdfExportRenderAudit,
      _ => Self::AdminAuditLog,
    }
  }
}

#[derive(InputObject, Debug, Default, Clone)]
pub struct AdminDocumentAuditFilterInput {
  /// Omitted groups mean every document-domain group, never every global
  /// operational audit category.
  pub groups: Option<Vec<AdminDocumentAuditGroupType>>,
  #[graphql(name = "actorUserId")]
  pub actor_user_id: Option<ID>,
  #[graphql(name = "targetType")]
  pub target_type: Option<String>,
  #[graphql(name = "targetId")]
  pub target_id: Option<String>,
  #[graphql(name = "workspaceId")]
  pub workspace_id: Option<ID>,
  #[graphql(name = "docId")]
  pub doc_id: Option<ID>,
  #[graphql(name = "eventKeyPrefix")]
  pub event_key_prefix: Option<String>,
  pub from: Option<DateTime<Utc>>,
  pub to: Option<DateTime<Utc>>,
}

impl AdminDocumentAuditFilterInput {
  fn normalize(&self) -> Result<DocumentAuditFilter> {
    Ok(DocumentAuditFilter {
      groups: self
        .groups
        .as_ref()
        .map(|groups| groups.iter().map(|group| group.as_key().to_string()).collect()),
      actor_user_id: parse_optional_uuid(&self.actor_user_id, "actorUserId")?,
      target_type: normalize_optional_text(self.target_type.as_deref(), "targetType")?,
      target_id: normalize_optional_text(self.target_id.as_deref(), "targetId")?,
      workspace_id: parse_optional_uuid(&self.workspace_id, "workspaceId")?,
      doc_id: parse_optional_uuid(&self.doc_id, "docId")?,
      event_key_prefix: normalize_optional_text(self.event_key_prefix.as_deref(), "eventKeyPrefix")?,
      from: self.from,
      to: self.to,
    })
  }
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminDocumentAuditEntryType {
  pub id: ID,
  pub source: AdminDocumentAuditSourceType,
  pub group: AdminDocumentAuditGroupType,
  #[graphql(name = "eventKey")]
  pub event_key: String,
  #[graphql(name = "sourceCategory")]
  pub source_category: String,
  pub target: Option<AuditTargetType>,
  pub actor: Option<AdminAuditActorType>,
  #[graphql(name = "oldValue")]
  pub old_value: Option<Value>,
  #[graphql(name = "newValue")]
  pub new_value: Option<Value>,
  pub metadata: Option<Value>,
  #[graphql(name = "createdAt")]
  pub created_at: DateTime<Utc>,
  #[graphql(name = "targetUnitId")]
  pub target_unit_id: Option<ID>,
  #[graphql(name = "workspaceId")]
  pub workspace_id: Option<ID>,
  #[graphql(name = "docId")]
  pub doc_id: Option<ID>,
}

#[instrument(skip(state, filter), fields(take, skip))]
pub async fn list_document_audit(
  state: &ApiState,
  filter: AdminDocumentAuditFilterInput,
  skip: i64,
  take: i64,
) -> Result<Vec<AdminDocumentAuditEntryType>> {
  let normalized = filter.normalize()?;
  let take = take.clamp(1, 500);
  let skip = skip.max(0);
  let rows = state
    .document_audit_projection()
    .list_document_audit(&normalized, skip, take)
    .await
    .map_err(|error| async_graphql::Error::new(error.to_string()))?;
  debug!(rows = rows.len(), take, skip, groups = ?normalized.groups, "admin document audit rows listed");
  rows.into_iter().map(entry_to_type).collect()
}

#[instrument(skip(state, filter))]
pub async fn count_document_audit(state: &ApiState, filter: AdminDocumentAuditFilterInput) -> Result<i64> {
  let normalized = filter.normalize()?;
  let count = state
    .document_audit_projection()
    .count_document_audit(&normalized)
    .await
    .map_err(|error| async_graphql::Error::new(error.to_string()))?;
  debug!(count, groups = ?normalized.groups, "admin document audit rows counted");
  Ok(count)
}

fn entry_to_type(entry: DocumentAuditEntry) -> Result<AdminDocumentAuditEntryType> {
  let group = AdminDocumentAuditGroupType::from_key(&entry.group_key)
    .ok_or_else(|| async_graphql::Error::new(format!("unknown document audit group: {}", entry.group_key)))?;
  let target = match (entry.target_type, entry.target_id) {
    (Some(target_type), Some(id)) => Some(AuditTargetType {
      target_type,
      id,
      label: entry.target_label,
    }),
    _ => None,
  };
  let actor = if entry.actor_user_id.is_some() || entry.actor_label.is_some() || entry.actor_kind.is_some() {
    Some(AdminAuditActorType {
      id: entry.actor_user_id,
      label: entry.actor_label,
      kind: entry.actor_kind.unwrap_or_else(|| {
        if entry.actor_user_id.is_some() {
          "user".to_string()
        } else {
          "system".to_string()
        }
      }),
      credential_type: entry.credential_type,
      credential_id: entry.credential_id,
    })
  } else {
    None
  };
  Ok(AdminDocumentAuditEntryType {
    id: ID::from(entry.id),
    source: AdminDocumentAuditSourceType::from_key(&entry.source),
    group,
    event_key: entry.event_key,
    source_category: entry.source_category,
    target,
    actor,
    old_value: entry.old_value,
    new_value: entry.new_value,
    metadata: entry.metadata,
    created_at: entry.created_at,
    target_unit_id: entry.target_unit_id.map(|id| ID::from(id.to_string())),
    workspace_id: entry.workspace_id.map(ID::from),
    doc_id: entry.doc_id.map(ID::from),
  })
}

fn parse_optional_uuid(raw: &Option<ID>, field: &str) -> Result<Option<Uuid>> {
  raw
    .as_ref()
    .map(|id| {
      Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new(format!("{field} must be a valid UUID")))
    })
    .transpose()
}

fn normalize_optional_text(raw: Option<&str>, field: &str) -> Result<Option<String>> {
  let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
    return Ok(None);
  };
  if value.len() > 160 {
    return Err(async_graphql::Error::new(format!(
      "{field} must be at most 160 characters"
    )));
  }
  Ok(Some(value.to_string()))
}
