//! Authentication application service and related types.
//!
//! This module implements the complete authentication domain for Myoxus:
//!
//! - **DTOs** — [`AuthUser`], [`AuthSession`], [`SessionSnapshot`], etc.
//! - **[`AuthStore`]** — the persistence port for all auth artefacts.
//! - **[`InMemoryAuthStore`]** — an in-memory implementation used by
//!   integration tests (also implements [`WorkspaceStore`]).
//! - **[`AuthService`]** — the high-level service that orchestrates sign-in,
//!   magic-link, OAuth, session management, avatar upload, and more.
//!
//! All crypto operations (password hashing, token generation) are self-
//! contained within this module.  TLS / transport security is the
//! responsibility of the ingress layer and is out of scope here.

use std::{
  collections::{BTreeMap, HashMap, HashSet},
  sync::{Arc, RwLock},
};

use argon2::{
  Argon2,
  password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{debug, error, info, instrument, trace, warn};
use uuid::Uuid;

use crate::ports::{BlobStoragePort, MailPort, MailPresentation, MailTemplate, RedisPort, TemplateMail};
use crate::workspace::{UpdateWorkspace, WorkspaceClassification, WorkspaceStore};
use myoxus_domain::entities::{
  DocRole, MembershipStatus, User, Workspace, WorkspaceInviteLink, WorkspaceMember, WorkspaceRole,
};
use myoxus_domain::ids::{InviteLinkId, UserId, WorkspaceId};

mod capabilities;
pub use capabilities::*;
mod password_reset;
pub use password_reset::*;
mod password_policy;
pub use password_policy::*;

/// Projection of a user account used throughout the auth domain.
///
/// This is a lighter-weight counterpart to [`myoxus_domain::entities::User`]
/// that includes all auth-relevant fields without coupling to domain entities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthUser {
  /// User's primary key.
  pub id: Uuid,
  /// Normalised (lowercase) email address.
  pub email: String,
  /// Display name, if set.
  pub name: Option<String>,
  /// URL of the user's avatar image.
  pub avatar_url: Option<String>,
  /// Argon2 password hash, absent for OAuth-only accounts.
  pub password_hash: Option<String>,
  /// Whether the user has server administrator privileges.
  pub is_admin: bool,
  /// If `true` the account is suspended and sign-in is rejected.
  pub disabled: bool,
  /// When the user's primary email was verified.  `None` = unverified.
  pub email_verified_at: Option<DateTime<Utc>>,
  /// `false` for "shadow" accounts created to represent pending invitees.
  pub registered: bool,
}

/// Read-only attribution profile, including retained historical identities.
/// Deleted identities expose their original UUID/name, an empty email and no
/// avatar. This port must never be used to authenticate or grant permissions.
#[derive(Debug, Clone)]
pub struct HistoricalUserProfile {
  pub id: Uuid,
  pub name: Option<String>,
  pub email: String,
  pub avatar_url: Option<String>,
}

impl From<&AuthUser> for HistoricalUserProfile {
  fn from(user: &AuthUser) -> Self {
    let deleted = user.email == format!("deleted:{}", user.id);
    Self {
      id: user.id,
      name: user.name.clone(),
      email: if deleted { String::new() } else { user.email.clone() },
      avatar_url: if deleted { None } else { user.avatar_url.clone() },
    }
  }
}

/// Non-secret user projection returned by administrative mutation commits.
///
/// Unlike [`AuthUser`], this type deliberately has no password hash or other
/// credential material. Credential mutations return this representation rather than exposing
/// stored hashes at their commit boundary.
#[derive(Debug, Clone, Serialize)]
pub struct AuthUserProjection {
  pub id: Uuid,
  pub email: String,
  pub name: Option<String>,
  pub avatar_url: Option<String>,
  pub is_admin: bool,
  pub disabled: bool,
  pub email_verified_at: Option<DateTime<Utc>>,
  pub has_password: bool,
}

impl From<&AuthUser> for AuthUserProjection {
  fn from(user: &AuthUser) -> Self {
    Self {
      id: user.id,
      email: user.email.clone(),
      name: user.name.clone(),
      avatar_url: user.avatar_url.clone(),
      is_admin: user.is_admin,
      disabled: user.disabled,
      email_verified_at: user.email_verified_at,
      has_password: user.password_hash.is_some(),
    }
  }
}

/// Represents a browser/device session bound to a user account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthSession {
  /// Session's primary key.
  pub id: Uuid,
  /// The user this session belongs to.
  pub user_id: Uuid,
  /// CSRF prevention token that must accompany state-mutating requests.
  pub csrf_token: String,
  /// User-agent string from the device that created the session.
  pub user_agent: Option<String>,
  /// IP address from which the session was created.
  pub ip_address: Option<String>,
  /// Absolute expiry time; requests after this timestamp are rejected.
  pub expires_at: DateTime<Utc>,
  /// Time after which a sliding refresh should be issued.
  pub refresh_after: DateTime<Utc>,
  /// Set when the session is explicitly revoked (sign-out or admin action).
  pub revoked_at: Option<DateTime<Utc>>,
  /// When the session record was created.
  pub created_at: DateTime<Utc>,
}

/// Durable membership of one session in a multi-user browser session group.
#[derive(Debug, Clone, Copy)]
pub struct SessionGroupLink {
  pub session_id: Uuid,
  pub root_session_id: Uuid,
  pub user_id: Uuid,
  pub created_at: DateTime<Utc>,
}

/// Input DTO for creating a new session (passed to [`AuthStore::create_session`]).
#[derive(Debug, Clone)]
pub struct NewSession {
  /// Client-provided or generated session ID.
  pub id: Uuid,
  /// User the session is created for.
  pub user_id: Uuid,
  /// CSRF token to embed in cookies / headers.
  pub csrf_token: String,
  /// User-agent header from the request.
  pub user_agent: Option<String>,
  /// Client IP address.
  pub ip_address: Option<String>,
  /// Absolute expiry timestamp.
  pub expires_at: DateTime<Utc>,
  /// Timestamp after which a sliding refresh should be issued.
  pub refresh_after: DateTime<Utc>,
  /// Creation timestamp.
  pub created_at: DateTime<Utc>,
}

/// HTTP-request metadata captured when a session is created.
#[derive(Debug, Clone)]
pub struct SessionContext {
  /// Value of the `User-Agent` request header.
  pub user_agent: Option<String>,
  /// Client IP address extracted from the request (after proxy headers).
  pub ip_address: Option<String>,
}

/// A combined user + session pair cached in Redis and returned on every
/// authenticated request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
  /// The authenticated user.
  pub user: AuthUser,
  /// The active session.
  pub session: AuthSession,
}

/// Result of the sign-in preflight check (before the user enters credentials).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightResult {
  /// Whether a registered account exists for the email address.
  pub registered: bool,
  /// Whether the account has a password set (i.e. supports password login).
  pub has_password: bool,
}

/// Outcome of a sign-in attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SignInResult {
  /// Password authentication succeeded; the session has been created.
  PasswordSignIn { user: AuthUser, session: Box<AuthSession> },
  /// No password was supplied; a magic-link email has been dispatched.
  MagicLinkRequested { email: String },
}

/// A single-use verification token used for email verification, password
/// resets, OAuth state, and open-app sign-in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationToken {
  /// Primary key.
  pub id: Uuid,
  /// User the token is bound to, if applicable.
  pub user_id: Option<Uuid>,
  /// Purpose discriminator (e.g. `"VerifyEmail"`, `"ChangePassword"`,
  /// `"OpenAppSignIn"`).
  pub kind: String,
  /// Opaque hash of the raw token string stored securely.
  pub token_hash: String,
  /// Email address associated with the token (for passwordless flows).
  pub email: Option<String>,
  /// Token expiry timestamp.
  pub expires_at: DateTime<Utc>,
  /// Set once the token has been consumed.
  pub used_at: Option<DateTime<Utc>>,
  /// When the token was created.
  pub created_at: DateTime<Utc>,
  /// Arbitrary JSON payload (e.g. OAuth `state` parameters).
  pub extra: Option<serde_json::Value>,
}

/// Trusted session-revocation selector. User strings retain the CLI's exact
/// email-or-UUID lookup; sessions created after selection are outside the cut.
#[derive(Debug, Clone)]
pub enum SessionRevocationTarget {
  Session(Uuid),
  User(String),
  All,
}

/// Target identifiers and newly revoked row count from one transaction.
/// Already revoked rows participate in cache eviction without another write.
#[derive(Debug, Clone, Default)]
pub struct SessionRevocationCommit {
  pub sessions: Vec<(Uuid, Uuid)>,
  pub revoked_count: usize,
  pub epochs: Vec<UserSessionEpoch>,
}

/// Operation-owned cache fence; never reused by a later credential mutation.
#[derive(Debug, Clone)]
pub struct UserSessionEpoch {
  pub user_id: Uuid,
  pub epoch: Option<String>,
}

/// Authentication barrier held around the store's atomic revocation. Stores
/// roll back durable writes before restoring the barrier on failure.
#[async_trait]
pub trait SessionRevocationBarrier: Send + Sync {
  async fn block(&self, users: &[Uuid]) -> AuthResult<Vec<UserSessionEpoch>>;
  async fn rollback(&self, epochs: &[UserSessionEpoch]);
}

/// Awaited post-commit publication; failures cannot undo a database commit.
#[async_trait]
pub trait SessionRevocationEffects: Send + Sync {
  async fn session_revoked(&self, session_id: Uuid);
  async fn user_sessions_revoked(&self, user_id: Uuid);
}

/// Email/account/token changes and captured session fences from one commit.
#[derive(Debug, Clone)]
pub struct EmailChangeCommit {
  pub user: AuthUser,
  pub revoked_session_ids: Vec<Uuid>,
  pub epochs: Vec<UserSessionEpoch>,
}

/// Result of the atomic password-reset persistence transaction.
///
/// The session identifiers let the application invalidate only snapshots
/// which can contain pre-reset authentication state. They are collected in
/// the same transaction that revokes those sessions, so cache invalidation
/// cannot silently miss a database session known to the commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordResetCommit {
  pub user_id: Uuid,
  pub revoked_session_ids: Vec<Uuid>,
}

/// Result of an administrative password update and its atomic session revoke.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordUpdateCommit {
  pub user_id: Uuid,
  pub revoked_session_ids: Vec<Uuid>,
}

/// Known role commit and the existing snapshots that must be refreshed.
/// Credentials and their expiry remain unchanged; no secrets cross this port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserAdminRoleCommit {
  pub user_id: Uuid,
  pub previous_is_admin: bool,
  pub is_admin: bool,
  pub session_ids: Vec<Uuid>,
}

/// Known permanent account deletion with retained UUID/name attribution.
/// The snapshot contains no old email/avatar, hashes or tokens. Credential IDs
/// captured before explicit cleanup drive cache eviction and live revocation.
#[derive(Debug, Clone)]
pub struct UserDeletionCommit {
  pub user: AuthUserProjection,
  pub revoked_session_ids: Vec<Uuid>,
  pub deleted_api_key_ids: Vec<Uuid>,
}

/// Result of the atomic administrative user suspension transaction.
///
/// The persistence layer returns only identifiers needed for cache and
/// credential invalidation. It never returns API-key hashes or other secret
/// material to the application layer.
#[derive(Debug, Clone)]
pub struct UserSuspensionCommit {
  pub user: AuthUserProjection,
  pub revoked_session_ids: Vec<Uuid>,
  pub deleted_api_key_ids: Vec<Uuid>,
}

/// A long-lived API access token (personal access token / machine token).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessToken {
  /// Primary key.
  pub id: Uuid,
  /// User the token belongs to.
  pub user_id: Uuid,
  /// Human-readable label chosen by the user.
  pub name: String,
  /// SHA-256 hash of the raw `ut_<uuid>` token string.
  pub token_hash: String,
  /// Optional expiry.  `None` = never expires.
  pub expires_at: Option<DateTime<Utc>>,
  /// When the token was created.
  pub created_at: DateTime<Utc>,
  /// Updated on each successful authentication with this token.
  pub last_used_at: Option<DateTime<Utc>>,
}

/// Input for creating a new access token record.
pub struct NewAccessToken {
  /// User the token belongs to.
  pub user_id: Uuid,
  /// Human-readable label.
  pub name: String,
  /// Pre-computed SHA-256 hash of the raw token.
  pub token_hash: String,
  /// Optional expiry date.
  pub expires_at: Option<DateTime<Utc>>,
}

/// Stable Workbench families used to scope personal tool layouts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkbenchViewFamily {
  DocumentPage,
  DocumentEdgeless,
  Journal,
  Database,
  Graph,
}

/// Stable tool identifiers accepted by the server-owned preference contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkbenchToolId {
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

impl WorkbenchViewFamily {
  fn allows(self, tool: WorkbenchToolId) -> bool {
    use WorkbenchToolId::*;
    match self {
      Self::DocumentPage => matches!(
        tool,
        Outline | Tags | DocumentInfo | Calendar | Agenda | Activity | Comment | Chat | Export | Analytics | Presence
      ),
      Self::DocumentEdgeless => matches!(
        tool,
        Frame | DocumentInfo | Calendar | Agenda | Activity | Comment | Chat | Export | Analytics | Presence
      ),
      Self::Journal => matches!(
        tool,
        Calendar | Agenda | Activity | Comment | Chat | Export | Analytics | Presence
      ),
      Self::Database => matches!(tool, DatabaseSettings | TaskDetails | Presence),
      Self::Graph => tool == GraphDetails,
    }
  }
}

/// One explicit personal override for a Workspace and Workbench family.
///
/// Missing scopes are intentionally absent from the aggregate. Product
/// defaults are resolved by the Workbench consumer, not materialized here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkbenchToolLayout {
  pub workspace_id: Uuid,
  pub view_family: WorkbenchViewFamily,
  pub ordered_tool_ids: Vec<WorkbenchToolId>,
  pub visible_tool_ids: Vec<WorkbenchToolId>,
  pub collapsed_tool_ids: Vec<WorkbenchToolId>,
}

const MAX_WORKBENCH_TOOL_LAYOUTS: usize = 640;

impl WorkbenchToolLayout {
  fn validate(&self) -> AuthResult<()> {
    let ordered = validate_workbench_tool_list(self, "orderedToolIds", &self.ordered_tool_ids)?;
    let visible = validate_workbench_tool_list(self, "visibleToolIds", &self.visible_tool_ids)?;
    let collapsed = validate_workbench_tool_list(self, "collapsedToolIds", &self.collapsed_tool_ids)?;
    if !visible.is_subset(&ordered) {
      return Err(AuthError::InvalidInput(
        "workbenchToolLayouts visibleToolIds must be a subset of orderedToolIds".to_string(),
      ));
    }
    if !collapsed.is_subset(&visible) {
      return Err(AuthError::InvalidInput(
        "workbenchToolLayouts collapsedToolIds must be a subset of visibleToolIds".to_string(),
      ));
    }
    Ok(())
  }
}

fn validate_workbench_tool_list(
  layout: &WorkbenchToolLayout,
  field: &str,
  tools: &[WorkbenchToolId],
) -> AuthResult<HashSet<WorkbenchToolId>> {
  let unique: HashSet<_> = tools.iter().copied().collect();
  if unique.len() != tools.len() {
    return Err(AuthError::InvalidInput(format!(
      "workbenchToolLayouts {field} must not contain duplicates"
    )));
  }
  if tools.iter().any(|tool| !layout.view_family.allows(*tool)) {
    return Err(AuthError::InvalidInput(format!(
      "workbenchToolLayouts {field} contains a tool that is not allowed for its viewFamily"
    )));
  }
  Ok(unique)
}

/// Stable dashboard sections accepted by the server-owned preference contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceDashboardDashletId {
  Today,
  Tasks,
  NewDocuments,
  Reminders,
  RecentlyEdited,
  Activity,
}

/// Semantic dashboard widths. Responsive projection remains client-owned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceDashboardDashletSize {
  Compact,
  Standard,
  Wide,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceDashboardDashletSizeOverride {
  pub dashlet_id: WorkspaceDashboardDashletId,
  pub size: WorkspaceDashboardDashletSize,
}

/// One bounded per-user layout override for a Workspace dashboard.
///
/// Missing dashlets are appended by the product resolver and are never treated
/// as hidden. Defaults therefore remain product code rather than persisted
/// snapshots that could become stale after an upgrade.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceDashboardLayout {
  pub workspace_id: Uuid,
  pub ordered_dashlet_ids: Vec<WorkspaceDashboardDashletId>,
  pub dashlet_sizes: Vec<WorkspaceDashboardDashletSizeOverride>,
}

const MAX_WORKSPACE_DASHBOARD_LAYOUTS: usize = 128;

impl WorkspaceDashboardLayout {
  fn validate(&self) -> AuthResult<()> {
    let ordered: HashSet<_> = self.ordered_dashlet_ids.iter().copied().collect();
    if ordered.len() != self.ordered_dashlet_ids.len() {
      return Err(AuthError::InvalidInput(
        "workspaceDashboardLayouts orderedDashletIds must not contain duplicates".to_string(),
      ));
    }

    let mut sized = HashSet::with_capacity(self.dashlet_sizes.len());
    for override_value in &self.dashlet_sizes {
      if !sized.insert(override_value.dashlet_id) {
        return Err(AuthError::InvalidInput(
          "workspaceDashboardLayouts dashletSizes must contain one entry per dashletId".to_string(),
        ));
      }
      if !ordered.contains(&override_value.dashlet_id) {
        return Err(AuthError::InvalidInput(
          "workspaceDashboardLayouts dashletSizes must be a subset of orderedDashletIds".to_string(),
        ));
      }
      if matches!(
        override_value.dashlet_id,
        WorkspaceDashboardDashletId::Today
          | WorkspaceDashboardDashletId::Tasks
          | WorkspaceDashboardDashletId::Reminders
          | WorkspaceDashboardDashletId::Activity
      ) && override_value.size == WorkspaceDashboardDashletSize::Compact
      {
        return Err(AuthError::InvalidInput(
          "workspaceDashboardLayouts today, tasks, reminders, and activity do not support Compact".to_string(),
        ));
      }
    }
    Ok(())
  }
}

/// Personal presentation policy; selecting Automatic never starts an operation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssistanceMode {
  #[default]
  Manual,
  Guided,
  Automatic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssistanceSource {
  UserDefault,
  Workspace,
  Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectAssistanceOverride {
  /// Prevent an override from following a Project into another Workspace.
  pub workspace_id: Uuid,
  pub mode: AssistanceMode,
}

#[derive(Debug, Clone)]
pub struct WorkspaceAssistancePatch {
  pub workspace_id: Uuid,
  /// None removes this key and resumes inheritance.
  pub mode: Option<AssistanceMode>,
}

#[derive(Debug, Clone)]
pub struct ProjectAssistancePatch {
  pub workspace_id: Uuid,
  pub project_id: Uuid,
  pub mode: Option<AssistanceMode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveAssistance {
  pub mode: AssistanceMode,
  pub source: AssistanceSource,
  pub user_default_explicit: bool,
  /// Initial interactive choice only; it is not persisted or execution eligibility.
  pub interactive_mode: AssistanceMode,
}

/// Current native facts loaded by the preference store under authority locks.
#[derive(Debug, Clone)]
pub struct AssistanceProjectFacts {
  pub id: Uuid,
  pub workspace_id: Uuid,
  pub profile_kind: myoxus_domain::database::DatabaseProfileKind,
  pub system_role: Option<myoxus_domain::database::DatabaseSystemRole>,
}

impl AssistanceProjectFacts {
  pub fn validate(&self, workspace_id: Uuid, project_id: Uuid, for_override: bool) -> AuthResult<()> {
    use myoxus_domain::database::DatabaseProfileKind;
    if self.id != project_id || self.workspace_id != workspace_id {
      return Err(AuthError::ActionForbidden);
    }
    if self.profile_kind != DatabaseProfileKind::Project || (for_override && self.system_role.is_some()) {
      return Err(AuthError::InvalidInput(
        "assistance override requires an ordinary Project".into(),
      ));
    }
    Ok(())
  }
}

mod saved_setup;
pub use saved_setup::*;

const MAX_ASSISTANCE_SCOPES: usize = 128;

/// Persisted per-user overrides. Missing values intentionally inherit the
/// current server/product default and are never materialised into SQL.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct UserPreferences {
  #[serde(skip_serializing_if = "BTreeMap::is_empty")]
  pub saved_setups: BTreeMap<Uuid, SavedSetupConfiguration>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub locale: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub default_document_language: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub timezone: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub date_format: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub time_format: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub receive_invitation_email: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub receive_mention_email: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub receive_comment_email: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub notify_created_documents: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub journal_first_day_of_week: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub journal_show_calendar_weeks: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub color_mode: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub show_linked_documents: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub image_antialiasing: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub noisy_background: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub editor_font_family: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub editor_custom_font_family: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub editor_font_size: Option<u8>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub new_document_mode: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub full_width_layout: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub open_document_mode: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub edgeless_default_theme: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub telemetry_enabled: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub ai_model_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub ai_reasoning_enabled: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub document_metadata_header_visibility: Option<HashMap<Uuid, HashMap<String, bool>>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workbench_tool_layouts: Option<Vec<WorkbenchToolLayout>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workspace_dashboard_layouts: Option<Vec<WorkspaceDashboardLayout>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub template_catalog_views: Option<HashMap<Uuid, String>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub assistance_mode: Option<AssistanceMode>,
  #[serde(skip_serializing_if = "BTreeMap::is_empty")]
  pub workspace_assistance_overrides: BTreeMap<Uuid, AssistanceMode>,
  #[serde(skip_serializing_if = "BTreeMap::is_empty")]
  pub project_assistance_overrides: BTreeMap<Uuid, ProjectAssistanceOverride>,
}

impl UserPreferences {
  /// Validate the complete persisted aggregate at the application boundary.
  pub fn validate(&self) -> AuthResult<()> {
    if self.saved_setups.len() > 32 {
      return Err(AuthError::InvalidInput("too many saved setups".into()));
    }
    for (id, configuration) in &self.saved_setups {
      if *id != configuration.id {
        return Err(AuthError::InvalidInput("saved setup identity mismatch".into()));
      }
      configuration.validate()?;
    }
    if self.workspace_assistance_overrides.len() > MAX_ASSISTANCE_SCOPES
      || self.project_assistance_overrides.len() > MAX_ASSISTANCE_SCOPES
      || self.workspace_assistance_overrides.keys().any(Uuid::is_nil)
      || self
        .project_assistance_overrides
        .iter()
        .any(|(id, value)| id.is_nil() || value.workspace_id.is_nil())
    {
      return Err(AuthError::InvalidInput("invalid assistance override scopes".into()));
    }
    validate_optional_text("locale", self.locale.as_deref(), 64)?;
    validate_optional_text("defaultDocumentLanguage", self.default_document_language.as_deref(), 64)?;
    validate_optional_text("timezone", self.timezone.as_deref(), 128)?;
    if let Some(timezone) = self.timezone.as_deref()
      && timezone.parse::<Tz>().is_err()
    {
      return Err(AuthError::InvalidInput(
        "timezone must be a valid IANA timezone".to_string(),
      ));
    }
    validate_optional_choice(
      "dateFormat",
      self.date_format.as_deref(),
      &["day-month-year", "month-day-year", "year-month-day"],
    )?;
    validate_optional_choice("timeFormat", self.time_format.as_deref(), &["12-hour", "24-hour"])?;
    validate_optional_choice(
      "journalFirstDayOfWeek",
      self.journal_first_day_of_week.as_deref(),
      &["monday", "sunday"],
    )?;
    validate_optional_choice("colorMode", self.color_mode.as_deref(), &["light", "dark", "system"])?;
    validate_optional_choice(
      "editorFontFamily",
      self.editor_font_family.as_deref(),
      &["Sans", "Serif", "Mono", "Custom"],
    )?;
    validate_optional_text("editorCustomFontFamily", self.editor_custom_font_family.as_deref(), 256)?;
    validate_optional_text("aiModelId", self.ai_model_id.as_deref(), 255)?;
    if let Some(size) = self.editor_font_size
      && !(12..=24).contains(&size)
    {
      return Err(AuthError::InvalidInput(
        "editorFontSize must be between 12 and 24".to_string(),
      ));
    }
    validate_optional_choice(
      "newDocumentMode",
      self.new_document_mode.as_deref(),
      &["edgeless", "page", "ask"],
    )?;
    validate_optional_choice(
      "openDocumentMode",
      self.open_document_mode.as_deref(),
      &[
        "open-in-active-view",
        "open-in-new-view",
        "open-in-new-tab",
        "open-in-center-peek",
      ],
    )?;
    validate_optional_choice(
      "edgelessDefaultTheme",
      self.edgeless_default_theme.as_deref(),
      &["specified", "dark", "light", "auto"],
    )?;
    if let Some(workspaces) = &self.document_metadata_header_visibility {
      if workspaces.len() > 128 {
        return Err(AuthError::InvalidInput(
          "documentMetadataHeaderVisibility has too many workspaces".to_string(),
        ));
      }
      for fields in workspaces.values() {
        if fields.len() > 64 {
          return Err(AuthError::InvalidInput(
            "documentMetadataHeaderVisibility has too many fields".to_string(),
          ));
        }
        for field in fields.keys() {
          if field.trim().is_empty() || field.len() > 128 {
            return Err(AuthError::InvalidInput(
              "documentMetadataHeaderVisibility contains an invalid field".to_string(),
            ));
          }
        }
      }
    }
    if let Some(layouts) = &self.workbench_tool_layouts {
      if layouts.len() > MAX_WORKBENCH_TOOL_LAYOUTS {
        return Err(AuthError::InvalidInput(format!(
          "workbenchToolLayouts must contain at most {MAX_WORKBENCH_TOOL_LAYOUTS} scopes"
        )));
      }
      let mut scopes = HashSet::with_capacity(layouts.len());
      for layout in layouts {
        if !scopes.insert((layout.workspace_id, layout.view_family)) {
          return Err(AuthError::InvalidInput(
            "workbenchToolLayouts must contain one entry per workspaceId and viewFamily".to_string(),
          ));
        }
        layout.validate()?;
      }
    }
    // A user's display choice is scoped to a workspace, never shared workspace state.
    if let Some(views) = &self.template_catalog_views {
      if views.len() > 128
        || views
          .iter()
          .any(|(id, view)| id.is_nil() || !matches!(view.as_str(), "list" | "gallery"))
      {
        return Err(AuthError::InvalidInput(
          "templateCatalogViews requires at most 128 valid workspace IDs and list/gallery values".into(),
        ));
      }
    }
    if let Some(layouts) = &self.workspace_dashboard_layouts {
      if layouts.len() > MAX_WORKSPACE_DASHBOARD_LAYOUTS {
        return Err(AuthError::InvalidInput(format!(
          "workspaceDashboardLayouts must contain at most {MAX_WORKSPACE_DASHBOARD_LAYOUTS} workspaces"
        )));
      }
      let mut workspaces = HashSet::with_capacity(layouts.len());
      for layout in layouts {
        if !workspaces.insert(layout.workspace_id) {
          return Err(AuthError::InvalidInput(
            "workspaceDashboardLayouts must contain one entry per workspaceId".to_string(),
          ));
        }
        layout.validate()?;
      }
    }
    Ok(())
  }

  /// Apply a tri-state patch: outer `None` means unchanged, inner `None`
  /// removes the persisted override.
  pub fn apply_patch(&mut self, patch: UserPreferencesPatch) -> AuthResult<()> {
    patch.validate_assistance_scopes()?;
    let mut candidate = self.clone();
    macro_rules! apply {
      ($field:ident) => {
        if let Some(value) = patch.$field {
          candidate.$field = value;
        }
      };
    }
    apply!(locale);
    apply!(default_document_language);
    apply!(timezone);
    apply!(date_format);
    apply!(time_format);
    apply!(receive_invitation_email);
    apply!(receive_mention_email);
    apply!(receive_comment_email);
    apply!(notify_created_documents);
    apply!(journal_first_day_of_week);
    apply!(journal_show_calendar_weeks);
    apply!(color_mode);
    apply!(show_linked_documents);
    apply!(image_antialiasing);
    apply!(noisy_background);
    apply!(editor_font_family);
    apply!(editor_custom_font_family);
    apply!(editor_font_size);
    apply!(new_document_mode);
    apply!(full_width_layout);
    apply!(open_document_mode);
    apply!(edgeless_default_theme);
    apply!(telemetry_enabled);
    apply!(ai_model_id);
    apply!(ai_reasoning_enabled);
    apply!(document_metadata_header_visibility);
    apply!(workbench_tool_layouts);
    apply!(workspace_dashboard_layouts);
    apply!(template_catalog_views);
    apply!(assistance_mode);
    for scoped in patch.workspace_assistance_overrides {
      if let Some(mode) = scoped.mode {
        candidate
          .workspace_assistance_overrides
          .insert(scoped.workspace_id, mode);
      } else {
        candidate.workspace_assistance_overrides.remove(&scoped.workspace_id);
      }
    }
    for scoped in patch.project_assistance_overrides {
      if let Some(mode) = scoped.mode {
        candidate.project_assistance_overrides.insert(
          scoped.project_id,
          ProjectAssistanceOverride {
            workspace_id: scoped.workspace_id,
            mode,
          },
        );
      } else {
        candidate.project_assistance_overrides.remove(&scoped.project_id);
      }
    }
    let mut saved_ids = HashSet::new();
    if patch.saved_setups.len() > 32 {
      return Err(AuthError::InvalidInput("too many saved setup changes".into()));
    }
    for saved in patch.saved_setups {
      if saved.id.is_nil() || !saved_ids.insert(saved.id) {
        return Err(AuthError::InvalidInput("invalid saved setup patch".into()));
      }
      match saved.value {
        Some(configuration) if configuration.id == saved.id => {
          candidate.saved_setups.insert(saved.id, configuration);
        }
        Some(_) => return Err(AuthError::InvalidInput("saved setup identity mismatch".into())),
        None => {
          candidate.saved_setups.remove(&saved.id);
        }
      }
    }
    candidate.validate()?;
    *self = candidate;
    Ok(())
  }
}

fn validate_optional_text(field: &str, value: Option<&str>, max_len: usize) -> AuthResult<()> {
  if let Some(value) = value
    && (value.trim().is_empty() || value.len() > max_len)
  {
    return Err(AuthError::InvalidInput(format!(
      "{field} must contain between 1 and {max_len} characters"
    )));
  }
  Ok(())
}

fn validate_optional_choice(field: &str, value: Option<&str>, allowed: &[&str]) -> AuthResult<()> {
  if let Some(value) = value
    && !allowed.contains(&value)
  {
    return Err(AuthError::InvalidInput(format!(
      "{field} contains an unsupported value"
    )));
  }
  Ok(())
}

/// A persisted preference aggregate and its server acknowledgement timestamp.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UserPreferencesRecord {
  pub values: UserPreferences,
  pub updated_at: Option<DateTime<Utc>>,
}

/// Server/product defaults needed to resolve stored overrides.
#[derive(Debug, Clone)]
pub struct UserPreferenceDefaults {
  pub locale: String,
  pub timezone: String,
  pub journal_first_day_of_week: String,
  pub journal_show_calendar_weeks: bool,
}

impl Default for UserPreferenceDefaults {
  fn default() -> Self {
    Self {
      locale: "en".to_string(),
      timezone: "UTC".to_string(),
      journal_first_day_of_week: "monday".to_string(),
      journal_show_calendar_weeks: true,
    }
  }
}

/// Fully resolved values consumed by UI and server-owned business adapters.
#[derive(Debug, Clone, PartialEq)]
pub struct EffectiveUserPreferences {
  pub assistance_mode: AssistanceMode,
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
  pub editor_font_size: u8,
  pub new_document_mode: String,
  pub full_width_layout: bool,
  pub open_document_mode: String,
  pub edgeless_default_theme: String,
  pub telemetry_enabled: bool,
  pub ai_model_id: Option<String>,
  pub ai_reasoning_enabled: bool,
  pub document_metadata_header_visibility: HashMap<Uuid, HashMap<String, bool>>,
  pub workbench_tool_layouts: Option<Vec<WorkbenchToolLayout>>,
  pub workspace_dashboard_layouts: Option<Vec<WorkspaceDashboardLayout>>,
  pub template_catalog_views: Option<HashMap<Uuid, String>>,
}

impl UserPreferences {
  /// Resolve only admitted current scope facts. System Tasks never consume a Project override.
  pub fn resolve_assistance(
    &self,
    workspace_id: Option<Uuid>,
    project: Option<&AssistanceProjectFacts>,
  ) -> EffectiveAssistance {
    let workspace_mode = workspace_id.and_then(|id| self.workspace_assistance_overrides.get(&id).copied());
    let project_mode = project
      .filter(|facts| facts.system_role.is_none())
      .and_then(|facts| {
        self
          .project_assistance_overrides
          .get(&facts.id)
          .filter(|value| Some(value.workspace_id) == workspace_id && value.workspace_id == facts.workspace_id)
      })
      .map(|value| value.mode);
    let (mode, source) = if let Some(mode) = project_mode {
      (mode, AssistanceSource::Project)
    } else if let Some(mode) = workspace_mode {
      (mode, AssistanceSource::Workspace)
    } else {
      (self.assistance_mode.unwrap_or_default(), AssistanceSource::UserDefault)
    };
    EffectiveAssistance {
      mode,
      source,
      user_default_explicit: self.assistance_mode.is_some(),
      interactive_mode: if source == AssistanceSource::UserDefault && self.assistance_mode.is_none() {
        AssistanceMode::Guided
      } else {
        mode
      },
    }
  }

  pub fn resolve(&self, defaults: &UserPreferenceDefaults) -> EffectiveUserPreferences {
    let locale = self.locale.clone().unwrap_or_else(|| defaults.locale.clone());
    EffectiveUserPreferences {
      assistance_mode: self.assistance_mode.unwrap_or_default(),
      default_document_language: self.default_document_language.clone().unwrap_or_else(|| locale.clone()),
      locale,
      timezone: self.timezone.clone().unwrap_or_else(|| defaults.timezone.clone()),
      date_format: self.date_format.clone().unwrap_or_else(|| "locale".to_string()),
      time_format: self.time_format.clone().unwrap_or_else(|| "locale".to_string()),
      receive_invitation_email: self.receive_invitation_email.unwrap_or(true),
      receive_mention_email: self.receive_mention_email.unwrap_or(true),
      receive_comment_email: self.receive_comment_email.unwrap_or(true),
      notify_created_documents: self.notify_created_documents.unwrap_or(true),
      journal_first_day_of_week: self
        .journal_first_day_of_week
        .clone()
        .unwrap_or_else(|| defaults.journal_first_day_of_week.clone()),
      journal_show_calendar_weeks: self
        .journal_show_calendar_weeks
        .unwrap_or(defaults.journal_show_calendar_weeks),
      color_mode: self.color_mode.clone().unwrap_or_else(|| "system".to_string()),
      show_linked_documents: self.show_linked_documents.unwrap_or(true),
      image_antialiasing: self.image_antialiasing.unwrap_or(true),
      noisy_background: self.noisy_background.unwrap_or(true),
      editor_font_family: self.editor_font_family.clone().unwrap_or_else(|| "Sans".to_string()),
      editor_custom_font_family: self.editor_custom_font_family.clone().unwrap_or_default(),
      editor_font_size: self.editor_font_size.unwrap_or(16),
      new_document_mode: self.new_document_mode.clone().unwrap_or_else(|| "page".to_string()),
      full_width_layout: self.full_width_layout.unwrap_or(false),
      open_document_mode: self
        .open_document_mode
        .clone()
        .unwrap_or_else(|| "open-in-active-view".to_string()),
      edgeless_default_theme: self
        .edgeless_default_theme
        .clone()
        .unwrap_or_else(|| "specified".to_string()),
      telemetry_enabled: self.telemetry_enabled.unwrap_or(true),
      ai_model_id: self.ai_model_id.clone(),
      ai_reasoning_enabled: self.ai_reasoning_enabled.unwrap_or(false),
      document_metadata_header_visibility: self.document_metadata_header_visibility.clone().unwrap_or_default(),
      workbench_tool_layouts: self.workbench_tool_layouts.clone(),
      workspace_dashboard_layouts: self.workspace_dashboard_layouts.clone(),
      template_catalog_views: self.template_catalog_views.clone(),
    }
  }
}

/// Application patch type. Each field has an explicit omitted/set/reset state.
#[derive(Debug, Clone, Default)]
pub struct UserPreferencesPatch {
  pub saved_setups: Vec<SavedSetupPatch>,
  pub locale: Option<Option<String>>,
  pub default_document_language: Option<Option<String>>,
  pub timezone: Option<Option<String>>,
  pub date_format: Option<Option<String>>,
  pub time_format: Option<Option<String>>,
  pub receive_invitation_email: Option<Option<bool>>,
  pub receive_mention_email: Option<Option<bool>>,
  pub receive_comment_email: Option<Option<bool>>,
  pub notify_created_documents: Option<Option<bool>>,
  pub journal_first_day_of_week: Option<Option<String>>,
  pub journal_show_calendar_weeks: Option<Option<bool>>,
  pub color_mode: Option<Option<String>>,
  pub show_linked_documents: Option<Option<bool>>,
  pub image_antialiasing: Option<Option<bool>>,
  pub noisy_background: Option<Option<bool>>,
  pub editor_font_family: Option<Option<String>>,
  pub editor_custom_font_family: Option<Option<String>>,
  pub editor_font_size: Option<Option<u8>>,
  pub new_document_mode: Option<Option<String>>,
  pub full_width_layout: Option<Option<bool>>,
  pub open_document_mode: Option<Option<String>>,
  pub edgeless_default_theme: Option<Option<String>>,
  pub telemetry_enabled: Option<Option<bool>>,
  pub ai_model_id: Option<Option<String>>,
  pub ai_reasoning_enabled: Option<Option<bool>>,
  pub document_metadata_header_visibility: Option<Option<HashMap<Uuid, HashMap<String, bool>>>>,
  pub workbench_tool_layouts: Option<Option<Vec<WorkbenchToolLayout>>>,
  pub workspace_dashboard_layouts: Option<Option<Vec<WorkspaceDashboardLayout>>>,
  pub template_catalog_views: Option<Option<HashMap<Uuid, String>>>,
  pub assistance_mode: Option<Option<AssistanceMode>>,
  pub workspace_assistance_overrides: Vec<WorkspaceAssistancePatch>,
  pub project_assistance_overrides: Vec<ProjectAssistancePatch>,
}

impl UserPreferencesPatch {
  pub fn validate_assistance_scopes(&self) -> AuthResult<()> {
    let mut workspaces = HashSet::new();
    let mut projects = HashSet::new();
    if self.workspace_assistance_overrides.len() > MAX_ASSISTANCE_SCOPES
      || self.project_assistance_overrides.len() > MAX_ASSISTANCE_SCOPES
      || self
        .workspace_assistance_overrides
        .iter()
        .any(|entry| entry.workspace_id.is_nil() || !workspaces.insert(entry.workspace_id))
      || self
        .project_assistance_overrides
        .iter()
        .any(|entry| entry.workspace_id.is_nil() || entry.project_id.is_nil() || !projects.insert(entry.project_id))
    {
      return Err(AuthError::InvalidInput(
        "invalid or duplicate assistance patch scopes".into(),
      ));
    }
    Ok(())
  }
}

/// An OAuth provider account linked to a Myoxus user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectedAccount {
  /// Primary key.
  pub id: Uuid,
  /// Myoxus user this account is linked to.
  pub user_id: Uuid,
  /// OAuth provider identifier (e.g. `"google"`, `"github"`).
  pub provider: String,
  /// The user's subject / account ID within the provider.
  pub provider_account_id: String,
  /// Current provider access token (encrypted at rest).
  pub access_token: Option<String>,
  /// Provider refresh token used to obtain new access tokens.
  pub refresh_token: Option<String>,
  /// When the access token expires.
  pub expires_at: Option<DateTime<Utc>>,
  /// When the link was established.
  pub created_at: DateTime<Utc>,
}

/// Input for creating a new connected-account record.
pub struct NewConnectedAccount {
  /// Myoxus user this account belongs to.
  pub user_id: Uuid,
  /// Provider identifier.
  pub provider: String,
  /// User's ID within the provider.
  pub provider_account_id: String,
  /// Initial access token.
  pub access_token: Option<String>,
  /// Initial refresh token.
  pub refresh_token: Option<String>,
  /// Access token expiry.
  pub expires_at: Option<DateTime<Utc>>,
}

/// A 6-digit magic-link one-time password entry bound to an email address.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MagicLinkOtp {
  /// Destination email address.
  pub email: String,
  /// The 6-digit OTP sent to the user.
  pub otp: String,
  /// The verification token created alongside this OTP (for cross-reference).
  pub verification_token_id: Uuid,
  /// Optional client-generated nonce that must match at consumption time to
  /// prevent OTP theft by a third party.
  pub client_nonce: Option<String>,
  /// When this OTP expires.
  pub expires_at: DateTime<Utc>,
}

/// Partial-update DTO for mutating an [`AuthUser`]'s profile fields.
///
/// Each field is double-`Option` where the outer `Option` signals "this field
/// should be updated" and the inner `Option` carries the new value (`None`
/// clears the field).  Fields left as outer-`None` are not modified.
#[derive(Debug, Clone, Default)]
pub struct UpdateAuthUser {
  /// New display name; `Some(None)` clears it.
  pub name: Option<Option<String>>,
  /// New avatar URL; `Some(None)` removes the avatar.
  pub avatar_url: Option<Option<String>>,
  /// New primary email address.
  pub email: Option<String>,
}

/// Errors produced by the authentication service and store.
///
/// HTTP handlers in `crates/api` map these variants to appropriate HTTP status
/// codes (e.g. `WrongSignInCredentials` → 401, `ActionForbidden` → 403).
#[derive(Debug, Error)]
pub enum AuthError {
  /// The supplied email address is syntactically invalid.
  #[error("invalid email")]
  InvalidEmail,
  /// Password authentication failed (user not found or wrong password).
  #[error("wrong sign-in credentials")]
  WrongSignInCredentials,
  /// The current user is not permitted to perform this action.
  #[error("action forbidden")]
  ActionForbidden,
  /// The provided token is malformed or does not exist.
  #[error("invalid token")]
  InvalidToken,
  /// The provided token exists but has passed its expiry time.
  #[error("expired token")]
  ExpiredToken,
  /// The requested token record was not found (distinct from `InvalidToken`
  /// in contexts where the absence is semantically meaningful).
  #[error("token not found")]
  TokenNotFound,
  /// The OAuth state cookie / token has expired.
  #[error("oauth state expired")]
  OauthStateExpired,
  /// New account creation is disabled on this instance.
  #[error("sign up forbidden")]
  SignUpForbidden,
  /// The request requires an authenticated session.
  #[error("authentication required")]
  AuthenticationRequired,
  /// The requested resource was not found.
  #[error("not found: {0}")]
  NotFound(String),
  /// The caller supplied invalid input data.
  #[error("invalid input: {0}")]
  InvalidInput(String),
  /// A workspace name is already reserved by the same ownership principal.
  #[error("XWS_WORKSPACE_NAME_CONFLICT")]
  WorkspaceNameConflict {
    /// Smallest currently free deterministic alternative.
    suggestion: String,
  },
  #[error("WORKSPACE_OVERVIEW_REVISION_CONFLICT")]
  WorkspaceOverviewRevisionConflict { current_revision: i64 },
  /// The write would exceed the workspace's storage quota.
  #[error("storage quota exceeded: {current_bytes} used + {write_bytes} write > {quota_bytes} limit")]
  StorageQuotaExceeded {
    workspace_id: uuid::Uuid,
    current_bytes: u64,
    write_bytes: u64,
    quota_bytes: u64,
  },
  /// An external Yjs update exceeded the configured decoded-byte limit.
  #[error("document update exceeds the configured maximum of {max_bytes} bytes")]
  UpdateTooLarge { max_bytes: usize },
  /// An external payload is not structurally valid Yjs v1.
  #[error("invalid Yjs v1 update")]
  InvalidYjsUpdate,
  /// The bounded blocking validator could not be acquired or completed.
  #[error("Yjs update validation is temporarily unavailable")]
  YjsValidationUnavailable,
  /// A client supplied a malformed Yjs-v1 state vector to the sync protocol.
  #[error("invalid Yjs v1 state vector")]
  InvalidYjsStateVector,
  /// A document load or diff exceeded the configured WebSocket payload bound.
  #[error("document sync payload exceeds the configured maximum of {max_bytes} bytes")]
  DocSyncPayloadTooLarge { max_bytes: usize },
  /// A document load stopped because its owning socket no longer exists.
  #[error("document sync load was cancelled")]
  DocSyncCancelled,
  /// The shared bounded Yjs decoder gate was closed or its worker failed.
  #[error("Yjs decoder is temporarily unavailable")]
  YjsDecoderUnavailable,
  /// An internal storage or I/O error occurred.
  #[error("storage failure: {0}")]
  Storage(String),
}

/// Convenience alias for all auth service results.
pub type AuthResult<T> = Result<T, AuthError>;

/// Persistence port for all authentication artefacts.
///
/// Each method corresponds to a single atomic database operation.  Callers
/// should prefer [`AuthService`] methods for business logic; the store itself
/// rechecks current native authority where it must remain locked through commit.
#[async_trait]
pub trait AuthStore: Send + Sync {
  /// Return the minimal account projection needed to determine which
  /// authentication methods are operational. Keeping this aggregation behind
  /// the store port avoids loading password hashes into setup diagnostics.
  async fn auth_capability_account_state(&self) -> AuthResult<AuthCapabilityAccountState>;
  /// Fetch a user by email address (case-insensitive).
  async fn get_user_by_email(&self, email: &str) -> AuthResult<Option<AuthUser>>;
  async fn get_user_by_id(&self, user_id: Uuid) -> AuthResult<Option<AuthUser>>;
  /// Batch-fetch users by a set of IDs.  Returns a map of found users keyed
  /// by their ID.  IDs that do not exist are simply absent from the result.
  async fn get_users_by_ids(&self, ids: &[Uuid]) -> AuthResult<HashMap<Uuid, AuthUser>>;
  /// Historical attribution only; never an account or credential lookup.
  async fn get_historical_profile(&self, id: Uuid) -> AuthResult<Option<HistoricalUserProfile>> {
    Ok(self.get_historical_profiles(&[id]).await?.remove(&id))
  }
  async fn get_historical_profiles(&self, ids: &[Uuid]) -> AuthResult<HashMap<Uuid, HistoricalUserProfile>>;
  /// Resolve one explicit user feature override; `None` means no override.
  async fn get_user_feature_override(&self, user_id: Uuid, feature_name: &str) -> AuthResult<Option<bool>>;
  /// Resolve one feature override for several users in one repository read.
  async fn get_user_feature_overrides(&self, user_ids: &[Uuid], feature_name: &str) -> AuthResult<HashMap<Uuid, bool>>;
  /// Persist an explicit feature override and its operator-facing reason.
  async fn set_user_feature_override(
    &self,
    user_id: Uuid,
    feature_name: &str,
    activated: bool,
    reason: &str,
  ) -> AuthResult<()>;
  /// Return the newest session creation time for one user.
  async fn last_login_at(&self, user_id: Uuid) -> AuthResult<Option<DateTime<Utc>>>;
  /// Batch-check which of the given (already-lowercased) emails exist.
  /// Returns the subset of input emails that are already registered.
  async fn get_existing_emails(&self, emails: &[String]) -> AuthResult<HashSet<String>>;
  async fn fulfill_user(&self, email: &str, name: Option<&str>, avatar_url: Option<&str>) -> AuthResult<AuthUser>;
  /// Insert-only administrative creation. `None` means the normalized email
  /// already exists; the losing caller must perform no provisioning writes.
  async fn insert_admin_user(&self, email: &str, name: Option<&str>) -> AuthResult<Option<AuthUser>>;
  async fn update_user(&self, user_id: Uuid, update: UpdateAuthUser) -> AuthResult<AuthUser>;
  /// Existing port adapter; deletion cleanup has one transactional owner.
  async fn delete_user(&self, user_id: Uuid) -> AuthResult<()> {
    self.commit_user_deletion(user_id).await.map(|_| ())
  }

  /// Lock the user, capture its safe snapshot and credential IDs, then perform
  /// the established content/ownership cleanup and account deletion atomically.
  async fn commit_user_deletion(&self, user_id: Uuid) -> AuthResult<UserDeletionCommit>;
  /// Atomically replace a user's password hash and revoke every existing
  /// session. Direct administrative password-setting paths must use this
  /// operation instead of composing two independently fallible writes.
  async fn commit_password_update(
    &self,
    user_id: Uuid,
    password_hash: String,
    changed_at: DateTime<Utc>,
  ) -> AuthResult<PasswordUpdateCommit>;
  /// Atomically disable a user, revoke all sessions, and delete all MCP API
  /// keys owned by that user. Implementations must commit all three changes
  /// in one database transaction.
  async fn commit_user_suspension(&self, user_id: Uuid, changed_at: DateTime<Utc>) -> AuthResult<UserSuspensionCommit>;
  /// Lock the target and commit its Admin flag together with existing session
  /// IDs. Missing targets fail; sessions/keys are neither revoked nor deleted.
  async fn commit_user_admin_role(&self, user_id: Uuid, is_admin: bool) -> AuthResult<UserAdminRoleCommit>;
  /// Set a user's disabled status.  When `disabled = true` the account is
  /// suspended (equivalent to `status = 'disabled'` in the DB); when `false`
  /// the account is restored to active.  Returns the updated user.
  async fn set_user_disabled(&self, user_id: Uuid, disabled: bool) -> AuthResult<AuthUser>;
  async fn set_email_verified(&self, user_id: Uuid, verified_at: DateTime<Utc>) -> AuthResult<()>;
  async fn create_session(&self, session: NewSession) -> AuthResult<AuthSession>;
  async fn get_session(&self, session_id: Uuid) -> AuthResult<Option<AuthSession>>;
  async fn refresh_session(
    &self,
    session_id: Uuid,
    expires_at: DateTime<Utc>,
    refresh_after: DateTime<Utc>,
  ) -> AuthResult<()>;
  /// Select and lock target sessions, establish the cache barrier, and revoke
  /// unrevoked rows atomically. No expiry filter is applied; previously revoked
  /// rows are captured for stale-cache eviction but retain their timestamp.
  async fn commit_session_revocation(
    &self,
    target: &SessionRevocationTarget,
    revoked_at: DateTime<Utc>,
    barrier: &dyn SessionRevocationBarrier,
  ) -> AuthResult<SessionRevocationCommit>;
  async fn revoke_session(&self, session_id: Uuid, revoked_at: DateTime<Utc>) -> AuthResult<()>;
  async fn revoke_all_user_sessions(&self, user_id: Uuid, revoked_at: DateTime<Utc>) -> AuthResult<()>;

  /// Resolve the group root linked to a session.
  async fn get_session_group_root(&self, session_id: Uuid) -> AuthResult<Option<Uuid>>;
  /// Insert or update one session-group membership.
  async fn upsert_session_group_link(&self, link: SessionGroupLink) -> AuthResult<()>;
  /// Remove one session from its group.
  async fn delete_session_group_link(&self, session_id: Uuid) -> AuthResult<()>;
  /// List group sessions in oldest-first order.
  async fn list_session_group_sessions(&self, root_session_id: Uuid) -> AuthResult<Vec<Uuid>>;
  /// List distinct group users in first-linked order.
  async fn list_session_group_users(&self, root_session_id: Uuid) -> AuthResult<Vec<Uuid>>;
  /// Find the newest group session owned by `user_id`.
  async fn find_session_group_session_for_user(&self, root_session_id: Uuid, user_id: Uuid)
  -> AuthResult<Option<Uuid>>;

  async fn create_verification_token(
    &self,
    user_id: Option<Uuid>,
    kind: &str,
    token_hash: &str,
    email: Option<&str>,
    expires_at: DateTime<Utc>,
    extra: Option<serde_json::Value>,
  ) -> AuthResult<VerificationToken>;
  async fn get_verification_token(&self, token_hash: &str) -> AuthResult<Option<VerificationToken>>;
  async fn find_verification_token(
    &self,
    kind: &str,
    token_hash: &str,
    user_id: Option<Uuid>,
  ) -> AuthResult<Option<VerificationToken>>;
  async fn consume_verification_token(&self, token_hash: &str, used_at: DateTime<Utc>) -> AuthResult<()>;

  /// Validate the bound VerifyEmail token and live account under locks, then
  /// commit email verification, token consumption and all session revocations.
  /// Fences roll back only after a confirmed DB rollback; uncertain commits
  /// remain blocked. No raw token or email may enter diagnostic metadata.
  async fn commit_email_change(
    &self,
    user_id: Uuid,
    token: &str,
    email: &str,
    changed_at: DateTime<Utc>,
    barrier: &dyn SessionRevocationBarrier,
  ) -> AuthResult<EmailChangeCommit>;

  /// Atomically validate and consume a `ChangePassword` token, replace the
  /// bound user's password hash, and revoke every existing user session.
  /// Implementations must lock or conditionally update the token so concurrent
  /// callers cannot both succeed.
  async fn commit_password_reset(
    &self,
    token_hash: &str,
    password_hash: String,
    changed_at: DateTime<Utc>,
  ) -> AuthResult<PasswordResetCommit>;

  async fn create_access_token(&self, input: NewAccessToken) -> AuthResult<AccessToken>;
  async fn list_access_tokens(&self, user_id: Uuid) -> AuthResult<Vec<AccessToken>>;
  async fn revoke_access_token(&self, id: Uuid, user_id: Uuid) -> AuthResult<()>;

  async fn get_user_preferences(&self, user_id: Uuid) -> AuthResult<UserPreferencesRecord>;
  async fn acknowledge_workspace_starter_assistance(&self, actor: Uuid, request_id: Uuid) -> AuthResult<()>;
  async fn get_assistance(
    &self,
    user_id: Uuid,
    workspace_id: Option<Uuid>,
    project_id: Option<Uuid>,
  ) -> AuthResult<EffectiveAssistance>;
  async fn patch_user_preferences(
    &self,
    user_id: Uuid,
    patch: UserPreferencesPatch,
  ) -> AuthResult<UserPreferencesRecord>;
  async fn has_shared_workspace(&self, user_id1: Uuid, user_id2: Uuid) -> AuthResult<bool>;
  async fn get_workspace_role(&self, user_id: Uuid, workspace_id: Uuid) -> AuthResult<Option<WorkspaceRole>>;
  async fn get_doc_role(&self, user_id: Uuid, doc_id: Uuid) -> AuthResult<Option<DocRole>>;
  /// Fetch explicit document-role overrides for one user in one database call.
  /// Missing document IDs are intentionally absent from the result.
  async fn get_doc_roles_bulk(&self, user_id: Uuid, doc_ids: &[Uuid]) -> AuthResult<HashMap<Uuid, DocRole>>;

  async fn get_connected_account(
    &self,
    provider: &str,
    provider_account_id: &str,
  ) -> AuthResult<Option<ConnectedAccount>>;
  async fn create_connected_account(&self, input: NewConnectedAccount) -> AuthResult<ConnectedAccount>;
  async fn update_connected_account(
    &self,
    id: Uuid,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<DateTime<Utc>>,
  ) -> AuthResult<()>;

  async fn upsert_magic_link_otp(&self, otp: MagicLinkOtp) -> AuthResult<()>;
  async fn get_magic_link_otp(&self, email: &str, otp: &str) -> AuthResult<Option<MagicLinkOtp>>;
  /// Consume the existing OTP/token under the bound account lock. Existing
  /// accounts resolve by UUID; only unbound signup tokens may fulfill by email.
  async fn consume_magic_link_otp(
    &self,
    email: &str,
    otp: &str,
    client_nonce: Option<&str>,
    used_at: DateTime<Utc>,
  ) -> AuthResult<AuthUser>;
}

/// In-process auth + workspace store backed by `RwLock<HashMap<…>>`.
///
/// Used exclusively in integration tests.  This type implements both
/// [`AuthStore`] and [`WorkspaceStore`] so a single instance can be passed
/// wherever either trait is required.
#[derive(Debug, Default)]
pub struct InMemoryAuthStore {
  users_by_id: RwLock<HashMap<Uuid, AuthUser>>,
  users_by_email: RwLock<HashMap<String, Uuid>>,
  sessions: RwLock<HashMap<Uuid, AuthSession>>,
  session_group_links: RwLock<HashMap<Uuid, SessionGroupLink>>,
  verification_tokens: RwLock<HashMap<String, VerificationToken>>,
  access_tokens: RwLock<HashMap<Uuid, AccessToken>>,
  user_preferences: RwLock<HashMap<Uuid, UserPreferencesRecord>>,
  connected_accounts: RwLock<HashMap<(String, String), ConnectedAccount>>,
  magic_link_otps: RwLock<HashMap<(String, String), MagicLinkOtp>>,
  workspaces: RwLock<HashMap<Uuid, Workspace>>,
  memberships: RwLock<HashMap<(Uuid, Uuid), WorkspaceMember>>,
  invite_links: RwLock<HashMap<Uuid, WorkspaceInviteLink>>,
  docs: RwLock<HashMap<Uuid, bool>>,
  doc_permissions: RwLock<HashMap<(Uuid, Uuid), DocRole>>,
  user_features: RwLock<HashMap<(Uuid, String), bool>>,
}

impl InMemoryAuthStore {
  fn fulfill_locked(
    users: &mut HashMap<Uuid, AuthUser>,
    emails: &mut HashMap<String, Uuid>,
    email: &str,
    name: Option<&str>,
    avatar_url: Option<&str>,
  ) -> AuthResult<AuthUser> {
    validate_email(email)?;
    let email = email.to_lowercase();
    if let Some(id) = emails.get(&email) {
      return users
        .get(id)
        .filter(Self::operational)
        .cloned()
        .ok_or(AuthError::NotFound("user".into()));
    }
    let user = AuthUser {
      id: Uuid::new_v4(),
      email: email.clone(),
      name: name.map(str::to_owned),
      avatar_url: avatar_url.map(str::to_owned),
      password_hash: None,
      is_admin: false,
      disabled: false,
      email_verified_at: None,
      registered: true,
    };
    emails.insert(email, user.id);
    users.insert(user.id, user.clone());
    Ok(user)
  }

  fn operational(user: &&AuthUser) -> bool {
    user.email != format!("deleted:{}", user.id)
  }

  /// Insert a user into both the by-id and by-email indexes.
  pub fn insert_user(&self, user: AuthUser) {
    let key = user.email.to_lowercase();

    let mut users_by_id = self.users_by_id.write().expect("in-memory users lock poisoned");
    users_by_id.insert(user.id, user.clone());

    let mut users_by_email = self.users_by_email.write().expect("in-memory email lock poisoned");
    users_by_email.insert(key, user.id);
  }

  /// Configure an explicit document-role override for permission tests.
  pub fn set_doc_role(&self, user_id: Uuid, doc_id: Uuid, role: DocRole) {
    self
      .doc_permissions
      .write()
      .expect("in-memory doc permissions lock poisoned")
      .insert((user_id, doc_id), role);
  }
}

/// Hash a plain-text password using Argon2id with a freshly generated salt.
///
/// The returned string is in the PHC format (`$argon2id$...`) and can be
/// stored directly in the database.
pub fn hash_password(password: &str) -> AuthResult<String> {
  trace!("hashing password");
  let salt = SaltString::generate(&mut OsRng);
  Argon2::default()
    .hash_password(password.as_bytes(), &salt)
    .map(|hash| hash.to_string())
    .map_err(|err| {
      error!(error = %err, "password hashing failed");
      AuthError::Storage(format!("password hashing failed: {err}"))
    })
}

/// Alias for [`hash_password`] intended for test code; behaviour is identical.
pub fn hash_password_for_testing(password: &str) -> AuthResult<String> {
  hash_password(password)
}

/// Verify a plain-text password against a stored PHC-format Argon2 hash.
///
/// Returns `false` rather than an error if the hash is malformed, so callers
/// can treat malformed hashes the same as mismatches.
pub fn verify_password_hash(hash: &str, password: &str) -> bool {
  let Ok(parsed_hash) = PasswordHash::new(hash) else {
    return false;
  };

  Argon2::default()
    .verify_password(password.as_bytes(), &parsed_hash)
    .is_ok()
}

/// Perform a minimal syntactic validation on an email address.
///
/// Only checks that the string is non-empty and contains `@`.  This is
/// intentionally lenient — full RFC 5322 parsing is left to the transport
/// layer (e.g. the mail provider will reject truly invalid addresses).
pub fn validate_email(email: &str) -> AuthResult<()> {
  let trimmed = email.trim();
  if trimmed.is_empty() || !trimmed.contains('@') {
    return Err(AuthError::InvalidEmail);
  }
  Ok(())
}

/// API-RV-05: Validate magic-link callback URL.
///
/// Only relative paths (starting with `/`, not `//`) are accepted to prevent
/// open-redirect / phishing attacks via external callback domains.
pub fn validate_magic_link_callback(callback_url: &str) -> AuthResult<()> {
  if !callback_url.starts_with('/') || callback_url.starts_with("//") {
    return Err(AuthError::InvalidInput(
      "callback_url must be a relative path (starting with /)".to_string(),
    ));
  }
  Ok(())
}

fn map_auth_user_to_domain_user(u: &AuthUser) -> User {
  User {
    id: u.id,
    email: u.email.clone(),
    name: u.name.clone().unwrap_or_default(),
    password_hash: u.password_hash.clone(),
    avatar_url: u.avatar_url.clone(),
    avatar_key: u.avatar_url.clone(),
    status: if u.disabled {
      myoxus_domain::entities::AccountStatus::Disabled
    } else {
      myoxus_domain::entities::AccountStatus::Active
    },
    is_admin: u.is_admin,
    registered: u.registered,
    disabled: u.disabled,
    email_verified_at: u.email_verified_at,
    created_at: Utc::now(), // mock
    updated_at: Utc::now(), // mock
  }
}

#[async_trait]
impl AuthStore for InMemoryAuthStore {
  async fn insert_admin_user(&self, email: &str, name: Option<&str>) -> AuthResult<Option<AuthUser>> {
    let email = email.trim().to_lowercase();
    // Match insert_user/delete_user lock ordering and hold both indexes across
    // duplicate admission so two administrative callers cannot both win.
    let mut by_id = self.users_by_id.write().expect("in-memory users lock poisoned");
    let mut by_email = self.users_by_email.write().expect("in-memory email lock poisoned");
    if by_email.contains_key(&email) {
      return Ok(None);
    }
    let user = AuthUser {
      id: Uuid::new_v4(),
      email: email.clone(),
      name: name.map(str::to_owned),
      avatar_url: None,
      password_hash: None,
      is_admin: false,
      disabled: false,
      email_verified_at: None,
      registered: true,
    };
    by_email.insert(email, user.id);
    by_id.insert(user.id, user.clone());
    Ok(Some(user))
  }

  async fn auth_capability_account_state(&self) -> AuthResult<AuthCapabilityAccountState> {
    let users = self.users_by_id.read().expect("in-memory users lock poisoned");
    Ok(AuthCapabilityAccountState {
      total_users: users.values().filter(Self::operational).count() as u64,
      active_password_users: users
        .values()
        .filter(|user| !user.disabled && user.registered && user.password_hash.is_some())
        .count() as u64,
    })
  }

  async fn get_user_by_email(&self, email: &str) -> AuthResult<Option<AuthUser>> {
    let key = email.to_lowercase();

    let maybe_user_id = {
      let users_by_email = self.users_by_email.read().expect("in-memory email lock poisoned");
      users_by_email.get(&key).copied()
    };

    let Some(user_id) = maybe_user_id else {
      return Ok(None);
    };

    let users_by_id = self.users_by_id.read().expect("in-memory users lock poisoned");
    Ok(users_by_id.get(&user_id).filter(Self::operational).cloned())
  }

  async fn get_user_by_id(&self, user_id: Uuid) -> AuthResult<Option<AuthUser>> {
    let users_by_id = self.users_by_id.read().expect("in-memory users lock poisoned");
    Ok(users_by_id.get(&user_id).filter(Self::operational).cloned())
  }

  async fn get_users_by_ids(&self, ids: &[Uuid]) -> AuthResult<HashMap<Uuid, AuthUser>> {
    let users_by_id = self.users_by_id.read().expect("in-memory users lock poisoned");
    let mut result = HashMap::with_capacity(ids.len());
    for id in ids {
      if let Some(user) = users_by_id.get(id).filter(Self::operational) {
        result.insert(*id, user.clone());
      }
    }
    Ok(result)
  }

  async fn get_historical_profiles(&self, ids: &[Uuid]) -> AuthResult<HashMap<Uuid, HistoricalUserProfile>> {
    let users = self.users_by_id.read().expect("in-memory users lock poisoned");
    Ok(
      ids
        .iter()
        .filter_map(|id| users.get(id).map(|u| (*id, HistoricalUserProfile::from(u))))
        .collect(),
    )
  }

  async fn get_user_feature_override(&self, user_id: Uuid, feature_name: &str) -> AuthResult<Option<bool>> {
    Ok(
      self
        .user_features
        .read()
        .expect("in-memory user features lock poisoned")
        .get(&(user_id, feature_name.to_string()))
        .copied(),
    )
  }

  async fn get_user_feature_overrides(&self, user_ids: &[Uuid], feature_name: &str) -> AuthResult<HashMap<Uuid, bool>> {
    let features = self
      .user_features
      .read()
      .expect("in-memory user features lock poisoned");
    Ok(
      user_ids
        .iter()
        .filter_map(|user_id| {
          features
            .get(&(*user_id, feature_name.to_string()))
            .copied()
            .map(|activated| (*user_id, activated))
        })
        .collect(),
    )
  }

  async fn set_user_feature_override(
    &self,
    user_id: Uuid,
    feature_name: &str,
    activated: bool,
    _reason: &str,
  ) -> AuthResult<()> {
    let users = self.users_by_id.read().expect("in-memory users lock poisoned");
    if users.get(&user_id).filter(Self::operational).is_none() {
      return Err(AuthError::NotFound("user".into()));
    }
    self
      .user_features
      .write()
      .expect("in-memory user features lock poisoned")
      .insert((user_id, feature_name.to_string()), activated);
    Ok(())
  }

  async fn last_login_at(&self, user_id: Uuid) -> AuthResult<Option<DateTime<Utc>>> {
    Ok(
      self
        .sessions
        .read()
        .expect("in-memory sessions lock poisoned")
        .values()
        .filter(|session| session.user_id == user_id)
        .map(|session| session.created_at)
        .max(),
    )
  }

  async fn get_existing_emails(&self, emails: &[String]) -> AuthResult<HashSet<String>> {
    let users_by_email = self.users_by_email.read().expect("in-memory email lock poisoned");
    let mut result = HashSet::new();
    for email in emails {
      if users_by_email.contains_key(email) {
        result.insert(email.clone());
      }
    }
    Ok(result)
  }

  async fn fulfill_user(&self, email: &str, name: Option<&str>, avatar_url: Option<&str>) -> AuthResult<AuthUser> {
    let mut users = self.users_by_id.write().expect("in-memory users lock poisoned");
    let mut emails = self.users_by_email.write().expect("in-memory email lock poisoned");
    Self::fulfill_locked(&mut users, &mut emails, email, name, avatar_url)
  }

  async fn update_user(&self, user_id: Uuid, update: UpdateAuthUser) -> AuthResult<AuthUser> {
    let mut users = self.users_by_id.write().expect("in-memory users lock poisoned");
    let user = users
      .get_mut(&user_id)
      .filter(|u| Self::operational(&&**u))
      .ok_or(AuthError::NotFound("user".into()))?;
    let mut emails = self.users_by_email.write().expect("in-memory email lock poisoned");
    // Reject a duplicate before changing any field, just like the SQL UPDATE.
    if let Some(email) = &update.email {
      let key = email.to_lowercase();
      if emails.get(&key).is_some_and(|existing| *existing != user_id) {
        return Err(AuthError::Storage("email already used".into()));
      }
    }
    if let Some(name) = update.name {
      user.name = name;
    }
    if let Some(avatar_url) = update.avatar_url {
      user.avatar_url = avatar_url;
    }
    if let Some(email) = update.email {
      emails.remove(&user.email.to_lowercase());
      emails.insert(email.to_lowercase(), user_id);
      user.email = email;
    }
    Ok(user.clone())
  }

  async fn commit_user_deletion(&self, user_id: Uuid) -> AuthResult<UserDeletionCommit> {
    // Match credential creation and the other account commits: user first,
    // then its indices/credentials, held until the in-memory commit completes.
    let mut users = self.users_by_id.write().expect("in-memory users lock poisoned");
    let user = users
      .get(&user_id)
      .filter(Self::operational)
      .ok_or(AuthError::NotFound("user".into()))?;
    let projection = AuthUserProjection::from(user);
    let mut emails = self.users_by_email.write().expect("in-memory email lock poisoned");
    let mut sessions = self.sessions.write().expect("in-memory sessions lock poisoned");
    let mut revoked_session_ids = sessions
      .values()
      .filter(|s| s.user_id == user_id)
      .map(|s| s.id)
      .collect::<Vec<_>>();
    revoked_session_ids.sort_unstable();
    sessions.retain(|_, session| session.user_id != user_id);
    self
      .session_group_links
      .write()
      .expect("in-memory session group lock poisoned")
      .retain(|_, link| link.user_id != user_id && !revoked_session_ids.contains(&link.root_session_id));
    self
      .verification_tokens
      .write()
      .expect("in-memory token lock poisoned")
      .retain(|_, token| {
        token.user_id != Some(user_id)
          && token.email.as_deref().map(str::to_lowercase).as_deref() != Some(&projection.email.to_lowercase())
      });
    self
      .magic_link_otps
      .write()
      .expect("in-memory otps lock poisoned")
      .retain(|(email, _), _| !email.eq_ignore_ascii_case(&projection.email));
    self
      .access_tokens
      .write()
      .expect("in-memory access-token lock poisoned")
      .retain(|_, token| token.user_id != user_id);
    self
      .connected_accounts
      .write()
      .expect("in-memory account lock poisoned")
      .retain(|_, account| account.user_id != user_id);
    self
      .user_preferences
      .write()
      .expect("in-memory preferences lock poisoned")
      .remove(&user_id);
    self
      .user_features
      .write()
      .expect("in-memory feature lock poisoned")
      .retain(|(id, _), _| *id != user_id);
    // Model the same ownership outcomes for the workspaces/root documents
    // represented by this test store. Memberships precede workspace locks.
    let mut memberships = self.memberships.write().expect("in-memory memberships lock poisoned");
    let mut workspaces = self.workspaces.write().expect("in-memory workspaces lock poisoned");
    let mut deleted_workspaces = Vec::new();
    workspaces.retain(|id, workspace| {
      if workspace.owner_user_id != Some(user_id) {
        return true;
      }
      if memberships.values().any(|member| {
        member.workspace_id == *id && member.user.id != user_id && member.status == MembershipStatus::Accepted
      }) {
        workspace.owner_user_id = None;
        workspace.updated_at = Utc::now();
        true
      } else {
        deleted_workspaces.push(*id);
        false
      }
    });
    memberships
      .retain(|(workspace_id, member_id), _member| *member_id != user_id && !deleted_workspaces.contains(workspace_id));
    self
      .docs
      .write()
      .expect("in-memory docs lock poisoned")
      .retain(|id, _| !deleted_workspaces.contains(id));
    self
      .invite_links
      .write()
      .expect("in-memory links lock poisoned")
      .retain(|workspace_id, _| !deleted_workspaces.contains(workspace_id));
    self
      .doc_permissions
      .write()
      .expect("in-memory doc permissions lock poisoned")
      .retain(|(id, _), _| *id != user_id);
    emails.remove(&projection.email.to_lowercase());
    let user = users.get_mut(&user_id).expect("locked retained identity");
    user.email = format!("deleted:{user_id}");
    user.password_hash = None;
    user.avatar_url = None;
    user.email_verified_at = None;
    user.is_admin = false;
    user.disabled = true;
    let projection = AuthUserProjection {
      email: String::new(),
      avatar_url: None,
      is_admin: false,
      disabled: true,
      email_verified_at: None,
      has_password: false,
      ..projection
    };
    Ok(UserDeletionCommit {
      user: projection,
      revoked_session_ids,
      deleted_api_key_ids: Vec::new(),
    })
  }

  async fn commit_password_update(
    &self,
    user_id: Uuid,
    password_hash: String,
    changed_at: DateTime<Utc>,
  ) -> AuthResult<PasswordUpdateCommit> {
    let mut users = self.users_by_id.write().expect("in-memory users lock poisoned");
    let user = users
      .get_mut(&user_id)
      .filter(|u| Self::operational(&&**u))
      .ok_or(AuthError::NotFound("user".to_string()))?;
    let mut sessions = self.sessions.write().expect("in-memory sessions lock poisoned");
    let revoked_session_ids = sessions
      .values()
      .filter(|session| session.user_id == user_id)
      .map(|session| session.id)
      .collect::<Vec<_>>();

    user.password_hash = Some(password_hash);
    for session in sessions.values_mut().filter(|session| session.user_id == user_id) {
      session.revoked_at = Some(session.revoked_at.unwrap_or(changed_at));
    }

    Ok(PasswordUpdateCommit {
      user_id,
      revoked_session_ids,
    })
  }

  async fn commit_user_suspension(&self, user_id: Uuid, changed_at: DateTime<Utc>) -> AuthResult<UserSuspensionCommit> {
    let mut users = self.users_by_id.write().expect("in-memory users lock poisoned");
    let user = users
      .get_mut(&user_id)
      .filter(|u| Self::operational(&&**u))
      .ok_or(AuthError::NotFound("user".to_string()))?;
    user.disabled = true;

    let mut sessions = self.sessions.write().expect("in-memory sessions lock poisoned");
    let revoked_session_ids = sessions
      .values_mut()
      .filter(|session| session.user_id == user_id)
      .map(|session| {
        session.revoked_at = Some(session.revoked_at.unwrap_or(changed_at));
        session.id
      })
      .collect();

    Ok(UserSuspensionCommit {
      user: AuthUserProjection::from(&*user),
      revoked_session_ids,
      deleted_api_key_ids: Vec::new(),
    })
  }

  async fn commit_user_admin_role(&self, user_id: Uuid, is_admin: bool) -> AuthResult<UserAdminRoleCommit> {
    let mut users = self.users_by_id.write().expect("in-memory users lock poisoned");
    let user = users
      .get_mut(&user_id)
      .filter(|u| Self::operational(&&**u))
      .ok_or(AuthError::NotFound("user".into()))?;
    let sessions = self.sessions.read().expect("in-memory sessions lock poisoned");
    let mut session_ids = sessions
      .values()
      .filter(|session| session.user_id == user_id)
      .map(|session| session.id)
      .collect::<Vec<_>>();
    session_ids.sort_unstable();
    let previous_is_admin = user.is_admin;
    user.is_admin = is_admin;
    Ok(UserAdminRoleCommit {
      user_id,
      previous_is_admin,
      is_admin,
      session_ids,
    })
  }

  async fn set_user_disabled(&self, user_id: Uuid, disabled: bool) -> AuthResult<AuthUser> {
    let mut users_by_id = self.users_by_id.write().expect("in-memory users lock poisoned");
    if let Some(user) = users_by_id.get_mut(&user_id).filter(|u| Self::operational(&&**u)) {
      user.disabled = disabled;
      Ok(user.clone())
    } else {
      Err(AuthError::NotFound("user".into()))
    }
  }

  async fn set_email_verified(&self, user_id: Uuid, verified_at: DateTime<Utc>) -> AuthResult<()> {
    let mut users_by_id = self.users_by_id.write().expect("in-memory users lock poisoned");
    if let Some(user) = users_by_id.get_mut(&user_id).filter(|u| Self::operational(&&**u)) {
      user.email_verified_at = Some(verified_at);
      Ok(())
    } else {
      Err(AuthError::NotFound("user".into()))
    }
  }

  async fn create_session(&self, session: NewSession) -> AuthResult<AuthSession> {
    let users = self.users_by_id.read().expect("in-memory users lock poisoned");
    let Some(user) = users.get(&session.user_id) else {
      return Err(AuthError::AuthenticationRequired);
    };
    if user.disabled {
      return Err(AuthError::AuthenticationRequired);
    }

    let created = AuthSession {
      id: session.id,
      user_id: session.user_id,
      csrf_token: session.csrf_token,
      user_agent: session.user_agent,
      ip_address: session.ip_address,
      expires_at: session.expires_at,
      refresh_after: session.refresh_after,
      revoked_at: None,
      created_at: session.created_at,
    };

    let mut sessions = self.sessions.write().expect("in-memory sessions lock poisoned");
    sessions.insert(created.id, created.clone());
    Ok(created)
  }

  async fn get_session(&self, session_id: Uuid) -> AuthResult<Option<AuthSession>> {
    let sessions = self.sessions.read().expect("in-memory sessions lock poisoned");
    Ok(sessions.get(&session_id).cloned())
  }

  async fn refresh_session(
    &self,
    session_id: Uuid,
    expires_at: DateTime<Utc>,
    refresh_after: DateTime<Utc>,
  ) -> AuthResult<()> {
    let mut sessions = self.sessions.write().expect("in-memory sessions lock poisoned");
    if let Some(session) = sessions.get_mut(&session_id) {
      session.expires_at = expires_at;
      session.refresh_after = refresh_after;
    }
    Ok(())
  }

  async fn commit_session_revocation(
    &self,
    target: &SessionRevocationTarget,
    revoked_at: DateTime<Utc>,
    barrier: &dyn SessionRevocationBarrier,
  ) -> AuthResult<SessionRevocationCommit> {
    let user_id = if let SessionRevocationTarget::User(filter) = target {
      let users = self.users_by_id.read().expect("in-memory users lock poisoned");
      users
        .values()
        .find(|u| u.email == *filter || u.id.to_string() == *filter)
        .map(|u| u.id)
    } else {
      None
    };
    let captured: Vec<(Uuid, Uuid)> = {
      let sessions = self.sessions.read().expect("in-memory sessions lock poisoned");
      sessions
        .values()
        .filter(|s| match target {
          SessionRevocationTarget::Session(id) => s.id == *id,
          SessionRevocationTarget::User(_) => Some(s.user_id) == user_id,
          SessionRevocationTarget::All => true,
        })
        .map(|s| (s.id, s.user_id))
        .collect()
    };
    let users: Vec<Uuid> = captured
      .iter()
      .map(|(_, user)| *user)
      .collect::<std::collections::BTreeSet<_>>()
      .into_iter()
      .collect();
    let epochs = barrier.block(&users).await?;
    let mut sessions = self.sessions.write().expect("in-memory sessions lock poisoned");
    let mut commit = SessionRevocationCommit {
      sessions: captured.clone(),
      revoked_count: 0,
      epochs,
    };
    for (id, _) in captured {
      if let Some(session) = sessions.get_mut(&id).filter(|s| s.revoked_at.is_none()) {
        session.revoked_at = Some(revoked_at);
        commit.revoked_count += 1;
      }
    }
    Ok(commit)
  }

  async fn revoke_session(&self, session_id: Uuid, revoked_at: DateTime<Utc>) -> AuthResult<()> {
    let mut sessions = self.sessions.write().expect("in-memory sessions lock poisoned");
    if let Some(session) = sessions.get_mut(&session_id) {
      session.revoked_at = Some(revoked_at);
    }
    Ok(())
  }

  async fn revoke_all_user_sessions(&self, user_id: Uuid, revoked_at: DateTime<Utc>) -> AuthResult<()> {
    let mut sessions = self.sessions.write().expect("in-memory sessions lock poisoned");
    for session in sessions.values_mut() {
      if session.user_id == user_id {
        session.revoked_at = Some(revoked_at);
      }
    }
    Ok(())
  }

  async fn get_session_group_root(&self, session_id: Uuid) -> AuthResult<Option<Uuid>> {
    Ok(
      self
        .session_group_links
        .read()
        .expect("in-memory session-group lock poisoned")
        .get(&session_id)
        .map(|link| link.root_session_id),
    )
  }

  async fn upsert_session_group_link(&self, link: SessionGroupLink) -> AuthResult<()> {
    let users = self.users_by_id.read().expect("in-memory users lock poisoned");
    if users.get(&link.user_id).filter(Self::operational).is_none() {
      return Err(AuthError::NotFound("user".into()));
    }
    let mut links = self
      .session_group_links
      .write()
      .expect("in-memory session-group lock poisoned");
    if links.len() >= 50_000 {
      let mut oldest = links
        .values()
        .map(|item| (item.session_id, item.created_at))
        .collect::<Vec<_>>();
      oldest.sort_by_key(|(_, created_at)| *created_at);
      let evict_count = oldest.len() / 2;
      for (session_id, _) in oldest.into_iter().take(evict_count) {
        links.remove(&session_id);
      }
    }
    links.insert(link.session_id, link);
    Ok(())
  }

  async fn delete_session_group_link(&self, session_id: Uuid) -> AuthResult<()> {
    self
      .session_group_links
      .write()
      .expect("in-memory session-group lock poisoned")
      .remove(&session_id);
    Ok(())
  }

  async fn list_session_group_sessions(&self, root_session_id: Uuid) -> AuthResult<Vec<Uuid>> {
    let links = self
      .session_group_links
      .read()
      .expect("in-memory session-group lock poisoned");
    let mut links = links
      .values()
      .filter(|link| link.root_session_id == root_session_id)
      .copied()
      .collect::<Vec<_>>();
    links.sort_by_key(|link| link.created_at);
    Ok(links.into_iter().map(|link| link.session_id).collect())
  }

  async fn list_session_group_users(&self, root_session_id: Uuid) -> AuthResult<Vec<Uuid>> {
    let links = self
      .session_group_links
      .read()
      .expect("in-memory session-group lock poisoned");
    let mut first_link = HashMap::<Uuid, DateTime<Utc>>::new();
    for link in links.values().filter(|link| link.root_session_id == root_session_id) {
      first_link
        .entry(link.user_id)
        .and_modify(|created_at| *created_at = (*created_at).min(link.created_at))
        .or_insert(link.created_at);
    }
    let mut users = first_link.into_iter().collect::<Vec<_>>();
    users.sort_by_key(|(_, created_at)| *created_at);
    Ok(users.into_iter().map(|(user_id, _)| user_id).collect())
  }

  async fn find_session_group_session_for_user(
    &self,
    root_session_id: Uuid,
    user_id: Uuid,
  ) -> AuthResult<Option<Uuid>> {
    let links = self
      .session_group_links
      .read()
      .expect("in-memory session-group lock poisoned");
    Ok(
      links
        .values()
        .filter(|link| link.root_session_id == root_session_id && link.user_id == user_id)
        .max_by_key(|link| link.created_at)
        .map(|link| link.session_id),
    )
  }

  async fn create_verification_token(
    &self,
    user_id: Option<Uuid>,
    kind: &str,
    token_hash: &str,
    email: Option<&str>,
    expires_at: DateTime<Utc>,
    extra: Option<serde_json::Value>,
  ) -> AuthResult<VerificationToken> {
    let users = self.users_by_id.read().expect("in-memory users lock poisoned");
    if user_id.is_some_and(|id| users.get(&id).filter(Self::operational).is_none()) {
      return Err(AuthError::NotFound("user".into()));
    }
    let token = VerificationToken {
      id: Uuid::new_v4(),
      user_id,
      kind: kind.to_string(),
      token_hash: token_hash.to_string(),
      email: email.map(|e| e.to_string()),
      expires_at,
      used_at: None,
      created_at: Utc::now(),
      extra,
    };

    let mut tokens = self
      .verification_tokens
      .write()
      .expect("in-memory tokens lock poisoned");
    tokens.insert(token_hash.to_string(), token.clone());
    Ok(token)
  }

  async fn get_verification_token(&self, token_hash: &str) -> AuthResult<Option<VerificationToken>> {
    let tokens = self.verification_tokens.read().expect("in-memory tokens lock poisoned");
    Ok(tokens.get(token_hash).cloned())
  }

  async fn find_verification_token(
    &self,
    kind: &str,
    token_hash: &str,
    user_id: Option<Uuid>,
  ) -> AuthResult<Option<VerificationToken>> {
    let tokens = self.verification_tokens.read().expect("in-memory tokens lock poisoned");
    Ok(
      tokens
        .get(token_hash)
        .filter(|t| t.kind == kind && (user_id.is_none() || t.user_id == user_id))
        .cloned(),
    )
  }

  async fn consume_verification_token(&self, token_hash: &str, used_at: DateTime<Utc>) -> AuthResult<()> {
    let mut tokens = self
      .verification_tokens
      .write()
      .expect("in-memory tokens lock poisoned");
    if let Some(token) = tokens.get_mut(token_hash) {
      token.used_at = Some(used_at);
    }
    Ok(())
  }

  async fn commit_email_change(
    &self,
    user_id: Uuid,
    token_hash: &str,
    email: &str,
    changed_at: DateTime<Utc>,
    barrier: &dyn SessionRevocationBarrier,
  ) -> AuthResult<EmailChangeCommit> {
    let token = self
      .find_verification_token("VerifyEmail", token_hash, Some(user_id))
      .await?
      .filter(|t| t.used_at.is_none())
      .ok_or(AuthError::InvalidToken)?;
    if token.expires_at <= Utc::now().max(changed_at) {
      return Err(AuthError::ExpiredToken);
    }
    let epochs = barrier.block(&[user_id]).await?;
    // Never hold synchronous store locks across Redis awaits. Revalidate all
    // durable inputs together after fencing, in the account-first lock order.
    let result = (|| {
      let mut users = self.users_by_id.write().expect("in-memory users lock poisoned");
      let user = users
        .get_mut(&user_id)
        .filter(|u| Self::operational(&&**u) && !u.disabled)
        .ok_or(AuthError::InvalidToken)?;
      let mut emails = self.users_by_email.write().expect("in-memory email lock poisoned");
      let mut tokens = self
        .verification_tokens
        .write()
        .expect("in-memory tokens lock poisoned");
      let token = tokens
        .get_mut(token_hash)
        .filter(|t| t.kind == "VerifyEmail" && t.user_id == Some(user_id) && t.used_at.is_none())
        .ok_or(AuthError::InvalidToken)?;
      if token.expires_at <= Utc::now().max(changed_at) {
        return Err(AuthError::ExpiredToken);
      }
      let key = email.to_lowercase();
      if emails.get(&key).is_some_and(|id| *id != user_id) {
        return Err(AuthError::ActionForbidden);
      }
      let mut sessions = self.sessions.write().expect("in-memory sessions lock poisoned");
      let revoked_session_ids = sessions
        .values()
        .filter(|s| s.user_id == user_id)
        .map(|s| s.id)
        .collect();
      emails.remove(&user.email.to_lowercase());
      emails.insert(key, user_id);
      user.email = email.to_string();
      user.email_verified_at = Some(changed_at);
      token.used_at = Some(changed_at);
      for session in sessions.values_mut().filter(|s| s.user_id == user_id) {
        session.revoked_at = Some(session.revoked_at.unwrap_or(changed_at));
      }
      Ok((user.clone(), revoked_session_ids))
    })();
    match result {
      Ok((user, revoked_session_ids)) => Ok(EmailChangeCommit {
        user,
        revoked_session_ids,
        epochs,
      }),
      Err(error) => {
        barrier.rollback(&epochs).await;
        Err(error)
      }
    }
  }

  async fn commit_password_reset(
    &self,
    token_hash: &str,
    password_hash: String,
    changed_at: DateTime<Utc>,
  ) -> AuthResult<PasswordResetCommit> {
    // Resolve the identity without holding the token lock, then follow the
    // user-first commit order used by deletion. Revalidate the token under
    // both locks before any write; otherwise reset/deletion could deadlock.
    let user_id = self
      .verification_tokens
      .read()
      .expect("in-memory tokens lock poisoned")
      .get(token_hash)
      .filter(|token| token.kind == "ChangePassword")
      .and_then(|token| token.user_id)
      .ok_or(AuthError::InvalidToken)?;
    let mut users = self.users_by_id.write().expect("in-memory users lock poisoned");
    let user = users
      .get_mut(&user_id)
      .filter(|u| Self::operational(&&**u))
      .ok_or(AuthError::InvalidToken)?;
    let mut tokens = self
      .verification_tokens
      .write()
      .expect("in-memory tokens lock poisoned");
    let token = tokens
      .get_mut(token_hash)
      .filter(|token| token.kind == "ChangePassword" && token.user_id == Some(user_id))
      .ok_or(AuthError::InvalidToken)?;
    if token.used_at.is_some() {
      return Err(AuthError::InvalidToken);
    }
    if token.expires_at <= changed_at {
      return Err(AuthError::ExpiredToken);
    }
    let mut sessions = self.sessions.write().expect("in-memory sessions lock poisoned");
    let revoked_session_ids = sessions
      .values()
      .filter(|session| session.user_id == user_id)
      .map(|session| session.id)
      .collect::<Vec<_>>();

    user.password_hash = Some(password_hash);
    token.used_at = Some(changed_at);
    for session in sessions.values_mut().filter(|session| session.user_id == user_id) {
      session.revoked_at = Some(session.revoked_at.unwrap_or(changed_at));
    }

    Ok(PasswordResetCommit {
      user_id,
      revoked_session_ids,
    })
  }

  async fn create_access_token(&self, input: NewAccessToken) -> AuthResult<AccessToken> {
    let users = self.users_by_id.read().expect("in-memory users lock poisoned");
    if users.get(&input.user_id).filter(Self::operational).is_none() {
      return Err(AuthError::NotFound("user".into()));
    }
    let token = AccessToken {
      id: Uuid::new_v4(),
      user_id: input.user_id,
      name: input.name,
      token_hash: input.token_hash,
      expires_at: input.expires_at,
      created_at: Utc::now(),
      last_used_at: None,
    };
    let mut tokens = self
      .access_tokens
      .write()
      .expect("in-memory access tokens lock poisoned");
    tokens.insert(token.id, token.clone());
    Ok(token)
  }

  async fn list_access_tokens(&self, user_id: Uuid) -> AuthResult<Vec<AccessToken>> {
    let tokens = self
      .access_tokens
      .read()
      .expect("in-memory access tokens lock poisoned");
    Ok(tokens.values().filter(|t| t.user_id == user_id).cloned().collect())
  }

  async fn revoke_access_token(&self, id: Uuid, user_id: Uuid) -> AuthResult<()> {
    let mut tokens = self
      .access_tokens
      .write()
      .expect("in-memory access tokens lock poisoned");
    if let Some(token) = tokens.get(&id)
      && token.user_id == user_id
    {
      tokens.remove(&id);
    }
    Ok(())
  }

  async fn get_user_preferences(&self, user_id: Uuid) -> AuthResult<UserPreferencesRecord> {
    let preferences = self
      .user_preferences
      .read()
      .expect("in-memory user preferences lock poisoned");
    Ok(preferences.get(&user_id).cloned().unwrap_or_default())
  }

  async fn acknowledge_workspace_starter_assistance(&self, _actor: Uuid, _request_id: Uuid) -> AuthResult<()> {
    Err(AuthError::Storage(
      "in-memory Workspace starter receipts unavailable".into(),
    ))
  }

  async fn get_assistance(
    &self,
    user_id: Uuid,
    workspace_id: Option<Uuid>,
    project_id: Option<Uuid>,
  ) -> AuthResult<EffectiveAssistance> {
    if project_id.is_some() {
      return Err(AuthError::NotFound("project".into()));
    }
    let workspaces = self.workspaces.read().expect("in-memory workspaces lock poisoned");
    let memberships = self.memberships.read().expect("in-memory memberships lock poisoned");
    if let Some(id) = workspace_id
      && (workspaces
        .get(&id)
        .is_none_or(|workspace| workspace.deleted_at.is_some())
        || memberships
          .get(&(id, user_id))
          .is_none_or(|member| member.status != MembershipStatus::Accepted))
    {
      return Err(AuthError::ActionForbidden);
    }
    let preferences = self
      .user_preferences
      .read()
      .expect("in-memory user preferences lock poisoned");
    Ok(
      preferences
        .get(&user_id)
        .cloned()
        .unwrap_or_default()
        .values
        .resolve_assistance(workspace_id, None),
    )
  }

  async fn patch_user_preferences(
    &self,
    user_id: Uuid,
    patch: UserPreferencesPatch,
  ) -> AuthResult<UserPreferencesRecord> {
    let users = self.users_by_id.read().expect("in-memory users lock poisoned");
    if users.get(&user_id).filter(Self::operational).is_none() {
      return Err(AuthError::NotFound("user".into()));
    }
    patch.validate_assistance_scopes()?;
    let workspaces = self.workspaces.read().expect("in-memory workspaces lock poisoned");
    let memberships = self.memberships.read().expect("in-memory memberships lock poisoned");
    for workspace_id in patch
      .workspace_assistance_overrides
      .iter()
      .map(|value| value.workspace_id)
      .chain(
        patch
          .project_assistance_overrides
          .iter()
          .map(|value| value.workspace_id),
      )
    {
      if workspaces
        .get(&workspace_id)
        .is_none_or(|workspace| workspace.deleted_at.is_some())
        || memberships
          .get(&(workspace_id, user_id))
          .is_none_or(|member| member.status != MembershipStatus::Accepted)
      {
        return Err(AuthError::ActionForbidden);
      }
    }
    // This store has no Database aggregates; Project targets cannot be admitted.
    if !patch.project_assistance_overrides.is_empty() {
      return Err(AuthError::NotFound("project".into()));
    }
    let mut preferences = self
      .user_preferences
      .write()
      .expect("in-memory user preferences lock poisoned");
    let mut values = preferences.get(&user_id).cloned().unwrap_or_default().values;
    values.apply_patch(patch)?;
    let record = UserPreferencesRecord {
      values,
      updated_at: Some(Utc::now()),
    };
    preferences.insert(user_id, record.clone());
    Ok(record)
  }

  async fn has_shared_workspace(&self, user_id1: Uuid, user_id2: Uuid) -> AuthResult<bool> {
    let memberships = self.memberships.read().expect("in-memory memberships lock poisoned");
    let mut user1_workspaces = HashSet::new();
    for ((workspace_id, user_id), member) in memberships.iter() {
      if *user_id == user_id1 && member.status == MembershipStatus::Accepted {
        user1_workspaces.insert(*workspace_id);
      }
    }
    for ((workspace_id, user_id), member) in memberships.iter() {
      if *user_id == user_id2 && member.status == MembershipStatus::Accepted && user1_workspaces.contains(workspace_id)
      {
        return Ok(true);
      }
    }
    Ok(false)
  }

  async fn get_workspace_role(&self, user_id: Uuid, workspace_id: Uuid) -> AuthResult<Option<WorkspaceRole>> {
    let memberships = self.memberships.read().expect("in-memory memberships lock poisoned");
    Ok(
      memberships
        .get(&(workspace_id, user_id))
        .filter(|m| m.status == MembershipStatus::Accepted)
        .map(|m| m.role),
    )
  }

  async fn get_doc_role(&self, user_id: Uuid, doc_id: Uuid) -> AuthResult<Option<DocRole>> {
    Ok(
      self
        .doc_permissions
        .read()
        .expect("in-memory doc permissions lock poisoned")
        .get(&(user_id, doc_id))
        .copied(),
    )
  }

  async fn get_doc_roles_bulk(&self, user_id: Uuid, doc_ids: &[Uuid]) -> AuthResult<HashMap<Uuid, DocRole>> {
    if doc_ids.is_empty() {
      return Ok(HashMap::new());
    }
    let permissions = self
      .doc_permissions
      .read()
      .expect("in-memory doc permissions lock poisoned");
    Ok(
      doc_ids
        .iter()
        .filter_map(|doc_id| {
          permissions
            .get(&(user_id, *doc_id))
            .copied()
            .map(|role| (*doc_id, role))
        })
        .collect(),
    )
  }

  async fn get_connected_account(
    &self,
    provider: &str,
    provider_account_id: &str,
  ) -> AuthResult<Option<ConnectedAccount>> {
    let accounts = self
      .connected_accounts
      .read()
      .expect("in-memory connected accounts lock poisoned");
    Ok(
      accounts
        .get(&(provider.to_string(), provider_account_id.to_string()))
        .cloned(),
    )
  }

  async fn create_connected_account(&self, input: NewConnectedAccount) -> AuthResult<ConnectedAccount> {
    let users = self.users_by_id.read().expect("in-memory users lock poisoned");
    if users.get(&input.user_id).filter(Self::operational).is_none() {
      return Err(AuthError::NotFound("user".into()));
    }
    let account = ConnectedAccount {
      id: Uuid::new_v4(),
      user_id: input.user_id,
      provider: input.provider.clone(),
      provider_account_id: input.provider_account_id.clone(),
      access_token: input.access_token,
      refresh_token: input.refresh_token,
      expires_at: input.expires_at,
      created_at: Utc::now(),
    };
    let mut accounts = self
      .connected_accounts
      .write()
      .expect("in-memory connected accounts lock poisoned");
    accounts.insert((input.provider, input.provider_account_id), account.clone());
    Ok(account)
  }

  async fn update_connected_account(
    &self,
    id: Uuid,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<DateTime<Utc>>,
  ) -> AuthResult<()> {
    let mut accounts = self
      .connected_accounts
      .write()
      .expect("in-memory connected accounts lock poisoned");
    for account in accounts.values_mut() {
      if account.id == id {
        account.access_token = access_token;
        account.refresh_token = refresh_token;
        account.expires_at = expires_at;
        break;
      }
    }
    Ok(())
  }

  async fn upsert_magic_link_otp(&self, otp: MagicLinkOtp) -> AuthResult<()> {
    let users = self.users_by_id.read().expect("in-memory users lock poisoned");
    let tokens = self.verification_tokens.read().expect("in-memory tokens lock poisoned");
    let token = tokens
      .values()
      .find(|token| token.id == otp.verification_token_id && token.kind == "SignIn" && token.used_at.is_none())
      .ok_or(AuthError::InvalidToken)?;
    if token
      .user_id
      .is_some_and(|id| users.get(&id).filter(Self::operational).is_none())
    {
      return Err(AuthError::InvalidToken);
    }
    let mut otps = self.magic_link_otps.write().expect("in-memory otps lock poisoned");
    otps.retain(|(email, _), _| !email.eq_ignore_ascii_case(&otp.email));
    otps.insert((otp.email.clone(), otp.otp.clone()), otp);
    Ok(())
  }

  async fn get_magic_link_otp(&self, email: &str, otp: &str) -> AuthResult<Option<MagicLinkOtp>> {
    let otps = self.magic_link_otps.read().expect("in-memory otps lock poisoned");
    Ok(otps.get(&(email.to_string(), otp.to_string())).cloned())
  }

  async fn consume_magic_link_otp(
    &self,
    email: &str,
    otp: &str,
    client_nonce: Option<&str>,
    used_at: DateTime<Utc>,
  ) -> AuthResult<AuthUser> {
    let mut users = self.users_by_id.write().expect("in-memory users lock poisoned");
    let mut emails = self.users_by_email.write().expect("in-memory email lock poisoned");
    let mut tokens = self
      .verification_tokens
      .write()
      .expect("in-memory tokens lock poisoned");
    let mut otps = self.magic_link_otps.write().expect("in-memory otps lock poisoned");
    let key = (email.to_string(), otp.to_string());
    let code = otps.get(&key).ok_or(AuthError::InvalidToken)?;
    let token = tokens
      .values_mut()
      .find(|v| {
        v.id == code.verification_token_id
          && v.kind == "SignIn"
          && v.used_at.is_none()
          && v.email.as_deref().is_some_and(|e| e.eq_ignore_ascii_case(email))
      })
      .ok_or(AuthError::InvalidToken)?;
    if code.expires_at <= used_at || token.expires_at <= used_at {
      return Err(AuthError::ExpiredToken);
    }
    if code.client_nonce.as_deref() != client_nonce {
      return Err(AuthError::ActionForbidden);
    }
    let user = if let Some(id) = token.user_id {
      users
        .get(&id)
        .filter(Self::operational)
        .cloned()
        .ok_or(AuthError::InvalidToken)?
    } else {
      Self::fulfill_locked(&mut users, &mut emails, email, None, None)?
    };
    token.used_at = Some(used_at);
    otps.remove(&key);
    Ok(user)
  }
}

#[async_trait]
impl WorkspaceStore for InMemoryAuthStore {
  async fn has_accepted_member(&self, workspace_id: WorkspaceId, user_id: UserId) -> AuthResult<bool> {
    if self
      .get_workspace(workspace_id)
      .await?
      .is_none_or(|workspace| workspace.deleted_at.is_some())
    {
      return Ok(false);
    }
    let memberships = self.memberships.read().expect("in-memory memberships lock poisoned");
    Ok(
      memberships
        .get(&(workspace_id, user_id))
        .is_some_and(|member| member.status == MembershipStatus::Accepted),
    )
  }
  async fn accepted_member_by_email(&self, workspace_id: WorkspaceId, email: &str) -> AuthResult<Option<UserId>> {
    Ok(
      self
        .accepted_members_for_lookup(workspace_id)
        .await?
        .into_iter()
        .find(|member| {
          member
            .handle
            .as_deref()
            .is_some_and(|handle| handle.trim().eq_ignore_ascii_case(email.trim()))
        })
        .map(|member| member.user_id),
    )
  }
  async fn accepted_members_for_lookup(
    &self,
    workspace_id: WorkspaceId,
  ) -> AuthResult<Vec<myoxus_domain::entities::WorkspaceMemberLookupRow>> {
    if self
      .get_workspace(workspace_id)
      .await?
      .is_none_or(|workspace| workspace.deleted_at.is_some())
    {
      return Ok(Vec::new());
    }
    let memberships = self.memberships.read().expect("in-memory memberships lock poisoned");
    let mut members = memberships
      .values()
      .filter(|member| member.workspace_id == workspace_id && member.status == MembershipStatus::Accepted)
      .map(|member| myoxus_domain::entities::WorkspaceMemberLookupRow {
        user_id: member.user.id,
        display_name: member.user.name.clone(),
        handle: Some(member.user.email.clone()),
      })
      .collect::<Vec<_>>();
    members.sort_by_key(|member| member.display_name.to_lowercase());
    Ok(members)
  }

  async fn workspace_classification(&self, workspace_id: Uuid) -> AuthResult<Option<WorkspaceClassification>> {
    Ok(
      self
        .workspaces
        .read()
        .expect("in-memory workspaces lock poisoned")
        .get(&workspace_id)
        .map(|workspace| {
          if workspace.owner_user_id.is_some() {
            WorkspaceClassification::UserOwned
          } else {
            WorkspaceClassification::Shared
          }
        }),
    )
  }
  async fn create_workspace(&self, owner_id: UserId, name: crate::workspace::WorkspaceName) -> AuthResult<Workspace> {
    let users = self.users_by_id.read().expect("in-memory users lock poisoned");
    let user = users
      .get(&owner_id)
      .filter(Self::operational)
      .ok_or(AuthError::NotFound("user".into()))?;
    let mut memberships = self.memberships.write().expect("in-memory memberships lock poisoned");
    let ws = Workspace {
      initial_content_policy: Default::default(),
      id: Uuid::new_v4(),
      owner_user_id: Some(owner_id),
      name: name.display().to_string(),
      description: String::new(),
      overview_settings: Default::default(),
      overview_revision: 0,
      avatar_key: None,
      public: false,
      enable_ai: false,
      enable_sharing: true,
      enable_url_preview: false,
      enable_doc_embedding: false,
      created_at: Utc::now(),
      updated_at: Utc::now(),
      deleted_at: None,
    };
    {
      let mut workspaces = self.workspaces.write().expect("in-memory workspaces lock poisoned");
      workspaces.insert(ws.id, ws.clone());
    }

    memberships.insert(
      (ws.id, owner_id),
      WorkspaceMember {
        workspace_id: ws.id,
        user: map_auth_user_to_domain_user(user),
        role: WorkspaceRole::Owner,
        status: MembershipStatus::Accepted,
        invited_by_user_id: None,
        invite_id: Uuid::new_v4(),
      },
    );

    Ok(ws)
  }

  async fn get_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<Option<Workspace>> {
    let workspaces = self.workspaces.read().expect("in-memory workspaces lock poisoned");
    Ok(workspaces.get(&workspace_id).cloned())
  }

  async fn list_user_workspaces(&self, user_id: UserId) -> AuthResult<Vec<Workspace>> {
    let memberships = self.memberships.read().expect("in-memory memberships lock poisoned");
    let workspaces = self.workspaces.read().expect("in-memory workspaces lock poisoned");

    let ws_ids: Vec<WorkspaceId> = memberships
      .iter()
      .filter(|((_, uid), m)| *uid == user_id && m.status == MembershipStatus::Accepted)
      .map(|((ws_id, _), _)| *ws_id)
      .collect();

    Ok(
      ws_ids
        .into_iter()
        .filter_map(|id| workspaces.get(&id).cloned())
        .collect(),
    )
  }

  async fn update_workspace(&self, workspace_id: WorkspaceId, update: UpdateWorkspace) -> AuthResult<Workspace> {
    let mut workspaces = self.workspaces.write().expect("in-memory workspaces lock poisoned");
    if let Some(ws) = workspaces.get_mut(&workspace_id) {
      if let Some(patch) = &update.overview {
        let (settings, revision) = patch.apply(workspace_id, &ws.overview_settings, ws.overview_revision)?;
        ws.overview_settings = settings;
        ws.overview_revision = revision;
      }
      if let Some(name) = update.name {
        ws.name = name.display().to_string();
      }
      if let Some(public) = update.public {
        ws.public = public;
      }
      if let Some(enable_ai) = update.enable_ai {
        ws.enable_ai = enable_ai;
      }
      if let Some(enable_sharing) = update.enable_sharing {
        ws.enable_sharing = enable_sharing;
      }
      if let Some(enable_url_preview) = update.enable_url_preview {
        ws.enable_url_preview = enable_url_preview;
      }
      if let Some(enable_doc_embedding) = update.enable_doc_embedding {
        ws.enable_doc_embedding = enable_doc_embedding;
      }
      ws.updated_at = Utc::now();
      Ok(ws.clone())
    } else {
      Err(AuthError::Storage("Workspace not found".into()))
    }
  }

  async fn delete_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<()> {
    let mut workspaces = self.workspaces.write().expect("in-memory workspaces lock poisoned");
    workspaces.remove(&workspace_id);
    Ok(())
  }

  async fn list_workspace_members(
    &self,
    workspace_id: WorkspaceId,
    skip: i64,
    take: i64,
    query: Option<String>,
  ) -> AuthResult<Vec<WorkspaceMember>> {
    let memberships = self.memberships.read().expect("in-memory memberships lock poisoned");

    let query = query.map(|q| q.to_lowercase());

    let members: Vec<WorkspaceMember> = memberships
      .values()
      .filter(|m| m.workspace_id == workspace_id)
      .filter(|m| {
        if let Some(q) = &query {
          m.user.email.to_lowercase().contains(q) || m.user.name.to_lowercase().contains(q)
        } else {
          true
        }
      })
      .skip(skip as usize)
      .take(take as usize)
      .cloned()
      .collect();

    Ok(members)
  }

  async fn count_workspace_members(&self, workspace_id: WorkspaceId) -> AuthResult<i64> {
    let memberships = self.memberships.read().expect("in-memory memberships lock poisoned");
    Ok(memberships.values().filter(|m| m.workspace_id == workspace_id).count() as i64)
  }

  async fn get_workspace_owner(&self, workspace_id: WorkspaceId) -> AuthResult<Option<User>> {
    let users_by_id = self.users_by_id.read().expect("in-memory users lock poisoned");
    let workspaces = self.workspaces.read().expect("in-memory workspaces lock poisoned");

    if let Some(ws) = workspaces.get(&workspace_id)
      && let Some(owner_id) = ws.owner_user_id
      && let Some(user) = users_by_id.get(&owner_id)
    {
      return Ok(Some(map_auth_user_to_domain_user(user)));
    }
    Ok(None)
  }

  async fn add_or_update_member(
    &self,
    workspace_id: WorkspaceId,
    user_id: UserId,
    role: WorkspaceRole,
    status: MembershipStatus,
    inviter_id: Option<UserId>,
  ) -> AuthResult<WorkspaceMember> {
    let users = self.users_by_id.read().expect("in-memory users lock poisoned");
    let mut memberships = self.memberships.write().expect("in-memory memberships lock poisoned");
    let user = users
      .get(&user_id)
      .filter(Self::operational)
      .ok_or_else(|| AuthError::NotFound("user".into()))?;

    let prior = memberships.get(&(workspace_id, user_id));
    let member = WorkspaceMember {
      workspace_id,
      invited_by_user_id: inviter_id.or_else(|| prior.and_then(|member| member.invited_by_user_id)),
      user: map_auth_user_to_domain_user(user),
      role,
      status,
      invite_id: prior.map(|member| member.invite_id).unwrap_or_else(Uuid::new_v4),
    };
    memberships.insert((workspace_id, user_id), member.clone());
    Ok(member)
  }

  async fn get_member(&self, workspace_id: WorkspaceId, user_id: UserId) -> AuthResult<Option<WorkspaceMember>> {
    let memberships = self.memberships.read().expect("in-memory memberships lock poisoned");
    Ok(memberships.get(&(workspace_id, user_id)).cloned())
  }

  async fn get_member_by_invite_id(&self, invite_id: InviteLinkId) -> AuthResult<Option<WorkspaceMember>> {
    let memberships = self.memberships.read().expect("in-memory memberships lock poisoned");
    Ok(memberships.values().find(|m| m.invite_id == invite_id).cloned())
  }

  async fn delete_member(&self, workspace_id: WorkspaceId, user_id: UserId) -> AuthResult<()> {
    let mut memberships = self.memberships.write().expect("in-memory memberships lock poisoned");
    memberships.remove(&(workspace_id, user_id));
    Ok(())
  }

  async fn update_member_role(
    &self,
    workspace_id: WorkspaceId,
    user_id: UserId,
    role: WorkspaceRole,
  ) -> AuthResult<()> {
    let mut memberships = self.memberships.write().expect("in-memory memberships lock poisoned");
    if let Some(m) = memberships.get_mut(&(workspace_id, user_id)) {
      m.role = role;
    }
    Ok(())
  }

  async fn transfer_ownership(
    &self,
    workspace_id: WorkspaceId,
    current_owner_id: UserId,
    new_owner_id: UserId,
  ) -> AuthResult<()> {
    {
      let mut workspaces = self.workspaces.write().expect("in-memory workspaces lock poisoned");
      if let Some(ws) = workspaces.get_mut(&workspace_id) {
        ws.owner_user_id = Some(new_owner_id);
      }
    }

    self
      .update_member_role(workspace_id, current_owner_id, WorkspaceRole::Admin)
      .await?;
    self
      .update_member_role(workspace_id, new_owner_id, WorkspaceRole::Owner)
      .await?;

    Ok(())
  }

  async fn list_orphaned_workspaces(&self, skip: i64, take: i64) -> AuthResult<Vec<Workspace>> {
    let workspaces = self.workspaces.read().expect("in-memory workspaces lock poisoned");
    let mut orphaned: Vec<Workspace> = workspaces
      .values()
      .filter(|ws| ws.owner_user_id.is_none() && ws.deleted_at.is_none())
      .cloned()
      .collect();
    orphaned.sort_by_key(|workspace| std::cmp::Reverse(workspace.created_at));
    Ok(orphaned.into_iter().skip(skip as usize).take(take as usize).collect())
  }

  async fn count_orphaned_workspaces(&self) -> AuthResult<i64> {
    let workspaces = self.workspaces.read().expect("in-memory workspaces lock poisoned");
    Ok(
      workspaces
        .values()
        .filter(|ws| ws.owner_user_id.is_none() && ws.deleted_at.is_none())
        .count() as i64,
    )
  }

  async fn reassign_workspace_owner(&self, workspace_id: WorkspaceId, new_owner_id: UserId) -> AuthResult<()> {
    {
      let mut workspaces = self.workspaces.write().expect("in-memory workspaces lock poisoned");
      if let Some(ws) = workspaces.get_mut(&workspace_id) {
        ws.owner_user_id = Some(new_owner_id);
      }
    }
    self
      .add_or_update_member(
        workspace_id,
        new_owner_id,
        WorkspaceRole::Owner,
        MembershipStatus::Accepted,
        None,
      )
      .await?;
    Ok(())
  }

  async fn create_invite_link(
    &self,
    workspace_id: WorkspaceId,
    inviter_id: UserId,
    token_hash: &str,
    expire_at: DateTime<Utc>,
  ) -> AuthResult<WorkspaceInviteLink> {
    let link = WorkspaceInviteLink {
      id: Uuid::new_v4(),
      workspace_id,
      created_by_user_id: inviter_id,
      token_hash: token_hash.to_owned(),
      expires_at: Some(expire_at),
      revoked_at: None,
      created_at: Utc::now(),
    };
    let mut links = self.invite_links.write().expect("in-memory links lock poisoned");
    links.insert(link.workspace_id, link.clone());
    Ok(link)
  }

  async fn get_invite_link(&self, workspace_id: WorkspaceId) -> AuthResult<Option<WorkspaceInviteLink>> {
    let links = self.invite_links.read().expect("in-memory links lock poisoned");
    Ok(links.get(&workspace_id).cloned())
  }

  async fn get_invite_link_by_token(&self, token_hash: &str) -> AuthResult<Option<WorkspaceInviteLink>> {
    let links = self.invite_links.read().expect("in-memory links lock poisoned");
    Ok(links.values().find(|l| l.token_hash == token_hash).cloned())
  }

  async fn revoke_invite_link(&self, workspace_id: WorkspaceId) -> AuthResult<()> {
    let mut links = self.invite_links.write().expect("in-memory links lock poisoned");
    if let Some(link) = links.get_mut(&workspace_id) {
      link.revoked_at = Some(Utc::now());
    }
    Ok(())
  }

  async fn init_workspace_root_doc(
    &self,
    workspace_id: WorkspaceId,
    _user_id: UserId,
    _data: Vec<u8>,
  ) -> AuthResult<()> {
    let mut docs = self.docs.write().expect("in-memory docs lock poisoned");
    docs.insert(workspace_id, true);
    Ok(())
  }

  async fn workspace_root_doc_exists(&self, workspace_id: WorkspaceId) -> AuthResult<bool> {
    let docs = self.docs.read().expect("in-memory docs lock poisoned");
    Ok(docs.contains_key(&workspace_id))
  }

  /// In-memory implementation of `find_personal_workspace`.
  ///
  /// Returns the first active workspace owned by `user_id` (by insertion
  /// order). The in-memory test store does not model the persisted
  /// personal/user-owned classification.
  async fn find_personal_workspace(&self, user_id: UserId) -> AuthResult<Option<Workspace>> {
    let workspaces = self.workspaces.read().expect("in-memory workspaces lock poisoned");
    let found = workspaces
      .values()
      .find(|ws| ws.owner_user_id == Some(user_id) && ws.deleted_at.is_none())
      .cloned();
    Ok(found)
  }
}

/// High-level authentication service.
///
/// `AuthService` orchestrates all user-facing auth operations — sign-in,
/// sign-out, magic links, OAuth, password changes, avatar management — by
/// composing the [`AuthStore`], [`MailPort`], and [`BlobStoragePort`] ports.
///
/// Session snapshots are optionally cached in Redis to reduce database reads
/// on hot authenticated paths.
#[derive(Clone)]
pub struct AuthService {
  /// Underlying auth persistence store.
  pub store: Arc<dyn AuthStore>,
  /// Transactional email port.
  pub mailer: Arc<dyn MailPort>,
  mail_defaults: UserPreferenceDefaults,
  /// Object store for avatar images.
  pub storage: Arc<dyn BlobStoragePort>,
  session_cache: Option<AuthSessionCache>,
  session_ttl_seconds: i64,
  session_ttr_seconds: i64,
  /// TTL for magic-link / OTP verification tokens, in seconds.
  magic_link_ttl_seconds: i64,
  password_reset_links: PasswordResetLinkService,
  password_policy: Arc<dyn PasswordPolicyProvider>,
  session_revocation_observer: Option<Arc<dyn SessionRevocationObserver>>,
  session_revocation_effects: Option<Arc<dyn SessionRevocationEffects>>,
}

/// Process-local side-effect boundary notified only after session revocation
/// has committed. Authentication remains authoritative in the store; the
/// observer exists to stop resources still owned by a revoked live session.
pub trait SessionRevocationObserver: Send + Sync {
  fn session_revoked(&self, session_id: Uuid);
  fn user_sessions_revoked(&self, user_id: Uuid, session_ids: &[Uuid]);
}

#[derive(Clone)]
struct AuthSessionCache {
  redis: Arc<dyn RedisPort>,
  ttl_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedSessionSnapshot {
  snapshot: SessionSnapshot,
  /// `None` is the pre-epoch cache state and remains readable only until this
  /// user experiences the first global session invalidation.
  user_epoch: Option<String>,
}

#[derive(Clone, Copy)]
enum SessionEpochState {
  Blocked,
  Active,
}

#[async_trait]
impl SessionRevocationBarrier for AuthService {
  async fn block(&self, users: &[Uuid]) -> AuthResult<Vec<UserSessionEpoch>> {
    let mut epochs = Vec::with_capacity(users.len());
    for user in users {
      match self.begin_global_session_revoke(*user).await {
        Ok(epoch) => epochs.push(UserSessionEpoch { user_id: *user, epoch }),
        Err(error) => {
          self.rollback(&epochs).await;
          return Err(error);
        }
      }
    }
    Ok(epochs)
  }

  async fn rollback(&self, epochs: &[UserSessionEpoch]) {
    for guard in epochs {
      if self
        .rollback_global_session_revoke(guard.user_id, guard.epoch.as_deref())
        .await
        .is_err()
      {
        error!(user_id = %guard.user_id, "session revocation rolled back while cache remains fail-closed");
      }
    }
  }
}

impl AuthService {
  /// Construct a new `AuthService`.
  ///
  /// `session_ttl_seconds` is the absolute session lifetime; `session_ttr_seconds`
  /// is the time-to-refresh interval after which a sliding renewal is issued.
  pub fn new(
    store: Arc<dyn AuthStore>,
    mailer: Arc<dyn MailPort>,
    storage: Arc<dyn BlobStoragePort>,
    session_ttl_seconds: i64,
    session_ttr_seconds: i64,
  ) -> Self {
    Self {
      password_reset_links: PasswordResetLinkService::new(store.clone(), DEFAULT_PASSWORD_RESET_TTL_SECONDS)
        .expect("static password-reset TTL is valid"),
      store,
      mailer,
      mail_defaults: UserPreferenceDefaults::default(),
      storage,
      session_cache: None,
      session_ttl_seconds,
      session_ttr_seconds,
      magic_link_ttl_seconds: 1800, // 30 minutes default
      password_policy: Arc::new(StaticPasswordPolicyProvider::default()),
      session_revocation_observer: None,
      session_revocation_effects: None,
    }
  }

  /// Construct a new `AuthService` with explicit magic-link TTL.
  pub fn new_with_magic_link_ttl(
    store: Arc<dyn AuthStore>,
    mailer: Arc<dyn MailPort>,
    storage: Arc<dyn BlobStoragePort>,
    session_ttl_seconds: i64,
    session_ttr_seconds: i64,
    magic_link_ttl_seconds: i64,
  ) -> Self {
    Self {
      password_reset_links: PasswordResetLinkService::new(store.clone(), DEFAULT_PASSWORD_RESET_TTL_SECONDS)
        .expect("static password-reset TTL is valid"),
      store,
      mailer,
      mail_defaults: UserPreferenceDefaults::default(),
      storage,
      session_cache: None,
      session_ttl_seconds,
      session_ttr_seconds,
      magic_link_ttl_seconds,
      password_policy: Arc::new(StaticPasswordPolicyProvider::default()),
      session_revocation_observer: None,
      session_revocation_effects: None,
    }
  }

  /// Construct an auth service with independently configured sign-in and
  /// password-reset token lifetimes. Password-reset TTL is restart-bound;
  /// invalid values are rejected instead of silently clamped.
  pub fn new_with_token_ttls(
    store: Arc<dyn AuthStore>,
    mailer: Arc<dyn MailPort>,
    storage: Arc<dyn BlobStoragePort>,
    session_ttl_seconds: i64,
    session_ttr_seconds: i64,
    magic_link_ttl_seconds: i64,
    password_reset_ttl_seconds: i64,
  ) -> AuthResult<Self> {
    Ok(Self {
      password_reset_links: PasswordResetLinkService::new(store.clone(), password_reset_ttl_seconds)?,
      store,
      mailer,
      mail_defaults: UserPreferenceDefaults::default(),
      storage,
      session_cache: None,
      session_ttl_seconds,
      session_ttr_seconds,
      magic_link_ttl_seconds,
      password_policy: Arc::new(StaticPasswordPolicyProvider::default()),
      session_revocation_observer: None,
      session_revocation_effects: None,
    })
  }

  pub fn with_mail_defaults(mut self, defaults: UserPreferenceDefaults) -> Self {
    self.mail_defaults = defaults;
    self
  }

  /// Auth callers pass the known/requesting account ID. New-address delivery
  /// deliberately never resolves the unconfirmed address as another account.
  #[instrument(skip_all)]
  pub async fn prepare_mail_for_user(
    &self,
    user_id: Option<Uuid>,
    to: &str,
    template: MailTemplate,
    context: serde_json::Value,
  ) -> AuthResult<TemplateMail> {
    let presentation = if let Some(user_id) = user_id {
      let record = self.store.get_user_preferences(user_id).await?;
      MailPresentation::from_preferences(&record.values.resolve(&self.mail_defaults), None)
    } else {
      MailPresentation::from_defaults(&self.mail_defaults, None)
    };
    Ok(TemplateMail::new(to, template, presentation, context))
  }

  /// Attach a Redis-backed session snapshot cache.
  ///
  /// When enabled, [`get_session_snapshot`](Self::get_session_snapshot) first
  /// checks Redis before hitting the database.  `ttl_seconds` is clamped to a
  /// minimum of 10 seconds.
  pub fn with_session_cache(mut self, redis: Arc<dyn RedisPort>, ttl_seconds: u64) -> Self {
    let ttl_seconds = ttl_seconds.max(10);
    self.session_cache = Some(AuthSessionCache { redis, ttl_seconds });
    info!(ttl_seconds, "enabled auth session cache");
    self
  }

  /// Bind the runtime source used by every password-setting operation and by
  /// the public server-config projection.
  pub fn with_password_policy_provider(mut self, provider: Arc<dyn PasswordPolicyProvider>) -> Self {
    self.password_policy = provider;
    self
  }

  /// Attach a process-local observer for resources owned by live sessions.
  /// The callback is deliberately synchronous and runs only after the
  /// authoritative revocation write has succeeded.
  pub fn with_session_revocation_observer(mut self, observer: Arc<dyn SessionRevocationObserver>) -> Self {
    self.session_revocation_observer = Some(observer);
    self
  }

  pub fn with_session_revocation_effects(mut self, effects: Arc<dyn SessionRevocationEffects>) -> Self {
    self.session_revocation_effects = Some(effects);
    self
  }

  pub async fn current_password_policy(&self) -> AuthResult<PasswordPolicy> {
    self.password_policy.current_policy().await
  }

  pub async fn validate_password(&self, password: &str) -> AuthResult<()> {
    self.current_password_policy().await?.validate(password)
  }

  fn session_cache_key(session_id: Uuid) -> String {
    format!("auth:session_snapshot:{session_id}")
  }

  fn user_session_epoch_key(user_id: Uuid) -> String {
    format!("auth:user_session_epoch:{user_id}")
  }

  async fn load_user_session_epoch(&self, user_id: Uuid) -> Result<Option<String>, ()> {
    let Some(cache) = &self.session_cache else {
      return Ok(None);
    };
    let key = Self::user_session_epoch_key(user_id);
    cache.redis.get_string(&key).await.map_err(|_| {
      warn!(%user_id, "failed to read user session cache epoch");
    })
  }

  fn session_epoch_blocks_auth(epoch: &Option<String>) -> bool {
    epoch.as_deref().is_some_and(|value| value.starts_with("blocked:"))
  }

  /// Claim/release the per-user epoch atomically around a credential mutation.
  /// A blocked epoch is never overwritten, and only its owner can activate it. The
  /// pre-commit state blocks cache authentication outright; the active state
  /// enables snapshots created after the transaction. Epochs expire with the
  /// cache horizon so an interrupted post-commit Redis write cannot leave an
  /// account permanently blocked.
  async fn rotate_user_session_epoch(
    &self,
    user_id: Uuid,
    state: SessionEpochState,
    owned_epoch: Option<&str>,
  ) -> AuthResult<Option<String>> {
    let Some(cache) = &self.session_cache else {
      return Ok(None);
    };
    let key = Self::user_session_epoch_key(user_id);
    let state_name = match state {
      SessionEpochState::Blocked => "blocked",
      SessionEpochState::Active => "active",
    };
    let epoch = format!("{state_name}:{}", Uuid::new_v4());
    let expected = match state {
      SessionEpochState::Blocked => {
        let current = self
          .load_user_session_epoch(user_id)
          .await
          .map_err(|_| AuthError::Storage("session cache invalidation unavailable".into()))?;
        if Self::session_epoch_blocks_auth(&current) {
          return Err(AuthError::Storage(
            "session cache invalidation already in progress".into(),
          ));
        }
        current
      }
      SessionEpochState::Active => Some(
        owned_epoch
          .ok_or_else(|| AuthError::Storage("session cache epoch ownership lost".into()))?
          .to_owned(),
      ),
    };
    for attempt in 1..=3 {
      match cache
        .redis
        .compare_and_set(&key, expected.as_deref(), &epoch, cache.ttl_seconds)
        .await
      {
        Ok(true) => return Ok(Some(epoch)),
        Ok(false) => return Err(AuthError::Storage("session cache epoch changed concurrently".into())),
        Err(_) => warn!(%user_id, attempt, state = state_name, "failed to rotate user session cache epoch"),
      }
    }
    error!(%user_id, state = state_name, "user session cache epoch rotation exhausted retries");
    Err(AuthError::Storage("session cache invalidation unavailable".to_string()))
  }

  fn cache_ttl_for_snapshot(cache_ttl_seconds: u64, snapshot: &SessionSnapshot) -> Option<u64> {
    let remaining_seconds = (snapshot.session.expires_at - Utc::now()).num_seconds();
    if remaining_seconds <= 0 {
      return None;
    }
    Some(cache_ttl_seconds.min(remaining_seconds as u64).max(1))
  }

  #[instrument(skip(self))]
  async fn invalidate_session_cache(&self, session_id: Uuid) {
    let Some(cache) = &self.session_cache else {
      return;
    };
    let key = Self::session_cache_key(session_id);
    if let Err(error) = cache.redis.delete_key(&key).await {
      warn!(%session_id, %key, error = %error, "failed to invalidate cached session snapshot");
    } else {
      trace!(%session_id, %key, "invalidated cached session snapshot");
    }
  }

  async fn begin_global_session_revoke(&self, user_id: Uuid) -> AuthResult<Option<String>> {
    self
      .rotate_user_session_epoch(user_id, SessionEpochState::Blocked, None)
      .await
  }

  async fn rollback_global_session_revoke(&self, user_id: Uuid, epoch: Option<&str>) -> AuthResult<()> {
    self
      .rotate_user_session_epoch(user_id, SessionEpochState::Active, epoch)
      .await
      .map(|_| ())
  }

  /// A role refresh shares the epoch/cache boundary with revocation, but must
  /// never notify credential-revocation observers for still-valid credentials.
  async fn refresh_user_session_snapshots(&self, user_id: Uuid, session_ids: &[Uuid], epoch: Option<&str>) -> bool {
    let activated = self
      .rotate_user_session_epoch(user_id, SessionEpochState::Active, epoch)
      .await
      .is_ok();
    for session_id in session_ids {
      self.invalidate_session_cache(*session_id).await;
    }
    activated
  }

  async fn finish_global_session_revoke(&self, user_id: Uuid, revoked_session_ids: Vec<Uuid>, epoch: Option<&str>) {
    let activated = self
      .refresh_user_session_snapshots(user_id, &revoked_session_ids, epoch)
      .await;
    if let Some(observer) = &self.session_revocation_observer {
      observer.user_sessions_revoked(user_id, &revoked_session_ids);
    }
    if let Some(effects) = &self.session_revocation_effects {
      effects.user_sessions_revoked(user_id).await;
    }
    if !activated {
      // The database transaction is authoritative. The blocked pre-commit
      // epoch remains fail-closed until the cache horizon expires.
      error!(%user_id, "credential mutation committed while the session cache remains fail-closed");
    }
  }

  #[instrument(skip(self))]
  async fn load_cached_session_snapshot(&self, session_id: Uuid) -> Option<SessionSnapshot> {
    let Some(cache) = &self.session_cache else {
      return None;
    };
    let key = Self::session_cache_key(session_id);
    let value = match cache.redis.get_string(&key).await {
      Ok(value) => value,
      Err(error) => {
        warn!(%session_id, %key, error = %error, "failed to read cached session snapshot");
        return None;
      }
    }?;
    let (snapshot, cached_epoch) = match serde_json::from_str::<CachedSessionSnapshot>(&value) {
      Ok(envelope) => (envelope.snapshot, envelope.user_epoch),
      Err(_) => match serde_json::from_str::<SessionSnapshot>(&value) {
        // Existing deployments can consume their old cache shape until a
        // user epoch is established. The first global revoke invalidates it.
        Ok(snapshot) => (snapshot, None),
        Err(error) => {
          warn!(%session_id, %key, error = %error, "invalid cached session snapshot payload");
          self.invalidate_session_cache(session_id).await;
          return None;
        }
      },
    };
    if snapshot.user.disabled {
      trace!(user_id = %snapshot.user.id, %session_id, "cached session snapshot belongs to a disabled user");
      self.invalidate_session_cache(session_id).await;
      return None;
    }
    // Verification changes the account while retaining the browser session.
    // Reload unverified identities until confirmation is visible; rotating a
    // credential-revocation epoch here could release a concurrent revoke fence.
    if snapshot.user.email_verified_at.is_none() {
      self.invalidate_session_cache(session_id).await;
      return None;
    }
    let current_epoch = self.load_user_session_epoch(snapshot.user.id).await.ok()?;
    if Self::session_epoch_blocks_auth(&current_epoch) {
      trace!(%session_id, "user session epoch blocks cache authentication");
      self.invalidate_session_cache(session_id).await;
      return None;
    }
    if cached_epoch != current_epoch {
      trace!(%session_id, "cached session snapshot has a stale user epoch");
      self.invalidate_session_cache(session_id).await;
      return None;
    }
    if snapshot.session.revoked_at.is_some() || snapshot.session.expires_at <= Utc::now() {
      trace!(%session_id, %key, "cached session snapshot is stale");
      self.invalidate_session_cache(session_id).await;
      return None;
    }
    debug!(%session_id, %key, "session cache hit");
    Some(snapshot)
  }

  #[instrument(skip(self, snapshot))]
  async fn store_session_snapshot_cache(
    &self,
    session_id: Uuid,
    snapshot: &SessionSnapshot,
    user_epoch: Option<String>,
  ) {
    let Some(cache) = &self.session_cache else {
      return;
    };
    let Some(ttl_seconds) = Self::cache_ttl_for_snapshot(cache.ttl_seconds, snapshot) else {
      self.invalidate_session_cache(session_id).await;
      return;
    };
    let key = Self::session_cache_key(session_id);
    let value = match serde_json::to_string(&CachedSessionSnapshot {
      snapshot: snapshot.clone(),
      user_epoch,
    }) {
      Ok(value) => value,
      Err(error) => {
        warn!(%session_id, %key, error = %error, "failed to encode session snapshot for cache");
        return;
      }
    };
    if let Err(error) = cache.redis.set_string(&key, &value, Some(ttl_seconds)).await {
      warn!(%session_id, %key, ttl_seconds, error = %error, "failed to store session snapshot cache");
    } else {
      trace!(%session_id, %key, ttl_seconds, "stored session snapshot cache");
    }
  }

  /// Check whether an account exists for `email` and whether it has a password.
  ///
  /// Called before the sign-in form is shown to decide which credential input
  /// fields to render.
  #[instrument(skip(self))]
  pub async fn preflight(&self, email: &str) -> AuthResult<PreflightResult> {
    trace!(email, "running sign-in preflight");
    validate_email(email)?;

    let user = self.store.get_user_by_email(email).await?;
    let result = match user {
      Some(user) => PreflightResult {
        registered: user.registered,
        has_password: user.password_hash.is_some(),
      },
      None => PreflightResult {
        registered: false,
        has_password: false,
      },
    };
    debug!(
      email,
      registered = result.registered,
      has_password = result.has_password,
      "preflight result resolved"
    );
    Ok(result)
  }

  /// Attempt to sign in with the given credentials.
  ///
  /// If `password` is `Some`, password authentication is attempted.  If the
  /// password is missing, a magic-link flow is initiated instead.
  #[instrument(skip(self, password, context))]
  pub async fn sign_in(
    &self,
    email: &str,
    password: Option<&str>,
    context: SessionContext,
  ) -> AuthResult<SignInResult> {
    info!(email, "handling sign-in attempt");
    validate_email(email)?;

    if let Some(password) = password {
      return self.password_sign_in(email, password, context).await;
    }

    info!(email, "password missing, switching to magic-link flow");
    Ok(SignInResult::MagicLinkRequested {
      email: email.to_owned(),
    })
  }

  /// Resolve the durable root of a browser session group.
  pub async fn session_group_root(&self, session_id: Uuid) -> AuthResult<Option<Uuid>> {
    self.store.get_session_group_root(session_id).await
  }

  /// Resolve one explicit user feature override.
  pub async fn user_feature_override(&self, user_id: Uuid, feature_name: &str) -> AuthResult<Option<bool>> {
    self.store.get_user_feature_override(user_id, feature_name).await
  }

  /// Resolve one explicit feature override for several users.
  pub async fn user_feature_overrides(&self, user_ids: &[Uuid], feature_name: &str) -> AuthResult<HashMap<Uuid, bool>> {
    self.store.get_user_feature_overrides(user_ids, feature_name).await
  }

  /// Persist an explicit feature override.
  pub async fn set_user_feature_override(
    &self,
    user_id: Uuid,
    feature_name: &str,
    activated: bool,
    reason: &str,
  ) -> AuthResult<()> {
    self
      .store
      .set_user_feature_override(user_id, feature_name, activated, reason)
      .await
  }

  /// Return the timestamp of the user's newest session.
  pub async fn last_login_at(&self, user_id: Uuid) -> AuthResult<Option<DateTime<Utc>>> {
    self.store.last_login_at(user_id).await
  }

  /// Persist one browser session-group membership.
  pub async fn upsert_session_group_link(&self, link: SessionGroupLink) -> AuthResult<()> {
    self.store.upsert_session_group_link(link).await
  }

  /// Remove one browser session from its group.
  pub async fn delete_session_group_link(&self, session_id: Uuid) -> AuthResult<()> {
    self.store.delete_session_group_link(session_id).await
  }

  /// List session IDs in a group in oldest-first order.
  pub async fn list_session_group_sessions(&self, root_session_id: Uuid) -> AuthResult<Vec<Uuid>> {
    self.store.list_session_group_sessions(root_session_id).await
  }

  /// List distinct users in a group in first-linked order.
  pub async fn list_session_group_users(&self, root_session_id: Uuid) -> AuthResult<Vec<Uuid>> {
    self.store.list_session_group_users(root_session_id).await
  }

  /// Find the newest group session owned by one user.
  pub async fn find_session_group_session_for_user(
    &self,
    root_session_id: Uuid,
    user_id: Uuid,
  ) -> AuthResult<Option<Uuid>> {
    self
      .store
      .find_session_group_session_for_user(root_session_id, user_id)
      .await
  }

  /// Revoke a captured set atomically. Cache failures before the commit abort;
  /// failures after it retain committed revocations and the fail-closed epoch.
  #[instrument(skip_all)]
  pub async fn revoke_sessions(&self, target: SessionRevocationTarget) -> AuthResult<SessionRevocationCommit> {
    let commit = self.store.commit_session_revocation(&target, Utc::now(), self).await?;
    for guard in &commit.epochs {
      let user = guard.user_id;
      let epoch = guard.epoch.as_deref();
      let sessions: Vec<Uuid> = commit
        .sessions
        .iter()
        .filter(|(_, owner)| *owner == user)
        .map(|(id, _)| *id)
        .collect();
      if let SessionRevocationTarget::Session(id) = &target {
        if !self.refresh_user_session_snapshots(user, &sessions, epoch).await {
          error!(%user, "session revoke committed while authentication remains fail-closed");
        }
        if let Some(observer) = &self.session_revocation_observer {
          observer.session_revoked(*id);
        }
        if let Some(effects) = &self.session_revocation_effects {
          effects.session_revoked(*id).await;
        }
      } else {
        self.finish_global_session_revoke(user, sessions, epoch).await;
      }
    }
    Ok(commit)
  }

  /// Sign-out uses the same commit/cache fence as trusted session administration.
  #[instrument(skip(self))]
  pub async fn sign_out(&self, session_id: Uuid) -> AuthResult<()> {
    self
      .revoke_sessions(SessionRevocationTarget::Session(session_id))
      .await?;
    Ok(())
  }

  /// Load the full session snapshot (user + session) for the given session ID.
  ///
  /// Returns `None` if the session does not exist, is expired, or has been
  /// revoked.  Caches the result in Redis when a session cache is configured.
  #[instrument(skip(self))]
  pub async fn get_session_snapshot(&self, session_id: Uuid) -> AuthResult<Option<SessionSnapshot>> {
    trace!(%session_id, "loading session snapshot");
    if let Some(cached) = self.load_cached_session_snapshot(session_id).await {
      return Ok(Some(cached));
    }

    let Some(mut session) = self.store.get_session(session_id).await? else {
      debug!(%session_id, "session not found");
      return Ok(None);
    };

    // A global reset rotates the user epoch around its database transaction.
    // On a cache miss, capture that epoch and then reload the session: this
    // closes the race where the first DB read completed before the revoke but
    // the cache write happened after it. A second epoch read below makes the
    // snapshot linearizable with either side of the reset operation; a final
    // check below also fences a cache write crossing the commit.
    let guarded_epoch: Option<Option<String>> = if self.session_cache.is_some() {
      match self.load_user_session_epoch(session.user_id).await {
        Ok(epoch) if Self::session_epoch_blocks_auth(&epoch) => return Ok(None),
        Ok(epoch) => {
          let Some(reloaded) = self.store.get_session(session_id).await? else {
            return Ok(None);
          };
          session = reloaded;
          Some(epoch)
        }
        // Once Redis-backed epochs participate in global revocation they are
        // a security barrier, not merely a performance cache. Returning the
        // first DB read here could authenticate a session read immediately
        // before a concurrent password-reset commit.
        Err(()) => return Ok(None),
      }
    } else {
      None
    };

    if session.revoked_at.is_some() {
      debug!(%session_id, "session revoked");
      return Ok(None);
    }

    if session.expires_at <= Utc::now() {
      debug!(%session_id, "session expired");
      return Ok(None);
    }

    let Some(user) = self.store.get_user_by_id(session.user_id).await? else {
      warn!(user_id = %session.user_id, %session_id, "user for session not found");
      return Ok(None);
    };

    if user.disabled {
      debug!(user_id = %user.id, %session_id, "session user is disabled");
      self.invalidate_session_cache(session_id).await;
      return Ok(None);
    }

    let snapshot = SessionSnapshot { user, session };
    if let Some(epoch_before) = guarded_epoch {
      let epoch_after = match self.load_user_session_epoch(snapshot.user.id).await {
        Ok(epoch) => epoch,
        Err(()) => return Ok(None),
      };
      if Self::session_epoch_blocks_auth(&epoch_after) {
        return Ok(None);
      }
      if epoch_before != epoch_after {
        trace!(%session_id, "user session epoch changed during snapshot load");
        return Ok(None);
      }
      self
        .store_session_snapshot_cache(session_id, &snapshot, epoch_after.clone())
        .await;
      // A cache write can complete after the role/deletion transaction and its
      // eviction. Recheck before accepting that fill, then remove its stale
      // envelope; the next request must reload the committed identity.
      match self.load_user_session_epoch(snapshot.user.id).await {
        Ok(epoch) if epoch == epoch_after && !Self::session_epoch_blocks_auth(&epoch) => {}
        _ => {
          self.invalidate_session_cache(session_id).await;
          return Ok(None);
        }
      }
    }
    Ok(Some(snapshot))
  }

  /// Extend the session's expiry if `refresh_after` has passed.
  ///
  /// Returns the (possibly refreshed) snapshot, or `None` if the session is
  /// no longer valid.
  #[instrument(skip(self))]
  pub async fn refresh_session_if_needed(&self, session_id: Uuid) -> AuthResult<Option<SessionSnapshot>> {
    let Some(snapshot) = self.get_session_snapshot(session_id).await? else {
      return Ok(None);
    };

    if snapshot.session.refresh_after > Utc::now() {
      trace!(%session_id, "session refresh not needed yet");
      return Ok(Some(snapshot));
    }

    info!(%session_id, "refreshing session");
    let now = Utc::now();
    let expires_at = now + Duration::seconds(self.session_ttl_seconds.max(60));
    let refresh_after = now + Duration::seconds(self.session_ttr_seconds.max(30));
    self.invalidate_session_cache(session_id).await;

    self
      .store
      .refresh_session(session_id, expires_at, refresh_after)
      .await?;

    // Return updated snapshot
    self.get_session_snapshot(session_id).await
  }

  /// Create a new authenticated session for `user_id`.
  #[instrument(skip(self, context))]
  pub async fn create_user_session(&self, user_id: Uuid, context: SessionContext) -> AuthResult<AuthSession> {
    info!(%user_id, "creating new session");
    let now = Utc::now();
    let expires_at = now + Duration::seconds(self.session_ttl_seconds.max(60));
    let refresh_after = now + Duration::seconds(self.session_ttr_seconds.max(30));
    self
      .store
      .create_session(NewSession {
        id: Uuid::new_v4(),
        user_id,
        csrf_token: Uuid::new_v4().to_string(),
        user_agent: context.user_agent,
        ip_address: context.ip_address,
        expires_at,
        refresh_after,
        created_at: now,
      })
      .await
  }

  /// Commit an Admin-role change while retaining all credentials. Epochs
  /// fence concurrent fills before/after the transaction. Post-commit cache
  /// failure keeps authentication blocked without misreporting a rollback.
  #[instrument(skip(self), fields(user_id = %user_id))]
  pub async fn set_user_admin_role(&self, user_id: Uuid, is_admin: bool) -> AuthResult<UserAdminRoleCommit> {
    let epoch = self.begin_global_session_revoke(user_id).await?;
    let commit = match self.store.commit_user_admin_role(user_id, is_admin).await {
      Ok(commit) => commit,
      Err(error) => {
        if self
          .rollback_global_session_revoke(user_id, epoch.as_deref())
          .await
          .is_err()
        {
          error!(%user_id, "failed to restore session epoch after role rollback");
        }
        return Err(error);
      }
    };
    if commit.user_id != user_id || commit.is_admin != is_admin {
      for session in &commit.session_ids {
        self.invalidate_session_cache(*session).await;
      }
      return Err(AuthError::Storage("Admin role commit mismatch".into()));
    }
    if !self
      .refresh_user_session_snapshots(user_id, &commit.session_ids, epoch.as_deref())
      .await
    {
      error!(%user_id, "Admin role committed while authentication remains fail-closed");
    }
    Ok(commit)
  }

  /// Suspend a user and revoke every session and MCP API key atomically.
  ///
  /// The Redis epoch is placed in a fail-closed state before the database
  /// transaction starts. A failed transaction rolls that barrier back; a
  /// committed transaction keeps the barrier active if post-commit Redis
  /// activation fails. The database commit remains authoritative.
  #[instrument(skip(self), fields(user_id = %user_id))]
  pub async fn suspend_user(&self, user_id: Uuid, changed_at: DateTime<Utc>) -> AuthResult<UserSuspensionCommit> {
    let epoch = self.begin_global_session_revoke(user_id).await?;
    let commit = match self.store.commit_user_suspension(user_id, changed_at).await {
      Ok(commit) => commit,
      Err(error) => {
        if let Err(rollback_error) = self.rollback_global_session_revoke(user_id, epoch.as_deref()).await {
          error!(%user_id, %rollback_error, "failed to restore session epoch after suspension rollback");
        }
        return Err(error);
      }
    };

    if commit.user.id != user_id || !commit.user.disabled {
      error!(
        %user_id,
        committed_user_id = %commit.user.id,
        committed_disabled = commit.user.disabled,
        "suspension store returned an invalid commit"
      );
      // The database transaction has already committed, but its returned
      // projection is not trustworthy. Keep the pre-commit epoch blocked and
      // only remove cache entries whose identifiers are still known.
      for session_id in commit.revoked_session_ids {
        self.invalidate_session_cache(session_id).await;
      }
      return Err(AuthError::Storage("user suspension commit mismatch".to_string()));
    }

    self
      .finish_global_session_revoke(user_id, commit.revoked_session_ids.clone(), epoch.as_deref())
      .await;
    info!(
      %user_id,
      revoked_sessions = commit.revoked_session_ids.len(),
      deleted_api_keys = commit.deleted_api_key_ids.len(),
      "user suspended and credentials revoked"
    );
    Ok(commit)
  }

  /// Change a verified account's email and revoke its existing sessions in one
  /// store commit. Publication/cache failures after commit remain fail-closed.
  #[instrument(skip_all)]
  pub async fn change_email(&self, user_id: Uuid, token: &str, email: &str) -> AuthResult<AuthUser> {
    let decoded = urlencoding::decode(email)
      .map(|s| s.into_owned())
      .unwrap_or_else(|_| email.to_string());
    let commit = self
      .store
      .commit_email_change(user_id, token, &decoded, Utc::now(), self)
      .await?;
    let epoch = commit
      .epochs
      .iter()
      .find(|e| e.user_id == user_id)
      .and_then(|e| e.epoch.as_deref());
    self
      .finish_global_session_revoke(user_id, commit.revoked_session_ids, epoch)
      .await;
    Ok(commit.user)
  }

  /// Validate a `ChangePassword` token and update the user's password hash.
  ///
  /// On success all existing sessions for the user are revoked.
  /// The user_id is extracted from the token record itself (API-C-01),
  /// not from any client-supplied parameter.
  #[instrument(skip(self, token, new_password))]
  pub async fn change_password(&self, token: &str, new_password: &str) -> AuthResult<()> {
    info!("changing password via verification token");
    self.validate_password(new_password).await?;
    let Some(verification_token) = self
      .store
      .find_verification_token("ChangePassword", token, None)
      .await?
    else {
      warn!("invalid or missing change-password token");
      return Err(AuthError::InvalidToken);
    };

    let Some(user_id) = verification_token.user_id else {
      warn!("change-password token has no associated user_id");
      return Err(AuthError::InvalidToken);
    };

    if verification_token.used_at.is_some() {
      warn!(%user_id, "change-password token already used");
      return Err(AuthError::InvalidToken);
    }

    if verification_token.expires_at <= Utc::now() {
      warn!(%user_id, "change-password token expired");
      return Err(AuthError::ExpiredToken);
    }

    let hash = hash_password(new_password)?;
    // Epoch A makes every snapshot created before this operation stale. The
    // post-commit rotation below catches a snapshot loaded concurrently from
    // the database while the transaction is in flight.
    let epoch = self.begin_global_session_revoke(user_id).await?;
    let commit = match self.store.commit_password_reset(token, hash, Utc::now()).await {
      Ok(commit) => commit,
      Err(error) => {
        self.rollback_global_session_revoke(user_id, epoch.as_deref()).await?;
        return Err(error);
      }
    };
    if commit.user_id != user_id {
      error!(%user_id, committed_user_id = %commit.user_id, "password reset store returned a mismatched user");
      return Err(AuthError::Storage("password reset commit mismatch".to_string()));
    }
    self
      .finish_global_session_revoke(user_id, commit.revoked_session_ids, epoch.as_deref())
      .await;

    info!(%user_id, "password changed successfully");
    Ok(())
  }

  /// Set a password through an administrative ingress while enforcing the
  /// effective policy and atomically revoking all existing sessions.
  #[instrument(skip(self, new_password), fields(user_id = %user_id))]
  pub async fn set_user_password(&self, user_id: Uuid, new_password: &str) -> AuthResult<()> {
    self.validate_password(new_password).await?;
    let hash = hash_password(new_password)?;
    let epoch = self.begin_global_session_revoke(user_id).await?;
    let commit = match self.store.commit_password_update(user_id, hash, Utc::now()).await {
      Ok(commit) => commit,
      Err(error) => {
        self.rollback_global_session_revoke(user_id, epoch.as_deref()).await?;
        return Err(error);
      }
    };
    if commit.user_id != user_id {
      error!(%user_id, committed_user_id = %commit.user_id, "password update store returned a mismatched user");
      return Err(AuthError::Storage("password update commit mismatch".to_string()));
    }
    self
      .finish_global_session_revoke(user_id, commit.revoked_session_ids, epoch.as_deref())
      .await;
    info!(%user_id, "user password updated and sessions revoked");
    Ok(())
  }

  /// Create a canonical one-time password-reset link for a user.
  #[instrument(skip_all, fields(user_id = %user_id))]
  pub async fn create_password_reset_link(
    &self,
    user_id: Uuid,
    server_origin: &str,
    callback_path: Option<&str>,
  ) -> AuthResult<PasswordResetLink> {
    self
      .password_reset_links
      .create_link(user_id, server_origin, callback_path)
      .await
  }

  /// Verify the user's email address using a `VerifyEmail` token.
  #[instrument(skip(self, token))]
  pub async fn verify_email(&self, user_id: Uuid, token: &str) -> AuthResult<()> {
    info!(%user_id, "verifying user email");
    let Some(verification_token) = self
      .store
      .find_verification_token("VerifyEmail", token, Some(user_id))
      .await?
    else {
      warn!(%user_id, "invalid or missing verify-email token");
      return Err(AuthError::InvalidToken);
    };

    if verification_token.used_at.is_some() {
      warn!(%user_id, "verify-email token already used");
      return Err(AuthError::InvalidToken);
    }

    if verification_token.expires_at <= Utc::now() {
      warn!(%user_id, "verify-email token expired");
      return Err(AuthError::ExpiredToken);
    }

    self.store.set_email_verified(user_id, Utc::now()).await?;
    self.store.consume_verification_token(token, Utc::now()).await?;

    info!(%user_id, "email verified successfully");
    Ok(())
  }

  /// Generate a new personal access token for `user_id`.
  ///
  /// Returns a tuple of the persisted [`AccessToken`] record and the raw
  /// plaintext token string (shown only once to the user).
  #[instrument(skip(self))]
  pub async fn create_access_token(
    &self,
    user_id: Uuid,
    name: String,
    expires_at: Option<DateTime<Utc>>,
  ) -> AuthResult<(AccessToken, String)> {
    info!(%user_id, token_name = %name, "creating user access token");
    use sha2::{Digest, Sha256};
    let raw_token = format!("ut_{}", Uuid::new_v4().simple());
    let mut hasher = Sha256::new();
    hasher.update(raw_token.as_bytes());
    let token_hash = hex::encode(hasher.finalize());

    let token = self
      .store
      .create_access_token(NewAccessToken {
        user_id,
        name,
        token_hash,
        expires_at,
      })
      .await?;

    Ok((token, raw_token))
  }

  #[instrument(skip(self))]
  pub async fn list_access_tokens(&self, user_id: Uuid) -> AuthResult<Vec<AccessToken>> {
    trace!(%user_id, "listing user access tokens");
    self.store.list_access_tokens(user_id).await
  }

  #[instrument(skip(self))]
  pub async fn revoke_access_token(&self, id: Uuid, user_id: Uuid) -> AuthResult<()> {
    info!(token_id = %id, %user_id, "revoking user access token");
    self.store.revoke_access_token(id, user_id).await
  }

  #[instrument(skip(self))]
  pub async fn get_user_preferences(&self, user_id: Uuid) -> AuthResult<UserPreferencesRecord> {
    trace!(%user_id, "reading user preferences");
    self.store.get_user_preferences(user_id).await
  }

  /// Acknowledge the accepted Workspace choice once, atomically with its scoped
  /// preference patch. Replaying a completed receipt never rewrites preferences.
  #[instrument(skip_all)]
  pub async fn acknowledge_workspace_starter_assistance(&self, actor: Uuid, request_id: Uuid) -> AuthResult<()> {
    self
      .store
      .acknowledge_workspace_starter_assistance(actor, request_id)
      .await
  }

  #[instrument(skip_all)]
  pub async fn get_assistance(
    &self,
    user_id: Uuid,
    workspace_id: Option<Uuid>,
    project_id: Option<Uuid>,
  ) -> AuthResult<EffectiveAssistance> {
    if project_id.is_some() && workspace_id.is_none() {
      return Err(AuthError::InvalidInput(
        "project assistance requires a workspace".into(),
      ));
    }
    self.store.get_assistance(user_id, workspace_id, project_id).await
  }

  #[instrument(skip(self))]
  pub async fn patch_user_preferences(
    &self,
    user_id: Uuid,
    patch: UserPreferencesPatch,
  ) -> AuthResult<UserPreferencesRecord> {
    info!(%user_id, "updating user preferences");
    self.store.patch_user_preferences(user_id, patch).await
  }

  /// Look up a user by email with ACL enforcement.
  ///
  /// Returns `None` if the target user does not exist **or** if the requesting
  /// user (`current_user_id`) does not share a workspace with them.
  #[instrument(skip(self))]
  pub async fn get_user_by_email(&self, email: &str, current_user_id: Uuid) -> AuthResult<Option<AuthUser>> {
    trace!(email, requester_id = %current_user_id, "resolving user by email with ACL");
    let Some(user) = self.store.get_user_by_email(email).await? else {
      return Ok(None);
    };

    if user.id == current_user_id {
      return Ok(Some(user));
    }

    if self.store.has_shared_workspace(current_user_id, user.id).await? {
      debug!(requester_id = %current_user_id, target_user_id = %user.id, "shared workspace found");
      return Ok(Some(user));
    }

    warn!(requester_id = %current_user_id, target_user_id = %user.id, email, "user-by-email access denied");
    Ok(None)
  }

  #[instrument(skip(self))]
  pub async fn get_user_by_id(&self, user_id: Uuid) -> AuthResult<Option<AuthUser>> {
    trace!(%user_id, "resolving user by id");
    self.store.get_user_by_id(user_id).await
  }

  /// Resolve several user profiles in one repository read.
  pub async fn get_historical_profile(&self, id: Uuid) -> AuthResult<Option<HistoricalUserProfile>> {
    self.store.get_historical_profile(id).await
  }
  pub async fn get_historical_profiles(&self, ids: &[Uuid]) -> AuthResult<HashMap<Uuid, HistoricalUserProfile>> {
    self.store.get_historical_profiles(ids).await
  }

  pub async fn get_users_by_ids(&self, user_ids: &[Uuid]) -> AuthResult<HashMap<Uuid, AuthUser>> {
    self.store.get_users_by_ids(user_ids).await
  }

  /// Persist an OAuth CSRF state token with arbitrary `extra` payload and
  /// return the raw token string.
  #[instrument(skip(self, extra))]
  pub async fn save_oauth_state(&self, kind: &str, extra: serde_json::Value) -> AuthResult<String> {
    debug!(kind, "saving oauth state");
    let token = Uuid::new_v4().to_string();
    self
      .store
      .create_verification_token(None, kind, &token, None, Utc::now() + Duration::hours(3), Some(extra))
      .await?;
    Ok(token)
  }

  /// Retrieve an OAuth state token without consuming it.
  ///
  /// Returns `None` if the token does not exist, has expired, or has been
  /// consumed.
  #[instrument(skip(self, token))]
  pub async fn get_oauth_state(&self, kind: &str, token: &str) -> AuthResult<Option<VerificationToken>> {
    trace!(kind, "resolving oauth state");
    let Some(vt) = self.store.get_verification_token(token).await? else {
      return Ok(None);
    };
    if vt.kind != kind || vt.used_at.is_some() || vt.expires_at <= Utc::now() {
      debug!(kind, "oauth state token invalid, used or expired");
      return Ok(None);
    }
    Ok(Some(vt))
  }

  /// Mark an OAuth state token as consumed.
  #[instrument(skip(self, token))]
  pub async fn consume_oauth_state(&self, token: &str) -> AuthResult<()> {
    debug!("consuming oauth state token");
    self.store.consume_verification_token(token, Utc::now()).await
  }

  /// Apply a partial profile update to a user and return the updated record.
  #[instrument(skip(self, update))]
  pub async fn update_profile(&self, user_id: Uuid, update: UpdateAuthUser) -> AuthResult<AuthUser> {
    info!(%user_id, "updating user profile");
    self.store.update_user(user_id, update).await
  }

  /// Preserve the existing self-service response contract through the same
  /// deletion commit used by the administrative owner.
  #[instrument(skip(self))]
  pub async fn delete_account(&self, user_id: Uuid) -> AuthResult<()> {
    self.delete_account_with_commit(user_id).await.map(|_| ())
  }

  /// Fence authentication before permanent account deletion. Rollback restores the epoch;
  /// a known commit evicts captured snapshots and notifies revocation even
  /// if Redis activation fails. No post-cascade credential reread is needed.
  #[instrument(skip(self), fields(user_id = %user_id))]
  pub async fn delete_account_with_commit(&self, user_id: Uuid) -> AuthResult<UserDeletionCommit> {
    let epoch = self.begin_global_session_revoke(user_id).await?;
    let commit = match self.store.commit_user_deletion(user_id).await {
      Ok(commit) => commit,
      Err(error) => {
        if self
          .rollback_global_session_revoke(user_id, epoch.as_deref())
          .await
          .is_err()
        {
          error!(%user_id, "failed to restore session epoch after deletion rollback");
        }
        return Err(error);
      }
    };
    if commit.user.id != user_id {
      for session in &commit.revoked_session_ids {
        self.invalidate_session_cache(*session).await;
      }
      return Err(AuthError::Storage("account deletion commit mismatch".into()));
    }
    self
      .finish_global_session_revoke(user_id, commit.revoked_session_ids.clone(), epoch.as_deref())
      .await;
    Ok(commit)
  }

  /// Upload a new avatar image, replacing any existing one.
  ///
  /// The image bytes are stored via the blob storage port and the user's
  /// `avatar_url` field is updated to point to the new URL.
  #[instrument(skip(self, data))]
  pub async fn upload_avatar(&self, user_id: Uuid, data: bytes::Bytes, content_type: &str) -> AuthResult<AuthUser> {
    info!(%user_id, content_type, "uploading avatar");
    let user = self.store.get_user_by_id(user_id).await?.ok_or_else(|| {
      error!(%user_id, "user not found during avatar upload");
      AuthError::Storage("User not found".into())
    })?;

    let key = format!("{}-avatar-{}", user_id, Utc::now().timestamp_millis());
    let avatar_url = self.storage.put_avatar(&key, data, content_type).await.map_err(|e| {
      error!(%user_id, error = %e, "failed to store avatar");
      AuthError::Storage(e.to_string())
    })?;

    if let Some(old_avatar) = &user.avatar_url {
      debug!(%user_id, old_avatar, "deleting old avatar");
      self.storage.delete_avatar(old_avatar).await.ok();
    }

    self
      .store
      .update_user(
        user_id,
        UpdateAuthUser {
          avatar_url: Some(Some(avatar_url)),
          ..Default::default()
        },
      )
      .await
  }

  /// Remove the user's avatar image from storage and clear the URL field.
  #[instrument(skip(self))]
  pub async fn remove_avatar(&self, user_id: Uuid) -> AuthResult<()> {
    info!(%user_id, "removing avatar");
    let user = self.store.get_user_by_id(user_id).await?.ok_or_else(|| {
      error!(%user_id, "user not found during avatar removal");
      AuthError::Storage("User not found".into())
    })?;

    if let Some(old_avatar) = &user.avatar_url {
      debug!(%user_id, old_avatar, "deleting avatar from storage");
      self.storage.delete_avatar(old_avatar).await.ok();
    }

    self
      .store
      .update_user(
        user_id,
        UpdateAuthUser {
          avatar_url: Some(None),
          ..Default::default()
        },
      )
      .await?;
    Ok(())
  }

  async fn password_sign_in(&self, email: &str, password: &str, context: SessionContext) -> AuthResult<SignInResult> {
    debug!(email, "attempting password sign-in");
    let Some(user) = self.store.get_user_by_email(email).await? else {
      warn!(email, "sign-in failed: user not found");
      return Err(AuthError::WrongSignInCredentials);
    };

    if user.disabled {
      warn!(email, "sign-in failed: user disabled");
      return Err(AuthError::WrongSignInCredentials);
    }

    let Some(password_hash) = user.password_hash.as_deref() else {
      warn!(email, "sign-in failed: password missing");
      return Err(AuthError::WrongSignInCredentials);
    };

    if !verify_password_hash(password_hash, password) {
      warn!(email, "sign-in failed: wrong password");
      return Err(AuthError::WrongSignInCredentials);
    }

    let session = self.create_user_session(user.id, context).await?;
    info!(user_id = %user.id, email = %user.email, "password sign-in succeeded");

    Ok(SignInResult::PasswordSignIn {
      user,
      session: Box::new(session),
    })
  }

  /// Generate a 6-digit OTP, store it, and email a magic-link to `email`.
  ///
  /// `callback_url` is the redirect destination embedded in the link.
  /// `client_nonce` must be provided again when consuming the OTP to prevent
  /// replay attacks.
  ///
  /// The `callback_url` is validated by [`validate_magic_link_callback`] before use.
  #[instrument(skip(self, callback_url, client_nonce))]
  pub async fn request_magic_link(
    &self,
    email: &str,
    callback_url: &str,
    client_nonce: Option<String>,
  ) -> AuthResult<()> {
    info!(email, "requesting magic link");
    validate_email(email)?;

    // API-RV-05: Validate callback_url
    validate_magic_link_callback(callback_url)?;

    let user = self.store.get_user_by_email(email).await?;
    let is_signup = user.is_none();

    let ttl_in_sec = self.magic_link_ttl_seconds;
    let vt = self
      .store
      .create_verification_token(
        user.as_ref().map(|user| user.id),
        "SignIn",
        &Uuid::new_v4().to_string(), // internal token
        Some(email),
        Utc::now() + Duration::seconds(ttl_in_sec),
        None,
      )
      .await?;

    // Generate 6-digit OTP
    use rand::Rng;
    let otp = format!("{:06}", rand::thread_rng().gen_range(0..1000000));

    self
      .store
      .upsert_magic_link_otp(MagicLinkOtp {
        email: email.to_string(),
        otp: otp.clone(),
        verification_token_id: vt.id,
        client_nonce: client_nonce.clone(),
        expires_at: Utc::now() + Duration::seconds(ttl_in_sec),
      })
      .await?;

    // In legacy, the link is callback_url?token=OTP&email=EMAIL
    let magic_link = if callback_url.contains('?') {
      format!("{}&token={}&email={}", callback_url, otp, urlencoding::encode(email))
    } else {
      format!("{}?token={}&email={}", callback_url, otp, urlencoding::encode(email))
    };

    debug!(email, "sending magic link");
    let mail = self
      .prepare_mail_for_user(
        user.as_ref().map(|user| user.id),
        email,
        if is_signup {
          MailTemplate::Welcome
        } else {
          MailTemplate::SignIn
        },
        serde_json::json!({"url":magic_link,"otp":otp}),
      )
      .await?;
    self.mailer.send_template(mail).await.map_err(|e| {
      error!(email, error = %e, "failed to send magic link");
      AuthError::Storage(e.to_string())
    })?;

    info!(email, "magic link requested");
    Ok(())
  }

  /// Validate and consume a magic-link OTP, returning the user account.
  ///
  /// Existing-account codes resolve their bound UUID under its lock. Only an
  /// unbound signup code may fulfill by email; old codes never cross recreation.
  #[instrument(skip(self, otp, client_nonce))]
  pub async fn consume_magic_link_otp(
    &self,
    email: &str,
    otp: &str,
    client_nonce: Option<String>,
  ) -> AuthResult<AuthUser> {
    self
      .store
      .consume_magic_link_otp(email, otp, client_nonce.as_deref(), Utc::now())
      .await
  }

  /// Generate a short-lived (`OpenAppSignIn`) code for seamless sign-in to the
  /// desktop / mobile application.
  #[instrument(skip(self))]
  pub async fn request_open_app_sign_in_code(&self, user_id: Uuid) -> AuthResult<String> {
    info!(%user_id, "requesting open-app sign-in code");
    let code = Uuid::new_v4().to_string();
    self
      .store
      .create_verification_token(
        Some(user_id),
        "OpenAppSignIn",
        &code,
        None,
        Utc::now() + Duration::minutes(5),
        None,
      )
      .await?;
    Ok(code)
  }

  /// Validate an open-app code and return the associated user.
  #[instrument(skip(self))]
  pub async fn open_app_sign_in(&self, code: &str) -> AuthResult<AuthUser> {
    debug!("attempting open-app sign-in via code");
    let Some(vt) = self.store.get_verification_token(code).await? else {
      warn!("invalid or missing open-app code");
      return Err(AuthError::InvalidToken);
    };

    if vt.kind != "OpenAppSignIn" || vt.used_at.is_some() || vt.expires_at <= Utc::now() {
      warn!("open-app code invalid, used or expired");
      return Err(AuthError::InvalidToken);
    }

    let Some(user_id) = vt.user_id else {
      error!("open-app code missing user_id");
      return Err(AuthError::InvalidToken);
    };

    let user = self.store.get_user_by_id(user_id).await?.ok_or_else(|| {
      error!(%user_id, "user not found for open-app sign-in");
      AuthError::Storage("User not found".into())
    })?;

    self.store.consume_verification_token(code, Utc::now()).await?;

    info!(user_id = %user.id, email = %user.email, "open-app sign-in succeeded");
    Ok(user)
  }
}

#[cfg(test)]
mod tests {

  use super::*;
  use async_trait::async_trait;
  use bytes::Bytes;
  use std::collections::{HashMap, VecDeque};
  use std::io::Write;
  use std::sync::Mutex as StdMutex;
  use tokio::sync::RwLock as TokioRwLock;

  use crate::ports::{
    BlobReadResponse, BlobStoragePort, MultipartCompleteRequest, MultipartCreateRequest, MultipartCreateResponse,
    MultipartPartUrlRequest, MultipartPartUrlResponse, PortError, PortResult, RedisPort,
  };

  #[derive(Default)]
  struct TestRedis {
    values: TokioRwLock<HashMap<String, String>>,
    scripted_gets: tokio::sync::Mutex<HashMap<String, VecDeque<PortResult<Option<String>>>>>,
    scripted_sets: tokio::sync::Mutex<VecDeque<bool>>,
    paused_set: tokio::sync::Mutex<Option<(String, Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
  }

  impl TestRedis {
    async fn script_gets(&self, key: &str, values: impl IntoIterator<Item = Option<String>>) {
      self
        .scripted_gets
        .lock()
        .await
        .insert(key.to_string(), values.into_iter().map(Ok).collect());
    }

    async fn script_get_results(&self, key: &str, values: impl IntoIterator<Item = PortResult<Option<String>>>) {
      self
        .scripted_gets
        .lock()
        .await
        .insert(key.to_string(), values.into_iter().collect());
    }

    async fn script_sets(&self, succeeds: impl IntoIterator<Item = bool>) {
      self.scripted_sets.lock().await.extend(succeeds);
    }
  }

  #[async_trait]
  impl RedisPort for TestRedis {
    async fn get_string(&self, key: &str) -> PortResult<Option<String>> {
      if let Some(value) = self
        .scripted_gets
        .lock()
        .await
        .get_mut(key)
        .and_then(VecDeque::pop_front)
      {
        return value;
      }
      Ok(self.values.read().await.get(key).cloned())
    }

    async fn set_string(&self, key: &str, value: &str, _ttl_seconds: Option<u64>) -> PortResult<()> {
      let paused = {
        let mut slot = self.paused_set.lock().await;
        if slot.as_ref().is_some_and(|entry| entry.0 == key) {
          slot.take()
        } else {
          None
        }
      };
      if let Some((_, started, resume)) = paused {
        started.notify_one();
        resume.notified().await;
      }
      if self
        .scripted_sets
        .lock()
        .await
        .pop_front()
        .is_some_and(|succeeds| !succeeds)
      {
        return Err(PortError::Transport("scripted Redis set failure".to_string()));
      }
      self.values.write().await.insert(key.to_string(), value.to_string());
      Ok(())
    }

    async fn compare_and_set(
      &self,
      key: &str,
      expected: Option<&str>,
      value: &str,
      _ttl_seconds: u64,
    ) -> PortResult<bool> {
      if self
        .scripted_sets
        .lock()
        .await
        .pop_front()
        .is_some_and(|succeeds| !succeeds)
      {
        return Err(PortError::Transport("scripted Redis set failure".into()));
      }
      let mut values = self.values.write().await;
      if values.get(key).map(String::as_str) != expected {
        return Ok(false);
      }
      values.insert(key.to_string(), value.to_string());
      Ok(true)
    }

    async fn delete_key(&self, key: &str) -> PortResult<()> {
      self.values.write().await.remove(key);
      Ok(())
    }
  }

  #[derive(Clone, Default)]
  struct TestLogWriter(Arc<StdMutex<Vec<u8>>>);

  impl Write for TestLogWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
      self.0.lock().expect("test log lock").extend_from_slice(buffer);
      Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
      Ok(())
    }
  }

  impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for TestLogWriter {
    type Writer = Self;

    fn make_writer(&'writer self) -> Self::Writer {
      self.clone()
    }
  }

  struct TestMail;

  #[async_trait]
  impl MailPort for TestMail {
    async fn send_template(&self, _mail: crate::ports::TemplateMail) -> PortResult<()> {
      Ok(())
    }
  }

  struct TestStorage;

  #[async_trait]
  impl BlobStoragePort for TestStorage {
    async fn write_blob(&self, _req: crate::ports::BlobWriteRequest) -> PortResult<()> {
      Ok(())
    }

    async fn read_blob(&self, key: &str) -> PortResult<BlobReadResponse> {
      Err(PortError::NotFound(key.to_string()))
    }

    async fn delete_blob(&self, _key: &str) -> PortResult<()> {
      Ok(())
    }

    async fn put_avatar(&self, key: &str, _data: Bytes, _content_type: &str) -> PortResult<String> {
      Ok(key.to_string())
    }

    async fn get_avatar(&self, key: &str) -> PortResult<BlobReadResponse> {
      Err(PortError::NotFound(key.to_string()))
    }

    async fn delete_avatar(&self, _key: &str) -> PortResult<()> {
      Ok(())
    }

    async fn create_multipart_upload(&self, _req: MultipartCreateRequest) -> PortResult<MultipartCreateResponse> {
      Err(PortError::InvalidInput("not used".to_string()))
    }

    async fn create_multipart_part_url(&self, _req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse> {
      Err(PortError::InvalidInput("not used".to_string()))
    }

    async fn complete_multipart_upload(&self, _req: MultipartCompleteRequest) -> PortResult<()> {
      Ok(())
    }

    async fn abort_multipart_upload(&self, _upload_id: Uuid) -> PortResult<()> {
      Ok(())
    }
  }

  fn build_service(store: Arc<dyn AuthStore>, redis: Arc<dyn RedisPort>) -> AuthService {
    AuthService::new(store, Arc::new(TestMail), Arc::new(TestStorage), 1_296_000, 604_800)
      .with_session_cache(redis, 300)
  }

  #[derive(Default)]
  struct RecordingSessionRevocationObserver {
    sessions: StdMutex<Vec<Uuid>>,
    users: StdMutex<Vec<(Uuid, Vec<Uuid>)>>,
  }

  impl SessionRevocationObserver for RecordingSessionRevocationObserver {
    fn session_revoked(&self, session_id: Uuid) {
      self.sessions.lock().expect("observer session lock").push(session_id);
    }

    fn user_sessions_revoked(&self, user_id: Uuid, session_ids: &[Uuid]) {
      self
        .users
        .lock()
        .expect("observer user lock")
        .push((user_id, session_ids.to_vec()));
    }
  }

  #[test]
  fn user_preferences_patch_sets_resets_and_rejects_invalid_values() {
    let mut preferences = UserPreferences::default();
    let workspace = Uuid::new_v4();
    let other_workspace = Uuid::new_v4();
    let views = HashMap::from([(workspace, "gallery".into()), (other_workspace, "list".into())]);
    preferences
      .apply_patch(UserPreferencesPatch {
        template_catalog_views: Some(Some(views.clone())),
        ..Default::default()
      })
      .unwrap();
    // Invalid display choices must not partially replace this account's other scopes.
    assert!(
      preferences
        .apply_patch(UserPreferencesPatch {
          template_catalog_views: Some(Some(HashMap::from([(workspace, "unknown".into())]))),
          ..Default::default()
        })
        .is_err()
    );
    assert_eq!(preferences.template_catalog_views.as_ref(), Some(&views));
    assert_eq!(
      preferences
        .resolve(&UserPreferenceDefaults::default())
        .template_catalog_views,
      Some(views)
    );
    preferences
      .apply_patch(UserPreferencesPatch {
        template_catalog_views: Some(None),
        ..Default::default()
      })
      .unwrap();
    assert!(preferences.template_catalog_views.is_none());
    assert!(
      preferences
        .resolve(&UserPreferenceDefaults::default())
        .notify_created_documents
    );
    preferences
      .apply_patch(UserPreferencesPatch {
        notify_created_documents: Some(Some(false)),
        ..Default::default()
      })
      .unwrap();
    preferences.apply_patch(UserPreferencesPatch::default()).unwrap();
    assert!(
      !preferences
        .resolve(&UserPreferenceDefaults::default())
        .notify_created_documents
    );
    preferences
      .apply_patch(UserPreferencesPatch {
        notify_created_documents: Some(None),
        ..Default::default()
      })
      .unwrap();
    assert!(
      preferences
        .resolve(&UserPreferenceDefaults::default())
        .notify_created_documents
    );
    assert!(
      serde_json::to_value(&preferences)
        .unwrap()
        .get("notifyCreatedDocuments")
        .is_none()
    );
    preferences
      .apply_patch(UserPreferencesPatch {
        assistance_mode: Some(Some(AssistanceMode::Automatic)),
        locale: Some(Some("de".to_string())),
        timezone: Some(Some("Europe/Berlin".to_string())),
        date_format: Some(Some("day-month-year".to_string())),
        time_format: Some(Some("24-hour".to_string())),
        color_mode: Some(Some("dark".to_string())),
        telemetry_enabled: Some(Some(false)),
        ..Default::default()
      })
      .expect("valid preference patch");
    assert_eq!(preferences.locale.as_deref(), Some("de"));
    assert_eq!(preferences.timezone.as_deref(), Some("Europe/Berlin"));
    assert_eq!(preferences.date_format.as_deref(), Some("day-month-year"));
    assert_eq!(preferences.time_format.as_deref(), Some("24-hour"));
    assert_eq!(preferences.color_mode.as_deref(), Some("dark"));
    assert_eq!(preferences.telemetry_enabled, Some(false));
    let encoded = serde_json::to_value(&preferences).unwrap();
    assert_eq!(encoded["assistanceMode"], "automatic");
    assert!(serde_json::from_value::<UserPreferences>(serde_json::json!({"assistanceMode":"Automatic"})).is_err());
    assert_eq!(
      preferences
        .resolve(&UserPreferenceDefaults::default())
        .default_document_language,
      "de"
    );

    preferences
      .apply_patch(UserPreferencesPatch {
        color_mode: Some(None),
        ..Default::default()
      })
      .expect("reset removes the override");
    assert_eq!(preferences.color_mode, None);
    assert_eq!(
      preferences.resolve(&UserPreferenceDefaults::default()).color_mode,
      "system"
    );

    let error = preferences
      .apply_patch(UserPreferencesPatch {
        editor_font_size: Some(Some(40)),
        ..Default::default()
      })
      .expect_err("invalid preference must be rejected");
    assert!(matches!(error, AuthError::InvalidInput(_)));
    assert_eq!(preferences.editor_font_size, None);

    let error = preferences
      .apply_patch(UserPreferencesPatch {
        date_format: Some(Some("browser-magic".to_string())),
        ..Default::default()
      })
      .expect_err("unknown date format must be rejected");
    assert!(matches!(error, AuthError::InvalidInput(_)));

    let error = preferences
      .apply_patch(UserPreferencesPatch {
        timezone: Some(Some("Berlin local".to_string())),
        ..Default::default()
      })
      .expect_err("invalid timezone must be rejected");
    assert!(matches!(error, AuthError::InvalidInput(_)));
  }

  fn workbench_layout(
    workspace_id: Uuid,
    view_family: WorkbenchViewFamily,
    ordered_tool_ids: Vec<WorkbenchToolId>,
    visible_tool_ids: Vec<WorkbenchToolId>,
    collapsed_tool_ids: Vec<WorkbenchToolId>,
  ) -> WorkbenchToolLayout {
    WorkbenchToolLayout {
      workspace_id,
      view_family,
      ordered_tool_ids,
      visible_tool_ids,
      collapsed_tool_ids,
    }
  }

  #[test]
  fn workbench_tool_layout_patch_sets_resets_and_preserves_missing_override() {
    use WorkbenchToolId::{Calendar, DocumentInfo, Outline};

    let workspace_id = Uuid::new_v4();
    let layout = workbench_layout(
      workspace_id,
      WorkbenchViewFamily::DocumentPage,
      vec![Outline, DocumentInfo, Calendar],
      vec![Outline, Calendar],
      vec![Calendar],
    );
    let mut preferences = UserPreferences::default();
    assert!(
      preferences
        .resolve(&UserPreferenceDefaults::default())
        .workbench_tool_layouts
        .is_none()
    );

    preferences
      .apply_patch(UserPreferencesPatch {
        workbench_tool_layouts: Some(Some(vec![layout.clone()])),
        ..Default::default()
      })
      .expect("valid Workbench layout");
    assert_eq!(preferences.workbench_tool_layouts, Some(vec![layout]));

    preferences
      .apply_patch(UserPreferencesPatch {
        workbench_tool_layouts: Some(None),
        ..Default::default()
      })
      .expect("reset removes every explicit Workbench layout");
    assert!(preferences.workbench_tool_layouts.is_none());
    assert!(
      preferences
        .resolve(&UserPreferenceDefaults::default())
        .workbench_tool_layouts
        .is_none()
    );
  }

  #[test]
  fn workbench_tool_layout_validation_rejects_invalid_scopes_without_partial_write() {
    use WorkbenchToolId::{Calendar, DatabaseSettings, Outline};

    let workspace_id = Uuid::new_v4();
    let original = workbench_layout(
      workspace_id,
      WorkbenchViewFamily::DocumentPage,
      vec![Outline, Calendar],
      vec![Outline],
      vec![],
    );
    let mut preferences = UserPreferences {
      workbench_tool_layouts: Some(vec![original.clone()]),
      ..Default::default()
    };
    let invalid_layouts = [
      vec![
        original.clone(),
        workbench_layout(
          workspace_id,
          WorkbenchViewFamily::DocumentPage,
          vec![Outline],
          vec![],
          vec![],
        ),
      ],
      vec![workbench_layout(
        workspace_id,
        WorkbenchViewFamily::DocumentPage,
        vec![Outline, Outline],
        vec![Outline],
        vec![],
      )],
      vec![workbench_layout(
        workspace_id,
        WorkbenchViewFamily::DocumentPage,
        vec![DatabaseSettings],
        vec![],
        vec![],
      )],
      vec![workbench_layout(
        workspace_id,
        WorkbenchViewFamily::DocumentPage,
        vec![Outline],
        vec![Calendar],
        vec![],
      )],
      vec![workbench_layout(
        workspace_id,
        WorkbenchViewFamily::DocumentPage,
        vec![Outline],
        vec![Outline],
        vec![Calendar],
      )],
    ];

    for layouts in invalid_layouts {
      let error = preferences
        .apply_patch(UserPreferencesPatch {
          workbench_tool_layouts: Some(Some(layouts)),
          ..Default::default()
        })
        .expect_err("invalid Workbench layout must be rejected");
      assert!(matches!(error, AuthError::InvalidInput(_)));
      assert_eq!(preferences.workbench_tool_layouts, Some(vec![original.clone()]));
    }
  }

  #[test]
  fn workbench_tool_layout_validation_covers_every_view_family() {
    use WorkbenchToolId::*;

    let workspace_id = Uuid::new_v4();
    let layouts = vec![
      workbench_layout(
        workspace_id,
        WorkbenchViewFamily::DocumentPage,
        vec![
          Outline,
          Tags,
          DocumentInfo,
          Calendar,
          Agenda,
          Activity,
          Comment,
          Chat,
          Export,
          Analytics,
          Presence,
        ],
        vec![],
        vec![],
      ),
      workbench_layout(
        workspace_id,
        WorkbenchViewFamily::DocumentEdgeless,
        vec![
          Frame,
          DocumentInfo,
          Calendar,
          Agenda,
          Activity,
          Comment,
          Chat,
          Export,
          Analytics,
          Presence,
        ],
        vec![],
        vec![],
      ),
      workbench_layout(
        workspace_id,
        WorkbenchViewFamily::Journal,
        vec![Calendar, Agenda, Activity, Comment, Chat, Export, Analytics, Presence],
        vec![],
        vec![],
      ),
      workbench_layout(
        workspace_id,
        WorkbenchViewFamily::Database,
        vec![DatabaseSettings, Presence],
        vec![DatabaseSettings],
        vec![],
      ),
      workbench_layout(
        workspace_id,
        WorkbenchViewFamily::Graph,
        vec![GraphDetails],
        vec![GraphDetails],
        vec![],
      ),
    ];

    UserPreferences {
      workbench_tool_layouts: Some(layouts),
      ..Default::default()
    }
    .validate()
    .expect("the canonical view-family matrix must remain valid");
  }

  #[test]
  fn workbench_tags_tool_is_limited_to_document_page() {
    use WorkbenchToolId::Tags;

    let workspace_id = Uuid::new_v4();
    UserPreferences {
      workbench_tool_layouts: Some(vec![workbench_layout(
        workspace_id,
        WorkbenchViewFamily::DocumentPage,
        vec![Tags],
        vec![Tags],
        vec![],
      )]),
      ..Default::default()
    }
    .validate()
    .expect("Tags must be accepted for DocumentPage");

    for view_family in [
      WorkbenchViewFamily::DocumentEdgeless,
      WorkbenchViewFamily::Journal,
      WorkbenchViewFamily::Database,
      WorkbenchViewFamily::Graph,
    ] {
      let error = UserPreferences {
        workbench_tool_layouts: Some(vec![workbench_layout(
          workspace_id,
          view_family,
          vec![Tags],
          vec![],
          vec![],
        )]),
        ..Default::default()
      }
      .validate()
      .expect_err("Tags must be rejected outside DocumentPage");
      assert!(matches!(error, AuthError::InvalidInput(_)));
    }
  }

  #[test]
  fn workbench_tool_layout_validation_rejects_unbounded_scope_growth() {
    let layouts = (0..=MAX_WORKBENCH_TOOL_LAYOUTS)
      .map(|_| {
        workbench_layout(
          Uuid::new_v4(),
          WorkbenchViewFamily::Database,
          vec![WorkbenchToolId::DatabaseSettings],
          vec![],
          vec![],
        )
      })
      .collect();

    let error = UserPreferences {
      workbench_tool_layouts: Some(layouts),
      ..Default::default()
    }
    .validate()
    .expect_err("unbounded Workbench scope growth must be rejected");
    assert!(matches!(error, AuthError::InvalidInput(_)));
  }

  fn dashboard_layout(
    workspace_id: Uuid,
    ordered_dashlet_ids: Vec<WorkspaceDashboardDashletId>,
    dashlet_sizes: Vec<(WorkspaceDashboardDashletId, WorkspaceDashboardDashletSize)>,
  ) -> WorkspaceDashboardLayout {
    WorkspaceDashboardLayout {
      workspace_id,
      ordered_dashlet_ids,
      dashlet_sizes: dashlet_sizes
        .into_iter()
        .map(|(dashlet_id, size)| WorkspaceDashboardDashletSizeOverride { dashlet_id, size })
        .collect(),
    }
  }

  #[test]
  fn workspace_dashboard_layout_patch_sets_resets_and_rejects_invalid_candidates_atomically() {
    use WorkspaceDashboardDashletId::*;
    use WorkspaceDashboardDashletSize::*;

    let workspace_id = Uuid::new_v4();
    let valid = dashboard_layout(
      workspace_id,
      vec![Today, Activity, NewDocuments, Reminders, RecentlyEdited],
      vec![(Today, Wide), (Activity, Standard)],
    );
    let mut preferences = UserPreferences::default();
    preferences
      .apply_patch(UserPreferencesPatch {
        workspace_dashboard_layouts: Some(Some(vec![valid.clone()])),
        ..Default::default()
      })
      .expect("valid dashboard layout");
    assert_eq!(preferences.workspace_dashboard_layouts, Some(vec![valid.clone()]));

    for task_size in [Standard, Wide] {
      let mut candidate = UserPreferences::default();
      let layout = dashboard_layout(workspace_id, vec![Tasks], vec![(Tasks, task_size)]);
      candidate
        .apply_patch(UserPreferencesPatch {
          workspace_dashboard_layouts: Some(Some(vec![layout.clone()])),
          ..Default::default()
        })
        .expect("Tasks supports Standard and Wide");
      assert_eq!(candidate.workspace_dashboard_layouts, Some(vec![layout]));
    }

    for invalid in [
      dashboard_layout(workspace_id, vec![Today, Today], vec![]),
      dashboard_layout(workspace_id, vec![Today], vec![(Activity, Standard)]),
      dashboard_layout(workspace_id, vec![Today], vec![(Today, Compact)]),
      dashboard_layout(workspace_id, vec![Tasks], vec![(Tasks, Compact)]),
      dashboard_layout(workspace_id, vec![Reminders], vec![(Reminders, Compact)]),
      dashboard_layout(workspace_id, vec![Activity], vec![(Activity, Compact)]),
      dashboard_layout(
        workspace_id,
        vec![Activity],
        vec![(Activity, Standard), (Activity, Wide)],
      ),
    ] {
      let error = preferences
        .apply_patch(UserPreferencesPatch {
          workspace_dashboard_layouts: Some(Some(vec![invalid])),
          ..Default::default()
        })
        .expect_err("invalid dashboard layout");
      assert!(matches!(error, AuthError::InvalidInput(_)));
      assert_eq!(
        preferences.workspace_dashboard_layouts,
        Some(vec![valid.clone()]),
        "candidate validation must not partially update the aggregate"
      );
    }

    let duplicate_workspace = vec![
      valid.clone(),
      dashboard_layout(workspace_id, vec![NewDocuments], vec![]),
    ];
    assert!(
      preferences
        .apply_patch(UserPreferencesPatch {
          workspace_dashboard_layouts: Some(Some(duplicate_workspace)),
          ..Default::default()
        })
        .is_err()
    );
    assert_eq!(preferences.workspace_dashboard_layouts, Some(vec![valid]));

    preferences
      .apply_patch(UserPreferencesPatch {
        workspace_dashboard_layouts: Some(None),
        ..Default::default()
      })
      .expect("dashboard reset");
    assert!(preferences.workspace_dashboard_layouts.is_none());
  }

  #[test]
  fn workspace_dashboard_layout_validation_rejects_unbounded_workspace_growth() {
    let layouts = (0..=MAX_WORKSPACE_DASHBOARD_LAYOUTS)
      .map(|_| dashboard_layout(Uuid::new_v4(), vec![], vec![]))
      .collect();
    let error = UserPreferences {
      workspace_dashboard_layouts: Some(layouts),
      ..Default::default()
    }
    .validate()
    .expect_err("unbounded dashboard layouts");
    assert!(matches!(error, AuthError::InvalidInput(_)));
  }

  #[tokio::test]
  async fn concurrent_preference_patches_preserve_unrelated_fields() {
    let store = Arc::new(InMemoryAuthStore::default());
    let user_id = store
      .fulfill_user("preference-race@example.test", Some("Preference owner"), None)
      .await
      .expect("create preference owner")
      .id;
    let workspace_id = Uuid::new_v4();
    let first = store.patch_user_preferences(
      user_id,
      UserPreferencesPatch {
        locale: Some(Some("de".to_string())),
        ..Default::default()
      },
    );
    let second = store.patch_user_preferences(
      user_id,
      UserPreferencesPatch {
        workbench_tool_layouts: Some(Some(vec![workbench_layout(
          workspace_id,
          WorkbenchViewFamily::Database,
          vec![WorkbenchToolId::DatabaseSettings],
          vec![WorkbenchToolId::DatabaseSettings],
          vec![],
        )])),
        ..Default::default()
      },
    );
    let (first_result, second_result) = tokio::join!(first, second);
    first_result.expect("locale patch");
    second_result.expect("Workbench patch");

    let record = store.get_user_preferences(user_id).await.expect("stored preferences");
    assert_eq!(record.values.locale.as_deref(), Some("de"));
    assert_eq!(record.values.workbench_tool_layouts.as_ref().map(Vec::len), Some(1));
  }

  #[tokio::test]
  async fn email_confirmation_refreshes_an_existing_cached_browser_session() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let service = build_service(store.clone(), redis.clone());
    let user = store
      .fulfill_user("verify-cache@example.test", None, None)
      .await
      .unwrap();
    let session = service
      .create_user_session(
        user.id,
        SessionContext {
          user_agent: None,
          ip_address: None,
        },
      )
      .await
      .unwrap();
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .unwrap()
        .unwrap()
        .user
        .email_verified_at
        .is_none()
    );
    assert!(
      redis
        .get_string(&AuthService::session_cache_key(session.id))
        .await
        .unwrap()
        .is_some()
    );
    store
      .create_verification_token(
        Some(user.id),
        "VerifyEmail",
        "confirm-cache",
        None,
        Utc::now() + Duration::minutes(30),
        None,
      )
      .await
      .unwrap();
    service.verify_email(user.id, "confirm-cache").await.unwrap();
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .unwrap()
        .unwrap()
        .user
        .email_verified_at
        .is_some()
    );
    assert!(
      store
        .get_session(session.id)
        .await
        .unwrap()
        .unwrap()
        .revoked_at
        .is_none()
    );
    assert!(matches!(
      service.verify_email(user.id, "confirm-cache").await,
      Err(AuthError::InvalidToken)
    ));
  }

  #[tokio::test]
  async fn overlapping_session_mutations_cannot_unblock_another_owner() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let service = build_service(store, redis.clone());
    let user = Uuid::new_v4();
    let first = service.begin_global_session_revoke(user).await.expect("claim epoch");
    assert!(service.begin_global_session_revoke(user).await.is_err());
    // Model expiry and replacement while the earlier operation is delayed.
    redis
      .delete_key(&AuthService::user_session_epoch_key(user))
      .await
      .expect("expire old fence");
    let second = service.begin_global_session_revoke(user).await.expect("new owner");
    assert!(
      service
        .rollback_global_session_revoke(user, first.as_deref())
        .await
        .is_err()
    );
    assert_eq!(
      redis
        .get_string(&AuthService::user_session_epoch_key(user))
        .await
        .expect("still blocked"),
      second
    );
    service
      .rollback_global_session_revoke(user, second.as_deref())
      .await
      .expect("owner releases epoch");
  }

  #[tokio::test]
  async fn single_revoke_fences_a_late_cache_fill_and_preserves_other_sessions() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let service = build_service(store.clone(), redis.clone());
    let user = store
      .fulfill_user("revoke-race@example.test", None, None)
      .await
      .expect("user");
    let session = service
      .create_user_session(
        user.id,
        SessionContext {
          user_agent: None,
          ip_address: None,
        },
      )
      .await
      .expect("session");
    let other = service
      .create_user_session(
        user.id,
        SessionContext {
          user_agent: None,
          ip_address: None,
        },
      )
      .await
      .expect("other session");
    let key = AuthService::session_cache_key(session.id);
    let started = Arc::new(tokio::sync::Notify::new());
    let resume = Arc::new(tokio::sync::Notify::new());
    *redis.paused_set.lock().await = Some((key.clone(), started.clone(), resume.clone()));
    let reader = tokio::spawn({
      let service = service.clone();
      async move { service.get_session_snapshot(session.id).await }
    });
    started.notified().await;
    let commit = service
      .revoke_sessions(SessionRevocationTarget::Session(session.id))
      .await
      .expect("revoke");
    assert_eq!(commit.sessions, vec![(session.id, user.id)]);
    resume.notify_one();
    assert!(reader.await.expect("reader task").expect("snapshot").is_none());
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("revoked read")
        .is_none()
    );
    assert!(
      service
        .get_session_snapshot(other.id)
        .await
        .expect("untargeted read")
        .is_some()
    );
    assert!(redis.get_string(&key).await.expect("late cache entry").is_none());
    assert!(
      service
        .revoke_sessions(SessionRevocationTarget::Session(session.id))
        .await
        .expect("repeat revoke")
        .revoked_count
        == 0
    );
  }

  #[tokio::test]
  async fn email_change_rejects_invalid_tokens_and_fences_late_cache_refill() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let service = build_service(store.clone(), redis.clone());
    let user = store
      .fulfill_user("old-email@example.test", None, None)
      .await
      .expect("user");
    let peer = store
      .fulfill_user("occupied-email@example.test", None, None)
      .await
      .expect("peer");
    let session = service
      .create_user_session(
        user.id,
        SessionContext {
          user_agent: None,
          ip_address: None,
        },
      )
      .await
      .expect("session");
    let token = "email-change-test-token";
    store
      .create_verification_token(
        Some(user.id),
        "VerifyEmail",
        token,
        None,
        Utc::now() + chrono::Duration::hours(1),
        None,
      )
      .await
      .expect("token");
    assert!(matches!(
      service.change_email(user.id, "missing", "new@example.test").await,
      Err(AuthError::InvalidToken)
    ));
    assert!(matches!(
      service.change_email(user.id, token, &peer.email).await,
      Err(AuthError::ActionForbidden)
    ));
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("preserved session")
        .is_some()
    );
    assert!(
      store
        .get_verification_token(token)
        .await
        .expect("token")
        .expect("exists")
        .used_at
        .is_none()
    );
    service.invalidate_session_cache(session.id).await;
    let key = AuthService::session_cache_key(session.id);
    let started = Arc::new(tokio::sync::Notify::new());
    let resume = Arc::new(tokio::sync::Notify::new());
    *redis.paused_set.lock().await = Some((key, started.clone(), resume.clone()));
    let reader = tokio::spawn({
      let service = service.clone();
      async move { service.get_session_snapshot(session.id).await }
    });
    started.notified().await;
    let updated = service
      .change_email(user.id, token, "new-email%40example.test")
      .await
      .expect("change email");
    assert_eq!(updated.email, "new-email@example.test");
    assert!(updated.email_verified_at.is_some());
    resume.notify_one();
    assert!(reader.await.expect("reader").expect("late read").is_none());
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("revoked")
        .is_none()
    );
    assert!(
      store
        .get_session(session.id)
        .await
        .expect("DB")
        .expect("session")
        .revoked_at
        .is_some()
    );
    assert!(
      store
        .get_verification_token(token)
        .await
        .expect("token")
        .expect("exists")
        .used_at
        .is_some()
    );
    assert!(matches!(
      service.change_email(user.id, token, "another@example.test").await,
      Err(AuthError::InvalidToken)
    ));
    assert_eq!(
      store
        .get_user_by_id(user.id)
        .await
        .expect("user")
        .expect("exists")
        .email,
      updated.email
    );
  }

  #[tokio::test]
  async fn auth_service_session_cache_stores_snapshot_and_invalidates_on_sign_out() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let observer = Arc::new(RecordingSessionRevocationObserver::default());
    let service = build_service(store.clone(), redis.clone()).with_session_revocation_observer(observer.clone());
    let now = Utc::now();

    let user = store
      .fulfill_user("cache-user@example.com", Some("Cache User"), None)
      .await
      .expect("create user");
    let session = store
      .create_session(NewSession {
        id: Uuid::new_v4(),
        user_id: user.id,
        csrf_token: "csrf".to_string(),
        user_agent: None,
        ip_address: None,
        expires_at: now + Duration::hours(1),
        refresh_after: now + Duration::minutes(30),
        created_at: now,
      })
      .await
      .expect("create session");

    let snapshot = service.get_session_snapshot(session.id).await.expect("snapshot");
    assert!(snapshot.is_some());
    let cache_key = AuthService::session_cache_key(session.id);
    assert!(
      redis.get_string(&cache_key).await.expect("redis get").is_some(),
      "snapshot should be cached"
    );

    service.sign_out(session.id).await.expect("sign out");
    assert!(
      redis.get_string(&cache_key).await.expect("redis get").is_none(),
      "cache entry must be removed on sign out"
    );
    assert_eq!(
      observer.sessions.lock().expect("observer session lock").as_slice(),
      &[session.id],
      "the observer runs only after the session revoke succeeds"
    );
  }

  #[tokio::test]
  async fn password_reset_atomically_revokes_sessions_and_invalidates_cached_snapshots() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let observer = Arc::new(RecordingSessionRevocationObserver::default());
    let service = build_service(store.clone(), redis.clone()).with_session_revocation_observer(observer.clone());
    let now = Utc::now();
    let user = store
      .fulfill_user("reset-cache@example.com", Some("Reset Cache"), None)
      .await
      .expect("create user");
    let session = store
      .create_session(NewSession {
        id: Uuid::new_v4(),
        user_id: user.id,
        csrf_token: "csrf-reset".to_string(),
        user_agent: None,
        ip_address: None,
        expires_at: now + Duration::hours(1),
        refresh_after: now + Duration::minutes(30),
        created_at: now,
      })
      .await
      .expect("create session");
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("prime cache")
        .is_some()
    );

    let link = service
      .create_password_reset_link(user.id, "https://workspace.example.test", None)
      .await
      .expect("reset link");
    let token = url::Url::parse(&link.url)
      .expect("link URL")
      .query_pairs()
      .find(|(key, _)| key == "token")
      .map(|(_, value)| value.into_owned())
      .expect("token");
    service
      .change_password(&token, "new-secure-password")
      .await
      .expect("password reset");

    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("revoked snapshot lookup")
        .is_none(),
      "a cache hit must not resurrect a session revoked by password reset"
    );
    assert!(
      redis
        .get_string(&AuthService::session_cache_key(session.id))
        .await
        .expect("cache lookup")
        .is_none()
    );
    assert!(
      redis
        .get_string(&AuthService::user_session_epoch_key(user.id))
        .await
        .expect("epoch lookup")
        .is_some_and(|epoch| epoch.starts_with("active:")),
      "global revoke must establish a durable user epoch"
    );
    assert!(matches!(
      service.change_password(&token, "another-password").await,
      Err(AuthError::InvalidToken)
    ));
    let changed_user = store.get_user_by_id(user.id).await.expect("user lookup").expect("user");
    assert!(verify_password_hash(
      changed_user.password_hash.as_deref().expect("password hash"),
      "new-secure-password"
    ));
    assert_eq!(
      observer.users.lock().expect("observer user lock").as_slice(),
      &[(user.id, vec![session.id])],
      "global revocation must expose the committed session set exactly once"
    );
  }

  #[tokio::test]
  async fn session_snapshot_is_rejected_when_user_epoch_rotates_during_database_read() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let service = build_service(store.clone(), redis.clone());
    let now = Utc::now();
    let user = store
      .fulfill_user("reset-race@example.com", Some("Reset Race"), None)
      .await
      .expect("create user");
    let session = store
      .create_session(NewSession {
        id: Uuid::new_v4(),
        user_id: user.id,
        csrf_token: "csrf-reset-race".to_string(),
        user_agent: None,
        ip_address: None,
        expires_at: now + Duration::hours(1),
        refresh_after: now + Duration::minutes(30),
        created_at: now,
      })
      .await
      .expect("create session");
    let epoch_key = AuthService::user_session_epoch_key(user.id);
    redis
      .script_gets(
        &epoch_key,
        [
          Some("active:before-reset".to_string()),
          Some("active:after-reset".to_string()),
        ],
      )
      .await;

    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("snapshot lookup")
        .is_none(),
      "an epoch rotation during the DB read must reject the stale snapshot"
    );
    assert!(
      redis
        .get_string(&AuthService::session_cache_key(session.id))
        .await
        .expect("cache lookup")
        .is_none(),
      "the stale snapshot must never reach Redis"
    );
  }

  #[tokio::test]
  async fn blocked_user_epoch_rejects_database_snapshot_until_reset_finishes() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let service = build_service(store.clone(), redis.clone());
    let user = store
      .fulfill_user("reset-blocked@example.com", Some("Reset Blocked"), None)
      .await
      .expect("create user");
    let session = service
      .create_user_session(
        user.id,
        SessionContext {
          user_agent: None,
          ip_address: None,
        },
      )
      .await
      .expect("create session");
    redis
      .set_string(
        &AuthService::user_session_epoch_key(user.id),
        "blocked:unfinished-reset",
        Some(300),
      )
      .await
      .expect("blocked epoch");

    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("snapshot lookup")
        .is_none(),
      "an in-progress or interrupted reset must block session authentication"
    );
    assert!(
      redis
        .get_string(&AuthService::session_cache_key(session.id))
        .await
        .expect("cache lookup")
        .is_none()
    );
  }

  #[tokio::test]
  async fn session_snapshot_fails_closed_when_epoch_cannot_be_read() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let service = build_service(store.clone(), redis.clone());
    let user = store
      .fulfill_user("reset-epoch-read@example.com", Some("Reset Epoch Read"), None)
      .await
      .expect("create user");
    let session = service
      .create_user_session(
        user.id,
        SessionContext {
          user_agent: None,
          ip_address: None,
        },
      )
      .await
      .expect("create session");
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("prime snapshot cache")
        .is_some()
    );

    let epoch_key = AuthService::user_session_epoch_key(user.id);
    redis
      .script_get_results(
        &epoch_key,
        [
          Err(PortError::Transport("scripted epoch read failure".to_string())),
          Err(PortError::Transport("scripted epoch read failure".to_string())),
        ],
      )
      .await;

    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("snapshot lookup")
        .is_none(),
      "an unavailable epoch barrier must never fall through to a stale DB snapshot"
    );
  }

  #[tokio::test]
  async fn committed_password_reset_stays_safe_when_active_epoch_rotation_fails() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let service = build_service(store.clone(), redis.clone());
    let now = Utc::now();
    let user = store
      .fulfill_user("reset-epoch-write@example.com", Some("Reset Epoch Write"), None)
      .await
      .expect("create user");
    let session = store
      .create_session(NewSession {
        id: Uuid::new_v4(),
        user_id: user.id,
        csrf_token: "csrf-reset-epoch-write".to_string(),
        user_agent: None,
        ip_address: None,
        expires_at: now + Duration::hours(1),
        refresh_after: now + Duration::minutes(30),
        created_at: now,
      })
      .await
      .expect("create session");
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("prime snapshot cache")
        .is_some()
    );
    let link = service
      .create_password_reset_link(user.id, "https://workspace.example.test", None)
      .await
      .expect("reset link");
    let token = url::Url::parse(&link.url)
      .expect("link URL")
      .query_pairs()
      .find(|(key, _)| key == "token")
      .map(|(_, value)| value.into_owned())
      .expect("token");

    // The pre-commit block succeeds; all three post-commit activation retries
    // fail. This is the only cross-store failure window after the SQL commit.
    redis.script_sets([true, false, false, false]).await;
    service
      .change_password(&token, "new-password-after-redis-failure")
      .await
      .expect("the committed reset remains successful");

    let changed_user = store.get_user_by_id(user.id).await.expect("user lookup").expect("user");
    assert!(verify_password_hash(
      changed_user.password_hash.as_deref().expect("password hash"),
      "new-password-after-redis-failure"
    ));
    assert!(matches!(
      service.change_password(&token, "must-not-be-used").await,
      Err(AuthError::InvalidToken)
    ));
    assert!(
      redis
        .get_string(&AuthService::user_session_epoch_key(user.id))
        .await
        .expect("epoch lookup")
        .is_some_and(|epoch| epoch.starts_with("blocked:")),
      "failed activation must preserve the pre-commit fail-closed epoch"
    );
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("revoked snapshot lookup")
        .is_none(),
      "the revoked session must not authenticate after the Redis write failure"
    );
  }

  #[tokio::test]
  async fn cached_session_is_rejected_immediately_after_ban() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let service = build_service(store.clone(), redis.clone());
    let user = store
      .fulfill_user("suspend-cached@example.com", Some("Suspend Cached"), None)
      .await
      .expect("create user");
    let session = service
      .create_user_session(
        user.id,
        SessionContext {
          user_agent: None,
          ip_address: None,
        },
      )
      .await
      .expect("create session");

    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("prime cache")
        .is_some()
    );
    assert!(
      redis
        .get_string(&AuthService::session_cache_key(session.id))
        .await
        .expect("cache lookup")
        .is_some()
    );

    service.suspend_user(user.id, Utc::now()).await.expect("suspend user");

    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("cached session lookup")
        .is_none(),
      "a cached session must be rejected immediately after suspension"
    );
    assert!(
      redis
        .get_string(&AuthService::session_cache_key(session.id))
        .await
        .expect("cache lookup")
        .is_none(),
      "suspension must invalidate the cached snapshot"
    );
  }

  #[tokio::test]
  async fn cached_disabled_user_snapshot_is_rejected_even_if_invalidation_misses() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let service = build_service(store.clone(), redis.clone());
    let user = store
      .fulfill_user("suspend-cached-guard@example.com", Some("Suspend Cached Guard"), None)
      .await
      .expect("create user");
    let session = service
      .create_user_session(
        user.id,
        SessionContext {
          user_agent: None,
          ip_address: None,
        },
      )
      .await
      .expect("create session");

    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("prime cache")
        .is_some()
    );
    let cache_key = AuthService::session_cache_key(session.id);
    let cached = redis
      .get_string(&cache_key)
      .await
      .expect("cache lookup")
      .expect("snapshot must be cached");
    let mut envelope: CachedSessionSnapshot = serde_json::from_str(&cached).expect("cache envelope");
    envelope.snapshot.user.disabled = true;
    redis
      .set_string(
        &cache_key,
        &serde_json::to_string(&envelope).expect("encode disabled envelope"),
        None,
      )
      .await
      .expect("overwrite cache with disabled snapshot");

    assert!(
      service.load_cached_session_snapshot(session.id).await.is_none(),
      "a disabled user must never authenticate from a cached snapshot"
    );
    assert!(
      redis
        .get_string(&cache_key)
        .await
        .expect("cache lookup after rejection")
        .is_none(),
      "a rejected disabled snapshot must be invalidated"
    );
  }

  #[tokio::test]
  async fn uncached_session_is_rejected_immediately_after_ban() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let service = build_service(store.clone(), Arc::new(TestRedis::default()));
    let user = store
      .fulfill_user("suspend-uncached@example.com", Some("Suspend Uncached"), None)
      .await
      .expect("create user");
    let session = service
      .create_user_session(
        user.id,
        SessionContext {
          user_agent: None,
          ip_address: None,
        },
      )
      .await
      .expect("create session");

    service.suspend_user(user.id, Utc::now()).await.expect("suspend user");
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("uncached session lookup")
        .is_none(),
      "an uncached session must be rejected immediately after suspension"
    );
  }

  #[tokio::test]
  async fn admin_role_refresh_fences_late_fills_retains_credentials_and_never_notifies_revocation() {
    let store = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let observer = Arc::new(RecordingSessionRevocationObserver::default());
    let service = build_service(store.clone(), redis.clone()).with_session_revocation_observer(observer.clone());
    let user = store
      .fulfill_user("role-cache@example.test", Some("Role cache"), None)
      .await
      .unwrap();
    let session = service
      .create_user_session(
        user.id,
        SessionContext {
          user_agent: None,
          ip_address: None,
        },
      )
      .await
      .unwrap();
    service.set_user_admin_role(user.id, true).await.unwrap();
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .unwrap()
        .unwrap()
        .user
        .is_admin
    );
    let key = AuthService::session_cache_key(session.id);
    redis.delete_key(&key).await.unwrap();
    let started = Arc::new(tokio::sync::Notify::new());
    let resume = Arc::new(tokio::sync::Notify::new());
    *redis.paused_set.lock().await = Some((key.clone(), started.clone(), resume.clone()));
    let reader = service.clone();
    let fill = tokio::spawn(async move { reader.get_session_snapshot(session.id).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
      .await
      .expect("fill reaches Redis write");
    let commit = service.set_user_admin_role(user.id, false).await.unwrap();
    assert!(commit.previous_is_admin && !commit.is_admin);
    assert_eq!(commit.session_ids, vec![session.id]);
    resume.notify_one();
    assert!(
      fill.await.unwrap().unwrap().is_none(),
      "a fill crossing the role commit is not accepted"
    );
    assert!(
      redis.get_string(&key).await.unwrap().is_none(),
      "late old-role fill is removed"
    );
    assert!(
      !service
        .get_session_snapshot(session.id)
        .await
        .unwrap()
        .unwrap()
        .user
        .is_admin
    );
    assert_eq!(
      store.get_session(session.id).await.unwrap().unwrap().expires_at,
      session.expires_at
    );
    assert!(
      store
        .get_session(session.id)
        .await
        .unwrap()
        .unwrap()
        .revoked_at
        .is_none()
    );
    assert!(observer.sessions.lock().unwrap().is_empty());
    assert!(observer.users.lock().unwrap().is_empty());
    redis.script_sets([true, false, false, false]).await;
    let committed = service
      .set_user_admin_role(user.id, true)
      .await
      .expect("known role commit survives Redis failure");
    assert!(committed.is_admin);
    assert!(store.get_user_by_id(user.id).await.unwrap().unwrap().is_admin);
    assert!(
      service.get_session_snapshot(session.id).await.unwrap().is_none(),
      "failed activation stays fail-closed"
    );
    assert!(
      store
        .get_session(session.id)
        .await
        .unwrap()
        .unwrap()
        .revoked_at
        .is_none()
    );
    assert!(observer.users.lock().unwrap().is_empty());
    let missing = Uuid::new_v4();
    assert!(matches!(
      service.set_user_admin_role(missing, true).await,
      Err(AuthError::NotFound(_))
    ));
    assert!(
      redis
        .get_string(&AuthService::user_session_epoch_key(missing))
        .await
        .unwrap()
        .is_some_and(|epoch| epoch.starts_with("active:")),
      "rollback restores the epoch"
    );
  }

  #[tokio::test]
  async fn account_deletion_fences_late_fills_and_notifies_captured_sessions_after_known_commit() {
    for activation_fails in [false, true] {
      let store = Arc::new(InMemoryAuthStore::default());
      let redis = Arc::new(TestRedis::default());
      let observer = Arc::new(RecordingSessionRevocationObserver::default());
      let service = build_service(store.clone(), redis.clone()).with_session_revocation_observer(observer.clone());
      let user = store
        .fulfill_user("delete-cache@example.test", Some("Deleted account"), None)
        .await
        .unwrap();
      let survivor = store
        .fulfill_user("delete-survivor@example.test", None, None)
        .await
        .unwrap();
      let sole = store
        .create_workspace(user.id, crate::workspace::WorkspaceName::parse("Sole").unwrap())
        .await
        .unwrap();
      let shared = store
        .create_workspace(user.id, crate::workspace::WorkspaceName::parse("Shared").unwrap())
        .await
        .unwrap();
      store.init_workspace_root_doc(sole.id, user.id, vec![]).await.unwrap();
      store.init_workspace_root_doc(shared.id, user.id, vec![]).await.unwrap();
      store
        .add_or_update_member(
          shared.id,
          survivor.id,
          WorkspaceRole::Admin,
          MembershipStatus::Accepted,
          Some(user.id),
        )
        .await
        .unwrap();
      let session = service
        .create_user_session(
          user.id,
          SessionContext {
            user_agent: None,
            ip_address: None,
          },
        )
        .await
        .unwrap();
      let old_app = service.request_open_app_sign_in_code(user.id).await.unwrap();
      let old_reset = Uuid::new_v4().to_string();
      store
        .create_verification_token(
          Some(user.id),
          "ChangePassword",
          &old_reset,
          Some(&user.email),
          Utc::now() + chrono::Duration::hours(1),
          None,
        )
        .await
        .unwrap();
      let old_otp_token = store
        .create_verification_token(
          Some(user.id),
          "SignIn",
          &Uuid::new_v4().to_string(),
          Some(&user.email),
          Utc::now() + chrono::Duration::hours(1),
          None,
        )
        .await
        .unwrap();
      store
        .upsert_magic_link_otp(MagicLinkOtp {
          email: user.email.clone(),
          otp: "123456".into(),
          verification_token_id: old_otp_token.id,
          client_nonce: None,
          expires_at: Utc::now() + chrono::Duration::hours(1),
        })
        .await
        .unwrap();
      assert!(service.get_session_snapshot(session.id).await.unwrap().is_some());
      let key = AuthService::session_cache_key(session.id);
      redis.delete_key(&key).await.unwrap();
      let started = Arc::new(tokio::sync::Notify::new());
      let resume = Arc::new(tokio::sync::Notify::new());
      *redis.paused_set.lock().await = Some((key.clone(), started.clone(), resume.clone()));
      let reader = service.clone();
      let fill = tokio::spawn(async move { reader.get_session_snapshot(session.id).await });
      tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
        .await
        .expect("fill reaches write");
      if activation_fails {
        redis.script_sets([true, false, false, false]).await;
      }
      let commit = service
        .delete_account_with_commit(user.id)
        .await
        .expect("known deletion succeeds despite post-commit cache failure");
      resume.notify_one();
      assert!(
        fill.await.unwrap().unwrap().is_none(),
        "a fill crossing deletion never returns the old identity"
      );
      assert!(
        redis.get_string(&key).await.unwrap().is_none(),
        "late deleted-user fill is evicted"
      );
      assert_eq!(commit.user.id, user.id);
      assert!(commit.user.email.is_empty());
      assert!(commit.user.avatar_url.is_none());
      let retained = store.get_historical_profile(user.id).await.unwrap().unwrap();
      assert_eq!(retained.name, user.name);
      assert!(retained.email.is_empty() && retained.avatar_url.is_none());
      assert!(matches!(
        store.set_user_disabled(user.id, false).await,
        Err(AuthError::NotFound(_))
      ));
      assert!(matches!(
        store
          .commit_password_update(user.id, "never restored".into(), Utc::now())
          .await,
        Err(AuthError::NotFound(_))
      ));
      assert!(matches!(
        store.commit_user_admin_role(user.id, true).await,
        Err(AuthError::NotFound(_))
      ));
      assert!(matches!(
        store.set_user_feature_override(user.id, "manager", true, "test").await,
        Err(AuthError::NotFound(_))
      ));
      assert_eq!(commit.revoked_session_ids, vec![session.id]);
      assert!(store.get_user_by_id(user.id).await.unwrap().is_none());
      assert!(store.get_user_by_email(&user.email).await.unwrap().is_none());
      assert!(store.get_session(session.id).await.unwrap().is_none());
      assert!(service.get_session_snapshot(session.id).await.unwrap().is_none());
      assert_eq!(*observer.users.lock().unwrap(), vec![(user.id, vec![session.id])]);
      assert!(store.get_workspace(sole.id).await.unwrap().is_none());
      assert!(!store.workspace_root_doc_exists(sole.id).await.unwrap());
      assert_eq!(
        store.get_workspace(shared.id).await.unwrap().unwrap().owner_user_id,
        None
      );
      assert!(store.workspace_root_doc_exists(shared.id).await.unwrap());
      assert_eq!(
        store
          .get_member(shared.id, survivor.id)
          .await
          .unwrap()
          .unwrap()
          .invited_by_user_id,
        Some(user.id)
      );
      assert!(store.list_user_workspaces(user.id).await.unwrap().is_empty());
      let new_user = store.fulfill_user(&user.email, Some("New signup"), None).await.unwrap();
      assert_ne!(new_user.id, user.id);
      assert!(store.list_user_workspaces(new_user.id).await.unwrap().is_empty());
      assert!(
        store
          .get_user_feature_override(new_user.id, "manager")
          .await
          .unwrap()
          .is_none()
      );
      assert!(matches!(
        service.open_app_sign_in(&old_app).await,
        Err(AuthError::InvalidToken)
      ));
      assert!(matches!(
        service.change_password(&old_reset, "New-password-2026!").await,
        Err(AuthError::InvalidToken)
      ));
      assert!(matches!(
        service.consume_magic_link_otp(&user.email, "123456", None).await,
        Err(AuthError::InvalidToken)
      ));
      assert!(
        store
          .fulfill_user(&format!("deleted:{}", user.id), None, None)
          .await
          .is_err()
      );
      assert!(matches!(
        store
          .update_user(
            user.id,
            UpdateAuthUser {
              name: Some(Some("restored".into())),
              ..Default::default()
            }
          )
          .await,
        Err(AuthError::NotFound(_))
      ));
      assert!(matches!(
        store.set_email_verified(user.id, Utc::now()).await,
        Err(AuthError::NotFound(_))
      ));
      assert!(
        store
          .add_or_update_member(
            shared.id,
            user.id,
            WorkspaceRole::Admin,
            MembershipStatus::Accepted,
            None
          )
          .await
          .is_err()
      );
      let epoch = redis
        .get_string(&AuthService::user_session_epoch_key(user.id))
        .await
        .unwrap()
        .unwrap();
      assert_eq!(epoch.starts_with("blocked:"), activation_fails);
      let missing = Uuid::new_v4();
      assert!(matches!(
        service.delete_account(missing).await,
        Err(AuthError::NotFound(_))
      ));
      assert!(
        redis
          .get_string(&AuthService::user_session_epoch_key(missing))
          .await
          .unwrap()
          .unwrap()
          .starts_with("active:"),
        "failed deletion restores the epoch"
      );
      assert_eq!(
        observer.users.lock().unwrap().len(),
        1,
        "missing target has no revocation side effect"
      );
    }
  }

  #[tokio::test]
  async fn post_commit_epoch_failure_remains_blocked() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let redis = Arc::new(TestRedis::default());
    let service = build_service(store.clone(), redis.clone());
    let user = store
      .fulfill_user("suspend-epoch-failure@example.com", Some("Suspend Epoch Failure"), None)
      .await
      .expect("create user");
    let session = service
      .create_user_session(
        user.id,
        SessionContext {
          user_agent: None,
          ip_address: None,
        },
      )
      .await
      .expect("create session");
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("prime cache")
        .is_some()
    );

    // The first write blocks the epoch; all post-commit activation retries fail.
    redis.script_sets([true, false, false, false]).await;
    service
      .suspend_user(user.id, Utc::now())
      .await
      .expect("database suspension remains committed");

    assert!(
      redis
        .get_string(&AuthService::user_session_epoch_key(user.id))
        .await
        .expect("epoch lookup")
        .is_some_and(|epoch| epoch.starts_with("blocked:")),
      "a failed post-commit epoch rotation must remain fail-closed"
    );
    assert!(
      service
        .get_session_snapshot(session.id)
        .await
        .expect("snapshot lookup")
        .is_none()
    );
    assert!(
      store
        .get_user_by_id(user.id)
        .await
        .expect("user lookup")
        .unwrap()
        .disabled
    );
  }

  #[tokio::test]
  async fn enable_user_does_not_revive_old_credentials() {
    let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
    let service = build_service(store.clone(), Arc::new(TestRedis::default()));
    let user = store
      .fulfill_user("suspend-enable@example.com", Some("Suspend Enable"), None)
      .await
      .expect("create user");
    let old_session = service
      .create_user_session(
        user.id,
        SessionContext {
          user_agent: None,
          ip_address: None,
        },
      )
      .await
      .expect("create session");

    service.suspend_user(user.id, Utc::now()).await.expect("suspend user");
    store.set_user_disabled(user.id, false).await.expect("enable user");

    assert!(
      service
        .get_session_snapshot(old_session.id)
        .await
        .expect("old session lookup")
        .is_none()
    );
    assert!(
      service
        .create_user_session(
          user.id,
          SessionContext {
            user_agent: None,
            ip_address: None,
          },
        )
        .await
        .is_ok(),
      "enabling a user must permit only newly created sessions"
    );
  }

  #[test]
  fn password_reset_tracing_excludes_callback_link_token_and_password_values() {
    let writer = TestLogWriter::default();
    // Keep two interested dispatchers registered. With only one scoped
    // dispatcher, tracing-core computes newly registered callsite interest
    // from the current thread's default; a parallel auth test without a
    // subscriber could therefore disable the production callsite mid-test.
    let _interest_guard = tracing::Dispatch::new(
      tracing_subscriber::fmt()
        .with_ansi(false)
        .without_time()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(writer.clone())
        .finish(),
    );
    let subscriber = tracing_subscriber::fmt()
      .with_ansi(false)
      .without_time()
      .with_max_level(tracing::Level::TRACE)
      .with_writer(writer.clone())
      .finish();
    let dispatch = tracing::Dispatch::new(subscriber);
    let runtime = tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .expect("test runtime");
    let callback_sentinel = "callback-secret-sentinel";
    let password_sentinel = "password-secret-sentinel";
    let (link, token) = tracing::dispatcher::with_default(&dispatch, || {
      tracing::callsite::rebuild_interest_cache();
      tracing::info!("password-reset tracing test collector active");
      runtime.block_on(async {
        let store: Arc<dyn AuthStore> = Arc::new(InMemoryAuthStore::default());
        let service = build_service(store.clone(), Arc::new(TestRedis::default()));
        let user = store
          .fulfill_user("reset-log@example.com", Some("Reset Log"), None)
          .await
          .expect("create user");
        let link = service
          .create_password_reset_link(
            user.id,
            "https://workspace.example.test",
            Some(&format!("/auth/changePassword?returnTo={callback_sentinel}")),
          )
          .await
          .expect("reset link");
        let token = url::Url::parse(&link.url)
          .expect("link URL")
          .query_pairs()
          .find(|(key, _)| key == "token")
          .map(|(_, value)| value.into_owned())
          .expect("token");

        service
          .change_password(&token, password_sentinel)
          .await
          .expect("password reset");
        (link.url, token)
      })
    });

    let logs = String::from_utf8(writer.0.lock().expect("test log lock").clone()).expect("UTF-8 logs");
    assert!(
      logs.contains("password-reset tracing test collector active"),
      "the test-local tracing collector must be active"
    );
    assert!(
      logs.contains("password changed successfully"),
      "the capture must observe the exercised reset path"
    );
    for secret in [&link, &token, callback_sentinel, password_sentinel] {
      assert!(
        !logs.contains(secret),
        "password-reset tracing leaked a protected value"
      );
    }
  }

  /// API-RV-05c: External callback URLs must be rejected.
  #[test]
  fn magic_link_callback_rejects_external_urls() {
    assert!(validate_magic_link_callback("https://attacker.example/phish").is_err());
    assert!(validate_magic_link_callback("http://evil.com/token").is_err());
    assert!(validate_magic_link_callback("//evil.com/proto-relative").is_err());
    assert!(validate_magic_link_callback("javascript:alert(1)").is_err());
    assert!(validate_magic_link_callback("data:text/html,<script>").is_err());
  }

  /// API-RV-05c: Relative callback URLs must be accepted.
  #[test]
  fn magic_link_callback_accepts_relative_paths() {
    assert!(validate_magic_link_callback("/magic-link").is_ok());
    assert!(validate_magic_link_callback("/auth/callback?foo=bar").is_ok());
    assert!(validate_magic_link_callback("/").is_ok());
  }
}
