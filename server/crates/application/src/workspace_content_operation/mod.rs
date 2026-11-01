// SPDX-License-Identifier: AGPL-3.0-or-later
//! Persistence ports for durable cross-workspace content operations.
//!
//! PostgreSQL owns operation state and publication intent. Object storage owns
//! staged bytes. Redis and individual API/worker processes are deliberately
//! absent from this contract and cannot decide durable transitions.

use async_trait::async_trait;
use myoxus_domain::entities::WorkspaceRole;
use myoxus_domain::ids::{UserId, WorkspaceContentOperationId};
use myoxus_domain::workspace_content_operation::{
  RedactedWorkspaceContentError, WorkspaceContentConfirmation, WorkspaceContentErrorCode, WorkspaceContentIdMapping,
  WorkspaceContentOperationKind, WorkspaceContentOperationRecord, WorkspaceContentOperationStatus,
  WorkspaceContentResourceKind, WorkspaceContentResourceRef, WorkspaceContentStagingEntry,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};

/// Historical Collection mappings remain decodable, but are never executable.
/// Call before staging, publication, retry or constructing an inverse operation.
pub fn reject_collection_mappings(mappings: &[WorkspaceContentIdMapping]) -> AuthResult<()> {
  if mappings.iter().any(|mapping| {
    mapping.source.kind() == WorkspaceContentResourceKind::Collection
      || mapping.target.kind() == WorkspaceContentResourceKind::Collection
  }) {
    return Err(AuthError::InvalidInput(
      myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode::SelectedResourceUnsupported
        .as_str()
        .into(),
    ));
  }
  Ok(())
}

/// Typed native plans live inside existing staged documents/Move manifests.
/// Version admission is separate from terminal receipt decoding.
pub const NATIVE_REFERENCE_PLAN_VERSION: u32 = 2;

/// Preview semantics may change without invalidating committed history lineage.
pub const REFERENCE_ADMISSION_VERSION: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum WorkspaceContentReferenceDecision {
  Keep {
    target: WorkspaceContentResourceRef,
  },
  Remap {
    target: WorkspaceContentResourceRef,
  },
  /// Historical origin is unproved: retain the native occurrence with an
  /// explicitly unavailable scope, without guessing a containing workspace.
  Unavailable,
  Omit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceContentReferenceOccurrence {
  pub position: yjs::NativeReferencePosition,
  /// Exact codec values bind the selector, including malformed explicit scopes.
  pub expected_id: String,
  pub expected_workspace_id: Option<String>,
  /// Present only when canonical resolution proved a typed address.
  pub resource: Option<WorkspaceContentResourceRef>,
  pub decision: WorkspaceContentReferenceDecision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceContentNativeReferencePlan {
  pub version: u32,
  pub source: WorkspaceContentResourceRef,
  pub snapshot_sha256: String,
  pub occurrences: Vec<WorkspaceContentReferenceOccurrence>,
}

impl WorkspaceContentNativeReferencePlan {
  /// Validate before I/O/publication. Unknown plans require a new preview;
  /// historical terminal manifests remain serde-readable without this admission.
  pub fn validate(&self) -> AuthResult<()> {
    use myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode;
    if self.version != NATIVE_REFERENCE_PLAN_VERSION {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::NativeReferenceVersionUnsupported
          .as_str()
          .into(),
      ));
    }
    let mut positions = std::collections::BTreeSet::new();
    WorkspaceContentResourceRef::new(
      self.source.workspace_id(),
      self.source.kind(),
      self.source.resource_id(),
    )
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into()))?;

    if self.source.kind() != WorkspaceContentResourceKind::Document
      || self.snapshot_sha256.len() != 64
      || !self.snapshot_sha256.bytes().all(|value| value.is_ascii_hexdigit())
      || self
        .occurrences
        .iter()
        .any(|occurrence| !positions.insert(&occurrence.position))
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into(),
      ));
    }
    for occurrence in &self.occurrences {
      match &occurrence.decision {
        WorkspaceContentReferenceDecision::Keep { target } | WorkspaceContentReferenceDecision::Remap { target } => {
          let Some(resource) = &occurrence.resource else {
            return Err(AuthError::InvalidInput(
              WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into(),
            ));
          };
          for address in [resource, target] {
            WorkspaceContentResourceRef::new(address.workspace_id(), address.kind(), address.resource_id())
              .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into()))?;
          }
          if !matches!(
            resource.kind(),
            WorkspaceContentResourceKind::Document | WorkspaceContentResourceKind::Blob
          ) || target.kind() != resource.kind()
          {
            return Err(AuthError::InvalidInput(
              WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into(),
            ));
          }
        }
        WorkspaceContentReferenceDecision::Omit | WorkspaceContentReferenceDecision::Unavailable => {}
      }
    }
    Ok(())
  }
}

pub const MAX_PREVIEW_REVISION_BYTES: usize = 128;

/// Deployed Tag relocation plans preserve globally unique catalog IDs. The new
/// publisher never does: reject these plans before materialization and let the
/// existing compensation path retain the precise fresh-preview outcome.
pub fn reject_tag_relocation_mappings(mappings: &[WorkspaceContentIdMapping]) -> AuthResult<()> {
  if mappings.iter().any(|mapping| {
    mapping.source.kind() == WorkspaceContentResourceKind::Tag
      && mapping.source.resource_id() == mapping.target.resource_id()
  }) {
    return Err(AuthError::InvalidInput(
      myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode::MoveTagLineageRequiresAFreshPreview
        .as_str()
        .into(),
    ));
  }
  Ok(())
}
pub const MAX_DIAGNOSTIC_INSTANCE_ID_BYTES: usize = 128;
pub const MAX_COMPENSATION_KIND_BYTES: usize = 64;
pub const MAX_RECIPIENT_EVENT_KIND_BYTES: usize = 64;
pub const MAX_ORGANIZER_ENTRY_ID_BYTES: usize = 512;
pub const MAX_ORGANIZER_INDEX_BYTES: usize = 512;
pub const MAX_OPERATION_SELECTION_RESOURCES: usize = 256;
pub const MAX_EXTRACT_WORKSPACE_NAME_BYTES: usize = 256;

/// Server-reloadable selection for one content operation.
///
/// Only stable source identities are persisted. The resource graph, revisions,
/// permissions and membership effects are rebuilt from authoritative stores.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceContentOperationSelection {
  Resources {
    resources: Vec<WorkspaceContentResourceRef>,
  },
  FolderSubtree {
    folder_id: String,
  },
}

/// Content-free admission request persisted beside an operation.
/// The optional Git choice is absent on existing persisted requests; fresh
/// Git-enabled Extracts resolve that absence to Move at preflight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceContentGitSyncChoice {
  Move,
  Disconnect,
}

/// Captured ownership evidence for a Git-enabled Extract. This is server-only
/// planning data, not client-selected paths or credentials. Rebuild it on
/// execute and bind the canonical representation to the preflight revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentGitSyncPlan {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub undo: Option<WorkspaceContentGitSyncUndo>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub target_configuration: Option<serde_json::Value>,
  pub choice: WorkspaceContentGitSyncChoice,
  pub source_profile_id: Uuid,
  pub source_profile_owner_id: Uuid,
  pub source_profile_updated_at: chrono::DateTime<chrono::Utc>,
  pub source_scope_revision: i64,
  pub direction: myoxus_domain::git_sync::SyncDirection,
  pub trigger: myoxus_domain::git_sync::TriggerMode,
  pub intended_enabled: bool,
  pub repository: String,
  pub branch: String,
  pub source_root: String,
  pub source_manifest: String,
  pub target_root: String,
  pub target_manifest: String,
  pub remote_oid: Option<String>,
  pub observed_hashes: std::collections::BTreeMap<String, String>,
  /// Typed manifest inventory serialized as metadata, never document bodies.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub manifest_inventory: Option<serde_json::Value>,
  pub documents: Vec<WorkspaceContentGitSyncDocument>,
  pub files: Vec<WorkspaceContentGitSyncFile>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub shared_files: Vec<WorkspaceContentGitSyncSharedFile>,
  pub delegated_descendants: Vec<WorkspaceContentGitSyncDelegation>,
}

/// Configuration owned by a newly extracted profile. Runtime schedule state and
/// current credential pointers are intentionally outside inverse authority.
pub fn extract_git_profile_configuration(profile: &myoxus_domain::git_sync::GitSyncProfile) -> serde_json::Value {
  serde_json::json!({"direction":profile.sync_direction,"trigger":profile.trigger_mode,
    "polling":profile.polling_interval_secs,"cron":profile.cron_expression,"timezone":profile.cron_timezone,
    "misfire":profile.cron_misfire_policy,"auth":profile.auth_method,"enabled":profile.enabled,"mirror":profile.max_mirror_storage_mb})
}

/// Inverse metadata authority is captured from the original receipt and current
/// authenticated branch, never from old credentials or a reconstructed slug.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentGitSyncUndo {
  pub origin_operation_id: Uuid,
  pub original_oid: String,
  pub source_scope_revision: i64,
  pub target_scope_revision: Option<i64>,
  pub expected_hashes: std::collections::BTreeMap<String, Option<String>>,
  pub original_baselines: std::collections::BTreeMap<Uuid, String>,
  pub baseline_observed_before: chrono::DateTime<chrono::Utc>,
}

/// One deterministic profile identity across SQL publication and Git retries.
pub fn extract_git_profile_id(operation_id: Uuid) -> Uuid {
  Uuid::new_v5(&operation_id, b"extract-git-profile")
}

/// Existing source fence carried into the extracted parent's scope. Removing
/// a delegated destination never releases the protected repository path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentGitSyncDelegation {
  pub repo_path: String,
  pub is_directory: bool,
  pub destination_profile_id: Option<Uuid>,
  pub originating_operation_id: Uuid,
  pub scope_revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentGitSyncDocument {
  pub binding_id: Uuid,
  pub doc_id: Uuid,
  pub sync_id: Uuid,
  pub repo_path: String,
  pub content_hash: Option<String>,
  pub baseline_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentGitSyncFile {
  pub binding_id: Uuid,
  pub blob_key: String,
  pub repo_path: String,
  pub content_hash: String,
}

/// An asset needed by the target but retained by the source outside its subtree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentGitSyncSharedFile {
  pub source: WorkspaceContentGitSyncFile,
  pub target_blob_key: String,
  pub target_repo_path: String,
  pub mime_type: String,
  pub file_size: i64,
}

/// Authenticated read-only branch observation. Raw Git bytes never enter the
/// durable operation plan; only identities and hashes are retained.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceContentGitSyncCapture {
  /// Undo cannot reverse remote ownership from a cached outage observation.
  #[serde(default)]
  pub remote_verified: bool,
  pub head_oid: String,
  pub manifest: crate::git_sync::export::GitSyncManifest,
  /// Complete worktree file inventory from the same authenticated branch clone.
  pub observed_paths: std::collections::BTreeSet<String>,
  pub path_hashes: std::collections::BTreeMap<String, String>,
  /// Canonical Markdown-body hashes, distinct from full Git-file byte hashes.
  pub document_body_hashes: std::collections::BTreeMap<String, String>,
}

#[async_trait]
pub trait WorkspaceContentGitSyncCapturePort: Send + Sync {
  /// `None` denotes an unavailable remote, not proof that a path is free.
  async fn capture(
    &self,
    actor_id: uuid::Uuid,
    profile: &myoxus_domain::git_sync::GitSyncProfile,
    folder_id: &str,
    paths: &[String],
  ) -> AuthResult<Option<WorkspaceContentGitSyncCapture>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentOperationRequest {
  pub kind: WorkspaceContentOperationKind,
  pub source_workspace_id: Uuid,
  /// Reserved before preflight. Extract targets do not become visible until
  /// execute creates the lifecycle-isolated workspace.
  pub target_workspace_id: Uuid,
  pub selection: WorkspaceContentOperationSelection,
  pub copy_document_acl: bool,
  pub extract_workspace_name: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub git_sync_choice: Option<WorkspaceContentGitSyncChoice>,
  pub link_entry_id: Option<String>,
  pub link_parent_id: Option<String>,
  pub link_index: Option<String>,
}

/// Exact execute binding supplied by the authenticated actor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentExecuteRequest {
  pub operation_id: WorkspaceContentOperationId,
  pub actor_id: UserId,
  pub revision: String,
  pub confirmations: Vec<WorkspaceContentConfirmation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentExecutionMembership {
  pub user_id: UserId,
  pub role: WorkspaceRole,
}

/// Actor-visible status projection. Internal diagnostics stay operator-only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentOperationStatusProjection {
  pub record: WorkspaceContentOperationRecord,
  pub origin_operation_id: Option<WorkspaceContentOperationId>,
  pub git_sync: Option<WorkspaceContentGitSyncPending>,
}

/// External completion never changes the successful content-operation state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentGitSyncPending {
  pub summary: WorkspaceContentGitSyncSummary,
  pub pending: bool,
  pub error_code: Option<myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode>,
  pub retry_exhausted: bool,
}

/// Content-free metadata reused by review and resumed status projections.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentGitSyncSummary {
  pub is_undo: bool,
  pub choice: WorkspaceContentGitSyncChoice,
  pub repository: String,
  pub branch: String,
  pub source_profile_id: Uuid,
  pub new_root: String,
  pub own_manifest: String,
  pub intended_enabled: bool,
}

impl From<&WorkspaceContentGitSyncPlan> for WorkspaceContentGitSyncSummary {
  fn from(plan: &WorkspaceContentGitSyncPlan) -> Self {
    Self {
      is_undo: plan.undo.is_some(),
      choice: plan.choice,
      repository: plan.repository.clone(),
      branch: plan.branch.clone(),
      source_profile_id: plan.source_profile_id,
      new_root: plan.target_root.clone(),
      own_manifest: plan.target_manifest.clone(),
      intended_enabled: plan.intended_enabled,
    }
  }
}

/// Result of an idempotent create.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentCreateResult {
  pub record: WorkspaceContentOperationRecord,
  /// True only for the caller that inserted the durable operation.
  pub created: bool,
}

/// Operation-owned redirect written during publication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentRedirect {
  pub operation_id: WorkspaceContentOperationId,
  pub source: WorkspaceContentResourceRef,
  pub target: WorkspaceContentResourceRef,
}

/// Content-free notification intent bound to the finalize recipient snapshot.
///
/// `resource_count == 0` and an empty kind set deliberately encode a generic
/// notice for a source member without resource-level read access. Resource
/// identities, titles, target metadata, and payloads are never valid here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentRecipientIntent {
  pub operation_id: WorkspaceContentOperationId,
  pub recipient_id: UserId,
  pub event_kind: String,
  pub source_workspace_id: Uuid,
  pub source_workspace_name: String,
  pub actor_id: UserId,
  pub resource_count: i32,
  /// Canonical kinds visible to this recipient; empty means generic notice.
  pub visible_resource_kinds: Vec<WorkspaceContentResourceKind>,
  pub recipient_snapshot_revision: String,
}

/// Durable compensation intent. `kind` is an internal operation verb, while
/// `target` remains a typed, workspace-qualified product identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentCompensationIntent {
  pub operation_id: WorkspaceContentOperationId,
  pub sequence: i64,
  pub kind: String,
  pub target: WorkspaceContentResourceRef,
}

/// Durable, content-free placement for exactly one cross-workspace link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentLinkIntent {
  pub operation_id: WorkspaceContentOperationId,
  pub entry_id: String,
  pub parent_id: String,
  pub index: String,
  /// Organizer revision observed when the placement was confirmed.
  pub organizer_revision: String,
  pub target: WorkspaceContentResourceRef,
}

/// Durable operation repository with compare-and-transition semantics.
#[async_trait]
pub trait WorkspaceContentOperationRepository: Send + Sync {
  async fn pending_git_operation_ids(&self, workspace_id: Uuid, actor_id: UserId) -> AuthResult<Vec<Uuid>>;
  /// Insert once by `idempotency_id`. An exact replay returns the existing
  /// aggregate; a changed replay is rejected.
  async fn create_or_get(&self, record: WorkspaceContentOperationRecord) -> AuthResult<WorkspaceContentCreateResult>;
  async fn get(&self, operation_id: WorkspaceContentOperationId)
  -> AuthResult<Option<WorkspaceContentOperationRecord>>;
  /// Atomically apply one legal state edge. A stale expected state and an
  /// illegal edge are both rejected without changing durable state.
  async fn transition(
    &self,
    operation_id: WorkspaceContentOperationId,
    expected: WorkspaceContentOperationStatus,
    next: WorkspaceContentOperationStatus,
    error: Option<RedactedWorkspaceContentError>,
    diagnostic_instance_id: Option<&str>,
  ) -> AuthResult<WorkspaceContentOperationRecord>;
  /// Insert a source redirect once. An exact replay is idempotent; a different
  /// target for the same source is rejected.
  async fn insert_redirect(&self, redirect: WorkspaceContentRedirect) -> AuthResult<bool>;
  /// Return durable operations that need a queue wake-up.
  ///
  /// The caller may emit duplicate wake-ups; operation transitions remain
  /// idempotent.
  async fn list_reconcilable_operation_ids(&self, limit: usize) -> AuthResult<Vec<WorkspaceContentOperationId>>;
  /// True only for a succeeded Extract whose metadata remains eligible for
  /// queue delivery; an exhausted attempt waits for explicit actor Retry.
  async fn has_reconcilable_git_work(&self, operation_id: WorkspaceContentOperationId) -> AuthResult<bool>;
  async fn git_work_status(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Option<WorkspaceContentGitSyncPending>>;
  /// Store only stable safe causes; never transition or compensate published content.
  async fn record_git_failure(
    &self,
    operation_id: WorkspaceContentOperationId,
    code: WorkspaceContentErrorCode,
    exhausted: bool,
  ) -> AuthResult<()>;
  async fn retry_git_work(&self, operation_id: WorkspaceContentOperationId, actor_id: UserId) -> AuthResult<()>;
  /// Persist one content-free recipient intent exactly once.
  async fn enqueue_recipient(&self, intent: WorkspaceContentRecipientIntent) -> AuthResult<bool>;
  /// Append one deterministic compensation step exactly once.
  async fn append_compensation(&self, intent: WorkspaceContentCompensationIntent) -> AuthResult<bool>;
}

/// Durable API-control metadata and actor-scoped state transitions.
#[async_trait]
pub trait WorkspaceContentControlRepository: Send + Sync {
  async fn store_git_undo_plan(&self, operation_id: Uuid, plan: Option<&WorkspaceContentGitSyncPlan>)
  -> AuthResult<()>;
  /// Persist the exact content-free request once. A changed replay fails.
  async fn store_request(
    &self,
    operation_id: WorkspaceContentOperationId,
    request: &WorkspaceContentOperationRequest,
    origin_operation_id: Option<WorkspaceContentOperationId>,
  ) -> AuthResult<()>;
  async fn load_request(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Option<(WorkspaceContentOperationRequest, Option<WorkspaceContentOperationId>)>>;
  /// Transition only when the immutable actor and expected revision match.
  async fn queue_previewed(
    &self,
    request: &WorkspaceContentExecuteRequest,
  ) -> AuthResult<WorkspaceContentOperationRecord>;
  async fn store_execution_memberships(
    &self,
    operation_id: WorkspaceContentOperationId,
    memberships: &[WorkspaceContentExecutionMembership],
  ) -> AuthResult<()>;
  /// Cancel only before canonical publication. Staged cleanup is performed by
  /// the recovery worker from durable compensation state.
  async fn cancel_unpublished(
    &self,
    operation_id: WorkspaceContentOperationId,
    actor_id: UserId,
  ) -> AuthResult<WorkspaceContentOperationRecord>;
  /// Return only this cancelled operation's private, unpublished Blob intents.
  /// Live canonical catalogs and committed receipts are never cleanup-owned.
  async fn cancelled_private_blob_targets(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Vec<WorkspaceContentResourceRef>>;
  async fn retry_failed(
    &self,
    operation_id: WorkspaceContentOperationId,
    actor_id: UserId,
    revision: &str,
  ) -> AuthResult<WorkspaceContentOperationRecord>;
  async fn mark_cancel_cleanup_required(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<WorkspaceContentOperationRecord>;
  async fn complete_cancel_cleanup(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<WorkspaceContentOperationRecord>;
  async fn mark_staging_deleted(&self, operation_id: WorkspaceContentOperationId) -> AuthResult<()>;
  async fn resume_cleanup_required(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<WorkspaceContentOperationRecord>;
}

/// Durable redirect lookup and target existence boundary.
#[async_trait]
pub trait WorkspaceContentRedirectRepository: Send + Sync {
  async fn resolve_redirect(
    &self,
    source: &WorkspaceContentResourceRef,
  ) -> AuthResult<Option<WorkspaceContentResourceRef>>;
  async fn resource_exists(&self, resource: &WorkspaceContentResourceRef) -> AuthResult<bool>;
  /// Internal canonical existence proof without metadata or an actor read
  /// grant. Unknown/failed resolution propagates; only proved absence is None.
  async fn canonical_reference(
    &self,
    resource: &WorkspaceContentResourceRef,
  ) -> AuthResult<Option<WorkspaceContentResourceRef>> {
    Ok(self.resource_exists(resource).await?.then(|| resource.clone()))
  }
}

/// Persistence boundary for the singular organizer placement of a Link job.
#[async_trait]
pub trait WorkspaceContentLinkIntentRepository: Send + Sync {
  /// Store an exact intent once. A changed replay is rejected.
  async fn store_link_intent(&self, intent: WorkspaceContentLinkIntent) -> AuthResult<bool>;
  async fn get_link_intent(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Option<WorkspaceContentLinkIntent>>;
}

/// Atomic persistence boundary for the operation-owned staging manifest.
#[async_trait]
pub trait WorkspaceContentStagingManifestRepository: Send + Sync {
  /// Persist the complete mapping and currently produced staged-object
  /// manifest in one transaction. Active staging may extend that complete
  /// prefix; exact entries are immutable and omitted durable entries or any
  /// divergent replay are rejected. The operation's manifest hash must match
  /// `manifest_hash`.
  async fn store_manifest(
    &self,
    operation_id: WorkspaceContentOperationId,
    manifest_hash: &str,
    mappings: &[WorkspaceContentIdMapping],
    entries: &[WorkspaceContentStagingEntry],
  ) -> AuthResult<()>;
  async fn list_mappings(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Vec<WorkspaceContentIdMapping>>;
  async fn list_staging_entries(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Vec<WorkspaceContentStagingEntry>>;
}
pub mod authorization;
pub mod control;
pub mod coordination;
pub mod copy;
pub mod dependencies;
mod diagnostics;
pub use diagnostics::{WorkspaceContentExecutionError, WorkspaceContentExecutionResult, organizer_failure};
pub use diagnostics::{failure_code, record_operation_failure};
pub mod extract;
pub mod link;
pub mod move_publication;
pub mod notification;
pub mod organizer_stage;
pub mod overview;
pub mod preflight;
pub mod publication;
pub mod reconcile;
pub mod redirect;
pub mod worker;
