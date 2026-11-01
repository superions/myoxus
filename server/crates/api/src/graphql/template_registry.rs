//! GraphQL resolvers for the Template Registry (admin-only).
//!
//! Provides queries and mutations for template catalog management,
//! bundle import, revision publishing, and catalog browsing.

use async_graphql::{Enum, ID, InputObject, Result, SimpleObject};
use chrono::{DateTime, Utc};
use std::sync::Arc;
use tracing::instrument;

use crate::state::ApiState;
use myoxus_application::template_registry::bundle;
use myoxus_domain::template_registry::{InstanceState, ProvisioningMode, SelectionMode, TemplateSource};

// ─── GraphQL Types ───────────────────────────────────────────────────────────

#[derive(SimpleObject)]
pub struct WorkspaceTemplateSourceType {
  /// Workspace-local native document key, not a Registry revision ID.
  pub doc_id: ID,
  pub title: String,
  pub document_revision: i64,
  pub metadata_revision: i64,
  pub origin: Option<String>,
  pub identifier: Option<String>,
  pub version: Option<String>,
  pub description: Option<String>,
  pub category: Option<String>,
  pub tags: Vec<String>,
  pub locale: Option<String>,
  pub title_policy: Option<String>,
}

impl From<myoxus_application::document_template::DocumentTemplateSource> for WorkspaceTemplateSourceType {
  fn from(source: myoxus_application::document_template::DocumentTemplateSource) -> Self {
    Self {
      doc_id: ID(source.external_id),
      title: source.title,
      document_revision: source.document_revision,
      metadata_revision: source.metadata_revision,
      origin: source.origin,
      identifier: source.identifier,
      version: source.version,
      description: source.description,
      category: source.category,
      tags: source.tags,
      locale: source.locale,
      title_policy: source.title_policy.map(|policy| {
        match policy {
          bundle::TitlePolicy::Template => "template",
          bundle::TitlePolicy::TemplateDate => "template-date",
          bundle::TitlePolicy::Date => "date",
        }
        .to_string()
      }),
    }
  }
}

#[derive(SimpleObject)]
pub struct WorkspaceTemplateSourcePageType {
  pub sources: Vec<WorkspaceTemplateSourceType>,
  pub next_offset: Option<i64>,
}

/// Template catalog entry status as a GraphQL enum.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum TemplateStatusType {
  Active,
  Disabled,
  Archived,
}

impl From<myoxus_domain::template_registry::TemplateStatus> for TemplateStatusType {
  fn from(s: myoxus_domain::template_registry::TemplateStatus) -> Self {
    match s {
      myoxus_domain::template_registry::TemplateStatus::Active => Self::Active,
      myoxus_domain::template_registry::TemplateStatus::Disabled => Self::Disabled,
      myoxus_domain::template_registry::TemplateStatus::Archived => Self::Archived,
    }
  }
}

impl From<TemplateStatusType> for myoxus_domain::template_registry::TemplateStatus {
  fn from(s: TemplateStatusType) -> Self {
    match s {
      TemplateStatusType::Active => Self::Active,
      TemplateStatusType::Disabled => Self::Disabled,
      TemplateStatusType::Archived => Self::Archived,
    }
  }
}

/// Revision state as a GraphQL enum.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum RevisionStateType {
  Draft,
  Validated,
  Published,
  Deprecated,
  Archived,
}

impl From<myoxus_domain::template_registry::RevisionState> for RevisionStateType {
  fn from(s: myoxus_domain::template_registry::RevisionState) -> Self {
    match s {
      myoxus_domain::template_registry::RevisionState::Draft => Self::Draft,
      myoxus_domain::template_registry::RevisionState::Validated => Self::Validated,
      myoxus_domain::template_registry::RevisionState::Published => Self::Published,
      myoxus_domain::template_registry::RevisionState::Deprecated => Self::Deprecated,
      myoxus_domain::template_registry::RevisionState::Archived => Self::Archived,
    }
  }
}

/// Validation severity as a GraphQL enum.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum ValidationSeverityType {
  Error,
  Warning,
}

impl From<bundle::ValidationSeverity> for ValidationSeverityType {
  fn from(s: bundle::ValidationSeverity) -> Self {
    match s {
      bundle::ValidationSeverity::Error => Self::Error,
      bundle::ValidationSeverity::Warning => Self::Warning,
    }
  }
}

/// Template source discriminator.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum TemplateSourceType {
  Bundle,
  Builtin,
}

impl From<TemplateSource> for TemplateSourceType {
  fn from(s: TemplateSource) -> Self {
    match s {
      TemplateSource::Bundle => Self::Bundle,
      TemplateSource::Builtin => Self::Builtin,
    }
  }
}

/// A template catalog entry as exposed via GraphQL.
#[derive(SimpleObject, Clone)]
pub struct TemplateCatalogEntryType {
  pub id: ID,
  pub slug: String,
  pub title: String,
  pub description: Option<String>,
  pub category: Option<String>,
  pub tags: Vec<String>,
  pub status: TemplateStatusType,
  pub source: TemplateSourceType,
  pub builder_version: Option<i32>,
  pub min_client_version: i32,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub archived_at: Option<DateTime<Utc>>,
}

impl From<myoxus_domain::template_registry::TemplateCatalogEntry> for TemplateCatalogEntryType {
  fn from(e: myoxus_domain::template_registry::TemplateCatalogEntry) -> Self {
    Self {
      id: ID::from(e.id),
      slug: e.slug,
      title: e.title,
      description: e.description,
      category: e.category,
      tags: e.tags,
      status: e.status.into(),
      source: e.source.into(),
      builder_version: e.builder_version.map(|v| v as i32),
      min_client_version: e.min_client_version as i32,
      created_at: e.created_at,
      updated_at: e.updated_at,
      archived_at: e.archived_at,
    }
  }
}

/// A template revision as exposed via GraphQL.
#[derive(SimpleObject, Clone)]
pub struct TemplateRevisionType {
  pub id: ID,
  pub template_id: ID,
  pub version: String,
  pub state: RevisionStateType,
  pub checksum: Option<String>,
  /// File-owned locale, title and purpose metadata of this immutable revision.
  pub manifest: Option<async_graphql::Json<serde_json::Value>>,
  pub release_notes: Option<String>,
  pub created_by: Option<String>,
  pub created_at: DateTime<Utc>,
  pub published_at: Option<DateTime<Utc>>,
}

impl From<myoxus_domain::template_registry::TemplateRevision> for TemplateRevisionType {
  fn from(r: myoxus_domain::template_registry::TemplateRevision) -> Self {
    Self {
      id: ID::from(r.id),
      template_id: ID::from(r.template_id),
      version: r.version,
      state: r.state.into(),
      checksum: r.checksum,
      manifest: r.manifest.map(async_graphql::Json),
      release_notes: r.release_notes,
      created_by: r.created_by.map(|u| u.to_string()),
      created_at: r.created_at,
      published_at: r.published_at,
    }
  }
}

/// A validation error/warning from bundle import.
#[derive(SimpleObject, Clone)]
pub struct ValidationErrorType {
  pub code: String,
  pub message: String,
  pub field: Option<String>,
  pub path: Option<String>,
  pub severity: ValidationSeverityType,
}

impl From<bundle::ValidationError> for ValidationErrorType {
  fn from(e: bundle::ValidationError) -> Self {
    Self {
      code: e.code,
      message: e.message,
      field: e.field,
      path: e.path,
      severity: e.severity.into(),
    }
  }
}

/// Result of a template bundle import.
#[derive(SimpleObject, Clone)]
pub struct TemplateImportResultType {
  // Keep the deployed result envelope stable. Current imports return one native
  // document; Basis owns onboarding, so package/job_id/error remain unpopulated.
  /// Single-document catalog entry; packages expose their actual children.
  pub entry: Option<TemplateCatalogEntryType>,
  /// Single-document revision, validated through the existing import owner.
  pub revision: Option<TemplateRevisionType>,
  /// Actual persisted children; a package never creates a synthetic entry.
  pub documents: Vec<TemplateImportedDocumentType>,
  pub package: Option<async_graphql::Json<serde_json::Value>>,
  pub job_id: Option<ID>,
  /// Present when some child writes/publications failed. Persisted children
  /// remain visible and importing the same package resumes idempotently.
  pub error: Option<String>,
  /// Any validation warnings (non-fatal issues).
  pub warnings: Vec<ValidationErrorType>,
  /// Detected input format (`myoxus_bundle`, `upstream_snapshot_zip`, ...).
  pub detected_format: String,
  /// Whether the import required normalization from a non-canonical input.
  pub normalized: bool,
  /// Number of ignored noisy ZIP entries (for example `__MACOSX/**`).
  pub ignored_entries_count: i32,
  /// Version tag of the server-side template error catalog.
  pub error_catalog_version: String,
}

#[derive(SimpleObject, Clone)]
pub struct TemplateImportedDocumentType {
  pub entry: TemplateCatalogEntryType,
  pub revision: TemplateRevisionType,
}

/// Selection mode for a workspace template policy.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum SelectionModeType {
  Published,
  PinnedRevision,
}

impl From<SelectionMode> for SelectionModeType {
  fn from(s: SelectionMode) -> Self {
    match s {
      SelectionMode::Published => Self::Published,
      SelectionMode::PinnedRevision => Self::PinnedRevision,
    }
  }
}

impl From<SelectionModeType> for SelectionMode {
  fn from(s: SelectionModeType) -> Self {
    match s {
      SelectionModeType::Published => Self::Published,
      SelectionModeType::PinnedRevision => Self::PinnedRevision,
    }
  }
}

/// Provisioning mode for a workspace template policy.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum ProvisioningModeType {
  SeedOnce,
  ManagedUntilLocalEdit,
  ManualUpdate,
}

impl From<ProvisioningMode> for ProvisioningModeType {
  fn from(s: ProvisioningMode) -> Self {
    match s {
      ProvisioningMode::SeedOnce => Self::SeedOnce,
      ProvisioningMode::ManagedUntilLocalEdit => Self::ManagedUntilLocalEdit,
      ProvisioningMode::ManualUpdate => Self::ManualUpdate,
    }
  }
}

impl From<ProvisioningModeType> for ProvisioningMode {
  fn from(s: ProvisioningModeType) -> Self {
    match s {
      ProvisioningModeType::SeedOnce => Self::SeedOnce,
      ProvisioningModeType::ManagedUntilLocalEdit => Self::ManagedUntilLocalEdit,
      ProvisioningModeType::ManualUpdate => Self::ManualUpdate,
    }
  }
}

/// Instance state as a GraphQL enum.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum InstanceStateType {
  Ok,
  UpdateAvailable,
  Detached,
  Retired,
  Error,
}

impl From<InstanceState> for InstanceStateType {
  fn from(s: InstanceState) -> Self {
    match s {
      InstanceState::Ok => Self::Ok,
      InstanceState::UpdateAvailable => Self::UpdateAvailable,
      InstanceState::Detached => Self::Detached,
      InstanceState::Retired => Self::Retired,
      InstanceState::Error => Self::Error,
    }
  }
}

/// A workspace template policy as exposed via GraphQL.
#[derive(SimpleObject, Clone)]
pub struct WorkspaceTemplatePolicyType {
  pub id: ID,
  pub workspace_id: String,
  pub template_id: ID,
  pub selection_mode: SelectionModeType,
  pub selected_revision_id: Option<ID>,
  pub provisioning_mode: ProvisioningModeType,
  pub is_enabled: bool,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl From<myoxus_domain::template_registry::WorkspaceTemplatePolicy> for WorkspaceTemplatePolicyType {
  fn from(p: myoxus_domain::template_registry::WorkspaceTemplatePolicy) -> Self {
    Self {
      id: ID::from(p.id),
      workspace_id: p.workspace_id.to_string(),
      template_id: ID::from(p.template_id),
      selection_mode: p.selection_mode.into(),
      selected_revision_id: p.selected_revision_id.map(ID::from),
      provisioning_mode: p.provisioning_mode.into(),
      is_enabled: p.is_enabled,
      created_at: p.created_at,
      updated_at: p.updated_at,
    }
  }
}

/// A workspace template instance as exposed via GraphQL.
#[derive(SimpleObject, Clone)]
pub struct WorkspaceTemplateInstanceType {
  pub id: ID,
  pub workspace_id: String,
  pub template_id: ID,
  pub revision_id: ID,
  pub workspace_doc_id: Option<String>,
  pub state: InstanceStateType,
  pub last_applied_hash: Option<String>,
  pub current_hash: Option<String>,
  pub last_synced_at: Option<DateTime<Utc>>,
  pub detached_at: Option<DateTime<Utc>>,
  pub retired_at: Option<DateTime<Utc>>,
  pub last_error_code: Option<String>,
  pub last_error_message: Option<String>,
}

impl From<myoxus_domain::template_registry::WorkspaceTemplateInstance> for WorkspaceTemplateInstanceType {
  fn from(i: myoxus_domain::template_registry::WorkspaceTemplateInstance) -> Self {
    Self {
      id: ID::from(i.id),
      workspace_id: i.workspace_id.to_string(),
      template_id: ID::from(i.template_id),
      revision_id: ID::from(i.revision_id),
      workspace_doc_id: i
        .workspace_doc_key
        .or_else(|| i.workspace_doc_id.map(|d| d.to_string())),
      state: i.state.into(),
      last_applied_hash: i.last_applied_hash,
      current_hash: i.current_hash,
      last_synced_at: i.last_synced_at,
      detached_at: i.detached_at,
      retired_at: i.retired_at,
      last_error_code: i.last_error_code,
      last_error_message: i.last_error_message,
    }
  }
}

/// Job state as a GraphQL enum.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum JobStateType {
  Pending,
  Running,
  Completed,
  Failed,
  Cancelled,
}

impl From<myoxus_domain::template_registry::JobState> for JobStateType {
  fn from(s: myoxus_domain::template_registry::JobState) -> Self {
    match s {
      myoxus_domain::template_registry::JobState::Pending => Self::Pending,
      myoxus_domain::template_registry::JobState::Running => Self::Running,
      myoxus_domain::template_registry::JobState::Completed => Self::Completed,
      myoxus_domain::template_registry::JobState::Failed => Self::Failed,
      myoxus_domain::template_registry::JobState::Cancelled => Self::Cancelled,
    }
  }
}

/// Job type discriminator (import vs reconcile).
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum TemplateJobKind {
  Import,
  Reconcile,
}

/// Unified view of template import and reconcile jobs.
#[derive(SimpleObject, Clone)]
pub struct TemplateJobType {
  pub id: ID,
  pub job_type: TemplateJobKind,
  pub state: JobStateType,
  pub template_id: Option<String>,
  pub workspace_id: Option<String>,
  pub started_at: Option<DateTime<Utc>>,
  pub finished_at: Option<DateTime<Utc>>,
  pub summary_json: Option<String>,
}

// ─── Builtin Bridge Types (P125-TPL-S-04) ────────────────────────────────────

/// One entry in the reconcile-slugs response: tells the client whether to build,
/// replace, or retire a builtin template document in this workspace.
#[derive(SimpleObject, Clone)]
pub struct BuiltinReconcileEntryType {
  pub slug: String,
  pub builder_version: i32,
  /// SHA-256 hex of `slug|builder_version|locale` — server-computed.
  pub expected_hash: String,
  pub provisioning_mode: ProvisioningModeType,
  /// Hash of the last client-applied build, if any.
  pub applied_hash: Option<String>,
  /// Document id of the current workspace instance, if one exists.
  pub workspace_doc_id: Option<ID>,
  /// Server-owned lifecycle state of the current workspace binding.
  pub instance_state: Option<InstanceStateType>,
  /// Whether the instance currently exists in this workspace.
  pub has_instance: bool,
}

impl From<myoxus_domain::template_registry::BuiltinReconcileEntry> for BuiltinReconcileEntryType {
  fn from(e: myoxus_domain::template_registry::BuiltinReconcileEntry) -> Self {
    let applied_hash = e.current_instance.as_ref().and_then(|i| i.applied_hash.clone());
    // Compatibility field: callers historically interpreted this as source
    // readiness. Keep the field while tightening it to a live attributed doc.
    let has_instance = e
      .current_instance
      .as_ref()
      .is_some_and(|instance| instance.source_available);
    Self {
      slug: e.slug,
      builder_version: e.builder_version as i32,
      expected_hash: e.expected_hash,
      provisioning_mode: e.provisioning_mode.into(),
      applied_hash,
      workspace_doc_id: e.current_instance.as_ref().and_then(|i| {
        i.workspace_doc_key
          .clone()
          .or_else(|| i.workspace_doc_id.map(|doc_id| doc_id.to_string()))
          .map(ID::from)
      }),
      instance_state: e.current_instance.as_ref().map(|i| i.state.into()),
      has_instance,
    }
  }
}

/// Input for `reportTemplateBuilderApplied`.
#[derive(InputObject)]
pub struct ReportBuilderAppliedInput {
  pub workspace_id: String,
  pub slug: String,
  pub applied_hash: String,
  pub locale: String,
  pub doc_id: Option<String>,
}

/// Input for `setWorkspaceTemplateOverride`.
#[derive(InputObject)]
pub struct SetWorkspaceTemplateOverrideInput {
  pub workspace_id: String,
  pub template_id: String,
  pub is_enabled: bool,
  pub provisioning_mode: Option<ProvisioningModeType>,
}

/// Input for `setTemplateDefaultPolicy` (admin).
#[derive(Debug, InputObject)]
pub struct SetTemplateDefaultPolicyInput {
  pub template_id: String,
  pub apply_to_new_workspaces: bool,
  pub selection_mode: SelectionModeType,
  pub provisioning_mode: ProvisioningModeType,
}

/// Result of `bumpBuilderVersion` — includes the new version and
/// the number of workspaces notified via `template:reconcile-needed` push.
#[derive(SimpleObject, Clone)]
pub struct BumpBuilderVersionResult {
  pub slug: String,
  pub new_version: i32,
  pub workspaces_notified: i32,
}

/// A template default policy as exposed via GraphQL.
#[derive(SimpleObject, Clone)]
pub struct TemplateDefaultPolicyType {
  /// Template catalog entry ID this policy applies to.
  pub template_id: String,
  pub apply_to_new_workspaces: bool,
  pub selection_mode: SelectionModeType,
  pub provisioning_mode: ProvisioningModeType,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl From<myoxus_domain::template_registry::TemplateDefaultPolicy> for TemplateDefaultPolicyType {
  fn from(p: myoxus_domain::template_registry::TemplateDefaultPolicy) -> Self {
    Self {
      template_id: p.template_id.to_string(),
      apply_to_new_workspaces: p.apply_to_new_workspaces,
      selection_mode: p.selection_mode.into(),
      provisioning_mode: p.provisioning_mode.into(),
      created_at: p.created_at,
      updated_at: p.updated_at,
    }
  }
}

/// Check whether the template registry is enabled at runtime.
///
#[instrument(skip_all)]
pub async fn is_template_registry_enabled(state: &ApiState) -> bool {
  state
    .effective_config()
    .await
    .bool("template_registry.enabled")
    .unwrap_or(state.config_file_baseline.template_registry.enabled)
}

/// Get the template registry service or return an error if disabled.
/// Used by MUTATIONS that must fail explicitly when disabled.
/// Checks the runtime enabled flag (app_configs DB) — no restart needed.
pub(crate) async fn require_template_registry(
  state: &Arc<ApiState>,
) -> Result<&myoxus_application::template_registry::TemplateRegistryService> {
  if !is_template_registry_enabled(state).await {
    return Err(async_graphql::Error::new("template registry is not enabled"));
  }
  state
    .template_registry()
    .ok_or_else(|| async_graphql::Error::new("template registry service not initialized"))
}

/// Get the template registry service, returning None if disabled at runtime.
/// Used by QUERIES that should return empty data instead of crashing.
pub(crate) async fn optional_template_registry(
  state: &Arc<ApiState>,
) -> Option<&myoxus_application::template_registry::TemplateRegistryService> {
  if !is_template_registry_enabled(state).await {
    return None;
  }
  state.template_registry()
}
