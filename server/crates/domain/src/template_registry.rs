//! Template Registry domain model — catalog entries, revisions, policies, instances.
//!
//! This module defines the pure domain types for the centrally administered
//! Template Registry feature.  Templates are imported as bundles, versioned,
//! assigned to workspaces via policies, and materialized as normal workspace
//! documents.  All types are persistence-agnostic and carry no I/O dependencies
//! beyond `uuid`, `chrono`, `serde`, and `serde_json`.
//!
//! ## Builtin Bridge (P125-TPL §3)
//!
//! Builtin templates (`source = Builtin`) are code-built in the web client and
//! versioned via `builder_version`.  The server stores their expected hash as
//! `sha256_hex(slug | builder_version | locale)`.  Clients compare this against
//! `applied_hash` to detect drift and decide whether to rebuild.

use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::ids::{DocId, UserId, WorkspaceId};

// ─── Type Aliases ────────────────────────────────────────────────────────────

/// Identifier for a [`TemplateDefaultPolicy`].
pub type TemplateDefaultPolicyId = Uuid;

/// Identifier for a [`TemplateCatalogEntry`].
pub type TemplateCatalogEntryId = Uuid;
/// Identifier for a [`TemplateRevision`].
pub type TemplateRevisionId = Uuid;
/// Identifier for a [`WorkspaceTemplatePolicy`].
pub type WorkspaceTemplatePolicyId = Uuid;
/// Identifier for a [`WorkspaceTemplateInstance`].
pub type WorkspaceTemplateInstanceId = Uuid;
/// Identifier for a [`TemplateImportJob`].
pub type TemplateImportJobId = Uuid;
/// Identifier for a [`TemplateReconcileJob`].
pub type TemplateReconcileJobId = Uuid;
/// Identifier for a [`TemplateRegistryAuditEvent`].
pub type TemplateRegistryAuditEventId = Uuid;

fn default_source_format() -> String {
  "legacy_unknown".to_string()
}

fn default_normalizer_version() -> String {
  "none".to_string()
}

fn default_detected_format() -> String {
  "unknown".to_string()
}

fn default_error_catalog_version() -> String {
  "unknown".to_string()
}

fn default_normalization_warnings() -> Vec<NormalizationWarning> {
  Vec::new()
}

// ─── Enums ──────────────────────────────────────────────────────────────────

/// Source of a template catalog entry — determines how the template content is
/// produced and versioned.
///
/// - `Bundle`: imported via ZIP bundle upload; content lives in `template_revisions`.
/// - `Builtin`: code-built by the web client; versioned via `builder_version`; no
///   blob storage involved.  The client's builder must match the registry entry.
///
/// See myoxus-template-registry-builtin-bridge.md §3.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TemplateSource {
  Bundle,
  Builtin,
}

impl TemplateSource {
  /// Database representation (lowercase).
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Bundle => "bundle",
      Self::Builtin => "builtin",
    }
  }
}

impl fmt::Display for TemplateSource {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(self.as_str())
  }
}

impl FromStr for TemplateSource {
  type Err = String;

  fn from_str(s: &str) -> Result<Self, Self::Err> {
    match s {
      "bundle" => Ok(Self::Bundle),
      "builtin" => Ok(Self::Builtin),
      _ => Err(format!("invalid template source: {s}")),
    }
  }
}

impl TemplateSource {
  /// Used by serde `default` attribute on `TemplateCatalogEntry.source`.
  pub fn default_bundle() -> Self {
    Self::Bundle
  }
}

/// Compute the expected hash for a builtin template instance.
///
/// `sha256_hex(slug | builder_version | locale)` — identical computation is
/// performed client-side in `computeExpectedHash`.  A mismatch indicates the
/// local doc was built with a different builder version or under a different
/// locale and must be rebuilt.  See §5.
pub fn compute_builtin_expected_hash(slug: &str, builder_version: u32, locale: &str) -> String {
  use sha2::{Digest, Sha256};
  let mut h = Sha256::new();
  h.update(slug.as_bytes());
  h.update(b"|");
  h.update(builder_version.to_string().as_bytes());
  h.update(b"|");
  h.update(locale.as_bytes());
  format!("{:x}", h.finalize())
}

/// Lifecycle status of a template catalog entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TemplateStatus {
  /// Template is available for assignment and provisioning.
  Active,
  /// Template is temporarily disabled — existing instances remain, but no new
  /// assignments or reconcile runs are processed.
  Disabled,
  /// Template is retired and hidden from the catalog. Existing instances
  /// transition to `Retired`.
  Archived,
}

impl fmt::Display for TemplateStatus {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Active => f.write_str("Active"),
      Self::Disabled => f.write_str("Disabled"),
      Self::Archived => f.write_str("Archived"),
    }
  }
}

/// Lifecycle state of a template revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RevisionState {
  /// Revision has been imported but not yet validated.
  Draft,
  /// Revision has passed validation checks.
  Validated,
  /// Revision is published and available for workspace provisioning.
  Published,
  /// Revision is superseded by a newer published version.
  Deprecated,
  /// Revision is permanently retired and no longer usable.
  Archived,
}

impl fmt::Display for RevisionState {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Draft => f.write_str("Draft"),
      Self::Validated => f.write_str("Validated"),
      Self::Published => f.write_str("Published"),
      Self::Deprecated => f.write_str("Deprecated"),
      Self::Archived => f.write_str("Archived"),
    }
  }
}

/// A normalization warning captured while importing a template revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizationWarning {
  /// Machine-readable warning code.
  pub code: String,
  /// Human-readable warning message.
  pub message: String,
  /// Optional manifest field associated with the warning.
  pub field: Option<String>,
  /// Optional JSON pointer path associated with the warning.
  pub path: Option<String>,
}

/// How the target revision is selected for a workspace policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SelectionMode {
  /// Always use the latest published revision.
  Published,
  /// Pin to a specific revision ID.
  PinnedRevision,
}

impl fmt::Display for SelectionMode {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Published => f.write_str("Published"),
      Self::PinnedRevision => f.write_str("PinnedRevision"),
    }
  }
}

/// How the template is provisioned into the workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProvisioningMode {
  /// Materialize once; never update automatically.
  SeedOnce,
  /// Managed by the server until a local edit is detected (then detached).
  ManagedUntilLocalEdit,
  /// Never update automatically; admin must trigger updates manually.
  ManualUpdate,
}

impl fmt::Display for ProvisioningMode {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::SeedOnce => f.write_str("SeedOnce"),
      Self::ManagedUntilLocalEdit => f.write_str("ManagedUntilLocalEdit"),
      Self::ManualUpdate => f.write_str("ManualUpdate"),
    }
  }
}

/// Runtime state of a materialized template instance in a workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InstanceState {
  /// Instance is in sync with the assigned revision.
  Ok,
  /// A newer revision is available but not yet applied.
  UpdateAvailable,
  /// Local changes detected — automatic updates are suspended.
  Detached,
  /// The policy has been removed; the instance is orphaned.
  Retired,
  /// An error occurred during materialization or reconciliation.
  Error,
}

impl fmt::Display for InstanceState {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Ok => f.write_str("Ok"),
      Self::UpdateAvailable => f.write_str("UpdateAvailable"),
      Self::Detached => f.write_str("Detached"),
      Self::Retired => f.write_str("Retired"),
      Self::Error => f.write_str("Error"),
    }
  }
}

/// Scope of a reconcile job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReconcileScope {
  /// Reconcile a single workspace.
  Workspace,
  /// Reconcile all workspaces assigned to a specific template.
  Template,
  /// Reconcile all template assignments globally.
  Global,
}

impl fmt::Display for ReconcileScope {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Workspace => f.write_str("Workspace"),
      Self::Template => f.write_str("Template"),
      Self::Global => f.write_str("Global"),
    }
  }
}

/// Lifecycle state of an import or reconcile job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JobState {
  Pending,
  Running,
  Completed,
  Failed,
  Cancelled,
}

impl fmt::Display for JobState {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Pending => f.write_str("Pending"),
      Self::Running => f.write_str("Running"),
      Self::Completed => f.write_str("Completed"),
      Self::Failed => f.write_str("Failed"),
      Self::Cancelled => f.write_str("Cancelled"),
    }
  }
}

/// Coarse-grained action recorded for a template registry audit event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TemplateRegistryAuditAction {
  Created,
  Updated,
  Deleted,
  Imported,
  Validated,
  Published,
  Assigned,
  Reconciled,
  Scanned,
  Detached,
  Exported,
  Failed,
}

impl fmt::Display for TemplateRegistryAuditAction {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Created => f.write_str("Created"),
      Self::Updated => f.write_str("Updated"),
      Self::Deleted => f.write_str("Deleted"),
      Self::Imported => f.write_str("Imported"),
      Self::Validated => f.write_str("Validated"),
      Self::Published => f.write_str("Published"),
      Self::Assigned => f.write_str("Assigned"),
      Self::Reconciled => f.write_str("Reconciled"),
      Self::Scanned => f.write_str("Scanned"),
      Self::Detached => f.write_str("Detached"),
      Self::Exported => f.write_str("Exported"),
      Self::Failed => f.write_str("Failed"),
    }
  }
}

/// Default-policy entry that drives automatic per-workspace seeding.
///
/// When a workspace is created, the server inserts one `workspace_template_policies`
/// row per `template_default_policies` entry where `apply_to_new_workspaces = true`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateDefaultPolicy {
  /// The template this policy applies to.
  pub template_id: TemplateCatalogEntryId,
  /// If true, a workspace policy is created for every newly created workspace.
  pub apply_to_new_workspaces: bool,
  /// How the target revision is selected.
  pub selection_mode: SelectionMode,
  /// How the template is provisioned into the workspace.
  pub provisioning_mode: ProvisioningMode,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Per-slug reconcile information returned by `workspaceTemplateReconcileSlugs`.
///
/// Carries everything the client needs to execute the §6 reconcile algorithm
/// without a second round-trip.
#[derive(Debug, Clone)]
pub struct BuiltinReconcileEntry {
  pub slug: String,
  pub builder_version: u32,
  pub expected_hash: String,
  pub provisioning_mode: ProvisioningMode,
  /// Existing instance state, if any.
  pub current_instance: Option<BuiltinInstanceState>,
}

/// Snapshot of an existing builtin instance for the client reconcile query.
#[derive(Debug, Clone)]
pub struct BuiltinInstanceState {
  pub state: InstanceState,
  pub applied_hash: Option<String>,
  pub locale_hash: Option<String>,
  /// True only when the bound document still exists as a live, correctly
  /// attributed workspace source. A persisted binding row alone is not ready.
  pub source_available: bool,
  /// Client-facing document key. This is the value the web client must use
  /// to find the document in its workspace store.
  pub workspace_doc_key: Option<String>,
  /// Database FK when the materialized document row is already known.
  pub workspace_doc_id: Option<DocId>,
}

// ─── Domain Errors ──────────────────────────────────────────────────────────

/// Errors from domain guard violations in the template registry.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TemplateRegistryDomainError {
  #[error("invalid revision state transition from {from} to {to}")]
  InvalidRevisionTransition { from: String, to: String },

  #[error("invalid instance state transition from {from} to {to}")]
  InvalidInstanceTransition { from: String, to: String },

  #[error("cannot publish revision: current state is {0}, expected Validated")]
  CannotPublishNonValidated(RevisionState),

  #[error("cannot assign disabled template to workspace")]
  TemplateDisabled,

  #[error("cannot assign archived template to workspace")]
  TemplateArchived,
}

// ─── Entities ────────────────────────────────────────────────────────────────

/// A template catalog entry — the top-level identity of a template.
///
/// Templates are identified by a stable `slug` for human-readable references
/// and a UUID `id` for database relations.
///
/// ## Builtin templates (P125-TPL §3.1)
///
/// When `source == Builtin`, `builder_version` is mandatory and `min_client_version`
/// indicates the minimum client build that understands the builder contract.  There
/// are no bundle revisions for builtins — the client builds the doc locally.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateCatalogEntry {
  pub id: TemplateCatalogEntryId,
  /// URL-safe, unique human-readable identifier (e.g. `"weekly-standup"`).
  pub slug: String,
  /// Display name shown in the admin UI.
  pub title: String,
  /// Markdown-formatted description of the template's purpose and contents.
  pub description: Option<String>,
  /// Organisational category (e.g. `"project-management"`, `"meeting-notes"`).
  pub category: Option<String>,
  /// Free-form tags for filtering and search.
  pub tags: Vec<String>,
  /// Lifecycle status controlling visibility and assignability.
  pub status: TemplateStatus,
  /// Whether the template is code-built (builtin) or bundle-imported (bundle).
  /// See `TemplateSource` and §3.1.
  #[serde(default = "TemplateSource::default_bundle")]
  pub source: TemplateSource,
  /// Monotonically increasing counter for builtin templates.  `None` for bundles.
  /// A bump triggers a `template:reconcile-needed` push to all active clients.
  pub builder_version: Option<u32>,
  /// Minimum client build version required to execute this builder.  0 = no minimum.
  #[serde(default)]
  pub min_client_version: u32,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  /// Set when the template is archived. `None` means it is active or disabled.
  pub archived_at: Option<DateTime<Utc>>,
}

impl TemplateCatalogEntry {
  /// Check whether this template can be assigned to a workspace.
  pub fn can_assign(&self) -> Result<(), TemplateRegistryDomainError> {
    match self.status {
      TemplateStatus::Active => Ok(()),
      TemplateStatus::Disabled => Err(TemplateRegistryDomainError::TemplateDisabled),
      TemplateStatus::Archived => Err(TemplateRegistryDomainError::TemplateArchived),
    }
  }
}

/// A versioned revision of a template, imported from a bundle.
///
/// Revisions follow a lifecycle: `Draft → Validated → Published → Deprecated → Archived`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateRevision {
  pub id: TemplateRevisionId,
  /// The catalog entry this revision belongs to.
  pub template_id: TemplateCatalogEntryId,
  /// Semantic version string (e.g. `"1.0.0"`, `"2.3.1"`).
  pub version: String,
  /// Lifecycle state of this revision.
  pub state: RevisionState,
  /// Storage key/ID for the imported bundle blob.
  pub bundle_blob_id: Option<String>,
  /// Storage key/ID for a preview image (SVG, PNG).
  pub preview_blob_id: Option<String>,
  /// SHA-256 hex checksum of the bundle content.
  pub checksum: Option<String>,
  /// Parsed manifest from the bundle as JSON.
  pub manifest: Option<Value>,
  /// Human-readable release notes for this version.
  pub release_notes: Option<String>,
  /// User who imported/created this revision.
  pub created_by: Option<UserId>,
  pub created_at: DateTime<Utc>,
  /// Set when the revision transitions to `Published`.
  pub published_at: Option<DateTime<Utc>>,
  /// High-level format family of the import source.
  #[serde(default = "default_source_format")]
  pub source_format: String,
  /// Normalizer implementation/version used during import.
  #[serde(default = "default_normalizer_version")]
  pub normalizer_version: String,
  /// Detected bundle/snapshot format from the importer.
  #[serde(default = "default_detected_format")]
  pub detected_format: String,
  /// Number of ignored non-semantic ZIP entries (e.g. metadata files).
  #[serde(default)]
  pub ignored_entries_count: u32,
  /// Error catalog version used by the import pipeline.
  #[serde(default = "default_error_catalog_version")]
  pub error_catalog_version: String,
  /// Normalization warnings captured during import.
  #[serde(default = "default_normalization_warnings")]
  pub normalization_warnings: Vec<NormalizationWarning>,
}

impl TemplateRevision {
  /// Validate that this revision can be published.
  ///
  /// Only `Validated` revisions can transition to `Published`.
  pub fn can_publish(&self) -> Result<(), TemplateRegistryDomainError> {
    if self.state != RevisionState::Validated {
      return Err(TemplateRegistryDomainError::CannotPublishNonValidated(self.state));
    }
    Ok(())
  }

  /// Transition from `Draft` to `Validated`.
  pub fn mark_validated(&mut self) -> Result<(), TemplateRegistryDomainError> {
    if self.state != RevisionState::Draft {
      return Err(TemplateRegistryDomainError::InvalidRevisionTransition {
        from: self.state.to_string(),
        to: RevisionState::Validated.to_string(),
      });
    }
    self.state = RevisionState::Validated;
    Ok(())
  }

  /// Transition from `Validated` to `Published`.
  pub fn publish(&mut self) -> Result<(), TemplateRegistryDomainError> {
    self.can_publish()?;
    self.state = RevisionState::Published;
    self.published_at = Some(Utc::now());
    Ok(())
  }

  /// Transition to `Deprecated` (from `Published` only).
  pub fn deprecate(&mut self) -> Result<(), TemplateRegistryDomainError> {
    if self.state != RevisionState::Published {
      return Err(TemplateRegistryDomainError::InvalidRevisionTransition {
        from: self.state.to_string(),
        to: RevisionState::Deprecated.to_string(),
      });
    }
    self.state = RevisionState::Deprecated;
    Ok(())
  }
}

/// Policy defining which template revision should be provisioned into a workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceTemplatePolicy {
  pub id: WorkspaceTemplatePolicyId,
  /// Target workspace for this policy.
  pub workspace_id: WorkspaceId,
  /// Template catalog entry this policy references.
  pub template_id: TemplateCatalogEntryId,
  /// How the target revision is determined.
  pub selection_mode: SelectionMode,
  /// Set when `selection_mode` is `PinnedRevision`. Ignored otherwise.
  pub selected_revision_id: Option<TemplateRevisionId>,
  /// How the template is provisioned and updated.
  pub provisioning_mode: ProvisioningMode,
  /// Whether this policy is active. Disabled policies are not processed by reconcile.
  pub is_enabled: bool,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// A materialized template instance — a real workspace document created from
/// a template revision (bundle) or a code-built document (builtin).
///
/// ## Builtin hash fields (P125-TPL §3.2 + §5)
///
/// `expected_hash` = `sha256_hex(slug | builder_version | locale)`, computed
/// server-side at reconcile time.  Clients compare their `applied_hash` against
/// this to detect drift; a mismatch triggers a rebuild per §6 algorithm.
/// `locale_hash` stores the locale key used at last apply so a locale-change
/// can be detected even when `builder_version` is unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceTemplateInstance {
  pub id: WorkspaceTemplateInstanceId,
  /// Workspace where this instance lives.
  pub workspace_id: WorkspaceId,
  /// Template catalog entry this instance was created from.
  pub template_id: TemplateCatalogEntryId,
  /// The revision that was materialized for revision-backed bundle templates.
  /// Builtin template rows in the database intentionally keep
  /// `workspace_template_instances.revision_id` NULL and are exposed through
  /// the builtin reconcile bridge, not through this domain type.
  pub revision_id: TemplateRevisionId,
  /// The workspace document ID created by materialization.
  pub workspace_doc_id: Option<DocId>,
  /// Client-facing document key for the materialized document.
  ///
  /// UUID-backed docs use the UUID string; non-UUID browser docs use the same
  /// key that is stored in `docs.external_id`.
  pub workspace_doc_key: Option<String>,
  /// Current runtime state of this instance.
  pub state: InstanceState,
  /// SHA-256 hash of the document content at last successful materialization.
  pub last_applied_hash: Option<String>,
  /// SHA-256 hash of the document content at last drift scan.
  pub current_hash: Option<String>,
  /// Timestamp of the last successful synchronization.
  pub last_synced_at: Option<DateTime<Utc>>,
  /// Set when the instance transitions to `Detached`.
  pub detached_at: Option<DateTime<Utc>>,
  /// Set when the instance transitions to `Retired`.
  pub retired_at: Option<DateTime<Utc>>,
  /// Machine-readable error code from the last failed operation.
  pub last_error_code: Option<String>,
  /// Human-readable error message from the last failed operation.
  pub last_error_message: Option<String>,
  /// Server-computed expected hash for builtin templates; `None` for bundles.
  /// See §5 for hash derivation: `sha256_hex(slug | builder_version | locale)`.
  pub expected_hash: Option<String>,
  /// Locale tag under which this instance was last built (e.g. `"de"`, `"en"`).
  pub locale_hash: Option<String>,
}

impl WorkspaceTemplateInstance {
  /// Check if drift has been detected (content hash mismatch).
  pub fn has_drift(&self) -> bool {
    match (&self.last_applied_hash, &self.current_hash) {
      (Some(applied), Some(current)) => applied != current,
      _ => false,
    }
  }

  /// Transition to `Detached` state (local changes detected).
  pub fn detach(&mut self) -> Result<(), TemplateRegistryDomainError> {
    if self.state == InstanceState::Retired {
      return Err(TemplateRegistryDomainError::InvalidInstanceTransition {
        from: self.state.to_string(),
        to: InstanceState::Detached.to_string(),
      });
    }
    self.state = InstanceState::Detached;
    self.detached_at = Some(Utc::now());
    Ok(())
  }

  /// Transition to `UpdateAvailable` state (target revision differs).
  pub fn mark_update_available(&mut self) -> Result<(), TemplateRegistryDomainError> {
    if self.state != InstanceState::Ok {
      return Err(TemplateRegistryDomainError::InvalidInstanceTransition {
        from: self.state.to_string(),
        to: InstanceState::UpdateAvailable.to_string(),
      });
    }
    self.state = InstanceState::UpdateAvailable;
    Ok(())
  }

  /// Transition to `Retired` state (policy removed).
  pub fn retire(&mut self) {
    self.state = InstanceState::Retired;
    self.retired_at = Some(Utc::now());
  }
}

/// Record of a template import job for audit and traceability.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateImportJob {
  pub id: TemplateImportJobId,
  /// Storage key/ID of the uploaded bundle blob.
  pub uploaded_blob_id: Option<String>,
  /// Resulting revision ID after successful import.
  pub result_revision_id: Option<TemplateRevisionId>,
  /// Current state of the import job.
  pub state: JobState,
  /// Validation report as structured JSON.
  pub validation_report: Option<Value>,
  /// User who initiated the import.
  pub created_by: Option<UserId>,
  pub started_at: Option<DateTime<Utc>>,
  pub finished_at: Option<DateTime<Utc>>,
}

/// Persisted audit event for template registry activity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateRegistryAuditEvent {
  pub id: TemplateRegistryAuditEventId,
  /// High-level action category for the event.
  pub action: TemplateRegistryAuditAction,
  /// Free-form event type name, e.g. `template.import.started`.
  pub event_type: String,
  pub actor_user_id: Option<UserId>,
  pub template_id: Option<TemplateCatalogEntryId>,
  pub revision_id: Option<TemplateRevisionId>,
  pub workspace_id: Option<WorkspaceId>,
  pub policy_id: Option<WorkspaceTemplatePolicyId>,
  pub instance_id: Option<WorkspaceTemplateInstanceId>,
  pub import_job_id: Option<TemplateImportJobId>,
  pub source_format: Option<String>,
  pub detected_format: Option<String>,
  pub normalizer_version: Option<String>,
  pub ignored_entries_count: Option<u32>,
  pub error_catalog_version: Option<String>,
  pub error_code: Option<String>,
  pub payload_json: Option<Value>,
  pub created_at: DateTime<Utc>,
}

/// Record of a template reconcile job for audit and traceability.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateReconcileJob {
  pub id: TemplateReconcileJobId,
  /// Scope of this reconcile run.
  pub scope: ReconcileScope,
  /// Set when scope is `Workspace`.
  pub workspace_id: Option<WorkspaceId>,
  /// Set when scope is `Template`.
  pub template_id: Option<TemplateCatalogEntryId>,
  /// Current state of the reconcile job.
  pub state: JobState,
  /// Summary of the reconcile results as structured JSON.
  pub summary: Option<Value>,
  pub started_at: Option<DateTime<Utc>>,
  pub finished_at: Option<DateTime<Utc>>,
}

// ─── Unit Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;

  // ── Helpers ──────────────────────────────────────────────────────────

  fn make_revision(state: RevisionState) -> TemplateRevision {
    TemplateRevision {
      id: Uuid::new_v4(),
      template_id: Uuid::new_v4(),
      version: "1.0.0".to_string(),
      state,
      bundle_blob_id: None,
      preview_blob_id: None,
      checksum: None,
      manifest: None,
      release_notes: None,
      created_by: None,
      created_at: Utc::now(),
      published_at: None,
      source_format: default_source_format(),
      normalizer_version: default_normalizer_version(),
      detected_format: default_detected_format(),
      ignored_entries_count: 0,
      error_catalog_version: default_error_catalog_version(),
      normalization_warnings: default_normalization_warnings(),
    }
  }

  fn make_instance(state: InstanceState) -> WorkspaceTemplateInstance {
    WorkspaceTemplateInstance {
      id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      template_id: Uuid::new_v4(),
      revision_id: Uuid::new_v4(),
      workspace_doc_id: None,
      workspace_doc_key: None,
      state,
      last_applied_hash: None,
      current_hash: None,
      last_synced_at: None,
      detached_at: None,
      retired_at: None,
      last_error_code: None,
      last_error_message: None,
      expected_hash: None,
      locale_hash: None,
    }
  }

  fn make_catalog_entry(status: TemplateStatus) -> TemplateCatalogEntry {
    TemplateCatalogEntry {
      id: Uuid::new_v4(),
      slug: "test-template".to_string(),
      title: "Test Template".to_string(),
      description: None,
      category: None,
      tags: vec![],
      status,
      source: TemplateSource::Bundle,
      builder_version: None,
      min_client_version: 0,
      created_at: Utc::now(),
      updated_at: Utc::now(),
      archived_at: None,
    }
  }

  // ── Revision state transitions ──────────────────────────────────────

  #[test]
  fn revision_draft_to_validated_ok() {
    let mut r = make_revision(RevisionState::Draft);
    assert!(r.mark_validated().is_ok());
    assert_eq!(r.state, RevisionState::Validated);
  }

  #[test]
  fn revision_validated_to_published_ok() {
    let mut r = make_revision(RevisionState::Validated);
    assert!(r.publish().is_ok());
    assert_eq!(r.state, RevisionState::Published);
    assert!(r.published_at.is_some());
  }

  #[test]
  fn revision_draft_cannot_publish() {
    let mut r = make_revision(RevisionState::Draft);
    let err = r.publish().unwrap_err();
    assert!(matches!(err, TemplateRegistryDomainError::CannotPublishNonValidated(_)));
  }

  #[test]
  fn revision_published_to_deprecated_ok() {
    let mut r = make_revision(RevisionState::Published);
    assert!(r.deprecate().is_ok());
    assert_eq!(r.state, RevisionState::Deprecated);
  }

  #[test]
  fn revision_draft_cannot_deprecate() {
    let mut r = make_revision(RevisionState::Draft);
    assert!(r.deprecate().is_err());
  }

  #[test]
  fn revision_validated_cannot_mark_validated_again() {
    let mut r = make_revision(RevisionState::Validated);
    assert!(r.mark_validated().is_err());
  }

  // ── Instance state transitions ──────────────────────────────────────

  #[test]
  fn instance_ok_can_detach() {
    let mut i = make_instance(InstanceState::Ok);
    assert!(i.detach().is_ok());
    assert_eq!(i.state, InstanceState::Detached);
    assert!(i.detached_at.is_some());
  }

  #[test]
  fn instance_retired_cannot_detach() {
    let mut i = make_instance(InstanceState::Retired);
    assert!(i.detach().is_err());
  }

  #[test]
  fn instance_ok_can_mark_update_available() {
    let mut i = make_instance(InstanceState::Ok);
    assert!(i.mark_update_available().is_ok());
    assert_eq!(i.state, InstanceState::UpdateAvailable);
  }

  #[test]
  fn instance_non_ok_cannot_mark_update_available() {
    let mut i = make_instance(InstanceState::Error);
    assert!(i.mark_update_available().is_err());
  }

  #[test]
  fn instance_retire_sets_state_and_timestamp() {
    let mut i = make_instance(InstanceState::Ok);
    i.retire();
    assert_eq!(i.state, InstanceState::Retired);
    assert!(i.retired_at.is_some());
  }

  // ── Drift detection ─────────────────────────────────────────────────

  #[test]
  fn instance_no_drift_when_hashes_match() {
    let mut i = make_instance(InstanceState::Ok);
    i.last_applied_hash = Some("abc123".to_string());
    i.current_hash = Some("abc123".to_string());
    assert!(!i.has_drift());
  }

  #[test]
  fn instance_drift_when_hashes_differ() {
    let mut i = make_instance(InstanceState::Ok);
    i.last_applied_hash = Some("abc123".to_string());
    i.current_hash = Some("def456".to_string());
    assert!(i.has_drift());
  }

  #[test]
  fn instance_no_drift_when_hashes_missing() {
    let i = make_instance(InstanceState::Ok);
    assert!(!i.has_drift());
  }

  // ── Catalog entry assignment guard ──────────────────────────────────

  #[test]
  fn active_template_can_assign() {
    let entry = make_catalog_entry(TemplateStatus::Active);
    assert!(entry.can_assign().is_ok());
  }

  #[test]
  fn disabled_template_cannot_assign() {
    let entry = make_catalog_entry(TemplateStatus::Disabled);
    assert!(matches!(
      entry.can_assign().unwrap_err(),
      TemplateRegistryDomainError::TemplateDisabled
    ));
  }

  #[test]
  fn archived_template_cannot_assign() {
    let entry = make_catalog_entry(TemplateStatus::Archived);
    assert!(matches!(
      entry.can_assign().unwrap_err(),
      TemplateRegistryDomainError::TemplateArchived
    ));
  }

  #[test]
  fn revision_deserialize_backfills_format_metadata_defaults() {
    let revision_json = serde_json::json!({
      "id": Uuid::new_v4(),
      "template_id": Uuid::new_v4(),
      "version": "1.0.0",
      "state": "Draft",
      "bundle_blob_id": null,
      "preview_blob_id": null,
      "checksum": null,
      "manifest": null,
      "release_notes": null,
      "created_by": null,
      "created_at": Utc::now(),
      "published_at": null
    });

    let revision: TemplateRevision = serde_json::from_value(revision_json).unwrap();
    assert_eq!(revision.source_format, "legacy_unknown");
    assert_eq!(revision.normalizer_version, "none");
    assert_eq!(revision.detected_format, "unknown");
    assert_eq!(revision.ignored_entries_count, 0);
    assert_eq!(revision.error_catalog_version, "unknown");
    assert!(revision.normalization_warnings.is_empty());
  }

  #[test]
  fn normalization_warning_roundtrip() {
    let warning = NormalizationWarning {
      code: "TRIMMED_TITLE".to_string(),
      message: "title was trimmed during normalization".to_string(),
      field: Some("title".to_string()),
      path: Some("/manifest/title".to_string()),
    };

    let json = serde_json::to_value(&warning).unwrap();
    let back: NormalizationWarning = serde_json::from_value(json).unwrap();
    assert_eq!(warning, back);
  }

  // ── Display impls ───────────────────────────────────────────────────

  #[test]
  fn template_source_roundtrip() {
    assert_eq!(TemplateSource::Bundle.as_str(), "bundle");
    assert_eq!(TemplateSource::Builtin.as_str(), "builtin");
    assert_eq!("bundle".parse::<TemplateSource>().unwrap(), TemplateSource::Bundle);
    assert_eq!("builtin".parse::<TemplateSource>().unwrap(), TemplateSource::Builtin);
    assert!("invalid".parse::<TemplateSource>().is_err());
  }

  #[test]
  fn compute_builtin_expected_hash_is_deterministic() {
    let h1 = compute_builtin_expected_hash("welcome-myoxus", 1, "de");
    let h2 = compute_builtin_expected_hash("welcome-myoxus", 1, "de");
    assert_eq!(h1, h2);
    assert_ne!(h1, compute_builtin_expected_hash("welcome-myoxus", 1, "en"));
    assert_ne!(h1, compute_builtin_expected_hash("welcome-myoxus", 2, "de"));
    assert_ne!(h1, compute_builtin_expected_hash("other-slug", 1, "de"));
    // hash is 64 hex chars (sha256)
    assert_eq!(h1.len(), 64);
  }

  #[test]
  fn enum_display_values() {
    assert_eq!(TemplateStatus::Active.to_string(), "Active");
    assert_eq!(TemplateStatus::Disabled.to_string(), "Disabled");
    assert_eq!(TemplateStatus::Archived.to_string(), "Archived");
    assert_eq!(RevisionState::Draft.to_string(), "Draft");
    assert_eq!(RevisionState::Published.to_string(), "Published");
    assert_eq!(SelectionMode::Published.to_string(), "Published");
    assert_eq!(SelectionMode::PinnedRevision.to_string(), "PinnedRevision");
    assert_eq!(ProvisioningMode::SeedOnce.to_string(), "SeedOnce");
    assert_eq!(
      ProvisioningMode::ManagedUntilLocalEdit.to_string(),
      "ManagedUntilLocalEdit"
    );
    assert_eq!(InstanceState::Ok.to_string(), "Ok");
    assert_eq!(InstanceState::Detached.to_string(), "Detached");
    assert_eq!(ReconcileScope::Global.to_string(), "Global");
    assert_eq!(JobState::Pending.to_string(), "Pending");
  }
}
