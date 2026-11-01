//! Template Registry application service and its persistence port.
//!
//! [`TemplateRegistryStore`] is the storage port that must be implemented by
//! the infrastructure layer.  [`TemplateRegistryService`] orchestrates all
//! template lifecycle operations (import, validation, publishing, assignment,
//! reconciliation, drift scanning).
//!
//! Sub-modules:
//! - [`bundle`] — ZIP bundle parsing, manifest validation, export

pub mod bundle;
mod content;
mod released_builtin;
pub use released_builtin::{ReleasedBuiltinAdoption, ReleasedBuiltinInstance, released_system_baseline_version};
pub mod source_export;
pub mod suggestions;

/// Only the explicit category denotes a section source; absent/unknown values stay ordinary templates.
pub fn is_building_block_category(category: Option<&str>) -> bool {
  category == Some("building-blocks")
}

use async_trait::async_trait;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use myoxus_domain::ids::{DocId, UserId, WorkspaceId};
use myoxus_domain::template_registry::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tracing::{Level, debug, error, info, instrument, trace, warn};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};
use crate::doc::{
  DocRevisionCheckedUpdateOutcome, DocService, DocSpaceKind, PermanentDeleteMode, PermanentDeleteRequest,
  canonical_yjs_revision,
};
use crate::ports::{BlobStoragePort, BlobWriteRequest};
use crate::telemetry::TelemetryService;
use crate::worker::WorkQueuePort;

/// Apply catalog lifecycle semantics to a locked entry. Archive deactivates
/// workspace policies in the same Store transaction; disable leaves them
/// intact, and enable never restores previously disabled policies.
/// `allow_already_active` preserves the trusted CLI's successful enable retry.
pub fn apply_catalog_transition(
  entry: &mut TemplateCatalogEntry,
  status: TemplateStatus,
  allow_already_active: bool,
  now: DateTime<Utc>,
) -> AuthResult<()> {
  if entry.status == status && !(status == TemplateStatus::Active && allow_already_active) {
    let state = match status {
      TemplateStatus::Active => "active",
      TemplateStatus::Disabled => "disabled",
      TemplateStatus::Archived => "archived",
    };
    return Err(AuthError::InvalidInput(format!("template is already {state}")));
  }
  entry.status = status;
  entry.updated_at = now;
  match status {
    TemplateStatus::Archived => entry.archived_at = Some(now),
    TemplateStatus::Active => entry.archived_at = None,
    TemplateStatus::Disabled => {}
  }
  Ok(())
}

pub const TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION: &str = "2026-03-31.v1";
pub const TEMPLATE_REGISTRY_NORMALIZER_VERSION: &str = "2026-03-31.v1";
pub const TEMPLATE_AUDIT_ERROR_CODE_NONE: &str = "NONE";
pub const TEMPLATE_AUDIT_UNKNOWN_VALUE: &str = "unknown";
pub const TEMPLATE_ASSIGNMENT_CREATED_EVENT: &str = "template.assignment.created";
pub const TEMPLATE_ASSIGNMENT_REMOVED_EVENT: &str = "template.assignment.removed";
pub const TEMPLATE_ASSIGNMENT_RETIRED_EVENT: &str = "template.assignment.retired";
pub const TEMPLATE_ASSIGNMENT_REJECTED_EVENT: &str = "template.assignment.rejected";
pub const TEMPLATE_DRIFT_SCAN_STARTED_EVENT: &str = "template.drift.scan.started";
pub const TEMPLATE_DRIFT_SCAN_FAILED_EVENT: &str = "template.drift.scan.failed";
pub const TEMPLATE_EXPORT_COMPLETED_EVENT: &str = "template.export.completed";
pub const TEMPLATE_IMPORT_COMPLETED_EVENT: &str = "template.import.completed";
pub const TEMPLATE_IMPORT_FORMAT_NORMALIZED_EVENT: &str = "template.import.format.normalized";
pub const TEMPLATE_IMPORT_FORMAT_REJECTED_EVENT: &str = "template.import.format.rejected";
pub const TEMPLATE_IMPORT_FAILED_EVENT: &str = "template.import.failed";
pub const TEMPLATE_IMPORT_STARTED_EVENT: &str = "template.import.started";
pub const TEMPLATE_IMPORT_VALIDATED_EVENT: &str = "template.import.validated";
pub const TEMPLATE_INSTANCE_DETACHED_EVENT: &str = "template.instance.detached";
pub const TEMPLATE_INSTANCE_RETIRED_EVENT: &str = "template.instance.retired";
pub const TEMPLATE_RECONCILE_FAILED_EVENT: &str = "template.reconcile.failed";
pub const TEMPLATE_RECONCILE_COMPLETED_EVENT: &str = "template.reconcile.completed";
pub const TEMPLATE_RECONCILE_STARTED_EVENT: &str = "template.reconcile.started";
pub const TEMPLATE_REVISION_PUBLISHED_EVENT: &str = "template.revision.published";
pub const TEMPLATE_DEFAULT_REPLACED_EVENT: &str = "template.default.replaced";
pub const TEMPLATE_REVISION_PUBLISH_FAILED_EVENT: &str = "template.revision.publish.failed";
pub const TEMPLATE_REGISTRY_QUEUE: &str = "template-registry";
pub const TEMPLATE_RECONCILE_WORKSPACE_JOB: &str = "template-registry.reconcileWorkspace";

/// Filter parameters for template registry audit event listing.
#[derive(Debug, Clone, Default)]
pub struct TemplateRegistryAuditEventFilter {
  pub action: Option<TemplateRegistryAuditAction>,
  pub event_type: Option<String>,
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
  pub created_after: Option<DateTime<Utc>>,
  pub created_before: Option<DateTime<Utc>>,
}

/// Server-owned source selected for deliberate central retirement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetiringTemplateSource {
  pub instance_id: WorkspaceTemplateInstanceId,
  pub source: TemplateSource,
  pub workspace_doc_id: Option<DocId>,
  pub workspace_doc_key: Option<String>,
}

// ─── Store Port ──────────────────────────────────────────────────────────────

/// Native release intent after every immutable bundle has passed import and validation.
/// History never becomes current; only explicitly release-owned defaults follow
/// authored changes. Unknown and operator-edited native policies stay untouched.
#[derive(Debug, Clone)]
pub struct ShippedTemplateSelection {
  pub template_id: TemplateCatalogEntryId,
  pub current_revision_id: Option<TemplateRevisionId>,
  pub history_revision_ids: Vec<TemplateRevisionId>,
  pub new_workspace_default: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ShippedTemplateSelectionReport {
  pub current: Vec<TemplateCatalogEntryId>,
  pub operator_current_preserved: Vec<TemplateCatalogEntryId>,
  pub history_revisions: usize,
}

/// Persistence port for the Template Registry.
///
/// Covers CRUD operations for catalog entries, revisions, workspace policies,
/// workspace instances, and job records.  The infrastructure layer must provide
/// a concrete implementation (e.g. backed by SQLx/PostgreSQL).
#[async_trait]
pub trait TemplateRegistryStore: Send + Sync {
  /// One scoped SQL inventory page, already filtered and keyset-paged. Implementors
  /// must not fetch document bodies or perform per-entry repository round-trips.
  async fn library_sources(
    &self,
    _query: &suggestions::TemplateLibraryQuery,
  ) -> AuthResult<Vec<suggestions::TemplateLibrarySource>> {
    Err(AuthError::Storage("Library inventory projection is unavailable".into()))
  }
  // ── Catalog Entries ──────────────────────────────────────────────────

  /// Insert a new template catalog entry.
  async fn create_catalog_entry(&self, entry: &TemplateCatalogEntry) -> AuthResult<()>;

  /// Fetch a catalog entry by ID, or `None` if not found.
  async fn get_catalog_entry(&self, id: TemplateCatalogEntryId) -> AuthResult<Option<TemplateCatalogEntry>>;

  /// Fetch a catalog entry by slug, or `None` if not found.
  async fn get_catalog_entry_by_slug(&self, slug: &str) -> AuthResult<Option<TemplateCatalogEntry>>;

  /// List all catalog entries, optionally filtered by status.
  async fn list_catalog_entries(
    &self,
    status_filter: Option<TemplateStatus>,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<TemplateCatalogEntry>>;

  /// Count catalog entries, optionally filtered by status.
  async fn count_catalog_entries(&self, status_filter: Option<TemplateStatus>) -> AuthResult<i64>;

  /// Update a catalog entry (full replace).
  async fn update_catalog_entry(&self, entry: &TemplateCatalogEntry) -> AuthResult<()>;

  /// Legacy rows are read only by the private validated-release transition.
  async fn list_released_builtin_instances(
    &self,
    _id: TemplateCatalogEntryId,
  ) -> AuthResult<Vec<ReleasedBuiltinInstance>> {
    Err(AuthError::Storage("released builtin discovery is unavailable".into()))
  }

  /// Exact attribution for native retirement; never enumerate other Workspaces
  /// merely to attest one bound source.
  async fn source_attribution(
    &self,
    workspace: WorkspaceId,
    template: TemplateCatalogEntryId,
  ) -> AuthResult<Option<ReleasedBuiltinInstance>> {
    Ok(
      self
        .list_released_builtin_instances(template)
        .await?
        .into_iter()
        .find(|row| row.workspace_id == workspace),
    )
  }

  /// A bounded restartable batch of still-null legacy revisions. Already adopted
  /// native bindings are excluded, including after an interrupted owner cutover.
  async fn pending_released_builtin_instances(
    &self,
    _id: TemplateCatalogEntryId,
    _limit: usize,
  ) -> AuthResult<Vec<ReleasedBuiltinInstance>> {
    Err(AuthError::Storage(
      "bounded released builtin discovery is unavailable".into(),
    ))
  }

  /// Lock/fence one observed batch and attach real revisions without body writes.
  /// Finalization switches the owner only when no NULL-revision binding remains.
  async fn commit_released_builtin_transition(
    &self,
    _id: TemplateCatalogEntryId,
    _revision: TemplateRevisionId,
    _purpose: bundle::TemplatePurpose,
    _adoptions: &[ReleasedBuiltinAdoption],
    _finalize: bool,
  ) -> AuthResult<()> {
    Err(AuthError::Storage("released builtin transition is unavailable".into()))
  }

  /// Relinquish only this central source binding, retaining its document as a
  /// custom template. Never changes body, root registration or policy choices.
  async fn preserve_source_as_custom(
    &self,
    _workspace: WorkspaceId,
    _template: TemplateCatalogEntryId,
  ) -> AuthResult<()> {
    Err(AuthError::Storage("source preservation is unavailable".into()))
  }

  /// Automatic replacement rechecks eligibility while locking the policy.
  async fn begin_eligible_source_retirement(
    &self,
    _policy: &WorkspaceTemplatePolicy,
  ) -> AuthResult<Option<RetiringTemplateSource>> {
    Err(AuthError::Storage("eligible source retirement is unavailable".into()))
  }

  /// Lock the current catalog row and commit the requested lifecycle state
  /// with its policy effects atomically. Apply the shared transition rules
  /// after locking; unrelated catalog/revision/binding/default fields survive.
  async fn commit_catalog_transition(
    &self,
    id: TemplateCatalogEntryId,
    status: TemplateStatus,
    allow_already_active: bool,
  ) -> AuthResult<TemplateCatalogEntry>;

  /// Delete one catalog entry and its cascade-owned revisions/instances.
  /// Used only to compensate a newly imported portable Database Row template
  /// before any Database binding has committed.
  async fn delete_catalog_entry(&self, _id: TemplateCatalogEntryId) -> AuthResult<()> {
    Err(AuthError::Storage(
      "template catalog deletion is not implemented by this store".to_string(),
    ))
  }

  // ── Audit Events ────────────────────────────────────────────────────

  /// Insert a new template registry audit event.
  async fn create_audit_event(&self, event: &TemplateRegistryAuditEvent) -> AuthResult<()>;

  /// List audit events ordered by created_at descending, with optional filters.
  async fn list_audit_events(
    &self,
    filter: Option<TemplateRegistryAuditEventFilter>,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<TemplateRegistryAuditEvent>>;

  // ── Revisions ────────────────────────────────────────────────────────

  /// Insert a new template revision.
  async fn create_revision(&self, revision: &TemplateRevision) -> AuthResult<()>;

  /// Fetch a revision by ID, or `None` if not found.
  async fn get_revision(&self, id: TemplateRevisionId) -> AuthResult<Option<TemplateRevision>>;

  /// List revisions for a given template, ordered by creation date descending.
  async fn list_revisions(
    &self,
    template_id: TemplateCatalogEntryId,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<TemplateRevision>>;

  /// Find the latest published revision for a template.
  async fn get_latest_published_revision(
    &self,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Option<TemplateRevision>>;

  /// Update a revision (full replace). Validation writes require the stored
  /// state to remain Draft, so stale validation cannot undo publication.
  async fn update_revision(&self, revision: &TemplateRevision) -> AuthResult<()>;

  /// Publish under the same catalog-root lock used by release selection.
  async fn commit_revision_publication(&self, _revision_id: TemplateRevisionId) -> AuthResult<TemplateRevision> {
    Err(AuthError::Storage("atomic revision publication is unavailable".into()))
  }

  /// Commit the complete release selection, preserving operator state. Omitted
  /// release-owned identities lose standalone publication, not their revisions.
  async fn commit_shipped_catalog_selection(
    &self,
    _selection: &[ShippedTemplateSelection],
  ) -> AuthResult<ShippedTemplateSelectionReport> {
    Err(AuthError::Storage(
      "atomic shipped catalog selection is unavailable".into(),
    ))
  }

  // ── Workspace Policies ───────────────────────────────────────────────

  /// Insert a new workspace template policy.
  async fn create_policy(&self, policy: &WorkspaceTemplatePolicy) -> AuthResult<()>;

  /// Atomically create an explicit assignment and reactivate a historical
  /// retired binding when present. An active/non-retired binding remains a
  /// conflict; passive reconciliation never calls this operation.
  async fn create_policy_for_explicit_assignment(
    &self,
    policy: &WorkspaceTemplatePolicy,
    _revision_id: Option<TemplateRevisionId>,
  ) -> AuthResult<()> {
    self.create_policy(policy).await
  }

  /// Fetch a policy by ID.
  async fn get_policy(&self, id: WorkspaceTemplatePolicyId) -> AuthResult<Option<WorkspaceTemplatePolicy>>;

  /// List policies for a workspace.
  async fn list_policies_for_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<Vec<WorkspaceTemplatePolicy>>;

  /// List policies for a template (across all workspaces).
  async fn list_policies_for_template(
    &self,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Vec<WorkspaceTemplatePolicy>>;

  /// Update a policy (full replace).
  async fn update_policy(&self, policy: &WorkspaceTemplatePolicy) -> AuthResult<()>;

  /// Delete a policy by ID.
  async fn delete_policy(&self, id: WorkspaceTemplatePolicyId) -> AuthResult<()>;

  // ── Workspace Instances ──────────────────────────────────────────────

  /// Insert a new workspace template instance.
  async fn create_instance(&self, instance: &WorkspaceTemplateInstance) -> AuthResult<()>;

  /// Fetch an instance by ID.
  async fn get_instance(&self, id: WorkspaceTemplateInstanceId) -> AuthResult<Option<WorkspaceTemplateInstance>>;

  /// List instances for a workspace.
  async fn list_instances_for_workspace(&self, workspace_id: WorkspaceId)
  -> AuthResult<Vec<WorkspaceTemplateInstance>>;

  /// List instances for a template (across all workspaces).
  async fn list_instances_for_template(
    &self,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Vec<WorkspaceTemplateInstance>>;

  /// Find the instance for a specific workspace + template combination.
  async fn find_instance(
    &self,
    workspace_id: WorkspaceId,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Option<WorkspaceTemplateInstance>>;

  /// Read-only projection used by document permission surfaces. Destructive
  /// writes still recheck this invariant inside their own transaction.
  async fn is_managed_source(&self, _workspace_id: WorkspaceId, _doc_id: DocId) -> AuthResult<bool> {
    Ok(false)
  }

  /// Update an instance (full replace).
  async fn update_instance(&self, instance: &WorkspaceTemplateInstance) -> AuthResult<()>;

  /// Mark the current builtin or bundle source as centrally retired and return
  /// its document identity for the existing document lifecycle owner.
  async fn begin_central_source_retirement(
    &self,
    _workspace_id: WorkspaceId,
    _template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Option<RetiringTemplateSource>> {
    Err(AuthError::Storage(
      "central template source retirement is not implemented by this store".to_string(),
    ))
  }

  /// Clear a retired delivery binding. Reusable sources must have been removed
  /// by the document lifecycle; ordinary guide copies remain reader-owned.
  async fn complete_central_source_retirement(
    &self,
    _workspace_id: WorkspaceId,
    _template_id: TemplateCatalogEntryId,
  ) -> AuthResult<()> {
    Err(AuthError::Storage(
      "central template source retirement completion is not implemented by this store".to_string(),
    ))
  }

  // ── Import Jobs ──────────────────────────────────────────────────────

  /// Insert a new import job record.
  async fn create_import_job(&self, job: &TemplateImportJob) -> AuthResult<()>;

  /// Fetch an import job by ID.
  async fn get_import_job(&self, id: TemplateImportJobId) -> AuthResult<Option<TemplateImportJob>>;

  /// Update an import job (full replace).
  async fn update_import_job(&self, job: &TemplateImportJob) -> AuthResult<()>;

  /// List import jobs ordered by started_at descending, with pagination.
  async fn list_import_jobs(&self, skip: i64, take: i64) -> AuthResult<Vec<TemplateImportJob>>;

  // ── Reconcile Jobs ───────────────────────────────────────────────────

  /// Insert a new reconcile job record.
  async fn create_reconcile_job(&self, job: &TemplateReconcileJob) -> AuthResult<()>;

  /// Fetch a reconcile job by ID.
  async fn get_reconcile_job(&self, id: TemplateReconcileJobId) -> AuthResult<Option<TemplateReconcileJob>>;

  /// Update a reconcile job (full replace).
  async fn update_reconcile_job(&self, job: &TemplateReconcileJob) -> AuthResult<()>;

  /// List reconcile jobs ordered by started_at descending, with pagination.
  async fn list_reconcile_jobs(&self, skip: i64, take: i64) -> AuthResult<Vec<TemplateReconcileJob>>;

  /// List durable workspace deliveries that still need queue completion.
  async fn list_recoverable_workspace_reconcile_jobs(&self, take: i64) -> AuthResult<Vec<TemplateReconcileJob>> {
    Ok(
      self
        .list_reconcile_jobs(0, take)
        .await?
        .into_iter()
        .filter(|job| {
          job.scope == ReconcileScope::Workspace
            && matches!(job.state, JobState::Pending | JobState::Running)
            && job.workspace_id.is_some()
        })
        .collect(),
    )
  }

  // ── Bulk Discovery ──────────────────────────────────────────────────

  /// List distinct workspace IDs that have at least one enabled policy.
  ///
  /// Used by the reconcileAll cron job to discover which workspaces need
  /// reconciliation.
  async fn list_distinct_policy_workspace_ids(&self) -> AuthResult<Vec<WorkspaceId>>;

  /// Stable bounded enumeration for explicit operator-run release recovery.
  /// Include Empty Workspaces: their explicit assignments still need processing.
  async fn release_workspace_ids(&self, _after: Option<WorkspaceId>, _limit: usize) -> AuthResult<Vec<WorkspaceId>> {
    Err(AuthError::Storage(
      "bounded release Workspace discovery is unavailable".into(),
    ))
  }

  /// Bounded native release delta, excluding Workspaces already represented by
  /// a pending/running Registry job. No document bodies are read here.
  async fn release_workspaces_needing_reconcile(
    &self,
    _after: Option<WorkspaceId>,
    _limit: usize,
  ) -> AuthResult<Vec<WorkspaceId>> {
    Err(AuthError::Storage("release delta discovery is unavailable".into()))
  }

  /// Missing release-owned defaults only; existing assignments and historical
  /// opt-outs are never converted into implicit assignments.
  async fn pending_release_default_ids(&self, _workspace: WorkspaceId) -> AuthResult<Vec<TemplateCatalogEntryId>> {
    Err(AuthError::Storage("release default discovery is unavailable".into()))
  }

  /// Eligible assignments of withdrawn release publications. The ordinary
  /// retirement service still rechecks policy, content and attribution fences.
  async fn withdrawn_release_policy_ids(&self, _workspace: WorkspaceId) -> AuthResult<Vec<WorkspaceTemplatePolicyId>> {
    Err(AuthError::Storage("release withdrawal discovery is unavailable".into()))
  }

  /// List distinct workspace IDs that have at least one template instance.
  ///
  /// Used by the driftScan cron job to discover which workspaces need
  /// drift scanning.
  async fn list_distinct_instance_workspace_ids(&self) -> AuthResult<Vec<WorkspaceId>>;

  // ── Builtin Bridge (P125-TPL §3) ────────────────────────────────────

  /// List all template default policies (used for workspace seeding and admin UI).
  /// See myoxus-template-registry-builtin-bridge.md §3.3.
  async fn list_default_policies(&self) -> AuthResult<Vec<TemplateDefaultPolicy>>;

  /// Insert or update a template default policy.
  async fn upsert_default_policy(&self, policy: &TemplateDefaultPolicy) -> AuthResult<()>;

  /// Insert a shipped default only when no operator-owned policy exists.
  /// Existing rows, including administrative opt-outs, remain authoritative.
  /// New persisted rows carry positive release-default ownership.
  async fn insert_default_policy_if_absent(&self, policy: &TemplateDefaultPolicy) -> AuthResult<bool> {
    let exists = self
      .list_default_policies()
      .await?
      .into_iter()
      .any(|existing| existing.template_id == policy.template_id);
    if exists {
      return Ok(false);
    }
    self.upsert_default_policy(policy).await?;
    Ok(true)
  }

  /// Flip the `apply_to_new_workspaces` flag on a default policy without replacing
  /// selection_mode / provisioning_mode.
  async fn set_default_policy_apply_flag(&self, template_id: TemplateCatalogEntryId, apply: bool) -> AuthResult<()>;

  /// Permanent native metadata, not a template policy or package default.
  async fn workspace_initial_content_policy(
    &self,
    workspace_id: WorkspaceId,
  ) -> AuthResult<myoxus_domain::entities::WorkspaceInitialContentPolicy>;

  /// Seed a new workspace by inserting one `workspace_template_policies` row per
  /// active default policy.  Single-SQL, idempotent (ON CONFLICT DO NOTHING).
  /// Returns the number of policy rows inserted.
  async fn apply_default_policies_to_new_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<usize>;

  /// Atomically increment `builder_version` on a builtin catalog entry and return
  /// the new version.  Fails if the slug is not found or not `source=builtin`.
  async fn bump_builder_version(&self, slug: &str) -> AuthResult<u32>;

  /// List workspace IDs that have an active enabled policy for a given builtin slug.
  /// Used to fan out `template:reconcile-needed` push after a builder_version bump.
  async fn list_workspaces_with_builtin_slug(&self, slug: &str) -> AuthResult<Vec<WorkspaceId>>;

  /// Return the per-slug reconcile manifest for a workspace (§5+§6).
  ///
  /// Computes `expected_hash` server-side from `(slug, builder_version, locale)`,
  /// joins with the current instance state, and returns everything the client
  /// needs to run the reconcile algorithm.
  async fn list_builtin_reconcile_entries(
    &self,
    workspace_id: WorkspaceId,
    locale: &str,
  ) -> AuthResult<Vec<BuiltinReconcileEntry>>;

  /// Upsert a builtin instance after successful client-side build.
  /// Called by the `reportTemplateBuilderApplied` mutation.
  async fn upsert_builtin_instance_applied(
    &self,
    workspace_id: WorkspaceId,
    slug: &str,
    applied_hash: &str,
    locale: &str,
    doc_id: Option<&str>,
  ) -> AuthResult<()>;

  /// Attribute a newly materialized bundle document through the canonical
  /// metadata owner before the registry may expose its instance as ready.
  /// Guides keep ordinary attribution; both purposes record the chosen language.
  async fn attribute_materialized_document(
    &self,
    doc_id: DocId,
    actor_id: UserId,
    locale: &str,
    purpose: bundle::TemplatePurpose,
  ) -> AuthResult<()>;

  /// Existing source language comes from document metadata; fresh sources use
  /// the server's canonical document-default-language projection.
  async fn resolve_bundle_source_language(&self, _doc_id: Option<DocId>) -> AuthResult<String> {
    Err(AuthError::Storage(
      "bundle source language lookup is unavailable".into(),
    ))
  }

  /// Resolve the existing user actor recorded by the workspace lifecycle for
  /// server-driven document materialization.
  async fn resolve_workspace_materialization_actor(&self, _workspace_id: WorkspaceId) -> AuthResult<UserId> {
    Err(AuthError::Storage(
      "workspace materialization actor lookup is unavailable".to_string(),
    ))
  }

  /// Mark a builtin instance as retired through a server-owned lifecycle path.
  /// Client-reported trash is rejected by the application service.
  async fn retire_builtin_instance(&self, workspace_id: WorkspaceId, slug: &str) -> AuthResult<()>;
}

// ─── Service ────────────────────────────────────────────────────────────────

/// Compute SHA-256 hex digest of the given bytes.
fn compute_content_hash(data: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(data);
  format!("{:x}", hasher.finalize())
}

/// Reuse one immutable identity check for single imports and package preflight.
/// Historical raw-content blob locators keep their deployed identity semantics.
fn ensure_same_revision_content(
  revision: &TemplateRevision,
  parsed: &bundle::ParsedBundle,
  canonical_checksum: &str,
) -> AuthResult<()> {
  let canonical_identity_changed = revision.bundle_blob_id.as_deref().is_some_and(|id| {
    id.starts_with("template-registry/bundles/")
      && id
        != format!(
          "template-registry/bundles/{}/{}/{}.zip",
          parsed.manifest.template_id, parsed.manifest.version, canonical_checksum
        )
  });
  if canonical_identity_changed
    || revision.checksum.as_deref() != Some(parsed.content_checksum.as_str())
    || revision.manifest.as_ref()
      != Some(
        &serde_json::to_value(&parsed.manifest)
          .map_err(|_| AuthError::InvalidInput("invalid template manifest".into()))?,
      )
  {
    return Err(AuthError::InvalidInput(format!(
      "template '{}' version '{}' already exists with different content",
      parsed.manifest.template_id, parsed.manifest.version
    )));
  }
  Ok(())
}

/// Compare the stored immutable payload, independently of ZIP encoder output.
/// The locator still authenticates the original archive; compression changes
/// must never replace that locator or admit changed locales or previews.
fn ensure_same_stored_revision_content(
  revision: &TemplateRevision,
  incoming: &bundle::ParsedBundle,
  stored: &bundle::ParsedBundle,
  stored_archive_checksum: &str,
) -> AuthResult<()> {
  ensure_same_revision_content(revision, stored, stored_archive_checksum)?;
  let incoming_manifest = serde_json::to_value(&incoming.manifest)
    .map_err(|_| AuthError::InvalidInput("invalid template manifest".into()))?;
  if incoming.content_bytes != stored.content_bytes
    || incoming.localized_contents != stored.localized_contents
    || incoming.preview_bytes != stored.preview_bytes
    || Some(&incoming_manifest) != revision.manifest.as_ref()
  {
    return Err(AuthError::InvalidInput(format!(
      "template '{}' version '{}' already exists with different content",
      incoming.manifest.template_id, incoming.manifest.version
    )));
  }
  Ok(())
}

/// Read-only equivalent of immutable release staging. Ownership recovery may
/// attest a historical publication only against an admitted native identity,
/// complete manifest and canonical content, never an absent author alone.
pub fn attest_shipped_revision(revision: &TemplateRevision, parsed: &bundle::ParsedBundle) -> AuthResult<()> {
  let canonical = bundle::create_export_bundle(
    &parsed.manifest,
    &parsed.content_bytes,
    parsed.preview_bytes.as_deref(),
    &parsed.localized_contents,
  )
  .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
  if revision.created_by.is_some() || revision.version != parsed.manifest.version {
    return Err(AuthError::InvalidInput(
      "publication is not the admitted system revision".into(),
    ));
  }
  ensure_same_revision_content(revision, parsed, &compute_content_hash(&canonical))
}

/// Fingerprint immutable native source identity, not its publication lifecycle.
pub fn template_revision_source_digest(revision: &TemplateRevision) -> String {
  compute_content_hash(
    &serde_json::to_vec(&(
      &revision.version,
      &revision.bundle_blob_id,
      &revision.checksum,
      &revision.manifest,
    ))
    .expect("typed immutable native revision"),
  )
}

/// One native admission check serves read preparation and the locked SQL write
/// boundary. Native delivery and accepted receipts may select retained component
/// revisions; standalone publication is not the authority for those consumers.
pub fn validate_accepted_document_source(
  entry: &TemplateCatalogEntry,
  revision: &TemplateRevision,
  source: &myoxus_domain::assistant_package::AssistantDocumentComponentSource,
  revision_digest: &str,
  client_version: u32,
) -> AuthResult<()> {
  if entry.slug != source.template_id
    || revision.version != source.version
    || entry.status != TemplateStatus::Active
    || entry.source != TemplateSource::Bundle
    || client_version < entry.min_client_version
    || revision.bundle_blob_id.is_none()
    || revision.checksum.is_none()
    || !matches!(revision.state, RevisionState::Published | RevisionState::Deprecated)
    || revision_is_guide(&revision)
    || template_revision_source_digest(&revision) != revision_digest
  {
    return Err(AuthError::InvalidInput("accepted document source unavailable".into()));
  }
  Ok(())
}

pub(crate) fn revision_is_guide(revision: &TemplateRevision) -> bool {
  revision
    .manifest
    .as_ref()
    .and_then(|manifest| manifest.get("purpose"))
    .and_then(Value::as_str)
    == Some("guide")
}

/// Release defaults manage reusable sources, not independent reader copies.
/// Explicit pins/manual policies are selected separately and must not use this
/// default-mode choice to override an operator decision.
pub fn shipped_default_provisioning_mode(revision: &TemplateRevision) -> ProvisioningMode {
  if revision_is_guide(revision) {
    ProvisioningMode::SeedOnce
  } else {
    ProvisioningMode::ManagedUntilLocalEdit
  }
}

/// ZIP safety limits used while importing template bundles.
///
/// These values are supplied at startup from server configuration and kept on
/// the service so the bundle layer can apply them later without threading
/// additional config through every call site.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TemplateRegistryZipLimits {
  /// Maximum number of ZIP entries allowed in a template bundle.
  pub max_entries: u64,
  /// Maximum combined uncompressed size of all ZIP entries, in MB.
  pub max_total_uncompressed_size_mb: u64,
  /// Maximum uncompressed size of any single ZIP entry, in MB.
  pub max_entry_uncompressed_size_mb: u64,
  /// Maximum allowed per-entry compression ratio.
  pub max_compression_ratio: f64,
  /// Maximum allowed ZIP path length.
  pub max_path_length: u64,
}

impl Default for TemplateRegistryZipLimits {
  fn default() -> Self {
    Self {
      max_entries: 256,
      max_total_uncompressed_size_mb: 200,
      max_entry_uncompressed_size_mb: 50,
      max_compression_ratio: 200.0,
      max_path_length: 512,
    }
  }
}

/// Bounded replacement of one centrally managed default-template assignment.
#[derive(Debug, Clone)]
pub struct TemplateDefaultReplacementRequest<'a> {
  pub source_slug: &'a str,
  pub replacement_slug: &'a str,
  pub after_policy_id: Option<WorkspaceTemplatePolicyId>,
  pub limit: usize,
  pub apply: bool,
}

/// Stable per-workspace result emitted by the replacement repair owner.
#[derive(Debug, Clone, Serialize)]
pub struct TemplateDefaultReplacementResult {
  pub policy_id: WorkspaceTemplatePolicyId,
  pub workspace_id: WorkspaceId,
  pub outcome: String,
  pub detail: String,
  pub retired_source_doc_id: Option<String>,
  pub replacement_source_doc_id: Option<String>,
}

/// Exact document identity replacement consumed by synced page-default state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplatePageDefaultReplacement {
  pub retired_source_doc_id: String,
  /// None withdraws a stale preference without selecting an unrelated source.
  pub replacement_source_doc_id: Option<String>,
}

/// Post-commit acceleration only; clients can always read the current version.
#[async_trait]
pub trait TemplateBuilderNotificationPort: Send + Sync {
  async fn notify(&self, workspace_id: WorkspaceId, slug: &str, builder_version: u32) -> AuthResult<()>;
}

/// High-level template registry service.
///
/// Orchestrates template lifecycle operations through the [`TemplateRegistryStore`]
/// port.  All operations are logged with structured tracing fields.
///
/// Materialization (Phase 5) and drift detection (Phase 6) require access to
/// [`DocService`] and [`BlobStoragePort`].  These are optional — when absent,
/// reconcile fails without writing instances. Drift scans preserve instances
/// when live document evidence is unavailable; recorded hashes alone cannot
/// prove that shared content is unchanged. ZIP import safety limits are carried
/// on the service for later bundle processing.
#[derive(Clone)]
pub struct TemplateRegistryService {
  store: Arc<dyn TemplateRegistryStore>,
  builder_notifications: Option<Arc<dyn TemplateBuilderNotificationPort>>,
  /// Doc service for creating/reading workspace documents during materialization.
  doc_service: Option<DocService>,
  /// Blob storage port for reading template bundle content.
  blob_storage: Option<Arc<dyn BlobStoragePort>>,
  asset_service: Option<Arc<crate::ports::blob_service::BlobService>>,
  /// Optional shared telemetry sink wired to the API metrics endpoint.
  telemetry: Option<Arc<TelemetryService>>,
  /// Shared late-bound queue because API startup constructs Redis after the
  /// registry and workspace services. Every service clone observes the same
  /// production queue once startup wiring completes.
  reconcile_queue: Arc<OnceLock<Arc<dyn WorkQueuePort>>>,
  /// ZIP archive safety limits used for template bundle import.
  zip_limits: TemplateRegistryZipLimits,
}

/// Registry and document identities created for one portable Row-template
/// body. Database import keeps this handle only until its SQL binding commits,
/// so every earlier failure can compensate both resources.
#[derive(Debug, Clone)]
pub struct PortableDatabaseRowTemplate {
  pub template_id: TemplateCatalogEntryId,
  pub workspace_doc_id: DocId,
}

#[derive(Debug, Clone)]
pub(crate) struct PublishedRegistryDocumentMetadata {
  pub revision_id: Uuid,
  pub revision_digest: String,
  pub locale: String,
  pub title: String,
}

/// In-memory content from an immutable native revision, never a receipt body.
pub(crate) struct CapturedRegistryDocumentRevision {
  pub revision_id: TemplateRevisionId,
  pub content_digest: String,
  pub revision_digest: String,
  pub locale: String,
  pub snapshot: Vec<u8>,
}

pub struct ImportTemplateBundleRequest<'a> {
  pub slug: &'a str,
  pub title: &'a str,
  pub description: Option<&'a str>,
  pub category: Option<&'a str>,
  pub tags: Vec<String>,
  pub version: &'a str,
  pub bundle_blob_id: &'a str,
  pub preview_blob_id: Option<&'a str>,
  pub checksum: &'a str,
  pub manifest: Value,
  /// Administrative imports retain their caller; server-supplied release
  /// assets intentionally have no user actor.
  pub created_by: Option<UserId>,
}

struct ImportTemplateBundleWithMetadataRequest<'a> {
  bundle: ImportTemplateBundleRequest<'a>,
  revision_format_metadata: RevisionFormatMetadata,
}

#[derive(Debug)]
pub struct TemplateImportOutcome {
  pub entry: TemplateCatalogEntry,
  pub revision: TemplateRevision,
  pub warnings: Vec<bundle::ValidationError>,
  pub detected_format: bundle::BundleFormat,
  pub normalized: bool,
  pub ignored_entries_count: usize,
  pub error_catalog_version: &'static str,
}

#[derive(Debug, Clone)]
struct TemplateAuditContext {
  actor_user_id: Option<UserId>,
  job_id: Option<TemplateImportJobId>,
  template_id: Option<TemplateCatalogEntryId>,
  revision_id: Option<TemplateRevisionId>,
  workspace_id: Option<WorkspaceId>,
  policy_id: Option<WorkspaceTemplatePolicyId>,
  instance_id: Option<WorkspaceTemplateInstanceId>,
  source_format: String,
  detected_format: String,
  normalizer_version: String,
  ignored_entries_count: u32,
  error_catalog_version: String,
  error_code: String,
}

impl TemplateAuditContext {
  fn unknown() -> Self {
    Self {
      actor_user_id: None,
      job_id: None,
      template_id: None,
      revision_id: None,
      workspace_id: None,
      policy_id: None,
      instance_id: None,
      source_format: TEMPLATE_AUDIT_UNKNOWN_VALUE.to_string(),
      detected_format: TEMPLATE_AUDIT_UNKNOWN_VALUE.to_string(),
      normalizer_version: TEMPLATE_AUDIT_UNKNOWN_VALUE.to_string(),
      ignored_entries_count: 0,
      error_catalog_version: TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION.to_string(),
      error_code: TEMPLATE_AUDIT_ERROR_CODE_NONE.to_string(),
    }
  }

  fn from_revision(revision: &TemplateRevision) -> Self {
    Self {
      template_id: Some(revision.template_id),
      revision_id: Some(revision.id),
      source_format: revision.source_format.clone(),
      detected_format: revision.detected_format.clone(),
      normalizer_version: revision.normalizer_version.clone(),
      ignored_entries_count: revision.ignored_entries_count,
      error_catalog_version: revision.error_catalog_version.clone(),
      ..Self::unknown()
    }
  }

  fn from_revision_with_error(revision: &TemplateRevision, error_code: impl Into<String>) -> Self {
    Self {
      error_code: error_code.into(),
      ..Self::from_revision(revision)
    }
  }

  fn from_import_metadata(metadata: &RevisionFormatMetadata) -> Self {
    Self {
      source_format: metadata.source_format.clone(),
      detected_format: metadata.detected_format.clone(),
      normalizer_version: metadata.normalizer_version.clone(),
      ignored_entries_count: metadata.ignored_entries_count,
      error_catalog_version: metadata.error_catalog_version.clone(),
      ..Self::unknown()
    }
  }

  fn with_actor_user_id(mut self, actor_user_id: Option<UserId>) -> Self {
    self.actor_user_id = actor_user_id;
    self
  }

  fn with_job_id(mut self, job_id: TemplateImportJobId) -> Self {
    self.job_id = Some(job_id);
    self
  }

  fn with_template_id(mut self, template_id: TemplateCatalogEntryId) -> Self {
    self.template_id = Some(template_id);
    self
  }

  fn with_revision_id(mut self, revision_id: TemplateRevisionId) -> Self {
    self.revision_id = Some(revision_id);
    self
  }

  fn with_workspace_id(mut self, workspace_id: WorkspaceId) -> Self {
    self.workspace_id = Some(workspace_id);
    self
  }

  fn with_policy_id(mut self, policy_id: WorkspaceTemplatePolicyId) -> Self {
    self.policy_id = Some(policy_id);
    self
  }

  fn with_instance_id(mut self, instance_id: WorkspaceTemplateInstanceId) -> Self {
    self.instance_id = Some(instance_id);
    self
  }

  fn with_error_code(mut self, error_code: impl Into<String>) -> Self {
    self.error_code = error_code.into();
    self
  }

  fn with_import_metadata(
    mut self,
    source_format: impl Into<String>,
    detected_format: impl Into<String>,
    normalizer_version: impl Into<String>,
    ignored_entries_count: usize,
    error_catalog_version: impl Into<String>,
  ) -> Self {
    self.source_format = source_format.into();
    self.detected_format = detected_format.into();
    self.normalizer_version = normalizer_version.into();
    self.ignored_entries_count = ignored_entries_count.min(u32::MAX as usize) as u32;
    self.error_catalog_version = error_catalog_version.into();
    self
  }

  fn emit(&self, level: Level, event_type: &'static str, message: &str) {
    let log = |level| match level {
      Level::ERROR => error!(
        audit_event = event_type,
        message = %message,
        actor_user_id = ?self.actor_user_id,
        job_id = ?self.job_id,
        template_id = ?self.template_id,
        revision_id = ?self.revision_id,
        workspace_id = ?self.workspace_id,
        policy_id = ?self.policy_id,
        instance_id = ?self.instance_id,
        source_format = %self.source_format,
        detected_format = %self.detected_format,
        normalizer_version = %self.normalizer_version,
        ignored_entries_count = self.ignored_entries_count,
        error_catalog_version = %self.error_catalog_version,
        error_code = %self.error_code,
      ),
      Level::WARN => warn!(
        audit_event = event_type,
        message = %message,
        actor_user_id = ?self.actor_user_id,
        job_id = ?self.job_id,
        template_id = ?self.template_id,
        revision_id = ?self.revision_id,
        workspace_id = ?self.workspace_id,
        policy_id = ?self.policy_id,
        instance_id = ?self.instance_id,
        source_format = %self.source_format,
        detected_format = %self.detected_format,
        normalizer_version = %self.normalizer_version,
        ignored_entries_count = self.ignored_entries_count,
        error_catalog_version = %self.error_catalog_version,
        error_code = %self.error_code,
      ),
      Level::INFO => info!(
        audit_event = event_type,
        message = %message,
        actor_user_id = ?self.actor_user_id,
        job_id = ?self.job_id,
        template_id = ?self.template_id,
        revision_id = ?self.revision_id,
        workspace_id = ?self.workspace_id,
        policy_id = ?self.policy_id,
        instance_id = ?self.instance_id,
        source_format = %self.source_format,
        detected_format = %self.detected_format,
        normalizer_version = %self.normalizer_version,
        ignored_entries_count = self.ignored_entries_count,
        error_catalog_version = %self.error_catalog_version,
        error_code = %self.error_code,
      ),
      Level::DEBUG => debug!(
        audit_event = event_type,
        message = %message,
        actor_user_id = ?self.actor_user_id,
        job_id = ?self.job_id,
        template_id = ?self.template_id,
        revision_id = ?self.revision_id,
        workspace_id = ?self.workspace_id,
        policy_id = ?self.policy_id,
        instance_id = ?self.instance_id,
        source_format = %self.source_format,
        detected_format = %self.detected_format,
        normalizer_version = %self.normalizer_version,
        ignored_entries_count = self.ignored_entries_count,
        error_catalog_version = %self.error_catalog_version,
        error_code = %self.error_code,
      ),
      Level::TRACE => trace!(
        audit_event = event_type,
        message = %message,
        actor_user_id = ?self.actor_user_id,
        job_id = ?self.job_id,
        template_id = ?self.template_id,
        revision_id = ?self.revision_id,
        workspace_id = ?self.workspace_id,
        policy_id = ?self.policy_id,
        instance_id = ?self.instance_id,
        source_format = %self.source_format,
        detected_format = %self.detected_format,
        normalizer_version = %self.normalizer_version,
        ignored_entries_count = self.ignored_entries_count,
        error_catalog_version = %self.error_catalog_version,
        error_code = %self.error_code,
      ),
    };

    log(level);
  }
}

fn audit_error_code(err: &AuthError) -> &'static str {
  match err {
    AuthError::InvalidEmail => "INVALID_EMAIL",
    AuthError::WrongSignInCredentials => "WRONG_SIGN_IN_CREDENTIALS",
    AuthError::ActionForbidden => "ACTION_FORBIDDEN",
    AuthError::InvalidToken => "INVALID_TOKEN",
    AuthError::ExpiredToken => "EXPIRED_TOKEN",
    AuthError::TokenNotFound => "TOKEN_NOT_FOUND",
    AuthError::OauthStateExpired => "OAUTH_STATE_EXPIRED",
    AuthError::SignUpForbidden => "SIGN_UP_FORBIDDEN",
    AuthError::AuthenticationRequired => "AUTHENTICATION_REQUIRED",
    AuthError::NotFound(_) => "NOT_FOUND",
    AuthError::InvalidInput(_) => "INVALID_INPUT",
    AuthError::WorkspaceNameConflict { .. } => "WORKSPACE_NAME_CONFLICT",
    AuthError::WorkspaceOverviewRevisionConflict { .. } => "WORKSPACE_OVERVIEW_REVISION_CONFLICT",
    AuthError::StorageQuotaExceeded { .. } => "STORAGE_QUOTA_EXCEEDED",
    AuthError::UpdateTooLarge { .. } => "UPDATE_TOO_LARGE",
    AuthError::InvalidYjsUpdate => "INVALID_YJS_UPDATE",
    AuthError::YjsValidationUnavailable => "YJS_VALIDATION_UNAVAILABLE",
    AuthError::InvalidYjsStateVector => "INVALID_YJS_STATE_VECTOR",
    AuthError::DocSyncPayloadTooLarge { .. } => "DOC_SYNC_PAYLOAD_TOO_LARGE",
    AuthError::DocSyncCancelled => "DOC_SYNC_CANCELLED",
    AuthError::YjsDecoderUnavailable => "YJS_DECODER_UNAVAILABLE",
    AuthError::Storage(_) => "STORAGE_ERROR",
  }
}

fn audit_payload(status: &str, message: &str, extra: Option<Value>, error: Option<&AuthError>) -> Value {
  let mut payload = serde_json::Map::new();
  payload.insert("status".to_string(), Value::String(status.to_string()));
  payload.insert("message".to_string(), Value::String(message.to_string()));
  if let Some(err) = error {
    payload.insert("error".to_string(), Value::String(err.to_string()));
    payload.insert(
      "error_code".to_string(),
      Value::String(audit_error_code(err).to_string()),
    );
  }
  if let Some(extra) = extra {
    match extra {
      Value::Object(extra_obj) => {
        for (key, value) in extra_obj {
          payload.insert(key, value);
        }
      }
      other => {
        payload.insert("extra".to_string(), other);
      }
    }
  }
  Value::Object(payload)
}

#[derive(Debug, Clone, Serialize)]
struct TemplateImportStageSummary {
  name: &'static str,
  duration_ms: u128,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TemplateRegistryOperation {
  Import,
  Reconcile,
  Export,
}

impl TemplateRegistryOperation {
  fn as_str(self) -> &'static str {
    match self {
      Self::Import => "import",
      Self::Reconcile => "reconcile",
      Self::Export => "export",
    }
  }
}

#[derive(Debug, Clone, Serialize)]
struct TemplateOperationErrorSummary {
  operation: &'static str,
  stage: &'static str,
  code: String,
  message: String,
  path: Option<String>,
}

/// Persisted format metadata attached to a created template revision.
///
/// Kept as a typed value in the import flow to avoid leaking ad-hoc string
/// maps across call boundaries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct RevisionFormatMetadata {
  source_format: String,
  detected_format: String,
  normalizer_version: String,
  ignored_entries_count: u32,
  error_catalog_version: String,
  normalization_warnings: Vec<NormalizationWarning>,
}

impl RevisionFormatMetadata {
  fn from_import(
    source_format: bundle::BundleFormat,
    ignored_entries_count: usize,
    error_catalog_version: &'static str,
    normalization_warnings: Vec<NormalizationWarning>,
  ) -> Self {
    let normalized_input = !matches!(source_format, bundle::BundleFormat::TemplateBundle);
    Self {
      source_format: source_format.as_str().to_string(),
      // Revisions are stored in canonical template-bundle shape after import.
      detected_format: bundle::BundleFormat::TemplateBundle.as_str().to_string(),
      normalizer_version: if normalized_input {
        TEMPLATE_REGISTRY_NORMALIZER_VERSION.to_string()
      } else {
        "none".to_string()
      },
      ignored_entries_count: ignored_entries_count.min(u32::MAX as usize) as u32,
      error_catalog_version: error_catalog_version.to_string(),
      normalization_warnings,
    }
  }
}

fn normalization_warnings_from_validation_warnings(warnings: &[bundle::ValidationError]) -> Vec<NormalizationWarning> {
  warnings
    .iter()
    .map(|warning| NormalizationWarning {
      code: warning.code.clone(),
      message: warning.message.clone(),
      field: warning.field.clone(),
      path: warning.path.clone(),
    })
    .collect()
}

#[derive(Debug, Clone, Serialize)]
struct TemplateImportJobSummary {
  error_catalog_version: &'static str,
  status: &'static str,
  started_at: DateTime<Utc>,
  finished_at: Option<DateTime<Utc>>,
  detected_format: Option<String>,
  normalized: Option<bool>,
  ignored_entries_count: Option<usize>,
  result_revision_id: Option<TemplateRevisionId>,
  stages: Vec<TemplateImportStageSummary>,
  warnings: Vec<bundle::ValidationError>,
  validation_errors: Vec<bundle::ValidationError>,
  error: Option<TemplateOperationErrorSummary>,
  failed_stage: Option<&'static str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  package: Option<Value>,
}

impl TemplateImportJobSummary {
  fn new(started_at: DateTime<Utc>) -> Self {
    Self {
      error_catalog_version: TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION,
      status: "pending",
      started_at,
      finished_at: None,
      detected_format: None,
      normalized: None,
      ignored_entries_count: None,
      result_revision_id: None,
      stages: Vec::new(),
      warnings: Vec::new(),
      validation_errors: Vec::new(),
      error: None,
      failed_stage: None,
      package: None,
    }
  }

  fn push_stage(&mut self, name: &'static str, duration: std::time::Duration) {
    self.stages.push(TemplateImportStageSummary {
      name,
      duration_ms: duration.as_millis(),
    });
  }

  fn complete(
    mut self,
    finished_at: DateTime<Utc>,
    result_revision_id: TemplateRevisionId,
    warnings: Vec<bundle::ValidationError>,
  ) -> Self {
    self.status = "completed";
    self.finished_at = Some(finished_at);
    self.result_revision_id = Some(result_revision_id);
    self.warnings = warnings;
    self
  }

  fn fail(
    mut self,
    finished_at: DateTime<Utc>,
    failed_stage: &'static str,
    error: TemplateOperationErrorSummary,
    validation_errors: Vec<bundle::ValidationError>,
  ) -> Self {
    self.status = "failed";
    self.finished_at = Some(finished_at);
    self.failed_stage = Some(failed_stage);
    self.error = Some(error);
    self.validation_errors = validation_errors;
    self
  }

  fn into_value(self) -> Value {
    serde_json::to_value(self).unwrap_or_else(|_| Value::Object(Default::default()))
  }
}

fn template_operation_error_summary_from_message(
  operation: TemplateRegistryOperation,
  stage: &'static str,
  message: &str,
) -> TemplateOperationErrorSummary {
  let parsed_path = extract_json_pointer_from_error_message(message);

  if let Some((code, rest)) = message.split_once(": ")
    && !code.is_empty()
    && code
      .chars()
      .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
  {
    return TemplateOperationErrorSummary {
      operation: operation.as_str(),
      stage,
      code: code.to_string(),
      message: rest.to_string(),
      path: parsed_path,
    };
  }

  TemplateOperationErrorSummary {
    operation: operation.as_str(),
    stage,
    code: "IMPORT_FAILED".to_string(),
    message: message.to_string(),
    path: parsed_path,
  }
}

fn extract_json_pointer_from_error_message(message: &str) -> Option<String> {
  // Shared import diagnostics use both "at /path" and prose ending in
  // "/path"; keep the structured report independent of that wording.
  message.split_whitespace().rev().find_map(|part| {
    let path = part.trim_end_matches(&[')', '.', ',', ';', ':'][..]);
    path.starts_with('/').then(|| path.to_string())
  })
}

fn derive_release_notes(manifest: &Value, fallback_description: Option<&str>) -> Option<String> {
  let from_manifest = manifest
    .as_object()
    .and_then(|obj| {
      obj
        .get("release_notes")
        .or_else(|| obj.get("releaseNotes"))
        .and_then(Value::as_str)
    })
    .map(str::trim)
    .filter(|text| !text.is_empty())
    .map(ToString::to_string);

  if from_manifest.is_some() {
    return from_manifest;
  }

  fallback_description
    .map(str::trim)
    .filter(|text| !text.is_empty())
    .map(ToString::to_string)
}

fn is_workspace_instance_unique_violation(err: &AuthError) -> bool {
  match err {
    AuthError::Storage(message) => {
      message.contains("workspace_template_instances_workspace_id_template_id_key")
        || message.contains("duplicate key value violates unique constraint")
    }
    _ => false,
  }
}

fn template_operation_error_summary_from_auth_error(
  operation: TemplateRegistryOperation,
  stage: &'static str,
  err: &AuthError,
) -> TemplateOperationErrorSummary {
  match err {
    AuthError::InvalidInput(message) => template_operation_error_summary_from_message(operation, stage, message),
    AuthError::Storage(message) => TemplateOperationErrorSummary {
      operation: operation.as_str(),
      stage,
      code: "STORAGE_ERROR".to_string(),
      message: message.clone(),
      path: None,
    },
    _ => TemplateOperationErrorSummary {
      operation: operation.as_str(),
      stage,
      code: "IMPORT_FAILED".to_string(),
      message: err.to_string(),
      path: None,
    },
  }
}

fn template_operation_error_summary_from_validation_error(
  operation: TemplateRegistryOperation,
  stage: &'static str,
  error: &bundle::ValidationError,
) -> TemplateOperationErrorSummary {
  TemplateOperationErrorSummary {
    operation: operation.as_str(),
    stage,
    code: error.code.clone(),
    message: error.message.clone(),
    path: error.path.clone(),
  }
}

struct TemplateRegistryMetricGuard {
  telemetry: Option<Arc<TelemetryService>>,
  failure_event: &'static str,
  normalized: bool,
  rejected: bool,
  finished: bool,
}

impl TemplateRegistryMetricGuard {
  fn new(telemetry: Option<Arc<TelemetryService>>, failure_event: &'static str) -> Self {
    Self {
      telemetry,
      failure_event,
      normalized: false,
      rejected: false,
      finished: false,
    }
  }

  fn record(&self, event_name: &'static str) {
    if let Some(telemetry) = &self.telemetry {
      telemetry.record_events(&[json!({ "eventName": event_name })]);
    }
  }

  fn mark_normalized(&mut self) {
    if !self.normalized {
      self.normalized = true;
      self.record(TEMPLATE_IMPORT_FORMAT_NORMALIZED_EVENT);
    }
  }

  fn mark_rejected(&mut self) {
    if !self.rejected {
      self.rejected = true;
      self.record(TEMPLATE_IMPORT_FORMAT_REJECTED_EVENT);
    }
  }

  fn mark_success(&mut self, event_name: &'static str) {
    self.finished = true;
    self.record(event_name);
  }
}

impl Drop for TemplateRegistryMetricGuard {
  fn drop(&mut self) {
    if self.finished {
      return;
    }

    self.record(self.failure_event);
  }
}

struct TemplateImportJobTracker<'a> {
  store: &'a dyn TemplateRegistryStore,
  job: TemplateImportJob,
  report: TemplateImportJobSummary,
}

impl<'a> TemplateImportJobTracker<'a> {
  async fn start(store: &'a dyn TemplateRegistryStore, created_by: Option<UserId>) -> AuthResult<Self> {
    let started_at = Utc::now();
    let mut job = TemplateImportJob {
      id: uuid::Uuid::new_v4(),
      uploaded_blob_id: None,
      result_revision_id: None,
      state: JobState::Pending,
      validation_report: Some(TemplateImportJobSummary::new(started_at).into_value()),
      created_by,
      started_at: Some(started_at),
      finished_at: None,
    };
    store.create_import_job(&job).await?;

    let mut report = TemplateImportJobSummary::new(started_at);
    report.status = "running";
    job.state = JobState::Running;
    job.validation_report = Some(report.clone().into_value());
    if let Err(err) = store.update_import_job(&job).await {
      warn!(job_id = %job.id, error = %err, "template.import.job_update_failed");
    }

    Ok(Self { store, job, report })
  }

  fn id(&self) -> TemplateImportJobId {
    self.job.id
  }

  fn report_snapshot(&self) -> TemplateImportJobSummary {
    self.report.clone()
  }

  fn set_report(&mut self, report: TemplateImportJobSummary) {
    self.report = report;
  }

  async fn fail(
    &mut self,
    stage: &'static str,
    error: TemplateOperationErrorSummary,
    validation_errors: Vec<bundle::ValidationError>,
  ) {
    let finished_at = Utc::now();
    self.report = self.report.clone().fail(finished_at, stage, error, validation_errors);
    self.job.state = JobState::Failed;
    self.job.finished_at = Some(finished_at);
    self.job.validation_report = Some(self.report.clone().into_value());
    if let Err(update_err) = self.store.update_import_job(&self.job).await {
      warn!(
        job_id = %self.job.id,
        error = %update_err,
        "template.import.job_finalize_failed"
      );
    }
  }

  async fn complete(
    &mut self,
    result_revision_id: TemplateRevisionId,
    warnings: Vec<bundle::ValidationError>,
    uploaded_blob_id: Option<String>,
  ) {
    let finished_at = Utc::now();
    self.report = self.report.clone().complete(finished_at, result_revision_id, warnings);
    self.job.state = JobState::Completed;
    self.job.result_revision_id = Some(result_revision_id);
    self.job.uploaded_blob_id = uploaded_blob_id;
    self.job.finished_at = Some(finished_at);
    self.job.validation_report = Some(self.report.clone().into_value());
    if let Err(update_err) = self.store.update_import_job(&self.job).await {
      warn!(
        job_id = %self.job.id,
        error = %update_err,
        "template.import.job_finalize_failed"
      );
    }
  }
}

impl TemplateRegistryService {
  /// Create a new `TemplateRegistryService` without materialization support.
  ///
  /// Reconcile without materialization dependencies fails before writing instances.
  /// Use `with_materialization` to enable full materialization.
  pub fn new(store: Arc<dyn TemplateRegistryStore>) -> Self {
    Self {
      store,
      builder_notifications: None,
      doc_service: None,
      blob_storage: None,
      asset_service: None,
      telemetry: None,
      reconcile_queue: Arc::new(OnceLock::new()),
      zip_limits: TemplateRegistryZipLimits::default(),
    }
  }

  pub fn with_builder_notifications(mut self, port: Arc<dyn TemplateBuilderNotificationPort>) -> Self {
    self.builder_notifications = Some(port);
    self
  }

  /// Shared catalog lifecycle owner. Transports authorize/capture their actor
  /// before calling; successful committed transitions emit one existing audit.
  #[instrument(skip_all, fields(template_id = %id, status = ?status, source))]
  pub async fn transition_catalog(
    &self,
    id: TemplateCatalogEntryId,
    status: TemplateStatus,
    allow_already_active: bool,
    actor: crate::audit::AuditActor,
    audit: &crate::audit::AuditRecorder,
    source: &str,
  ) -> AuthResult<TemplateCatalogEntry> {
    let entry = self
      .store
      .commit_catalog_transition(id, status, allow_already_active)
      .await?;
    use crate::audit::{AuditCategory, AuditEvent, AuditTarget};
    let event = match status {
      TemplateStatus::Archived => "template.archive",
      TemplateStatus::Disabled => "template.disable",
      TemplateStatus::Active => "template.enable",
    };
    audit
      .record(
        AuditEvent::mutation(
          event,
          AuditCategory::Template,
          Some(AuditTarget::entity("template", id, entry.title.clone())),
          actor,
          None,
          Some(json!({ "templateId": id.to_string() })),
        )
        .with_metadata(json!({ "source": source })),
      )
      .await;
    Ok(entry)
  }

  /// Attach the existing durable worker queue used by Registry reconciliation.
  pub fn set_reconcile_queue(&self, queue: Arc<dyn WorkQueuePort>) -> AuthResult<()> {
    self
      .reconcile_queue
      .set(queue)
      .map_err(|_| AuthError::Storage("template reconcile queue is already configured".to_string()))
  }

  /// Builder form used by focused tests and non-API composition roots.
  pub fn with_reconcile_queue(self, queue: Arc<dyn WorkQueuePort>) -> AuthResult<Self> {
    self.set_reconcile_queue(queue)?;
    Ok(self)
  }

  /// Attach materialization dependencies (doc service + blob storage).
  ///
  /// When both are present, reconcile will create actual workspace documents
  /// from template bundle content, and drift scans will compute live content
  /// hashes from the doc store.
  pub fn with_materialization(mut self, doc_service: DocService, blob_storage: Arc<dyn BlobStoragePort>) -> Self {
    self.doc_service = Some(doc_service);
    self.blob_storage = Some(blob_storage);
    self
  }

  /// Use normal workspace blob metadata and storage for bundled document media.
  pub fn with_asset_materialization(mut self, assets: Arc<crate::ports::blob_service::BlobService>) -> Self {
    self.asset_service = Some(assets);
    self
  }

  /// Resolve a client-visible workspace document key to the server-internal
  /// document id used by the permission service.
  ///
  /// Template instances deliberately persist the external document key so
  /// GraphQL consumers can open the document without knowing the database
  /// identity. Permission checks, however, operate on `docs.id`. Keeping the
  /// conversion here avoids making suggestion code guess which identity a
  /// template instance currently exposes.
  pub async fn resolve_workspace_doc_key(&self, workspace_id: WorkspaceId, document_key: &str) -> Option<DocId> {
    let Some(doc_service) = &self.doc_service else {
      return None;
    };

    match doc_service
      .store()
      .resolve_external_doc_id(workspace_id, DocSpaceKind::Workspace, document_key)
      .await
    {
      Ok(Some(doc_id)) => Some(doc_id),
      Ok(None) => {
        let Ok(internal_id) = document_key.parse::<DocId>() else {
          return None;
        };
        match doc_service.get_metadata(internal_id).await {
          Ok(Some(doc)) if doc.workspace_id == Some(workspace_id) => Some(internal_id),
          Ok(_) => None,
          Err(error) => {
            warn!(%workspace_id, error = %error, "failed to resolve internal workspace template document id");
            None
          }
        }
      }
      Err(error) => {
        warn!(%workspace_id, error = %error, "failed to resolve workspace template document key");
        None
      }
    }
  }

  /// Attach blob storage without enabling document materialization.
  pub fn with_blob_storage(mut self, blob_storage: Arc<dyn BlobStoragePort>) -> Self {
    self.blob_storage = Some(blob_storage);
    self
  }

  /// Attach the shared telemetry sink used by the existing API metrics endpoint.
  pub fn with_telemetry(mut self, telemetry: Arc<TelemetryService>) -> Self {
    self.telemetry = Some(telemetry);
    self
  }

  /// Attach ZIP archive safety limits for bundle import.
  pub fn with_zip_limits(mut self, zip_limits: TemplateRegistryZipLimits) -> Self {
    self.zip_limits = zip_limits;
    self
  }

  /// Return the ZIP archive safety limits currently configured on the service.
  pub fn zip_limits(&self) -> TemplateRegistryZipLimits {
    self.zip_limits
  }

  fn bundle_zip_limits(&self) -> bundle::TemplateBundleZipLimits {
    bundle::TemplateBundleZipLimits {
      max_entries: self.zip_limits.max_entries as usize,
      max_single_file_size: self.zip_limits.max_entry_uncompressed_size_mb * 1024 * 1024,
      max_total_uncompressed_size: self.zip_limits.max_total_uncompressed_size_mb * 1024 * 1024,
      max_compression_ratio: self.zip_limits.max_compression_ratio,
      max_path_length: self.zip_limits.max_path_length as usize,
    }
  }

  async fn record_audit_event(
    &self,
    level: Level,
    action: TemplateRegistryAuditAction,
    event_type: &'static str,
    context: &TemplateAuditContext,
    message: &str,
    payload_json: Option<Value>,
  ) {
    if let Err(err) = self
      .persist_audit_event(level, action, event_type, context, message, payload_json)
      .await
    {
      warn!(
        audit_event = event_type,
        error = %err,
        "failed to persist template registry audit event"
      );
    }
  }

  async fn persist_audit_event(
    &self,
    level: Level,
    action: TemplateRegistryAuditAction,
    event_type: &'static str,
    context: &TemplateAuditContext,
    message: &str,
    payload_json: Option<Value>,
  ) -> AuthResult<()> {
    context.emit(level, event_type, message);

    let event = TemplateRegistryAuditEvent {
      id: uuid::Uuid::new_v4(),
      action,
      event_type: event_type.to_string(),
      actor_user_id: context.actor_user_id,
      template_id: context.template_id,
      revision_id: context.revision_id,
      workspace_id: context.workspace_id,
      policy_id: context.policy_id,
      instance_id: context.instance_id,
      import_job_id: context.job_id,
      source_format: Some(context.source_format.clone()),
      detected_format: Some(context.detected_format.clone()),
      normalizer_version: Some(context.normalizer_version.clone()),
      ignored_entries_count: Some(context.ignored_entries_count),
      error_catalog_version: Some(context.error_catalog_version.clone()),
      error_code: Some(context.error_code.clone()),
      payload_json,
      created_at: Utc::now(),
    };

    self.store.create_audit_event(&event).await
  }

  /// Import a template bundle, creating a catalog entry (if new) and a draft revision.
  ///
  /// The bundle is stored as a blob and a validation report is generated.
  /// The caller must supply the pre-parsed manifest and checksum.
  #[instrument(skip_all, fields(slug = request.slug, version = request.version, created_by = ?request.created_by))]
  pub async fn import_template_bundle(
    &self,
    request: ImportTemplateBundleRequest<'_>,
  ) -> AuthResult<(TemplateCatalogEntry, TemplateRevision)> {
    info!(
      slug = request.slug,
      version = request.version,
      created_by = ?request.created_by,
      "template.import_bundle.start"
    );
    let revision_format_metadata = RevisionFormatMetadata::from_import(
      bundle::BundleFormat::TemplateBundle,
      0,
      TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION,
      Vec::new(),
    );
    let result = self
      .import_template_bundle_with_metadata(ImportTemplateBundleWithMetadataRequest {
        bundle: request,
        revision_format_metadata,
      })
      .await;

    match &result {
      Ok((entry, revision)) => {
        info!(
          template_id = %entry.id,
          revision_id = %revision.id,
          version = %revision.version,
          created_by = ?revision.created_by,
          "template.import_bundle.success"
        );
      }
      Err(err) => {
        error!(
          error = %err,
          "template.import_bundle.failed"
        );
      }
    }

    result
  }

  #[instrument(skip_all)]
  async fn import_template_bundle_with_metadata(
    &self,
    request: ImportTemplateBundleWithMetadataRequest<'_>,
  ) -> AuthResult<(TemplateCatalogEntry, TemplateRevision)> {
    let revision_format_metadata = request.revision_format_metadata;
    let ImportTemplateBundleRequest {
      slug,
      title,
      description,
      category,
      tags,
      version,
      bundle_blob_id,
      preview_blob_id,
      checksum,
      manifest,
      created_by,
    } = request.bundle;
    // Find or create catalog entry
    let entry = match self.store.get_catalog_entry_by_slug(slug).await? {
      Some(existing) => {
        debug!(template_id = %existing.id, "using existing catalog entry");
        existing
      }
      None => {
        let entry = TemplateCatalogEntry {
          id: uuid::Uuid::new_v4(),
          slug: slug.to_string(),
          title: title.to_string(),
          description: description.map(|s| s.to_string()),
          category: category.map(|s| s.to_string()),
          tags,
          status: TemplateStatus::Active,
          source: TemplateSource::Bundle,
          builder_version: None,
          min_client_version: 0,
          created_at: chrono::Utc::now(),
          updated_at: chrono::Utc::now(),
          archived_at: None,
        };
        if let Err(err) = self.store.create_catalog_entry(&entry).await {
          if let Some(concurrent) = self.store.get_catalog_entry_by_slug(slug).await?
            && concurrent.source == TemplateSource::Bundle
          {
            debug!(template_id = %concurrent.id, "using concurrently created catalog entry");
            concurrent
          } else {
            let audit = TemplateAuditContext::from_import_metadata(&revision_format_metadata)
              .with_actor_user_id(created_by)
              .with_error_code(audit_error_code(&err));
            self
              .record_audit_event(
                Level::WARN,
                TemplateRegistryAuditAction::Failed,
                TEMPLATE_IMPORT_FAILED_EVENT,
                &audit,
                "template import failed while creating catalog entry",
                Some(audit_payload(
                  "failed",
                  "failed to create catalog entry",
                  Some(serde_json::json!({ "slug": slug, "version": version })),
                  Some(&err),
                )),
              )
              .await;
            return Err(err);
          }
        } else {
          info!(template_id = %entry.id, slug = slug, "template catalog entry created");
          entry
        }
      }
    };

    let audit = TemplateAuditContext::from_import_metadata(&revision_format_metadata)
      .with_actor_user_id(created_by)
      .with_template_id(entry.id);
    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Imported,
        TEMPLATE_IMPORT_STARTED_EVENT,
        &audit,
        "template import started",
        Some(audit_payload(
          "started",
          "template import started",
          Some(serde_json::json!({ "slug": slug, "version": version })),
          None,
        )),
      )
      .await;

    // Create draft revision
    let release_notes = derive_release_notes(&manifest, description);
    let revision = TemplateRevision {
      id: uuid::Uuid::new_v4(),
      template_id: entry.id,
      version: version.to_string(),
      state: RevisionState::Draft,
      bundle_blob_id: Some(bundle_blob_id.to_string()),
      preview_blob_id: preview_blob_id.map(str::to_string),
      checksum: Some(checksum.to_string()),
      manifest: Some(manifest),
      release_notes,
      created_by,
      created_at: chrono::Utc::now(),
      published_at: None,
      source_format: revision_format_metadata.source_format.clone(),
      normalizer_version: revision_format_metadata.normalizer_version.clone(),
      detected_format: revision_format_metadata.detected_format.clone(),
      ignored_entries_count: revision_format_metadata.ignored_entries_count,
      error_catalog_version: revision_format_metadata.error_catalog_version.clone(),
      normalization_warnings: revision_format_metadata.normalization_warnings.clone(),
    };
    let revision = if let Err(err) = self.store.create_revision(&revision).await {
      if let Some(concurrent) = self
        .store
        .list_revisions(entry.id, 0, 1_000)
        .await?
        .into_iter()
        .find(|candidate| {
          candidate.version == version
            && candidate.checksum.as_deref() == Some(checksum)
            && candidate.manifest == revision.manifest
            && candidate.bundle_blob_id == revision.bundle_blob_id
        })
      {
        debug!(revision_id = %concurrent.id, "using concurrently created identical revision");
        concurrent
      } else {
        let audit = TemplateAuditContext::from_import_metadata(&revision_format_metadata)
          .with_actor_user_id(created_by)
          .with_template_id(entry.id)
          .with_error_code(audit_error_code(&err));
        self
          .record_audit_event(
            Level::WARN,
            TemplateRegistryAuditAction::Failed,
            TEMPLATE_IMPORT_FAILED_EVENT,
            &audit,
            "template import failed while creating revision",
            Some(audit_payload(
              "failed",
              "failed to create revision",
              Some(serde_json::json!({
                "slug": slug,
                "version": version,
                "template_id": entry.id,
              })),
              Some(&err),
            )),
          )
          .await;
        return Err(err);
      }
    } else {
      revision
    };

    Ok((entry, revision))
  }

  /// Validate stored bundle content. Already validated/published content retains
  /// its lifecycle state; an archived revision cannot be reactivated here.
  #[instrument(skip(self))]
  pub async fn validate_template_bundle(&self, revision_id: TemplateRevisionId) -> AuthResult<TemplateRevision> {
    self.validate_template_bundle_with_content(revision_id, None).await
  }

  #[instrument(skip(self, supplied_content))]
  async fn validate_template_bundle_with_content(
    &self,
    revision_id: TemplateRevisionId,
    supplied_content: Option<&[u8]>,
  ) -> AuthResult<TemplateRevision> {
    info!(revision_id = %revision_id, "template.validate.start");
    let mut revision = match self.store.get_revision(revision_id).await {
      Ok(Some(revision)) => revision,
      Ok(None) => {
        let err = AuthError::InvalidInput("Revision not found".to_string());
        error!(revision_id = %revision_id, error = %err, "template.validate.failed");
        return Err(err);
      }
      Err(err) => {
        error!(revision_id = %revision_id, error = %err, "template.validate.failed");
        return Err(err);
      }
    };

    let manifest = revision
      .manifest
      .as_ref()
      .ok_or_else(|| AuthError::InvalidInput("revision has no stored manifest".to_string()))
      .and_then(|manifest| {
        serde_json::from_value::<bundle::Manifest>(manifest.clone())
          .map_err(|error| AuthError::InvalidInput(format!("stored template manifest is invalid: {error}")))
      })?;
    let manifest_errors = bundle::validate_manifest(&manifest)
      .into_iter()
      .filter(|error| error.severity == bundle::ValidationSeverity::Error)
      .collect::<Vec<_>>();
    if let Some(error) = manifest_errors.first() {
      return Err(AuthError::InvalidInput(error.message.clone()));
    }
    let owned_content;
    let content_bytes = if let Some(content) = supplied_content {
      content
    } else {
      let blob_storage = self
        .blob_storage
        .as_deref()
        .ok_or_else(|| AuthError::Storage("template bundle storage is unavailable for validation".to_string()))?;
      let bundle_bytes = self.load_revision_bundle_bytes(&revision, blob_storage).await?;
      let parsed = bundle::parse_bundle_with_limits(&bundle_bytes, self.bundle_zip_limits())?;
      for bytes in parsed.localized_contents.values() {
        content::document_update(bytes, self.zip_limits)?;
      }
      owned_content = parsed.content_bytes;
      owned_content.as_slice()
    };
    let mut hasher = Sha256::new();
    hasher.update(content_bytes);
    let checksum = format!("{:x}", hasher.finalize());
    if revision.checksum.as_deref() != Some(checksum.as_str()) {
      return Err(AuthError::InvalidInput(
        "stored template content checksum does not match the revision".to_string(),
      ));
    }
    bundle::validate_content_checksum(&manifest, &checksum).map_err(|error| AuthError::InvalidInput(error.message))?;
    content::document_update(content_bytes, self.zip_limits)?;

    // Concurrent startup imports reuse the same immutable revision. Validation
    // is idempotent, but must never roll publication back to Validated.
    if matches!(
      revision.state,
      RevisionState::Validated | RevisionState::Published | RevisionState::Deprecated
    ) {
      return Ok(revision);
    }

    if let Err(err) = revision.mark_validated() {
      warn!(revision_id = %revision_id, error = %err, "template.validate.failed");
      let audit = TemplateAuditContext::from_revision_with_error(&revision, "INVALID_INPUT");
      self
        .record_audit_event(
          Level::WARN,
          TemplateRegistryAuditAction::Failed,
          TEMPLATE_IMPORT_FAILED_EVENT,
          &audit,
          "template validation failed",
          Some(audit_payload(
            "failed",
            "template revision validation failed",
            Some(serde_json::json!({ "revision_id": revision_id })),
            Some(&AuthError::InvalidInput(err.to_string())),
          )),
        )
        .await;
      return Err(AuthError::InvalidInput(err.to_string()));
    }

    if let Err(err) = self.store.update_revision(&revision).await {
      if let Some(current) = self.store.get_revision(revision_id).await?
        && matches!(
          current.state,
          RevisionState::Validated | RevisionState::Published | RevisionState::Deprecated
        )
        && current.checksum == revision.checksum
        && current.manifest == revision.manifest
        && current.bundle_blob_id == revision.bundle_blob_id
      {
        return Ok(current);
      }
      error!(revision_id = %revision_id, error = %err, "template.validate.failed");
      return Err(err);
    }
    let audit = TemplateAuditContext::from_revision(&revision);
    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Validated,
        TEMPLATE_IMPORT_VALIDATED_EVENT,
        &audit,
        "template revision validated",
        Some(audit_payload(
          "validated",
          "template revision validated",
          Some(serde_json::json!({ "revision_id": revision_id, "template_id": revision.template_id })),
          None,
        )),
      )
      .await;
    info!(
      revision_id = %revision_id,
      template_id = %revision.template_id,
      "template.validate.success"
    );
    Ok(revision)
  }

  /// Publish a validated revision, making it available for workspace provisioning.
  ///
  /// Previously published revisions for the same template are deprecated.
  #[instrument(skip(self))]
  pub async fn publish_revision(&self, revision_id: TemplateRevisionId) -> AuthResult<TemplateRevision> {
    info!(revision_id = %revision_id, "template.publish.start");
    let result = self.publish_revision_with_actor(revision_id, None).await;
    match &result {
      Ok(revision) => {
        info!(
          revision_id = %revision.id,
          template_id = %revision.template_id,
          "template.publish.success"
        );
      }
      Err(err) => {
        error!(revision_id = %revision_id, error = %err, "template.publish.failed");
      }
    }
    result
  }

  #[instrument(skip(self))]
  pub async fn publish_revision_with_actor(
    &self,
    revision_id: TemplateRevisionId,
    actor_user_id: Option<UserId>,
  ) -> AuthResult<TemplateRevision> {
    info!(revision_id = %revision_id, actor_user_id = ?actor_user_id, "template.publish.start");
    let mut revision = match self.store.get_revision(revision_id).await {
      Ok(Some(revision)) => revision,
      Ok(None) => {
        let audit = TemplateAuditContext::unknown()
          .with_actor_user_id(actor_user_id)
          .with_revision_id(revision_id)
          .with_error_code("NOT_FOUND");
        let err = AuthError::NotFound(format!("revision {} not found", revision_id));
        warn!(revision_id = %revision_id, actor_user_id = ?actor_user_id, error = %err, "template.publish.failed");
        self
          .record_audit_event(
            Level::WARN,
            TemplateRegistryAuditAction::Failed,
            TEMPLATE_REVISION_PUBLISH_FAILED_EVENT,
            &audit,
            "template revision publish target not found",
            Some(audit_payload(
              "failed",
              "template revision publish target not found",
              Some(serde_json::json!({ "revision_id": revision_id })),
              Some(&err),
            )),
          )
          .await;
        return Err(err);
      }
      Err(err) => {
        error!(revision_id = %revision_id, actor_user_id = ?actor_user_id, error = %err, "template.publish.failed");
        return Err(err);
      }
    };

    if let Err(err) = revision.publish() {
      let audit =
        TemplateAuditContext::from_revision_with_error(&revision, "INVALID_INPUT").with_actor_user_id(actor_user_id);
      warn!(
        revision_id = %revision_id,
        template_id = %revision.template_id,
        actor_user_id = ?actor_user_id,
        error = %err,
        "template.publish.failed"
      );
      self
        .record_audit_event(
          Level::WARN,
          TemplateRegistryAuditAction::Failed,
          TEMPLATE_REVISION_PUBLISH_FAILED_EVENT,
          &audit,
          "template revision publish failed",
          Some(audit_payload(
            "failed",
            "template revision publish failed",
            Some(serde_json::json!({ "revision_id": revision_id, "template_id": revision.template_id })),
            Some(&AuthError::InvalidInput(err.to_string())),
          )),
        )
        .await;
      return Err(AuthError::InvalidInput(err.to_string()));
    }

    // Recheck the native transition after locking; a concurrent publication
    // cannot leave two current revisions or deprecate an operator's winner.
    revision = self.store.commit_revision_publication(revision_id).await?;
    let audit = TemplateAuditContext::from_revision(&revision).with_actor_user_id(actor_user_id);
    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Published,
        TEMPLATE_REVISION_PUBLISHED_EVENT,
        &audit,
        "template revision published",
        Some(audit_payload(
          "published",
          "template revision published",
          Some(serde_json::json!({
            "template_id": revision.template_id,
            "revision_id": revision.id,
            "version": revision.version,
          })),
          None,
        )),
      )
      .await;
    info!(
      revision_id = %revision.id,
      template_id = %revision.template_id,
      actor_user_id = ?actor_user_id,
      "template.publish.success"
    );
    Ok(revision)
  }

  /// Resolve the catalog entry for feature integrations that only bind to a
  /// Template Registry catalog entry and must not duplicate registry storage.
  pub async fn get_catalog_entry_for_binding(
    &self,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Option<TemplateCatalogEntry>> {
    self.store.get_catalog_entry(template_id).await
  }

  /// Return the workspace-local materialization state for a catalog entry.
  ///
  /// Database row templates use this to surface detached/reconcile-required
  /// states without constructing a second template lifecycle model.
  pub async fn find_workspace_instance_for_binding(
    &self,
    workspace_id: WorkspaceId,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Option<WorkspaceTemplateInstance>> {
    self.store.find_instance(workspace_id, template_id).await
  }

  pub async fn is_managed_source(&self, workspace_id: WorkspaceId, doc_id: DocId) -> AuthResult<bool> {
    self.store.is_managed_source(workspace_id, doc_id).await
  }

  /// Resolve the current published revision for integrations whose use case is
  /// blocked until the Template Registry has a published target.
  pub async fn latest_published_revision_for_binding(
    &self,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Option<TemplateRevision>> {
    self.store.get_latest_published_revision(template_id).await
  }

  /// Create the canonical Template Registry records for one portable Database
  /// Row-template body. The materialized workspace document is the sole body
  /// source used when the Row template is later applied.
  #[instrument(skip(self, update), fields(%workspace_id, %workspace_doc_id, %actor))]
  pub async fn create_portable_database_row_template(
    &self,
    workspace_id: WorkspaceId,
    workspace_doc_id: DocId,
    title: &str,
    update: Vec<u8>,
    actor: UserId,
  ) -> AuthResult<PortableDatabaseRowTemplate> {
    let doc_service = self
      .doc_service
      .clone()
      .ok_or_else(|| AuthError::Storage("template document materialization is not configured".to_string()))?;
    let template_id = uuid::Uuid::new_v4();
    let revision_id = uuid::Uuid::new_v4();
    let now = Utc::now();
    let checksum = hex::encode(Sha256::digest(&update));
    let entry = TemplateCatalogEntry {
      id: template_id,
      slug: format!("database-row-import-{template_id}"),
      title: title.to_string(),
      description: Some("Portable Database Row template content".to_string()),
      category: Some("database-row-content".to_string()),
      tags: vec!["database".to_string(), "row-template".to_string()],
      status: TemplateStatus::Active,
      source: TemplateSource::Bundle,
      builder_version: None,
      min_client_version: 0,
      created_at: now,
      updated_at: now,
      archived_at: None,
    };
    self.store.create_catalog_entry(&entry).await?;
    let revision = TemplateRevision {
      id: revision_id,
      template_id,
      version: "1.0.0".to_string(),
      state: RevisionState::Published,
      bundle_blob_id: None,
      preview_blob_id: None,
      checksum: Some(checksum.clone()),
      manifest: Some(json!({ "format": "myoxus-database-row-content" })),
      release_notes: None,
      created_by: Some(actor),
      created_at: now,
      published_at: Some(now),
      source_format: "myoxus-database-snapshot".to_string(),
      normalizer_version: "none".to_string(),
      detected_format: "myoxus-database-row-content".to_string(),
      ignored_entries_count: 0,
      error_catalog_version: TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION.to_string(),
      normalization_warnings: Vec::new(),
    };
    if let Err(error) = self.store.create_revision(&revision).await {
      let _ = self.store.delete_catalog_entry(template_id).await;
      return Err(error);
    }
    if let Err(error) = doc_service
      .create_doc(workspace_id, workspace_doc_id, title.to_string(), false, actor)
      .await
    {
      let _ = self.store.delete_catalog_entry(template_id).await;
      return Err(error);
    }
    if let Err(error) = doc_service
      .push_update_raw(workspace_id, workspace_doc_id, update, DocSpaceKind::Workspace)
      .await
    {
      let _ = doc_service.delete_doc(workspace_id, workspace_doc_id).await;
      let _ = self.store.delete_catalog_entry(template_id).await;
      return Err(error);
    }
    let instance = WorkspaceTemplateInstance {
      id: uuid::Uuid::new_v4(),
      workspace_id,
      template_id,
      revision_id,
      workspace_doc_id: Some(workspace_doc_id),
      workspace_doc_key: Some(workspace_doc_id.to_string()),
      state: InstanceState::Ok,
      last_applied_hash: Some(checksum.clone()),
      current_hash: Some(checksum),
      last_synced_at: Some(now),
      detached_at: None,
      retired_at: None,
      last_error_code: None,
      last_error_message: None,
      expected_hash: None,
      locale_hash: None,
    };
    if let Err(error) = self.store.create_instance(&instance).await {
      let _ = doc_service.delete_doc(workspace_id, workspace_doc_id).await;
      let _ = self.store.delete_catalog_entry(template_id).await;
      return Err(error);
    }
    Ok(PortableDatabaseRowTemplate {
      template_id,
      workspace_doc_id,
    })
  }

  #[instrument(skip(self, materialized), fields(%workspace_id, template_id = %materialized.template_id, workspace_doc_id = %materialized.workspace_doc_id))]
  pub async fn compensate_portable_database_row_template(
    &self,
    workspace_id: WorkspaceId,
    materialized: &PortableDatabaseRowTemplate,
  ) {
    if let Some(doc_service) = &self.doc_service
      && let Err(error) = doc_service
        .delete_doc(workspace_id, materialized.workspace_doc_id)
        .await
    {
      error!(
        workspace_id = %workspace_id,
        template_id = %materialized.template_id,
        workspace_doc_id = %materialized.workspace_doc_id,
        error = %error,
        "failed to compensate portable Database Row-template document"
      );
    }
    if let Err(error) = self.store.delete_catalog_entry(materialized.template_id).await {
      error!(
        workspace_id = %workspace_id,
        template_id = %materialized.template_id,
        error = %error,
        "failed to compensate portable Database Row template"
      );
    }
  }

  /// Assign a template to a workspace by creating a policy.
  ///
  /// Validates that the template is assignable (active, not archived/disabled).
  #[instrument(skip(self))]
  pub async fn assign_template_to_workspace(
    &self,
    workspace_id: WorkspaceId,
    template_id: TemplateCatalogEntryId,
    selection_mode: SelectionMode,
    selected_revision_id: Option<TemplateRevisionId>,
    provisioning_mode: ProvisioningMode,
  ) -> AuthResult<WorkspaceTemplatePolicy> {
    info!(
      workspace_id = %workspace_id,
      template_id = %template_id,
      selection_mode = %selection_mode,
      "template.assign.start"
    );
    let result = self
      .assign_template_to_workspace_with_actor(
        workspace_id,
        template_id,
        selection_mode,
        selected_revision_id,
        provisioning_mode,
        None,
      )
      .await;
    match &result {
      Ok(policy) => {
        info!(
          policy_id = %policy.id,
          workspace_id = %policy.workspace_id,
          template_id = %policy.template_id,
          "template.assign.success"
        );
      }
      Err(err) => {
        error!(
          workspace_id = %workspace_id,
          template_id = %template_id,
          error = %err,
          "template.assign.failed"
        );
      }
    }
    result
  }

  #[instrument(skip(self))]
  pub async fn assign_template_to_workspace_with_actor(
    &self,
    workspace_id: WorkspaceId,
    template_id: TemplateCatalogEntryId,
    selection_mode: SelectionMode,
    selected_revision_id: Option<TemplateRevisionId>,
    provisioning_mode: ProvisioningMode,
    actor_user_id: Option<UserId>,
  ) -> AuthResult<WorkspaceTemplatePolicy> {
    info!(
      workspace_id = %workspace_id,
      template_id = %template_id,
      selection_mode = %selection_mode,
      actor_user_id = ?actor_user_id,
      "template.assign.start"
    );
    let entry = match self.store.get_catalog_entry(template_id).await {
      Ok(Some(entry)) => entry,
      Ok(None) => {
        let audit = TemplateAuditContext::unknown()
          .with_actor_user_id(actor_user_id)
          .with_template_id(template_id)
          .with_workspace_id(workspace_id)
          .with_error_code("NOT_FOUND");
        let err = AuthError::NotFound(format!("template {} not found", template_id));
        error!(
          workspace_id = %workspace_id,
          template_id = %template_id,
          actor_user_id = ?actor_user_id,
          error = %err,
          "template.assign.failed"
        );
        self
          .record_audit_event(
            Level::WARN,
            TemplateRegistryAuditAction::Failed,
            TEMPLATE_ASSIGNMENT_REJECTED_EVENT,
            &audit,
            "template assignment target not found",
            Some(audit_payload(
              "failed",
              "template assignment target not found",
              Some(serde_json::json!({
                "template_id": template_id,
                "workspace_id": workspace_id,
              })),
              Some(&err),
            )),
          )
          .await;
        return Err(err);
      }
      Err(err) => {
        error!(
          workspace_id = %workspace_id,
          template_id = %template_id,
          actor_user_id = ?actor_user_id,
          error = %err,
          "template.assign.failed"
        );
        return Err(err);
      }
    };
    let base_audit = TemplateAuditContext::unknown()
      .with_actor_user_id(actor_user_id)
      .with_template_id(template_id)
      .with_workspace_id(workspace_id);

    if let Err(err) = entry.can_assign() {
      let audit = base_audit.clone().with_error_code("INVALID_INPUT");
      self
        .record_audit_event(
          Level::WARN,
          TemplateRegistryAuditAction::Failed,
          TEMPLATE_ASSIGNMENT_REJECTED_EVENT,
          &audit,
          "template assignment rejected",
          Some(audit_payload(
            "failed",
            "template assignment rejected",
            Some(serde_json::json!({
              "template_id": template_id,
              "workspace_id": workspace_id,
              "reason": err.to_string(),
            })),
            Some(&AuthError::InvalidInput(err.to_string())),
          )),
        )
        .await;
      return Err(AuthError::InvalidInput(err.to_string()));
    }

    let resolved_revision = match selection_mode {
      SelectionMode::Published => match self.store.get_latest_published_revision(template_id).await {
        Ok(revision) => revision,
        Err(err) => {
          warn!(
            template_id = %template_id,
            workspace_id = %workspace_id,
            error = %err,
            "template assignment audit could not resolve latest published revision"
          );
          None
        }
      },
      SelectionMode::PinnedRevision => match selected_revision_id {
        Some(revision_id) => match self.store.get_revision(revision_id).await {
          Ok(revision) => revision,
          Err(err) => {
            warn!(
              revision_id = %revision_id,
              template_id = %template_id,
              workspace_id = %workspace_id,
              error = %err,
              "template assignment audit could not resolve pinned revision"
            );
            None
          }
        },
        None => None,
      },
    };
    if selection_mode == SelectionMode::PinnedRevision {
      let revision = resolved_revision
        .as_ref()
        .ok_or_else(|| AuthError::InvalidInput("a pinned assignment requires an existing revision".to_string()))?;
      if revision.template_id != template_id {
        return Err(AuthError::InvalidInput(
          "the pinned revision does not belong to the selected template".to_string(),
        ));
      }
      if !matches!(revision.state, RevisionState::Published | RevisionState::Deprecated) {
        return Err(AuthError::InvalidInput("the pinned revision is not usable".to_string()));
      }
    }

    let policy = WorkspaceTemplatePolicy {
      id: uuid::Uuid::new_v4(),
      workspace_id,
      template_id,
      selection_mode,
      selected_revision_id,
      provisioning_mode: if resolved_revision.as_ref().is_some_and(revision_is_guide) {
        ProvisioningMode::SeedOnce
      } else {
        provisioning_mode
      },
      is_enabled: true,
      created_at: chrono::Utc::now(),
      updated_at: chrono::Utc::now(),
    };
    if let Err(err) = self
      .store
      .create_policy_for_explicit_assignment(&policy, resolved_revision.as_ref().map(|revision| revision.id))
      .await
    {
      error!(
        workspace_id = %workspace_id,
        template_id = %template_id,
        policy_id = %policy.id,
        actor_user_id = ?actor_user_id,
        error = %err,
        "template.assign.failed"
      );
      return Err(err);
    }

    let audit = resolved_revision
      .as_ref()
      .map(TemplateAuditContext::from_revision)
      .unwrap_or_else(TemplateAuditContext::unknown)
      .with_actor_user_id(actor_user_id)
      .with_template_id(template_id)
      .with_workspace_id(workspace_id)
      .with_policy_id(policy.id);
    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Assigned,
        TEMPLATE_ASSIGNMENT_CREATED_EVENT,
        &audit,
        "template assigned to workspace",
        Some(audit_payload(
          "created",
          "template assigned to workspace",
          Some(serde_json::json!({
            "template_id": template_id,
            "workspace_id": workspace_id,
            "policy_id": policy.id,
            "selection_mode": selection_mode.to_string(),
            "selected_revision_id": selected_revision_id,
            "provisioning_mode": provisioning_mode.to_string(),
          })),
          None,
        )),
      )
      .await;
    info!(
      workspace_id = %workspace_id,
      template_id = %template_id,
      policy_id = %policy.id,
      actor_user_id = ?actor_user_id,
      "template.assign.success"
    );
    Ok(policy)
  }

  /// Remove a workspace template assignment by deleting its policy.
  #[instrument(skip(self))]
  pub async fn remove_template_assignment(&self, policy_id: WorkspaceTemplatePolicyId) -> AuthResult<()> {
    info!(policy_id = %policy_id, "template.assignment.remove.start");
    let result = self.remove_template_assignment_with_actor(policy_id, None).await;
    match &result {
      Ok(()) => info!(policy_id = %policy_id, "template.assignment.remove.success"),
      Err(err) => error!(policy_id = %policy_id, error = %err, "template.assignment.remove.failed"),
    }
    result
  }

  #[instrument(skip(self))]
  pub async fn remove_template_assignment_with_actor(
    &self,
    policy_id: WorkspaceTemplatePolicyId,
    actor_user_id: Option<UserId>,
  ) -> AuthResult<()> {
    info!(policy_id = %policy_id, actor_user_id = ?actor_user_id, "template.assignment.remove.start");
    let policy = match self.store.get_policy(policy_id).await {
      Ok(Some(policy)) => policy,
      Ok(None) => {
        let audit = TemplateAuditContext::unknown()
          .with_actor_user_id(actor_user_id)
          .with_policy_id(policy_id)
          .with_error_code("NOT_FOUND");
        let err = AuthError::NotFound(format!("policy {} not found", policy_id));
        error!(policy_id = %policy_id, actor_user_id = ?actor_user_id, error = %err, "template.assignment.remove.failed");
        self
          .record_audit_event(
            Level::WARN,
            TemplateRegistryAuditAction::Failed,
            TEMPLATE_ASSIGNMENT_REMOVED_EVENT,
            &audit,
            "template assignment removal target not found",
            Some(audit_payload(
              "failed",
              "template assignment removal target not found",
              Some(serde_json::json!({ "policy_id": policy_id })),
              Some(&err),
            )),
          )
          .await;
        return Err(err);
      }
      Err(err) => {
        error!(policy_id = %policy_id, actor_user_id = ?actor_user_id, error = %err, "template.assignment.remove.failed");
        return Err(err);
      }
    };
    let revision = match policy.selection_mode {
      SelectionMode::Published => match self.store.get_latest_published_revision(policy.template_id).await {
        Ok(revision) => revision,
        Err(err) => {
          warn!(
            policy_id = %policy.id,
            template_id = %policy.template_id,
            workspace_id = %policy.workspace_id,
            error = %err,
            "template assignment removal audit could not resolve latest published revision"
          );
          None
        }
      },
      SelectionMode::PinnedRevision => match policy.selected_revision_id {
        Some(revision_id) => match self.store.get_revision(revision_id).await {
          Ok(revision) => revision,
          Err(err) => {
            warn!(
              policy_id = %policy.id,
              revision_id = %revision_id,
              template_id = %policy.template_id,
              workspace_id = %policy.workspace_id,
              error = %err,
              "template assignment removal audit could not resolve pinned revision"
            );
            None
          }
        },
        None => None,
      },
    };
    let audit = revision
      .as_ref()
      .map(TemplateAuditContext::from_revision)
      .unwrap_or_else(TemplateAuditContext::unknown)
      .with_actor_user_id(actor_user_id)
      .with_template_id(policy.template_id)
      .with_workspace_id(policy.workspace_id)
      .with_policy_id(policy.id);

    if let Err(err) = self.store.delete_policy(policy_id).await {
      let audit = audit.clone().with_error_code(audit_error_code(&err));
      error!(
        policy_id = %policy_id,
        workspace_id = %policy.workspace_id,
        template_id = %policy.template_id,
        actor_user_id = ?actor_user_id,
        error = %err,
        "template.assignment.remove.failed"
      );
      self
        .record_audit_event(
          Level::WARN,
          TemplateRegistryAuditAction::Failed,
          TEMPLATE_ASSIGNMENT_REMOVED_EVENT,
          &audit,
          "template assignment removal failed",
          Some(audit_payload(
            "failed",
            "template assignment removal failed",
            Some(serde_json::json!({
              "policy_id": policy_id,
              "workspace_id": policy.workspace_id,
              "template_id": policy.template_id,
            })),
            Some(&err),
          )),
        )
        .await;
      return Err(err);
    }

    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Deleted,
        TEMPLATE_ASSIGNMENT_REMOVED_EVENT,
        &audit,
        "template assignment removed",
        Some(audit_payload(
          "removed",
          "template assignment removed",
          Some(serde_json::json!({
            "policy_id": policy_id,
            "workspace_id": policy.workspace_id,
            "template_id": policy.template_id,
            "revision_id": audit.revision_id,
          })),
          None,
        )),
      )
      .await;
    info!(
      policy_id = %policy_id,
      workspace_id = %policy.workspace_id,
      template_id = %policy.template_id,
      actor_user_id = ?actor_user_id,
      "template.assignment.remove.success"
    );
    Ok(())
  }

  /// Retire a workspace template assignment and its active instance, if any.
  #[instrument(skip(self))]
  pub async fn retire_template_assignment(&self, policy_id: WorkspaceTemplatePolicyId) -> AuthResult<()> {
    info!(policy_id = %policy_id, "template.assignment.retire.start");
    let result = self.retire_template_assignment_with_actor(policy_id, None).await;
    match &result {
      Ok(()) => info!(policy_id = %policy_id, "template.assignment.retire.success"),
      Err(err) => error!(policy_id = %policy_id, error = %err, "template.assignment.retire.failed"),
    }
    result
  }

  /// Retire an automatically selected source without reclaiming explicit policy
  /// choices or deleting edited reader content. Callers own the release scope;
  /// this boundary owns native content attestation and the final deletion fence.
  #[instrument(skip_all, fields(policy_id = %policy_id))]
  pub async fn retire_unchanged_template_assignment(&self, policy_id: WorkspaceTemplatePolicyId) -> AuthResult<()> {
    let Some(policy) = self.store.get_policy(policy_id).await? else {
      return Ok(());
    };
    if !policy.is_enabled
      || policy.selection_mode != SelectionMode::Published
      || policy.provisioning_mode == ProvisioningMode::ManualUpdate
    {
      return Ok(());
    }
    let instance = self
      .store
      .find_instance(policy.workspace_id, policy.template_id)
      .await?;
    let guide = if let Some(instance) = &instance {
      self
        .store
        .get_revision(instance.revision_id)
        .await?
        .as_ref()
        .is_some_and(revision_is_guide)
    } else {
      policy.provisioning_mode == ProvisioningMode::SeedOnce
        && self
          .store
          .list_revisions(policy.template_id, 0, 200)
          .await?
          .iter()
          .any(revision_is_guide)
    };
    if guide {
      // Native retirement already removes only delivery ownership for guides.
      return self.retire_template_assignment(policy_id).await;
    }
    if policy.provisioning_mode != ProvisioningMode::ManagedUntilLocalEdit {
      return Ok(());
    }
    if let Some(instance) = &instance
      && instance.workspace_doc_id.is_none()
      && instance.workspace_doc_key.is_some()
      && self
        .store
        .source_attribution(policy.workspace_id, policy.template_id)
        .await?
        .is_some_and(|source| source.resolved_doc_id.is_some())
    {
      return Err(AuthError::InvalidInput(
        "source binding requires explicit release recovery".into(),
      ));
    }
    let source_revision = if let Some(instance) = instance
      .as_ref()
      .filter(|instance| instance.state != InstanceState::Detached)
    {
      self.unchanged_source_revision(instance).await?
    } else {
      None
    };
    if source_revision.is_none() {
      self
        .store
        .preserve_source_as_custom(policy.workspace_id, policy.template_id)
        .await?;
    }
    self
      .retire_template_assignment_inner(policy_id, None, source_revision, true)
      .await
  }

  #[instrument(skip(self))]
  pub async fn retire_template_assignment_with_actor(
    &self,
    policy_id: WorkspaceTemplatePolicyId,
    actor_user_id: Option<UserId>,
  ) -> AuthResult<()> {
    self
      .retire_template_assignment_inner(policy_id, actor_user_id, None, false)
      .await
  }

  async fn retire_template_assignment_inner(
    &self,
    policy_id: WorkspaceTemplatePolicyId,
    actor_user_id: Option<UserId>,
    source_revision: Option<(DocId, i64)>,
    automatic: bool,
  ) -> AuthResult<()> {
    info!(policy_id = %policy_id, actor_user_id = ?actor_user_id, "template.assignment.retire.start");
    let policy = match self.store.get_policy(policy_id).await {
      Ok(Some(policy)) => policy,
      Ok(None) => {
        let audit = TemplateAuditContext::unknown()
          .with_actor_user_id(actor_user_id)
          .with_policy_id(policy_id)
          .with_error_code("NOT_FOUND");
        let err = AuthError::NotFound(format!("policy {} not found", policy_id));
        error!(policy_id = %policy_id, actor_user_id = ?actor_user_id, error = %err, "template.assignment.retire.failed");
        self
          .record_audit_event(
            Level::WARN,
            TemplateRegistryAuditAction::Failed,
            TEMPLATE_ASSIGNMENT_RETIRED_EVENT,
            &audit,
            "template assignment retirement target not found",
            Some(audit_payload(
              "failed",
              "template assignment retirement target not found",
              Some(serde_json::json!({ "policy_id": policy_id })),
              Some(&err),
            )),
          )
          .await;
        return Err(err);
      }
      Err(err) => {
        error!(policy_id = %policy_id, actor_user_id = ?actor_user_id, error = %err, "template.assignment.retire.failed");
        return Err(err);
      }
    };
    let revision = match policy.selection_mode {
      SelectionMode::Published => match self.store.get_latest_published_revision(policy.template_id).await {
        Ok(revision) => revision,
        Err(err) => {
          warn!(
            policy_id = %policy.id,
            template_id = %policy.template_id,
            workspace_id = %policy.workspace_id,
            error = %err,
            "template assignment retirement audit could not resolve latest published revision"
          );
          None
        }
      },
      SelectionMode::PinnedRevision => match policy.selected_revision_id {
        Some(revision_id) => match self.store.get_revision(revision_id).await {
          Ok(revision) => revision,
          Err(err) => {
            warn!(
              policy_id = %policy.id,
              revision_id = %revision_id,
              template_id = %policy.template_id,
              workspace_id = %policy.workspace_id,
              error = %err,
              "template assignment retirement audit could not resolve pinned revision"
            );
            None
          }
        },
        None => None,
      },
    };
    let audit = revision
      .as_ref()
      .map(TemplateAuditContext::from_revision)
      .unwrap_or_else(TemplateAuditContext::unknown)
      .with_actor_user_id(actor_user_id)
      .with_template_id(policy.template_id)
      .with_workspace_id(policy.workspace_id)
      .with_policy_id(policy.id);

    let reader_owned_guide = match self
      .store
      .find_instance(policy.workspace_id, policy.template_id)
      .await?
    {
      Some(instance) => self
        .store
        .get_revision(instance.revision_id)
        .await?
        .as_ref()
        .is_some_and(revision_is_guide),
      None => false,
    };
    let retiring = if automatic {
      if !policy.is_enabled
        || policy.selection_mode != SelectionMode::Published
        || policy.provisioning_mode != ProvisioningMode::ManagedUntilLocalEdit
      {
        return Err(AuthError::InvalidInput("source replacement eligibility changed".into()));
      }
      self.store.begin_eligible_source_retirement(&policy).await?
    } else {
      self
        .store
        .begin_central_source_retirement(policy.workspace_id, policy.template_id)
        .await?
    };
    let retired_instance_id = retiring.as_ref().map(|source| source.instance_id);
    if let Some((instance_id, retired_key)) = retiring.as_ref().filter(|_| !reader_owned_guide).and_then(|source| {
      source
        .workspace_doc_key
        .clone()
        .or_else(|| source.workspace_doc_id.map(|id| id.to_string()))
        .map(|key| (source.instance_id, key))
    }) {
      let recorded = self
        .store
        .list_audit_events(
          Some(TemplateRegistryAuditEventFilter {
            event_type: Some(TEMPLATE_DEFAULT_REPLACED_EVENT.into()),
            policy_id: Some(policy_id),
            ..TemplateRegistryAuditEventFilter::default()
          }),
          0,
          1,
        )
        .await?;
      if recorded.is_empty() {
        // Keep the old key durable before deletion/clearing its binding. Readers
        // expose this effect only after the physical source is actually absent.
        self.persist_audit_event(Level::INFO,TemplateRegistryAuditAction::Updated,TEMPLATE_DEFAULT_REPLACED_EVENT,
          &audit.clone().with_instance_id(instance_id),
          "template default source withdrawal pending",Some(json!({
            "retired_source_doc_id":retired_key,"replacement_source_doc_id":null,"source_template_id":policy.template_id,
          }))).await?;
      }
    }
    if let Some(source) = retiring {
      debug!(
        workspace_id = %policy.workspace_id,
        template_id = %policy.template_id,
        instance_id = %source.instance_id,
        source = %source.source,
        "template central source retirement started"
      );
      if let Some(source_doc_id) = source.workspace_doc_id.filter(|_| !reader_owned_guide) {
        if automatic && source_revision.is_none() {
          // An edited source was relinquished before this transaction. A newly
          // linked body is not covered by that missing-source observation.
          return Err(AuthError::InvalidInput(
            "automatic retirement source changed; retry recovery".into(),
          ));
        }
        let Some(doc_service) = &self.doc_service else {
          return Err(AuthError::Storage(
            "template retirement document lifecycle is unavailable".to_string(),
          ));
        };
        let source_key = source.workspace_doc_key.unwrap_or_else(|| source_doc_id.to_string());
        let request = PermanentDeleteRequest {
          workspace_id: policy.workspace_id,
          actor_user_id,
          mode: PermanentDeleteMode::SelectedDocs,
          doc_ids: vec![source_key],
        };
        let deleted = match source_revision {
          Some((expected_doc, revision)) => {
            doc_service
              .permanently_delete_source_at_revision(request, expected_doc, revision)
              .await?
          }
          None => doc_service.permanently_delete_documents(request).await?,
        };
        if !deleted.is_success() || deleted.deleted + deleted.already_deleted + deleted.not_found != 1 {
          return Err(AuthError::Storage(
            "template source permanent deletion did not complete".to_string(),
          ));
        }
      }
      self
        .store
        .complete_central_source_retirement(policy.workspace_id, policy.template_id)
        .await?;
    }

    let audit = if let Some(instance_id) = retired_instance_id {
      audit.clone().with_instance_id(instance_id)
    } else {
      audit.clone()
    };
    let retirement_recorded = self
      .store
      .list_audit_events(
        Some(TemplateRegistryAuditEventFilter {
          action: Some(TemplateRegistryAuditAction::Deleted),
          event_type: Some(TEMPLATE_ASSIGNMENT_RETIRED_EVENT.to_string()),
          policy_id: Some(policy_id),
          ..TemplateRegistryAuditEventFilter::default()
        }),
        0,
        1,
      )
      .await?
      .into_iter()
      .next()
      .is_some();
    if !retirement_recorded {
      self
        .persist_audit_event(
          Level::INFO,
          TemplateRegistryAuditAction::Deleted,
          TEMPLATE_ASSIGNMENT_RETIRED_EVENT,
          &audit,
          "template assignment retired",
          Some(audit_payload(
            "retired",
            "template assignment retired",
            Some(serde_json::json!({
              "policy_id": policy_id,
              "workspace_id": policy.workspace_id,
              "template_id": policy.template_id,
              "revision_id": audit.revision_id,
              "instance_id": retired_instance_id,
            })),
            None,
          )),
        )
        .await?;
    }

    if let Err(err) = self.store.delete_policy(policy_id).await {
      let failed_audit = audit.clone().with_error_code(audit_error_code(&err));
      self
        .record_audit_event(
          Level::WARN,
          TemplateRegistryAuditAction::Failed,
          TEMPLATE_ASSIGNMENT_RETIRED_EVENT,
          &failed_audit,
          "template assignment retirement cleanup remains pending",
          Some(audit_payload(
            "failed",
            "template assignment retirement cleanup remains pending",
            Some(serde_json::json!({
              "policy_id": policy_id,
              "workspace_id": policy.workspace_id,
              "template_id": policy.template_id,
            })),
            Some(&err),
          )),
        )
        .await;
      return Err(err);
    }
    info!(
      policy_id = %policy_id,
      workspace_id = %policy.workspace_id,
      template_id = %policy.template_id,
      instance_id = ?retired_instance_id,
      actor_user_id = ?actor_user_id,
      "template.assignment.retire.success"
    );
    Ok(())
  }

  /// Reconcile template instances for a workspace.
  ///
  /// For each active policy:
  /// - If no instance exists, materialize a new one (Phase 5).
  /// - If instance exists and is unmodified, update to the target revision.
  /// - If instance has local changes, detach it.
  /// - If policy was removed, retire the instance.
  ///
  /// **Materialization (Phase 5)**: When `doc_service` and `blob_storage` are
  /// available, new instances are fully materialized — bundle content is read
  /// from blob storage, a workspace document is created, and the content hash
  /// is recorded. Missing materialization dependencies fail before any write.
  #[instrument(skip(self))]
  pub async fn reconcile_workspace_templates(
    &self,
    workspace_id: WorkspaceId,
  ) -> AuthResult<Vec<WorkspaceTemplateInstance>> {
    // This is the existing mutating Registry operation, not a source read.
    // Release publication schedules it independently of Library activity.
    for template_id in self.store.pending_release_default_ids(workspace_id).await? {
      self
        .assign_template_to_workspace(
          workspace_id,
          template_id,
          SelectionMode::Published,
          None,
          ProvisioningMode::ManagedUntilLocalEdit,
        )
        .await?;
    }
    for policy_id in self.store.withdrawn_release_policy_ids(workspace_id).await? {
      self.retire_unchanged_template_assignment(policy_id).await?;
    }
    self.reconcile_workspace_templates_inner(workspace_id, None).await
  }

  /// Apply one explicitly selected revision to a manual-update assignment.
  ///
  /// The regular reconcile path continues to report availability only. This
  /// entry point validates Admin intent and then uses the same document lock,
  /// revision check, and instance persistence path as managed updates.
  #[instrument(skip(self), fields(%workspace_id, %template_id, %revision_id))]
  pub async fn apply_manual_update(
    &self,
    workspace_id: WorkspaceId,
    template_id: TemplateCatalogEntryId,
    revision_id: TemplateRevisionId,
  ) -> AuthResult<WorkspaceTemplateInstance> {
    let policy = self
      .store
      .list_policies_for_workspace(workspace_id)
      .await?
      .into_iter()
      .find(|policy| policy.template_id == template_id)
      .ok_or_else(|| AuthError::NotFound("template assignment not found".to_string()))?;
    if !policy.is_enabled {
      return Err(AuthError::InvalidInput(
        "manual update requires an enabled assignment".to_string(),
      ));
    }
    let entry = self
      .store
      .get_catalog_entry(template_id)
      .await?
      .ok_or_else(|| AuthError::NotFound("template not found".to_string()))?;
    entry
      .can_assign()
      .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
    let revision = self
      .store
      .get_revision(revision_id)
      .await?
      .ok_or_else(|| AuthError::NotFound("template revision not found".to_string()))?;
    if revision.template_id != template_id
      || !matches!(revision.state, RevisionState::Published | RevisionState::Deprecated)
    {
      return Err(AuthError::InvalidInput(
        "the selected revision is not usable for this template".to_string(),
      ));
    }
    if !revision_is_guide(&revision) && policy.provisioning_mode != ProvisioningMode::ManualUpdate {
      return Err(AuthError::InvalidInput(
        "manual update requires a manual-update assignment".into(),
      ));
    }

    let mut instance = self
      .reconcile_workspace_templates_inner(workspace_id, Some((template_id, revision.id)))
      .await?
      .into_iter()
      .find(|instance| instance.template_id == template_id)
      .ok_or_else(|| AuthError::NotFound("template instance not found".to_string()))?;
    if instance.revision_id != revision_id || instance.state != InstanceState::Ok {
      if instance.state == InstanceState::Error && instance.revision_id != revision_id {
        instance.state = InstanceState::UpdateAvailable;
        self.store.update_instance(&instance).await?;
      }
      return Err(AuthError::Storage(
        instance
          .last_error_message
          .clone()
          .unwrap_or_else(|| "manual template update could not be applied".to_string()),
      ));
    }
    Ok(instance)
  }

  #[instrument(skip(self, manual_update), fields(%workspace_id))]
  async fn reconcile_workspace_templates_inner(
    &self,
    workspace_id: WorkspaceId,
    manual_update: Option<(TemplateCatalogEntryId, TemplateRevisionId)>,
  ) -> AuthResult<Vec<WorkspaceTemplateInstance>> {
    // Empty suppresses default-policy seeding, not its existing explicit
    // assignments. This path reconciles native policy rows only; it never adds
    // defaults or turns an Empty Workspace into a starter kit.
    let mut metric_guard = TemplateRegistryMetricGuard::new(self.telemetry.clone(), TEMPLATE_RECONCILE_FAILED_EVENT);
    if self.doc_service.is_none() || self.blob_storage.is_none() {
      return Err(AuthError::Storage(
        "template materialization dependencies are unavailable".into(),
      ));
    }
    info!(workspace_id = %workspace_id, "template.reconcile.start");
    let policies = match self.store.list_policies_for_workspace(workspace_id).await {
      Ok(policies) => policies,
      Err(err) => {
        let error_summary =
          template_operation_error_summary_from_auth_error(TemplateRegistryOperation::Reconcile, "load_policies", &err);
        error!(
          workspace_id = %workspace_id,
          error = %err,
          error_code = %error_summary.code,
          "template.reconcile.failed"
        );
        return Err(err);
      }
    };
    let existing_instances = match self.store.list_instances_for_workspace(workspace_id).await {
      Ok(instances) => instances,
      Err(err) => {
        let error_summary = template_operation_error_summary_from_auth_error(
          TemplateRegistryOperation::Reconcile,
          "load_instances",
          &err,
        );
        error!(
          workspace_id = %workspace_id,
          error = %err,
          error_code = %error_summary.code,
          "template.reconcile.failed"
        );
        return Err(err);
      }
    };
    let reconcile_audit = TemplateAuditContext::unknown().with_workspace_id(workspace_id);
    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Reconciled,
        TEMPLATE_RECONCILE_STARTED_EVENT,
        &reconcile_audit,
        "template reconcile started",
        Some(audit_payload(
          "started",
          "template reconcile started",
          Some(serde_json::json!({
            "workspace_id": workspace_id,
            "policy_count": policies.len(),
            "instance_count": existing_instances.len(),
          })),
          None,
        )),
      )
      .await;
    let mut results = Vec::new();
    let mut active_template_ids = std::collections::HashSet::new();

    for policy in &policies {
      active_template_ids.insert(policy.template_id);
      if manual_update
        .as_ref()
        .is_some_and(|(template_id, _)| policy.template_id != *template_id)
      {
        continue;
      }
      if !policy.is_enabled {
        continue;
      }

      let catalog_entry = match self.store.get_catalog_entry(policy.template_id).await {
        Ok(entry) => entry,
        Err(err) => {
          error!(
            workspace_id = %workspace_id,
            template_id = %policy.template_id,
            policy_id = %policy.id,
            error = %err,
            "template.reconcile.failed"
          );
          return Err(err);
        }
      };
      if matches!(
        catalog_entry.as_ref().map(|entry| entry.source),
        Some(TemplateSource::Builtin)
      ) {
        trace!(
          workspace_id = %workspace_id,
          template_id = %policy.template_id,
          policy_id = %policy.id,
          "template.reconcile.skip_builtin_bridge_policy"
        );
        continue;
      }

      // Resolve target revision
      let target_revision = if let Some((_, revision_id)) = manual_update
        .as_ref()
        .filter(|(template_id, _)| *template_id == policy.template_id)
      {
        self.store.get_revision(*revision_id).await?
      } else {
        match policy.selection_mode {
          SelectionMode::Published => match self.store.get_latest_published_revision(policy.template_id).await {
            Ok(revision) => revision,
            Err(err) => {
              let error_summary = template_operation_error_summary_from_auth_error(
                TemplateRegistryOperation::Reconcile,
                "resolve_target_revision",
                &err,
              );
              error!(
                workspace_id = %workspace_id,
                policy_id = %policy.id,
                template_id = %policy.template_id,
                error = %err,
                error_code = %error_summary.code,
                "template.reconcile.failed"
              );
              return Err(err);
            }
          },
          SelectionMode::PinnedRevision => {
            if let Some(rev_id) = policy.selected_revision_id {
              match self.store.get_revision(rev_id).await {
                Ok(revision) => revision,
                Err(err) => {
                  let error_summary = template_operation_error_summary_from_auth_error(
                    TemplateRegistryOperation::Reconcile,
                    "resolve_target_revision",
                    &err,
                  );
                  error!(
                    workspace_id = %workspace_id,
                    policy_id = %policy.id,
                    template_id = %policy.template_id,
                    revision_id = %rev_id,
                    error = %err,
                    error_code = %error_summary.code,
                    "template.reconcile.failed"
                  );
                  return Err(err);
                }
              }
            } else {
              warn!(
                  policy_id = %policy.id,
                  "pinned revision policy has no selected_revision_id"
              );
              None
            }
          }
        }
      };

      let Some(target_revision) = target_revision else {
        warn!(
            policy_id = %policy.id,
            template_id = %policy.template_id,
            "no target revision found for policy"
        );
        continue;
      };
      let target_is_usable = target_revision.template_id == policy.template_id
        && if manual_update.is_some() {
          matches!(
            target_revision.state,
            RevisionState::Published | RevisionState::Deprecated
          )
        } else {
          match policy.selection_mode {
            SelectionMode::Published => target_revision.state == RevisionState::Published,
            SelectionMode::PinnedRevision => {
              matches!(
                target_revision.state,
                RevisionState::Published | RevisionState::Deprecated
              )
            }
          }
        };
      if !target_is_usable {
        return Err(AuthError::InvalidInput(
          "the selected template revision is no longer usable".to_string(),
        ));
      }
      if revision_is_guide(&target_revision) && policy.provisioning_mode != ProvisioningMode::SeedOnce {
        let mut seed_policy = policy.clone();
        seed_policy.provisioning_mode = ProvisioningMode::SeedOnce;
        seed_policy.updated_at = Utc::now();
        self.store.update_policy(&seed_policy).await?;
      }

      // Find existing instance
      let existing = existing_instances.iter().find(|i| i.template_id == policy.template_id);

      match existing {
        None => {
          // Phase 5: Materialize a new template instance
          let mut instance = WorkspaceTemplateInstance {
            id: uuid::Uuid::new_v4(),
            workspace_id,
            template_id: policy.template_id,
            revision_id: target_revision.id,
            workspace_doc_id: None,
            workspace_doc_key: None,
            state: InstanceState::Ok,
            last_applied_hash: None,
            current_hash: None,
            last_synced_at: Some(chrono::Utc::now()),
            detached_at: None,
            retired_at: None,
            last_error_code: None,
            last_error_message: None,
            expected_hash: None,
            locale_hash: None,
          };

          // Attempt materialization if deps are available
          if let (Some(doc_svc), Some(blob_storage)) = (&self.doc_service, &self.blob_storage) {
            match self
              .materialize_instance(
                &mut instance,
                &target_revision,
                catalog_entry.as_ref(),
                workspace_id,
                doc_svc,
                blob_storage.as_ref(),
              )
              .await
            {
              Ok(()) => {
                debug!(
                    instance_id = %instance.id,
                    doc_id = ?instance.workspace_doc_id,
                    "template.instance.materialized"
                );
              }
              Err(e) => {
                error!(
                    instance_id = %instance.id,
                    error = %e,
                    "template.instance.materialization_failed"
                );
                instance.state = InstanceState::Error;
                instance.last_error_code = Some("MATERIALIZATION_FAILED".to_string());
                instance.last_error_message = Some(e.to_string());
              }
            }
          } else {
            trace!(
                instance_id = %instance.id,
                "materialization deps absent — creating placeholder instance"
            );
          }

          if let Err(err) = self.store.create_instance(&instance).await {
            if is_workspace_instance_unique_violation(&err) {
              self
                .cleanup_materialized_doc_after_instance_create_failure(
                  workspace_id,
                  &instance,
                  "concurrent instance create",
                )
                .await?;
              debug!(
                workspace_id = %workspace_id,
                template_id = %policy.template_id,
                "concurrent reconcile create detected; reloading instance"
              );
              let existing_instances = match self.store.list_instances_for_workspace(workspace_id).await {
                Ok(instances) => instances,
                Err(err) => {
                  error!(
                    workspace_id = %workspace_id,
                    template_id = %policy.template_id,
                    policy_id = %policy.id,
                    error = %err,
                    "template.reconcile.failed"
                  );
                  return Err(err);
                }
              };
              if let Some(existing_instance) = existing_instances
                .into_iter()
                .find(|candidate| candidate.template_id == policy.template_id)
              {
                results.push(existing_instance);
                continue;
              }
            }
            if let Err(cleanup_err) = self
              .cleanup_materialized_doc_after_instance_create_failure(workspace_id, &instance, "instance create failed")
              .await
            {
              error!(
                workspace_id = %workspace_id,
                template_id = %policy.template_id,
                policy_id = %policy.id,
                original_error = %err,
                cleanup_error = %cleanup_err,
                "template.reconcile.cleanup_failed"
              );
            }
            let audit = TemplateAuditContext::from_revision(&target_revision)
              .with_workspace_id(workspace_id)
              .with_template_id(policy.template_id)
              .with_policy_id(policy.id)
              .with_error_code(audit_error_code(&err));
            error!(
              workspace_id = %workspace_id,
              template_id = %policy.template_id,
              policy_id = %policy.id,
              error = %err,
              "template.reconcile.failed"
            );
            self
              .record_audit_event(
                Level::WARN,
                TemplateRegistryAuditAction::Failed,
                TEMPLATE_RECONCILE_FAILED_EVENT,
                &audit,
                "template reconcile failed while creating instance",
                Some(audit_payload(
                  "failed",
                  "template reconcile failed while creating instance",
                  Some(serde_json::json!({
                    "workspace_id": workspace_id,
                    "template_id": policy.template_id,
                    "policy_id": policy.id,
                  })),
                  Some(&err),
                )),
              )
              .await;
            return Err(err);
          }
          debug!(
              instance_id = %instance.id,
              template_id = %policy.template_id,
              state = %instance.state,
              "new template instance created"
          );
          results.push(instance);
        }
        Some(inst) => {
          let mut updated = inst.clone();
          let is_guide = revision_is_guide(&target_revision)
            || self
              .store
              .get_revision(inst.revision_id)
              .await?
              .as_ref()
              .is_some_and(revision_is_guide);
          if is_guide && manual_update.is_some() {
            if !revision_is_guide(&target_revision) {
              return Err(AuthError::InvalidInput(
                "a guide reinstall requires a guide revision".into(),
              ));
            }
            // Explicit installation creates a fresh ordinary copy. The old
            // reader-owned document remains intact, even when edited/deleted.
            updated.workspace_doc_id = None;
            updated.workspace_doc_key = None;
            updated.locale_hash = None;
            let doc_service = self.doc_service.as_ref().expect("checked before reconciliation");
            let storage = self.blob_storage.as_ref().expect("checked before reconciliation");
            self
              .materialize_instance(
                &mut updated,
                &target_revision,
                catalog_entry.as_ref(),
                workspace_id,
                doc_service,
                storage.as_ref(),
              )
              .await?;
            updated.revision_id = target_revision.id;
            updated.state = InstanceState::Ok;
            updated.retired_at = None;
            updated.detached_at = None;
            updated.last_error_code = None;
            updated.last_error_message = None;
            updated.last_synced_at = Some(Utc::now());
            if let Err(error) = self.store.update_instance(&updated).await {
              self
                .cleanup_materialized_doc_after_instance_create_failure(
                  workspace_id,
                  &updated,
                  "guide reinstall attachment failed",
                )
                .await?;
              return Err(error);
            }
            results.push(updated);
            continue;
          }
          if inst.state == InstanceState::Detached || inst.state == InstanceState::Retired {
            // Don't touch detached or retired instances
            results.push(updated);
            continue;
          }
          // A binding row is not readiness. Older jobs may have omitted the
          // document and historical clients could trash a source before the
          // server-side protection existed. Reuse the binding and materialize
          // one replacement only when the authoritative document row is absent.
          let source_available = match inst.workspace_doc_id {
            Some(doc_id) => self
              .doc_service
              .as_ref()
              .expect("checked before reconciliation")
              .store()
              .get_doc_metadata(doc_id)
              .await?
              .is_some_and(|doc| doc.workspace_id == Some(workspace_id)),
            None => false,
          };
          if is_guide && (source_available || inst.workspace_doc_key.is_some() || inst.last_applied_hash.is_some()) {
            // A delivered guide is reader-owned: automatic reconcile neither
            // refreshes edits nor resurrects a deliberately removed copy.
            if !source_available {
              updated.retire();
              updated.workspace_doc_id = None;
              self.store.update_instance(&updated).await?;
            }
            results.push(updated);
            continue;
          }
          if !source_available {
            let doc_service = self.doc_service.as_ref().expect("checked before reconciliation");
            let storage = self.blob_storage.as_ref().expect("checked before reconciliation");
            match self
              .materialize_instance(
                &mut updated,
                &target_revision,
                catalog_entry.as_ref(),
                workspace_id,
                doc_service,
                storage.as_ref(),
              )
              .await
            {
              Ok(()) => {
                updated.revision_id = target_revision.id;
                updated.state = InstanceState::Ok;
                updated.last_error_code = None;
                updated.last_error_message = None;
              }
              Err(error) => {
                updated.state = InstanceState::Error;
                updated.last_error_code = Some("MATERIALIZATION_FAILED".into());
                updated.last_error_message = Some(error.to_string());
              }
            }
            if let Err(error) = self.store.update_instance(&updated).await {
              self
                .cleanup_materialized_doc_after_instance_create_failure(
                  workspace_id,
                  &updated,
                  "placeholder attachment failed",
                )
                .await?;
              return Err(error);
            }
            results.push(updated);
            continue;
          }
          if inst.revision_id != target_revision.id {
            if policy.provisioning_mode == ProvisioningMode::SeedOnce {
              results.push(updated);
              continue;
            }
            if policy.provisioning_mode == ProvisioningMode::ManualUpdate && manual_update.is_none() {
              updated.state = InstanceState::UpdateAvailable;
              self.store.update_instance(&updated).await?;
              results.push(updated);
              continue;
            }
            // A recorded hash is not sufficient to prove that the live source
            // is unchanged. Preserve the source whenever the live check is
            // unavailable and require an explicit follow-up.
            let has_live_drift = match self
              .check_live_drift(inst, self.doc_service.as_ref().expect("checked before reconciliation"))
              .await
            {
              Ok(has_drift) => has_drift,
              Err(check_error) => {
                warn!(
                  workspace_id = %workspace_id,
                  template_id = %policy.template_id,
                  instance_id = %inst.id,
                  error = %check_error,
                  "template update preserved because live drift check was unavailable"
                );
                if updated.state == InstanceState::Ok {
                  let _ = updated.mark_update_available();
                }
                updated.last_error_code = Some("UPDATE_FAILED".to_string());
                updated.last_error_message = Some(check_error.to_string());
                self.store.update_instance(&updated).await?;
                results.push(updated);
                continue;
              }
            };
            if has_live_drift {
              let _ = updated.detach();
              if let Err(err) = self.store.update_instance(&updated).await {
                error!(
                  workspace_id = %workspace_id,
                  template_id = %policy.template_id,
                  policy_id = %policy.id,
                  instance_id = %updated.id,
                  error = %err,
                  "template.reconcile.failed"
                );
                let audit = TemplateAuditContext::from_revision(&target_revision)
                  .with_workspace_id(workspace_id)
                  .with_template_id(policy.template_id)
                  .with_policy_id(policy.id)
                  .with_instance_id(updated.id)
                  .with_error_code(audit_error_code(&err));
                self
                  .record_audit_event(
                    Level::WARN,
                    TemplateRegistryAuditAction::Failed,
                    TEMPLATE_RECONCILE_FAILED_EVENT,
                    &audit,
                    "template reconcile failed while detaching instance",
                    Some(audit_payload(
                      "failed",
                      "template reconcile failed while detaching instance",
                      Some(serde_json::json!({
                        "workspace_id": workspace_id,
                        "template_id": policy.template_id,
                        "policy_id": policy.id,
                        "instance_id": inst.id,
                        "revision_id": target_revision.id,
                      })),
                      Some(&err),
                    )),
                  )
                  .await;
                return Err(err);
              }
              let audit = TemplateAuditContext::from_revision(&target_revision)
                .with_workspace_id(workspace_id)
                .with_template_id(policy.template_id)
                .with_policy_id(policy.id)
                .with_instance_id(updated.id);
              self
                .record_audit_event(
                  Level::INFO,
                  TemplateRegistryAuditAction::Detached,
                  TEMPLATE_INSTANCE_DETACHED_EVENT,
                  &audit,
                  "template instance detached due to local changes",
                  Some(audit_payload(
                    "detached",
                    "template instance detached due to local changes",
                    Some(serde_json::json!({
                      "workspace_id": workspace_id,
                      "template_id": policy.template_id,
                      "policy_id": policy.id,
                      "instance_id": inst.id,
                      "revision_id": target_revision.id,
                    })),
                    None,
                  )),
                )
                .await;
            } else {
              if updated.state == InstanceState::Ok {
                let _ = updated.mark_update_available();
              }
              // Phase 5: Update doc content if materialization deps available
              if let (Some(doc_svc), Some(blob_storage)) = (&self.doc_service, &self.blob_storage) {
                match self
                  .update_instance_content(
                    &mut updated,
                    &target_revision,
                    workspace_id,
                    doc_svc,
                    blob_storage.as_ref(),
                  )
                  .await
                {
                  Ok(true) => {
                    debug!(
                        instance_id = %inst.id,
                        new_revision = %target_revision.id,
                        "template.instance.updated"
                    );
                  }
                  Ok(false) => {
                    let _ = updated.detach();
                    debug!(
                      instance_id = %inst.id,
                      revision_id = %inst.revision_id,
                      "template update preserved a concurrently edited source"
                    );
                  }
                  Err(e) => {
                    error!(
                        instance_id = %inst.id,
                        error = %e,
                        "template.instance.update_failed"
                    );
                    updated.state = InstanceState::Error;
                    updated.last_error_code = Some("UPDATE_FAILED".to_string());
                    updated.last_error_message = Some(e.to_string());
                  }
                }
              } else {
                if updated.state == InstanceState::Ok {
                  let _ = updated.mark_update_available();
                }
                updated.last_error_code = Some("UPDATE_FAILED".to_string());
                updated.last_error_message = Some("live document update dependencies are unavailable".to_string());
              }
              if let Err(err) = self.store.update_instance(&updated).await {
                error!(
                  workspace_id = %workspace_id,
                  template_id = %policy.template_id,
                  policy_id = %policy.id,
                  instance_id = %updated.id,
                  error = %err,
                  "template.reconcile.failed"
                );
                let audit = TemplateAuditContext::from_revision(&target_revision)
                  .with_workspace_id(workspace_id)
                  .with_template_id(policy.template_id)
                  .with_policy_id(policy.id)
                  .with_instance_id(updated.id)
                  .with_error_code(audit_error_code(&err));
                self
                  .record_audit_event(
                    Level::WARN,
                    TemplateRegistryAuditAction::Failed,
                    TEMPLATE_RECONCILE_FAILED_EVENT,
                    &audit,
                    "template reconcile failed while updating instance",
                    Some(audit_payload(
                      "failed",
                      "template reconcile failed while updating instance",
                      Some(serde_json::json!({
                        "workspace_id": workspace_id,
                        "template_id": policy.template_id,
                        "policy_id": policy.id,
                        "instance_id": updated.id,
                        "revision_id": target_revision.id,
                      })),
                      Some(&err),
                    )),
                  )
                  .await;
                return Err(err);
              }
            }
          }
          results.push(updated);
        }
      }
    }

    // Retire orphaned instances whose policies no longer exist.
    for inst in &existing_instances {
      if active_template_ids.contains(&inst.template_id) || inst.state == InstanceState::Retired {
        continue;
      }

      let mut retired = inst.clone();
      retired.retire();
      if self
        .store
        .get_revision(inst.revision_id)
        .await?
        .as_ref()
        .is_some_and(revision_is_guide)
      {
        retired.workspace_doc_id = None;
      }
      if let Err(err) = self.store.update_instance(&retired).await {
        error!(
          workspace_id = %workspace_id,
          template_id = %inst.template_id,
          instance_id = %retired.id,
          error = %err,
          "template.reconcile.failed"
        );
        let maybe_revision = match self.store.get_revision(inst.revision_id).await {
          Ok(revision) => revision,
          Err(load_err) => {
            warn!(
              workspace_id = %workspace_id,
              template_id = %inst.template_id,
              instance_id = %inst.id,
              error = %load_err,
              "template reconcile could not load revision for orphaned retire failure audit"
            );
            None
          }
        };
        let audit = maybe_revision
          .as_ref()
          .map(TemplateAuditContext::from_revision)
          .unwrap_or_else(TemplateAuditContext::unknown)
          .with_workspace_id(workspace_id)
          .with_template_id(inst.template_id)
          .with_instance_id(inst.id)
          .with_error_code(audit_error_code(&err));
        self
          .record_audit_event(
            Level::WARN,
            TemplateRegistryAuditAction::Failed,
            TEMPLATE_RECONCILE_FAILED_EVENT,
            &audit,
            "template reconcile failed while retiring orphaned instance",
            Some(audit_payload(
              "failed",
              "template reconcile failed while retiring orphaned instance",
              Some(serde_json::json!({
                "workspace_id": workspace_id,
                "template_id": inst.template_id,
                "instance_id": inst.id,
              })),
              Some(&err),
            )),
          )
          .await;
        return Err(err);
      }

      let maybe_revision = match self.store.get_revision(inst.revision_id).await {
        Ok(revision) => revision,
        Err(load_err) => {
          warn!(
            workspace_id = %workspace_id,
            template_id = %inst.template_id,
            instance_id = %inst.id,
            error = %load_err,
            "template reconcile could not load revision for orphaned retire audit"
          );
          None
        }
      };
      let audit = maybe_revision
        .as_ref()
        .map(TemplateAuditContext::from_revision)
        .unwrap_or_else(TemplateAuditContext::unknown)
        .with_workspace_id(workspace_id)
        .with_template_id(inst.template_id)
        .with_instance_id(inst.id);
      self
        .record_audit_event(
          Level::INFO,
          TemplateRegistryAuditAction::Updated,
          TEMPLATE_INSTANCE_RETIRED_EVENT,
          &audit,
          "template instance retired after assignment removal",
          Some(audit_payload(
            "retired",
            "template instance retired after assignment removal",
            Some(serde_json::json!({
              "workspace_id": workspace_id,
              "template_id": inst.template_id,
              "instance_id": inst.id,
            })),
            None,
          )),
        )
        .await;
      results.push(retired);
    }

    let complete_audit = TemplateAuditContext::unknown().with_workspace_id(workspace_id);
    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Reconciled,
        TEMPLATE_RECONCILE_COMPLETED_EVENT,
        &complete_audit,
        "template reconcile completed",
        Some(audit_payload(
          "completed",
          "template reconcile completed",
          Some(serde_json::json!({
            "workspace_id": workspace_id,
            "instance_count": results.len(),
          })),
          None,
        )),
      )
      .await;
    metric_guard.mark_success(TEMPLATE_RECONCILE_COMPLETED_EVENT);
    info!(
      workspace_id = %workspace_id,
      instance_count = results.len(),
      "template.reconcile.success"
    );
    Ok(results)
  }

  /// Remove a document that was created while materializing a template instance
  /// but could not be attached to the registry. Reconcile creates documents
  /// before it can persist the instance row; this rollback keeps failed or
  /// concurrent runs from leaking visible empty template documents.
  async fn cleanup_materialized_doc_after_instance_create_failure(
    &self,
    workspace_id: WorkspaceId,
    instance: &WorkspaceTemplateInstance,
    reason: &'static str,
  ) -> AuthResult<()> {
    let Some(doc_id) = instance.workspace_doc_id else {
      return Ok(());
    };
    let Some(doc_service) = &self.doc_service else {
      warn!(
        workspace_id = %workspace_id,
        instance_id = %instance.id,
        doc_id = %doc_id,
        reason,
        "template.reconcile.cleanup_skipped_no_doc_service"
      );
      return Ok(());
    };

    doc_service.delete_doc(workspace_id, doc_id).await?;
    warn!(
      workspace_id = %workspace_id,
      instance_id = %instance.id,
      doc_id = %doc_id,
      reason,
      "template.reconcile.cleaned_materialized_doc"
    );
    Ok(())
  }

  /// Materialize a new template instance by reading bundle content from blob
  /// storage and creating a workspace document.
  ///
  /// On success, populates `instance.workspace_doc_id`, `last_applied_hash`,
  /// and `current_hash`.
  async fn materialize_instance(
    &self,
    instance: &mut WorkspaceTemplateInstance,
    revision: &TemplateRevision,
    catalog_entry: Option<&TemplateCatalogEntry>,
    workspace_id: WorkspaceId,
    doc_service: &DocService,
    blob_storage: &dyn BlobStoragePort,
  ) -> AuthResult<()> {
    let content = self
      .load_revision_content_bytes(revision, blob_storage, instance)
      .await?;
    let source_locale = instance
      .locale_hash
      .clone()
      .ok_or_else(|| AuthError::Storage("template source language was not resolved".into()))?;
    let source_title = yjs::extract_structural_document_title(&content).map_err(AuthError::InvalidInput)?;
    let title = source_title
      .filter(|title| !title.trim().is_empty())
      .or_else(|| catalog_entry.map(|entry| entry.title.clone()));
    let created_by = self.store.resolve_workspace_materialization_actor(workspace_id).await?;
    // Commit the complete leaf and root discovery together through the normal
    // page lifecycle. A ZIP is never a Yjs update and an empty starter page must
    // not be merged with the template's independently authored page root.
    let (doc, sync) = doc_service
      .create_page_from_snapshot_with_sync_updates(workspace_id, created_by, title, content)
      .await?;
    let content_hash = compute_content_hash(&sync.document);

    if let Err(error) = self
      .store
      .attribute_materialized_document(
        doc.id,
        created_by,
        &source_locale,
        if revision_is_guide(revision) {
          bundle::TemplatePurpose::Guide
        } else {
          bundle::TemplatePurpose::Template
        },
      )
      .await
    {
      if let Err(cleanup_error) = doc_service.delete_doc(workspace_id, doc.id).await {
        error!(
          instance_id = %instance.id,
          doc_id = %doc.id,
          error = %cleanup_error,
          "template materialization attribution cleanup failed"
        );
      }
      return Err(error);
    }

    // Update instance with materialization results
    instance.workspace_doc_id = Some(doc.id);
    instance.workspace_doc_key = Some(doc.external_id);
    instance.last_applied_hash = Some(content_hash.clone());
    instance.current_hash = Some(content_hash);

    // Server-created reader guides do not emit a browser write, so the normal
    // WebSocket indexing trigger never runs. Index their committed native leaf
    // through the existing worker queue without editing reader-owned content.
    if revision_is_guide(revision)
      && let Some(queue) = self.reconcile_queue.get()
      && let Err(error) = queue
        .add_job(
          "indexer",
          "indexer.indexDoc",
          json!({ "workspaceId": workspace_id, "docId": doc.id, "kind": "deferred" }),
          Some(3),
          None,
        )
        .await
    {
      warn!(%workspace_id, doc_id = %doc.id, error = %error, "guide search indexing enqueue failed");
    }

    info!(
        instance_id = %instance.id,
        doc_id = %doc.id,
        created_by = %created_by,
        "template instance materialized with doc"
    );

    Ok(())
  }

  /// Update an existing instance's document content to a new revision.
  ///
  /// Reads the new revision's bundle content and publishes the replacement
  /// only if the live document still has the revision and semantic content
  /// observed here. The checked append owns the final conflict boundary.
  async fn update_instance_content(
    &self,
    instance: &mut WorkspaceTemplateInstance,
    new_revision: &TemplateRevision,
    workspace_id: WorkspaceId,
    doc_service: &DocService,
    blob_storage: &dyn BlobStoragePort,
  ) -> AuthResult<bool> {
    let content = self
      .load_revision_content_bytes(new_revision, blob_storage, instance)
      .await?;
    let doc_id = instance
      .workspace_doc_id
      .ok_or_else(|| AuthError::InvalidInput("template instance has no document to update".to_string()))?;
    let current = doc_service.load_full_doc(workspace_id, doc_id).await?;
    let expected_hash = instance
      .last_applied_hash
      .as_ref()
      .ok_or_else(|| AuthError::InvalidInput("template instance has no applied content hash".to_string()))?;
    if compute_content_hash(&current) != *expected_hash {
      return Ok(false);
    }
    let expected_revision = canonical_yjs_revision(&current)
      .map_err(|error| AuthError::Storage(format!("template source revision is invalid: {error}")))?;
    let update = yjs::restore_document_snapshot(&current, &content)
      .map_err(|error| AuthError::InvalidInput(format!("template revision cannot replace live document: {error}")))?;
    let applied = yjs::merge_updates(vec![current, update.clone()])
      .map_err(|error| AuthError::Storage(format!("template replacement state is invalid: {error}")))?;
    let new_hash = compute_content_hash(&applied);
    match doc_service
      .push_revision_checked_update(workspace_id, doc_id, &expected_revision, update)
      .await?
    {
      DocRevisionCheckedUpdateOutcome::Appended { .. } => {}
      DocRevisionCheckedUpdateOutcome::Stale { .. } => return Ok(false),
    }

    debug!(
        instance_id = %instance.id,
        doc_id = %doc_id,
        old_hash = ?instance.last_applied_hash,
        new_hash = %new_hash,
        "template doc content updated"
    );

    // Update instance metadata regardless (revision pointer changes)
    instance.revision_id = new_revision.id;
    instance.last_applied_hash = Some(new_hash.clone());
    instance.current_hash = Some(new_hash);
    instance.state = InstanceState::Ok;
    instance.last_synced_at = Some(chrono::Utc::now());
    instance.last_error_code = None;
    instance.last_error_message = None;

    Ok(true)
  }

  /// Scan for drift in template instances for a workspace (Phase 6).
  ///
  /// For each instance in `Ok` state that has a `workspace_doc_id`:
  /// 1. Loads the current doc content via `DocService`
  /// 2. Computes SHA-256 hash of the Yjs snapshot bytes
  /// 3. Compares with `last_applied_hash`
  /// 4. If different, transitions the instance to `Detached` and records `detached_at`
  ///
  /// When `doc_service` is unavailable, the scan preserves the source because
  /// pre-recorded hashes are insufficient evidence for a lifecycle transition.
  #[instrument(skip(self))]
  pub async fn scan_drift(&self, workspace_id: WorkspaceId) -> AuthResult<Vec<WorkspaceTemplateInstance>> {
    info!(workspace_id = %workspace_id, "template.drift.scan.start");
    let audit = TemplateAuditContext::unknown().with_workspace_id(workspace_id);
    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Scanned,
        TEMPLATE_DRIFT_SCAN_STARTED_EVENT,
        &audit,
        "template drift scan started",
        Some(audit_payload(
          "started",
          "template drift scan started",
          Some(serde_json::json!({ "workspace_id": workspace_id })),
          None,
        )),
      )
      .await;

    let instances = match self.store.list_instances_for_workspace(workspace_id).await {
      Ok(instances) => instances,
      Err(err) => {
        error!(workspace_id = %workspace_id, error = %err, "template.drift.scan.failed");
        return Err(err);
      }
    };
    let mut drifted = Vec::new();

    for inst in &instances {
      if inst.state != InstanceState::Ok {
        continue;
      }
      if self
        .store
        .get_revision(inst.revision_id)
        .await?
        .as_ref()
        .is_some_and(revision_is_guide)
      {
        continue;
      }

      let has_drift = if let Some(doc_svc) = &self.doc_service {
        // Phase 6: Compute live content hash from doc store
        match self.check_live_drift(inst, doc_svc).await {
          Ok(has_drift) => has_drift,
          Err(error) => {
            warn!(
              workspace_id = %workspace_id,
              instance_id = %inst.id,
              error = %error,
              "template drift scan preserved source because live state was unavailable"
            );
            false
          }
        }
      } else {
        warn!(
          workspace_id = %workspace_id,
          instance_id = %inst.id,
          "template drift scan preserved source because live document access was unavailable"
        );
        false
      };

      if has_drift {
        let mut updated = inst.clone();
        let _ = updated.detach();
        if let Err(err) = self.store.update_instance(&updated).await {
          error!(
            workspace_id = %workspace_id,
            template_id = %inst.template_id,
            instance_id = %inst.id,
            error = %err,
            "template.drift.scan.failed"
          );
          let maybe_revision = match self.store.get_revision(inst.revision_id).await {
            Ok(revision) => revision,
            Err(load_err) => {
              warn!(
                workspace_id = %workspace_id,
                template_id = %inst.template_id,
                instance_id = %inst.id,
                error = %load_err,
                "template drift audit could not load revision for failure event"
              );
              None
            }
          };
          let audit = maybe_revision
            .as_ref()
            .map(TemplateAuditContext::from_revision)
            .unwrap_or_else(TemplateAuditContext::unknown)
            .with_workspace_id(workspace_id)
            .with_template_id(inst.template_id)
            .with_instance_id(inst.id)
            .with_error_code(audit_error_code(&err));
          self
            .record_audit_event(
              Level::WARN,
              TemplateRegistryAuditAction::Failed,
              TEMPLATE_DRIFT_SCAN_FAILED_EVENT,
              &audit,
              "template drift scan failed while updating detached instance",
              Some(audit_payload(
                "failed",
                "template drift scan failed while updating detached instance",
                Some(serde_json::json!({
                  "workspace_id": workspace_id,
                  "template_id": inst.template_id,
                  "instance_id": inst.id,
                })),
                Some(&err),
              )),
            )
            .await;
          return Err(err);
        }
        let maybe_revision = match self.store.get_revision(inst.revision_id).await {
          Ok(revision) => revision,
          Err(load_err) => {
            warn!(
              workspace_id = %workspace_id,
              template_id = %inst.template_id,
              instance_id = %inst.id,
              error = %load_err,
              "template drift audit could not load revision for detach event"
            );
            None
          }
        };
        let audit = maybe_revision
          .as_ref()
          .map(TemplateAuditContext::from_revision)
          .unwrap_or_else(TemplateAuditContext::unknown)
          .with_workspace_id(workspace_id)
          .with_template_id(inst.template_id)
          .with_instance_id(inst.id);
        self
          .record_audit_event(
            Level::INFO,
            TemplateRegistryAuditAction::Detached,
            TEMPLATE_INSTANCE_DETACHED_EVENT,
            &audit,
            "template instance detached due to drift",
            Some(audit_payload(
              "detached",
              "template instance detached due to drift",
              Some(serde_json::json!({
                "workspace_id": workspace_id,
                "template_id": inst.template_id,
                "instance_id": inst.id,
              })),
              None,
            )),
          )
          .await;
        drifted.push(updated);
      }
    }

    info!(
      workspace_id = %workspace_id,
      drifted_count = drifted.len(),
      "template.drift.scan.success"
    );
    Ok(drifted)
  }

  /// Read-only validation for a pinned manual Library association. Persisted
  /// instance state alone cannot attest content that was edited since reconcile.
  pub(super) async fn pinned_library_content_unchanged(
    &self,
    instance: &WorkspaceTemplateInstance,
  ) -> AuthResult<bool> {
    let Some(doc_id) = instance.workspace_doc_id else {
      return Ok(false);
    };
    let Some(applied_hash) = instance.last_applied_hash.as_ref() else {
      return Ok(false);
    };
    let documents = self
      .doc_service
      .as_ref()
      .ok_or_else(|| AuthError::Storage("template document service unavailable".into()))?;
    let before = documents
      .store()
      .preview_source_identity(instance.workspace_id, doc_id)
      .await?;
    if before.as_ref().is_none_or(|identity| identity.deleted) {
      return Ok(false);
    }
    let content = match documents.load_full_doc_consistent(instance.workspace_id, doc_id).await {
      Ok(content) => content,
      Err(AuthError::NotFound(_)) => return Ok(false),
      Err(error) => return Err(error),
    };
    let after = documents
      .store()
      .preview_source_identity(instance.workspace_id, doc_id)
      .await?;
    Ok(before == after && compute_content_hash(&content) == *applied_hash)
  }

  /// Check whether a template instance has drifted by loading the current
  /// doc content and comparing its SHA-256 hash with `last_applied_hash`.
  ///
  async fn check_live_drift(&self, instance: &WorkspaceTemplateInstance, doc_service: &DocService) -> AuthResult<bool> {
    let doc_id = instance
      .workspace_doc_id
      .ok_or_else(|| AuthError::InvalidInput("template instance has no document identity".to_string()))?;
    let applied_hash = instance
      .last_applied_hash
      .as_ref()
      .ok_or_else(|| AuthError::InvalidInput("template instance has no applied content hash".to_string()))?;

    // Load the current doc snapshot (P102-UNIFY-03: pass workspace_id for scoped DB access)
    match doc_service.load_full_doc(instance.workspace_id, doc_id).await {
      Ok(doc_bytes) => {
        let current_hash = compute_content_hash(&doc_bytes);
        let drifted = &current_hash != applied_hash;
        if drifted {
          debug!(
              instance_id = %instance.id,
              doc_id = %doc_id,
              applied_hash = %applied_hash,
              current_hash = %current_hash,
              "drift detected — content hash mismatch"
          );
        } else {
          trace!(
              instance_id = %instance.id,
              doc_id = %doc_id,
              "no drift — hashes match"
          );
        }
        Ok(drifted)
      }
      Err(error) => Err(AuthError::Storage(format!(
        "failed to load template source for drift check: {error}"
      ))),
    }
  }

  /// Inspect an admitted native component without reading its body or assigning
  /// a Workspace source. The caller resolves it from the server-owned delivery,
  /// which may retain a component without any standalone Library export.
  pub(crate) async fn delivered_document_source_metadata(
    &self,
    slug: &str,
    version: &str,
    locale: &str,
    client_version: u32,
  ) -> AuthResult<PublishedRegistryDocumentMetadata> {
    let entry = self
      .store
      .get_catalog_entry_by_slug(slug)
      .await?
      .ok_or_else(|| AuthError::NotFound("document template source".into()))?;
    if entry.status != TemplateStatus::Active
      || entry.source != TemplateSource::Bundle
      || client_version == 0
      || client_version < entry.min_client_version
    {
      return Err(AuthError::InvalidInput(
        "document template source is unavailable".into(),
      ));
    }
    let revision = self
      .store
      .list_revisions(entry.id, 0, 1_000)
      .await?
      .into_iter()
      .find(|revision| revision.version == version)
      .ok_or_else(|| AuthError::NotFound("document template revision".into()))?;
    if !matches!(revision.state, RevisionState::Published | RevisionState::Deprecated)
      || revision.bundle_blob_id.is_none()
      || revision.checksum.is_none()
      || revision_is_guide(&revision)
    {
      return Err(AuthError::InvalidInput(
        "document template component is not an eligible delivered page".into(),
      ));
    }
    let manifest: bundle::Manifest = serde_json::from_value(
      revision
        .manifest
        .clone()
        .ok_or_else(|| AuthError::InvalidInput("document source manifest unavailable".into()))?,
    )
    .map_err(|_| AuthError::InvalidInput("invalid document source manifest".into()))?;
    if manifest.template_id != slug || manifest.version != version {
      return Err(AuthError::InvalidInput("document source identity mismatch".into()));
    }
    let selected = manifest.select_locale(locale);
    let title = manifest
      .localized_contents
      .get(&selected)
      .map(|content| content.title.clone())
      .unwrap_or(manifest.title);
    Ok(PublishedRegistryDocumentMetadata {
      revision_id: revision.id,
      revision_digest: template_revision_source_digest(&revision),
      locale: selected,
      title,
    })
  }

  /// Capture an exact admitted component, including retained history without a
  /// standalone export. The caller owns delivery, actor and destination admission.
  pub(crate) async fn capture_delivered_document_revision(
    &self,
    slug: &str,
    version: &str,
    delivered: &[u8],
    locale: &str,
    client_version: u32,
  ) -> AuthResult<CapturedRegistryDocumentRevision> {
    let entry = self
      .store
      .get_catalog_entry_by_slug(slug)
      .await?
      .ok_or_else(|| AuthError::NotFound("document template source".into()))?;
    if entry.status != TemplateStatus::Active
      || entry.source != TemplateSource::Bundle
      || client_version < entry.min_client_version
    {
      return Err(AuthError::InvalidInput(
        "document template source is unavailable".into(),
      ));
    }
    let revision = self
      .store
      .list_revisions(entry.id, 0, 1_000)
      .await?
      .into_iter()
      .find(|revision| revision.version == version)
      .ok_or_else(|| AuthError::NotFound("document template revision".into()))?;
    if !matches!(revision.state, RevisionState::Published | RevisionState::Deprecated) || revision_is_guide(&revision) {
      return Err(AuthError::InvalidInput(
        "document template component is not an eligible delivered page".into(),
      ));
    }
    self
      .validate_delivered_document_revision(&revision, slug, version, delivered)
      .await?;
    self.capture_revision_content(&revision, locale, None).await
  }

  async fn validate_delivered_document_revision(
    &self,
    revision: &TemplateRevision,
    slug: &str,
    version: &str,
    delivered: &[u8],
  ) -> AuthResult<()> {
    let parsed = bundle::parse_bundle_with_limits(delivered, self.bundle_zip_limits())?;
    if parsed.manifest.template_id != slug || parsed.manifest.version != version {
      return Err(AuthError::InvalidInput("document delivery identity mismatch".into()));
    }
    let canonical = bundle::create_export_bundle(
      &parsed.manifest,
      &parsed.content_bytes,
      parsed.preview_bytes.as_deref(),
      &parsed.localized_contents,
    )?;
    self
      .ensure_revision_content(revision, &parsed, &compute_content_hash(&canonical))
      .await?;
    Ok(())
  }

  /// Only a server-loaded accepted receipt may resume this exact revision.
  /// Retirement of a release version is not a switch to the new current source.
  pub(crate) async fn capture_accepted_document_revision(
    &self,
    source: &myoxus_domain::assistant_package::AssistantDocumentComponentSource,
    revision_id: Uuid,
    revision_digest: &str,
    content_digest: &str,
    locale: &str,
    client_version: u32,
  ) -> AuthResult<CapturedRegistryDocumentRevision> {
    let revision = self
      .accepted_document_revision(source, revision_id, revision_digest, client_version)
      .await?;
    let captured = self
      .capture_revision_content(&revision, locale, Some(content_digest))
      .await?;
    if captured.locale != locale {
      return Err(AuthError::InvalidInput("accepted source locale changed".into()));
    }
    Ok(captured)
  }

  async fn accepted_document_revision(
    &self,
    source: &myoxus_domain::assistant_package::AssistantDocumentComponentSource,
    revision_id: Uuid,
    revision_digest: &str,
    client_version: u32,
  ) -> AuthResult<TemplateRevision> {
    let revision = self
      .store
      .get_revision(revision_id)
      .await?
      .ok_or_else(|| AuthError::NotFound("accepted document source".into()))?;
    let entry = self
      .store
      .get_catalog_entry(revision.template_id)
      .await?
      .ok_or_else(|| AuthError::NotFound("accepted document template".into()))?;
    validate_accepted_document_source(&entry, &revision, source, revision_digest, client_version)?;
    Ok(revision)
  }

  pub(crate) async fn capture_workspace_document_revision(
    &self,
    document: &myoxus_domain::assistant_package::AssistantPreparedDocumentMetadata,
    delivered: &[u8],
    client_version: u32,
  ) -> AuthResult<CapturedRegistryDocumentRevision> {
    let revision = self
      .accepted_document_revision(
        &document.source,
        document.source_revision_id,
        &document.source_revision_digest,
        client_version,
      )
      .await?;
    self
      .validate_delivered_document_revision(
        &revision,
        &document.source.template_id,
        &document.source.version,
        delivered,
      )
      .await?;
    let captured = self.capture_revision_content(&revision, &document.locale, None).await?;
    if captured.locale != document.locale {
      return Err(AuthError::InvalidInput("accepted source locale changed".into()));
    }
    Ok(captured)
  }

  async fn capture_revision_content(
    &self,
    revision: &TemplateRevision,
    locale: &str,
    expected_content_digest: Option<&str>,
  ) -> AuthResult<CapturedRegistryDocumentRevision> {
    let storage = self
      .blob_storage
      .as_deref()
      .ok_or_else(|| AuthError::Storage("document template storage unavailable".into()))?;
    let bytes = self.load_revision_bundle_bytes(revision, storage).await?;
    let parsed = bundle::parse_bundle_with_limits(&bytes, self.bundle_zip_limits())?;
    ensure_same_revision_content(revision, &parsed, &compute_content_hash(&bytes))?;
    let selected = parsed.select_locale(locale);
    let snapshot = content::document_update(parsed.content_for_locale(&selected), self.zip_limits)?;
    let content_digest = compute_content_hash(&snapshot);
    if expected_content_digest.is_some_and(|expected| expected != content_digest) {
      return Err(AuthError::InvalidInput(
        "accepted document source content changed".into(),
      ));
    }
    Ok(CapturedRegistryDocumentRevision {
      revision_id: revision.id,
      revision_digest: template_revision_source_digest(revision),
      content_digest,
      locale: selected,
      snapshot,
    })
  }

  async fn ensure_revision_content(
    &self,
    revision: &TemplateRevision,
    incoming: &bundle::ParsedBundle,
    canonical_checksum: &str,
  ) -> AuthResult<()> {
    if let Err(error) = ensure_same_revision_content(revision, incoming, canonical_checksum) {
      let Some(storage) = self.blob_storage.as_deref() else {
        return Err(error);
      };
      let bytes = self.load_revision_bundle_bytes(revision, storage).await?;
      let stored = bundle::parse_bundle_with_limits(&bytes, self.bundle_zip_limits())?;
      ensure_same_stored_revision_content(revision, incoming, &stored, &compute_content_hash(&bytes))?;
    }
    Ok(())
  }

  async fn load_revision_bundle_bytes(
    &self,
    revision: &TemplateRevision,
    blob_storage: &dyn BlobStoragePort,
  ) -> AuthResult<Vec<u8>> {
    let blob_id = revision
      .bundle_blob_id
      .as_deref()
      .ok_or_else(|| AuthError::InvalidInput("revision has no bundle_blob_id".to_string()))?;

    let blob_response = blob_storage
      .read_blob(blob_id)
      .await
      .map_err(|e| AuthError::Storage(format!("failed to read template bundle blob '{}': {}", blob_id, e)))?;

    Ok(blob_response.data.to_vec())
  }

  async fn load_revision_content_bytes(
    &self,
    revision: &TemplateRevision,
    blob_storage: &dyn BlobStoragePort,
    instance: &mut WorkspaceTemplateInstance,
  ) -> AuthResult<Vec<u8>> {
    let bundle_bytes = self.load_revision_bundle_bytes(revision, blob_storage).await?;
    match bundle::parse_bundle_with_limits(&bundle_bytes, self.bundle_zip_limits()) {
      Ok(parsed) => {
        let requested = match &instance.locale_hash {
          Some(locale) => locale.clone(),
          None => {
            self
              .store
              .resolve_bundle_source_language(instance.workspace_doc_id)
              .await?
          }
        };
        let selected = parsed.select_locale(&requested);
        // Never let a revision update or UI-language change rewrite a source's
        // recorded language. Older sources acquire their existing document key.
        if instance.locale_hash.is_none() {
          instance.locale_hash = Some(if instance.workspace_doc_id.is_some() {
            requested
          } else {
            selected.clone()
          });
        }
        let prepared = content::prepare_document(parsed.content_for_locale(&selected), self.zip_limits)?;
        self
          .materialize_document_assets(instance.workspace_id, &prepared.assets)
          .await?;
        Ok(prepared.update)
      }
      Err(e) => {
        // Backward compatibility: older revisions may store raw content bytes
        // instead of a full template bundle in `bundle_blob_id`.
        warn!(
          revision_id = %revision.id,
          error = %e,
          "template bundle parse failed, falling back to raw blob content"
        );
        if instance.locale_hash.is_none() {
          instance.locale_hash = Some(
            self
              .store
              .resolve_bundle_source_language(instance.workspace_doc_id)
              .await?,
          );
        }
        content::document_update(&bundle_bytes, self.zip_limits)
      }
    }
  }

  /// Publish bytes before their page becomes discoverable. Hash-addressed keys
  /// permit retries and multiple translated guides to reuse one workspace blob.
  #[instrument(skip_all, fields(%workspace_id, asset_count = assets.len()))]
  async fn materialize_document_assets(
    &self,
    workspace_id: WorkspaceId,
    assets: &[content::PreparedAsset],
  ) -> AuthResult<()> {
    if assets.is_empty() {
      return Ok(());
    }
    let service = self
      .asset_service
      .as_ref()
      .ok_or_else(|| AuthError::Storage("template asset materialization is unavailable".into()))?;
    for asset in assets {
      if let Some(existing) = service.get_blob_metadata(workspace_id, &asset.key).await? {
        if existing.deleted_at.is_none() && existing.status == crate::ports::blob::BlobStatus::Completed {
          let stored = service
            .get_blob_bounded(workspace_id, &asset.key, asset.bytes.len() as u64)
            .await?;
          if stored.data.as_ref() != asset.bytes.as_slice() {
            return Err(AuthError::Storage("template workspace asset checksum mismatch".into()));
          }
          continue;
        }
      }
      service
        .upload_single_part_blob(
          workspace_id,
          &asset.key,
          asset.bytes.clone().into(),
          &asset.mime,
          Some(asset.mime.clone()),
          Some(&asset.sha256),
        )
        .await?;
    }
    Ok(())
  }

  /// Import a template from a raw ZIP bundle.
  ///
  /// This is the high-level entry point that:
  /// 1. Parses the bundle (ZIP extraction)
  /// 2. Validates the manifest
  /// 3. Checks content checksum (if declared)
  /// 4. Creates or reuses the catalog entry
  /// 5. Creates a draft revision
  /// 6. Validates and transitions to `Validated` state
  ///
  /// Returns the catalog entry, the validated revision, and any validation warnings.
  #[instrument(skip(self, data))]
  pub async fn import_from_bundle(
    &self,
    data: &[u8],
    created_by: UserId,
  ) -> AuthResult<(TemplateCatalogEntry, TemplateRevision, Vec<bundle::ValidationError>)> {
    info!(created_by = %created_by, "template.import.start");
    let result = self
      .import_from_bundle_with_filename_detailed_as(data, "import", Some(created_by))
      .await;
    match &result {
      Ok(result) => {
        info!(
          created_by = ?created_by,
          template_id = %result.entry.id,
          revision_id = %result.revision.id,
          "template.import.success"
        );
      }
      Err(err) => {
        error!(created_by = %created_by, error = %err, "template.import.failed");
      }
    }
    let result = result?;
    Ok((result.entry, result.revision, result.warnings))
  }

  /// Import a template from a raw ZIP bundle, using an optional filename hint.
  #[instrument(skip(self, data))]
  pub async fn import_from_bundle_with_filename(
    &self,
    data: &[u8],
    filename: &str,
    created_by: UserId,
  ) -> AuthResult<(TemplateCatalogEntry, TemplateRevision, Vec<bundle::ValidationError>)> {
    info!(filename = filename, created_by = %created_by, "template.import.start");
    let result = self
      .import_from_bundle_with_filename_detailed_as(data, filename, Some(created_by))
      .await;
    match &result {
      Ok(result) => {
        info!(
          filename = filename,
          created_by = ?created_by,
          template_id = %result.entry.id,
          revision_id = %result.revision.id,
          "template.import.success"
        );
      }
      Err(err) => {
        error!(filename = filename, created_by = %created_by, error = %err, "template.import.failed");
      }
    }
    let result = result?;
    Ok((result.entry, result.revision, result.warnings))
  }

  /// Import a template from a raw ZIP bundle and return extended import metadata.
  #[instrument(skip(self, data))]
  pub async fn import_from_bundle_with_filename_detailed(
    &self,
    data: &[u8],
    filename: &str,
    created_by: UserId,
  ) -> AuthResult<TemplateImportOutcome> {
    self
      .import_from_bundle_with_filename_detailed_as(data, filename, Some(created_by))
      .await
  }

  /// Register a server-supplied release bundle through the normal import and
  /// validation pipeline without fabricating an administrative caller.
  pub async fn import_shipped_bundle(&self, data: &[u8], filename: &str) -> AuthResult<TemplateImportOutcome> {
    self
      .import_from_bundle_with_filename_detailed_as(data, filename, None)
      .await
  }

  /// Stage immutable release content without selecting current, adopting instances,
  /// or rewriting policies. The batch selection owns subsequent publication.
  pub async fn stage_shipped_catalog_bundle(
    &self,
    data: &[u8],
    filename: &str,
  ) -> AuthResult<(TemplateCatalogEntry, TemplateRevision)> {
    let outcome = self.import_from_bundle_owned(data, filename, None, true).await?;
    if outcome.revision.created_by.is_some() {
      return Err(AuthError::InvalidInput(
        "release revision belongs to an operator".into(),
      ));
    }
    let revision = if outcome.revision.state == RevisionState::Draft {
      match self.validate_template_bundle(outcome.revision.id).await {
        Ok(revision) => revision,
        Err(error) => match self.store.get_revision(outcome.revision.id).await? {
          Some(revision)
            if matches!(
              revision.state,
              RevisionState::Validated | RevisionState::Published | RevisionState::Deprecated
            ) =>
          {
            revision
          }
          _ => return Err(error),
        },
      }
    } else {
      outcome.revision
    };
    if !matches!(
      revision.state,
      RevisionState::Validated | RevisionState::Published | RevisionState::Deprecated
    ) {
      return Err(AuthError::InvalidInput("release revision is not validated".into()));
    }
    Ok((outcome.entry, revision))
  }

  /// Select a complete admitted release; omitted release-owned identities are
  /// withdrawals. This commits native metadata only, not Workspace bodies.
  pub async fn commit_shipped_catalog_selection(
    &self,
    selection: &[ShippedTemplateSelection],
  ) -> AuthResult<ShippedTemplateSelectionReport> {
    self.store.commit_shipped_catalog_selection(selection).await
  }

  /// Import, validate and publish one server-supplied release asset. Repeated
  /// startup reuses an identical slug/version/checksum and never changes an
  /// operator-owned revision or catalog status.
  pub async fn register_shipped_bundle(
    &self,
    data: &[u8],
    filename: &str,
  ) -> AuthResult<(TemplateCatalogEntry, TemplateRevision)> {
    let outcome = self.import_from_bundle_owned(data, filename, None, true).await?;
    let revision = match outcome.revision.state {
      RevisionState::Published | RevisionState::Deprecated => outcome.revision,
      RevisionState::Draft | RevisionState::Validated if outcome.revision.created_by.is_none() => {
        let validated = if outcome.revision.state == RevisionState::Draft {
          self.validate_template_bundle(outcome.revision.id).await?
        } else {
          outcome.revision
        };
        match self.publish_revision(validated.id).await {
          Ok(published) => published,
          Err(error) => {
            // Another server process may have completed the same bounded
            // startup registration after this process read the draft.
            match self.store.get_revision(validated.id).await? {
              Some(current) if matches!(current.state, RevisionState::Published | RevisionState::Deprecated) => current,
              _ => return Err(error),
            }
          }
        }
      }
      state => {
        return Err(AuthError::InvalidInput(format!(
          "shipped template {} {} conflicts with operator-owned revision in state {state}",
          outcome.entry.slug, outcome.revision.version
        )));
      }
    };
    let parsed = bundle::parse_bundle_with_filename_and_limits(data, filename, self.bundle_zip_limits())?;
    self
      .transition_released_builtin(&outcome.entry, &revision, &parsed)
      .await?;
    let entry = self
      .store
      .get_catalog_entry(outcome.entry.id)
      .await?
      .ok_or_else(|| AuthError::NotFound("shipped template".into()))?;
    Ok((entry, revision))
  }

  async fn import_from_bundle_with_filename_detailed_as(
    &self,
    data: &[u8],
    filename: &str,
    created_by: Option<UserId>,
  ) -> AuthResult<TemplateImportOutcome> {
    self.import_from_bundle_owned(data, filename, created_by, false).await
  }

  // Only committed startup delivery may stage a real revision under a listed
  // builtin owner. Source ownership changes later in one guarded transaction.
  async fn import_from_bundle_owned(
    &self,
    data: &[u8],
    filename: &str,
    created_by: Option<UserId>,
    system_release: bool,
  ) -> AuthResult<TemplateImportOutcome> {
    info!(filename = filename, created_by = ?created_by, "template.import.start");
    let mut metric_guard = TemplateRegistryMetricGuard::new(self.telemetry.clone(), TEMPLATE_IMPORT_FAILED_EVENT);
    let mut import_job = match TemplateImportJobTracker::start(self.store.as_ref(), created_by).await {
      Ok(job) => job,
      Err(err) => {
        error!(filename = filename, created_by = ?created_by, error = %err, "template.import.failed");
        return Err(err);
      }
    };
    let import_job_id = import_job.id();
    let mut job_report = import_job.report_snapshot();

    info!(job_id = %import_job_id, filename = filename, "template.import.job.created");

    let import_start_audit = TemplateAuditContext::unknown()
      .with_actor_user_id(created_by)
      .with_job_id(import_job_id);
    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Imported,
        TEMPLATE_IMPORT_STARTED_EVENT,
        &import_start_audit,
        "template import started",
        Some(audit_payload(
          "started",
          "template import started",
          Some(serde_json::json!({ "filename": filename })),
          None,
        )),
      )
      .await;

    let detect_started = Instant::now();
    let parsed = match bundle::parse_bundle_with_filename_and_limits(data, filename, self.bundle_zip_limits()) {
      Ok(parsed) => {
        job_report.push_stage("detect", parsed.parse_timings.detect);
        job_report.push_stage("unpack", parsed.parse_timings.unpack);
        job_report.push_stage("normalize", parsed.parse_timings.normalize);
        job_report.detected_format = Some(parsed.format.as_str().to_string());
        job_report.normalized = Some(!matches!(parsed.format, bundle::BundleFormat::TemplateBundle));
        job_report.ignored_entries_count = Some(parsed.ignored_entries.len());
        parsed
      }
      Err(e) => {
        job_report.push_stage("detect", detect_started.elapsed());
        import_job.set_report(job_report.clone());
        let error_summary =
          template_operation_error_summary_from_auth_error(TemplateRegistryOperation::Import, "detect", &e);
        let error_code = error_summary.code.clone();
        import_job.fail("detect", error_summary, Vec::new()).await;
        metric_guard.mark_rejected();
        let audit = import_start_audit.clone().with_error_code(error_code.clone());
        self
          .record_audit_event(
            Level::WARN,
            TemplateRegistryAuditAction::Failed,
            TEMPLATE_IMPORT_FORMAT_REJECTED_EVENT,
            &audit,
            "template import rejected during bundle detection",
            Some(audit_payload(
              "rejected",
              "template import rejected during bundle detection",
              Some(serde_json::json!({
                "filename": filename,
                "stage": "detect",
                "error_code": error_code,
              })),
              Some(&e),
            )),
          )
          .await;
        self
          .record_audit_event(
            Level::WARN,
            TemplateRegistryAuditAction::Failed,
            TEMPLATE_IMPORT_FAILED_EVENT,
            &audit,
            "template import failed during bundle detection",
            Some(audit_payload(
              "failed",
              "template import failed during bundle detection",
              Some(serde_json::json!({ "filename": filename })),
              Some(&e),
            )),
          )
          .await;
        error!(
          job_id = %import_job_id,
          filename = filename,
          created_by = ?created_by,
          error = %e,
          error_code = %error_code,
          "template.import.failed"
        );
        return Err(e);
      }
    };

    let detected_format = parsed.format;
    let ignored_entries_count = parsed.ignored_entries.len();
    let normalized = !matches!(detected_format, bundle::BundleFormat::TemplateBundle);
    if normalized {
      metric_guard.mark_normalized();
    }
    let manifest_json =
      serde_json::to_value(&parsed.manifest).unwrap_or_else(|_| serde_json::Value::Object(Default::default()));
    job_report.detected_format = Some(detected_format.as_str().to_string());
    job_report.normalized = Some(normalized);
    job_report.ignored_entries_count = Some(ignored_entries_count);
    let import_audit = TemplateAuditContext::unknown()
      .with_actor_user_id(created_by)
      .with_job_id(import_job_id)
      .with_import_metadata(
        detected_format.as_str(),
        detected_format.as_str(),
        if normalized {
          TEMPLATE_REGISTRY_NORMALIZER_VERSION
        } else {
          "none"
        },
        ignored_entries_count,
        TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION,
      );

    info!(
      filename = filename,
      job_id = %import_job_id,
      format = detected_format.as_str(),
      ignored_entry_count = ignored_entries_count,
      "template.import.bundle_detected"
    );
    if !parsed.ignored_entries.is_empty() {
      debug!(
        filename = filename,
        job_id = %import_job_id,
        format = detected_format.as_str(),
        ignored_entries = ?parsed.ignored_entries,
        "template.import.ignored_entries"
      );
    }

    let validate_started = Instant::now();
    let validation_errors = content::validation_findings(&parsed, self.zip_limits);
    let fatal_validation_errors: Vec<_> = validation_errors
      .iter()
      .filter(|e| e.severity == bundle::ValidationSeverity::Error)
      .cloned()
      .collect();
    let warnings: Vec<bundle::ValidationError> = validation_errors
      .iter()
      .filter(|e| e.severity == bundle::ValidationSeverity::Warning)
      .cloned()
      .collect();
    job_report.push_stage("validate", validate_started.elapsed());
    if !fatal_validation_errors.is_empty() {
      warn!(
        job_id = %import_job_id,
        error_count = fatal_validation_errors.len(),
        reason = "manifest validation errors",
        "{}",
        TEMPLATE_IMPORT_FAILED_EVENT
      );

      let error_summary = template_operation_error_summary_from_validation_error(
        TemplateRegistryOperation::Import,
        "validate",
        &fatal_validation_errors[0],
      );
      let error_code = error_summary.code.clone();
      import_job.set_report(job_report.clone());
      import_job
        .fail("validate", error_summary, fatal_validation_errors.clone())
        .await;

      metric_guard.mark_rejected();
      let audit = import_audit.clone().with_error_code(error_code.clone());
      self
        .record_audit_event(
          Level::WARN,
          TemplateRegistryAuditAction::Failed,
          TEMPLATE_IMPORT_FORMAT_REJECTED_EVENT,
          &audit,
          "template import rejected during validation",
          Some(audit_payload(
            "rejected",
            "template import rejected during validation",
            Some(serde_json::json!({
              "job_id": import_job_id,
              "template_id": parsed.manifest.template_id,
              "validation_error_count": fatal_validation_errors.len(),
              "stage": "validate",
              "error_code": error_code,
            })),
            Some(&AuthError::InvalidInput(fatal_validation_errors[0].message.clone())),
          )),
        )
        .await;
      let audit = import_audit.clone().with_error_code(error_code.clone());
      self
        .record_audit_event(
          Level::WARN,
          TemplateRegistryAuditAction::Failed,
          TEMPLATE_IMPORT_FAILED_EVENT,
          &audit,
          "template import failed during validation",
          Some(audit_payload(
            "failed",
            "template import failed during validation",
            Some(serde_json::json!({
              "job_id": import_job_id,
              "template_id": parsed.manifest.template_id,
              "validation_error_count": fatal_validation_errors.len(),
            })),
            Some(&AuthError::InvalidInput(fatal_validation_errors[0].message.clone())),
          )),
        )
        .await;
      error!(
        job_id = %import_job_id,
        filename = filename,
        created_by = ?created_by,
        error = %AuthError::InvalidInput(fatal_validation_errors[0].message.clone()),
        error_code = %error_code,
        "template.import.failed"
      );
      return Err(AuthError::InvalidInput(format!(
        "manifest validation failed with {} error(s): {}",
        fatal_validation_errors.len(),
        fatal_validation_errors
          .iter()
          .map(|e| e.message.as_str())
          .collect::<Vec<_>>()
          .join("; ")
      )));
    }

    if let Err(e) = bundle::validate_content_checksum(&parsed.manifest, &parsed.content_checksum) {
      warn!(
        job_id = %import_job_id,
        error = %e.message,
        reason = "checksum mismatch",
        "{}",
        TEMPLATE_IMPORT_FAILED_EVENT
      );
      let error_summary =
        template_operation_error_summary_from_validation_error(TemplateRegistryOperation::Import, "validate", &e);
      let error_code = error_summary.code.clone();
      metric_guard.mark_rejected();
      let audit = import_audit.clone().with_error_code(error_code.clone());
      self
        .record_audit_event(
          Level::WARN,
          TemplateRegistryAuditAction::Failed,
          TEMPLATE_IMPORT_FORMAT_REJECTED_EVENT,
          &audit,
          "template import rejected during checksum validation",
          Some(audit_payload(
            "rejected",
            "template import rejected during checksum validation",
            Some(serde_json::json!({
              "job_id": import_job_id,
              "template_id": parsed.manifest.template_id,
              "stage": "validate",
              "error_code": error_code,
            })),
            Some(&AuthError::InvalidInput(e.message.clone())),
          )),
        )
        .await;
      let audit = import_audit.clone().with_error_code(error_code.clone());
      self
        .record_audit_event(
          Level::WARN,
          TemplateRegistryAuditAction::Failed,
          TEMPLATE_IMPORT_FAILED_EVENT,
          &audit,
          "template import failed during checksum validation",
          Some(audit_payload(
            "failed",
            "template import failed during checksum validation",
            Some(serde_json::json!({
              "job_id": import_job_id,
              "template_id": parsed.manifest.template_id,
            })),
            Some(&AuthError::InvalidInput(e.message.clone())),
          )),
        )
        .await;
      error!(
        job_id = %import_job_id,
        filename = filename,
        created_by = ?created_by,
        error = %AuthError::InvalidInput(e.message.clone()),
        error_code = %error_code,
        "template.import.failed"
      );
      import_job.set_report(job_report.clone());
      import_job
        .fail(
          "validate",
          template_operation_error_summary_from_validation_error(TemplateRegistryOperation::Import, "validate", &e),
          validation_errors
            .iter()
            .filter(|entry| entry.severity == bundle::ValidationSeverity::Error)
            .cloned()
            .collect(),
        )
        .await;
      return Err(AuthError::InvalidInput(e.message));
    }

    if system_release
      && let Some(existing) = self
        .store
        .get_catalog_entry_by_slug(&parsed.manifest.template_id)
        .await?
      && existing.source == TemplateSource::Builtin
      && released_builtin::is_released_system_slug(&existing.slug)
    {
      if let Err(error) = released_builtin::validate_released_system_manifest(&parsed.manifest) {
        import_job
          .fail(
            "validate",
            template_operation_error_summary_from_auth_error(TemplateRegistryOperation::Import, "validate", &error),
            Vec::new(),
          )
          .await;
        return Err(error);
      }
    }

    // S-06: Reject bundle import if the slug is already owned by a builtin entry.
    // Builtin slugs are managed server-side; overwriting them via bundle upload would
    // break the reconcile protocol (expected_hash, builder_version invariants).
    if let Some(existing) = self
      .store
      .get_catalog_entry_by_slug(&parsed.manifest.template_id)
      .await?
      && existing.source == TemplateSource::Builtin
      && !(system_release && created_by.is_none() && released_builtin::is_released_system_slug(&existing.slug))
    {
      let conflict_msg = format!(
        "slug '{}' is already registered as a builtin template and cannot be overwritten via bundle import",
        parsed.manifest.template_id
      );
      warn!(
        slug = %parsed.manifest.template_id,
        job_id = %import_job_id,
        filename = filename,
        "template.import.rejected — slug is owned by a builtin entry"
      );
      let err = AuthError::InvalidInput(conflict_msg.clone());
      import_job
        .fail(
          "validate",
          template_operation_error_summary_from_auth_error(TemplateRegistryOperation::Import, "validate", &err),
          Vec::new(),
        )
        .await;
      return Err(err);
    }

    let canonical_bundle_bytes = match bundle::create_export_bundle(
      &parsed.manifest,
      &parsed.content_bytes,
      parsed.preview_bytes.as_deref(),
      &parsed.localized_contents,
    ) {
      Ok(bytes) => bytes,
      Err(e) => {
        let err = AuthError::InvalidInput(format!("failed to normalize template bundle to myoxus_bundle: {e}"));
        let error_summary =
          template_operation_error_summary_from_auth_error(TemplateRegistryOperation::Import, "persist", &err);
        let audit = import_audit.clone().with_error_code(error_summary.code.clone());
        import_job.set_report(job_report.clone());
        import_job
          .fail(
            "persist",
            template_operation_error_summary_from_auth_error(TemplateRegistryOperation::Import, "persist", &err),
            Vec::new(),
          )
          .await;
        self
          .record_audit_event(
            Level::WARN,
            TemplateRegistryAuditAction::Failed,
            TEMPLATE_IMPORT_FAILED_EVENT,
            &audit,
            "template import failed while normalizing bundle",
            Some(audit_payload(
              "failed",
              "template import failed while normalizing bundle",
              Some(serde_json::json!({
                "job_id": import_job_id,
                "template_id": parsed.manifest.template_id,
              })),
              Some(&err),
            )),
          )
          .await;
        error!(
          job_id = %import_job_id,
          filename = filename,
          created_by = ?created_by,
          error = %e,
          error_code = %error_summary.code,
          "template.import.failed"
        );
        return Err(err);
      }
    };
    let mut canonical_bundle_hasher = Sha256::new();
    canonical_bundle_hasher.update(&canonical_bundle_bytes);
    let canonical_bundle_checksum = format!("{:x}", canonical_bundle_hasher.finalize());

    if let Some(existing_entry) = self
      .store
      .get_catalog_entry_by_slug(&parsed.manifest.template_id)
      .await?
      && let Some(existing_revision) = self
        .store
        .list_revisions(existing_entry.id, 0, 1_000)
        .await?
        .into_iter()
        .find(|revision| revision.version == parsed.manifest.version)
    {
      if let Err(err) = self
        .ensure_revision_content(&existing_revision, &parsed, &canonical_bundle_checksum)
        .await
      {
        import_job
          .fail(
            "validate",
            template_operation_error_summary_from_auth_error(TemplateRegistryOperation::Import, "validate", &err),
            Vec::new(),
          )
          .await;
        return Err(err);
      }

      import_job.set_report(job_report.clone());
      import_job.complete(existing_revision.id, warnings.clone(), None).await;
      metric_guard.mark_success(TEMPLATE_IMPORT_COMPLETED_EVENT);
      info!(
        template_id = %existing_entry.id,
        revision_id = %existing_revision.id,
        filename,
        "template.import.reused_identical_revision"
      );
      return Ok(TemplateImportOutcome {
        entry: existing_entry,
        revision: existing_revision,
        warnings,
        detected_format,
        normalized,
        ignored_entries_count,
        error_catalog_version: TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION,
      });
    }

    let persist_started = Instant::now();
    let revision_format_metadata = RevisionFormatMetadata::from_import(
      detected_format,
      ignored_entries_count,
      TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION,
      normalization_warnings_from_validation_warnings(&warnings),
    );
    let mut stored_bundle_blob_id = canonical_bundle_checksum.clone();
    let mut stored_preview_blob_id: Option<String> = None;

    let persist_result: AuthResult<(TemplateCatalogEntry, TemplateRevision)> = async {
      if let Some(blob_storage) = &self.blob_storage {
        let bundle_blob_key = format!(
          "template-registry/bundles/{}/{}/{}.zip",
          parsed.manifest.template_id, parsed.manifest.version, canonical_bundle_checksum
        );
        blob_storage
          .write_blob(BlobWriteRequest {
            key: bundle_blob_key.clone(),
            content_type: Some("application/zip".to_string()),
            body: Bytes::copy_from_slice(&canonical_bundle_bytes),
          })
          .await
          .map_err(|e| AuthError::Storage(format!("failed to store template bundle '{}': {}", bundle_blob_key, e)))?;
        stored_bundle_blob_id = bundle_blob_key;

        if let Some(preview_bytes) = parsed.preview_bytes.as_deref() {
          let preview_blob_key = format!(
            "template-registry/previews/{}/{}/{}.svg",
            parsed.manifest.template_id, parsed.manifest.version, canonical_bundle_checksum
          );
          blob_storage
            .write_blob(BlobWriteRequest {
              key: preview_blob_key.clone(),
              content_type: Some("image/svg+xml".to_string()),
              body: Bytes::copy_from_slice(preview_bytes),
            })
            .await
            .map_err(|e| {
              AuthError::Storage(format!(
                "failed to store template preview '{}': {}",
                preview_blob_key, e
              ))
            })?;
          stored_preview_blob_id = Some(preview_blob_key);
        }
      } else {
        debug!(
          template_id = %parsed.manifest.template_id,
          version = %parsed.manifest.version,
          job_id = %import_job_id,
          canonical_bundle_checksum = %canonical_bundle_checksum,
          "template.import.storage_unavailable — keeping checksum placeholder as bundle_blob_id"
        );
      }

      let (entry, mut revision) = self
        .import_template_bundle_with_metadata(ImportTemplateBundleWithMetadataRequest {
          bundle: ImportTemplateBundleRequest {
            slug: &parsed.manifest.template_id,
            title: &parsed.manifest.title,
            description: parsed.manifest.description.as_deref(),
            category: parsed.manifest.category.as_deref(),
            tags: parsed.manifest.tags.clone(),
            version: &parsed.manifest.version,
            bundle_blob_id: &stored_bundle_blob_id,
            preview_blob_id: stored_preview_blob_id.as_deref(),
            checksum: &parsed.content_checksum,
            manifest: manifest_json,
            created_by,
          },
          revision_format_metadata: revision_format_metadata.clone(),
        })
        .await?;

      revision = match self
        .validate_template_bundle_with_content(revision.id, Some(&parsed.content_bytes))
        .await
      {
        Ok(revision) => revision,
        Err(err) => {
          let error_summary =
            template_operation_error_summary_from_auth_error(TemplateRegistryOperation::Import, "persist", &err);
          error!(
            job_id = %import_job_id,
            filename = filename,
            template_id = %entry.id,
            revision_id = %revision.id,
            created_by = ?created_by,
            error = %err,
            error_code = %error_summary.code,
            "template.import.failed"
          );
          return Err(err);
        }
      };
      Ok((entry, revision))
    }
    .await;

    let (entry, revision) = match persist_result {
      Ok(result) => {
        job_report.push_stage("persist", persist_started.elapsed());
        result
      }
      Err(e) => {
        job_report.push_stage("persist", persist_started.elapsed());
        let error_summary =
          template_operation_error_summary_from_auth_error(TemplateRegistryOperation::Import, "persist", &e);
        let error_code = error_summary.code.clone();
        import_job.set_report(job_report.clone());
        import_job.fail("persist", error_summary, Vec::new()).await;
        error!(
          job_id = %import_job_id,
          filename = filename,
          created_by = ?created_by,
          error = %e,
          error_code = %error_code,
          "template.import.failed"
        );
        return Err(e);
      }
    };

    import_job.set_report(job_report.clone());
    import_job
      .complete(
        revision.id,
        warnings.clone(),
        self.blob_storage.as_ref().map(|_| stored_bundle_blob_id.clone()),
      )
      .await;

    if normalized {
      let normalized_audit = TemplateAuditContext::from_import_metadata(&revision_format_metadata)
        .with_actor_user_id(created_by)
        .with_job_id(import_job_id)
        .with_template_id(entry.id)
        .with_revision_id(revision.id);
      self
        .record_audit_event(
          Level::INFO,
          TemplateRegistryAuditAction::Imported,
          TEMPLATE_IMPORT_FORMAT_NORMALIZED_EVENT,
          &normalized_audit,
          "template import normalized input format",
          Some(audit_payload(
            "normalized",
            "template import normalized input format",
            Some(serde_json::json!({
              "job_id": import_job_id,
              "template_id": entry.id,
              "revision_id": revision.id,
              "normalized": true,
              "source_format": detected_format.as_str(),
              "detected_format": bundle::BundleFormat::TemplateBundle.as_str(),
              "normalizer_version": TEMPLATE_REGISTRY_NORMALIZER_VERSION,
            })),
            None,
          )),
        )
        .await;
    }

    let completed_audit = import_audit
      .clone()
      .with_template_id(entry.id)
      .with_revision_id(revision.id);
    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Imported,
        TEMPLATE_IMPORT_COMPLETED_EVENT,
        &completed_audit,
        "template import completed",
        Some(audit_payload(
          "completed",
          "template import completed",
          Some(serde_json::json!({
            "job_id": import_job_id,
            "template_id": entry.id,
            "revision_id": revision.id,
            "version": revision.version,
            "warning_count": warnings.len(),
            "normalized": normalized,
          })),
          None,
        )),
      )
      .await;
    metric_guard.mark_success(TEMPLATE_IMPORT_COMPLETED_EVENT);

    info!(
      job_id = %import_job_id,
      filename = filename,
      template_id = %entry.id,
      revision_id = %revision.id,
      normalized = normalized,
      "template.import.success"
    );
    Ok(TemplateImportOutcome {
      entry,
      revision,
      warnings,
      detected_format,
      normalized,
      ignored_entries_count,
      error_catalog_version: TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION,
    })
  }

  /// Export a published revision as a ZIP bundle.
  ///
  /// Reconstructs the bundle from the stored manifest, content blob, and
  /// optional preview blob.  Only published or deprecated revisions can be
  /// exported (they have complete data).
  #[instrument(skip(self, content_bytes, preview_bytes, localized_contents))]
  pub async fn export_revision(
    &self,
    revision_id: TemplateRevisionId,
    content_bytes: &[u8],
    preview_bytes: Option<&[u8]>,
    localized_contents: &std::collections::BTreeMap<String, Vec<u8>>,
  ) -> AuthResult<Vec<u8>> {
    info!(revision_id = %revision_id, "template.export.start");
    let revision = match self.store.get_revision(revision_id).await {
      Ok(Some(revision)) => revision,
      Ok(None) => {
        let err = AuthError::InvalidInput("Revision not found".to_string());
        let error_summary =
          template_operation_error_summary_from_auth_error(TemplateRegistryOperation::Export, "load_revision", &err);
        error!(
          revision_id = %revision_id,
          error = %err,
          error_code = %error_summary.code,
          "template.export.failed"
        );
        return Err(err);
      }
      Err(err) => {
        let error_summary =
          template_operation_error_summary_from_auth_error(TemplateRegistryOperation::Export, "load_revision", &err);
        error!(
          revision_id = %revision_id,
          error = %err,
          error_code = %error_summary.code,
          "template.export.failed"
        );
        return Err(err);
      }
    };

    // Only published or deprecated revisions have complete data for export
    if revision.state != RevisionState::Published && revision.state != RevisionState::Deprecated {
      let err = AuthError::InvalidInput(format!(
        "cannot export revision in state '{}' — only Published or Deprecated revisions can be exported",
        revision.state
      ));
      let error_summary = template_operation_error_summary_from_auth_error(
        TemplateRegistryOperation::Export,
        "validate_revision_state",
        &err,
      );
      error!(
        revision_id = %revision_id,
        template_id = %revision.template_id,
        error = %err,
        error_code = %error_summary.code,
        "template.export.failed"
      );
      return Err(err);
    }

    // Reconstruct manifest from stored JSON
    let manifest: bundle::Manifest = match &revision.manifest {
      Some(json) => match serde_json::from_value(json.clone()) {
        Ok(manifest) => manifest,
        Err(e) => {
          let err = AuthError::InvalidInput(format!("failed to deserialize stored manifest: {e}"));
          let error_summary = template_operation_error_summary_from_auth_error(
            TemplateRegistryOperation::Export,
            "deserialize_manifest",
            &err,
          );
          error!(
            revision_id = %revision_id,
            template_id = %revision.template_id,
            error = %err,
            error_code = %error_summary.code,
            "template.export.failed"
          );
          return Err(err);
        }
      },
      None => {
        let err = AuthError::InvalidInput("revision has no stored manifest".to_string());
        let error_summary = template_operation_error_summary_from_auth_error(
          TemplateRegistryOperation::Export,
          "deserialize_manifest",
          &err,
        );
        error!(
          revision_id = %revision_id,
          template_id = %revision.template_id,
          error = %err,
          error_code = %error_summary.code,
          "template.export.failed"
        );
        return Err(err);
      }
    };

    let export_bytes = match bundle::create_export_bundle(&manifest, content_bytes, preview_bytes, localized_contents) {
      Ok(bytes) => bytes,
      Err(err) => {
        let error_summary =
          template_operation_error_summary_from_auth_error(TemplateRegistryOperation::Export, "build_bundle", &err);
        error!(
          revision_id = %revision_id,
          template_id = %revision.template_id,
          error = %err,
          error_code = %error_summary.code,
          "template.export.failed"
        );
        return Err(err);
      }
    };

    let audit = TemplateAuditContext::from_revision(&revision);
    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Exported,
        TEMPLATE_EXPORT_COMPLETED_EVENT,
        &audit,
        "template revision exported",
        Some(audit_payload(
          "completed",
          "template revision exported",
          Some(serde_json::json!({
            "revision_id": revision_id,
            "template_id": revision.template_id,
            "version": revision.version,
            "export_size": export_bytes.len(),
          })),
          None,
        )),
      )
      .await;
    info!(
      revision_id = %revision_id,
      template_id = %revision.template_id,
      export_size = export_bytes.len(),
      "template.export.success"
    );

    Ok(export_bytes)
  }

  /// Get the template registry store reference (for GraphQL resolvers that
  /// need direct read access).
  pub fn store(&self) -> &dyn TemplateRegistryStore {
    self.store.as_ref()
  }

  // ─── Builtin Bridge (P125-TPL §3–§7) ────────────────────────────────────

  /// Install a server-shipped bundle as a new-workspace default without
  /// replacing an operator's existing policy or opt-out.
  #[instrument(skip(self), fields(slug))]
  pub async fn ensure_shipped_default_policy(&self, slug: &str) -> AuthResult<bool> {
    let entry = self
      .store
      .get_catalog_entry_by_slug(slug)
      .await?
      .ok_or_else(|| AuthError::NotFound(format!("shipped template not found: {slug}")))?;
    if entry.source != TemplateSource::Bundle {
      return Err(AuthError::InvalidInput(format!(
        "shipped default must reference a bundle template: {slug}"
      )));
    }
    // An operator-disabled/archived identity remains a valid registered release;
    // startup must neither activate its default nor fail the whole deployment.
    if entry.status != TemplateStatus::Active {
      return Ok(false);
    }
    let revision = self
      .store
      .get_latest_published_revision(entry.id)
      .await?
      .ok_or_else(|| AuthError::InvalidInput(format!("shipped default has no published revision: {slug}")))?;
    let now = Utc::now();
    self
      .store
      .insert_default_policy_if_absent(&TemplateDefaultPolicy {
        template_id: entry.id,
        apply_to_new_workspaces: true,
        selection_mode: SelectionMode::Published,
        provisioning_mode: shipped_default_provisioning_mode(&revision),
        created_at: now,
        updated_at: now,
      })
      .await
  }

  /// Change the new-workspace flag for an existing catalog/default-policy
  /// pair without creating a policy or changing its selection semantics.
  pub async fn set_new_workspace_default_for_slug(&self, slug: &str, apply: bool) -> AuthResult<bool> {
    let Some(entry) = self.store.get_catalog_entry_by_slug(slug).await? else {
      return Ok(false);
    };
    if !self
      .store
      .list_default_policies()
      .await?
      .into_iter()
      .any(|policy| policy.template_id == entry.id)
    {
      return Ok(false);
    }
    self.store.set_default_policy_apply_flag(entry.id, apply).await?;
    Ok(true)
  }

  /// Inspect or apply a bounded, resumable replacement of eligible central
  /// assignments. Replacement materialization must be ready before the old
  /// source enters the existing retirement lifecycle.
  #[instrument(skip(self), fields(source_slug = request.source_slug, replacement_slug = request.replacement_slug, apply = request.apply))]
  pub async fn replace_default_assignments(
    &self,
    request: TemplateDefaultReplacementRequest<'_>,
  ) -> AuthResult<Vec<TemplateDefaultReplacementResult>> {
    self.replace_default_assignments_inner(request, None).await
  }

  async fn replace_default_assignments_inner(
    &self,
    request: TemplateDefaultReplacementRequest<'_>,
    only_policy: Option<WorkspaceTemplatePolicyId>,
  ) -> AuthResult<Vec<TemplateDefaultReplacementResult>> {
    if request.limit == 0 || request.limit > 500 {
      return Err(AuthError::InvalidInput(
        "replacement limit must be between 1 and 500".to_string(),
      ));
    }
    if request.source_slug == request.replacement_slug {
      return Err(AuthError::InvalidInput(
        "source and replacement template slugs must differ".to_string(),
      ));
    }
    let source = self
      .store
      .get_catalog_entry_by_slug(request.source_slug)
      .await?
      .ok_or_else(|| AuthError::NotFound(format!("source template not found: {}", request.source_slug)))?;
    let replacement = self
      .store
      .get_catalog_entry_by_slug(request.replacement_slug)
      .await?
      .ok_or_else(|| AuthError::NotFound(format!("replacement template not found: {}", request.replacement_slug)))?;
    if replacement.source != TemplateSource::Bundle || replacement.status != TemplateStatus::Active {
      return Err(AuthError::InvalidInput(
        "replacement template must be an active bundle".to_string(),
      ));
    }
    if self
      .store
      .get_latest_published_revision(replacement.id)
      .await?
      .is_none()
    {
      return Err(AuthError::InvalidInput(
        "replacement template has no published revision".to_string(),
      ));
    }

    let policies = if let Some(id) = only_policy {
      self
        .store
        .get_policy(id)
        .await?
        .filter(|policy| policy.template_id == source.id)
        .into_iter()
        .collect()
    } else {
      self.store.list_policies_for_template(source.id).await?
    };
    let start = match request.after_policy_id {
      Some(after) => policies
        .iter()
        .position(|policy| policy.id == after)
        .map(|index| index + 1)
        .ok_or_else(|| AuthError::InvalidInput("after-policy-id is not a source assignment".to_string()))?,
      None => 0,
    };
    let mut results = Vec::new();
    for source_policy in policies.into_iter().skip(start).take(request.limit) {
      let mut result = TemplateDefaultReplacementResult {
        policy_id: source_policy.id,
        workspace_id: source_policy.workspace_id,
        outcome: "preserved".to_string(),
        detail: String::new(),
        retired_source_doc_id: None,
        replacement_source_doc_id: None,
      };
      if !source_policy.is_enabled {
        result.detail = "source assignment is explicitly disabled".to_string();
        results.push(result);
        continue;
      }
      if source_policy.selection_mode != SelectionMode::Published
        || source_policy.provisioning_mode != ProvisioningMode::ManagedUntilLocalEdit
      {
        result.detail = "source assignment has an explicit pin or provisioning choice".to_string();
        results.push(result);
        continue;
      }
      let source_instance = self
        .store
        .list_instances_for_workspace(source_policy.workspace_id)
        .await?
        .into_iter()
        .find(|instance| instance.template_id == source.id);
      if source_instance
        .as_ref()
        .is_some_and(|instance| instance.state == InstanceState::Detached)
      {
        result.detail = "source instance is detached".to_string();
        results.push(result);
        continue;
      }
      let source_revision = if let Some(instance) = source_instance
        .as_ref()
        .filter(|instance| instance.workspace_doc_id.is_some())
      {
        let revision = self.unchanged_source_revision(instance).await?;
        if revision.is_none() {
          if request.apply {
            self
              .store
              .preserve_source_as_custom(source_policy.workspace_id, source.id)
              .await?;
          }
          result.detail = "source has live edits; retained as a custom template".into();
          results.push(result);
          continue;
        }
        revision
      } else {
        None
      };
      result.retired_source_doc_id = source_instance.as_ref().and_then(|instance| {
        instance
          .workspace_doc_key
          .clone()
          .or_else(|| instance.workspace_doc_id.map(|id| id.to_string()))
      });

      let replacement_policy = self
        .store
        .list_policies_for_workspace(source_policy.workspace_id)
        .await?
        .into_iter()
        .find(|policy| policy.template_id == replacement.id);
      if replacement_policy.as_ref().is_some_and(|policy| {
        !policy.is_enabled
          || policy.selection_mode != SelectionMode::Published
          || policy.provisioning_mode != ProvisioningMode::ManagedUntilLocalEdit
      }) {
        result.detail = "replacement assignment has an explicit disable, pin or provisioning choice".to_string();
        results.push(result);
        continue;
      }

      if !request.apply {
        result.outcome = "would-replace".to_string();
        result.detail = "eligible central assignment".to_string();
        results.push(result);
        continue;
      }

      if replacement_policy.is_none() {
        self
          .assign_template_to_workspace(
            source_policy.workspace_id,
            replacement.id,
            SelectionMode::Published,
            None,
            ProvisioningMode::ManagedUntilLocalEdit,
          )
          .await?;
      }
      // This explicit mapping must materialize its replacement before driving
      // release withdrawals; otherwise the old body could disappear too early.
      self
        .reconcile_workspace_templates_inner(source_policy.workspace_id, None)
        .await?;
      let replacement_instance = self
        .store
        .find_instance(source_policy.workspace_id, replacement.id)
        .await?
        .filter(|instance| instance.state == InstanceState::Ok)
        .ok_or_else(|| AuthError::Storage("replacement source did not become ready".to_string()))?;
      result.replacement_source_doc_id = replacement_instance
        .workspace_doc_key
        .clone()
        .or_else(|| replacement_instance.workspace_doc_id.map(|id| id.to_string()));
      if let (Some(retired_doc_id), Some(replacement_doc_id)) = (
        result.retired_source_doc_id.as_ref(),
        result.replacement_source_doc_id.as_ref(),
      ) {
        let already_recorded = self
          .store
          .list_audit_events(
            Some(TemplateRegistryAuditEventFilter {
              event_type: Some(TEMPLATE_DEFAULT_REPLACED_EVENT.to_string()),
              policy_id: Some(source_policy.id),
              ..TemplateRegistryAuditEventFilter::default()
            }),
            0,
            1,
          )
          .await?
          .into_iter()
          .next()
          .is_some();
        if !already_recorded {
          self
            .persist_audit_event(
              Level::INFO,
              TemplateRegistryAuditAction::Updated,
              TEMPLATE_DEFAULT_REPLACED_EVENT,
              &TemplateAuditContext::unknown()
                .with_workspace_id(source_policy.workspace_id)
                .with_template_id(replacement.id)
                .with_policy_id(source_policy.id)
                .with_instance_id(replacement_instance.id),
              "template default source replacement confirmed",
              Some(json!({
                "retired_source_doc_id": retired_doc_id,
                "replacement_source_doc_id": replacement_doc_id,
                "source_template_id": source.id,
                "replacement_template_id": replacement.id,
              })),
            )
            .await?;
        }
      }
      self
        .retire_template_assignment_inner(source_policy.id, None, source_revision, true)
        .await?;
      result.outcome = "replaced".to_string();
      result.detail = "replacement delivered before central source retirement".to_string();
      results.push(result);
    }
    Ok(results)
  }

  /// Return completed source replacements/withdrawals for compare-and-set
  /// migration of synced preferences. Pending intents never change a live source.
  pub async fn page_default_replacements(
    &self,
    workspace_id: WorkspaceId,
  ) -> AuthResult<Vec<TemplatePageDefaultReplacement>> {
    let events = self
      .store
      .list_audit_events(
        Some(TemplateRegistryAuditEventFilter {
          event_type: Some(TEMPLATE_DEFAULT_REPLACED_EVENT.to_string()),
          workspace_id: Some(workspace_id),
          ..TemplateRegistryAuditEventFilter::default()
        }),
        0,
        200,
      )
      .await?;
    let mut seen = std::collections::HashSet::new();
    let mut replacements = Vec::new();
    for event in events {
      let Some(payload) = event.payload_json else {
        continue;
      };
      let Some(retired) = payload.get("retired_source_doc_id").and_then(|value| value.as_str()) else {
        continue;
      };
      if retired.is_empty() || seen.contains(retired) {
        continue;
      }
      let Some(documents) = &self.doc_service else {
        continue;
      };
      // An edited source may have been preserved as custom after a failed
      // retirement. Its old Registry slot alone cannot attest physical deletion.
      let Ok(key) = myoxus_domain::document_key::DocumentKey::parse(retired.to_owned()) else {
        continue;
      };
      if documents
        .resolve_document_key(workspace_id, crate::doc::DocSpaceKind::Workspace, &key)
        .await?
        .is_some()
      {
        continue;
      }
      if let Ok(id) = uuid::Uuid::parse_str(retired)
        && documents
          .get_metadata_including_deleted(id)
          .await?
          .is_some_and(|document| document.workspace_id == Some(workspace_id) && document.userspace_owner_id.is_none())
      {
        continue;
      }
      let replacement = payload
        .get("replacement_source_doc_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
      seen.insert(retired.to_string());
      replacements.push(TemplatePageDefaultReplacement {
        retired_source_doc_id: retired.to_string(),
        replacement_source_doc_id: replacement,
      });
    }
    Ok(replacements)
  }

  /// Persist and enqueue one immediate workspace materialization request.
  /// The durable Registry row remains pending when Redis is unavailable, so
  /// the regular recovery scan can enqueue it later.
  #[instrument(skip(self), fields(%workspace_id))]
  pub async fn schedule_workspace_reconcile(&self, workspace_id: WorkspaceId) -> AuthResult<TemplateReconcileJobId> {
    let now = Utc::now();
    let mut job = TemplateReconcileJob {
      id: uuid::Uuid::new_v4(),
      scope: ReconcileScope::Workspace,
      workspace_id: Some(workspace_id),
      template_id: None,
      state: JobState::Pending,
      summary: Some(json!({ "delivery": "pending" })),
      started_at: Some(now),
      finished_at: None,
    };
    self.store.create_reconcile_job(&job).await?;

    let Some(queue) = self.reconcile_queue.get() else {
      job.summary = Some(json!({ "delivery": "pending", "error": "queue_unavailable" }));
      self.store.update_reconcile_job(&job).await?;
      warn!(%workspace_id, reconcile_job_id = %job.id, "template delivery persisted for queue recovery");
      return Ok(job.id);
    };
    if let Err(error) = queue
      .add_job(
        TEMPLATE_REGISTRY_QUEUE,
        TEMPLATE_RECONCILE_WORKSPACE_JOB,
        json!({ "workspaceId": workspace_id, "reconcileJobId": job.id }),
        Some(5),
        None,
      )
      .await
    {
      job.summary = Some(json!({ "delivery": "pending", "error": "enqueue_failed" }));
      self.store.update_reconcile_job(&job).await?;
      warn!(%workspace_id, reconcile_job_id = %job.id, error = %error, "template delivery enqueue deferred to recovery");
      return Ok(job.id);
    }

    job.summary = Some(json!({ "delivery": "queued" }));
    self.store.update_reconcile_job(&job).await?;
    Ok(job.id)
  }

  /// Seed a new workspace with workspace_template_policies from active default
  /// policies and immediately schedule materialization through the Registry
  /// queue. Assignment and delivery are both required for success.
  ///
  /// Returns the count of policy rows inserted. Idempotent.
  /// See §3.3 and S-03 in todo/server.md.
  #[instrument(skip(self), fields(%workspace_id))]
  pub async fn seed_default_policies_for_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<usize> {
    if self.store.workspace_initial_content_policy(workspace_id).await?
      == myoxus_domain::entities::WorkspaceInitialContentPolicy::Empty
    {
      return Ok(0);
    }
    let count = self.store.apply_default_policies_to_new_workspace(workspace_id).await?;
    let reconcile_job_id = if count > 0 {
      Some(self.schedule_workspace_reconcile(workspace_id).await?)
    } else {
      None
    };
    info!(
      target: "myoxus::workspace::create",
      %workspace_id,
      slugs_seeded = count,
      ?reconcile_job_id,
      "workspace seeded with default template policies"
    );
    Ok(count)
  }

  /// Return the per-slug reconcile manifest for a workspace (§5+§6 algorithm).
  ///
  /// Computes `expected_hash` server-side, joins existing instance state, and
  /// returns a structured list for the `workspaceTemplateReconcileSlugs` GQL query.
  #[instrument(skip(self), fields(%workspace_id, locale))]
  pub async fn query_builtin_reconcile_slugs(
    &self,
    workspace_id: WorkspaceId,
    locale: &str,
  ) -> AuthResult<Vec<BuiltinReconcileEntry>> {
    if self.store.workspace_initial_content_policy(workspace_id).await?
      == myoxus_domain::entities::WorkspaceInitialContentPolicy::Empty
    {
      return Ok(Vec::new());
    }
    let entries = self.store.list_builtin_reconcile_entries(workspace_id, locale).await?;
    debug!(
      target: "myoxus::template_registry::reconcile",
      %workspace_id,
      locale,
      slug_count = entries.len(),
      "builtin reconcile manifest computed"
    );
    Ok(entries)
  }

  /// Record that the client successfully completed a missing builtin source.
  ///
  /// Called by `reportTemplateBuilderApplied` GQL mutation.
  #[instrument(skip(self), fields(%workspace_id, slug))]
  pub async fn report_builder_applied(
    &self,
    workspace_id: WorkspaceId,
    slug: &str,
    applied_hash: &str,
    locale: &str,
    doc_id: Option<&str>,
  ) -> AuthResult<()> {
    let entry = self
      .store
      .list_builtin_reconcile_entries(workspace_id, locale)
      .await?
      .into_iter()
      .find(|entry| entry.slug == slug)
      .ok_or_else(|| {
        AuthError::InvalidInput(format!(
          "no active builtin template policy for workspace {workspace_id} and slug {slug}"
        ))
      })?;
    if entry.expected_hash != applied_hash {
      return Err(AuthError::InvalidInput(format!(
        "stale builtin template completion for slug {slug}"
      )));
    }
    self
      .store
      .upsert_builtin_instance_applied(workspace_id, slug, applied_hash, locale, doc_id)
      .await?;
    trace!(
      target: "myoxus::template_registry::reconcile",
      %workspace_id,
      slug,
      applied_hash,
      locale,
      "builder applied reported"
    );
    Ok(())
  }

  /// Compatibility endpoint for deployed clients. Retirement remains a
  /// server-owned lifecycle decision, so the client request is rejected.
  #[instrument(skip(self), fields(%workspace_id, slug))]
  pub async fn report_builder_trashed(&self, workspace_id: WorkspaceId, slug: &str) -> AuthResult<()> {
    Err(AuthError::InvalidInput(format!(
      "client-reported retirement is unsupported for server-owned builtin source {slug} in workspace {workspace_id}"
    )))
  }

  /// Bump `builder_version` for a builtin slug by 1.
  ///
  /// Returns the committed version and targeted workspaces, not guaranteed
  /// deliveries. Notification failures never undo or retry the increment.
  /// See §3.1 + §5 + S-05.
  #[instrument(skip(self))]
  pub async fn bump_builder_version(&self, slug: &str) -> AuthResult<(u32, Vec<WorkspaceId>)> {
    let new_version = self.store.bump_builder_version(slug).await?;
    let affected = self.store.list_workspaces_with_builtin_slug(slug).await?;
    if let Some(port) = &self.builder_notifications {
      for workspace_id in &affected {
        if port.notify(*workspace_id, slug, new_version).await.is_err() {
          warn!(%workspace_id, slug, new_version, "committed builder notification failed");
        }
      }
    }
    info!(
      target: "myoxus::template_registry::admin",
      slug,
      new_version,
      affected_workspaces = affected.len(),
      "builder_version bumped"
    );
    Ok((new_version, affected))
  }

  /// List all default policies (used by admin UI).
  #[instrument(skip(self))]
  pub async fn list_default_policies(&self) -> AuthResult<Vec<TemplateDefaultPolicy>> {
    self.store.list_default_policies().await
  }

  /// Update a default policy (admin UI / CLI).
  #[instrument(skip(self, policy), fields(template_id = %policy.template_id))]
  pub async fn set_default_policy(&self, mut policy: TemplateDefaultPolicy) -> AuthResult<()> {
    let revision = self.store.get_latest_published_revision(policy.template_id).await?;
    if revision.as_ref().is_some_and(revision_is_guide) {
      policy.provisioning_mode = ProvisioningMode::SeedOnce;
    }
    self.store.upsert_default_policy(&policy).await
  }

  /// Update the `apply_to_new_workspaces` flag on a default policy.
  #[instrument(skip(self))]
  pub async fn set_default_policy_apply_flag(
    &self,
    template_id: TemplateCatalogEntryId,
    apply: bool,
  ) -> AuthResult<()> {
    self.store.set_default_policy_apply_flag(template_id, apply).await
  }

  /// Update metadata for a builtin template (category, tags only — content is immutable).
  ///
  /// Enforces §6.4: builtin content (title, description, builder_version) cannot be
  /// changed via the admin API; only `category` and `tags` are writable.
  /// Returns `Err` if the caller attempts to mutate a forbidden field.
  #[instrument(skip(self))]
  pub async fn update_builtin_metadata(
    &self,
    template_id: TemplateCatalogEntryId,
    category: Option<String>,
    tags: Option<Vec<String>>,
    actor: Option<UserId>,
  ) -> AuthResult<TemplateCatalogEntry> {
    let mut entry = self
      .store
      .get_catalog_entry(template_id)
      .await?
      .ok_or_else(|| AuthError::InvalidInput(format!("template not found: {template_id}")))?;

    if entry.source != TemplateSource::Builtin {
      return Err(AuthError::InvalidInput(
        "updateBuiltinTemplateMetadata can only be called on builtin templates".to_string(),
      ));
    }

    if let Some(cat) = category {
      entry.category = Some(cat);
    }
    if let Some(t) = tags {
      entry.tags = t;
    }
    entry.updated_at = Utc::now();

    self.store.update_catalog_entry(&entry).await?;

    // Audit: metadata changed
    let audit_ctx = TemplateAuditContext {
      actor_user_id: actor,
      template_id: Some(entry.id),
      ..TemplateAuditContext::unknown()
    };
    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Updated,
        "template.metadata_changed",
        &audit_ctx,
        "builtin template metadata updated",
        None,
      )
      .await;

    info!(
      target: "myoxus::template_registry::admin",
      template_id = %entry.id,
      slug = %entry.slug,
      "builtin template metadata updated"
    );
    Ok(entry)
  }

  /// Set per-workspace template override (enable/disable, provisioning_mode).
  ///
  /// Called by `setWorkspaceTemplateOverride` GQL mutation (S-07).
  #[instrument(skip(self), fields(%workspace_id, %template_id))]
  pub async fn set_workspace_template_override(
    &self,
    workspace_id: WorkspaceId,
    template_id: TemplateCatalogEntryId,
    is_enabled: bool,
    provisioning_mode: Option<ProvisioningMode>,
    actor: Option<UserId>,
  ) -> AuthResult<()> {
    let policies = self.store.list_policies_for_workspace(workspace_id).await?;
    let mut policy = policies
      .into_iter()
      .find(|p| p.template_id == template_id)
      .ok_or_else(|| {
        AuthError::InvalidInput(format!(
          "no policy for template {template_id} in workspace {workspace_id}"
        ))
      })?;

    policy.is_enabled = is_enabled;
    if let Some(mode) = provisioning_mode {
      let revision = match policy.selected_revision_id {
        Some(id) if policy.selection_mode == SelectionMode::PinnedRevision => self.store.get_revision(id).await?,
        _ => self.store.get_latest_published_revision(template_id).await?,
      };
      policy.provisioning_mode = if revision.as_ref().is_some_and(revision_is_guide) {
        ProvisioningMode::SeedOnce
      } else {
        mode
      };
    }
    policy.updated_at = Utc::now();

    self.store.update_policy(&policy).await?;

    // Audit
    let audit_ctx = TemplateAuditContext {
      actor_user_id: actor,
      template_id: Some(template_id),
      workspace_id: Some(workspace_id),
      policy_id: Some(policy.id),
      ..TemplateAuditContext::unknown()
    };
    self
      .record_audit_event(
        Level::INFO,
        TemplateRegistryAuditAction::Updated,
        "template.workspace_override_applied",
        &audit_ctx,
        "workspace template override applied",
        None,
      )
      .await;

    info!(
      target: "myoxus::template_registry::admin",
      %workspace_id,
      %template_id,
      is_enabled,
      "workspace template override applied"
    );
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::ports::NullBlobStorage;
  use crate::telemetry::TelemetryService;
  use std::collections::HashMap;
  use tokio::sync::Mutex;
  use uuid::Uuid;

  #[derive(Default)]
  struct RecordingTemplateRegistryStore {
    catalog_entries_by_id: Mutex<HashMap<TemplateCatalogEntryId, TemplateCatalogEntry>>,
    catalog_entry_ids_by_slug: Mutex<HashMap<String, TemplateCatalogEntryId>>,
    revisions_by_id: Mutex<HashMap<TemplateRevisionId, TemplateRevision>>,
    policies_by_id: Mutex<HashMap<WorkspaceTemplatePolicyId, WorkspaceTemplatePolicy>>,
    instances_by_id: Mutex<HashMap<WorkspaceTemplateInstanceId, WorkspaceTemplateInstance>>,
    audit_events_by_id: Mutex<HashMap<TemplateRegistryAuditEventId, TemplateRegistryAuditEvent>>,
    import_jobs_by_id: Mutex<HashMap<TemplateImportJobId, TemplateImportJob>>,
    import_job_states: Mutex<Vec<JobState>>,
  }

  impl RecordingTemplateRegistryStore {
    fn not_implemented<T>() -> AuthResult<T> {
      Err(AuthError::InvalidInput("test store method not implemented".to_string()))
    }
  }

  #[async_trait]
  impl TemplateRegistryStore for RecordingTemplateRegistryStore {
    async fn create_catalog_entry(&self, entry: &TemplateCatalogEntry) -> AuthResult<()> {
      self
        .catalog_entry_ids_by_slug
        .lock()
        .await
        .insert(entry.slug.clone(), entry.id);
      self.catalog_entries_by_id.lock().await.insert(entry.id, entry.clone());
      Ok(())
    }

    async fn get_catalog_entry(&self, id: TemplateCatalogEntryId) -> AuthResult<Option<TemplateCatalogEntry>> {
      Ok(self.catalog_entries_by_id.lock().await.get(&id).cloned())
    }

    async fn get_catalog_entry_by_slug(&self, slug: &str) -> AuthResult<Option<TemplateCatalogEntry>> {
      let id = self.catalog_entry_ids_by_slug.lock().await.get(slug).copied();
      Ok(match id {
        Some(id) => self.catalog_entries_by_id.lock().await.get(&id).cloned(),
        None => None,
      })
    }

    async fn list_catalog_entries(
      &self,
      _status_filter: Option<TemplateStatus>,
      _skip: i64,
      _take: i64,
    ) -> AuthResult<Vec<TemplateCatalogEntry>> {
      Ok(self.catalog_entries_by_id.lock().await.values().cloned().collect())
    }

    async fn count_catalog_entries(&self, _status_filter: Option<TemplateStatus>) -> AuthResult<i64> {
      Ok(self.catalog_entries_by_id.lock().await.len() as i64)
    }

    async fn commit_catalog_transition(
      &self,
      id: TemplateCatalogEntryId,
      status: TemplateStatus,
      allow_already_active: bool,
    ) -> AuthResult<TemplateCatalogEntry> {
      let mut entries = self.catalog_entries_by_id.lock().await;
      let entry = entries.get_mut(&id).ok_or(AuthError::NotFound("template".into()))?;
      let mut next = entry.clone();
      apply_catalog_transition(&mut next, status, allow_already_active, Utc::now())?;
      if status == TemplateStatus::Archived {
        for policy in self
          .policies_by_id
          .lock()
          .await
          .values_mut()
          .filter(|p| p.template_id == id && p.is_enabled)
        {
          policy.is_enabled = false;
          policy.updated_at = next.updated_at;
        }
      }
      *entry = next;
      Ok(entry.clone())
    }

    async fn update_catalog_entry(&self, entry: &TemplateCatalogEntry) -> AuthResult<()> {
      self.catalog_entries_by_id.lock().await.insert(entry.id, entry.clone());
      self
        .catalog_entry_ids_by_slug
        .lock()
        .await
        .insert(entry.slug.clone(), entry.id);
      Ok(())
    }

    async fn create_audit_event(&self, event: &TemplateRegistryAuditEvent) -> AuthResult<()> {
      self.audit_events_by_id.lock().await.insert(event.id, event.clone());
      Ok(())
    }

    async fn list_audit_events(
      &self,
      filter: Option<TemplateRegistryAuditEventFilter>,
      skip: i64,
      take: i64,
    ) -> AuthResult<Vec<TemplateRegistryAuditEvent>> {
      let mut events: Vec<TemplateRegistryAuditEvent> =
        self.audit_events_by_id.lock().await.values().cloned().collect();
      if let Some(filter) = filter {
        events.retain(|event| {
          filter.action.is_none_or(|action| event.action == action)
            && filter.event_type.as_ref().is_none_or(|v| event.event_type == *v)
            && filter.actor_user_id.is_none_or(|v| event.actor_user_id == Some(v))
            && filter.template_id.is_none_or(|v| event.template_id == Some(v))
            && filter.revision_id.is_none_or(|v| event.revision_id == Some(v))
            && filter.workspace_id.is_none_or(|v| event.workspace_id == Some(v))
            && filter.policy_id.is_none_or(|v| event.policy_id == Some(v))
            && filter.instance_id.is_none_or(|v| event.instance_id == Some(v))
            && filter.import_job_id.is_none_or(|v| event.import_job_id == Some(v))
            && filter
              .source_format
              .as_ref()
              .is_none_or(|v| event.source_format.as_ref() == Some(v))
            && filter
              .detected_format
              .as_ref()
              .is_none_or(|v| event.detected_format.as_ref() == Some(v))
            && filter
              .normalizer_version
              .as_ref()
              .is_none_or(|v| event.normalizer_version.as_ref() == Some(v))
            && filter
              .ignored_entries_count
              .is_none_or(|v| event.ignored_entries_count == Some(v))
            && filter
              .error_catalog_version
              .as_ref()
              .is_none_or(|v| event.error_catalog_version.as_ref() == Some(v))
            && filter
              .error_code
              .as_ref()
              .is_none_or(|v| event.error_code.as_ref() == Some(v))
            && filter.created_after.is_none_or(|v| event.created_at >= v)
            && filter.created_before.is_none_or(|v| event.created_at <= v)
        });
      }

      events.sort_by_key(|event| std::cmp::Reverse((event.created_at, event.id)));
      let skip = skip.max(0) as usize;
      let take = take.clamp(1, 200) as usize;
      Ok(events.into_iter().skip(skip).take(take).collect())
    }

    async fn create_revision(&self, revision: &TemplateRevision) -> AuthResult<()> {
      self.revisions_by_id.lock().await.insert(revision.id, revision.clone());
      Ok(())
    }

    async fn get_revision(&self, id: TemplateRevisionId) -> AuthResult<Option<TemplateRevision>> {
      Ok(self.revisions_by_id.lock().await.get(&id).cloned())
    }

    async fn list_revisions(
      &self,
      template_id: TemplateCatalogEntryId,
      _skip: i64,
      _take: i64,
    ) -> AuthResult<Vec<TemplateRevision>> {
      Ok(
        self
          .revisions_by_id
          .lock()
          .await
          .values()
          .filter(|revision| revision.template_id == template_id)
          .cloned()
          .collect(),
      )
    }

    async fn get_latest_published_revision(
      &self,
      template_id: TemplateCatalogEntryId,
    ) -> AuthResult<Option<TemplateRevision>> {
      Ok(
        self
          .revisions_by_id
          .lock()
          .await
          .values()
          .filter(|revision| revision.template_id == template_id && revision.state == RevisionState::Published)
          .max_by_key(|revision| revision.created_at)
          .cloned(),
      )
    }

    async fn commit_revision_publication(&self, id: TemplateRevisionId) -> AuthResult<TemplateRevision> {
      let mut revisions = self.revisions_by_id.lock().await;
      let mut revision = revisions
        .get(&id)
        .cloned()
        .ok_or_else(|| AuthError::NotFound("revision".into()))?;
      revision
        .publish()
        .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
      for previous in revisions.values_mut() {
        if previous.template_id == revision.template_id && previous.state == RevisionState::Published {
          previous
            .deprecate()
            .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
        }
      }
      revisions.insert(id, revision.clone());
      Ok(revision)
    }

    async fn update_revision(&self, revision: &TemplateRevision) -> AuthResult<()> {
      let mut revisions = self.revisions_by_id.lock().await;
      if revision.state == RevisionState::Validated
        && revisions
          .get(&revision.id)
          .is_none_or(|current| current.state != RevisionState::Draft)
      {
        return Err(AuthError::InvalidInput(
          "template revision changed before update".to_string(),
        ));
      }
      revisions.insert(revision.id, revision.clone());
      Ok(())
    }

    async fn create_policy(&self, _policy: &WorkspaceTemplatePolicy) -> AuthResult<()> {
      self.policies_by_id.lock().await.insert(_policy.id, _policy.clone());
      Ok(())
    }

    async fn create_policy_for_explicit_assignment(
      &self,
      policy: &WorkspaceTemplatePolicy,
      revision_id: Option<TemplateRevisionId>,
    ) -> AuthResult<()> {
      let mut instances = self.instances_by_id.lock().await;
      if let Some(instance) = instances
        .values_mut()
        .find(|instance| instance.workspace_id == policy.workspace_id && instance.template_id == policy.template_id)
      {
        if instance.state != InstanceState::Retired {
          return Err(AuthError::InvalidInput(
            "Template is already assigned to this workspace".to_string(),
          ));
        }
        if let Some(revision_id) = revision_id {
          instance.revision_id = revision_id;
        }
        instance.workspace_doc_id = None;
        instance.workspace_doc_key = None;
        instance.state = InstanceState::Ok;
        instance.retired_at = None;
      }
      drop(instances);
      self.create_policy(policy).await
    }

    async fn get_policy(&self, id: WorkspaceTemplatePolicyId) -> AuthResult<Option<WorkspaceTemplatePolicy>> {
      Ok(self.policies_by_id.lock().await.get(&id).cloned())
    }

    async fn list_policies_for_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<Vec<WorkspaceTemplatePolicy>> {
      Ok(
        self
          .policies_by_id
          .lock()
          .await
          .values()
          .filter(|policy| policy.workspace_id == workspace_id)
          .cloned()
          .collect(),
      )
    }

    async fn list_policies_for_template(
      &self,
      template_id: TemplateCatalogEntryId,
    ) -> AuthResult<Vec<WorkspaceTemplatePolicy>> {
      Ok(
        self
          .policies_by_id
          .lock()
          .await
          .values()
          .filter(|policy| policy.template_id == template_id)
          .cloned()
          .collect(),
      )
    }

    async fn update_policy(&self, policy: &WorkspaceTemplatePolicy) -> AuthResult<()> {
      self.policies_by_id.lock().await.insert(policy.id, policy.clone());
      Ok(())
    }

    async fn delete_policy(&self, id: WorkspaceTemplatePolicyId) -> AuthResult<()> {
      self.policies_by_id.lock().await.remove(&id);
      Ok(())
    }

    async fn create_instance(&self, instance: &WorkspaceTemplateInstance) -> AuthResult<()> {
      self.instances_by_id.lock().await.insert(instance.id, instance.clone());
      Ok(())
    }

    async fn get_instance(&self, id: WorkspaceTemplateInstanceId) -> AuthResult<Option<WorkspaceTemplateInstance>> {
      Ok(self.instances_by_id.lock().await.get(&id).cloned())
    }

    async fn list_instances_for_workspace(
      &self,
      workspace_id: WorkspaceId,
    ) -> AuthResult<Vec<WorkspaceTemplateInstance>> {
      Ok(
        self
          .instances_by_id
          .lock()
          .await
          .values()
          .filter(|instance| instance.workspace_id == workspace_id)
          .cloned()
          .collect(),
      )
    }

    async fn list_instances_for_template(
      &self,
      template_id: TemplateCatalogEntryId,
    ) -> AuthResult<Vec<WorkspaceTemplateInstance>> {
      Ok(
        self
          .instances_by_id
          .lock()
          .await
          .values()
          .filter(|instance| instance.template_id == template_id)
          .cloned()
          .collect(),
      )
    }

    async fn find_instance(
      &self,
      workspace_id: WorkspaceId,
      template_id: TemplateCatalogEntryId,
    ) -> AuthResult<Option<WorkspaceTemplateInstance>> {
      Ok(
        self
          .instances_by_id
          .lock()
          .await
          .values()
          .find(|instance| instance.workspace_id == workspace_id && instance.template_id == template_id)
          .cloned(),
      )
    }

    async fn update_instance(&self, instance: &WorkspaceTemplateInstance) -> AuthResult<()> {
      self.instances_by_id.lock().await.insert(instance.id, instance.clone());
      Ok(())
    }

    async fn begin_central_source_retirement(
      &self,
      workspace_id: WorkspaceId,
      template_id: TemplateCatalogEntryId,
    ) -> AuthResult<Option<RetiringTemplateSource>> {
      let source = self
        .catalog_entries_by_id
        .lock()
        .await
        .get(&template_id)
        .map(|entry| entry.source)
        .ok_or_else(|| AuthError::NotFound("template catalog entry".to_string()))?;
      let mut instances = self.instances_by_id.lock().await;
      let Some(instance) = instances
        .values_mut()
        .find(|instance| instance.workspace_id == workspace_id && instance.template_id == template_id)
      else {
        return Ok(None);
      };
      instance.retire();
      Ok(Some(RetiringTemplateSource {
        instance_id: instance.id,
        source,
        workspace_doc_id: instance.workspace_doc_id,
        workspace_doc_key: instance.workspace_doc_key.clone(),
      }))
    }

    async fn complete_central_source_retirement(
      &self,
      workspace_id: WorkspaceId,
      template_id: TemplateCatalogEntryId,
    ) -> AuthResult<()> {
      if let Some(instance) = self
        .instances_by_id
        .lock()
        .await
        .values_mut()
        .find(|instance| instance.workspace_id == workspace_id && instance.template_id == template_id)
      {
        instance.workspace_doc_id = None;
        instance.workspace_doc_key = None;
      }
      Ok(())
    }

    async fn create_import_job(&self, job: &TemplateImportJob) -> AuthResult<()> {
      self.import_job_states.lock().await.push(job.state);
      self.import_jobs_by_id.lock().await.insert(job.id, job.clone());
      Ok(())
    }

    async fn get_import_job(&self, id: TemplateImportJobId) -> AuthResult<Option<TemplateImportJob>> {
      Ok(self.import_jobs_by_id.lock().await.get(&id).cloned())
    }

    async fn update_import_job(&self, job: &TemplateImportJob) -> AuthResult<()> {
      self.import_job_states.lock().await.push(job.state);
      self.import_jobs_by_id.lock().await.insert(job.id, job.clone());
      Ok(())
    }

    async fn list_import_jobs(&self, _skip: i64, _take: i64) -> AuthResult<Vec<TemplateImportJob>> {
      Ok(self.import_jobs_by_id.lock().await.values().cloned().collect())
    }

    async fn pending_release_default_ids(&self, _workspace: WorkspaceId) -> AuthResult<Vec<TemplateCatalogEntryId>> {
      Ok(Vec::new())
    }

    async fn withdrawn_release_policy_ids(
      &self,
      _workspace: WorkspaceId,
    ) -> AuthResult<Vec<WorkspaceTemplatePolicyId>> {
      Ok(Vec::new())
    }

    async fn create_reconcile_job(&self, _job: &TemplateReconcileJob) -> AuthResult<()> {
      Self::not_implemented()
    }

    async fn get_reconcile_job(&self, _id: TemplateReconcileJobId) -> AuthResult<Option<TemplateReconcileJob>> {
      Self::not_implemented()
    }

    async fn update_reconcile_job(&self, _job: &TemplateReconcileJob) -> AuthResult<()> {
      Self::not_implemented()
    }

    async fn list_reconcile_jobs(&self, _skip: i64, _take: i64) -> AuthResult<Vec<TemplateReconcileJob>> {
      Self::not_implemented()
    }

    async fn list_distinct_policy_workspace_ids(&self) -> AuthResult<Vec<WorkspaceId>> {
      Self::not_implemented()
    }

    async fn list_distinct_instance_workspace_ids(&self) -> AuthResult<Vec<WorkspaceId>> {
      Self::not_implemented()
    }

    // ── Builtin Bridge stubs (not used by existing tests) ────────────────────

    async fn list_default_policies(&self) -> AuthResult<Vec<TemplateDefaultPolicy>> {
      Ok(vec![])
    }

    async fn upsert_default_policy(&self, _policy: &TemplateDefaultPolicy) -> AuthResult<()> {
      Self::not_implemented()
    }

    async fn set_default_policy_apply_flag(
      &self,
      _template_id: TemplateCatalogEntryId,
      _apply: bool,
    ) -> AuthResult<()> {
      Self::not_implemented()
    }

    async fn workspace_initial_content_policy(
      &self,
      _workspace_id: WorkspaceId,
    ) -> AuthResult<myoxus_domain::entities::WorkspaceInitialContentPolicy> {
      Ok(myoxus_domain::entities::WorkspaceInitialContentPolicy::LegacyDefaults)
    }

    async fn apply_default_policies_to_new_workspace(&self, _workspace_id: WorkspaceId) -> AuthResult<usize> {
      Ok(0)
    }

    async fn bump_builder_version(&self, _slug: &str) -> AuthResult<u32> {
      Self::not_implemented()
    }

    async fn list_workspaces_with_builtin_slug(&self, _slug: &str) -> AuthResult<Vec<WorkspaceId>> {
      Ok(vec![])
    }

    async fn list_builtin_reconcile_entries(
      &self,
      _workspace_id: WorkspaceId,
      _locale: &str,
    ) -> AuthResult<Vec<BuiltinReconcileEntry>> {
      Ok(vec![])
    }

    async fn upsert_builtin_instance_applied(
      &self,
      _workspace_id: WorkspaceId,
      _slug: &str,
      _applied_hash: &str,
      _locale: &str,
      _doc_id: Option<&str>,
    ) -> AuthResult<()> {
      Self::not_implemented()
    }

    async fn attribute_materialized_document(
      &self,
      _doc_id: DocId,
      _actor_id: UserId,
      _locale: &str,
      _purpose: crate::template_registry::bundle::TemplatePurpose,
    ) -> AuthResult<()> {
      Ok(())
    }

    async fn retire_builtin_instance(&self, _workspace_id: WorkspaceId, _slug: &str) -> AuthResult<()> {
      Self::not_implemented()
    }
  }

  fn test_manifest(template_id: &str) -> bundle::Manifest {
    bundle::Manifest {
      template_id: template_id.to_string(),
      version: "1.0.0".to_string(),
      title: "Weekly Standup".to_string(),
      description: Some("A template for weekly standups".to_string()),
      category: Some("meeting-notes".to_string()),
      tags: vec!["meetings".to_string(), "agile".to_string()],
      locale: Some("en".to_string()),
      kind: Some("page".to_string()),
      min_server_version: None,
      checksum: None,
      localized_contents: std::collections::BTreeMap::new(),
      title_policy: None,
      purpose: None,
    }
  }

  fn upstream_snapshot_zip() -> Vec<u8> {
    let mut buf = Vec::new();
    {
      let cursor = std::io::Cursor::new(&mut buf);
      let mut writer = zip::ZipWriter::new(cursor);
      let options = zip::write::FileOptions::<()>::default();
      writer.start_file("workspace/page:home.snapshot.json", options).unwrap();
      std::io::Write::write_all(
        &mut writer,
        br#"{"meta":{"id":"page:home","title":"Portable template"},"blocks":{"type":"block","id":"page","flavour":"affine:page","props":{},"children":[]}}"#,
      )
      .unwrap();
      writer.finish().unwrap();
    }
    buf
  }

  fn valid_template_content() -> Vec<u8> {
    crate::markdown::markdown_to_yjs("Template", "Validated template content").expect("valid native template content")
  }

  fn valid_template_bundle(slug: &str) -> Vec<u8> {
    let manifest = bundle::Manifest {
      template_id: slug.to_string(),
      version: "1.0.0".to_string(),
      title: "Test Template".to_string(),
      description: Some("A template for audit contract tests".to_string()),
      category: Some("test".to_string()),
      tags: vec!["audit".to_string()],
      locale: None,
      kind: None,
      min_server_version: None,
      checksum: None,
      localized_contents: std::collections::BTreeMap::new(),
      title_policy: None,
      purpose: None,
    };
    bundle::create_export_bundle(
      &manifest,
      &valid_template_content(),
      None,
      &std::collections::BTreeMap::new(),
    )
    .expect("test bundle should be exportable")
  }

  async fn seed_published_template(
    service: &TemplateRegistryService,
    user_id: Uuid,
    slug: &str,
  ) -> (TemplateCatalogEntry, TemplateRevision) {
    let bundle = valid_template_bundle(slug);
    let outcome = service
      .import_from_bundle_with_filename_detailed(&bundle, "audit-contract.template.zip", user_id)
      .await
      .expect("template import should succeed");
    assert!(
      outcome.warnings.is_empty(),
      "seed bundle should import without warnings"
    );

    let revision = service
      .publish_revision(outcome.revision.id)
      .await
      .expect("template publish should succeed");
    (outcome.entry, revision)
  }

  async fn recorded_audit_event(
    store: &Arc<RecordingTemplateRegistryStore>,
    event_type: &str,
  ) -> TemplateRegistryAuditEvent {
    store
      .audit_events_by_id
      .lock()
      .await
      .values()
      .find(|event| event.event_type == event_type)
      .cloned()
      .unwrap_or_else(|| panic!("expected audit event {event_type}"))
  }

  fn invalid_upstream_snapshot_zip_missing_blocks() -> Vec<u8> {
    let mut buf = Vec::new();
    {
      let cursor = std::io::Cursor::new(&mut buf);
      let mut writer = zip::ZipWriter::new(cursor);
      let options = zip::write::FileOptions::<()>::default();
      writer.start_file("workspace/page:home.snapshot.json", options).unwrap();
      std::io::Write::write_all(&mut writer, br#"{"meta":{"id":"page:home"}}"#).unwrap();
      writer.finish().unwrap();
    }
    buf
  }

  fn redact_validation_report_for_snapshot(mut report: Value) -> Value {
    let Some(obj) = report.as_object_mut() else {
      return report;
    };

    if obj.contains_key("started_at") {
      obj.insert("started_at".to_string(), Value::String("<ts>".to_string()));
    }
    if obj.get("finished_at").map(|value| !value.is_null()).unwrap_or(false) {
      obj.insert("finished_at".to_string(), Value::String("<ts>".to_string()));
    }

    if let Some(stages) = obj.get_mut("stages").and_then(Value::as_array_mut) {
      for stage in stages {
        if let Some(stage_obj) = stage.as_object_mut() {
          stage_obj.insert("duration_ms".to_string(), Value::Number(0.into()));
        }
      }
    }

    if let Some(error_obj) = obj.get_mut("error").and_then(Value::as_object_mut)
      && error_obj.contains_key("message")
    {
      error_obj.insert("message".to_string(), Value::String("<msg>".to_string()));
    }

    report
  }

  fn telemetry_event_count(telemetry: &TelemetryService, event_name: &str) -> u64 {
    telemetry
      .events_by_name()
      .into_iter()
      .find(|(name, _)| name == event_name)
      .map(|(_, count)| count)
      .unwrap_or(0)
  }

  #[tokio::test]
  async fn client_report_cannot_retire_a_server_owned_builtin_binding() {
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store);

    let error = service
      .report_builder_trashed(Uuid::new_v4(), "meeting-notes")
      .await
      .expect_err("client lifecycle state must not retire a Registry binding");

    assert!(matches!(error, AuthError::InvalidInput(_)));
  }

  #[tokio::test]
  async fn import_from_bundle_creates_and_completes_import_job() {
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store.clone());
    let manifest = test_manifest("weekly-standup");
    let bundle = bundle::create_export_bundle(
      &manifest,
      &valid_template_content(),
      None,
      &std::collections::BTreeMap::new(),
    )
    .unwrap();
    let user_id = Uuid::new_v4();

    let outcome = service
      .import_from_bundle_with_filename_detailed(&bundle, "weekly-standup.zip", user_id)
      .await
      .unwrap();

    assert_eq!(outcome.entry.slug, "weekly-standup");
    assert_eq!(outcome.revision.state, RevisionState::Validated);

    let job_states = store.import_job_states.lock().await.clone();
    assert_eq!(
      job_states,
      vec![JobState::Pending, JobState::Running, JobState::Completed]
    );

    let job = store
      .import_jobs_by_id
      .lock()
      .await
      .values()
      .next()
      .cloned()
      .expect("import job should exist");
    assert_eq!(job.state, JobState::Completed);
    assert_eq!(job.result_revision_id, Some(outcome.revision.id));
    let report = job.validation_report.expect("job report");
    assert_eq!(report["status"], "completed");
    assert_eq!(report["error_catalog_version"], TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION);
    assert_eq!(
      report["result_revision_id"],
      Value::String(outcome.revision.id.to_string())
    );
    let stage_names: Vec<String> = report["stages"]
      .as_array()
      .expect("stages array")
      .iter()
      .map(|stage| stage["name"].as_str().unwrap().to_string())
      .collect();
    assert_eq!(
      stage_names,
      vec!["detect", "unpack", "normalize", "validate", "persist"]
    );
    assert_eq!(report["warnings"].as_array().unwrap().len(), 0);
  }

  #[tokio::test]
  async fn import_from_bundle_records_failed_job_report_on_validation_error() {
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store.clone());
    let manifest = test_manifest("");
    let bundle = bundle::create_export_bundle(
      &manifest,
      &valid_template_content(),
      None,
      &std::collections::BTreeMap::new(),
    )
    .unwrap();
    let user_id = Uuid::new_v4();

    let err = service
      .import_from_bundle_with_filename_detailed(&bundle, "broken.zip", user_id)
      .await
      .unwrap_err();
    assert!(matches!(err, AuthError::InvalidInput(_)));

    let job_states = store.import_job_states.lock().await.clone();
    assert_eq!(job_states, vec![JobState::Pending, JobState::Running, JobState::Failed]);

    let job = store
      .import_jobs_by_id
      .lock()
      .await
      .values()
      .next()
      .cloned()
      .expect("import job should exist");
    assert_eq!(job.state, JobState::Failed);
    assert!(job.result_revision_id.is_none());

    let report = job.validation_report.expect("job report");
    assert_eq!(report["status"], "failed");
    assert_eq!(report["failed_stage"], "validate");
    assert_eq!(report["error"]["code"], "MISSING_FIELD");
    assert_eq!(report["error"]["path"], "/manifest/template_id");
    let stage_names: Vec<String> = report["stages"]
      .as_array()
      .expect("stages array")
      .iter()
      .map(|stage| stage["name"].as_str().unwrap().to_string())
      .collect();
    assert_eq!(stage_names, vec!["detect", "unpack", "normalize", "validate"]);
    assert_eq!(report["validation_errors"].as_array().unwrap().len(), 1);
  }

  #[tokio::test]
  async fn import_from_bundle_records_failed_job_report_on_parse_error() {
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store.clone());
    let user_id = Uuid::new_v4();
    let bundle = b"this is not a zip archive";

    let err = service
      .import_from_bundle_with_filename_detailed(bundle, "broken.zip", user_id)
      .await
      .unwrap_err();
    assert!(matches!(err, AuthError::InvalidInput(_)));

    let job_states = store.import_job_states.lock().await.clone();
    assert_eq!(job_states, vec![JobState::Pending, JobState::Running, JobState::Failed]);

    let job = store
      .import_jobs_by_id
      .lock()
      .await
      .values()
      .next()
      .cloned()
      .expect("import job should exist");
    assert_eq!(job.state, JobState::Failed);
    assert!(job.result_revision_id.is_none());

    let report = job.validation_report.expect("job report");
    assert_eq!(report["status"], "failed");
    assert_eq!(report["failed_stage"], "detect");
    assert_eq!(report["detected_format"], Value::Null);
    assert_eq!(report["normalized"], Value::Null);
    assert_eq!(report["ignored_entries_count"], Value::Null);
    assert_eq!(report["error"]["code"], "ZIP_INVALID");
    assert!(
      report["error"]["message"]
        .as_str()
        .unwrap()
        .contains("invalid ZIP archive")
    );
    let stage_names: Vec<String> = report["stages"]
      .as_array()
      .expect("stages array")
      .iter()
      .map(|stage| stage["name"].as_str().unwrap().to_string())
      .collect();
    assert_eq!(stage_names, vec!["detect"]);
    assert!(report["validation_errors"].as_array().unwrap().is_empty());
  }

  #[tokio::test]
  async fn import_from_bundle_parse_error_report_snapshot() {
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store.clone());
    let user_id = Uuid::new_v4();

    let err = service
      .import_from_bundle_with_filename_detailed(b"this is not a zip archive", "broken.zip", user_id)
      .await
      .unwrap_err();
    assert!(matches!(err, AuthError::InvalidInput(_)));

    let job = store
      .import_jobs_by_id
      .lock()
      .await
      .values()
      .next()
      .cloned()
      .expect("import job should exist");
    let report = job.validation_report.expect("job report");
    let snapshot = redact_validation_report_for_snapshot(report);

    assert_eq!(
      snapshot,
      serde_json::json!({
        "error_catalog_version": TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION,
        "status": "failed",
        "started_at": "<ts>",
        "finished_at": "<ts>",
        "detected_format": Value::Null,
        "normalized": Value::Null,
        "ignored_entries_count": Value::Null,
        "result_revision_id": Value::Null,
        "stages": [
          { "name": "detect", "duration_ms": 0 }
        ],
        "warnings": [],
        "validation_errors": [],
        "error": {
          "code": "ZIP_INVALID",
          "message": "<msg>",
          "operation": "import",
          "path": Value::Null,
          "stage": "detect"
        },
        "failed_stage": "detect"
      })
    );
  }

  #[tokio::test]
  async fn import_from_bundle_records_pointer_for_snapshot_parse_error() {
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store.clone());
    let user_id = Uuid::new_v4();
    let bundle = invalid_upstream_snapshot_zip_missing_blocks();

    let err = service
      .import_from_bundle_with_filename_detailed(&bundle, "broken-upstream.zip", user_id)
      .await
      .unwrap_err();
    assert!(matches!(err, AuthError::InvalidInput(_)));

    let job = store
      .import_jobs_by_id
      .lock()
      .await
      .values()
      .next()
      .cloned()
      .expect("import job should exist");
    let report = job.validation_report.expect("job report");
    assert_eq!(report["status"], "failed");
    assert_eq!(report["failed_stage"], "detect");
    assert_eq!(report["error"]["code"], "SNAPSHOT_BLOCKS_MISSING");
    assert_eq!(report["error"]["path"], "/snapshots/0/blocks");
  }

  #[tokio::test]
  async fn import_from_bundle_persists_format_metadata_for_canonical_input() {
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store.clone());
    let manifest = test_manifest("canonical-template");
    let bundle = bundle::create_export_bundle(
      &manifest,
      &valid_template_content(),
      None,
      &std::collections::BTreeMap::new(),
    )
    .unwrap();
    let user_id = Uuid::new_v4();

    let outcome = service
      .import_from_bundle_with_filename_detailed(&bundle, "canonical.template.zip", user_id)
      .await
      .unwrap();
    assert_eq!(outcome.detected_format, bundle::BundleFormat::TemplateBundle);
    assert!(!outcome.normalized);

    let revision = store
      .revisions_by_id
      .lock()
      .await
      .get(&outcome.revision.id)
      .cloned()
      .expect("revision should be stored");
    assert_eq!(revision.source_format, bundle::BundleFormat::TemplateBundle.as_str());
    assert_eq!(revision.detected_format, bundle::BundleFormat::TemplateBundle.as_str());
    assert_eq!(revision.normalizer_version, "none");
    assert_eq!(revision.ignored_entries_count, 0);
    assert_eq!(revision.error_catalog_version, TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION);
    assert_eq!(
      revision.release_notes.as_deref(),
      Some("A template for weekly standups"),
      "release notes should default to manifest description when explicit release_notes are absent"
    );
    assert!(
      revision.normalization_warnings.is_empty(),
      "canonical bundles should not persist normalization warnings for valid manifests"
    );

    // An older ZIP encoder can produce different archive bytes for precisely
    // this payload. Preserve its stored locator while checking all members.
    let mut writer = zip::ZipWriter::new_append(std::io::Cursor::new(bundle.clone())).unwrap();
    writer.set_comment("previous encoder").unwrap();
    let stored_bytes = writer.finish().unwrap().into_inner();
    let stored_hash = compute_content_hash(&stored_bytes);
    let stored = bundle::parse_bundle(&stored_bytes).unwrap();
    let mut incoming = bundle::parse_bundle(&bundle).unwrap();
    let mut revision = revision;
    revision.bundle_blob_id = Some(format!(
      "template-registry/bundles/{}/{}/{}.zip",
      stored.manifest.template_id, stored.manifest.version, stored_hash
    ));
    assert!(ensure_same_revision_content(&revision, &incoming, &compute_content_hash(&bundle)).is_err());
    ensure_same_stored_revision_content(&revision, &incoming, &stored, &stored_hash).unwrap();
    assert!(ensure_same_stored_revision_content(&revision, &incoming, &stored, "changed archive").is_err());
    incoming.preview_bytes = Some(b"changed preview".to_vec());
    assert!(ensure_same_stored_revision_content(&revision, &incoming, &stored, &stored_hash).is_err());
    incoming.preview_bytes = None;
    incoming
      .localized_contents
      .insert("de".into(), b"changed locale".to_vec());
    assert!(ensure_same_stored_revision_content(&revision, &incoming, &stored, &stored_hash).is_err());
  }

  #[tokio::test]
  async fn import_from_bundle_persists_format_metadata_for_normalized_input() {
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store.clone());
    let bundle = upstream_snapshot_zip();
    let user_id = Uuid::new_v4();

    let outcome = service
      .import_from_bundle_with_filename_detailed(&bundle, "meeting.affine.zip", user_id)
      .await
      .unwrap();
    assert_eq!(outcome.detected_format, bundle::BundleFormat::UpstreamSnapshotZip);
    assert!(outcome.normalized);

    let revision = store
      .revisions_by_id
      .lock()
      .await
      .get(&outcome.revision.id)
      .cloned()
      .expect("revision should be stored");
    assert_eq!(
      revision.source_format,
      bundle::BundleFormat::UpstreamSnapshotZip.as_str()
    );
    assert_eq!(revision.detected_format, bundle::BundleFormat::TemplateBundle.as_str());
    assert_eq!(revision.normalizer_version, TEMPLATE_REGISTRY_NORMALIZER_VERSION);
    assert_eq!(revision.ignored_entries_count, 0);
    assert_eq!(revision.error_catalog_version, TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION);
    assert_eq!(
      revision.release_notes.as_deref(),
      Some("Auto-imported template"),
      "raw workspace imports should derive release notes from normalized manifest description"
    );
    assert_eq!(revision.normalization_warnings.len(), 2);
    assert!(
      revision.normalization_warnings.iter().any(
        |warning| warning.code == "MISSING_OPTIONAL_FIELD" && warning.path.as_deref() == Some("/manifest/category")
      )
    );
    assert!(
      revision
        .normalization_warnings
        .iter()
        .any(|warning| warning.code == "EMPTY_TAGS" && warning.path.as_deref() == Some("/manifest/tags"))
    );
  }

  #[tokio::test]
  async fn import_from_bundle_records_format_normalized_audit_event_for_normalized_input() {
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store.clone());
    let bundle = upstream_snapshot_zip();
    let user_id = Uuid::new_v4();

    let outcome = service
      .import_from_bundle_with_filename_detailed(&bundle, "meeting.affine.zip", user_id)
      .await
      .unwrap();

    let job = store
      .import_jobs_by_id
      .lock()
      .await
      .values()
      .next()
      .cloned()
      .expect("import job should exist");
    let job_id_string = job.id.to_string();
    let revision_id_string = outcome.revision.id.to_string();
    let event = recorded_audit_event(&store, TEMPLATE_IMPORT_FORMAT_NORMALIZED_EVENT).await;

    assert_eq!(event.action, TemplateRegistryAuditAction::Imported);
    assert_eq!(event.actor_user_id, Some(user_id));
    assert_eq!(event.import_job_id, Some(job.id));
    assert_eq!(event.template_id, Some(outcome.entry.id));
    assert_eq!(event.revision_id, Some(outcome.revision.id));
    assert_eq!(
      event.source_format.as_deref(),
      Some(bundle::BundleFormat::UpstreamSnapshotZip.as_str())
    );
    assert_eq!(
      event.detected_format.as_deref(),
      Some(bundle::BundleFormat::TemplateBundle.as_str())
    );
    assert_eq!(
      event.normalizer_version.as_deref(),
      Some(TEMPLATE_REGISTRY_NORMALIZER_VERSION)
    );
    assert_eq!(event.ignored_entries_count, Some(0));
    assert_eq!(
      event.error_catalog_version.as_deref(),
      Some(TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION)
    );
    assert_eq!(event.error_code.as_deref(), Some(TEMPLATE_AUDIT_ERROR_CODE_NONE));
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("job_id"))
        .and_then(serde_json::Value::as_str),
      Some(job_id_string.as_str())
    );
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("revision_id"))
        .and_then(serde_json::Value::as_str),
      Some(revision_id_string.as_str())
    );
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("normalized"))
        .and_then(serde_json::Value::as_bool),
      Some(true)
    );
  }

  #[tokio::test]
  async fn import_from_bundle_records_format_rejected_audit_event_for_unsupported_template_json() {
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store.clone());
    let user_id = Uuid::new_v4();
    let unsupported_template_json = serde_json::json!({
      "name": "contract-template",
      "type": "template",
      "content": {"blocks": []}
    })
    .to_string()
    .into_bytes();

    let err = service
      .import_from_bundle_with_filename_detailed(&unsupported_template_json, "unsupported-template.json", user_id)
      .await
      .unwrap_err();
    assert!(matches!(err, AuthError::InvalidInput(_)));

    let job = store
      .import_jobs_by_id
      .lock()
      .await
      .values()
      .next()
      .cloned()
      .expect("import job should exist");
    let event = recorded_audit_event(&store, TEMPLATE_IMPORT_FORMAT_REJECTED_EVENT).await;

    assert_eq!(event.action, TemplateRegistryAuditAction::Failed);
    assert_eq!(event.actor_user_id, Some(user_id));
    assert_eq!(event.import_job_id, Some(job.id));
    assert_eq!(event.template_id, None);
    assert_eq!(event.revision_id, None);
    assert_eq!(event.source_format.as_deref(), Some(TEMPLATE_AUDIT_UNKNOWN_VALUE));
    assert_eq!(event.detected_format.as_deref(), Some(TEMPLATE_AUDIT_UNKNOWN_VALUE));
    assert_eq!(event.normalizer_version.as_deref(), Some(TEMPLATE_AUDIT_UNKNOWN_VALUE));
    assert_eq!(event.ignored_entries_count, Some(0));
    assert_eq!(
      event.error_catalog_version.as_deref(),
      Some(TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION)
    );
    assert_eq!(event.error_code.as_deref(), Some("UNSUPPORTED_TEMPLATE_JSON"));
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("filename"))
        .and_then(serde_json::Value::as_str),
      Some("unsupported-template.json")
    );
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("stage"))
        .and_then(serde_json::Value::as_str),
      Some("detect")
    );
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("error_code"))
        .and_then(serde_json::Value::as_str),
      Some("UNSUPPORTED_TEMPLATE_JSON")
    );
  }

  #[tokio::test]
  async fn telemetry_metrics_cover_import_and_reconcile_outcomes() {
    let telemetry = Arc::new(TelemetryService::in_memory_stub());
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store.clone()).with_telemetry(telemetry.clone());
    let user_id = Uuid::new_v4();

    let canonical_bundle = bundle::create_export_bundle(
      &test_manifest("metric-canonical"),
      &valid_template_content(),
      None,
      &std::collections::BTreeMap::new(),
    )
    .expect("canonical bundle");
    let normalized_bundle = upstream_snapshot_zip();
    let rejected_bundle = invalid_upstream_snapshot_zip_missing_blocks();

    let canonical_outcome = service
      .import_from_bundle_with_filename_detailed(&canonical_bundle, "metric-canonical.zip", user_id)
      .await
      .expect("canonical import should succeed");
    assert!(!canonical_outcome.normalized);

    let normalized_outcome = service
      .import_from_bundle_with_filename_detailed(&normalized_bundle, "metric-normalized.affine.zip", user_id)
      .await
      .expect("normalized import should succeed");
    assert!(normalized_outcome.normalized);

    let rejected_err = service
      .import_from_bundle_with_filename_detailed(&rejected_bundle, "metric-rejected.zip", user_id)
      .await
      .expect_err("rejected import should fail");
    assert!(matches!(rejected_err, AuthError::InvalidInput(_)));

    assert_eq!(
      telemetry_event_count(&telemetry, TEMPLATE_IMPORT_COMPLETED_EVENT),
      2,
      "two successful imports should increment the completed counter"
    );
    assert_eq!(
      telemetry_event_count(&telemetry, TEMPLATE_IMPORT_FAILED_EVENT),
      1,
      "one rejected import should increment the failure counter"
    );
    assert_eq!(
      telemetry_event_count(&telemetry, TEMPLATE_IMPORT_FORMAT_NORMALIZED_EVENT),
      1,
      "only the raw workspace import should count as normalized"
    );
    assert_eq!(
      telemetry_event_count(&telemetry, TEMPLATE_IMPORT_FORMAT_REJECTED_EVENT),
      1,
      "the rejected import should count as rejected"
    );
    let import_prometheus = telemetry.render_prometheus();
    assert!(
      import_prometheus.contains("myoxus_frontend_event_count{event=\"template.import.completed\"} 2"),
      "Prometheus output should expose the completed import counter"
    );
    assert!(
      import_prometheus.contains("myoxus_frontend_event_count{event=\"template.import.failed\"} 1"),
      "Prometheus output should expose the failed import counter"
    );

    let reconcile_workspace_id = Uuid::new_v4();
    let (reconcile_entry, _) = seed_published_template(&service, user_id, "metric-reconcile").await;
    let _policy = service
      .assign_template_to_workspace(
        reconcile_workspace_id,
        reconcile_entry.id,
        SelectionMode::Published,
        None,
        ProvisioningMode::SeedOnce,
      )
      .await
      .expect("assignment should succeed");

    service
      .reconcile_workspace_templates(reconcile_workspace_id)
      .await
      .expect_err("missing materialization dependencies must fail closed");
    assert!(
      store
        .list_instances_for_workspace(reconcile_workspace_id)
        .await
        .unwrap()
        .is_empty()
    );
    assert_eq!(telemetry_event_count(&telemetry, TEMPLATE_RECONCILE_FAILED_EVENT), 1);
    assert_eq!(telemetry_event_count(&telemetry, TEMPLATE_RECONCILE_COMPLETED_EVENT), 0);

    let failing_telemetry = Arc::new(TelemetryService::in_memory_stub());
    let failing_store = Arc::new(RecordingTemplateRegistryStore::default());
    let failing_service = TemplateRegistryService::new(failing_store.clone())
      .with_telemetry(failing_telemetry.clone())
      .with_materialization(
        DocService::new(Arc::new(crate::doc::PanicDocStore)),
        Arc::new(NullBlobStorage),
      );
    let failing_workspace_id = Uuid::new_v4();
    let (failing_entry, _failing_revision) =
      seed_published_template(&failing_service, user_id, "metric-reconcile-fail").await;
    let _failing_policy = failing_service
      .assign_template_to_workspace(
        failing_workspace_id,
        failing_entry.id,
        SelectionMode::Published,
        None,
        ProvisioningMode::SeedOnce,
      )
      .await
      .expect("assignment should succeed");

    let failing_reconcile = failing_service
      .reconcile_workspace_templates(failing_workspace_id)
      .await
      .expect("reconcile should complete and mark the instance as error on materialization failure");
    let failed_instance = failing_reconcile
      .iter()
      .find(|instance| instance.template_id == failing_entry.id)
      .expect("reconcile should return the affected instance");
    assert_eq!(failed_instance.state, InstanceState::Error);
    assert_eq!(
      failed_instance.last_error_code.as_deref(),
      Some("MATERIALIZATION_FAILED")
    );
    assert!(
      failed_instance
        .last_error_message
        .as_deref()
        .unwrap_or_default()
        .contains("storage failure"),
      "error message should keep storage failure details for operators"
    );
    assert_eq!(
      telemetry_event_count(&failing_telemetry, TEMPLATE_RECONCILE_FAILED_EVENT),
      0,
      "soft materialization failures should not emit hard reconcile failure metrics"
    );
    assert_eq!(
      telemetry_event_count(&failing_telemetry, TEMPLATE_RECONCILE_COMPLETED_EVENT),
      1,
      "reconcile completion metric must still be emitted when instances are marked as error"
    );
    let failing_prometheus = failing_telemetry.render_prometheus();
    assert!(
      failing_prometheus.contains("myoxus_frontend_event_count{event=\"template.reconcile.completed\"} 1"),
      "Prometheus output should expose the completed reconcile counter for soft failures"
    );
  }

  #[test]
  fn logging_event_name_constants_are_stable() {
    assert_eq!(TEMPLATE_AUDIT_ERROR_CODE_NONE, "NONE");
    assert_eq!(TEMPLATE_ASSIGNMENT_CREATED_EVENT, "template.assignment.created");
    assert_eq!(TEMPLATE_ASSIGNMENT_REMOVED_EVENT, "template.assignment.removed");
    assert_eq!(TEMPLATE_ASSIGNMENT_RETIRED_EVENT, "template.assignment.retired");
    assert_eq!(TEMPLATE_ASSIGNMENT_REJECTED_EVENT, "template.assignment.rejected");
    assert_eq!(TEMPLATE_DRIFT_SCAN_STARTED_EVENT, "template.drift.scan.started");
    assert_eq!(TEMPLATE_EXPORT_COMPLETED_EVENT, "template.export.completed");
    assert_eq!(TEMPLATE_IMPORT_FAILED_EVENT, "template.import.failed");
    assert_eq!(TEMPLATE_IMPORT_COMPLETED_EVENT, "template.import.completed");
    assert_eq!(
      TEMPLATE_IMPORT_FORMAT_NORMALIZED_EVENT,
      "template.import.format.normalized"
    );
    assert_eq!(TEMPLATE_IMPORT_FORMAT_REJECTED_EVENT, "template.import.format.rejected");
    assert_eq!(TEMPLATE_IMPORT_STARTED_EVENT, "template.import.started");
    assert_eq!(TEMPLATE_IMPORT_VALIDATED_EVENT, "template.import.validated");
    assert_eq!(TEMPLATE_INSTANCE_DETACHED_EVENT, "template.instance.detached");
    assert_eq!(TEMPLATE_INSTANCE_RETIRED_EVENT, "template.instance.retired");
    assert_eq!(TEMPLATE_RECONCILE_FAILED_EVENT, "template.reconcile.failed");
    assert_eq!(TEMPLATE_RECONCILE_COMPLETED_EVENT, "template.reconcile.completed");
    assert_eq!(TEMPLATE_RECONCILE_STARTED_EVENT, "template.reconcile.started");
    assert_eq!(TEMPLATE_REVISION_PUBLISHED_EVENT, "template.revision.published");
    assert_eq!(
      TEMPLATE_REVISION_PUBLISH_FAILED_EVENT,
      "template.revision.publish.failed"
    );
  }

  #[tokio::test]
  async fn remove_template_assignment_records_audit_event_contract() {
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store.clone());
    let user_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let slug = format!("remove-audit-{}", Uuid::new_v4().simple());

    let (entry, revision) = seed_published_template(&service, user_id, &slug).await;
    let policy = service
      .assign_template_to_workspace(
        workspace_id,
        entry.id,
        SelectionMode::Published,
        None,
        ProvisioningMode::SeedOnce,
      )
      .await
      .expect("assignment should succeed");
    let policy_id_string = policy.id.to_string();
    let workspace_id_string = workspace_id.to_string();
    let template_id_string = entry.id.to_string();
    let revision_id_string = revision.id.to_string();

    service
      .remove_template_assignment(policy.id)
      .await
      .expect("removal should succeed");

    let event = recorded_audit_event(&store, TEMPLATE_ASSIGNMENT_REMOVED_EVENT).await;
    assert_eq!(event.action, TemplateRegistryAuditAction::Deleted);
    assert_eq!(event.actor_user_id, None);
    assert_eq!(event.template_id, Some(entry.id));
    assert_eq!(event.revision_id, Some(revision.id));
    assert_eq!(event.workspace_id, Some(workspace_id));
    assert_eq!(event.policy_id, Some(policy.id));
    assert_eq!(event.instance_id, None);
    assert_eq!(event.import_job_id, None);
    assert_eq!(event.source_format.as_deref(), Some("myoxus_bundle"));
    assert_eq!(event.detected_format.as_deref(), Some("myoxus_bundle"));
    assert_eq!(event.normalizer_version.as_deref(), Some("none"));
    assert_eq!(event.error_code.as_deref(), Some("NONE"));
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("policy_id"))
        .and_then(serde_json::Value::as_str),
      Some(policy_id_string.as_str())
    );
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("workspace_id"))
        .and_then(serde_json::Value::as_str),
      Some(workspace_id_string.as_str())
    );
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("template_id"))
        .and_then(serde_json::Value::as_str),
      Some(template_id_string.as_str())
    );
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("revision_id"))
        .and_then(serde_json::Value::as_str),
      Some(revision_id_string.as_str())
    );
  }

  #[tokio::test]
  async fn retire_template_assignment_records_audit_event_contract() {
    let store = Arc::new(RecordingTemplateRegistryStore::default());
    let service = TemplateRegistryService::new(store.clone());
    let user_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let slug = format!("retire-audit-{}", Uuid::new_v4().simple());

    let (entry, revision) = seed_published_template(&service, user_id, &slug).await;
    let policy = service
      .assign_template_to_workspace(
        workspace_id,
        entry.id,
        SelectionMode::Published,
        None,
        ProvisioningMode::SeedOnce,
      )
      .await
      .expect("assignment should succeed");

    let instance = WorkspaceTemplateInstance {
      id: Uuid::new_v4(),
      workspace_id,
      template_id: entry.id,
      revision_id: revision.id,
      workspace_doc_id: None,
      workspace_doc_key: None,
      state: InstanceState::Ok,
      last_applied_hash: None,
      current_hash: None,
      last_synced_at: Some(chrono::Utc::now()),
      detached_at: None,
      retired_at: None,
      last_error_code: None,
      last_error_message: None,
      expected_hash: None,
      locale_hash: None,
    };
    store
      .create_instance(&instance)
      .await
      .expect("instance seed should succeed");

    let policy_id_string = policy.id.to_string();
    let workspace_id_string = workspace_id.to_string();
    let template_id_string = entry.id.to_string();
    let revision_id_string = revision.id.to_string();
    let instance_id_string = instance.id.to_string();

    service
      .retire_template_assignment(policy.id)
      .await
      .expect("retirement should succeed");

    let event = recorded_audit_event(&store, TEMPLATE_ASSIGNMENT_RETIRED_EVENT).await;
    assert_eq!(event.action, TemplateRegistryAuditAction::Deleted);
    assert_eq!(event.actor_user_id, None);
    assert_eq!(event.template_id, Some(entry.id));
    assert_eq!(event.revision_id, Some(revision.id));
    assert_eq!(event.workspace_id, Some(workspace_id));
    assert_eq!(event.policy_id, Some(policy.id));
    assert_eq!(event.instance_id, Some(instance.id));
    assert_eq!(event.import_job_id, None);
    assert_eq!(event.source_format.as_deref(), Some("myoxus_bundle"));
    assert_eq!(event.detected_format.as_deref(), Some("myoxus_bundle"));
    assert_eq!(event.normalizer_version.as_deref(), Some("none"));
    assert_eq!(event.error_code.as_deref(), Some("NONE"));
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("policy_id"))
        .and_then(serde_json::Value::as_str),
      Some(policy_id_string.as_str())
    );
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("workspace_id"))
        .and_then(serde_json::Value::as_str),
      Some(workspace_id_string.as_str())
    );
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("template_id"))
        .and_then(serde_json::Value::as_str),
      Some(template_id_string.as_str())
    );
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("revision_id"))
        .and_then(serde_json::Value::as_str),
      Some(revision_id_string.as_str())
    );
    assert_eq!(
      event
        .payload_json
        .as_ref()
        .and_then(|json| json.get("instance_id"))
        .and_then(serde_json::Value::as_str),
      Some(instance_id_string.as_str())
    );

    let stored_instance = store
      .get_instance(instance.id)
      .await
      .expect("retired instance lookup should succeed")
      .expect("retired instance should still exist");
    assert_eq!(stored_instance.state, InstanceState::Retired);
    assert!(stored_instance.retired_at.is_some());
  }

  #[test]
  fn import_job_summary_serializes_required_fields_and_stable_error_contract() {
    let started_at = Utc::now();
    let finished_at = started_at + chrono::Duration::seconds(5);
    let warning = bundle::ValidationError {
      code: "EMPTY_TAGS".to_string(),
      message: "manifest has no tags".to_string(),
      field: Some("tags".to_string()),
      path: Some("/manifest/tags".to_string()),
      severity: bundle::ValidationSeverity::Warning,
    };
    let validation_error = bundle::ValidationError {
      code: "UNSUPPORTED_TEMPLATE_JSON".to_string(),
      message: "upstream template json is not supported".to_string(),
      field: Some("content".to_string()),
      path: Some("/content".to_string()),
      severity: bundle::ValidationSeverity::Error,
    };
    let completed_value = {
      let mut summary = TemplateImportJobSummary::new(started_at);
      summary.push_stage("detect", std::time::Duration::from_millis(11));
      summary.detected_format = Some(bundle::BundleFormat::TemplateBundle.as_str().to_string());
      summary.normalized = Some(false);
      summary.ignored_entries_count = Some(1);
      summary
        .complete(finished_at, Uuid::new_v4(), vec![warning.clone()])
        .into_value()
    };

    assert_eq!(completed_value["status"], "completed");
    assert_eq!(
      completed_value["error_catalog_version"],
      TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION
    );
    assert!(
      completed_value["started_at"].is_string(),
      "completed summary must include started_at"
    );
    assert!(
      completed_value["finished_at"].is_string(),
      "completed summary must include finished_at"
    );
    assert!(
      completed_value["result_revision_id"].is_string(),
      "completed summary must include result_revision_id"
    );
    assert_eq!(completed_value["detected_format"], "myoxus_bundle");
    assert_eq!(completed_value["normalized"], false);
    assert_eq!(completed_value["ignored_entries_count"], 1);
    assert!(completed_value["error"].is_null());
    assert!(completed_value["failed_stage"].is_null());
    assert_eq!(
      completed_value["stages"]
        .as_array()
        .expect("completed summary stages should be an array")
        .len(),
      1
    );
    assert_eq!(
      completed_value["warnings"]
        .as_array()
        .expect("completed summary warnings should be an array")
        .len(),
      1
    );
    assert_eq!(completed_value["warnings"][0]["code"], "EMPTY_TAGS");
    assert_eq!(completed_value["warnings"][0]["path"], "/manifest/tags");

    let failed_value = {
      let mut summary = TemplateImportJobSummary::new(started_at);
      summary.push_stage("validate", std::time::Duration::from_millis(8));
      summary
        .fail(
          finished_at,
          "validate",
          TemplateOperationErrorSummary {
            operation: TemplateRegistryOperation::Import.as_str(),
            stage: "validate",
            code: validation_error.code.clone(),
            message: validation_error.message.clone(),
            path: Some("/content".to_string()),
          },
          vec![validation_error],
        )
        .into_value()
    };

    assert_eq!(failed_value["status"], "failed");
    assert_eq!(
      failed_value["error_catalog_version"],
      TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION
    );
    assert!(
      failed_value["started_at"].is_string(),
      "failed summary must include started_at"
    );
    assert!(
      failed_value["finished_at"].is_string(),
      "failed summary must include finished_at"
    );
    assert!(
      failed_value["result_revision_id"].is_null(),
      "failed summary must not include a result revision"
    );
    assert_eq!(failed_value["failed_stage"], "validate");
    assert!(
      failed_value["error"].is_object(),
      "failed summary must include a structured error"
    );
    assert_eq!(failed_value["error"]["code"], "UNSUPPORTED_TEMPLATE_JSON");
    assert_eq!(failed_value["error"]["operation"], "import");
    assert_eq!(failed_value["error"]["stage"], "validate");
    assert_eq!(
      failed_value["error"]["message"],
      "upstream template json is not supported"
    );
    assert_eq!(failed_value["error"]["path"], "/content");
    assert_eq!(
      failed_value["validation_errors"]
        .as_array()
        .expect("validation_errors should be an array")
        .len(),
      1
    );
  }

  #[test]
  fn derive_release_notes_prefers_explicit_manifest_field() {
    let with_snake_case = serde_json::json!({
      "release_notes": "  from snake_case  "
    });
    assert_eq!(
      derive_release_notes(&with_snake_case, Some("fallback")),
      Some("from snake_case".to_string())
    );

    let with_camel_case = serde_json::json!({
      "releaseNotes": "from camelCase"
    });
    assert_eq!(
      derive_release_notes(&with_camel_case, Some("fallback")),
      Some("from camelCase".to_string())
    );

    let no_field = serde_json::json!({});
    assert_eq!(
      derive_release_notes(&no_field, Some("  fallback description  ")),
      Some("fallback description".to_string())
    );
    assert_eq!(derive_release_notes(&no_field, Some("   ")), None);
  }

  #[test]
  fn content_hash_is_stable_and_hex_encoded() {
    let empty_hash = compute_content_hash(b"");
    let abc_hash = compute_content_hash(b"abc");
    let abcd_hash = compute_content_hash(b"abcd");

    assert_eq!(
      empty_hash,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
      abc_hash,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_ne!(abc_hash, abcd_hash);
    assert!(abc_hash.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(abc_hash.len(), 64);
  }
}
