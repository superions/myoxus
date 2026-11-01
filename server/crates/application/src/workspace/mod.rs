//! Workspace application service and its persistence port.
//!
//! [`WorkspaceStore`] is the storage port that must be implemented by the
//! infrastructure layer.  [`WorkspaceService`] orchestrates all workspace
//! lifecycle operations (creation, member management, invite links, ownership
//! transfer) and publishes domain events to the outbox on state changes.

pub mod assistant_packages;
mod overview;
pub mod resource_inventory;
mod starter;
mod starter_documents;
mod starter_project;
pub use starter_documents::*;
pub use starter_project::*;
pub mod tasks;
pub use assistant_packages::{
  PreparedWorkspaceAssistant, WorkspaceSetupAssistance, WorkspaceSetupAssistanceDocumentTarget,
};
pub use starter::*;

use crate::auth::{AuthError, AuthResult};
use crate::events::EventPublisher;
use crate::permission::{AccessController, PermissionService, WorkspaceResource};
use crate::public::PublicRepository;
use crate::template_registry::TemplateRegistryService;
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use myoxus_domain::entities::OutboxEventType;
use myoxus_domain::entities::{MembershipStatus, User, Workspace, WorkspaceInviteLink, WorkspaceMember, WorkspaceRole};
use myoxus_domain::ids::{InviteLinkId, OrganizationUnitId, UserId, WorkspaceId, WorkspaceImportId};
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::workspace_overview::WorkspaceOverviewSettingsPatch;
use std::sync::Arc;
use thiserror::Error;
use tracing::{debug, info, instrument, warn};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

pub const MAX_WORKSPACE_NAME_CODEPOINTS: usize = 120;
pub const MAX_WORKSPACE_DESCRIPTION_CODEPOINTS: usize = 2_000;
const DEFAULT_WORKSPACE_NAME: &str = "New Workspace";
pub(crate) const MAX_WORKSPACE_NAME_SUFFIX: u32 = 10_000;

/// The shipped invitation duration choices shared by GraphQL and MCP.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub enum WorkspaceInviteLinkExpiry {
  OneDay,
  ThreeDays,
  OneWeek,
  OneMonth,
}

impl WorkspaceInviteLinkExpiry {
  pub const fn milliseconds(self) -> i64 {
    let days = match self {
      Self::OneDay => 1,
      Self::ThreeDays => 3,
      Self::OneWeek => 7,
      Self::OneMonth => 30,
    };
    days * 24 * 60 * 60 * 1000
  }
}

/// Project the deployed invite route using the startup-materialized origin.
/// The token is opaque and this helper must never trace it or the resulting URL.
pub fn workspace_invite_url(server_origin: &str, token: &str) -> String {
  format!("{}/invite/{}", server_origin.trim_end_matches('/'), token)
}

/// Canonical display and comparison forms of a workspace name.
///
/// Display names are NFC-normalized and have internal whitespace folded to a
/// single ASCII space. The comparison form additionally applies
/// locale-independent Unicode lowercase. Persistence stores both values so
/// every create, rename and extraction path shares one uniqueness contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceName {
  display: String,
  normalized: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum WorkspaceNameError {
  #[error("workspace name must not be blank")]
  Blank,
  #[error("workspace name contains control characters")]
  ControlCharacter,
  #[error("workspace name exceeds 120 Unicode codepoints")]
  TooLong,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceLifecycleState {
  Active,
  Importing,
  Extracting,
}

impl WorkspaceLifecycleState {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Active => "active",
      Self::Importing => "importing",
      Self::Extracting => "extracting",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceLifecycleOwnerKind {
  Import,
  WorkspaceContent,
}

/// User-facing workspace ownership classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceClassification {
  Personal,
  UserOwned,
  Shared,
}

/// Authoritative ownership target for an operator-driven workspace transfer.
///
/// The target deliberately excludes system ownership: operators may repair an
/// ownerless workspace by assigning a user or OU, but must not create new
/// ownerless workspaces through the normal lifecycle API.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceOwnerTarget {
  User(UserId),
  OrganizationUnit(OrganizationUnitId),
}

impl WorkspaceLifecycleOwnerKind {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Import => "import",
      Self::WorkspaceContent => "workspace_content",
    }
  }
}

impl WorkspaceName {
  pub fn parse(value: &str) -> Result<Self, WorkspaceNameError> {
    if value.chars().any(char::is_control) {
      return Err(WorkspaceNameError::ControlCharacter);
    }
    let nfc = value.nfc().collect::<String>();
    let display = nfc.split_whitespace().collect::<Vec<_>>().join(" ");
    if display.is_empty() {
      return Err(WorkspaceNameError::Blank);
    }
    if display.chars().count() > MAX_WORKSPACE_NAME_CODEPOINTS {
      return Err(WorkspaceNameError::TooLong);
    }
    let normalized = display
      .chars()
      .flat_map(char::to_lowercase)
      .collect::<String>()
      .nfc()
      .collect();
    Ok(Self { display, normalized })
  }

  pub fn default_name() -> Self {
    Self::parse(DEFAULT_WORKSPACE_NAME).expect("static workspace default name is valid")
  }

  pub fn display(&self) -> &str {
    &self.display
  }

  pub fn normalized(&self) -> &str {
    &self.normalized
  }

  /// Return the deterministic `Name (n)` alternative within the 120-codepoint
  /// limit. The base is shortened only to make room for the suffix.
  pub fn with_suffix(&self, suffix: u32) -> Result<Self, WorkspaceNameError> {
    let suffix = format!(" ({suffix})");
    let keep = MAX_WORKSPACE_NAME_CODEPOINTS
      .checked_sub(suffix.chars().count())
      .ok_or(WorkspaceNameError::TooLong)?;
    let base = self.display.chars().take(keep).collect::<String>();
    Self::parse(&format!("{}{suffix}", base.trim_end()))
  }
}

fn workspace_name(value: &str) -> AuthResult<WorkspaceName> {
  WorkspaceName::parse(value).map_err(|error| AuthError::InvalidInput(error.to_string()))
}

/// Normalize and validate the workspace's plain-text public description.
///
/// Only CRLF line endings are canonicalized. All other user text, including
/// whitespace and markup-looking characters, is preserved verbatim.
pub fn workspace_description(value: &str) -> AuthResult<String> {
  let normalized = value.replace("\r\n", "\n");
  if normalized.chars().count() > MAX_WORKSPACE_DESCRIPTION_CODEPOINTS {
    return Err(AuthError::InvalidInput(
      "workspace description exceeds 2000 Unicode codepoints".to_string(),
    ));
  }
  Ok(normalized)
}

/// Partial-update DTO for workspace settings.
///
/// Fields set to `None` are not modified; only `Some` fields are applied.
/// `storage_quota_update` uses tri-state [`QuotaUpdate`] because
/// clearing a quota override (back to NULL) is a distinct intent from "leave unchanged".
#[derive(Debug, Clone, Default)]
pub struct UpdateWorkspace {
  /// New display name for the workspace.
  pub name: Option<WorkspaceName>,
  /// New plain-text description. `None` leaves it unchanged; an empty value clears it.
  pub description: Option<String>,
  /// Workspace avatar blob key (asset reference, not a URL).
  pub avatar_key: Option<String>,
  /// Whether the workspace is publicly accessible without authentication.
  pub public: Option<bool>,
  /// Enable AI / copilot features for this workspace.
  pub enable_ai: Option<bool>,
  /// Allow documents to be shared externally via link.
  pub enable_sharing: Option<bool>,
  /// Enable URL-preview card generation within documents.
  pub enable_url_preview: Option<bool>,
  /// Enable server-side document embedding (semantic search, copilot).
  pub enable_doc_embedding: Option<bool>,
  /// Per-workspace storage quota override.
  ///
  /// `Unchanged` (default) — do not modify the current value.
  /// `Clear` — remove the override (set DB column to NULL, falls back to the config default).
  /// `Set(bytes)` — apply a new explicit override in bytes.
  pub storage_quota_update: QuotaUpdate,
  /// Revision-checked, root/folder-scoped overview presentation update.
  pub overview: Option<WorkspaceOverviewSettingsPatch>,
}

/// User-editable workspace settings before validation and normalization.
///
/// Omitted fields remain unchanged. Administrative avatar and quota fields are
/// deliberately absent so user-facing transports cannot reach them through
/// this operation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserWorkspaceSettingsInput {
  pub name: Option<String>,
  pub description: Option<String>,
  pub public: Option<bool>,
  pub enable_ai: Option<bool>,
  pub enable_sharing: Option<bool>,
  pub enable_url_preview: Option<bool>,
  pub enable_doc_embedding: Option<bool>,
  pub overview: Option<WorkspaceOverviewSettingsPatch>,
}

/// Invalidates the API-owned workspace-settings cache after a persisted write.
#[async_trait]
pub trait WorkspaceSettingsInvalidation: Send + Sync {
  async fn invalidate_workspace_settings(&self, workspace_id: WorkspaceId);
}

/// Authorized user-facing workspace-settings operation shared by transports.
#[derive(Clone)]
pub struct WorkspaceSettingsService {
  workspace: WorkspaceService,
  permission: Arc<PermissionService>,
  invalidation: Arc<dyn WorkspaceSettingsInvalidation>,
  public_repository: Arc<dyn PublicRepository>,
  documents: crate::doc::DocService,
  metadata: Option<crate::document_metadata_policy::DocumentMetadataPolicyService>,
}

impl WorkspaceSettingsService {
  pub fn new(
    workspace: WorkspaceService,
    permission: Arc<PermissionService>,
    invalidation: Arc<dyn WorkspaceSettingsInvalidation>,
    public_repository: Arc<dyn PublicRepository>,
    documents: crate::doc::DocService,
    metadata: Option<crate::document_metadata_policy::DocumentMetadataPolicyService>,
  ) -> Self {
    Self {
      workspace,
      permission,
      invalidation,
      public_repository,
      documents,
      metadata,
    }
  }

  /// Apply the user-editable settings after effective-role authorization.
  ///
  /// Cache invalidation follows a successful persistence write. Publication
  /// artifact invalidation remains best effort, matching the existing GraphQL
  /// behavior, and only runs when a public boundary was explicitly changed.
  #[instrument(skip_all, fields(user_id = %user_id, workspace_id = %workspace_id))]
  pub async fn update(
    &self,
    user_id: UserId,
    workspace_id: WorkspaceId,
    mut input: UserWorkspaceSettingsInput,
  ) -> AuthResult<Workspace> {
    self
      .permission
      .assert(
        &WorkspaceResource { user_id, workspace_id },
        WorkspaceAction::SettingsUpdate,
      )
      .await?;

    if let Some(patch) = &mut input.overview {
      self.validate_overview_patch(user_id, workspace_id, patch).await?;
    }
    let publication_boundary_changed = input.public.is_some() || input.enable_sharing.is_some();
    let workspace = self
      .workspace
      .update_workspace(
        workspace_id,
        UpdateWorkspace {
          name: input.name.as_deref().map(workspace_name).transpose()?,
          description: input.description.as_deref().map(workspace_description).transpose()?,
          public: input.public,
          enable_ai: input.enable_ai,
          enable_sharing: input.enable_sharing,
          enable_url_preview: input.enable_url_preview,
          enable_doc_embedding: input.enable_doc_embedding,
          overview: input.overview,
          ..Default::default()
        },
      )
      .await?;

    self.invalidation.invalidate_workspace_settings(workspace_id).await;
    if publication_boundary_changed && let Err(error) = self.public_repository.invalidate_workspace(workspace_id).await
    {
      warn!(%workspace_id, %error, "workspace publication artifact invalidation failed");
    }
    Ok(workspace)
  }
}

/// Tri-state workspace-quota mutation.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum QuotaUpdate {
  #[default]
  Unchanged,
  Clear,
  Set(i64),
}

impl QuotaUpdate {
  pub fn is_unchanged(&self) -> bool {
    matches!(self, Self::Unchanged)
  }

  pub fn from_gql_inputs(quota_mb: Option<i32>, clear: Option<bool>) -> Self {
    if clear == Some(true) {
      return Self::Clear;
    }
    match quota_mb {
      Some(mb) if mb > 0 => Self::Set(i64::from(mb) * 1024 * 1024),
      Some(_) => Self::Clear,
      None => Self::Unchanged,
    }
  }

  pub fn from_bytes(quota_bytes: Option<i64>) -> Self {
    match quota_bytes {
      Some(bytes) if bytes > 0 => Self::Set(bytes),
      _ => Self::Unchanged,
    }
  }
}

/// Persistence port for workspace and member management.
///
/// This is a composite port: it covers both workspace CRUD and the membership
/// / invite-link operations that are closely coupled to it.  The infrastructure
/// implementation is `myoxus_infrastructure::workspace`.
#[async_trait]
pub trait WorkspaceStore: Send + Sync {
  /// Historical presentation is available only through this actor's persisted
  /// acceptance and current membership of its still-active result Workspace.
  async fn has_accepted_starter_package(
    &self,
    actor: UserId,
    package: &myoxus_domain::assistant_package::AssistantPackageIdentity,
  ) -> AuthResult<bool> {
    let _ = (actor, package);
    Err(AuthError::Storage(
      "workspace starter acceptance lookup unavailable".into(),
    ))
  }
  /// Accepted members of an active workspace only; failures are never absence.
  async fn has_accepted_member(&self, workspace_id: WorkspaceId, user_id: UserId) -> AuthResult<bool>;
  async fn accepted_member_by_email(&self, workspace_id: WorkspaceId, email: &str) -> AuthResult<Option<UserId>>;
  /// Ordered by case-insensitive display name, retaining the native lookup payload.
  async fn accepted_members_for_lookup(
    &self,
    workspace_id: WorkspaceId,
  ) -> AuthResult<Vec<myoxus_domain::entities::WorkspaceMemberLookupRow>>;

  /// Read persisted ownership, never infer it from membership or an OU link.
  /// `None` means the active workspace or its principal is unavailable.
  async fn read_owner_principal(
    &self,
    workspace_id: WorkspaceId,
  ) -> AuthResult<Option<(myoxus_domain::entities::OwnerPrincipalType, Uuid)>> {
    let _ = workspace_id;
    Err(AuthError::Storage("workspace owner read unavailable".into()))
  }
  async fn get_workspace_starter(
    &self,
    actor: UserId,
    request_id: Uuid,
    expected_fingerprint: Option<&str>,
  ) -> WorkspaceStarterResult<Option<WorkspaceStarterAllocation>> {
    let _ = (actor, request_id, expected_fingerprint);
    Err(AuthError::Storage("workspace starter persistence unavailable".into()).into())
  }
  async fn allocate_workspace_starter(
    &self,
    receipt: WorkspaceStarterReceipt,
    root_update: Vec<u8>,
  ) -> WorkspaceStarterResult<WorkspaceStarterAllocation> {
    let _ = (receipt, root_update);
    Err(AuthError::Storage("workspace starter persistence unavailable".into()).into())
  }
  async fn bind_workspace_setup(
    &self,
    accepted: &assistant_packages::AcceptedWorkspaceSetup,
    plan: myoxus_domain::assistant_package::AssistantPreparedWorkspaceSetup,
  ) -> WorkspaceStarterResult<assistant_packages::AcceptedWorkspaceSetup> {
    let _ = (accepted, plan);
    Err(AuthError::Storage("Workspace setup persistence unavailable".into()).into())
  }
  async fn publish_workspace_setup_database(
    &self,
    accepted: &assistant_packages::AcceptedWorkspaceSetup,
    component: &str,
    state: myoxus_domain::database::DatabaseInitialState,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> WorkspaceStarterResult<()> {
    let _ = (accepted, component, state, fence);
    Err(AuthError::Storage("Workspace setup persistence unavailable".into()).into())
  }
  async fn finish_workspace_setup(
    &self,
    accepted: &assistant_packages::AcceptedWorkspaceSetup,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> WorkspaceStarterResult<()> {
    let _ = (accepted, fence);
    Err(AuthError::Storage("Workspace setup persistence unavailable".into()).into())
  }
  async fn workspace_setup_package(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
  ) -> AuthResult<Option<WorkspaceSetupAssistanceReceipt>> {
    let _ = (actor, workspace);
    Err(AuthError::Storage("Workspace setup read unavailable".into()))
  }
  async fn get_context_documents(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
    fingerprint: Option<&str>,
  ) -> ContextDocumentStarterResult<Option<AcceptedContextDocuments>> {
    let _ = (actor, workspace, request, fingerprint);
    Err(AuthError::Storage("context document persistence unavailable".into()).into())
  }
  async fn accept_context_documents(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
    fingerprint: &str,
    plan: myoxus_domain::assistant_package::AssistantPreparedContextDocuments,
    admission: ContextDocumentAdmission,
    definition: myoxus_domain::workspace_automation::AcceptedAutomationDefinition,
  ) -> ContextDocumentStarterResult<AcceptedContextDocuments> {
    let _ = (actor, workspace, request, fingerprint, plan, admission, definition);
    Err(AuthError::Storage("context document persistence unavailable".into()).into())
  }
  async fn review_context_documents(
    &self,
    accepted: &AcceptedContextDocuments,
    admission: ContextDocumentAdmission,
  ) -> ContextDocumentStarterResult<AcceptedContextDocuments> {
    let _ = (accepted, admission);
    Err(AuthError::Storage("context document persistence unavailable".into()).into())
  }
  async fn stop_context_documents(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
  ) -> ContextDocumentStarterResult<AcceptedContextDocuments> {
    let _ = (actor, workspace, request);
    Err(AuthError::Storage("context document persistence unavailable".into()).into())
  }
  async fn get_project_starter(
    &self,
    actor: UserId,
    operation: StarterOperation,
    workspace: WorkspaceId,
    request: Uuid,
    fingerprint: Option<&str>,
  ) -> ProjectStarterResult<Option<AcceptedProjectStarter>> {
    let _ = (actor, operation, workspace, request, fingerprint);
    Err(AuthError::Storage("Project starter persistence unavailable".into()).into())
  }
  async fn accept_project_starter(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
    fingerprint: &str,
    plan: myoxus_domain::assistant_package::AssistantPreparedProject,
    admission: ProjectStarterAdmission,
  ) -> ProjectStarterResult<AcceptedProjectStarter> {
    let _ = (actor, workspace, request, fingerprint, plan, admission);
    Err(AuthError::Storage("Project starter persistence unavailable".into()).into())
  }
  async fn publish_project_starter(
    &self,
    actor: UserId,
    operation: StarterOperation,
    workspace: WorkspaceId,
    request: Uuid,
    fingerprint: &str,
    admission: ProjectStarterAdmission,
    review: myoxus_domain::assistant_package::AssistantPreparedProject,
    state: myoxus_domain::database::DatabaseInitialState,
  ) -> ProjectStarterResult<(AcceptedProjectStarter, myoxus_domain::database::DatabaseRecord)> {
    let _ = (
      actor,
      operation,
      workspace,
      request,
      fingerprint,
      admission,
      review,
      state,
    );
    Err(AuthError::Storage("Project starter persistence unavailable".into()).into())
  }
  async fn stop_project_starter(
    &self,
    actor: UserId,
    operation: StarterOperation,
    workspace: WorkspaceId,
    request: Uuid,
  ) -> ProjectStarterResult<AcceptedProjectStarter> {
    let _ = (actor, operation, workspace, request);
    Err(AuthError::Storage("Project starter persistence unavailable".into()).into())
  }
  /// Create a new workspace owned by `owner_id` and return it.
  async fn create_workspace(&self, owner_id: UserId, name: WorkspaceName) -> AuthResult<Workspace>;
  /// Create the user's single canonical personal userspace.
  async fn create_personal_workspace(&self, owner_id: UserId, name: WorkspaceName) -> AuthResult<Workspace> {
    self.create_workspace(owner_id, name).await
  }
  /// Atomically create an OU-owned shared workspace. The creator receives an
  /// accepted Admin membership, never Owner.
  async fn create_shared_workspace(
    &self,
    owner_unit_id: OrganizationUnitId,
    creator_id: UserId,
    name: WorkspaceName,
    root_update: Vec<u8>,
  ) -> AuthResult<Workspace> {
    let _ = (owner_unit_id, creator_id, name, root_update);
    Err(AuthError::InvalidInput(
      "workspace store does not support shared workspace creation".to_string(),
    ))
  }
  /// Create an import target with a preallocated identity but no membership.
  /// Until [`Self::publish_importing_workspace`] commits the owner membership,
  /// normal workspace lists and ACL checks cannot expose the partial target.
  async fn create_importing_workspace(
    &self,
    import_id: WorkspaceImportId,
    owner_id: UserId,
    workspace_id: WorkspaceId,
    name: WorkspaceName,
  ) -> AuthResult<Workspace> {
    let _ = (import_id, owner_id, workspace_id, name);
    Err(AuthError::InvalidInput(
      "workspace store does not support importing targets".to_string(),
    ))
  }
  /// Atomically publish an import target by adding its owner membership.
  async fn publish_importing_workspace(
    &self,
    import_id: WorkspaceImportId,
    workspace_id: WorkspaceId,
    owner_id: UserId,
  ) -> AuthResult<()> {
    let _ = (import_id, workspace_id, owner_id);
    Err(AuthError::InvalidInput(
      "workspace store does not support importing targets".to_string(),
    ))
  }
  /// Hard-delete an unpublished target. The no-membership predicate prevents
  /// cleanup from deleting a workspace that has already been published.
  async fn hard_delete_importing_workspace(
    &self,
    import_id: WorkspaceImportId,
    workspace_id: WorkspaceId,
  ) -> AuthResult<()> {
    let _ = (import_id, workspace_id);
    Err(AuthError::InvalidInput(
      "workspace store does not support importing targets".to_string(),
    ))
  }
  /// Resolve a nonactive workspace only for its owning durable operation.
  async fn get_internal_workspace(
    &self,
    workspace_id: WorkspaceId,
    lifecycle_state: WorkspaceLifecycleState,
    owner_kind: WorkspaceLifecycleOwnerKind,
    owner_id: Uuid,
  ) -> AuthResult<Option<Workspace>> {
    let _ = (workspace_id, lifecycle_state, owner_kind, owner_id);
    Err(AuthError::InvalidInput(
      "workspace store does not support internal lifecycle lookup".to_string(),
    ))
  }
  /// Fetch a workspace by ID, or `None` if not found / soft-deleted.
  async fn get_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<Option<Workspace>>;
  /// Resolve the workspace ownership classification used by client navigation.
  async fn workspace_classification(&self, workspace_id: WorkspaceId) -> AuthResult<Option<WorkspaceClassification>>;
  /// Return all workspaces the user is an accepted member of.
  async fn list_user_workspaces(&self, user_id: UserId) -> AuthResult<Vec<Workspace>>;
  /// Return whether the user manages at least one active accepted workspace.
  async fn has_managed_workspace(&self, user_id: UserId) -> AuthResult<bool> {
    for workspace in self.list_user_workspaces(user_id).await? {
      if let Some(member) = self.get_member(workspace.id, user_id).await?
        && matches!(member.role, WorkspaceRole::Admin | WorkspaceRole::Owner)
        && member.status == MembershipStatus::Accepted
      {
        return Ok(true);
      }
    }
    Ok(false)
  }
  /// Apply a partial update to a workspace.
  async fn update_workspace(&self, workspace_id: WorkspaceId, update: UpdateWorkspace) -> AuthResult<Workspace>;
  /// Delete (or soft-delete) the workspace.
  async fn delete_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<()>;
  /// Restore a soft-deleted workspace without changing its identity or members.
  async fn undelete_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<Workspace> {
    let _ = workspace_id;
    Err(AuthError::InvalidInput(
      "workspace store does not support workspace restoration".to_string(),
    ))
  }
  /// Transfer ownership to a user or OU as one workspace-level transaction.
  async fn transfer_workspace_owner(&self, workspace_id: WorkspaceId, target: WorkspaceOwnerTarget) -> AuthResult<()> {
    let _ = (workspace_id, target);
    Err(AuthError::InvalidInput(
      "workspace store does not support principal ownership transfer".to_string(),
    ))
  }
  /// Set or clear the operational management OU and its managed relationship.
  async fn set_management_unit(
    &self,
    workspace_id: WorkspaceId,
    management_unit_id: Option<OrganizationUnitId>,
  ) -> AuthResult<()> {
    let _ = (workspace_id, management_unit_id);
    Err(AuthError::InvalidInput(
      "workspace store does not support management-unit assignment".to_string(),
    ))
  }

  // Member management
  /// List workspace members with optional name/email search filter.
  async fn list_workspace_members(
    &self,
    workspace_id: WorkspaceId,
    skip: i64,
    take: i64,
    query: Option<String>,
  ) -> AuthResult<Vec<WorkspaceMember>>;
  /// Return the total number of members (accepted + pending).
  async fn count_workspace_members(&self, workspace_id: WorkspaceId) -> AuthResult<i64>;
  /// Return the owner's full [`User`] record.
  async fn get_workspace_owner(&self, workspace_id: WorkspaceId) -> AuthResult<Option<User>>;
  /// Upsert a membership record (insert or update role / status).
  async fn add_or_update_member(
    &self,
    workspace_id: WorkspaceId,
    user_id: UserId,
    role: WorkspaceRole,
    status: MembershipStatus,
    inviter_id: Option<UserId>,
  ) -> AuthResult<WorkspaceMember>;
  /// Fetch a single membership record.
  async fn get_member(&self, workspace_id: WorkspaceId, user_id: UserId) -> AuthResult<Option<WorkspaceMember>>;
  /// Fetch a member by their invite record ID.
  async fn get_member_by_invite_id(&self, invite_id: InviteLinkId) -> AuthResult<Option<WorkspaceMember>>;
  /// Remove a membership record.
  async fn delete_member(&self, workspace_id: WorkspaceId, user_id: UserId) -> AuthResult<()>;
  /// Update a member's role without changing their status.
  async fn update_member_role(&self, workspace_id: WorkspaceId, user_id: UserId, role: WorkspaceRole)
  -> AuthResult<()>;
  /// Atomically swap ownership from `current_owner_id` to `new_owner_id`,
  /// demoting the previous owner to Admin.
  async fn transfer_ownership(
    &self,
    workspace_id: WorkspaceId,
    current_owner_id: UserId,
    new_owner_id: UserId,
  ) -> AuthResult<()>;
  /// List workspaces that have no owner (orphaned after user deletion),
  /// ordered by creation date descending.
  async fn list_orphaned_workspaces(&self, skip: i64, take: i64) -> AuthResult<Vec<Workspace>>;
  /// Count orphaned workspaces.
  async fn count_orphaned_workspaces(&self) -> AuthResult<i64>;
  /// Assign a new owner to an orphaned (or any) workspace.  The new owner
  /// is added as a member with the `Owner` role if not already a member.
  async fn reassign_workspace_owner(&self, workspace_id: WorkspaceId, new_owner_id: UserId) -> AuthResult<()>;

  // Invite links
  /// Create an expiring invite link for the workspace.
  ///
  /// The `token_hash` parameter must be a pre-computed SHA-256 hex digest of the
  /// raw invite token.  The store never sees the plaintext token.
  async fn create_invite_link(
    &self,
    workspace_id: WorkspaceId,
    inviter_id: UserId,
    token_hash: &str,
    expire_at: DateTime<Utc>,
  ) -> AuthResult<WorkspaceInviteLink>;
  /// Return the current active invite link for the workspace.
  async fn get_invite_link(&self, workspace_id: WorkspaceId) -> AuthResult<Option<WorkspaceInviteLink>>;
  /// Look up an invite link by its token hash.
  async fn get_invite_link_by_token(&self, token_hash: &str) -> AuthResult<Option<WorkspaceInviteLink>>;
  /// Revoke the current invite link so it can no longer be used.
  async fn revoke_invite_link(&self, workspace_id: WorkspaceId) -> AuthResult<()>;

  /// Seed the workspace's root Yjs document with initial bytes.
  async fn init_workspace_root_doc(&self, workspace_id: WorkspaceId, user_id: UserId, data: Vec<u8>) -> AuthResult<()>;
  /// Return `true` if the workspace root document has been initialised.
  async fn workspace_root_doc_exists(&self, workspace_id: WorkspaceId) -> AuthResult<bool>;

  /// Return the user's personal workspace, if one exists.
  ///
  /// Personal is an explicit marker on exactly one active user-owned
  /// workspace. Additional workspaces owned by the same person are not the
  /// userspace and must never be returned here.
  async fn find_personal_workspace(&self, user_id: UserId) -> AuthResult<Option<Workspace>>;
}

/// High-level workspace service.
///
/// Coordinates workspace and membership operations, enforces business rules
/// (e.g. the owner cannot leave their own workspace), and publishes domain
/// events via an optional [`EventPublisher`].
#[derive(Clone)]
pub struct WorkspaceService {
  store: Arc<dyn WorkspaceStore>,
  event_publisher: Option<Arc<dyn EventPublisher>>,
  template_registry: Option<TemplateRegistryService>,
  automation: Option<Arc<crate::workspace_automation::WorkspaceAutomationService>>,
}

impl WorkspaceService {
  pub fn with_automation(mut self, automation: Arc<crate::workspace_automation::WorkspaceAutomationService>) -> Self {
    self.automation = Some(automation);
    self
  }
  async fn create_user_workspace_with_name(
    &self,
    owner_id: UserId,
    requested_name: Option<&str>,
    personal: bool,
    auto_suffix: bool,
  ) -> AuthResult<Workspace> {
    let mut candidate = match requested_name {
      Some(name) => workspace_name(name)?,
      None => WorkspaceName::default_name(),
    };
    for _ in 0..MAX_WORKSPACE_NAME_SUFFIX {
      let result = if personal {
        self.store.create_personal_workspace(owner_id, candidate.clone()).await
      } else {
        self.store.create_workspace(owner_id, candidate.clone()).await
      };
      match result {
        Err(AuthError::WorkspaceNameConflict { suggestion }) if auto_suffix => {
          candidate = workspace_name(&suggestion)?;
        }
        result => return result,
      }
    }
    Err(AuthError::InvalidInput(
      "workspace name suffix space is exhausted".to_string(),
    ))
  }

  /// Create a `WorkspaceService` without event publishing.
  pub fn new(store: Arc<dyn WorkspaceStore>) -> Self {
    Self {
      store,
      event_publisher: None,
      template_registry: None,
      automation: None,
    }
  }

  /// Create a `WorkspaceService` that publishes domain events to an outbox.
  pub fn new_with_events(store: Arc<dyn WorkspaceStore>, event_publisher: Arc<dyn EventPublisher>) -> Self {
    Self {
      store,
      event_publisher: Some(event_publisher),
      template_registry: None,
      automation: None,
    }
  }

  /// Attach a template registry service so that builtin template default
  /// policies are seeded automatically on every `create_workspace` call.
  pub fn with_template_registry(mut self, svc: TemplateRegistryService) -> Self {
    self.template_registry = Some(svc);
    self
  }

  /// Wire in a template registry service post-construction.
  pub fn set_template_registry(&mut self, svc: TemplateRegistryService) {
    self.template_registry = Some(svc);
  }

  async fn emit_event(
    &self,
    aggregate_type: &str,
    aggregate_id: String,
    event_type: OutboxEventType,
    payload: serde_json::Value,
  ) {
    let Some(event_publisher) = &self.event_publisher else {
      return;
    };
    let event_type_for_log = event_type.clone();
    if let Err(error) = event_publisher
      .publish(aggregate_type, &aggregate_id, event_type, payload)
      .await
    {
      warn!(
          aggregate_type,
          aggregate_id,
          event_type = ?event_type_for_log,
          error = %error,
          "failed to publish workspace outbox event"
      );
    }
  }

  /// Create a new workspace and seed its root document.
  ///
  /// If `init_data` is provided, it is used as the initial Yjs binary.
  /// Without uploaded bytes, only the root row is created. Callers needing a
  /// canonical initialized root use `seed_root_doc` with the final Workspace name.
  #[instrument(skip(self, init_data))]
  pub async fn create_workspace(
    &self,
    owner_id: UserId,
    name: Option<String>,
    init_data: Option<Vec<u8>>,
  ) -> AuthResult<Workspace> {
    info!(owner_id = %owner_id, "creating new workspace");
    let workspace = self
      .create_user_workspace_with_name(owner_id, name.as_deref(), false, name.is_none())
      .await?;

    // Only seed doc_updates when the caller explicitly supplies binary content.
    // When init_data is None the root docs row is still created (via
    // init_workspace_root_doc), but no update payload is written so the REST
    // endpoint returns an empty body until the client pushes its first sync.
    let data = init_data.unwrap_or_default();

    self.store.init_workspace_root_doc(workspace.id, owner_id, data).await?;

    // A workspace is not successfully provisioned when configured template
    // defaults could not be assigned. The existing assignment operation stays
    // available for an explicit authorized retry.
    if let Some(tpl) = &self.template_registry {
      let count = tpl.seed_default_policies_for_workspace(workspace.id).await?;
      debug!(workspace_id = %workspace.id, templates_seeded = count, "seeded template default policies for new workspace");
    }

    info!(workspace_id = %workspace.id, owner_id = %owner_id, "workspace created successfully");
    Ok(workspace)
  }

  /// Create an OU-owned shared workspace with an initialized root document.
  ///
  /// The application owns name normalization and canonical Yjs generation.
  /// Persistence receives only final values and commits the workspace,
  /// ownership, membership and root update as one transaction.
  #[instrument(skip(self))]
  pub async fn create_shared_workspace(
    &self,
    owner_unit_id: OrganizationUnitId,
    creator_id: UserId,
    name: Option<String>,
  ) -> AuthResult<Workspace> {
    let explicit = name.is_some();
    let mut candidate = match name.as_deref() {
      Some(name) => workspace_name(name)?,
      None => WorkspaceName::default_name(),
    };
    info!(%owner_unit_id, %creator_id, "creating shared workspace");
    let mut attempts = 0;
    let workspace = loop {
      attempts += 1;
      if attempts > MAX_WORKSPACE_NAME_SUFFIX {
        return Err(AuthError::InvalidInput(
          "workspace name suffix space is exhausted".to_string(),
        ));
      }
      let root_update = yjs::create_initial_workspace_doc(candidate.display());
      match self
        .store
        .create_shared_workspace(owner_unit_id, creator_id, candidate.clone(), root_update)
        .await
      {
        Err(AuthError::WorkspaceNameConflict { suggestion }) if !explicit => {
          candidate = workspace_name(&suggestion)?;
        }
        result => break result?,
      }
    };

    if let Some(registry) = &self.template_registry {
      registry.seed_default_policies_for_workspace(workspace.id).await?;
    }

    info!(workspace_id = %workspace.id, %owner_unit_id, %creator_id, "shared workspace created");
    Ok(workspace)
  }

  /// Return the one canonical personal workspace owned by `user_id`.
  ///
  /// Callers that authorize personal-workspace-only capabilities must compare
  /// the returned ID with the requested workspace. Ownership alone is
  /// insufficient because a user may own additional `UserOwned` workspaces.
  #[instrument(skip_all)]
  pub async fn find_personal_workspace(&self, user_id: UserId) -> AuthResult<Option<Workspace>> {
    self.store.find_personal_workspace(user_id).await
  }

  /// Provision a personal workspace for a user if they do not have one yet.
  ///
  /// **Invariant (INV-WS-01):** Every user must have exactly one personal
  /// workspace. This workspace is owned by the user and is created
  /// automatically the first time a user account is activated
  /// (sign-up via OAuth, admin creation, CLI creation).
  ///
  /// This method is **idempotent**: if the user already owns a personal
  /// workspace it is returned unchanged.  It is safe to call multiple times
  /// for the same `user_id`.
  ///
  /// # When NOT to call this
  ///
  /// Do not call this from `invite_members`.  An invited-but-not-yet-accepted
  /// user is a stub account — they have not registered.  Their personal
  /// workspace is created the first time they actually sign in (OAuth callback
  /// or equivalent).
  ///
  /// # Error handling
  ///
  /// If workspace creation fails (e.g. DB error), the error is propagated to
  /// the caller.  The caller should treat this as a hard failure and roll back
  /// or surface the error — a user without a personal workspace is in an
  /// invalid state (INV-WS-01 broken).
  /// Provision a personal workspace for a user if they do not have one yet.
  ///
  /// `display_name` is used as the workspace name (shown in the sidebar) and
  /// as the Yjs document name so the frontend can render it immediately without
  /// requiring a client-side initialisation roundtrip.  Passing `None` falls
  /// back to `"My Workspace"`.
  ///
  /// This method is **idempotent**: if the user already owns a personal
  /// workspace it is returned unchanged.  It is safe to call multiple times.
  #[instrument(skip(self))]
  pub async fn ensure_personal_workspace(&self, user_id: UserId, display_name: Option<&str>) -> AuthResult<Workspace> {
    // Fast path: user already has a personal workspace.
    if let Some(existing) = self.store.find_personal_workspace(user_id).await? {
      debug!(
        user_id = %user_id,
        workspace_id = %existing.id,
        "ensure_personal_workspace: personal workspace already exists, skipping creation"
      );
      return Ok(existing);
    }

    // Slow path: create the personal workspace with Yjs init data so the
    // frontend can render the workspace name immediately (without a client
    // initialisation roundtrip).  Empty Yjs means the sidebar shows nothing
    // until the client connects and pushes its first sync — that's the bug
    // this addresses (reported as "workspace leer/uninitialisiert").
    let name = display_name.unwrap_or("My Workspace");
    let init_data = yjs::create_initial_workspace_doc(name);

    info!(
      user_id = %user_id,
      workspace_name = name,
      "ensure_personal_workspace: no personal workspace found, provisioning one now"
    );
    let workspace = self
      .create_user_workspace_with_name(user_id, Some(name), true, true)
      .await?;
    self
      .store
      .init_workspace_root_doc(workspace.id, user_id, init_data)
      .await?;
    if let Some(registry) = &self.template_registry {
      registry.seed_default_policies_for_workspace(workspace.id).await?;
    }
    info!(
      user_id = %user_id,
      workspace_id = %workspace.id,
      "ensure_personal_workspace: personal workspace provisioned successfully"
    );
    Ok(workspace)
  }

  /// Seed the root doc of an existing workspace with initial Yjs content.
  ///
  /// Used by the CLI to fix workspaces created before root doc seeding was
  /// implemented. Safe to call on workspaces that already have content (the
  /// docs row uses `ON CONFLICT DO NOTHING`; the doc_updates row will fail
  /// harmlessly if sequence=1 already exists).
  #[instrument(skip(self, data))]
  pub async fn seed_root_doc(&self, workspace_id: WorkspaceId, owner_id: UserId, data: Vec<u8>) -> AuthResult<()> {
    self.store.init_workspace_root_doc(workspace_id, owner_id, data).await
  }

  /// Retrieve a workspace by ID.
  #[instrument(skip_all)]
  pub async fn get_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<Option<Workspace>> {
    self.store.get_workspace(workspace_id).await
  }

  /// Resolve the user-facing ownership classification for a workspace.
  pub async fn workspace_classification(
    &self,
    workspace_id: WorkspaceId,
  ) -> AuthResult<Option<WorkspaceClassification>> {
    self.store.workspace_classification(workspace_id).await
  }

  /// Return all workspaces the given user belongs to.
  #[instrument(skip_all)]
  pub async fn list_workspaces(&self, user_id: UserId) -> AuthResult<Vec<Workspace>> {
    self.store.list_user_workspaces(user_id).await
  }

  /// Return whether the user manages at least one active accepted workspace.
  pub async fn has_managed_workspace(&self, user_id: UserId) -> AuthResult<bool> {
    self.store.has_managed_workspace(user_id).await
  }

  /// Apply a partial settings update to a workspace.
  #[instrument(skip_all)]
  pub async fn update_workspace(&self, workspace_id: WorkspaceId, update: UpdateWorkspace) -> AuthResult<Workspace> {
    self.store.update_workspace(workspace_id, update).await
  }

  /// Delete a workspace (soft-delete in production).
  #[instrument(skip_all)]
  pub async fn delete_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<()> {
    self.store.delete_workspace(workspace_id).await
  }

  /// Restore a soft-deleted workspace idempotently.
  #[instrument(skip_all)]
  pub async fn undelete_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<Workspace> {
    self.store.undelete_workspace(workspace_id).await
  }

  /// Transfer workspace ownership to the selected user or organization unit.
  #[instrument(skip(self))]
  pub async fn transfer_workspace_owner(
    &self,
    workspace_id: WorkspaceId,
    target: WorkspaceOwnerTarget,
  ) -> AuthResult<()> {
    info!(%workspace_id, ?target, "transferring workspace principal ownership");
    self.store.transfer_workspace_owner(workspace_id, target).await
  }

  /// Set or clear the workspace's operational management unit.
  #[instrument(skip(self))]
  pub async fn set_management_unit(
    &self,
    workspace_id: WorkspaceId,
    management_unit_id: Option<OrganizationUnitId>,
  ) -> AuthResult<()> {
    info!(%workspace_id, ?management_unit_id, "updating workspace management unit");
    self.store.set_management_unit(workspace_id, management_unit_id).await
  }

  /// Return `true` if the workspace root document has been seeded.
  #[instrument(skip_all)]
  pub async fn is_initialized(&self, workspace_id: WorkspaceId) -> AuthResult<bool> {
    self.store.workspace_root_doc_exists(workspace_id).await
  }

  /// Return the total number of members in a workspace.
  #[instrument(skip_all)]
  pub async fn member_count(&self, workspace_id: WorkspaceId) -> AuthResult<i64> {
    self.store.count_workspace_members(workspace_id).await
  }

  /// List members of a workspace with optional search and pagination.
  #[instrument(skip_all)]
  pub async fn list_members(
    &self,
    workspace_id: WorkspaceId,
    skip: i64,
    take: i64,
    query: Option<String>,
  ) -> AuthResult<Vec<WorkspaceMember>> {
    self.store.list_workspace_members(workspace_id, skip, take, query).await
  }

  /// Fetch a specific member record.
  #[instrument(skip_all)]
  pub async fn get_member(&self, workspace_id: WorkspaceId, user_id: UserId) -> AuthResult<Option<WorkspaceMember>> {
    self.store.get_member(workspace_id, user_id).await
  }

  /// Classify a membership mutation from the current target, never from the
  /// actor's raw role. Callers assert this action through PermissionService so
  /// effective OU-manager authority remains available. Owner requests are
  /// executed only by the separate ownership-transfer transaction.
  #[instrument(skip_all)]
  pub async fn membership_mutation_action(
    &self,
    workspace_id: WorkspaceId,
    actor: UserId,
    target: UserId,
    requested: Option<WorkspaceRole>,
  ) -> AuthResult<WorkspaceAction> {
    if requested.is_none() && actor == target {
      return Err(AuthError::InvalidInput("CanNotRevokeYourself".into()));
    }
    let member = self
      .get_member(workspace_id, target)
      .await?
      .ok_or_else(|| AuthError::InvalidInput("MemberNotFoundInSpace".into()))?;
    crate::permission::required_membership_mutation_action(member.role, requested)
  }

  /// Fetch a member record by its invite record ID.
  #[instrument(skip_all)]
  pub async fn get_member_by_invite_id(&self, invite_id: InviteLinkId) -> AuthResult<Option<WorkspaceMember>> {
    self.store.get_member_by_invite_id(invite_id).await
  }

  /// Return the workspace owner's full user record.
  #[instrument(skip_all)]
  pub async fn get_owner(&self, workspace_id: WorkspaceId) -> AuthResult<Option<User>> {
    self.store.get_workspace_owner(workspace_id).await
  }

  /// Invite a list of email addresses to the workspace.
  ///
  /// For each address, a user account is fulfilled (created if necessary) and
  /// a pending membership is created.  Returns one result per address so that
  /// callers can report partial failures.
  #[instrument(skip(self, emails, auth_store))]
  pub async fn invite_members(
    &self,
    workspace_id: WorkspaceId,
    inviter_id: UserId,
    emails: Vec<String>,
    auth_store: Arc<dyn crate::auth::AuthStore>,
  ) -> AuthResult<Vec<AuthResult<WorkspaceMember>>> {
    info!(workspace_id = %workspace_id, inviter_id = %inviter_id, count = emails.len(), "inviting members to workspace");
    let mut results = Vec::new();

    for email in emails {
      let res = async {
        let email = email.to_lowercase();
        let user = auth_store.fulfill_user(&email, None, None).await?;

        if let Some(m) = self.store.get_member(workspace_id, user.id).await?
          && m.status == MembershipStatus::Accepted
        {
          return Err(AuthError::InvalidInput("AlreadyInSpace".to_string()));
        }

        let member = self
          .store
          .add_or_update_member(
            workspace_id,
            user.id,
            WorkspaceRole::Collaborator,
            MembershipStatus::Pending,
            Some(inviter_id),
          )
          .await?;
        self
          .emit_event(
            "workspace",
            workspace_id.to_string(),
            OutboxEventType::Invite,
            serde_json::json!({
                "workspaceId": workspace_id,
                "inviterId": inviter_id,
                "invitedUserId": user.id,
                "email": email,
                "kind": "member_invite"
            }),
          )
          .await;
        Ok(member)
      }
      .await;
      results.push(res);
    }

    Ok(results)
  }

  /// Invite a user by their user ID (direct invite, no email fulfillment).
  ///
  /// Creates a Pending membership for an existing user and emits an `Invite`
  /// outbox event with `kind: "direct_invite"`.  Returns
  /// `Err(InvalidInput("AlreadyInSpace"))` if the user is already Accepted.
  #[instrument(skip(self))]
  pub async fn invite_member_by_id(
    &self,
    workspace_id: WorkspaceId,
    inviter_id: UserId,
    user_id: UserId,
  ) -> AuthResult<WorkspaceMember> {
    info!(workspace_id = %workspace_id, inviter_id = %inviter_id, user_id = %user_id, "inviting member by user ID");
    if let Some(m) = self.store.get_member(workspace_id, user_id).await?
      && m.status == MembershipStatus::Accepted
    {
      return Err(AuthError::InvalidInput("AlreadyInSpace".to_string()));
    }
    let member = self
      .store
      .add_or_update_member(
        workspace_id,
        user_id,
        WorkspaceRole::Collaborator,
        MembershipStatus::Pending,
        Some(inviter_id),
      )
      .await?;
    self
      .emit_event(
        "workspace",
        workspace_id.to_string(),
        OutboxEventType::Invite,
        serde_json::json!({
            "workspaceId": workspace_id,
            "inviterId": inviter_id,
            "invitedUserId": user_id,
            "kind": "direct_invite"
        }),
      )
      .await;
    Ok(member)
  }

  /// Accept a pending workspace invite by its invite record ID.
  ///
  /// Returns `true` on success.  Returns `Err(ActionForbidden)` if the
  /// invite belongs to a different user.
  #[instrument(skip(self))]
  pub async fn accept_invite_by_id(&self, user_id: UserId, invite_id: InviteLinkId) -> AuthResult<bool> {
    info!(user_id = %user_id, invite_id = %invite_id, "accepting workspace invite");
    let Some(member) = self.store.get_member_by_invite_id(invite_id).await? else {
      warn!(invite_id = %invite_id, "invite not found");
      return Err(AuthError::TokenNotFound);
    };

    if member.user.id != user_id {
      warn!(user_id = %user_id, invite_user_id = %member.user.id, "user mismatch for invite");
      return Err(AuthError::ActionForbidden);
    }

    if member.status == MembershipStatus::Accepted {
      return Ok(true);
    }

    self
      .store
      .add_or_update_member(
        member.workspace_id,
        user_id,
        member.role,
        MembershipStatus::Accepted,
        None,
      )
      .await?;
    self
      .emit_event(
        "workspace",
        member.workspace_id.to_string(),
        OutboxEventType::AccessChange,
        serde_json::json!({
            "workspaceId": member.workspace_id,
            "userId": user_id,
            "action": "invite_accepted",
            "inviterId": member.invited_by_user_id,
            "inviteId": invite_id
        }),
      )
      .await;

    info!(user_id = %user_id, workspace_id = %member.workspace_id, "invite accepted");
    Ok(true)
  }

  /// Create a new invite link expiring `expire_time_ms` milliseconds from now.
  ///
  /// Generates a raw UUID token and stores it as-is in `token_hash`.
  /// Returns the persisted link so the caller can hand the token to the end-user.
  #[instrument(skip(self))]
  pub async fn create_invite_link(
    &self,
    workspace_id: WorkspaceId,
    inviter_id: UserId,
    expire_time_ms: i64,
  ) -> AuthResult<WorkspaceInviteLink> {
    info!(workspace_id = %workspace_id, inviter_id = %inviter_id, "creating invite link");

    // Use a raw UUID token — stored as-is (token_hash field stores the token directly).
    // This keeps createInviteLink.link == workspace.inviteLink.link for API compatibility.
    let token = uuid::Uuid::new_v4().to_string();

    let expire_at = Utc::now() + Duration::milliseconds(expire_time_ms);
    let link = self
      .store
      .create_invite_link(workspace_id, inviter_id, &token, expire_at)
      .await?;

    self
      .emit_event(
        "workspace",
        workspace_id.to_string(),
        OutboxEventType::Invite,
        serde_json::json!({
            "workspaceId": workspace_id,
            "inviterId": inviter_id,
            "inviteLinkId": link.id,
            "expiresAt": link.expires_at
        }),
      )
      .await;
    Ok(link)
  }

  /// Return the current active invite link for a workspace.
  #[instrument(skip(self))]
  pub async fn get_invite_link(&self, workspace_id: WorkspaceId) -> AuthResult<Option<WorkspaceInviteLink>> {
    self.store.get_invite_link(workspace_id).await
  }

  /// Look up an invite link by its raw token string.
  ///
  /// The deployed `token_hash` column stores this opaque token unchanged.
  #[instrument(skip_all)]
  pub async fn get_invite_link_by_token(&self, token: &str) -> AuthResult<Option<WorkspaceInviteLink>> {
    // Token is stored as-is (not hashed) — look up directly.
    self.store.get_invite_link_by_token(token).await
  }

  /// Revoke the current invite link for a workspace.
  #[instrument(skip(self))]
  pub async fn revoke_invite_link(&self, workspace_id: WorkspaceId) -> AuthResult<()> {
    info!(workspace_id = %workspace_id, "revoking invite link");
    self.store.revoke_invite_link(workspace_id).await
  }

  /// Join a workspace using a shareable invite link token.
  ///
  /// New members are placed in `UnderReview` status (matching AFFiNE
  /// semantics); existing pending members are immediately accepted.
  #[instrument(skip_all)]
  pub async fn accept_invite_by_link(&self, user_id: UserId, token: &str) -> AuthResult<bool> {
    info!(user_id = %user_id, "joining workspace via link");
    // Token is stored as-is — look up directly.
    let Some(link) = self.store.get_invite_link_by_token(token).await? else {
      warn!("invalid or expired invite link token");
      return Err(AuthError::InvalidToken);
    };

    if let Some(expires) = link.expires_at
      && expires <= Utc::now()
    {
      warn!("invite link expired");
      return Err(AuthError::ExpiredToken);
    }

    if link.revoked_at.is_some() {
      warn!("invite link revoked");
      return Err(AuthError::InvalidToken);
    }

    // Check if already a member
    if let Some(m) = self.store.get_member(link.workspace_id, user_id).await? {
      if m.status == MembershipStatus::Accepted {
        return Ok(true);
      }
      if m.status == MembershipStatus::UnderReview {
        return Ok(true);
      }
      // If pending, just accept
      if m.status == MembershipStatus::Pending {
        self
          .store
          .add_or_update_member(link.workspace_id, user_id, m.role, MembershipStatus::Accepted, None)
          .await?;
        self
          .emit_event(
            "workspace",
            link.workspace_id.to_string(),
            OutboxEventType::AccessChange,
            serde_json::json!({
                "workspaceId": link.workspace_id,
                "userId": user_id,
                "action": "invite_link_pending_accepted"
            }),
          )
          .await;
        return Ok(true);
      }
    }

    // Create new membership record - usually link joins are UnderReview in AFFiNE
    self
      .store
      .add_or_update_member(
        link.workspace_id,
        user_id,
        WorkspaceRole::Collaborator,
        MembershipStatus::UnderReview,
        Some(link.created_by_user_id),
      )
      .await?;
    self
      .emit_event(
        "workspace",
        link.workspace_id.to_string(),
        OutboxEventType::AccessChange,
        serde_json::json!({
            "workspaceId": link.workspace_id,
            "userId": user_id,
            "action": "invite_link_joined_under_review"
        }),
      )
      .await;

    info!(user_id = %user_id, workspace_id = %link.workspace_id, "joined via link, status: UnderReview");
    Ok(true)
  }

  /// Add a user directly to a workspace with `Accepted` status (admin action).
  ///
  /// Unlike `invite_members`, this bypasses the invite flow and immediately
  /// grants full access. Returns `Err(InvalidInput("AlreadyInSpace"))` if the
  /// user is already an `Accepted` member.
  #[instrument(skip(self))]
  pub async fn add_member_direct(
    &self,
    workspace_id: WorkspaceId,
    user_id: UserId,
    role: WorkspaceRole,
    added_by: UserId,
  ) -> AuthResult<WorkspaceMember> {
    info!(workspace_id = %workspace_id, user_id = %user_id, ?role, "admin adding member directly");

    if let Some(m) = self.store.get_member(workspace_id, user_id).await?
      && m.status == MembershipStatus::Accepted
    {
      return Err(AuthError::InvalidInput("AlreadyInSpace".to_string()));
    }

    let member = self
      .store
      .add_or_update_member(workspace_id, user_id, role, MembershipStatus::Accepted, Some(added_by))
      .await?;
    self
      .emit_event(
        "workspace",
        workspace_id.to_string(),
        OutboxEventType::AccessChange,
        serde_json::json!({
            "workspaceId": workspace_id,
            "userId": user_id,
            "addedBy": added_by,
            "action": "admin_added"
        }),
      )
      .await;
    Ok(member)
  }

  /// Remove the user from the workspace.
  ///
  /// The workspace owner cannot leave; they must transfer ownership first.
  #[instrument(skip(self))]
  pub async fn leave_workspace(&self, user_id: UserId, workspace_id: WorkspaceId) -> AuthResult<bool> {
    info!(user_id = %user_id, workspace_id = %workspace_id, "user leaving workspace");
    let ws = self
      .store
      .get_workspace(workspace_id)
      .await?
      .ok_or(AuthError::Storage("Workspace not found".into()))?;
    if ws.owner_user_id == Some(user_id) {
      warn!(user_id = %user_id, workspace_id = %workspace_id, "owner cannot leave workspace");
      return Err(AuthError::ActionForbidden);
    }
    self.store.delete_member(workspace_id, user_id).await?;
    Ok(true)
  }

  /// Remove a member from the workspace (admin action).
  #[instrument(skip(self))]
  pub async fn revoke_member(&self, workspace_id: WorkspaceId, user_id: UserId) -> AuthResult<bool> {
    info!(user_id = %user_id, workspace_id = %workspace_id, "revoking member from workspace");
    let Some(previous) = self.store.get_member(workspace_id, user_id).await? else {
      return Ok(true);
    };
    self.store.delete_member(workspace_id, user_id).await?;
    self
      .emit_event(
        "workspace",
        workspace_id.to_string(),
        OutboxEventType::AccessChange,
        serde_json::json!({
            "workspaceId": workspace_id,
            "userId": user_id,
            "action": "member_revoked",
            "underReview": previous.status == MembershipStatus::UnderReview
        }),
      )
      .await;
    Ok(true)
  }

  /// Approve a member whose status is `UnderReview`, granting them full access.
  #[instrument(skip(self))]
  pub async fn approve_member(&self, workspace_id: WorkspaceId, user_id: UserId) -> AuthResult<bool> {
    let member = self.store.get_member(workspace_id, user_id).await?;
    let Some(member) = member else {
      return Err(AuthError::InvalidInput("MemberNotFoundInSpace".to_string()));
    };
    if member.status == MembershipStatus::Accepted {
      return Ok(true);
    }
    self
      .store
      .add_or_update_member(workspace_id, user_id, member.role, MembershipStatus::Accepted, None)
      .await?;
    self
      .emit_event(
        "workspace",
        workspace_id.to_string(),
        OutboxEventType::AccessChange,
        serde_json::json!({
            "workspaceId": workspace_id,
            "userId": user_id,
            "action": "member_approved"
        }),
      )
      .await;
    Ok(true)
  }

  /// Transfer workspace ownership to another member.
  ///
  /// The current owner is demoted to Admin and the new owner is promoted to
  /// Owner atomically.
  #[instrument(skip(self))]
  pub async fn transfer_ownership(
    &self,
    workspace_id: WorkspaceId,
    current_owner_id: UserId,
    new_owner_id: UserId,
  ) -> AuthResult<bool> {
    info!(workspace_id = %workspace_id, from = %current_owner_id, to = %new_owner_id, "transferring workspace ownership");
    self
      .store
      .transfer_ownership(workspace_id, current_owner_id, new_owner_id)
      .await?;
    self
      .emit_event(
        "workspace",
        workspace_id.to_string(),
        OutboxEventType::AccessChange,
        serde_json::json!({
            "workspaceId": workspace_id,
            "previousOwnerId": current_owner_id,
            "newOwnerId": new_owner_id,
            "action": "ownership_transferred"
        }),
      )
      .await;
    Ok(true)
  }

  /// List workspaces that have no owner (orphaned), paginated.
  #[instrument(skip(self))]
  pub async fn list_orphaned(&self, skip: i64, take: i64) -> AuthResult<Vec<Workspace>> {
    self.store.list_orphaned_workspaces(skip, take).await
  }

  /// Count of orphaned workspaces.
  #[instrument(skip_all)]
  pub async fn count_orphaned(&self) -> AuthResult<i64> {
    self.store.count_orphaned_workspaces().await
  }

  /// Assign a new owner to an orphaned workspace.  The new owner is added as
  /// a member with `Owner` role if not already present.
  #[instrument(skip(self))]
  pub async fn reassign_owner(&self, workspace_id: WorkspaceId, new_owner_id: UserId) -> AuthResult<()> {
    info!(workspace_id = %workspace_id, new_owner_id = %new_owner_id, "reassigning orphaned workspace owner");
    self.store.reassign_workspace_owner(workspace_id, new_owner_id).await
  }

  /// Change a member's role and publish an `AccessChange` event.
  #[instrument(skip(self))]
  pub async fn update_member_role(
    &self,
    workspace_id: WorkspaceId,
    user_id: UserId,
    role: WorkspaceRole,
  ) -> AuthResult<bool> {
    info!(workspace_id = %workspace_id, user_id = %user_id, role = ?role, "updating member role");
    let previous = self
      .store
      .get_member(workspace_id, user_id)
      .await?
      .ok_or_else(|| AuthError::InvalidInput("MemberNotFoundInSpace".into()))?;
    if previous.role == role {
      return Ok(true);
    }
    self.store.update_member_role(workspace_id, user_id, role).await?;
    self
      .emit_event(
        "workspace",
        workspace_id.to_string(),
        OutboxEventType::AccessChange,
        serde_json::json!({
            "workspaceId": workspace_id,
            "userId": user_id,
            "role": format!("{role:?}"),
            "action": "member_role_updated"
        }),
      )
      .await;
    Ok(true)
  }
}

#[cfg(test)]
mod workspace_input_tests {
  use super::*;

  #[test]
  fn workspace_name_normalizes_unicode_and_whitespace_once() {
    let composed = WorkspaceName::parse("  Café\u{2003}Workspace  ").unwrap();
    let decomposed = WorkspaceName::parse("Cafe\u{301}  Workspace").unwrap();
    assert_eq!(composed.display(), "Café Workspace");
    assert_eq!(composed.normalized(), decomposed.normalized());
  }

  #[test]
  fn workspace_name_rejects_controls_and_bounds_suffixes() {
    assert_eq!(
      WorkspaceName::parse("name\u{0000}").unwrap_err(),
      WorkspaceNameError::ControlCharacter
    );
    assert_eq!(
      WorkspaceName::parse(&"x".repeat(MAX_WORKSPACE_NAME_CODEPOINTS + 1)).unwrap_err(),
      WorkspaceNameError::TooLong
    );
    let maximum = WorkspaceName::parse(&"x".repeat(MAX_WORKSPACE_NAME_CODEPOINTS)).unwrap();
    let suffixed = maximum.with_suffix(10_000).unwrap();
    assert_eq!(suffixed.display().chars().count(), MAX_WORKSPACE_NAME_CODEPOINTS);
    assert!(suffixed.display().ends_with(" (10000)"));
  }
}
