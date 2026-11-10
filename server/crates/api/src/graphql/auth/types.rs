//! GraphQL output types and input objects for the authenticated API surface.
//!
//! Defines the `SimpleObject`, `InputObject`, `Enum`, and `Union` types that
//! are shared across multiple resolver modules (user profile, workspace info,
//! permissions, invitations, blob metadata, etc.). All types implement
//! `async_graphql` derive macros for automatic schema generation.

use async_graphql::{Enum, ID, InputObject, MaybeUndefined, SimpleObject, Union};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

use myoxus_application::auth::{
  AssistanceMode, AssistanceSource, AuthUser, AuthUserProjection, EffectiveAssistance, EffectiveUserPreferences,
  UserPreferences, WorkbenchToolId, WorkbenchToolLayout, WorkbenchViewFamily, WorkspaceDashboardDashletId,
  WorkspaceDashboardDashletSize, WorkspaceDashboardDashletSizeOverride, WorkspaceDashboardLayout,
};
use myoxus_contracts::client_update::{
  ClientUpdateCompletion, ClientUpdateCompletionAction, ClientUpdateControlV1, ClientUpdatePhase,
};
use myoxus_domain::entities::{
  MembershipStatus as MembershipStatusModel, User, Workspace, WorkspaceMember, WorkspaceRole as WorkspaceRoleModel,
};
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::workspace_content_operation::WorkspaceContentResourceRef;
use myoxus_domain::workspace_overview::{
  OverviewSettingsScope, WorkspaceOverviewSettings, WorkspaceOverviewSettingsPatch,
};

use super::workspace_content_operation::WorkspaceContentResourceInput;

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "ClientUpdatePhase", rename_items = "snake_case")]
pub enum ClientUpdatePhaseType {
  Normal,
  Limited,
  Suspended,
  Failed,
}

impl From<ClientUpdatePhase> for ClientUpdatePhaseType {
  fn from(value: ClientUpdatePhase) -> Self {
    match value {
      ClientUpdatePhase::Normal => Self::Normal,
      ClientUpdatePhase::Limited => Self::Limited,
      ClientUpdatePhase::Suspended => Self::Suspended,
      ClientUpdatePhase::Failed => Self::Failed,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "ClientUpdateCompletionAction", rename_items = "snake_case")]
pub enum ClientUpdateCompletionActionType {
  None,
  Reload,
  ResetLocalCache,
}

impl From<ClientUpdateCompletionAction> for ClientUpdateCompletionActionType {
  fn from(value: ClientUpdateCompletionAction) -> Self {
    match value {
      ClientUpdateCompletionAction::None => Self::None,
      ClientUpdateCompletionAction::Reload => Self::Reload,
      ClientUpdateCompletionAction::ResetLocalCache => Self::ResetLocalCache,
    }
  }
}

#[derive(Debug, SimpleObject, Clone)]
#[graphql(name = "ClientUpdateCompletion")]
pub struct ClientUpdateCompletionType {
  pub operation_id: ID,
  pub action: ClientUpdateCompletionActionType,
}

impl From<ClientUpdateCompletion> for ClientUpdateCompletionType {
  fn from(value: ClientUpdateCompletion) -> Self {
    Self {
      operation_id: ID::from(value.operation_id.to_string()),
      action: value.action.into(),
    }
  }
}

#[derive(Debug, SimpleObject, Clone)]
#[graphql(name = "ClientUpdateControlV1")]
pub struct ClientUpdateControlType {
  pub schema_version: i32,
  pub state_id: ID,
  pub phase: ClientUpdatePhaseType,
  pub operation_id: Option<ID>,
  pub max_attempts: Option<i32>,
  pub retry_after_ms: Option<i32>,
  pub completion: Option<ClientUpdateCompletionType>,
  pub required_web_build_id: Option<String>,
  pub cache_epoch: i32,
  pub updated_at: String,
}

impl From<ClientUpdateControlV1> for ClientUpdateControlType {
  fn from(value: ClientUpdateControlV1) -> Self {
    Self {
      schema_version: i32::from(value.schema_version),
      state_id: ID::from(value.state_id.to_string()),
      phase: value.phase.into(),
      operation_id: value.operation_id.map(|id| ID::from(id.to_string())),
      max_attempts: value.max_attempts.map(i32::from),
      retry_after_ms: value.retry_after_ms.map(|value| value as i32),
      completion: value.completion.map(Into::into),
      required_web_build_id: value.required_web_build_id,
      cache_epoch: value.cache_epoch as i32,
      updated_at: value.updated_at,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseDocumentReferenceKind", rename_items = "PascalCase")]
pub enum DatabaseDocumentReferenceKindType {
  RowContentDocument,
  DocumentLinkField,
  TaskSource,
}

impl From<myoxus_domain::database::DatabaseDocumentReferenceKind> for DatabaseDocumentReferenceKindType {
  fn from(value: myoxus_domain::database::DatabaseDocumentReferenceKind) -> Self {
    match value {
      myoxus_domain::database::DatabaseDocumentReferenceKind::RowContentDocument => Self::RowContentDocument,
      myoxus_domain::database::DatabaseDocumentReferenceKind::DocumentLinkField => Self::DocumentLinkField,
      myoxus_domain::database::DatabaseDocumentReferenceKind::TaskSource => Self::TaskSource,
    }
  }
}

#[derive(Debug, SimpleObject, Clone)]
#[graphql(name = "DatabaseDocumentReferenceType")]
pub struct DatabaseDocumentReferenceObjectType {
  pub target_workspace_id: Option<ID>,
  pub database_id: ID,
  pub database_title: String,
  pub row_id: ID,
  pub row_title: String,
  pub field_id: Option<ID>,
  pub field_name: Option<String>,
  pub reference_kind: DatabaseDocumentReferenceKindType,
  pub raw_target_doc_id: String,
  pub target_doc_id: Option<ID>,
  pub refreshed_at: DateTime<Utc>,
}

impl From<myoxus_domain::database::DatabaseDocumentReference> for DatabaseDocumentReferenceObjectType {
  fn from(value: myoxus_domain::database::DatabaseDocumentReference) -> Self {
    Self {
      target_workspace_id: value.target_workspace_id.map(ID::from),
      database_id: ID::from(value.database_id.to_string()),
      database_title: value.database_title,
      row_id: ID::from(value.row_id.to_string()),
      row_title: value.row_title,
      field_id: value.field_id.map(|id| ID::from(id.to_string())),
      field_name: value.field_name,
      reference_kind: value.reference_kind.into(),
      raw_target_doc_id: value.raw_target_doc_id,
      target_doc_id: value.resolved_target_doc_id.map(|id| ID::from(id.to_string())),
      refreshed_at: value.refreshed_at,
    }
  }
}

/// GraphQL enum of supported OAuth provider identifiers.
#[derive(Enum, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[graphql(name = "OAuthProviderType", rename_items = "PascalCase")]
pub enum OAuthProviderType {
  Google,
  GitHub,
  #[graphql(name = "OIDC")]
  Oidc,
  Apple,
}

/// GraphQL enum representing the role (permission level) of a workspace member.
///
/// Named `"Permission"` in the GraphQL schema for backward compatibility.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "Permission")]
pub enum WorkspaceRole {
  #[graphql(name = "Admin")]
  Admin,
  #[graphql(name = "Manager")]
  Manager,
  #[graphql(name = "Collaborator")]
  Collaborator,
  #[graphql(name = "Commenter")]
  Commenter,
  #[graphql(name = "Reader")]
  Reader,
  #[graphql(name = "Owner")]
  Owner,
  #[graphql(name = "External")]
  External,
}

impl From<WorkspaceRoleModel> for WorkspaceRole {
  fn from(role: WorkspaceRoleModel) -> Self {
    match role {
      WorkspaceRoleModel::Admin => Self::Admin,
      WorkspaceRoleModel::Manager => Self::Manager,
      WorkspaceRoleModel::Collaborator => Self::Collaborator,
      WorkspaceRoleModel::Commenter => Self::Commenter,
      WorkspaceRoleModel::Reader => Self::Reader,
      WorkspaceRoleModel::Owner => Self::Owner,
      WorkspaceRoleModel::External => Self::External,
    }
  }
}

/// GraphQL enum for the lifecycle state of a workspace membership invitation.
#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum WorkspaceMemberStatus {
  /// Invitation sent but not yet accepted.
  Pending,
  /// Membership is being reviewed by the workspace owner.
  UnderReview,
  /// A seat is being allocated for the new member.
  AllocatingSeat,
  /// The workspace has no available seats for this member.
  NeedMoreSeat,
  /// Membership is active.
  Accepted,
  /// Membership was revoked.
  Revoked,
}

impl From<MembershipStatusModel> for WorkspaceMemberStatus {
  fn from(status: MembershipStatusModel) -> Self {
    match status {
      MembershipStatusModel::Pending => Self::Pending,
      MembershipStatusModel::UnderReview => Self::UnderReview,
      MembershipStatusModel::AllocatingSeat => Self::AllocatingSeat,
      MembershipStatusModel::NeedMoreSeat => Self::NeedMoreSeat,
      MembershipStatusModel::Accepted => Self::Accepted,
      MembershipStatusModel::Revoked => Self::Revoked,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceInitialContent", rename_items = "PascalCase")]
pub enum WorkspaceInitialContentType {
  Empty,
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceInitialContentPolicy", rename_items = "PascalCase")]
pub enum WorkspaceInitialContentPolicyType {
  LegacyDefaults,
  Empty,
}
impl From<myoxus_domain::entities::WorkspaceInitialContentPolicy> for WorkspaceInitialContentPolicyType {
  fn from(value: myoxus_domain::entities::WorkspaceInitialContentPolicy) -> Self {
    match value {
      myoxus_domain::entities::WorkspaceInitialContentPolicy::LegacyDefaults => Self::LegacyDefaults,
      myoxus_domain::entities::WorkspaceInitialContentPolicy::Empty => Self::Empty,
    }
  }
}
#[derive(InputObject)]
pub struct CreateWorkspaceInput {
  pub name: String,
  pub initial_content: WorkspaceInitialContentType,
  pub assistance_mode: AssistanceModeType,
  pub request_id: ID,
  pub assistant_confirmation: super::database::WorkspaceAssistantConfirmationInput,
  pub project: Option<super::database::WorkspaceProjectSetupInput>,
  pub setup: Option<super::database::WorkspaceSetupInput>,
  pub admission_confirmation: Option<String>,
}
#[derive(InputObject)]
pub struct StopWorkspaceCreationInput {
  pub request_id: ID,
}
#[derive(InputObject)]
pub struct RetryWorkspaceCreationInput {
  pub request_id: ID,
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceCreationStatus", rename_items = "PascalCase")]
pub enum WorkspaceCreationStatusType {
  Ready,
  AssistancePending,
  Unavailable,
}
#[derive(SimpleObject)]
pub struct WorkspaceCreationResultType {
  pub setup: Option<super::database::WorkspaceSetupObjectType>,
  pub workspace_id: ID,
  pub accepted_plan: Option<super::database::PreparedWorkspaceAssistantObjectType>,
  pub project_setup: Option<super::database::ProjectSetupObjectType>,
  pub request_id: ID,
  pub status: WorkspaceCreationStatusType,
  pub root_ready: bool,
  pub tasks_ready: bool,
  pub tasks_database_id: Option<ID>,
  pub assistance_saved: bool,
  pub retry_required: bool,
  pub reason_code: Option<String>,
}
impl TryFrom<&myoxus_application::workspace::WorkspaceCreationOutcome> for WorkspaceCreationResultType {
  type Error = async_graphql::Error;
  fn try_from(value: &myoxus_application::workspace::WorkspaceCreationOutcome) -> async_graphql::Result<Self> {
    use myoxus_application::workspace::WorkspaceCreationStatus as S;
    Ok(Self {
      setup: value
        .setup
        .clone()
        .map(super::database::map_workspace_setup)
        .transpose()?,
      workspace_id: ID(value.allocation.workspace.id.to_string()),
      accepted_plan: value
        .allocation
        .receipt
        .prepared
        .clone()
        .map(|plan| (value.allocation.receipt.actor_id, plan).try_into())
        .transpose()?,
      project_setup: value
        .project
        .clone()
        .map(super::database::map_project_setup)
        .transpose()?,
      request_id: value.allocation.receipt.request_id.to_string().into(),
      status: match value.status {
        S::Ready => WorkspaceCreationStatusType::Ready,
        S::AssistancePending => WorkspaceCreationStatusType::AssistancePending,
        S::Unavailable => WorkspaceCreationStatusType::Unavailable,
      },
      root_ready: value.allocation.root_ready,
      tasks_ready: value.allocation.tasks_ready,
      tasks_database_id: value.allocation.tasks_database_id.map(|id| id.to_string().into()),
      assistance_saved: value.allocation.receipt.assistance_saved,
      retry_required: value.retry_required,
      reason_code: value.allocation.reason_code.clone(),
    })
  }
}

/// GraphQL output type for a workspace member / invitee (schema name `InviteUserType`).
#[derive(SimpleObject)]
#[graphql(name = "InviteUserType")]
pub struct WorkspaceMemberType {
  pub id: ID,
  pub email: String,
  pub name: String,
  pub avatar_url: Option<String>,
  pub email_verified: Option<bool>,
  pub disabled: Option<bool>,
  pub has_password: Option<bool>,
  pub role: WorkspaceRole,
  pub permission: WorkspaceRole, // deprecated but kept for compatibility
  pub status: WorkspaceMemberStatus,
  pub invite_id: String,
}

impl WorkspaceMemberType {
  pub fn from_model(m: WorkspaceMember) -> Self {
    let role: WorkspaceRole = m.role.into();
    Self {
      id: ID::from(m.user.id.to_string()),
      email: m.user.email,
      name: m.user.name,
      avatar_url: m.user.avatar_url,
      email_verified: Some(m.user.email_verified_at.is_some()),
      disabled: Some(m.user.disabled),
      has_password: Some(m.user.password_hash.is_some()),
      role,
      permission: role,
      status: m.status.into(),
      invite_id: m.invite_id.to_string(),
    }
  }
}

/// Result of a single invitation attempt within a batch-invite operation.
#[derive(SimpleObject)]
pub struct InviteResult {
  pub email: String,
  pub invite_id: Option<String>,
  pub sent_success: bool,
  pub error: Option<String>,
}

/// A shareable invite link with an expiry timestamp.
#[derive(SimpleObject)]
#[graphql(name = "InviteLink")]
pub struct InviteLinkType {
  /// Fully qualified URL that can be shared with invitees.
  pub link: String,
  /// UTC timestamp when the link expires.
  pub expire_time: DateTime<Utc>,
}

/// Workspace invite link details returned after link creation.
#[derive(SimpleObject)]
#[graphql(name = "WorkspaceInviteLinkType")]
pub struct WorkspaceInviteLinkType {
  /// UUID of the workspace the link grants access to.
  pub workspace_id: String,
  /// Opaque invite ID encoded in the link URL.
  pub invite_id: String,
  /// Expiry time as a Unix epoch millisecond value (float for JS compatibility).
  pub expire_time: f64,
}

/// Duration options for workspace invite link expiry.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
pub enum WorkspaceInviteLinkExpireTime {
  #[graphql(name = "OneDay")]
  OneDay,
  #[graphql(name = "ThreeDays")]
  ThreeDays,
  #[graphql(name = "OneWeek")]
  OneWeek,
  #[graphql(name = "OneMonth")]
  OneMonth,
}

impl WorkspaceInviteLinkExpireTime {
  pub(crate) fn milliseconds(self) -> i64 {
    use myoxus_application::workspace::WorkspaceInviteLinkExpiry;
    match self {
      Self::OneDay => WorkspaceInviteLinkExpiry::OneDay,
      Self::ThreeDays => WorkspaceInviteLinkExpiry::ThreeDays,
      Self::OneWeek => WorkspaceInviteLinkExpiry::OneWeek,
      Self::OneMonth => WorkspaceInviteLinkExpiry::OneMonth,
    }
    .milliseconds()
  }
}

/// Full permission matrix for a workspace membership, computed from the member's role.
///
/// Each boolean field corresponds to a [`WorkspaceAction`] and is derived via
/// [`WorkspacePermissions::from_role`].
#[derive(SimpleObject)]
pub struct WorkspacePermissions {
  #[graphql(name = "Workspace_Read")]
  pub workspace_read: bool,
  #[graphql(name = "Workspace_Sync")]
  pub workspace_sync: bool,
  #[graphql(name = "Workspace_CreateDoc")]
  pub workspace_create_doc: bool,
  #[graphql(name = "Workspace_Delete")]
  pub workspace_delete: bool,
  #[graphql(name = "Workspace_TransferOwner")]
  pub workspace_transfer_owner: bool,
  #[graphql(name = "Workspace_Organize_Read")]
  pub workspace_organize_read: bool,
  #[graphql(name = "Workspace_Organize_Update")]
  pub workspace_organize_update: bool,
  #[graphql(name = "Workspace_Content_Transfer")]
  pub workspace_content_transfer: bool,
  #[graphql(name = "Workspace_Users_Read")]
  pub workspace_users_read: bool,
  #[graphql(name = "Workspace_Users_Manage")]
  pub workspace_users_manage: bool,
  #[graphql(name = "Workspace_Administrators_Manage")]
  pub workspace_administrators_manage: bool,
  #[graphql(name = "Workspace_Properties_Read")]
  pub workspace_properties_read: bool,
  #[graphql(name = "Workspace_Properties_Create")]
  pub workspace_properties_create: bool,
  #[graphql(name = "Workspace_Properties_Update")]
  pub workspace_properties_update: bool,
  #[graphql(name = "Workspace_Properties_Delete")]
  pub workspace_properties_delete: bool,
  #[graphql(name = "Workspace_Settings_Read")]
  pub workspace_settings_read: bool,
  #[graphql(name = "Workspace_Settings_Update")]
  pub workspace_settings_update: bool,
  #[graphql(name = "Workspace_Blobs_Read")]
  pub workspace_blobs_read: bool,
  #[graphql(name = "Workspace_Blobs_List")]
  pub workspace_blobs_list: bool,
  #[graphql(name = "Workspace_Blobs_Write")]
  pub workspace_blobs_write: bool,
  #[graphql(name = "Workspace_Copilot")]
  pub workspace_copilot: bool,
  #[graphql(name = "Workspace_Transcription")]
  pub workspace_transcription: bool,
  /// Compatibility-only field for clients that still select the removed paid
  /// workspace capability. Myoxus has no payment-management product action,
  /// so every role receives the neutral value `false`.
  #[graphql(name = "Workspace_Payment_Manage")]
  pub workspace_payment_manage: bool,
}

impl WorkspacePermissions {
  pub fn from_role(role: WorkspaceRoleModel) -> Self {
    Self {
      workspace_read: role.can(WorkspaceAction::Read),
      workspace_sync: role.can(WorkspaceAction::Sync),
      workspace_create_doc: role.can(WorkspaceAction::CreateDoc),
      workspace_delete: role.can(WorkspaceAction::Delete),
      workspace_transfer_owner: role.can(WorkspaceAction::TransferOwner),
      workspace_organize_read: role.can(WorkspaceAction::OrganizeRead),
      workspace_organize_update: role.can(WorkspaceAction::OrganizeUpdate),
      workspace_content_transfer: role.can(WorkspaceAction::ContentTransfer),
      workspace_users_read: role.can(WorkspaceAction::UsersRead),
      workspace_users_manage: role.can(WorkspaceAction::UsersManage),
      workspace_administrators_manage: role.can(WorkspaceAction::AdministratorsManage),
      workspace_properties_read: role.can(WorkspaceAction::PropertiesRead),
      workspace_properties_create: role.can(WorkspaceAction::PropertiesCreate),
      workspace_properties_update: role.can(WorkspaceAction::PropertiesUpdate),
      workspace_properties_delete: role.can(WorkspaceAction::PropertiesDelete),
      workspace_settings_read: role.can(WorkspaceAction::SettingsRead),
      workspace_settings_update: role.can(WorkspaceAction::SettingsUpdate),
      workspace_blobs_read: role.can(WorkspaceAction::BlobsRead),
      workspace_blobs_list: role.can(WorkspaceAction::BlobsList),
      workspace_blobs_write: role.can(WorkspaceAction::BlobsWrite),
      workspace_copilot: role.can(WorkspaceAction::Copilot),
      workspace_transcription: role.can(WorkspaceAction::Transcription),
      workspace_payment_manage: false,
    }
  }
}

#[cfg(test)]
mod workspace_permissions_tests {
  use super::*;

  #[test]
  fn payment_management_compatibility_field_is_neutral_for_every_role() {
    for role in [
      WorkspaceRoleModel::External,
      WorkspaceRoleModel::Reader,
      WorkspaceRoleModel::Commenter,
      WorkspaceRoleModel::Collaborator,
      WorkspaceRoleModel::Manager,
      WorkspaceRoleModel::Admin,
      WorkspaceRoleModel::Owner,
    ] {
      assert!(
        !WorkspacePermissions::from_role(role).workspace_payment_manage,
        "{role:?} must not receive the removed payment-management capability"
      );
    }
  }
}

/// A role paired with its derived permission matrix.
#[derive(SimpleObject)]
pub struct WorkspaceRolePermissions {
  pub role: WorkspaceRole,
  pub permissions: WorkspacePermissions,
}

/// JWT / session token bundle returned by token-based auth endpoints.
#[derive(SimpleObject)]
#[graphql(name = "tokenType")]
pub struct TokenType {
  /// Long-lived refresh token.
  pub refresh: String,
  /// Optional opaque session token.
  pub session_token: Option<String>,
  /// Short-lived access token.
  pub token: String,
}

/// An API / personal access token record (without the plaintext secret).
#[derive(SimpleObject)]
pub struct AccessToken {
  pub id: Uuid,
  pub name: String,
  pub created_at: DateTime<Utc>,
  pub expires_at: Option<DateTime<Utc>>,
}

/// An API / personal access token including the plaintext secret (shown once on creation).
#[derive(SimpleObject)]
pub struct RevealedAccessToken {
  pub id: Uuid,
  pub name: String,
  pub created_at: DateTime<Utc>,
  pub expires_at: Option<DateTime<Utc>>,
  /// Plaintext token — shown only once; store it securely.
  pub token: String,
}

/// Input for creating a new personal access token.
#[derive(InputObject)]
pub struct GenerateAccessTokenInput {
  /// Descriptive name for the token.
  #[graphql(validator(max_length = 255))]
  pub name: String,
  /// Optional absolute expiry timestamp.
  pub expires_at: Option<DateTime<Utc>>,
}

/// Persisted overrides. Nullable fields intentionally inherit defaults.
#[derive(SimpleObject)]
pub struct DocumentMetadataFieldVisibilityType {
  pub field: String,
  pub visible: bool,
}

#[derive(SimpleObject)]
pub struct TemplateCatalogViewType {
  pub workspace_id: ID,
  pub view: String,
}

#[derive(InputObject)]
pub struct TemplateCatalogViewInput {
  pub workspace_id: ID,
  pub view: String,
}

fn map_template_catalog_views(views: HashMap<Uuid, String>) -> Vec<TemplateCatalogViewType> {
  let mut views = views.into_iter().collect::<Vec<_>>();
  views.sort_by_key(|(id, _)| *id);
  views
    .into_iter()
    .map(|(id, view)| TemplateCatalogViewType {
      workspace_id: ID::from(id.to_string()),
      view,
    })
    .collect()
}

#[derive(SimpleObject)]
pub struct WorkspaceDocumentMetadataVisibilityType {
  pub workspace_id: ID,
  pub fields: Vec<DocumentMetadataFieldVisibilityType>,
}

#[derive(InputObject)]
pub struct DocumentMetadataFieldVisibilityInput {
  pub field: String,
  pub visible: bool,
}

#[derive(InputObject)]
pub struct WorkspaceDocumentMetadataVisibilityInput {
  pub workspace_id: ID,
  pub fields: Vec<DocumentMetadataFieldVisibilityInput>,
}

fn map_document_metadata_visibility(
  values: HashMap<Uuid, HashMap<String, bool>>,
) -> Vec<WorkspaceDocumentMetadataVisibilityType> {
  let mut workspaces = values.into_iter().collect::<Vec<_>>();
  workspaces.sort_by_key(|(workspace_id, _)| *workspace_id);
  workspaces
    .into_iter()
    .map(|(workspace_id, fields)| {
      let mut fields = fields.into_iter().collect::<Vec<_>>();
      fields.sort_by(|(left, _), (right, _)| left.cmp(right));
      WorkspaceDocumentMetadataVisibilityType {
        workspace_id: ID::from(workspace_id.to_string()),
        fields: fields
          .into_iter()
          .map(|(field, visible)| DocumentMetadataFieldVisibilityType { field, visible })
          .collect(),
      }
    })
    .collect()
}

/// Stable Workbench route families accepted by the preference API.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkbenchViewFamily", rename_items = "PascalCase")]
pub enum WorkbenchViewFamilyType {
  DocumentPage,
  DocumentEdgeless,
  Journal,
  Database,
  Graph,
}

impl From<WorkbenchViewFamily> for WorkbenchViewFamilyType {
  fn from(value: WorkbenchViewFamily) -> Self {
    match value {
      WorkbenchViewFamily::DocumentPage => Self::DocumentPage,
      WorkbenchViewFamily::DocumentEdgeless => Self::DocumentEdgeless,
      WorkbenchViewFamily::Journal => Self::Journal,
      WorkbenchViewFamily::Database => Self::Database,
      WorkbenchViewFamily::Graph => Self::Graph,
    }
  }
}

impl From<WorkbenchViewFamilyType> for WorkbenchViewFamily {
  fn from(value: WorkbenchViewFamilyType) -> Self {
    match value {
      WorkbenchViewFamilyType::DocumentPage => Self::DocumentPage,
      WorkbenchViewFamilyType::DocumentEdgeless => Self::DocumentEdgeless,
      WorkbenchViewFamilyType::Journal => Self::Journal,
      WorkbenchViewFamilyType::Database => Self::Database,
      WorkbenchViewFamilyType::Graph => Self::Graph,
    }
  }
}

/// Stable product tool identifiers. Arbitrary client-defined IDs are rejected
/// by the schema before they can reach the preference aggregate.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkbenchToolId", rename_items = "PascalCase")]
pub enum WorkbenchToolIdType {
  Outline,
  Tags,
  Frame,
  DocumentInfo,
  Calendar,
  Agenda,
  Activity,
  Comment,
  Chat,
  Export,
  Analytics,
  DatabaseSettings,
  TaskDetails,
  GraphDetails,
  Presence,
}

impl From<WorkbenchToolId> for WorkbenchToolIdType {
  fn from(value: WorkbenchToolId) -> Self {
    match value {
      WorkbenchToolId::Outline => Self::Outline,
      WorkbenchToolId::Tags => Self::Tags,
      WorkbenchToolId::Frame => Self::Frame,
      WorkbenchToolId::DocumentInfo => Self::DocumentInfo,
      WorkbenchToolId::Calendar => Self::Calendar,
      WorkbenchToolId::Agenda => Self::Agenda,
      WorkbenchToolId::Activity => Self::Activity,
      WorkbenchToolId::Comment => Self::Comment,
      WorkbenchToolId::Chat => Self::Chat,
      WorkbenchToolId::Export => Self::Export,
      WorkbenchToolId::Analytics => Self::Analytics,
      WorkbenchToolId::DatabaseSettings => Self::DatabaseSettings,
      WorkbenchToolId::TaskDetails => Self::TaskDetails,
      WorkbenchToolId::GraphDetails => Self::GraphDetails,
      WorkbenchToolId::Presence => Self::Presence,
    }
  }
}

impl From<WorkbenchToolIdType> for WorkbenchToolId {
  fn from(value: WorkbenchToolIdType) -> Self {
    match value {
      WorkbenchToolIdType::Outline => Self::Outline,
      WorkbenchToolIdType::Tags => Self::Tags,
      WorkbenchToolIdType::Frame => Self::Frame,
      WorkbenchToolIdType::DocumentInfo => Self::DocumentInfo,
      WorkbenchToolIdType::Calendar => Self::Calendar,
      WorkbenchToolIdType::Agenda => Self::Agenda,
      WorkbenchToolIdType::Activity => Self::Activity,
      WorkbenchToolIdType::Comment => Self::Comment,
      WorkbenchToolIdType::Chat => Self::Chat,
      WorkbenchToolIdType::Export => Self::Export,
      WorkbenchToolIdType::Analytics => Self::Analytics,
      WorkbenchToolIdType::DatabaseSettings => Self::DatabaseSettings,
      WorkbenchToolIdType::TaskDetails => Self::TaskDetails,
      WorkbenchToolIdType::GraphDetails => Self::GraphDetails,
      WorkbenchToolIdType::Presence => Self::Presence,
    }
  }
}

#[derive(Debug, SimpleObject)]
pub struct WorkbenchToolLayoutType {
  pub workspace_id: ID,
  pub view_family: WorkbenchViewFamilyType,
  pub ordered_tool_ids: Vec<WorkbenchToolIdType>,
  pub visible_tool_ids: Vec<WorkbenchToolIdType>,
  pub collapsed_tool_ids: Vec<WorkbenchToolIdType>,
}

impl From<WorkbenchToolLayout> for WorkbenchToolLayoutType {
  fn from(value: WorkbenchToolLayout) -> Self {
    Self {
      workspace_id: value.workspace_id.to_string().into(),
      view_family: value.view_family.into(),
      ordered_tool_ids: value.ordered_tool_ids.into_iter().map(Into::into).collect(),
      visible_tool_ids: value.visible_tool_ids.into_iter().map(Into::into).collect(),
      collapsed_tool_ids: value.collapsed_tool_ids.into_iter().map(Into::into).collect(),
    }
  }
}

#[derive(Debug, InputObject)]
pub struct WorkbenchToolLayoutInput {
  pub workspace_id: ID,
  pub view_family: WorkbenchViewFamilyType,
  pub ordered_tool_ids: Vec<WorkbenchToolIdType>,
  pub visible_tool_ids: Vec<WorkbenchToolIdType>,
  pub collapsed_tool_ids: Vec<WorkbenchToolIdType>,
}

fn map_workbench_tool_layouts(values: Vec<WorkbenchToolLayout>) -> Vec<WorkbenchToolLayoutType> {
  values.into_iter().map(Into::into).collect()
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceDashboardDashletId", rename_items = "PascalCase")]
pub enum WorkspaceDashboardDashletIdType {
  Today,
  Tasks,
  NewDocuments,
  Reminders,
  RecentlyEdited,
  Activity,
}

impl From<WorkspaceDashboardDashletId> for WorkspaceDashboardDashletIdType {
  fn from(value: WorkspaceDashboardDashletId) -> Self {
    match value {
      WorkspaceDashboardDashletId::Today => Self::Today,
      WorkspaceDashboardDashletId::Tasks => Self::Tasks,
      WorkspaceDashboardDashletId::NewDocuments => Self::NewDocuments,
      WorkspaceDashboardDashletId::Reminders => Self::Reminders,
      WorkspaceDashboardDashletId::RecentlyEdited => Self::RecentlyEdited,
      WorkspaceDashboardDashletId::Activity => Self::Activity,
    }
  }
}

impl From<WorkspaceDashboardDashletIdType> for WorkspaceDashboardDashletId {
  fn from(value: WorkspaceDashboardDashletIdType) -> Self {
    match value {
      WorkspaceDashboardDashletIdType::Today => Self::Today,
      WorkspaceDashboardDashletIdType::Tasks => Self::Tasks,
      WorkspaceDashboardDashletIdType::NewDocuments => Self::NewDocuments,
      WorkspaceDashboardDashletIdType::Reminders => Self::Reminders,
      WorkspaceDashboardDashletIdType::RecentlyEdited => Self::RecentlyEdited,
      WorkspaceDashboardDashletIdType::Activity => Self::Activity,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceDashboardDashletSize", rename_items = "PascalCase")]
pub enum WorkspaceDashboardDashletSizeType {
  Compact,
  Standard,
  Wide,
}

impl From<WorkspaceDashboardDashletSize> for WorkspaceDashboardDashletSizeType {
  fn from(value: WorkspaceDashboardDashletSize) -> Self {
    match value {
      WorkspaceDashboardDashletSize::Compact => Self::Compact,
      WorkspaceDashboardDashletSize::Standard => Self::Standard,
      WorkspaceDashboardDashletSize::Wide => Self::Wide,
    }
  }
}

impl From<WorkspaceDashboardDashletSizeType> for WorkspaceDashboardDashletSize {
  fn from(value: WorkspaceDashboardDashletSizeType) -> Self {
    match value {
      WorkspaceDashboardDashletSizeType::Compact => Self::Compact,
      WorkspaceDashboardDashletSizeType::Standard => Self::Standard,
      WorkspaceDashboardDashletSizeType::Wide => Self::Wide,
    }
  }
}

#[derive(Debug, SimpleObject)]
pub struct WorkspaceDashboardDashletSizeOverrideType {
  pub dashlet_id: WorkspaceDashboardDashletIdType,
  pub size: WorkspaceDashboardDashletSizeType,
}

impl From<WorkspaceDashboardDashletSizeOverride> for WorkspaceDashboardDashletSizeOverrideType {
  fn from(value: WorkspaceDashboardDashletSizeOverride) -> Self {
    Self {
      dashlet_id: value.dashlet_id.into(),
      size: value.size.into(),
    }
  }
}

#[derive(Debug, SimpleObject)]
pub struct WorkspaceDashboardLayoutType {
  pub workspace_id: ID,
  pub ordered_dashlet_ids: Vec<WorkspaceDashboardDashletIdType>,
  pub dashlet_sizes: Vec<WorkspaceDashboardDashletSizeOverrideType>,
}

impl From<WorkspaceDashboardLayout> for WorkspaceDashboardLayoutType {
  fn from(value: WorkspaceDashboardLayout) -> Self {
    Self {
      workspace_id: value.workspace_id.to_string().into(),
      ordered_dashlet_ids: value.ordered_dashlet_ids.into_iter().map(Into::into).collect(),
      dashlet_sizes: value.dashlet_sizes.into_iter().map(Into::into).collect(),
    }
  }
}

#[derive(Debug, InputObject)]
pub struct WorkspaceDashboardDashletSizeOverrideInput {
  pub dashlet_id: WorkspaceDashboardDashletIdType,
  pub size: WorkspaceDashboardDashletSizeType,
}

#[derive(Debug, InputObject)]
pub struct WorkspaceDashboardLayoutInput {
  pub workspace_id: ID,
  pub ordered_dashlet_ids: Vec<WorkspaceDashboardDashletIdType>,
  pub dashlet_sizes: Vec<WorkspaceDashboardDashletSizeOverrideInput>,
}

fn map_workspace_dashboard_layouts(values: Vec<WorkspaceDashboardLayout>) -> Vec<WorkspaceDashboardLayoutType> {
  values.into_iter().map(Into::into).collect()
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistanceMode", rename_items = "PascalCase")]
pub enum AssistanceModeType {
  Manual,
  Guided,
  Automatic,
}

impl From<AssistanceMode> for AssistanceModeType {
  fn from(value: AssistanceMode) -> Self {
    match value {
      AssistanceMode::Manual => Self::Manual,
      AssistanceMode::Guided => Self::Guided,
      AssistanceMode::Automatic => Self::Automatic,
    }
  }
}
impl From<AssistanceModeType> for AssistanceMode {
  fn from(value: AssistanceModeType) -> Self {
    match value {
      AssistanceModeType::Manual => Self::Manual,
      AssistanceModeType::Guided => Self::Guided,
      AssistanceModeType::Automatic => Self::Automatic,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistanceSource", rename_items = "PascalCase")]
pub enum AssistanceSourceType {
  UserDefault,
  Workspace,
  Project,
}

#[derive(SimpleObject)]
pub struct EffectiveAssistanceType {
  pub mode: AssistanceModeType,
  pub source: AssistanceSourceType,
  pub user_default_explicit: bool,
  pub interactive_mode: AssistanceModeType,
}
impl From<EffectiveAssistance> for EffectiveAssistanceType {
  fn from(value: EffectiveAssistance) -> Self {
    Self {
      mode: value.mode.into(),
      source: match value.source {
        AssistanceSource::UserDefault => AssistanceSourceType::UserDefault,
        AssistanceSource::Workspace => AssistanceSourceType::Workspace,
        AssistanceSource::Project => AssistanceSourceType::Project,
      },
      user_default_explicit: value.user_default_explicit,
      interactive_mode: value.interactive_mode.into(),
    }
  }
}

#[derive(SimpleObject)]
pub struct WorkspaceAssistanceOverrideType {
  pub workspace_id: ID,
  pub mode: AssistanceModeType,
}
#[derive(SimpleObject)]
pub struct ProjectAssistanceOverrideType {
  pub workspace_id: ID,
  pub project_id: ID,
  pub mode: AssistanceModeType,
}

#[derive(InputObject)]
pub struct WorkspaceAssistanceOverrideInput {
  pub workspace_id: ID,
  /// Omitted is rejected; null resets this one key to inherited policy.
  pub mode: MaybeUndefined<Option<AssistanceModeType>>,
}
#[derive(InputObject)]
pub struct ProjectAssistanceOverrideInput {
  pub workspace_id: ID,
  pub project_id: ID,
  pub mode: MaybeUndefined<Option<AssistanceModeType>>,
}

#[derive(SimpleObject)]
pub struct UserPreferenceValuesType {
  pub saved_setups: Vec<super::database::SavedSetupConfigurationObjectType>,
  pub assistance_mode: Option<AssistanceModeType>,
  pub workspace_assistance_overrides: Vec<WorkspaceAssistanceOverrideType>,
  pub project_assistance_overrides: Vec<ProjectAssistanceOverrideType>,
  pub locale: Option<String>,
  pub default_document_language: Option<String>,
  pub timezone: Option<String>,
  pub date_format: Option<String>,
  pub time_format: Option<String>,
  pub receive_invitation_email: Option<bool>,
  pub receive_mention_email: Option<bool>,
  pub receive_comment_email: Option<bool>,
  pub notify_created_documents: Option<bool>,
  pub journal_first_day_of_week: Option<String>,
  pub journal_show_calendar_weeks: Option<bool>,
  pub color_mode: Option<String>,
  pub show_linked_documents: Option<bool>,
  pub image_antialiasing: Option<bool>,
  pub noisy_background: Option<bool>,
  pub editor_font_family: Option<String>,
  pub editor_custom_font_family: Option<String>,
  pub editor_font_size: Option<i32>,
  pub new_document_mode: Option<String>,
  pub full_width_layout: Option<bool>,
  pub open_document_mode: Option<String>,
  pub edgeless_default_theme: Option<String>,
  pub telemetry_enabled: Option<bool>,
  pub ai_model_id: Option<String>,
  pub ai_reasoning_enabled: Option<bool>,
  pub document_metadata_header_visibility: Option<Vec<WorkspaceDocumentMetadataVisibilityType>>,
  pub workbench_tool_layouts: Option<Vec<WorkbenchToolLayoutType>>,
  pub workspace_dashboard_layouts: Option<Vec<WorkspaceDashboardLayoutType>>,
  pub template_catalog_views: Option<Vec<TemplateCatalogViewType>>,
}

impl From<UserPreferences> for UserPreferenceValuesType {
  fn from(values: UserPreferences) -> Self {
    Self {
      saved_setups: values.saved_setups.into_values().map(Into::into).collect(),
      assistance_mode: values.assistance_mode.map(Into::into),
      workspace_assistance_overrides: values
        .workspace_assistance_overrides
        .into_iter()
        .map(|(id, mode)| WorkspaceAssistanceOverrideType {
          workspace_id: id.to_string().into(),
          mode: mode.into(),
        })
        .collect(),
      project_assistance_overrides: values
        .project_assistance_overrides
        .into_iter()
        .map(|(id, value)| ProjectAssistanceOverrideType {
          workspace_id: value.workspace_id.to_string().into(),
          project_id: id.to_string().into(),
          mode: value.mode.into(),
        })
        .collect(),
      locale: values.locale,
      default_document_language: values.default_document_language,
      timezone: values.timezone,
      date_format: values.date_format,
      time_format: values.time_format,
      receive_invitation_email: values.receive_invitation_email,
      receive_mention_email: values.receive_mention_email,
      receive_comment_email: values.receive_comment_email,
      notify_created_documents: values.notify_created_documents,
      journal_first_day_of_week: values.journal_first_day_of_week,
      journal_show_calendar_weeks: values.journal_show_calendar_weeks,
      color_mode: values.color_mode,
      show_linked_documents: values.show_linked_documents,
      image_antialiasing: values.image_antialiasing,
      noisy_background: values.noisy_background,
      editor_font_family: values.editor_font_family,
      editor_custom_font_family: values.editor_custom_font_family,
      editor_font_size: values.editor_font_size.map(i32::from),
      new_document_mode: values.new_document_mode,
      full_width_layout: values.full_width_layout,
      open_document_mode: values.open_document_mode,
      edgeless_default_theme: values.edgeless_default_theme,
      telemetry_enabled: values.telemetry_enabled,
      ai_model_id: values.ai_model_id,
      ai_reasoning_enabled: values.ai_reasoning_enabled,
      document_metadata_header_visibility: values
        .document_metadata_header_visibility
        .map(map_document_metadata_visibility),
      workbench_tool_layouts: values.workbench_tool_layouts.map(map_workbench_tool_layouts),
      workspace_dashboard_layouts: values.workspace_dashboard_layouts.map(map_workspace_dashboard_layouts),
      template_catalog_views: values.template_catalog_views.map(map_template_catalog_views),
    }
  }
}

/// Application-resolved values ready for direct consumption.
#[derive(SimpleObject)]
pub struct EffectiveUserPreferenceValuesType {
  pub assistance_mode: AssistanceModeType,
  pub locale: String,
  pub default_document_language: String,
  pub timezone: String,
  pub date_format: String,
  pub time_format: String,
  pub receive_invitation_email: bool,
  pub receive_mention_email: bool,
  pub receive_comment_email: bool,
  pub notify_created_documents: bool,
  pub journal_first_day_of_week: String,
  pub journal_show_calendar_weeks: bool,
  pub color_mode: String,
  pub show_linked_documents: bool,
  pub image_antialiasing: bool,
  pub noisy_background: bool,
  pub editor_font_family: String,
  pub editor_custom_font_family: String,
  pub editor_font_size: i32,
  pub new_document_mode: String,
  pub full_width_layout: bool,
  pub open_document_mode: String,
  pub edgeless_default_theme: String,
  pub telemetry_enabled: bool,
  pub ai_model_id: Option<String>,
  pub ai_reasoning_enabled: bool,
  pub document_metadata_header_visibility: Vec<WorkspaceDocumentMetadataVisibilityType>,
  pub workbench_tool_layouts: Option<Vec<WorkbenchToolLayoutType>>,
  pub workspace_dashboard_layouts: Option<Vec<WorkspaceDashboardLayoutType>>,
  pub template_catalog_views: Option<Vec<TemplateCatalogViewType>>,
}

impl From<EffectiveUserPreferences> for EffectiveUserPreferenceValuesType {
  fn from(values: EffectiveUserPreferences) -> Self {
    Self {
      assistance_mode: values.assistance_mode.into(),
      locale: values.locale,
      default_document_language: values.default_document_language,
      timezone: values.timezone,
      date_format: values.date_format,
      time_format: values.time_format,
      receive_invitation_email: values.receive_invitation_email,
      receive_mention_email: values.receive_mention_email,
      receive_comment_email: values.receive_comment_email,
      notify_created_documents: values.notify_created_documents,
      journal_first_day_of_week: values.journal_first_day_of_week,
      journal_show_calendar_weeks: values.journal_show_calendar_weeks,
      color_mode: values.color_mode,
      show_linked_documents: values.show_linked_documents,
      image_antialiasing: values.image_antialiasing,
      noisy_background: values.noisy_background,
      editor_font_family: values.editor_font_family,
      editor_custom_font_family: values.editor_custom_font_family,
      editor_font_size: i32::from(values.editor_font_size),
      new_document_mode: values.new_document_mode,
      full_width_layout: values.full_width_layout,
      open_document_mode: values.open_document_mode,
      edgeless_default_theme: values.edgeless_default_theme,
      telemetry_enabled: values.telemetry_enabled,
      ai_model_id: values.ai_model_id,
      ai_reasoning_enabled: values.ai_reasoning_enabled,
      document_metadata_header_visibility: map_document_metadata_visibility(values.document_metadata_header_visibility),
      workbench_tool_layouts: values.workbench_tool_layouts.map(map_workbench_tool_layouts),
      workspace_dashboard_layouts: values.workspace_dashboard_layouts.map(map_workspace_dashboard_layouts),
      template_catalog_views: values.template_catalog_views.map(map_template_catalog_views),
    }
  }
}

#[derive(SimpleObject)]
#[graphql(complex)]
pub struct UserPreferencesType {
  pub values: UserPreferenceValuesType,
  pub effective_values: EffectiveUserPreferenceValuesType,
  pub updated_at: Option<DateTime<Utc>>,
}

#[derive(InputObject)]
pub struct DeleteDocumentPermanentlyInput {
  pub workspace_id: ID,
  pub doc_id: String,
}

#[derive(InputObject)]
pub struct DeleteDocumentsPermanentlyInput {
  pub workspace_id: ID,
  pub doc_ids: Vec<String>,
}

#[derive(InputObject)]
pub struct EmptyWorkspaceTrashInput {
  pub workspace_id: ID,
  pub client_visible_doc_ids: Option<Vec<String>>,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(name = "DeleteDocumentPermanentlyStatus", rename_items = "PascalCase")]
pub enum DeleteDocumentPermanentlyStatusType {
  Deleted,
  NotFound,
  Forbidden,
  AlreadyDeleted,
  NotTrashed,
  Failed,
}

#[derive(SimpleObject)]
pub struct DeleteDocumentPermanentlyResultType {
  pub client_doc_id: String,
  pub resolved_doc_id: Option<ID>,
  pub title: Option<String>,
  pub status: DeleteDocumentPermanentlyStatusType,
  pub reason: Option<String>,
}

#[derive(SimpleObject)]
pub struct DeleteDocumentsPermanentlyPayload {
  pub requested: i32,
  pub deleted: i32,
  pub not_found: i32,
  pub forbidden: i32,
  pub already_deleted: i32,
  pub not_trashed: i32,
  pub failed: i32,
  pub root_meta_removed: i32,
  pub documents: Vec<DeleteDocumentPermanentlyResultType>,
}

/// GraphQL enum for compatibility feature flags returned in user/workspace contexts.
///
/// These represent plan or feature entitlements that the client uses to
/// gate UI features.  They are derived from [`crate::config::CompatibilityFeature`].
#[derive(Enum, Copy, Clone, Eq, PartialEq, Serialize, Deserialize, Debug)]
pub enum FeatureType {
  #[graphql(name = "AIEarlyAccess")]
  AIEarlyAccess,
  #[graphql(name = "Admin")]
  Admin,
  #[graphql(name = "EarlyAccess")]
  EarlyAccess,
  #[graphql(name = "FreePlan")]
  FreePlan,
  #[graphql(name = "LifetimeProPlan")]
  LifetimeProPlan,
  /// Globale Manager-Capability: schaltet einen User als _potenziellen_
  /// Manager frei. Wirksam erst in Kombination mit einer
  /// `organization_unit_member.role='manager'`-Mitgliedschaft (Learning
  /// LRN-20260502-ORG-A-01).
  #[graphql(name = "Manager")]
  Manager,
  #[graphql(name = "ProPlan")]
  ProPlan,
  #[graphql(name = "TeamPlan")]
  TeamPlan,
  #[graphql(name = "UnlimitedCopilot")]
  UnlimitedCopilot,
  #[graphql(name = "UnlimitedWorkspace")]
  UnlimitedWorkspace,
}

impl From<crate::config::CompatibilityFeature> for FeatureType {
  fn from(value: crate::config::CompatibilityFeature) -> Self {
    match value {
      crate::config::CompatibilityFeature::AIEarlyAccess => Self::AIEarlyAccess,
      crate::config::CompatibilityFeature::Admin => Self::Admin,
      crate::config::CompatibilityFeature::EarlyAccess => Self::EarlyAccess,
      crate::config::CompatibilityFeature::FreePlan => Self::FreePlan,
      crate::config::CompatibilityFeature::LifetimeProPlan => Self::LifetimeProPlan,
      crate::config::CompatibilityFeature::Manager => Self::Manager,
      crate::config::CompatibilityFeature::ProPlan => Self::ProPlan,
      crate::config::CompatibilityFeature::TeamPlan => Self::TeamPlan,
      crate::config::CompatibilityFeature::UnlimitedCopilot => Self::UnlimitedCopilot,
      crate::config::CompatibilityFeature::UnlimitedWorkspace => Self::UnlimitedWorkspace,
    }
  }
}

/// Tri-state preference patch. Omitted leaves a field unchanged; null removes
/// its override; a concrete value sets it.
#[derive(InputObject)]
pub struct UpdateUserPreferencesInput {
  pub assistance_mode: MaybeUndefined<Option<AssistanceModeType>>,
  /// Each entry modifies one key. Omission or an empty list preserves all keys.
  pub workspace_assistance_overrides: Option<Vec<WorkspaceAssistanceOverrideInput>>,
  pub project_assistance_overrides: Option<Vec<ProjectAssistanceOverrideInput>>,
  pub locale: MaybeUndefined<Option<String>>,
  pub default_document_language: MaybeUndefined<Option<String>>,
  pub timezone: MaybeUndefined<Option<String>>,
  pub date_format: MaybeUndefined<Option<String>>,
  pub time_format: MaybeUndefined<Option<String>>,
  pub receive_invitation_email: MaybeUndefined<Option<bool>>,
  pub receive_mention_email: MaybeUndefined<Option<bool>>,
  pub receive_comment_email: MaybeUndefined<Option<bool>>,
  pub notify_created_documents: MaybeUndefined<Option<bool>>,
  pub journal_first_day_of_week: MaybeUndefined<Option<String>>,
  pub journal_show_calendar_weeks: MaybeUndefined<Option<bool>>,
  pub color_mode: MaybeUndefined<Option<String>>,
  pub show_linked_documents: MaybeUndefined<Option<bool>>,
  pub image_antialiasing: MaybeUndefined<Option<bool>>,
  pub noisy_background: MaybeUndefined<Option<bool>>,
  pub editor_font_family: MaybeUndefined<Option<String>>,
  pub editor_custom_font_family: MaybeUndefined<Option<String>>,
  pub editor_font_size: MaybeUndefined<Option<i32>>,
  pub new_document_mode: MaybeUndefined<Option<String>>,
  pub full_width_layout: MaybeUndefined<Option<bool>>,
  pub open_document_mode: MaybeUndefined<Option<String>>,
  pub edgeless_default_theme: MaybeUndefined<Option<String>>,
  pub telemetry_enabled: MaybeUndefined<Option<bool>>,
  pub ai_model_id: MaybeUndefined<Option<String>>,
  pub ai_reasoning_enabled: MaybeUndefined<Option<bool>>,
  pub document_metadata_header_visibility: MaybeUndefined<Option<Vec<WorkspaceDocumentMetadataVisibilityInput>>>,
  pub workbench_tool_layouts: MaybeUndefined<Option<Vec<WorkbenchToolLayoutInput>>>,
  pub workspace_dashboard_layouts: MaybeUndefined<Option<Vec<WorkspaceDashboardLayoutInput>>>,
  pub template_catalog_views: MaybeUndefined<Option<Vec<TemplateCatalogViewInput>>>,
}

/// Input for updating user profile fields.
#[derive(InputObject)]
pub struct UpdateUserInput {
  /// New display name.
  #[graphql(validator(max_length = 255))]
  pub name: Option<String>,
}

/// Result of a `removeAvatar` mutation.
#[derive(SimpleObject)]
pub struct RemoveAvatar {
  /// Always `true` on success.
  pub success: bool,
}

/// Result of a `deleteAccount` mutation.
#[derive(SimpleObject)]
pub struct DeleteAccount {
  /// Always `true` on success.
  pub success: bool,
}

/// GraphQL output type for a workspace (used by authenticated user queries).
pub struct WorkspaceTemplateContextType {
  pub workspace_id: Uuid,
}

/// Workspace fields resolve under the authenticated workspace permission boundary.
pub struct WorkspaceType {
  pub(super) overview_settings: WorkspaceOverviewSettings,
  pub(super) overview_revision: i64,
  pub initial_content_policy: WorkspaceInitialContentPolicyType,
  pub creation: Option<WorkspaceCreationResultType>,
  /// Workspace UUID.
  pub id: Uuid,
  /// Human-readable workspace name.
  pub name: String,
  /// Plain-text workspace description.
  pub description: String,
  /// Whether the workspace is publicly accessible.
  pub public: bool,
  /// When the workspace was created.
  pub created_at: DateTime<Utc>,
  /// Whether AI (Copilot) features are enabled.
  pub enable_ai: bool,
  /// Whether document sharing is enabled.
  pub enable_sharing: bool,
  /// Whether URL preview cards are generated.
  pub enable_url_preview: bool,
  /// Whether documents are embedded for AI search.
  pub enable_doc_embedding: bool,
}

/// Per-document permission matrix, computed from the caller's role.
#[derive(SimpleObject)]
#[graphql(name = "DocPermissionsType")]
pub struct DocPermissionsType {
  #[graphql(name = "Doc_Copy")]
  pub doc_copy: bool,
  #[graphql(name = "Doc_Delete")]
  pub doc_delete: bool,
  #[graphql(name = "Doc_Duplicate")]
  pub doc_duplicate: bool,
  #[graphql(name = "Doc_Properties_Read")]
  pub doc_properties_read: bool,
  #[graphql(name = "Doc_Properties_Update")]
  pub doc_properties_update: bool,
  #[graphql(name = "Doc_Publish")]
  pub doc_publish: bool,
  #[graphql(name = "Doc_Read")]
  pub doc_read: bool,
  #[graphql(name = "Doc_Restore")]
  pub doc_restore: bool,
  #[graphql(name = "Doc_TransferOwner")]
  pub doc_transfer_owner: bool,
  #[graphql(name = "Doc_Trash")]
  pub doc_trash: bool,
  #[graphql(name = "Doc_Update")]
  pub doc_update: bool,
  #[graphql(name = "Doc_Users_Manage")]
  pub doc_users_manage: bool,
  #[graphql(name = "Doc_Users_Read")]
  pub doc_users_read: bool,
  #[graphql(name = "Doc_Comments_Create")]
  pub doc_comments_create: bool,
  #[graphql(name = "Doc_Comments_Delete")]
  pub doc_comments_delete: bool,
  #[graphql(name = "Doc_Comments_Read")]
  pub doc_comments_read: bool,
  #[graphql(name = "Doc_Comments_Resolve")]
  pub doc_comments_resolve: bool,
}

/// A user with an explicitly-granted role on a specific document.
#[derive(SimpleObject)]
#[graphql(name = "DocGrantedUserType")]
pub struct DocGrantedUserType {
  /// Role the user holds on this document.
  pub role: crate::graphql::DocRoleType,
  /// Public profile of the granted user.
  pub user: PublicUserType,
}

/// A cursor-based edge wrapping a [`DocGrantedUserType`].
#[derive(SimpleObject)]
#[graphql(name = "DocGrantedUserTypeEdge")]
pub struct DocGrantedUserTypeEdge {
  /// Opaque cursor for this edge position.
  pub cursor: String,
  pub node: DocGrantedUserType,
}

/// Paginated list of users with explicit roles on a document.
#[derive(SimpleObject)]
#[graphql(name = "PaginatedDocGrantedUserType")]
pub struct PaginatedDocGrantedUserType {
  /// Total number of matching records (before pagination).
  pub total_count: i32,
  pub edges: Vec<DocGrantedUserTypeEdge>,
  pub page_info: PageInfoType,
}

/// GraphQL output type for a workspace document (metadata only, no content).
pub struct WorkspaceDocType {
  /// Document UUID.
  pub id: String,
  /// UUID of the owning workspace.
  pub workspace_id: String,
  /// Whether the document is publicly shared.
  pub public: bool,
  /// Sharing mode when public.
  pub mode: crate::graphql::PublicDocModeType,
  /// Default role for users accessing the document without an explicit grant.
  pub default_role: crate::graphql::DocRoleType,
  /// Document title extracted from content, if available.
  pub title: Option<String>,
  /// Short summary extracted from content, if available.
  pub summary: Option<String>,
  pub created_at: Option<DateTime<Utc>>,
  pub updated_at: Option<DateTime<Utc>>,
}

/// Authorized list snippet backed only by the asynchronous search projection.
#[derive(SimpleObject)]
pub struct WorkspaceDocumentSnippetType {
  /// Client-visible document key.
  pub doc_id: String,
  /// Normalized list text; null when the index has no text or no row yet.
  pub snippet: Option<String>,
  /// Search projection freshness, distinct from the source document timestamp.
  pub indexed_at: Option<DateTime<Utc>>,
}

/// Workspace summary embedded in an invitation view.
#[derive(SimpleObject)]
#[graphql(name = "InvitationWorkspaceType")]
pub struct InvitationWorkspaceType {
  /// Workspace UUID.
  pub id: ID,
  /// Workspace display name.
  pub name: String,
  /// URL or storage key for the workspace avatar.
  pub avatar: String,
}

/// Minimal public user profile exposed in invitation and document-share contexts.
#[derive(SimpleObject)]
#[graphql(name = "PublicUserType")]
pub struct PublicUserType {
  pub id: ID,
  pub name: String,
  pub email: String,
  pub avatar_url: Option<String>,
}

/// Full invitation record returned when a user looks up their pending invitation.
#[derive(SimpleObject)]
#[graphql(name = "InvitationType")]
pub struct InvitationType {
  /// The workspace the invitation is for.
  pub workspace: InvitationWorkspaceType,
  /// The user who sent the invitation, if known.
  pub user: Option<PublicUserType>,
  /// Current status of the invitation.
  pub status: WorkspaceMemberStatus,
  /// The invitee's membership record, if accepted.
  pub invitee: Option<WorkspaceMemberType>,
}

impl From<Workspace> for WorkspaceType {
  fn from(w: Workspace) -> Self {
    Self {
      overview_settings: w.overview_settings,
      overview_revision: w.overview_revision,
      initial_content_policy: w.initial_content_policy.into(),
      creation: None,
      id: w.id,
      name: w.name,
      description: w.description,
      public: w.public,
      created_at: w.created_at,
      enable_ai: w.enable_ai,
      enable_sharing: w.enable_sharing,
      enable_url_preview: w.enable_url_preview,
      enable_doc_embedding: w.enable_doc_embedding,
    }
  }
}

// --- Types from lines 1401-1614 ---

/// Input for the `updateWorkspace` mutation.
#[derive(InputObject)]
pub struct UpdateWorkspaceInput {
  /// UUID of the workspace to update.
  pub id: String,
  /// One revision-fenced overview scope; unrelated settings remain untouched.
  pub overview: Option<WorkspaceOverviewSettingsInput>,
  /// New workspace name.
  #[graphql(validator(max_length = 255))]
  pub name: Option<String>,
  /// New plain-text workspace description. Empty text clears it.
  pub description: Option<String>,
  /// Whether to make the workspace publicly accessible.
  pub public: Option<bool>,
  /// Toggle AI / Copilot features for the workspace.
  pub enable_ai: Option<bool>,
  /// Toggle document sharing within the workspace.
  pub enable_sharing: Option<bool>,
  /// Toggle URL preview card generation.
  pub enable_url_preview: Option<bool>,
  /// Toggle AI document embedding for search.
  pub enable_doc_embedding: Option<bool>,
}

/// Existing workspace settings update, scoped to its root or one Organizer folder.
#[derive(InputObject)]
pub struct WorkspaceOverviewSettingsInput {
  pub expected_revision: i64,
  #[graphql(validator(max_length = 512))]
  pub folder_id: Option<String>,
  /// Omission preserves the binding; null clears it without deleting its Page.
  pub introduction: MaybeUndefined<Option<WorkspaceContentResourceInput>>,
  /// Omission preserves selection; null admits all branches; [] hides navigation.
  pub folder_ids: MaybeUndefined<Option<Vec<String>>>,
  /// Omission preserves presentation; null clears this scope's override.
  pub register_presentation: MaybeUndefined<WorkspaceOverviewRegisterPresentationInput>,
}

#[derive(InputObject)]
pub struct WorkspaceOverviewRegisterPresentationInput {
  pub display_properties: Vec<String>,
  pub order_by: WorkspaceOverviewOrderByInput,
}

#[derive(InputObject)]
pub struct WorkspaceOverviewOrderByInput {
  #[graphql(name = "type")]
  pub property_type: String,
  pub key: String,
  pub desc: bool,
}

impl WorkspaceOverviewSettingsInput {
  pub(super) fn into_patch(
    self,
    workspace_id: Uuid,
  ) -> myoxus_application::auth::AuthResult<WorkspaceOverviewSettingsPatch> {
    use myoxus_application::auth::AuthError;
    let introduction = match self.introduction {
      MaybeUndefined::Undefined => None,
      MaybeUndefined::Null | MaybeUndefined::Value(None) => Some(None),
      MaybeUndefined::Value(Some(value)) => Some(Some(
        WorkspaceContentResourceRef::new(workspace_id, value.kind.into(), value.id)
          .map_err(|error| AuthError::InvalidInput(error.to_string()))?,
      )),
    };
    let folder_ids = match self.folder_ids {
      MaybeUndefined::Undefined => None,
      MaybeUndefined::Null => Some(None),
      MaybeUndefined::Value(value) => Some(value),
    };
    Ok(WorkspaceOverviewSettingsPatch {
      expected_revision: self.expected_revision,
      scope: self
        .folder_id
        .map_or(OverviewSettingsScope::Workspace, OverviewSettingsScope::Folder),
      introduction,
      folder_ids,
      register_presentation: match self.register_presentation {
        MaybeUndefined::Undefined => None,
        MaybeUndefined::Null => Some(None),
        MaybeUndefined::Value(value) => Some(Some(myoxus_domain::workspace_overview::OverviewRegisterPresentation {
          display_properties: value.display_properties,
          order_by: myoxus_domain::workspace_overview::OverviewOrderBy {
            property_type: value.order_by.property_type,
            key: value.order_by.key,
            desc: value.order_by.desc,
          },
        })),
      },
    })
  }
}

/// GraphQL type for the full authenticated user profile (both user and admin-panel views).
#[derive(Clone, Debug)]
pub struct UserType {
  pub id: Uuid,
  pub email: String,
  /// Whether the e-mail address has been verified.
  pub email_verified: bool,
  pub avatar_url: Option<String>,
  pub name: Option<String>,
  /// Whether the user holds server-admin privileges.
  pub is_admin: bool,
  /// Whether the account is administratively disabled.
  pub disabled: bool,
  /// Whether a password credential is set on the account.
  pub has_password: bool,
}

/// Reduced user view shown to callers who are not permitted to see full profile details.
#[derive(SimpleObject)]
#[graphql(name = "LimitedUserType")]
pub struct LimitedUserType {
  /// E-mail address (only field exposed to unprivileged callers).
  pub email: String,
  /// Whether a password is set (required by the sign-in preflight).
  pub has_password: bool,
}

/// Union returned by `userById` — resolves to the full or limited profile depending on
/// whether the caller is the user themselves or an admin.
#[derive(Union)]
#[graphql(name = "UserOrLimitedUser")]
pub enum UserOrLimitedUser {
  UserType(UserType),
  LimitedUserType(LimitedUserType),
}

/// Human-readable quota limits (formatted as strings) for display in the UI.
#[derive(SimpleObject)]
pub struct UserQuotaHumanReadableType {
  /// Quota plan name.
  pub name: String,
  /// Maximum blob size in a human-readable format (e.g. `"10 MB"` or `"Unlimited"`).
  pub blob_limit: String,
  /// Total storage quota as a human-readable string (e.g. `"100 GB"` or `"Unlimited"`).
  pub storage_quota: String,
  /// History retention period as a human-readable string (e.g. `"30 days"` or `"Unlimited"`).
  pub history_period: String,
  /// Maximum number of workspace members as a human-readable string.
  pub member_limit: String,
  /// Current member count (formatted string).
  pub member_count: String,
  /// Number of members over the limit (formatted string).
  pub overcapacity_member_count: String,
}

/// Format a byte count as a human-readable string (e.g. `"10 MB"`, `"1.5 GB"`).
/// Returns `"Unlimited"` for values <= 0 or >= 1 TiB (effectively unlimited).
pub(crate) fn format_bytes_human(bytes: i64) -> String {
  if bytes <= 0 {
    return "Unlimited".to_string();
  }
  const KB: i64 = 1024;
  const MB: i64 = 1024 * KB;
  const GB: i64 = 1024 * MB;
  const TB: i64 = 1024 * GB;
  if bytes >= TB {
    return "Unlimited".to_string();
  }
  if bytes >= GB {
    let val = bytes as f64 / GB as f64;
    if (val - val.round()).abs() < 0.05 {
      return format!("{} GB", val.round() as i64);
    }
    return format!("{:.1} GB", val);
  }
  if bytes >= MB {
    let val = bytes as f64 / MB as f64;
    if (val - val.round()).abs() < 0.05 {
      return format!("{} MB", val.round() as i64);
    }
    return format!("{:.1} MB", val);
  }
  if bytes >= KB {
    let val = bytes as f64 / KB as f64;
    if (val - val.round()).abs() < 0.05 {
      return format!("{} KB", val.round() as i64);
    }
    return format!("{:.1} KB", val);
  }
  format!("{} bytes", bytes)
}

/// Workspace resource quota and current usage.
#[derive(SimpleObject)]
pub struct UserQuotaType {
  /// Quota plan name.
  pub name: String,
  /// Maximum blob upload size in bytes.
  pub blob_limit: i32,
  /// Total storage quota in bytes.
  pub storage_quota: i64,
  /// Currently used storage in bytes.
  pub used_storage_quota: i64,
  /// Number of days of document history retained.
  pub history_period: i32,
  /// Maximum workspace members.
  pub member_limit: i32,
  /// Current member count.
  pub member_count: i32,
  /// Members exceeding the plan limit.
  pub overcapacity_member_count: i32,
  /// Human-readable representations of the quota values.
  pub human_readable: UserQuotaHumanReadableType,
}

/// Storage usage for a user or workspace (returned by usage queries).
#[derive(SimpleObject)]
pub struct UserQuotaUsageType {
  /// Current storage used in bytes.
  pub storage_quota: i64,
}

/// Copilot usage quota (stub; always returns fixed values in the current implementation).
#[derive(SimpleObject)]
pub struct CopilotQuotaType {
  /// Maximum number of Copilot tokens/requests allowed.
  pub limit: i64,
  /// Number of tokens/requests consumed.
  pub used: i64,
}

/// A single Copilot AI model descriptor.
#[derive(SimpleObject)]
pub struct CopilotModelType {
  /// Model identifier string (e.g. `"gpt-4o"`).
  pub id: String,
  /// Human-readable model name.
  pub name: String,
  /// An enabled configured provider can honor both explicit reasoning states.
  pub reasoning_available: bool,
  /// At least one enabled configured provider preserves actual image input.
  pub supports_vision: bool,
}

/// Available Copilot models for a workspace.
#[derive(SimpleObject)]
pub struct CopilotModelsType {
  /// The default model ID selected for new sessions.
  pub default_model: String,
  /// Optional models the user can switch to.
  pub optional_models: Vec<CopilotModelType>,
  /// Retained empty protocol field; no access or plan semantics.
  pub pro_models: Vec<CopilotModelType>,
}

/// Sort order for Copilot chat history queries.
#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "ChatHistoryOrder")]
pub enum ChatHistoryOrderType {
  #[graphql(name = "asc")]
  Asc,
  #[graphql(name = "desc")]
  Desc,
}

impl ChatHistoryOrderType {
  pub(crate) fn is_desc(self) -> bool {
    matches!(self, Self::Desc)
  }
}

/// Input for creating a new Copilot chat session.
#[derive(InputObject)]
#[graphql(name = "CreateChatSessionInput")]
pub struct CreateChatSessionInput {
  pub workspace_id: String,
  pub prompt_name: String,
  pub doc_id: Option<String>,
  pub pinned: Option<bool>,
  pub reuse_latest_chat: Option<bool>,
}

/// Input for updating an existing Copilot chat session.
#[derive(InputObject)]
#[graphql(name = "UpdateChatSessionInput")]
pub struct UpdateChatSessionInput {
  pub session_id: String,
  pub prompt_name: Option<String>,
  pub doc_id: Option<String>,
  pub pinned: Option<bool>,
  pub title: Option<String>,
}

/// Input for deleting one or more Copilot chat sessions.
#[derive(InputObject)]
#[graphql(name = "DeleteSessionInput")]
pub struct DeleteSessionInput {
  pub workspace_id: String,
  pub session_ids: Vec<String>,
  pub doc_id: Option<String>,
}

/// Input for sending a new message to a Copilot session.
#[derive(InputObject)]
#[graphql(name = "CreateChatMessageInput")]
pub struct CreateChatMessageInput {
  /// Stable correlation for one explicit send, not a client-owned stream lease.
  pub request_id: Option<String>,
  /// Session to post the message to.
  pub session_id: String,
  /// Text content of the message.
  pub content: Option<String>,
  /// Optional list of blob keys attached to the message.
  pub attachments: Option<Vec<String>>,
  /// Prompt parameters. Server request/anchor/lease fields are reserved and
  /// cannot be authored here; request correlation has its own input field.
  pub params: Option<serde_json::Value>,
}

/// Filter/pagination parameters for Copilot chat history queries.
#[derive(InputObject, Default)]
#[graphql(name = "QueryChatHistoriesInput")]
pub struct QueryChatHistoriesInput {
  pub action: Option<bool>,
  pub fork: Option<bool>,
  pub limit: Option<i32>,
  pub skip: Option<i32>,
  pub pinned: Option<bool>,
  pub session_id: Option<String>,
  pub session_order: Option<ChatHistoryOrderType>,
  pub message_order: Option<ChatHistoryOrderType>,
  pub with_messages: Option<bool>,
  pub with_prompt: Option<bool>,
}

/// A single event in a Copilot streaming response.
#[derive(SimpleObject)]
#[graphql(name = "StreamObject")]
pub struct StreamObjectType {
  pub r#type: String,
  pub text_delta: Option<String>,
  pub tool_call_id: Option<String>,
  pub tool_name: Option<String>,
  pub args: Option<serde_json::Value>,
  pub result: Option<serde_json::Value>,
}

/// A single message in a Copilot conversation.
#[derive(SimpleObject)]
#[graphql(name = "ChatMessage")]
pub struct ChatMessageType {
  pub id: Option<ID>,
  pub role: String,
  pub content: String,
  pub attachments: Option<Vec<String>>,
  pub generated_files: Vec<CopilotGeneratedFileType>,
  pub stream_objects: Option<Vec<StreamObjectType>>,
  pub params: Option<serde_json::Value>,
  pub created_at: DateTime<Utc>,
}

#[derive(SimpleObject)]
pub struct CopilotGeneratedFileType {
  pub id: ID,
  pub file_name: String,
  pub mime_type: String,
  pub size_bytes: i64,
  pub format: String,
  pub download_url: String,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
pub enum CopilotExportFormat {
  Pdf,
  Html,
}

/// A full Copilot session record including all messages.
#[derive(SimpleObject)]
#[graphql(name = "CopilotHistories")]
pub struct CopilotHistoriesType {
  pub session_id: String,
  pub workspace_id: String,
  pub doc_id: Option<String>,
  pub parent_session_id: Option<String>,
  pub prompt_name: String,
  pub model: String,
  pub optional_models: Vec<String>,
  pub action: Option<String>,
  pub pinned: bool,
  pub title: Option<String>,
  pub tokens: i32,
  pub messages: Vec<ChatMessageType>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Cursor-based edge for a Copilot history record.
#[derive(SimpleObject)]
#[graphql(name = "CopilotHistoriesTypeEdge")]
pub struct CopilotHistoriesTypeEdge {
  /// Opaque pagination cursor.
  pub cursor: String,
  pub node: CopilotHistoriesType,
}

/// Paginated list of Copilot session history records.
#[derive(SimpleObject)]
#[graphql(name = "PaginatedCopilotHistoriesType")]
pub struct PaginatedCopilotHistoriesType {
  /// Total number of sessions matching the filter.
  pub total_count: i32,
  pub edges: Vec<CopilotHistoriesTypeEdge>,
  pub page_info: PageInfoType,
}

/// Sub-root resolver context for Copilot-scoped queries.
pub struct CopilotType {
  /// Usage quota for the current user.
  pub quota: CopilotQuotaType,
  /// Authenticated user UUID.
  pub user_id: Uuid,
  /// Optional workspace UUID when the query is workspace-scoped.
  pub workspace_id: Option<Uuid>,
}

// --- From impls for UserType ---

impl From<myoxus_application::auth::HistoricalUserProfile> for UserType {
  fn from(user: myoxus_application::auth::HistoricalUserProfile) -> Self {
    // Changelog attribution is not an account/credential projection.
    Self {
      id: user.id,
      disabled: user.email.is_empty(),
      email: user.email,
      avatar_url: user.avatar_url,
      name: user.name,
      email_verified: false,
      is_admin: false,
      has_password: false,
    }
  }
}

impl From<AuthUser> for UserType {
  fn from(user: AuthUser) -> Self {
    Self {
      id: user.id,
      email: user.email,
      email_verified: user.email_verified_at.is_some(),
      avatar_url: user.avatar_url,
      name: user.name,
      is_admin: user.is_admin,
      disabled: user.disabled,
      has_password: user.password_hash.is_some(),
    }
  }
}

impl From<AuthUserProjection> for UserType {
  fn from(user: AuthUserProjection) -> Self {
    Self {
      id: user.id,
      email: user.email,
      email_verified: user.email_verified_at.is_some(),
      avatar_url: user.avatar_url,
      name: user.name,
      is_admin: user.is_admin,
      disabled: user.disabled,
      has_password: user.has_password,
    }
  }
}

impl From<myoxus_application::admin::AdminUserProfile> for UserType {
  fn from(user: myoxus_application::admin::AdminUserProfile) -> Self {
    Self {
      id: user.id,
      email: user.email,
      email_verified: user.email_verified_at.is_some(),
      avatar_url: user.avatar_key,
      name: Some(user.name),
      is_admin: user.is_admin,
      disabled: user.disabled,
      has_password: user.has_password,
    }
  }
}

impl From<User> for UserType {
  fn from(user: User) -> Self {
    Self {
      id: user.id,
      email: user.email,
      email_verified: user.email_verified_at.is_some(),
      avatar_url: user.avatar_key,
      name: Some(user.name),
      is_admin: user.is_admin,
      disabled: user.disabled,
      has_password: user.password_hash.is_some(),
    }
  }
}

// --- Types from lines 2489-3168 ---

/// Top-level server configuration object returned by `serverConfig` query.
///
/// Provides version, feature flags, and OAuth provider list used by the web
/// client to configure itself at startup.
#[derive(SimpleObject, Clone, Serialize, Deserialize)]
#[graphql(complex)]
pub struct ServerConfigType {
  pub version: String,
  pub flavor: String,
  pub base_url: String,
  pub name: String,
  pub deployment_type: ServerDeploymentType,
  /// Legacy `type` field — alias for `deploymentType` as a string.
  /// The web client queries this field by name; `type` is a Rust keyword
  /// so we expose it via the graphql rename attribute.
  #[graphql(name = "type")]
  pub server_type: String,
  pub initialized: bool,
  pub features: Vec<ServerFeature>,
  pub oauth_providers: Vec<OAuthProviderType>,
  pub calendar_providers: Vec<super::calendar::CalendarProviderType>,
  #[graphql(name = "calendarCalDAVProviders")]
  pub calendar_caldav_providers: Vec<super::calendar::CalendarCalDAVProviderPresetObjectType>,
  pub available_upgrade: Option<ReleaseVersionType>,
  pub available_user_features: Vec<FeatureType>,
  pub available_workspace_features: Vec<FeatureType>,
  pub credentials_requirement: CredentialsRequirementType,
  /// Git Sync policy configuration. Added in 0.30 — older clients that
  /// don't query this field are unaffected (GraphQL ignores unqueried fields).
  #[graphql(name = "gitSync")]
  pub git_sync: ServerGitSyncConfigType,
  /// Journal settings (admin-configurable). The web frontend reads these
  /// at startup to set firstDayOfWeek and showCalendarWeeks.
  pub journal: ServerJournalConfigType,
  /// Client settings (admin-configurable). Includes the operator-set download URL.
  pub client: ServerClientConfigType,
  /// Public request-lifecycle budgets for the private preview consumer. All
  /// renderer and cache limits remain operator-private.
  pub preview: ServerPreviewClientConfigType,
  /// i18n settings (admin-configurable). The web frontend reads `availableLocales` at startup
  /// to restrict the language selector to admin-permitted locales.
  #[graphql(name = "i18n")]
  pub i18n: ServerI18nConfigType,
}

#[derive(SimpleObject, Clone, Serialize, Deserialize)]
pub struct ServerPreviewClientConfigType {
  /// Browser requests share the existing effective per-actor render budget.
  #[graphql(name = "maxConcurrentRequests")]
  pub max_concurrent_requests: usize,
  #[graphql(name = "requestTimeoutMs")]
  pub request_timeout_ms: u64,
  #[graphql(name = "retryCount")]
  pub retry_count: u32,
}

/// Client configuration exposed in serverConfig.
/// Values are set through the canonical Admin config contract and read by Web.
#[derive(SimpleObject, Clone, Serialize, Deserialize)]
pub struct ServerClientConfigType {
  /// Operator-configured app download URL. Empty string means
  /// "use BUILD_CONFIG.downloadUrl from the frontend build".
  #[graphql(name = "downloadUrl")]
  pub download_url: String,
  /// Allow the web editor to fall back to the `execCommand('copy'/'paste')`
  /// API when the Clipboard API is unavailable (e.g. HTTP without HTTPS).
  /// Set to true if the instance is intentionally served over plain HTTP
  /// behind a trusted reverse proxy.
  #[graphql(name = "clipboardHttpFallback")]
  pub clipboard_http_fallback: bool,
}

/// Journal configuration exposed in serverConfig.
/// Admin paths are `journal.first_day_of_week` and
/// `journal.show_calendar_weeks`; GraphQL retains its camel-case field names.
#[derive(SimpleObject, Clone, Serialize, Deserialize)]
pub struct ServerJournalConfigType {
  /// Whether to show ISO calendar week numbers in the journal month view.
  #[graphql(name = "showCalendarWeeks")]
  pub show_calendar_weeks: bool,
  /// First day of the week: "monday" or "sunday".
  #[graphql(name = "firstDayOfWeek")]
  pub first_day_of_week: String,
}

/// i18n configuration exposed in serverConfig.
/// Allows the web frontend to show only the locales permitted by the admin.
#[derive(SimpleObject, Clone, Serialize, Deserialize)]
pub struct ServerI18nConfigType {
  /// List of locale codes available for the web frontend language selector.
  /// An empty list means "all supported locales are available".
  #[graphql(name = "availableLocales")]
  pub available_locales: Vec<String>,
  /// Default locale for new users / first visit.
  #[graphql(name = "defaultLocale")]
  pub default_locale: String,
}

/// Git Sync policy configuration exposed in serverConfig.
/// All fields are read-only for non-admin users — the admin changes
/// these values through the canonical Admin config mutation.
#[derive(SimpleObject, Clone, Serialize, Deserialize)]
#[graphql(name = "ServerGitSyncConfig")]
pub struct ServerGitSyncConfigType {
  /// Master switch: when false, Git Sync UI is hidden from all users.
  pub enabled: bool,
  /// Which sync directions are available to users.
  #[graphql(name = "allowedDirections")]
  pub allowed_directions: Vec<String>,
  /// Which auth methods users can choose.
  #[graphql(name = "allowedAuthMethods")]
  pub allowed_auth_methods: Vec<String>,
  /// Default branch pre-filled in profile forms.
  #[graphql(name = "defaultBranch")]
  pub default_branch: String,
  /// Whether automatic sync (polling/on-change) is available.
  #[graphql(name = "autoSyncAllowed")]
  pub auto_sync_allowed: bool,
  /// Whether webhook-triggered sync is available.
  #[graphql(name = "webhookAllowed")]
  pub webhook_allowed: bool,
  /// SSH host-key verification policy used by server-side Git transports.
  #[graphql(name = "sshHostKeyPolicy")]
  pub ssh_host_key_policy: String,
  /// Maximum total disk space (MB) for git mirror repositories (global setting).
  #[graphql(name = "maxMirrorStorageMb")]
  pub max_mirror_storage_mb: u64,
}

/// An available server upgrade with version string and download URL.
#[derive(SimpleObject, Clone, Serialize, Deserialize)]
pub struct ReleaseVersionType {
  /// Semantic version string of the available release.
  pub version: String,
  /// Download or changelog URL.
  pub url: String,
  /// Human-readable changelog text for this release (optional).
  pub changelog: Option<String>,
  /// ISO-8601 publication timestamp of this release (optional).
  pub published_at: Option<String>,
}

/// Minimum and maximum accepted password lengths.
#[derive(SimpleObject, Clone, Serialize, Deserialize)]
pub struct PasswordLimitsType {
  pub min_length: i32,
  pub max_length: i32,
}

/// Password policy constraints included in server config.
#[derive(SimpleObject, Clone, Serialize, Deserialize)]
pub struct CredentialsRequirementType {
  pub password: PasswordLimitsType,
}

/// Identifies the server deployment model.
///
/// This enum value is returned to clients via `serverConfig.deploymentType`.
/// Clients branch on this value to control socket transport (polling+WS vs
/// WS-only), telemetry transport (HTTP vs WebSocket), admin UI module
/// visibility, sign-in flow guards and desktop invite dialogs.
///
/// The GraphQL wire values deliberately use the same Myoxus vocabulary as
/// the Rust model and operator configuration: `Cloud` / `Standalone`.
#[derive(Enum, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[graphql(rename_items = "PascalCase")]
pub enum ServerDeploymentType {
  /// Managed cloud deployment (Myoxus SaaS).
  /// Client effects: WS-only transport, WS telemetry, cloud UI modules.
  Cloud,
  /// Standalone on-premise deployment.
  /// Client effects: polling+WS transport, HTTP telemetry, standalone UI.
  Standalone,
}

/// Optional server capabilities advertised to clients.
#[derive(Enum, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[graphql(rename_items = "PascalCase")]
pub enum ServerFeature {
  /// OAuth social login is configured.
  #[graphql(name = "OAuth")]
  OAuth,
  /// Payment/billing is enabled (always `false` in Myoxus).
  Payment,
  /// Copilot AI integration is enabled.
  Copilot,
  /// CAPTCHA challenge is enabled on auth endpoints.
  Captcha,
  /// Local-first Yjs workspaces are supported (always true in Myoxus).
  LocalWorkspace,
  /// Full-text search indexer is active (Postgres FTS + pgvector).
  Indexer,
  /// Copilot embedding store is available (pgvector).
  CopilotEmbedding,
  /// Document commenting is enabled (always true in Myoxus).
  Comment,
}

/// Upload strategy negotiated by `createBlobUploadInit`.
#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "BlobUploadMethod", rename_items = "PascalCase")]
pub enum BlobUploadMethodType {
  /// Upload via GraphQL mutation body (small blobs).
  Graphql,
  /// Multipart upload via the `/api/blob-upload/` REST endpoints.
  Multipart,
  /// Pre-signed URL upload directly to object storage.
  Presigned,
}

/// An already-uploaded part in an in-progress multipart upload.
#[derive(SimpleObject)]
#[graphql(name = "BlobUploadedPartType")]
pub struct BlobUploadedPartType {
  /// 1-based part number.
  pub part_number: i32,
  /// ETag returned by the storage backend for this part.
  pub etag: String,
}

/// Initialization response for `createBlobUploadInit` — tells the client how to upload.
#[derive(SimpleObject)]
#[graphql(name = "BlobUploadInitType")]
pub struct BlobUploadInitType {
  /// Negotiated upload strategy.
  pub method: BlobUploadMethodType,
  /// Storage key under which the blob will be stored.
  pub blob_key: String,
  /// `true` when an identical blob was already uploaded (content-addressed dedup).
  pub already_uploaded: Option<bool>,
  /// Pre-signed upload URL (for `Presigned` method).
  pub upload_url: Option<String>,
  /// Additional headers to set when using the pre-signed URL.
  pub headers: Option<serde_json::Value>,
  /// When the pre-signed URL expires.
  pub expires_at: Option<DateTime<Utc>>,
  /// Multipart upload ID (for `Multipart` method).
  pub upload_id: Option<String>,
  /// Size in bytes of each part (for `Multipart` method).
  pub part_size: Option<i32>,
  /// Parts already uploaded (for resuming a multipart upload).
  pub uploaded_parts: Option<Vec<BlobUploadedPartType>>,
}

/// Pre-signed URL for uploading a single multipart part.
#[derive(SimpleObject)]
#[graphql(name = "BlobUploadPartType")]
pub struct BlobUploadPartType {
  /// Pre-signed URL for this part.
  pub upload_url: String,
  /// Required headers to include when PUT-ting to the URL.
  pub headers: Option<serde_json::Value>,
  /// When the pre-signed URL expires.
  pub expires_at: Option<DateTime<Utc>>,
}

/// Acknowledgment of a completed part, used to finalize multipart uploads.
#[derive(InputObject)]
#[graphql(name = "BlobUploadPartInput")]
pub struct BlobUploadPartInputType {
  /// 1-based part number.
  pub part_number: i32,
  /// ETag from the storage backend response.
  pub etag: String,
}

#[derive(SimpleObject)]
#[graphql(name = "CommentType")]
pub struct CommentType {
  pub id: ID,
  pub workspace_id: ID,
  pub doc_id: ID,
  pub parent_comment_id: Option<ID>,
  pub author_id: ID,
  pub body: serde_json::Value,
  pub resolved: bool,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  /// Whether the requesting user has unread activity in this thread.
  pub unread: bool,
}

/// A reply to a document comment thread.
#[derive(SimpleObject)]
#[graphql(name = "ReplyObjectType")]
pub struct ReplyObjectType {
  pub id: ID,
  pub comment_id: ID,
  pub content: serde_json::Value,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub user: PublicUserType,
}

/// A top-level document comment with its nested replies.
#[derive(SimpleObject)]
#[graphql(name = "CommentObjectType")]
pub struct CommentObjectType {
  pub id: ID,
  pub parent_comment_id: Option<ID>,
  pub content: serde_json::Value,
  pub resolved: bool,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub user: PublicUserType,
  pub replies: Vec<ReplyObjectType>,
}

/// Cursor-based edge for a paginated comment list.
#[derive(SimpleObject)]
#[graphql(name = "CommentObjectTypeEdge")]
pub struct CommentObjectTypeEdge {
  pub cursor: String,
  pub node: CommentObjectType,
}

/// Paginated list of document comments.
#[derive(SimpleObject)]
#[graphql(name = "PaginatedCommentObjectType")]
pub struct PaginatedCommentObjectType {
  pub total_count: i32,
  pub edges: Vec<CommentObjectTypeEdge>,
  pub page_info: PageInfoType,
}

/// Action type for a comment change event (used in change-log / SSE feeds).
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "CommentChangeActionType", rename_items = "PascalCase")]
pub enum CommentChangeActionType {
  Create,
  Update,
  Delete,
}

/// A single comment change event in the change log.
#[derive(SimpleObject)]
#[graphql(name = "CommentChangeObjectType")]
pub struct CommentChangeObjectType {
  /// UUID of the change event.
  pub id: ID,
  /// UUID of the comment that was changed.
  pub comment_id: Option<ID>,
  pub action: CommentChangeActionType,
  /// Full comment payload at the time of the change.
  pub item: serde_json::Value,
}

/// Cursor-based edge for a comment change list.
#[derive(SimpleObject)]
#[graphql(name = "CommentChangeObjectTypeEdge")]
pub struct CommentChangeObjectTypeEdge {
  pub cursor: String,
  pub node: CommentChangeObjectType,
}

/// Paginated list of comment change events.
#[derive(SimpleObject)]
#[graphql(name = "PaginatedCommentChangeObjectType")]
pub struct PaginatedCommentChangeObjectType {
  pub total_count: i32,
  pub edges: Vec<CommentChangeObjectTypeEdge>,
  pub page_info: PageInfoType,
}

impl From<myoxus_domain::entities::Comment> for CommentType {
  fn from(c: myoxus_domain::entities::Comment) -> Self {
    Self {
      id: ID::from(c.id.to_string()),
      workspace_id: ID::from(c.workspace_id.to_string()),
      doc_id: ID::from(c.doc_id.to_string()),
      parent_comment_id: c.parent_comment_id.map(|id| ID::from(id.to_string())),
      author_id: ID::from(c.author_id.to_string()),
      body: c.body,
      resolved: c.resolved,
      created_at: c.created_at,
      updated_at: c.updated_at,
      unread: false,
    }
  }
}

impl From<myoxus_application::comment::CommentThreadView> for CommentType {
  fn from(c: myoxus_application::comment::CommentThreadView) -> Self {
    Self {
      id: ID::from(c.comment.id.to_string()),
      workspace_id: ID::from(c.comment.workspace_id.to_string()),
      doc_id: ID::from(c.comment.doc_id.to_string()),
      parent_comment_id: c.comment.parent_comment_id.map(|id| ID::from(id.to_string())),
      author_id: ID::from(c.comment.author_id.to_string()),
      body: c.comment.body,
      resolved: c.comment.resolved,
      created_at: c.comment.created_at,
      updated_at: c.comment.updated_at,
      unread: c.unread,
    }
  }
}

/// A historical snapshot of a comment body from before it was edited.
#[derive(SimpleObject)]
#[graphql(name = "CommentEditHistoryType")]
pub struct CommentEditHistoryType {
  /// UUID of this history entry.
  pub id: ID,
  /// UUID of the comment that was edited.
  pub comment_id: ID,
  /// Body content at the time of this snapshot.
  pub body: serde_json::Value,
  /// When the edit was recorded.
  pub edited_at: DateTime<Utc>,
}

impl From<myoxus_application::comment::CommentEditHistoryEntry> for CommentEditHistoryType {
  fn from(e: myoxus_application::comment::CommentEditHistoryEntry) -> Self {
    Self {
      id: ID::from(e.id.to_string()),
      comment_id: ID::from(e.comment_id.to_string()),
      body: e.body,
      edited_at: e.edited_at,
    }
  }
}

/// Anchors a comment to a text range inside a document block.
#[derive(Debug, InputObject)]
pub struct SelectionAnchorInput {
  /// Quoted text the comment is anchored to.
  pub quote: String,
  /// Character offset of the anchor start within the block.
  pub start: Option<i32>,
  /// Character offset of the anchor end within the block.
  pub end: Option<i32>,
  /// Text immediately before the quote (for disambiguation).
  pub prefix: Option<String>,
  /// Text immediately after the quote (for disambiguation).
  pub suffix: Option<String>,
}

/// Filter for listing comment threads on a document.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "CommentThreadFilter", rename_items = "PascalCase")]
pub enum CommentThreadFilterType {
  /// All threads regardless of status.
  All,
  /// Only open (unresolved) threads.
  Open,
  /// Only resolved threads.
  Resolved,
  /// Only threads the current user is involved in.
  Mine,
}

/// Cursor-based pagination input compatible with the Relay connection spec.
#[derive(InputObject, Default, Debug)]
#[graphql(name = "PaginationInput")]
pub struct PaginationInputType {
  /// Maximum number of records to return.
  pub first: Option<i32>,
  /// Number of records to skip (offset pagination alternative).
  pub offset: Option<i32>,
  /// Return records after this cursor.
  pub after: Option<String>,
}

/// Input for creating a new top-level comment on a document.
#[derive(InputObject)]
pub struct CommentCreateInput {
  /// UUID of the workspace containing the document.
  pub workspace_id: String,
  /// UUID of the document to comment on.
  pub doc_id: String,
  /// Rich-text body (Virgultum JSON format).
  pub content: serde_json::Value,
}

/// Input for updating the body of an existing comment.
#[derive(InputObject)]
pub struct CommentUpdateInput {
  /// UUID of the comment to update.
  pub id: String,
  /// New rich-text body.
  pub content: serde_json::Value,
}

/// Input for changing the resolved state of a comment.
#[derive(InputObject)]
pub struct CommentResolveInput {
  /// UUID of the comment.
  pub id: String,
  /// `true` to mark as resolved, `false` to reopen.
  pub resolved: bool,
}

/// Input for adding a reply to a comment thread.
#[derive(InputObject)]
pub struct ReplyCreateInput {
  /// UUID of the parent comment.
  pub comment_id: String,
  /// Rich-text body of the reply.
  pub content: serde_json::Value,
}

/// Input for updating a reply's body.
#[derive(InputObject)]
pub struct ReplyUpdateInput {
  /// UUID of the reply.
  pub id: String,
  /// New rich-text body.
  pub content: serde_json::Value,
}

/// Document context embedded in a mention notification.
#[derive(InputObject)]
pub struct MentionDocInput {
  /// Document UUID.
  pub id: String,
  /// Document title at the time of the mention.
  pub title: Option<String>,
  /// Display mode the link should open in.
  pub mode: Option<String>,
  /// Block ID containing the mention anchor.
  pub block_id: Option<String>,
  /// Inline element ID of the mention.
  pub element_id: Option<String>,
}

/// Input for dispatching an @-mention notification.
#[derive(InputObject)]
pub struct MentionInput {
  /// UUID of the workspace where the mention occurred.
  pub workspace_id: String,
  /// UUID of the user who was mentioned.
  pub user_id: String,
  /// Document context for the mention link.
  pub doc: MentionDocInput,
}

/// Discriminator for the kind of in-app notification.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "NotificationType", rename_items = "PascalCase")]
pub enum NotificationTypeType {
  General,
  Mention,
  Comment,
  CommentReply,
  Invitation,
  InvitationAccepted,
  InvitationBlocked,
  MemberApproval,
  MemberApproved,
  MemberApprovalDeclined,
  MemberRemoved,
  RoleChanged,
  CommentMention,
  CalendarReminder,
  DatabaseRowReminder,
  DatabaseRowAssigned,
  DatabaseTaskChanged,
  DocumentShared,
  WorkspaceContentMoved,
  DocumentChanged,
}

impl NotificationTypeType {
  /// Return the canonical storage discriminator for this public enum value.
  ///
  /// Input filters use this total mapping instead of accepting arbitrary
  /// strings from GraphQL.
  pub const fn as_storage(self) -> &'static str {
    match self {
      Self::General => "general",
      Self::Mention => "mention",
      Self::Comment => "comment",
      Self::CommentReply => "comment_reply",
      Self::Invitation => "invitation",
      Self::InvitationAccepted => "invitation_accepted",
      Self::InvitationBlocked => "invitation_blocked",
      Self::MemberApproval => "member_approval",
      Self::MemberApproved => "member_approved",
      Self::MemberApprovalDeclined => "member_approval_declined",
      Self::MemberRemoved => "member_removed",
      Self::RoleChanged => "role_changed",
      Self::CommentMention => "comment_mention",
      Self::CalendarReminder => "calendar_reminder",
      Self::DatabaseRowReminder => "database_row_reminder",
      Self::DatabaseRowAssigned => "database.row.assigned",
      Self::DatabaseTaskChanged => "database.task.changed",
      Self::DocumentShared => "doc_shared",
      Self::WorkspaceContentMoved => "workspace_content_moved",
      Self::DocumentChanged => "document_changed",
    }
  }

  pub fn from_storage(value: &str) -> Self {
    match value {
      "general" => Self::General,
      "mention" => Self::Mention,
      "comment" => Self::Comment,
      "comment_reply" => Self::CommentReply,
      "invitation" => Self::Invitation,
      // Older persisted invitation events used this discriminator.
      "invite" | "workspace_invitation" => Self::Invitation,
      "invitation_accepted" => Self::InvitationAccepted,
      "invitation_blocked" => Self::InvitationBlocked,
      "member_approval" => Self::MemberApproval,
      "member_approved" => Self::MemberApproved,
      "member_approval_declined" => Self::MemberApprovalDeclined,
      "member_removed" => Self::MemberRemoved,
      "role_changed" => Self::RoleChanged,
      "comment_mention" => Self::CommentMention,
      "calendar_reminder" => Self::CalendarReminder,
      "database_row_reminder" => Self::DatabaseRowReminder,
      "database.row.assigned" | "database_row_assigned" => Self::DatabaseRowAssigned,
      "database.task.changed" => Self::DatabaseTaskChanged,
      "doc_shared" => Self::DocumentShared,
      "workspace_content_moved" => Self::WorkspaceContentMoved,
      "document_changed" => Self::DocumentChanged,
      _ => Self::General,
    }
  }
}

/// Optional server-side filters for the authenticated notification feed.
#[derive(Debug, Clone, InputObject)]
#[graphql(name = "NotificationListFilterInput")]
pub struct NotificationListFilterInput {
  /// Include already-read notifications. Omitted values preserve the unread
  /// default used by existing clients.
  pub include_read: Option<bool>,
  /// Restrict the result set to these notification types.
  pub types: Option<Vec<NotificationTypeType>>,
}

#[cfg(test)]
mod notification_type_tests {
  use super::NotificationTypeType;

  #[test]
  fn notification_type_storage_mapping_is_total_and_roundtrips() {
    let mappings = [
      (NotificationTypeType::General, "general"),
      (NotificationTypeType::Mention, "mention"),
      (NotificationTypeType::Comment, "comment"),
      (NotificationTypeType::CommentReply, "comment_reply"),
      (NotificationTypeType::Invitation, "invitation"),
      (NotificationTypeType::InvitationAccepted, "invitation_accepted"),
      (NotificationTypeType::InvitationBlocked, "invitation_blocked"),
      (NotificationTypeType::MemberApproval, "member_approval"),
      (NotificationTypeType::MemberApproved, "member_approved"),
      (NotificationTypeType::MemberApprovalDeclined, "member_approval_declined"),
      (NotificationTypeType::MemberRemoved, "member_removed"),
      (NotificationTypeType::RoleChanged, "role_changed"),
      (NotificationTypeType::CommentMention, "comment_mention"),
      (NotificationTypeType::CalendarReminder, "calendar_reminder"),
      (NotificationTypeType::DatabaseRowReminder, "database_row_reminder"),
      (NotificationTypeType::DatabaseRowAssigned, "database.row.assigned"),
      (NotificationTypeType::DatabaseTaskChanged, "database.task.changed"),
      (NotificationTypeType::DocumentShared, "doc_shared"),
      (NotificationTypeType::WorkspaceContentMoved, "workspace_content_moved"),
      (NotificationTypeType::DocumentChanged, "document_changed"),
    ];

    for (notification_type, storage) in mappings {
      assert_eq!(notification_type.as_storage(), storage);
      assert_eq!(NotificationTypeType::from_storage(storage), notification_type);
    }
    assert_eq!(
      NotificationTypeType::from_storage("invite"),
      NotificationTypeType::Invitation
    );
    assert_eq!(
      NotificationTypeType::from_storage("workspace_invitation"),
      NotificationTypeType::Invitation
    );
  }
}

/// Priority level of an in-app notification.
#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "NotificationLevel", rename_items = "PascalCase")]
pub enum NotificationLevelType {
  Default,
  High,
  Low,
}

impl NotificationLevelType {
  pub fn from_storage(value: &str) -> Self {
    match value {
      "high" => Self::High,
      "low" => Self::Low,
      _ => Self::Default,
    }
  }
}

/// A single in-app notification record.
#[derive(SimpleObject)]
#[graphql(name = "NotificationObjectType")]
pub struct NotificationObjectType {
  pub id: ID,
  /// Aliased as `type` for NestJS/Desktop client compatibility.
  #[graphql(name = "type")]
  pub notification_type: NotificationTypeType,
  pub level: NotificationLevelType,
  pub read: bool,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub body: serde_json::Value,
}

/// Cursor-based edge for notification pagination.
#[derive(SimpleObject)]
#[graphql(name = "NotificationObjectTypeEdge")]
pub struct NotificationObjectTypeEdge {
  pub cursor: String,
  pub node: NotificationObjectType,
}

/// Standard Relay page-info object returned with paginated connection types.
#[derive(SimpleObject, Clone)]
pub struct PageInfoType {
  /// Cursor of the first edge in this page.
  pub start_cursor: Option<String>,
  /// Cursor of the last edge in this page.
  pub end_cursor: Option<String>,
  pub has_next_page: bool,
  pub has_previous_page: bool,
}

#[derive(SimpleObject)]
#[graphql(name = "PaginatedNotificationObjectType")]
pub struct PaginatedNotificationObjectType {
  pub total_count: i32,
  pub edges: Vec<NotificationObjectTypeEdge>,
  pub page_info: PageInfoType,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "SearchSortBy", rename_items = "PascalCase")]
pub enum SearchSortByType {
  Relevance,
  UpdatedAt,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "SortDirection", rename_items = "PascalCase")]
pub enum SortDirectionType {
  Asc,
  Desc,
}

#[derive(SimpleObject)]
pub struct SearchDocType {
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  pub title: String,
  pub plain_text: String,
  pub updated_at: DateTime<Utc>,
}

impl From<myoxus_domain::entities::SearchDocument> for SearchDocType {
  fn from(doc: myoxus_domain::entities::SearchDocument) -> Self {
    Self {
      doc_id: doc.doc_id,
      workspace_id: doc.workspace_id,
      title: doc.title,
      plain_text: doc.plain_text,
      updated_at: doc.updated_at,
    }
  }
}

#[derive(SimpleObject)]
pub struct SearchAggregateType {
  pub total: i32,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "SearchTable")]
pub enum SearchTableType {
  Block,
  Tag,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "SearchQueryType", rename_items = "PascalCase")]
pub enum SearchQueryTypeEnum {
  Match,
  Boolean,
  Prefix,
  Phrase,
  Fuzzy,
  Wildcard,
  Regex,
  Boost,
  Exists,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "SearchQueryOccur")]
pub enum SearchQueryOccurType {
  #[graphql(name = "must")]
  Must,
  #[graphql(name = "must_not")]
  MustNot,
  #[graphql(name = "should")]
  Should,
  #[graphql(name = "filter")]
  Filter,
}

#[derive(InputObject, Clone)]
pub struct SearchPaginationInputType {
  pub skip: Option<i32>,
  pub limit: Option<i32>,
  pub cursor: Option<String>,
}

#[derive(InputObject, Clone)]
pub struct SearchHighlightInputType {
  pub field: String,
  pub pre_tag: Option<String>,
  pub post_tag: Option<String>,
}

#[derive(InputObject, Clone)]
pub struct SearchQueryInputType {
  pub r#type: Option<SearchQueryTypeEnum>,
  pub field: Option<String>,
  pub match_value: Option<String>,
  pub occur: Option<SearchQueryOccurType>,
  pub query: Option<Box<SearchQueryInputType>>,
  pub queries: Option<Vec<SearchQueryInputType>>,
  pub boost: Option<f64>,
}

#[derive(InputObject, Clone)]
pub struct SearchOptionsInputType {
  pub pagination: Option<SearchPaginationInputType>,
  pub highlights: Option<Vec<SearchHighlightInputType>>,
}

#[derive(InputObject, Clone)]
#[graphql(name = "SearchInput")]
pub struct SearchInputType {
  pub query: SearchQueryInputType,
  pub options: SearchOptionsInputType,
  #[graphql(name = "useSemanticSearch")]
  pub use_semantic_search: Option<bool>,
}

#[derive(InputObject, Clone)]
#[graphql(name = "SearchDocsInput")]
pub struct SearchDocsInputType {
  pub keyword: String,
  pub limit: Option<i32>,
  /// Offset in this source's returned order; omitted or negative values start at zero.
  pub offset: Option<i32>,
  #[graphql(name = "useSemanticSearch")]
  pub use_semantic_search: Option<bool>,
}

#[derive(InputObject, Clone)]
pub struct AggregateHitsPaginationInputType {
  pub limit: Option<i32>,
  pub cursor: Option<String>,
}

#[derive(InputObject, Clone)]
pub struct AggregateHitsOptionsInputType {
  pub pagination: Option<AggregateHitsPaginationInputType>,
  pub highlights: Option<Vec<SearchHighlightInputType>>,
}

#[derive(InputObject, Clone)]
pub struct AggregateOptionsInputType {
  pub hits: AggregateHitsOptionsInputType,
}

#[derive(InputObject, Clone)]
#[graphql(name = "AggregateInput")]
pub struct AggregateInputType {
  pub query: SearchQueryInputType,
  pub options: AggregateOptionsInputType,
}

#[derive(SimpleObject)]
pub struct SearchNodeObjectType {
  pub fields: serde_json::Value,
  pub highlights: Option<serde_json::Value>,
}

#[derive(SimpleObject)]
pub struct SearchResultPaginationType {
  pub count: i32,
  pub has_more: bool,
  pub next_cursor: Option<String>,
}

#[derive(SimpleObject)]
pub struct SearchResultObjectType {
  pub nodes: Vec<SearchNodeObjectType>,
  pub pagination: SearchResultPaginationType,
}

#[derive(SimpleObject)]
pub struct AggregateBucketHitsObjectType {
  pub nodes: Vec<SearchNodeObjectType>,
}

#[derive(SimpleObject)]
pub struct AggregateBucketObjectType {
  pub key: String,
  pub count: i32,
  pub hits: AggregateBucketHitsObjectType,
}

#[derive(SimpleObject)]
pub struct AggregateResultObjectType {
  pub buckets: Vec<AggregateBucketObjectType>,
  pub pagination: SearchResultPaginationType,
}

#[derive(SimpleObject)]
pub struct SearchDocObjectType {
  pub doc_id: Uuid,
  pub external_id: String,
  pub title: String,
  pub block_id: String,
  pub highlight: String,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub created_by_user: Option<PublicUserType>,
  pub updated_by_user: Option<PublicUserType>,
  pub database_contexts: Vec<DatabaseDocumentReferenceObjectType>,
}

#[derive(SimpleObject)]
pub struct ListedBlobType {
  pub key: String,
  pub size: i32,
  pub mime: String,
  pub created_at: DateTime<Utc>,
}

// ─── Page metadata & history types (P24) ─────────────────────────────────────

/// Brief user info returned in pageMeta and history entries.
#[derive(SimpleObject, Clone)]
#[graphql(name = "EditorType")]
pub struct EditorType {
  pub name: String,
  #[graphql(name = "avatarUrl")]
  pub avatar_url: Option<String>,
}

/// Cloud page metadata: author and timestamp information.
#[derive(SimpleObject)]
#[graphql(name = "WorkspaceDocMeta")]
pub struct WorkspaceDocMetaType {
  #[graphql(name = "createdAt")]
  pub created_at: DateTime<Utc>,
  #[graphql(name = "updatedAt")]
  pub updated_at: DateTime<Utc>,
  #[graphql(name = "createdBy")]
  pub created_by: Option<EditorType>,
  #[graphql(name = "updatedBy")]
  pub updated_by: Option<EditorType>,
}

/// A single history snapshot entry.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DocHistoryOrigin", rename_items = "snake_case")]
pub enum DocHistoryOriginType {
  Manual,
  Automatic,
  Publish,
  PdfExport,
  Daily,
  Api,
  Restore,
  Recovery,
}

impl From<myoxus_application::doc::history::DocHistoryOrigin> for DocHistoryOriginType {
  fn from(value: myoxus_application::doc::history::DocHistoryOrigin) -> Self {
    match value {
      myoxus_application::doc::history::DocHistoryOrigin::Manual => Self::Manual,
      myoxus_application::doc::history::DocHistoryOrigin::Automatic => Self::Automatic,
      myoxus_application::doc::history::DocHistoryOrigin::Publish => Self::Publish,
      myoxus_application::doc::history::DocHistoryOrigin::PdfExport => Self::PdfExport,
      myoxus_application::doc::history::DocHistoryOrigin::Daily => Self::Daily,
      myoxus_application::doc::history::DocHistoryOrigin::Api => Self::Api,
      myoxus_application::doc::history::DocHistoryOrigin::Restore => Self::Restore,
      myoxus_application::doc::history::DocHistoryOrigin::Recovery => Self::Recovery,
    }
  }
}

#[derive(SimpleObject)]
#[graphql(name = "DocHistoryType")]
pub struct DocHistoryGqlType {
  #[graphql(name = "workspaceId")]
  pub workspace_id: String,
  pub id: String,
  /// Immutable snapshot identity. `id` remains the legacy document selector.
  pub snapshot_id: async_graphql::ID,
  pub cursor: String,
  pub timestamp: DateTime<Utc>,
  pub origin: Option<DocHistoryOriginType>,
  pub editor: Option<EditorType>,
}

/// A doc node inside a paginated recently-updated-docs result.
#[derive(SimpleObject)]
#[graphql(name = "RecentDocNode")]
pub struct RecentDocNode {
  pub id: String,
  pub title: Option<String>,
  #[graphql(name = "createdAt")]
  pub created_at: Option<DateTime<Utc>>,
  #[graphql(name = "updatedAt")]
  pub updated_at: Option<DateTime<Utc>>,
  #[graphql(name = "creatorId")]
  pub creator_id: Option<String>,
  #[graphql(name = "lastUpdaterId")]
  pub last_updater_id: Option<String>,
}

/// Edge wrapper for paginated doc results.
#[derive(SimpleObject)]
#[graphql(name = "RecentDocEdge")]
pub struct RecentDocEdge {
  pub node: RecentDocNode,
}

/// Paginated result for recently-updated docs.
#[derive(SimpleObject)]
#[graphql(name = "PaginatedDocType")]
pub struct PaginatedDocType {
  #[graphql(name = "totalCount")]
  pub total_count: i64,
  #[graphql(name = "pageInfo")]
  pub page_info: PageInfoType,
  pub edges: Vec<RecentDocEdge>,
}

/// Privacy-scoped user record returned by the `serverUsers` search query.
///
/// Intentionally limited to non-sensitive fields — no email, no admin flag.
/// Used by the workspace invitation UI to search for users to invite.
#[derive(SimpleObject)]
#[graphql(name = "ServerUserSearchResult")]
pub struct ServerUserSearchResult {
  pub id: ID,
  pub name: String,
  #[graphql(name = "avatarUrl")]
  pub avatar_url: Option<String>,
}
