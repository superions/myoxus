//! Core domain entity types for Myoxus.
//!
//! Contains all plain-data structs and enums that model the business domain:
//! users, workspaces, workspace memberships, documents, blobs, comments,
//! calendar data, Copilot sessions/messages, notifications, search documents,
//! organizations, and their associated role/status enums. These types are
//! dependency-free (no persistence or network concerns) and are shared across
//! all crates.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::*;
use crate::workspace_tags::WorkspaceTagSearchProjection;

/// Whether a user account is active or administratively disabled.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AccountStatus {
  Active,
  Disabled,
}

/// A registered user account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
  pub id: UserId,
  /// Primary email address. Used for login, notifications, and OAuth linking.
  pub email: String,
  pub name: String,
  /// Bcrypt-hashed password. `None` for OAuth-only accounts that have never set a password.
  pub password_hash: Option<String>,
  /// Public avatar image URL served directly (e.g. from an OAuth provider).
  pub avatar_url: Option<String>,
  /// Storage key for the avatar blob managed by Myoxus (takes precedence over `avatar_url`).
  pub avatar_key: Option<String>,
  pub status: AccountStatus,
  /// When `true` the user has access to the admin panel and all admin GraphQL resolvers.
  pub is_admin: bool,
  /// `false` for placeholder accounts created during workspace invitations that the user
  /// has not yet accepted. Becomes `true` after the user completes registration.
  pub registered: bool,
  /// Soft-disable flag. When `true` the user cannot log in regardless of `status`.
  pub disabled: bool,
  pub email_verified_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// An active login session token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
  pub id: SessionId,
  pub user_id: UserId,
  /// CSRF protection token paired with this session. Must be submitted with state-mutating requests.
  pub csrf_token: Option<String>,
  pub user_agent: Option<String>,
  pub ip_address: Option<String>,
  /// Hard expiry — session is invalid after this timestamp regardless of activity.
  pub expires_at: DateTime<Utc>,
  /// Soft threshold — sessions are proactively refreshed when their remaining lifetime
  /// falls below this point.
  pub refresh_after: DateTime<Utc>,
  /// Set when the session is explicitly logged out or invalidated by an admin.
  pub revoked_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
}

/// Purpose of a short-lived verification token sent via email.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum VerificationTokenKind {
  VerifyEmail,
  ChangeEmail,
  ChangePassword,
  SetPassword,
  MagicLink,
}

/// A single-use token sent via email for account actions such as email verification
/// or password reset.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationToken {
  pub id: VerificationTokenId,
  pub user_id: Option<UserId>,
  pub kind: VerificationTokenKind,
  /// SHA-256 hash of the raw token value. The raw value is never stored.
  pub token_hash: String,
  /// Target email address for `ChangeEmail` tokens.
  pub email: Option<String>,
  pub expires_at: DateTime<Utc>,
  /// Set when the token is consumed. A non-`None` value means the token is spent.
  pub used_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
}

/// A long-lived API access token for programmatic access (CLI, integrations).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessToken {
  pub id: AccessTokenId,
  pub user_id: UserId,
  /// Human-readable label shown in the UI (e.g. "CI/CD bot").
  pub name: String,
  /// SHA-256 hash of the raw token. Never stored in plain text.
  pub token_hash: String,
  /// First few characters of the raw token shown in the UI for identification.
  pub revealed_prefix: Option<String>,
  pub last_used_at: Option<DateTime<Utc>>,
  /// `None` means the token never expires.
  pub expires_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
}

/// An OAuth provider account linked to a Myoxus user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectedAccount {
  pub id: ConnectedAccountId,
  pub user_id: UserId,
  /// Provider identifier (e.g. `"google"`, `"github"`, or a custom provider name).
  pub provider: String,
  /// Opaque user identifier issued by the provider (e.g. Google `sub` claim).
  pub provider_account_id: String,
  /// Email address reported by the provider at link time (may differ from `User.email`).
  pub provider_email: Option<String>,
  pub created_at: DateTime<Utc>,
}

/// A time-limited one-time password for magic-link / passwordless login.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MagicLinkOtp {
  pub id: MagicLinkOtpId,
  pub email: String,
  /// PBKDF2/bcrypt hash of the raw OTP code.
  pub otp_hash: String,
  /// Random nonce generated by the client, echoed back to tie the OTP to a browser session.
  pub client_nonce: Option<String>,
  /// Number of failed verification attempts. Used for rate-limiting.
  pub attempts: i32,
  /// When set, all verification attempts are rejected until this timestamp.
  pub locked_until: Option<DateTime<Utc>>,
  pub expires_at: DateTime<Utc>,
  /// Set when the OTP is successfully consumed.
  pub consumed_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
}

/// Permanent policy for implicit initial-content provisioning; explicit user
/// document and Library operations retain their native authorization.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceInitialContentPolicy {
  #[default]
  LegacyDefaults,
  Empty,
}

/// A collaborative workspace — the top-level container for docs, members, and settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
  #[serde(default)]
  pub initial_content_policy: WorkspaceInitialContentPolicy,
  pub id: WorkspaceId,
  /// `None` when the workspace is orphaned (owner account was deleted).
  pub owner_user_id: Option<UserId>,
  pub name: String,
  /// Plain-text description shown on authenticated and public workspace starts.
  pub description: String,
  #[serde(default)]
  pub overview_settings: crate::workspace_overview::WorkspaceOverviewSettings,
  #[serde(default)]
  pub overview_revision: i64,
  /// Storage key for the workspace avatar blob.
  pub avatar_key: Option<String>,
  /// When `true`, the workspace is discoverable and readable without authentication.
  pub public: bool,
  pub enable_ai: bool,
  pub enable_sharing: bool,
  pub enable_url_preview: bool,
  pub enable_doc_embedding: bool,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  /// Soft-delete timestamp. Non-`None` means the workspace is deleted and hidden from normal queries.
  pub deleted_at: Option<DateTime<Utc>>,
}

/// Permission level for a workspace member. Higher values grant more access.
/// Variants are ordered so that `>=` comparisons can be used for permission checks.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[repr(i32)]
pub enum WorkspaceRole {
  /// No workspace access (user is not a member or has been removed).
  External = -99,
  /// Read-only access: can view and sync workspace content, cannot create or edit.
  Reader = 0,
  /// Can read and comment on docs, but cannot edit content.
  Commenter = 1,
  /// Standard member: can create, edit, and delete docs they own.
  Collaborator = 5,
  /// Can manage doc properties and doc users (publish, ACL) but NOT workspace ops-admin.
  Manager = 8,
  /// Workspace administrator: can manage members, settings, and other members' content.
  Admin = 10,
  /// Workspace owner: full control including deletion and ownership transfer.
  Owner = 99,
}

/// Lifecycle state of a workspace membership invitation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MembershipStatus {
  /// Invitation sent, waiting for the invitee to accept.
  Pending,
  UnderReview,
  AllocatingSeat,
  NeedMoreSeat,
  /// Invitation accepted and member is fully active.
  Accepted,
  /// Membership revoked by an admin or the member themselves.
  Revoked,
}

/// Raw membership record linking a user to a workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceMembership {
  pub workspace_id: WorkspaceId,
  pub user_id: UserId,
  pub role: WorkspaceRole,
  pub status: MembershipStatus,
  pub invited_by_user_id: Option<UserId>,
  pub joined_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// A fully resolved workspace member (membership + user profile joined).
#[derive(Debug, Clone)]
pub struct WorkspaceMember {
  pub workspace_id: WorkspaceId,
  /// Retained inviter for acceptance notifications, including pending outbox retries.
  pub invited_by_user_id: Option<UserId>,
  pub user: User,
  pub role: WorkspaceRole,
  pub status: MembershipStatus,
  pub invite_id: uuid::Uuid,
}

/// P-DB-29R: lightweight projection of a workspace member used by the
/// Notion People resolution pass. Carries only the data needed to
/// match a display identity against the active membership without
/// pulling full user rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceMemberLookupRow {
  pub user_id: UserId,
  pub display_name: String,
  /// Email-style handle, when known; `None` means the user has no
  /// verifiable handle and matching has to fall back to the display
  /// name alone.
  pub handle: Option<String>,
}

/// A shareable, token-based invitation link for a workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInviteLink {
  pub id: InviteLinkId,
  pub workspace_id: WorkspaceId,
  pub created_by_user_id: UserId,
  /// Deployed opaque invitation token; the historical column name is retained.
  pub token_hash: String,
  /// `None` means the link never expires.
  pub expires_at: Option<DateTime<Utc>>,
  /// Set when an admin explicitly revokes the link.
  pub revoked_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum DocDefaultRole {
  Viewer,
  Editor,
}

/// A collaborative document within a workspace or user's personal space.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Doc {
  /// Global server-internal surrogate key used by downstream foreign keys.
  pub id: DocId,
  /// Client-visible key, unique only within `workspace_id` or userspace owner.
  pub external_id: String,
  /// The workspace this doc belongs to. `None` for personal (userspace) docs.
  pub workspace_id: Option<WorkspaceId>,
  /// Set for personal docs: the user who owns this doc in their private space.
  pub userspace_owner_id: Option<UserId>,
  pub title: String,
  /// Arbitrary JSON metadata (icon, cover image, page mode, etc.).
  pub meta: Value,
  /// When `true` the doc is inaccessible to all users pending admin review.
  pub blocked: bool,
  /// Marks the synthetic root document of a workspace (one per workspace).
  pub is_workspace_root: bool,
  /// Sharing visibility mode: `None` (private), `"public"`, `"edge"`, etc.
  pub public_mode: Option<String>,
  pub default_role: DocDefaultRole,
  pub created_by: Option<UserId>,
  pub updated_by: Option<UserId>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  /// Soft-delete timestamp. Non-`None` means the doc is in the trash.
  pub deleted_at: Option<DateTime<Utc>>,
}

/// Fine-grained access level on a single document. Higher values grant more access.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[repr(i32)]
pub enum DocRole {
  /// No access — used as a sentinel for permission denials.
  None = -32768,
  /// External (public read-only) access.
  External = 0,
  /// Can read and sync the document but cannot comment or edit.
  Reader = 10,
  /// Can comment on the document but cannot edit content.
  Commenter = 15,
  /// Can read and edit the document content.
  Editor = 20,
  /// Can edit content and manage the document's ACL entries.
  Manager = 30,
  /// Full control including deletion and ACL management.
  Owner = 99,
}

/// A point-in-time Yjs snapshot of a document, used for history and rollback.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocHistory {
  pub id: DocHistoryId,
  pub doc_id: DocId,
  pub workspace_id: WorkspaceId,
  /// Encoded Yjs document state vector snapshot.
  pub snapshot: Vec<u8>,
  pub created_at: DateTime<Utc>,
}

/// An incremental Yjs update that has been applied to a document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocUpdate {
  pub id: DocUpdateId,
  pub doc_id: DocId,
  pub workspace_id: WorkspaceId,
  /// Encoded Yjs update binary payload.
  pub payload: Vec<u8>,
  pub server_timestamp: DateTime<Utc>,
  /// Monotonically increasing sequence number within a document.
  pub sequence: i64,
}

/// A binary blob (file attachment, avatar, etc.) stored in the blob storage backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Blob {
  pub id: BlobId,
  pub workspace_id: WorkspaceId,
  /// Logical storage key (path within the bucket/filesystem).
  pub key: String,
  pub mime_type: Option<String>,
  pub size_bytes: i64,
  /// SHA-256 hex checksum of the content. Used for integrity verification.
  pub checksum: Option<String>,
  /// Which backend holds this blob (`"local"`, `"s3"`, `"r2"`).
  pub storage_backend: String,
  pub uploaded_by: Option<UserId>,
  pub created_at: DateTime<Utc>,
  /// Soft-delete timestamp. Non-`None` means the blob is marked for deletion.
  pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum MultipartUploadState {
  Created,
  Completed,
  Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultipartUpload {
  pub id: MultipartUploadId,
  pub workspace_id: WorkspaceId,
  pub blob_id: Option<BlobId>,
  pub upload_key: String,
  pub provider_upload_id: Option<String>,
  pub state: MultipartUploadState,
  pub created_at: DateTime<Utc>,
  pub completed_at: Option<DateTime<Utc>>,
  pub aborted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentAttachment {
  pub id: CommentAttachmentId,
  pub workspace_id: WorkspaceId,
  pub doc_id: DocId,
  pub comment_id: Option<CommentId>,
  pub storage_key: String,
  pub mime_type: Option<String>,
  pub size_bytes: i64,
  pub created_by: UserId,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
  pub id: CommentId,
  pub workspace_id: WorkspaceId,
  pub doc_id: DocId,
  pub parent_comment_id: Option<CommentId>,
  pub author_id: UserId,
  pub body: Value,
  pub resolved: bool,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
  pub id: NotificationId,
  pub user_id: UserId,
  pub notification_type: String,
  pub notification_level: String,
  pub idempotency_key: Option<String>,
  pub payload: Value,
  pub read_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutboxEventType {
  Mention,
  Invite,
  CommentReply,
  AccessChange,
  DocUpdated,
  WorkspaceDocBroadcast,
  WorkspaceContentPublished,
  HistoryCaptured,
  CalendarMail,
  DatabaseTaskNotification,
  WorkspaceAutomationTrigger,
  WorkspaceAutomationSignal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxEvent {
  pub id: uuid::Uuid,
  pub aggregate_type: String,
  pub aggregate_id: String,
  pub event_type: OutboxEventType,
  pub payload: Value,
  pub created_at: DateTime<Utc>,
  pub processed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchDocument {
  pub workspace_id: WorkspaceId,
  pub doc_id: DocId,
  pub title: String,
  pub plain_text: String,
  #[serde(default)]
  pub workspace_tags: Vec<WorkspaceTagSearchProjection>,
  pub search_vector: Option<String>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarAccount {
  pub id: CalendarAccountId,
  pub user_id: UserId,
  pub provider: String,
  pub remote_account_id: String,
  pub access_token_ciphertext: Option<String>,
  pub refresh_token_ciphertext: Option<String>,
  pub expires_at: Option<DateTime<Utc>>,
  pub config: Value,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Structured Google Calendar webhook channel registration.
///
/// Stored as JSONB in `calendar_subscriptions.webhook_channel_json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WebhookChannelInfo {
  /// Google-assigned channel identifier (UUID we generate).
  pub channel_id: String,
  /// Google-assigned resource identifier.
  pub resource_id: String,
  /// UTC timestamp when this channel expires.
  pub expiry: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarSubscription {
  pub id: CalendarSubscriptionId,
  pub account_id: CalendarAccountId,
  pub remote_calendar_id: String,
  /// Legacy TEXT channel identifier (kept for backward compat).
  pub webhook_channel: Option<String>,
  /// Structured webhook channel info (channel_id + resource_id + expiry).
  pub webhook_channel_json: Option<WebhookChannelInfo>,
  pub sync_token: Option<String>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceCalendar {
  pub workspace_id: WorkspaceId,
  pub account_id: CalendarAccountId,
  pub remote_calendar_id: String,
  pub enabled: bool,
  pub updated_at: DateTime<Utc>,
}

/// Whether a calendar event was authored natively in Myoxus or pulled from an
/// external provider (CalDAV / Google Calendar).
///
/// `native` events have `account_id`/`remote_event_id` = NULL.
/// `external` events always have both set (enforced by DB CHECK constraint
/// `ck_calendar_events_origin_consistency` — INV-CAL-NATIVE-01).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalendarEventOrigin {
  Native,
  External,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEvent {
  pub id: CalendarEventId,
  /// Discriminator: `native` = workspace-authored; `external` = provider-synced.
  pub origin: CalendarEventOrigin,
  /// NULL for native events; NOT NULL for external events.
  pub account_id: Option<CalendarAccountId>,
  pub workspace_id: Option<WorkspaceId>,
  /// NULL for native events; NOT NULL for external events.
  pub remote_event_id: Option<String>,
  pub starts_at: DateTime<Utc>,
  pub ends_at: DateTime<Utc>,
  pub title: Option<String>,
  pub description: Option<String>,
  /// Structured description as a Virgultum block-suite delta (native events only).
  pub description_delta: Option<Value>,
  pub location: Option<String>,
  pub source_doc_id: Option<DocId>,
  /// True when the event spans the whole day (time part is ignored).
  pub all_day: bool,
  /// True when the event implicitly involves every workspace member
  /// (INV-CAL-ALL-MEMBERS-01 — `calendar_event_participants` not populated).
  pub all_members: bool,
  /// Optional tag assigned to this event (native events only).
  pub tag_id: Option<CalendarEventTagId>,
  /// ID of the parent recurring event (native events only).
  pub recurrence_parent_id: Option<CalendarEventId>,
  pub participants: Vec<CalendarEventParticipant>,
  pub reminders: Vec<CalendarReminder>,
  pub payload: Value,
  pub updated_at: DateTime<Utc>,
  /// ETag from the remote CalDAV / Google Calendar server.
  pub etag: Option<String>,
  /// Canonical address of the event on the remote server.
  pub remote_href: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEventInstance {
  pub id: CalendarEventInstanceId,
  pub event_id: CalendarEventId,
  /// Concrete start time for this recurrence occurrence.
  pub instance_start: DateTime<Utc>,
  /// Concrete end time for this recurrence occurrence.
  pub instance_end: DateTime<Utc>,
  /// `true` when this row is a RECURRENCE-ID exception (provider-level override).
  pub is_override: bool,
  /// `true` when the provider has cancelled this specific occurrence.
  pub is_cancelled: bool,
  /// Field-level overrides from an exception VEVENT (RECURRENCE-ID).
  pub override_payload: Option<Value>,
  /// Row creation timestamp.
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEventParticipant {
  pub id: CalendarEventParticipantId,
  pub event_id: CalendarEventId,
  pub user_id: Option<UserId>,
  pub email: String,
  pub display_name: Option<String>,
  pub response_status: String,
  pub is_organizer: bool,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarReminder {
  pub id: CalendarReminderId,
  pub event_id: CalendarEventId,
  pub channel: String,
  pub minutes_before: i32,
  pub scheduled_for: DateTime<Utc>,
  pub delivered_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Delivery context for a calendar reminder: all data needed by the
/// [`CalendarReminderDispatcher`] to route notification to the correct channel
/// without additional round-trips.
#[derive(Debug, Clone)]
pub struct CalendarReminderContext {
  /// The reminder that is being dispatched.
  pub reminder: CalendarReminder,
  /// ID of the user who owns the calendar account.
  pub user_id: UserId,
  /// Email address of the user (for email channel).
  pub user_email: String,
  /// Human-readable event title (may be empty if not set).
  pub event_title: String,
  /// When the event starts.
  pub starts_at: DateTime<Utc>,
}

/// A user-defined label that can be applied to native calendar events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEventTag {
  pub id: CalendarEventTagId,
  pub workspace_id: WorkspaceId,
  pub name: String,
  /// CSS hex colour string (e.g. `"#E57373"`).
  pub color: String,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Per-workspace calendar settings (native calendar feature).
///
/// One row per workspace; absence means defaults apply.
/// Schema source: the canonical Calendar schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceCalendarSettings {
  pub workspace_id: WorkspaceId,
  /// When set, native event mutations are pushed to this CalDAV subscription
  /// (INV-CAL-WRITEBACK-01).
  pub writeback_subscription_id: Option<CalendarSubscriptionId>,
  /// Default reminder lead time in minutes (e.g. 15 = 15 min before start).
  /// `None` = no automatic reminder.
  pub default_reminder_offset_minutes: Option<i32>,
  pub updated_at: DateTime<Utc>,
}

/// A detected conflict between a local calendar event and the current remote
/// server version.  Returned when an optimistic-lock ETag precondition fails.
#[derive(Debug, Clone)]
pub struct CalendarConflict {
  /// Local event ID.
  pub event_id: CalendarEventId,
  /// The local (ours) version of the event.
  pub local_version: CalendarEvent,
  /// The server's (theirs) current version of the event.
  pub remote_version: CalendarEvent,
}

/// A deferred calendar write operation in the offline queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarPendingWrite {
  pub id: uuid::Uuid,
  /// Live source event for create/update and legacy delete jobs. Detached
  /// delete jobs retain their source identity in [`CalendarDeleteSnapshot`].
  pub event_id: Option<CalendarEventId>,
  /// `"create"`, `"update"`, or `"delete"`.
  pub operation: String,
  /// Provider-specific context needed to replay the operation.
  pub payload: Option<Value>,
  pub created_at: DateTime<Utc>,
  pub retry_count: i32,
  pub next_retry_at: Option<DateTime<Utc>>,
  pub last_error: Option<String>,
}

/// Credential-free routing snapshot for a remote delete after its local event
/// has been removed. Account credentials remain repository-owned and are
/// resolved by the provider adapter when the delete is executed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarDeleteSnapshot {
  pub schema_version: u8,
  pub source_event_id: CalendarEventId,
  pub provider: String,
  pub account_id: uuid::Uuid,
  pub calendar_id: String,
  pub remote_href: String,
  pub remote_uid: String,
  pub etag: String,
}

impl CalendarDeleteSnapshot {
  pub const SCHEMA_VERSION: u8 = 1;

  /// Reject incomplete or future payloads instead of reinterpreting them as a
  /// currently executable delete request.
  pub fn validate(&self) -> Result<(), &'static str> {
    if self.schema_version != Self::SCHEMA_VERSION {
      return Err("unsupported calendar delete snapshot version");
    }
    if self.provider.trim().is_empty()
      || self.calendar_id.trim().is_empty()
      || self.remote_href.trim().is_empty()
      || self.remote_uid.trim().is_empty()
      || self.etag.trim().is_empty()
    {
      return Err("calendar delete snapshot is incomplete");
    }
    Ok(())
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotSession {
  pub id: CopilotSessionId,
  pub user_id: UserId,
  pub workspace_id: Option<WorkspaceId>,
  pub doc_id: Option<DocId>,
  pub title: Option<String>,
  pub model: Option<String>,
  pub pinned: bool,
  pub archived_at: Option<DateTime<Utc>>,
  pub deleted_at: Option<DateTime<Utc>>,
  pub metadata: Value,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// All predicates apply before paging. Action/fork mean a recorded nonempty
/// metadata string, not a classification inferred from old prompts or messages.
#[derive(Debug, Clone, Default)]
pub struct CopilotSessionFilter {
  pub workspace_id: Option<WorkspaceId>,
  pub doc_id: Option<DocId>,
  pub session_id: Option<CopilotSessionId>,
  pub pinned: Option<bool>,
  pub action: Option<bool>,
  pub fork: Option<bool>,
  pub include_archived: bool,
  pub ascending: bool,
}

impl CopilotSessionFilter {
  pub fn matches(&self, session: &CopilotSession) -> bool {
    let recorded = |key: &str| {
      session
        .metadata
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
    };
    session.deleted_at.is_none()
      && (self.include_archived || session.archived_at.is_none())
      && self.workspace_id.is_none_or(|id| session.workspace_id == Some(id))
      && self.doc_id.is_none_or(|id| session.doc_id == Some(id))
      && self.session_id.is_none_or(|id| session.id == id)
      && self.pinned.is_none_or(|value| session.pinned == value)
      && self.action.is_none_or(|value| recorded("action") == value)
      && self.fork.is_none_or(|value| recorded("parentSessionId") == value)
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CopilotSessionAccessScope {
  pub workspace_id: Option<WorkspaceId>,
  pub doc_id: Option<DocId>,
}

/// A bounded page and complete matching count from one repository snapshot.
/// Interactive callers must authorize every distinct matching scope before
/// publishing even the count; an unreadable off-page session still fails closed.
#[derive(Debug, Clone)]
pub struct CopilotSessionPage {
  pub sessions: Vec<CopilotSession>,
  pub total_count: i64,
  pub access_scopes: Vec<CopilotSessionAccessScope>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CopilotMessageRole {
  System,
  User,
  Assistant,
  Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CopilotToolCallStatus {
  Queued,
  Running,
  Completed,
  Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotToolCall {
  pub id: uuid::Uuid,
  pub message_id: CopilotMessageId,
  pub tool_name: String,
  pub args: Value,
  pub status: CopilotToolCallStatus,
  pub result: Option<Value>,
  pub error: Option<String>,
  pub started_at: Option<DateTime<Utc>>,
  pub finished_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotAttachmentRef {
  pub id: uuid::Uuid,
  pub message_id: CopilotMessageId,
  pub blob_key: String,
  pub file_name: Option<String>,
  pub mime_type: Option<String>,
  pub size_bytes: Option<i64>,
  pub metadata: Value,
  pub created_at: DateTime<Utc>,
}

/// Generated output stays distinct from incoming image attachments.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CopilotFileFormat {
  Pdf,
  Html,
}

impl CopilotFileFormat {
  pub fn extension(self) -> &'static str {
    match self {
      Self::Pdf => "pdf",
      Self::Html => "html",
    }
  }
  pub fn media_type(self) -> &'static str {
    match self {
      Self::Pdf => "application/pdf",
      Self::Html => "text/html; charset=utf-8",
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CopilotGeneratedFileKind {
  #[serde(rename = "generated-file")]
  GeneratedFile,
}

/// Immutable source/render identity; delivery URLs are derived at read time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopilotGeneratedFileMetadata {
  pub kind: CopilotGeneratedFileKind,
  pub format: CopilotFileFormat,
  pub source_id: uuid::Uuid,
  pub source_fingerprint: String,
  pub render_fingerprint: String,
}

impl CopilotAttachmentRef {
  pub fn generated_file(&self) -> Option<CopilotGeneratedFileMetadata> {
    serde_json::from_value(self.metadata.clone()).ok()
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotMessage {
  pub id: CopilotMessageId,
  pub session_id: CopilotSessionId,
  pub role: CopilotMessageRole,
  pub content: Value,
  pub token_usage: Option<Value>,
  pub tool_calls: Vec<CopilotToolCall>,
  pub attachment_refs: Vec<CopilotAttachmentRef>,
  pub edited_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
}

/// Application-prepared chat copy and the exact source snapshot it depends on.
/// Repositories must compare the source under lock and commit all target rows
/// atomically; a concurrent edit, append or session change invalidates the copy.
#[derive(Debug, Clone)]
pub struct CopilotSessionFork {
  pub source: CopilotSession,
  pub source_messages: Vec<CopilotMessage>,
  pub session: CopilotSession,
  pub messages: Vec<CopilotMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopilotContext {
  pub id: CopilotContextId,
  pub user_id: UserId,
  pub workspace_id: Option<WorkspaceId>,
  pub name: String,
  pub metadata: Value,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CopilotContextItemType {
  Doc,
  File,
  Blob,
  Category,
  Tag,
  Collection,
  Workspace,
  Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopilotContextItem {
  pub id: CopilotContextItemId,
  pub context_id: CopilotContextId,
  pub item_type: CopilotContextItemType,
  pub item_ref: String,
  pub metadata: Value,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CopilotJobState {
  Pending,
  Claimed,
  Running,
  Finished,
  Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopilotJob {
  pub id: CopilotJobId,
  pub job_type: String,
  pub state: CopilotJobState,
  pub workspace_id: Option<WorkspaceId>,
  pub user_id: Option<UserId>,
  pub payload: Value,
  pub error_message: Option<String>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopilotWorkspaceState {
  pub workspace_id: WorkspaceId,
  pub last_embedding_at: Option<DateTime<Utc>>,
  pub ignored_doc_ids: Vec<DocId>,
  pub metadata: Value,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceAnalyticsMinute {
  pub workspace_id: WorkspaceId,
  pub bucket_at: DateTime<Utc>,
  pub active_users: i32,
  pub doc_views: i32,
  pub sync_updates: i32,
}

// ─── Organization and organization units ────────────────────────────────────

/// Tenant boundary of a Myoxus installation. Single-tenant deployments have
/// exactly one `Organization` row with `key="myoxus"` (seeded by migration
/// 0107). `OrganizationId` foreign keys on child records preserve a possible
/// future multi-tenant evolution without changing today's product model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Organization {
  pub id: crate::ids::OrganizationId,
  /// Stable idempotency key for import and export.
  pub key: String,
  pub name: String,
  pub slug: String,
  pub metadata: serde_json::Value,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Lifecycle status of an organization unit. `archived` retains hierarchy
/// while preventing operational use; `disabled` is a reversible soft-disable,
/// for example during reorganization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrganizationUnitStatus {
  Active,
  Disabled,
  Archived,
}

impl OrganizationUnitStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Active => "active",
      Self::Disabled => "disabled",
      Self::Archived => "archived",
    }
  }

  pub fn parse_or_active(s: &str) -> Self {
    match s {
      "active" => Self::Active,
      "disabled" => Self::Disabled,
      "archived" => Self::Archived,
      other => {
        tracing::warn!(value = other, "unknown OrganizationUnitStatus, defaulting to Active");
        Self::Active
      }
    }
  }

  /// Whether this status may transition to `target` through the public OU
  /// lifecycle. Repeating the current status is deliberately idempotent.
  pub fn can_transition_to(self, target: Self) -> bool {
    self == target
      || matches!(
        (self, target),
        (Self::Active, Self::Disabled | Self::Archived)
          | (Self::Disabled, Self::Active | Self::Archived)
          | (Self::Archived, Self::Active)
      )
  }
}

/// Stable reasons why an organization unit cannot be deleted.
///
/// The values are API contracts shared by GraphQL, MCP and Admin. They are
/// intentionally independent of database constraint names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrganizationUnitDeletionBlockerCode {
  ChildUnits,
  Members,
  WorkspaceLinks,
  OwnerPrincipalWorkspaces,
  ManagementUnitWorkspaces,
  ProjectRequests,
  OidcGroupMappings,
}

impl OrganizationUnitDeletionBlockerCode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::ChildUnits => "CHILD_UNITS",
      Self::Members => "MEMBERS",
      Self::WorkspaceLinks => "WORKSPACE_LINKS",
      Self::OwnerPrincipalWorkspaces => "OWNER_PRINCIPAL_WORKSPACES",
      Self::ManagementUnitWorkspaces => "MANAGEMENT_UNIT_WORKSPACES",
      Self::ProjectRequests => "PROJECT_REQUESTS",
      Self::OidcGroupMappings => "OIDC_GROUP_MAPPINGS",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrganizationUnitDeletionBlocker {
  pub code: OrganizationUnitDeletionBlockerCode,
  pub count: i64,
}

/// Revision-bound deletion preview. `updated_at` is the optimistic revision
/// consumed by permanent delete; callers must not synthesize a replacement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrganizationUnitDeletionPreview {
  pub id: crate::ids::OrganizationUnitId,
  pub name: String,
  pub status: OrganizationUnitStatus,
  pub updated_at: DateTime<Utc>,
  pub deletable: bool,
  pub blockers: Vec<OrganizationUnitDeletionBlocker>,
}

/// A user's role within an organization unit.
///
/// This is independent from [`WorkspaceRole`]. An OU `Manager` may grant only
/// roles allowed by the organization-to-workspace mapping. See the permission
/// matrix in `docs/dev/server/organization-management.md` and learning
/// LRN-20260502-ORG-A-02.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrganizationUnitRole {
  Reader,
  Member,
  Manager,
}

impl OrganizationUnitRole {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Reader => "reader",
      Self::Member => "member",
      Self::Manager => "manager",
    }
  }

  pub fn parse_or_member(s: &str) -> Self {
    match s {
      "reader" => Self::Reader,
      "manager" => Self::Manager,
      "member" => Self::Member,
      other => {
        tracing::warn!(value = other, "unknown OrganizationUnitRole, defaulting to Member");
        Self::Member
      }
    }
  }
}

/// Origin of an organizational-unit membership. `manual` means an administrator
/// assigned it; all other variants are synchronization paths (delivery package H).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrganizationUnitMemberSource {
  Manual,
  Import,
  Oidc,
  Ldap,
  Scim,
}

impl OrganizationUnitMemberSource {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Manual => "manual",
      Self::Import => "import",
      Self::Oidc => "oidc",
      Self::Ldap => "ldap",
      Self::Scim => "scim",
    }
  }

  pub fn parse_or_manual(s: &str) -> Self {
    match s {
      "manual" => Self::Manual,
      "import" => Self::Import,
      "oidc" => Self::Oidc,
      "ldap" => Self::Ldap,
      "scim" => Self::Scim,
      other => {
        tracing::warn!(
          value = other,
          "unknown OrganizationUnitMemberSource, defaulting to Manual"
        );
        Self::Manual
      }
    }
  }
}

/// Relationship between an organizational unit and a workspace.
///
/// - `Owner`: domain owner; each workspace may have **exactly one** owner
///   relationship (enforced by a canonical partial unique index).
/// - `Managed`: the unit manages the workspace without necessarily owning it.
/// - `Linked`: the workspace is visibly associated, but the relationship does
///   not grant permissions by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrganizationUnitWorkspaceRelationship {
  Owner,
  Managed,
  Linked,
}

impl OrganizationUnitWorkspaceRelationship {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Owner => "owner",
      Self::Managed => "managed",
      Self::Linked => "linked",
    }
  }

  pub fn parse_or_managed(s: &str) -> Self {
    match s {
      "owner" => Self::Owner,
      "linked" => Self::Linked,
      "managed" => Self::Managed,
      other => {
        tracing::warn!(
          value = other,
          "unknown OrganizationUnitWorkspaceRelationship, defaulting to Managed"
        );
        Self::Managed
      }
    }
  }
}

/// Authoritative owner principal of a workspace.
///
/// `User` owns personal and user-owned workspaces, `Ou` owns organization
/// shared workspaces, and `System` owns technical bootstrap resources.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OwnerPrincipalType {
  User,
  Ou,
  System,
}

impl OwnerPrincipalType {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::User => "user",
      Self::Ou => "ou",
      Self::System => "system",
    }
  }

  pub fn parse(s: &str) -> Option<Self> {
    match s {
      "user" => Some(Self::User),
      "ou" => Some(Self::Ou),
      "system" => Some(Self::System),
      _ => None,
    }
  }
}

/// Capability flags of an organization-unit type. Each preset or custom type
/// defines them explicitly, including manager creation and cross-unit members.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizationUnitType {
  pub id: crate::ids::OrganizationUnitTypeId,
  pub organization_id: crate::ids::OrganizationId,
  /// Stable technical key within an organization, for example `kvg.referat`.
  pub key: String,
  /// User-visible label.
  pub label: String,
  pub description: Option<String>,
  pub icon: Option<String>,
  pub color: Option<String>,
  /// `true` for server-owned organization-unit presets.
  pub is_preset: bool,
  /// Soft-deactivation flag for types that are no longer in use.
  pub is_active: bool,
  pub is_structural: bool,
  pub can_have_children: bool,
  pub can_be_root_level: bool,
  pub can_be_manager_created: bool,
  pub can_have_cross_unit_members: bool,
  pub can_own_workspaces: bool,
  pub can_manage_workspaces: bool,
  pub is_staff_unit: bool,
  pub requires_admin_approval: bool,
  pub metadata: serde_json::Value,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// A concrete organizational unit. `parent_unit_id == None` identifies a root
/// unit within its organization. `slug` is unique per
/// `(organization_id, parent_unit_id)` tuple through a partial unique index.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizationUnit {
  pub id: crate::ids::OrganizationUnitId,
  pub organization_id: crate::ids::OrganizationId,
  pub parent_unit_id: Option<crate::ids::OrganizationUnitId>,
  pub unit_type_id: crate::ids::OrganizationUnitTypeId,
  pub name: String,
  pub slug: String,
  pub description: Option<String>,
  pub status: OrganizationUnitStatus,
  pub max_members: i32,
  pub metadata: serde_json::Value,
  pub created_by: Option<UserId>,
  /// Aggregate UI/API counts for tree and list projections. Repositories fill
  /// these fields on reads; newly created rows may temporarily carry `0` until
  /// they are read again.
  pub child_unit_count: i64,
  pub member_count: i64,
  pub workspace_count: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Member of an organization unit. The `(unit_id, user_id)` composite primary
/// key prevents duplicates.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizationUnitMember {
  pub unit_id: crate::ids::OrganizationUnitId,
  pub user_id: UserId,
  pub role: OrganizationUnitRole,
  pub source: OrganizationUnitMemberSource,
  pub metadata: serde_json::Value,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Organization-unit to workspace association with an explicit relationship.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizationUnitWorkspace {
  pub unit_id: crate::ids::OrganizationUnitId,
  pub workspace_id: WorkspaceId,
  pub relationship: OrganizationUnitWorkspaceRelationship,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Global organization policies. Each organization has exactly one
/// `OrganizationPolicy` row keyed by `organization_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizationPolicy {
  pub organization_id: crate::ids::OrganizationId,
  /// Policy for manager-driven root project creation. `disabled` blocks the
  /// operation, `requires_approval` creates an `OrganizationProjectRequest`,
  /// and `allowed` creates the project directly.
  pub manager_root_project_creation: PolicyState,
  /// Policy for manager-driven project creation below the manager's OU.
  pub manager_unit_project_creation: PolicyState,
  /// Globally allow managers to create workspaces below their OU.
  pub manager_can_create_workspaces: bool,
  /// Allow managers to maintain the OU member list within their scope.
  pub manager_can_manage_ou_members: bool,
  /// Whether organization import/export is enabled in Admin.
  pub import_export_enabled: bool,
  pub metadata: serde_json::Value,
  pub updated_by: Option<UserId>,
  pub updated_at: DateTime<Utc>,
}

/// Three-state policy used for project and workspace creation.
/// `RequiresApproval` creates an `OrganizationProjectRequest` instead of the
/// requested object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyState {
  Disabled,
  RequiresApproval,
  Allowed,
}

impl PolicyState {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Disabled => "disabled",
      Self::RequiresApproval => "requires_approval",
      Self::Allowed => "allowed",
    }
  }

  pub fn parse_or_disabled(s: &str) -> Self {
    match s {
      "allowed" => Self::Allowed,
      "requires_approval" => Self::RequiresApproval,
      "disabled" => Self::Disabled,
      other => {
        tracing::warn!(value = other, "unknown PolicyState, defaulting to Disabled");
        Self::Disabled
      }
    }
  }
}

/// Scope of a project-creation request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectRequestScope {
  /// Request for a project directly below the organization root.
  OrganizationRoot,
  /// Request for a project below an existing OU; `parent_unit_id` is set.
  Ou,
}

impl ProjectRequestScope {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::OrganizationRoot => "organization_root",
      Self::Ou => "ou",
    }
  }

  pub fn parse(s: &str) -> Option<Self> {
    match s {
      "organization_root" => Some(Self::OrganizationRoot),
      "ou" => Some(Self::Ou),
      _ => None,
    }
  }
}

/// Status eines Projekt-Antrags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectRequestStatus {
  Pending,
  Approved,
  Rejected,
  Cancelled,
}

impl ProjectRequestStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Pending => "pending",
      Self::Approved => "approved",
      Self::Rejected => "rejected",
      Self::Cancelled => "cancelled",
    }
  }

  pub fn parse_or_pending(s: &str) -> Self {
    match s {
      "approved" => Self::Approved,
      "rejected" => Self::Rejected,
      "cancelled" => Self::Cancelled,
      _ => Self::Pending,
    }
  }
}

/// A manager request to create a project whose `requires_approval` policy
/// requires an administrator decision. On approval, the application service
/// creates the project and its optional workspace atomically.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizationProjectRequest {
  pub id: crate::ids::OrganizationProjectRequestId,
  pub organization_id: crate::ids::OrganizationId,
  pub requested_by: UserId,
  pub requested_scope: ProjectRequestScope,
  pub parent_unit_id: Option<crate::ids::OrganizationUnitId>,
  pub proposed_name: String,
  pub proposed_type_id: Option<crate::ids::OrganizationUnitTypeId>,
  pub proposed_members: Vec<UserId>,
  pub proposed_workspace: bool,
  pub status: ProjectRequestStatus,
  pub decided_by: Option<UserId>,
  pub decided_at: Option<DateTime<Utc>>,
  pub metadata: serde_json::Value,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Map an [`OrganizationUnitRole`] to its maximum [`WorkspaceRole`] in an OU
/// workspace. This function is the single authority for that mapping; direct
/// `match` expressions elsewhere are forbidden by learning
/// LRN-20260502-ORG-A-02.
///
/// Managers are capped at `WorkspaceRole::Admin`; only system administrators
/// may elevate a member to `Owner`.
pub fn map_ou_role_to_max_workspace_role(role: OrganizationUnitRole) -> WorkspaceRole {
  match role {
    OrganizationUnitRole::Reader => WorkspaceRole::Reader,
    OrganizationUnitRole::Member => WorkspaceRole::Collaborator,
    OrganizationUnitRole::Manager => WorkspaceRole::Admin,
  }
}

// ─── MCP API Keys ─────────────────────────────────────────────────────────────

// ─── Copilot Embeddings ──────────────────────────────────────────────────────

/// The type of source document an embedding was derived from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CopilotEmbeddingSourceType {
  /// A workspace document (Yjs/block-based page).
  Doc,
  /// A file blob stored in the workspace.
  File,
  /// An attachment linked to a copilot message or comment.
  Attachment,
}

impl CopilotEmbeddingSourceType {
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::Doc => "doc",
      Self::File => "file",
      Self::Attachment => "attachment",
    }
  }

  pub fn parse_or_doc(s: &str) -> Self {
    match s {
      "doc" => Self::Doc,
      "file" => Self::File,
      "attachment" => Self::Attachment,
      other => {
        tracing::warn!(
          source_type = other,
          "unknown CopilotEmbeddingSourceType, defaulting to Doc"
        );
        Self::Doc
      }
    }
  }
}

/// A vector embedding of a text chunk from a workspace document, file, or
/// attachment. Used for semantic similarity search (RAG) in the Copilot pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopilotEmbedding {
  pub id: uuid::Uuid,
  pub workspace_id: WorkspaceId,
  /// Source type discriminator: `"doc"`, `"file"`, or `"attachment"`.
  pub source_type: CopilotEmbeddingSourceType,
  /// Identifier of the source within the workspace (doc_id, blob_key, etc.).
  pub source_id: String,
  /// Zero-based position of this chunk within the source document.
  pub chunk_index: i32,
  /// The raw text that was embedded.
  pub chunk_text: String,
  /// Approximate token count of `chunk_text` (for context window budgeting).
  pub token_count: i32,
  /// Model-specific vector; stored and queried without padding across dimensions.
  pub embedding: Vec<f32>,
  /// Model identifier used to produce this embedding.
  pub model: String,
  /// Arbitrary metadata (source filename, chunk boundaries, etc.).
  pub metadata: Value,
  pub created_at: DateTime<Utc>,
}

/// A similarity search result: an embedding row paired with its cosine distance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopilotEmbeddingMatch {
  pub embedding: CopilotEmbedding,
  /// Cosine distance from the query vector (lower = more similar).
  pub distance: f64,
}

// ─── MCP API Keys ─────────────────────────────────────────────────────────────

/// A long-lived API key for MCP (Model Context Protocol) clients.
///
/// The actual key value is issued once at creation (`myoxus_<random_32_bytes_base62>`)
/// and never stored; only its SHA-256 hash is persisted in `key_hash`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKey {
  pub id: crate::ids::ApiKeyId,
  pub user_id: UserId,
  /// Human-readable label for this key (e.g. "Claude Desktop key").
  pub name: String,
  /// SHA-256 hex digest of the raw key value. Never store the plaintext key.
  pub key_hash: String,
  /// Allowed MCP operation scopes (e.g. `["read:workspaces", "read:docs"]`).
  pub scopes: Vec<String>,
  pub created_at: DateTime<Utc>,
  /// Last time this key was used for authentication. `None` if never used.
  pub last_used_at: Option<DateTime<Utc>>,
  /// Hard expiry timestamp. `None` means the key never expires.
  pub expires_at: Option<DateTime<Utc>>,
}

/// A hybrid search result combining pgvector similarity and PostgreSQL
/// full-text search via Reciprocal Rank Fusion (RRF).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HybridSearchResult {
  pub doc_id: String,
  pub title: Option<String>,
  pub chunk_text: Option<String>,
  pub rrf_score: f64,
}

// --- PDF-Export V2 ---
// All types below mirror the canonical PDF export schema exactly.
// SQLx `FromRow` implementations live in the infrastructure crate.

/// A registered PDF export template (migration: `pdf_templates`).
///
/// The `manifest` field stores the full L2 JSON manifest (validated against
/// `pdf_template_manifest_v2.json` before insert).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PdfTemplate {
  /// Primary key — stable UUID assigned at registration time.
  pub id: uuid::Uuid,
  /// Stable kebab-case identifier (e.g. `"myoxus-report-modern"`).
  pub slug: String,
  /// Human-readable display name shown in UI pickers.
  pub name: String,
  /// Semver string declared by the template author.
  pub version: String,
  /// Manifest schema version that was validated on upload (currently `"2.0"`).
  pub schema_version: String,
  /// Full L2 JSON manifest blob as stored in the database.
  pub manifest: serde_json::Value,
  /// User who uploaded this template, or `None` for system-seeded entries
  /// (default/report/letter inserted at first server startup).
  pub created_by: Option<uuid::Uuid>,
  pub created_at: chrono::DateTime<chrono::Utc>,
  /// Set when the template is soft-deleted; `None` means the template is active.
  pub deleted_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// A single file belonging to a PDF template bundle (migration: `pdf_template_files`).
///
/// Primary key is `(template_id, file_path)`. Cascades delete when the parent
/// `pdf_templates` row is removed.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PdfTemplateFile {
  /// References `pdf_templates.id`.
  pub template_id: uuid::Uuid,
  /// Relative path within the template bundle (e.g. `"main.typ"`).
  pub file_path: String,
  /// Opendal storage key where the file content is stored.
  pub blob_key: String,
  /// SHA-256 hex digest of the file content (verified at upload time).
  pub content_hash: String,
}

/// Assignment of a PDF template to a workspace (migration: `pdf_workspace_template_assignments`).
///
/// The partial unique index `uniq_default_per_ws` enforces that at most one
/// row per `workspace_id` has `is_default = true`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PdfWorkspaceTemplateAssignment {
  pub workspace_id: uuid::Uuid,
  pub template_id: uuid::Uuid,
  /// Whether this template is the workspace-level default shown in the export picker.
  pub is_default: bool,
  /// User who created this assignment, if that account still exists.
  pub assigned_by: Option<uuid::Uuid>,
  pub assigned_at: chrono::DateTime<chrono::Utc>,
}

/// Document-branding logo slot. The slots are document-visible assets and are
/// intentionally separate from app/server shell branding slots.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PdfDocumentBrandLogoSlot {
  Large,
  Small,
}

/// Workspace-scoped document-branding and PDF-settings projection.
///
/// The storage model is split (`organization_identity`,
/// `document_brand_profiles`, `brand_assets`, `pdf_export_settings`). This flat
/// shape is retained as the application-layer render projection so PDF export
/// can resolve document-visible identity and render defaults in one pass.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PdfWorkspaceBrandAsset {
  pub workspace_id: uuid::Uuid,
  /// Opendal key for the large logo (e.g. for cover pages). PNG or SVG.
  pub logo_large_blob: Option<String>,
  /// SHA-256 of the uploaded large-logo payload. Included in render hashes so
  /// same-slot re-uploads cannot reuse stale PDF jobs.
  pub logo_large_sha256: Option<String>,
  /// Opendal key for the small logo (e.g. for running headers).
  pub logo_small_blob: Option<String>,
  /// SHA-256 of the uploaded small-logo payload.
  pub logo_small_sha256: Option<String>,
  /// Global organisation display/legal name rendered in documents. It is never
  /// workspace-overridable.
  pub company_name: Option<String>,
  /// Effective legal line: workspace document-branding override when present,
  /// otherwise the global organisation legal name.
  pub legal_text: Option<String>,
  /// Free-form footer line.
  pub footer_text: Option<String>,
  /// Effective document colour policy (`theme_palette`, `plain`, `custom`).
  pub color_policy: String,
  /// Palette key used when `color_policy` is `theme_palette` or `plain`.
  pub color_palette_key: Option<String>,
  /// Effective primary document color hex (`#RRGGBB`).
  pub brand_color_primary: Option<String>,
  /// Effective accent document color hex.
  pub brand_color_accent: Option<String>,
  /// Effective rule/stroke color used for table/header separators.
  pub brand_color_rule: Option<String>,
  /// Effective document text color.
  pub brand_color_text: Option<String>,
  /// Effective document background color.
  pub brand_color_background: Option<String>,
  /// Default paper size for exports from this workspace (e.g. `"A4"`, `"Letter"`).
  pub default_paper_size: Option<String>,
  /// Default BCP-47 locale (e.g. `"en"`, `"de"`).
  pub default_locale: Option<String>,
  /// Default color profile (`"sRGB"`, `"CMYK_FOGRA39"`, `"CMYK_SWOP"`).
  pub default_color_profile: Option<String>,
  /// Default image quality tier (`"low"`, `"med"`, `"high"`, `"lossless"`).
  pub default_image_quality: Option<String>,
  /// Whether OpenType ligatures are enabled by default for this workspace.
  pub ligatures_enabled: bool,
  /// The template shown as the pre-selected default in the workspace's export picker.
  pub default_template_id: Option<uuid::Uuid>,
  pub updated_at: chrono::DateTime<chrono::Utc>,
  /// User who last modified these brand assets.
  pub updated_by: uuid::Uuid,
}

/// One audit-log entry recorded by the PDF-Export V2 render pipeline
/// (migration: `pdf_export_render_audit`).
///
/// Compliance-mandated trail — every successful start of an export job
/// produces exactly one row. Independent of [`super::audit::AuditEvent`],
/// which is the admin-config-mutation channel; this table tracks
/// **render activity**, not admin configuration.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PdfExportRenderAudit {
  pub id: uuid::Uuid,
  pub job_id: uuid::Uuid,
  pub actor_id: uuid::Uuid,
  pub workspace_id: uuid::Uuid,
  pub doc_id: uuid::Uuid,
  /// Optional human-readable doc-version label captured at render time.
  /// `None` when doc-versioning is off for the workspace.
  pub doc_version_label: Option<String>,
  /// Resolved document-version UUID captured at render time. Unlike the
  /// user-submitted selector this always points at the exact named snapshot
  /// rendered by the export.
  pub document_version_id: Option<uuid::Uuid>,
  /// FK to the V2 template if the render went through the V2 path; `None`
  /// for legacy slug-based renders.
  pub template_id: Option<uuid::Uuid>,
  /// Free-form template version captured at render time. Stays
  /// meaningful even after the source template row is replaced.
  pub template_version: String,
  /// Hex SHA-256 of the effective render appearance snapshot.
  ///
  /// This covers document branding plus the resolved Theme DB typography/font
  /// assets that can change rendered pixels. PDF export policy fields such as
  /// paper size, ICC profile or image quality are audited separately.
  pub render_appearance_hash: String,
  pub locale: String,
  /// Optional confidentiality / classification label active for the
  /// render (e.g. `"Internal"`).
  pub classification: Option<String>,
  /// Snapshot of the L3 inputs the user submitted with the render.
  pub l3_inputs: serde_json::Value,
  /// Renderer-facing document metadata snapshot captured after server-side
  /// export validation and, for `latest`, after auto-version creation.
  pub document_metadata_snapshot: serde_json::Value,
  /// The validation result that allowed the export to proceed.
  pub metadata_validation: serde_json::Value,
  pub created_at: chrono::DateTime<chrono::Utc>,
}

/// A font available in the server-side PDF font library (migration: `pdf_fonts`).
///
/// Each font variant (e.g. Bold Italic of a family) is a separate row. Bundled
/// system fonts use `uploaded_by = None`; admin uploads carry the uploader.
/// The `sha256` column carries a UNIQUE constraint so duplicates are rejected.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PdfFont {
  pub id: uuid::Uuid,
  /// Font family name (e.g. `"IBM Plex Sans"`).
  pub family_name: String,
  /// Style string (e.g. `"Regular"`, `"Italic"`).
  pub style: String,
  /// Numeric CSS-compatible weight (100–900).
  pub weight: i32,
  /// Opendal storage key for the font binary.
  pub blob_key: String,
  /// SHA-256 hex digest of the font binary (unique; used for dedup).
  pub sha256: String,
  /// SPDX-style license identifier.
  pub license: PdfFontLicense,
  /// Approval status — new fonts start as `Pending`.
  pub license_status: PdfFontLicenseStatus,
  pub uploaded_by: Option<uuid::Uuid>,
  pub uploaded_at: chrono::DateTime<chrono::Utc>,
  /// Set by a super-admin when `license_status` moves to `Approved` or `Rejected`.
  pub approved_by: Option<uuid::Uuid>,
  pub approved_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// SPDX-style license identifier for an uploaded font.
///
/// Common open-source licenses have dedicated variants so code can branch on
/// them without string matching. Unknown / proprietary licenses fall into
/// `Other(String)` which round-trips the raw license text.
///
/// Serialises to/from its string representation:
/// `"OFL-1.1"`, `"Apache-2.0"`, `"MIT"`, `"GPL"`, `"Proprietary"`, or an
/// arbitrary string for `Other`.
#[derive(Debug, Clone, PartialEq)]
pub enum PdfFontLicense {
  /// SIL Open Font License 1.1.
  Ofl11,
  /// Apache License 2.0.
  Apache20,
  /// MIT License.
  Mit,
  /// GNU General Public License (any version).
  Gpl,
  /// Proprietary / commercial font with explicit permission.
  Proprietary,
  /// Any other license — stored verbatim and round-trips without transformation.
  Other(String),
}

impl serde::Serialize for PdfFontLicense {
  fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
    let text = match self {
      Self::Ofl11 => "OFL-1.1",
      Self::Apache20 => "Apache-2.0",
      Self::Mit => "MIT",
      Self::Gpl => "GPL",
      Self::Proprietary => "Proprietary",
      Self::Other(v) => v.as_str(),
    };
    s.serialize_str(text)
  }
}

impl<'de> serde::Deserialize<'de> for PdfFontLicense {
  fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
    let s = String::deserialize(d)?;
    Ok(match s.as_str() {
      "OFL-1.1" => Self::Ofl11,
      "Apache-2.0" => Self::Apache20,
      "MIT" => Self::Mit,
      "GPL" => Self::Gpl,
      "Proprietary" => Self::Proprietary,
      other => Self::Other(other.to_owned()),
    })
  }
}

/// Approval workflow state for a font's license review (migration: `pdf_fonts.license_status`).
///
/// The SQL column has a CHECK constraint: `license_status IN ('pending', 'approved', 'rejected')`.
/// Serde uses `rename_all = "lowercase"` so the values round-trip with that constraint.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PdfFontLicenseStatus {
  /// Uploaded but not yet reviewed by a super-admin.
  Pending,
  /// Reviewed and approved for use in PDF exports.
  Approved,
  /// Reviewed and rejected (font must not be used for rendering).
  Rejected,
}

// --- Document Metadata + Versioning ---
// All types below mirror the document metadata target model introduced by
// P-DOC-ATTR-B. The existing document-version structs are extended in place so
// API/CLI/MCP callers cannot accidentally fork a second version model.
// SQLx `FromRow` implementations live in the infrastructure crate.
// Delivery package: P-DOC-ATTR-C

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentStatusSchema {
  pub id: uuid::Uuid,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub complexity: String,
  pub is_preset: bool,
  pub is_active: bool,
  pub metadata: serde_json::Value,
}

/// Editable projection mapping on the native status definition, independent of
/// its key, label and workflow terminal flag.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentOkfStatus {
  #[default]
  Draft,
  Stable,
  Deprecated,
}

impl DocumentOkfStatus {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Draft => "draft",
      Self::Stable => "stable",
      Self::Deprecated => "deprecated",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentStatusValue {
  pub id: uuid::Uuid,
  pub schema_id: uuid::Uuid,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub color: Option<String>,
  pub icon: Option<String>,
  pub sort_order: i32,
  pub terminal: bool,
  pub is_active: bool,
  pub metadata: serde_json::Value,
  #[serde(default)]
  pub okf_status: DocumentOkfStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentStatusTransition {
  pub from_status_id: uuid::Uuid,
  pub to_status_id: uuid::Uuid,
  pub required_roles: Vec<String>,
  pub required_metadata_fields: Vec<String>,
  pub creates_version: String,
  pub sets_version_kind: Option<DocumentVersionKind>,
  pub date_enforcement: String,
  pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataFieldDefinition {
  pub key: String,
  pub label: String,
  pub enabled: bool,
  pub required_mode: String,
  pub editable_by: String,
  pub visible_in_header: bool,
  pub visible_in_properties: bool,
  pub visible_in_lists: bool,
  pub export_mode: String,
  pub validation_config: serde_json::Value,
  pub metadata: serde_json::Value,
  pub updated_by: Option<uuid::Uuid>,
  pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataFieldDefinitionPatch {
  pub label: Option<String>,
  pub enabled: Option<bool>,
  pub required_mode: Option<String>,
  pub editable_by: Option<String>,
  pub visible_in_header: Option<bool>,
  pub visible_in_properties: Option<bool>,
  pub visible_in_lists: Option<bool>,
  pub export_mode: Option<String>,
  pub validation_config: Option<serde_json::Value>,
  pub metadata: Option<serde_json::Value>,
  pub updated_by: Option<uuid::Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataValueDefinition {
  pub id: uuid::Uuid,
  pub field_key: String,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub color: Option<String>,
  pub icon: Option<String>,
  pub sort_order: i32,
  pub is_active: bool,
  pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentTypeDefinition {
  pub id: uuid::Uuid,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub icon: Option<String>,
  pub color: Option<String>,
  pub is_active: bool,
  pub is_suggested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentWorkspaceSettings {
  pub workspace_id: uuid::Uuid,
  pub status_schema_id: Option<uuid::Uuid>,
  pub default_status_id: Option<uuid::Uuid>,
  pub version_policy_id: Option<uuid::Uuid>,
  pub default_document_type_id: Option<uuid::Uuid>,
  pub default_classification_id: Option<uuid::Uuid>,
  pub default_retention_policy_id: Option<uuid::Uuid>,
  pub updated_by: Option<uuid::Uuid>,
  pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataState {
  pub doc_id: uuid::Uuid,
  pub status_id: Option<uuid::Uuid>,
  pub type_id: Option<uuid::Uuid>,
  pub current_version_id: Option<uuid::Uuid>,
  pub dirty_since_current_version: bool,
  pub version_display_mode: String,
  pub last_versioned_at: Option<chrono::DateTime<chrono::Utc>>,
  pub responsible_principals: serde_json::Value,
  pub review_due_at: Option<chrono::DateTime<chrono::Utc>>,
  pub valid_from: Option<chrono::DateTime<chrono::Utc>>,
  pub valid_until: Option<chrono::DateTime<chrono::Utc>>,
  pub classification_id: Option<uuid::Uuid>,
  pub document_number: Option<String>,
  pub language: Option<String>,
  pub audience_ids: Vec<uuid::Uuid>,
  pub retention_policy_id: Option<uuid::Uuid>,
  pub updated_by: Option<uuid::Uuid>,
  pub updated_at: chrono::DateTime<chrono::Utc>,
  pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataIndexRow {
  pub doc_id: uuid::Uuid,
  pub external_id: String,
  pub created_by: Option<uuid::Uuid>,
  pub updated_by: Option<uuid::Uuid>,
  pub journal_date: Option<chrono::NaiveDate>,
  pub is_template: bool,
  pub template_state: Option<String>,
  pub template_origin: Option<String>,
  pub template_category: Option<String>,
  pub template_tags: Option<Vec<String>>,
  pub primary_mode: Option<String>,
  pub page_width: Option<String>,
  pub edgeless_color_theme: Option<String>,
  pub integration_type: Option<String>,
  pub status_id: Option<uuid::Uuid>,
  pub document_type_id: Option<uuid::Uuid>,
  pub current_version_id: Option<uuid::Uuid>,
  pub dirty_since_current_version: bool,
  pub review_due_at: Option<chrono::DateTime<chrono::Utc>>,
  pub valid_until: Option<chrono::DateTime<chrono::Utc>>,
  pub classification_id: Option<uuid::Uuid>,
}

/// Display references for an admitted index row, resolved in one bounded read.
/// These labels do not grant access or change the native property identities.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocumentMetadataIndexLabels {
  pub status_label: Option<String>,
  pub document_type_label: Option<String>,
  pub version_label: Option<String>,
  pub classification_label: Option<String>,
}

/// Actor-independent document-list facts read with their authoritative cache version.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataIndexSnapshot {
  pub version: String,
  pub rows: Vec<DocumentMetadataIndexRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentRuntimeAggregateBucket {
  pub key: Option<String>,
  pub label: Option<String>,
  pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentRuntimeOverview {
  pub total_documents: i64,
  pub by_status: Vec<DocumentRuntimeAggregateBucket>,
  pub by_document_type: Vec<DocumentRuntimeAggregateBucket>,
  pub by_classification: Vec<DocumentRuntimeAggregateBucket>,
  pub by_review_due: Vec<DocumentRuntimeAggregateBucket>,
  pub by_version_state: Vec<DocumentRuntimeAggregateBucket>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentMetadataSource {
  Document,
  Workspace,
  Organization,
  Fallback,
}

impl DocumentMetadataSource {
  pub fn from_storage(value: &str) -> Self {
    match value {
      "document" => Self::Document,
      "workspace" => Self::Workspace,
      "organization" => Self::Organization,
      _ => Self::Fallback,
    }
  }

  pub fn as_storage(self) -> &'static str {
    match self {
      Self::Document => "document",
      Self::Workspace => "workspace",
      Self::Organization => "organization",
      Self::Fallback => "fallback",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentMetadataInheritanceMode {
  Inherited,
  DocumentOnly,
  RelationInherited,
  SystemReadonly,
  SpecializedSubsystem,
}

impl DocumentMetadataInheritanceMode {
  pub fn from_storage(value: &str) -> Self {
    match value {
      "inherited" => Self::Inherited,
      "document_only" => Self::DocumentOnly,
      "relation_inherited" => Self::RelationInherited,
      "specialized_subsystem" => Self::SpecializedSubsystem,
      _ => Self::SystemReadonly,
    }
  }

  pub fn as_storage(self) -> &'static str {
    match self {
      Self::Inherited => "inherited",
      Self::DocumentOnly => "document_only",
      Self::RelationInherited => "relation_inherited",
      Self::SystemReadonly => "system_readonly",
      Self::SpecializedSubsystem => "specialized_subsystem",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataReferenceValue {
  pub id: uuid::Uuid,
  pub key: String,
  pub label: String,
  pub is_active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataAudience {
  pub value: DocumentMetadataReferenceValue,
  pub source: DocumentMetadataSource,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataFieldValue {
  pub key: String,
  pub source: DocumentMetadataSource,
  pub reference: Option<DocumentMetadataReferenceValue>,
  pub text_value: Option<String>,
  pub timestamp_value: Option<chrono::DateTime<chrono::Utc>>,
  pub date_value: Option<chrono::NaiveDate>,
  pub user_id: Option<uuid::Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataSystemFacts {
  pub created_at: chrono::DateTime<chrono::Utc>,
  pub updated_at: chrono::DateTime<chrono::Utc>,
  pub created_by: Option<uuid::Uuid>,
  pub updated_by: Option<uuid::Uuid>,
  pub metadata_updated_at: Option<chrono::DateTime<chrono::Utc>>,
  pub metadata_updated_by: Option<uuid::Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataFieldLock {
  pub key: String,
  pub inheritance_mode: DocumentMetadataInheritanceMode,
  pub editable: bool,
  pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataPolicy {
  pub locks: Vec<DocumentMetadataFieldLock>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataTemplateState {
  pub state: String,
  pub origin: Option<String>,
  /// Custom-source classification; bound sources use their Registry catalog metadata.
  pub category: Option<String>,
  pub tags: Option<Vec<String>>,
  pub template_id: Option<uuid::Uuid>,
  pub revision_id: Option<uuid::Uuid>,
  pub instance_id: Option<uuid::Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataJournal {
  pub journal_date: Option<chrono::NaiveDate>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataPresentation {
  pub primary_mode: Option<String>,
  pub page_width: Option<String>,
  pub edgeless_color_theme: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataIntegration {
  pub integration_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataProjection {
  pub doc_id: uuid::Uuid,
  pub workspace_id: uuid::Uuid,
  #[serde(default)]
  pub projection_version: String,
  pub metadata_revision: i64,
  pub metadata_updated_at: Option<chrono::DateTime<chrono::Utc>>,
  pub metadata_updated_by: Option<uuid::Uuid>,
  pub system: DocumentMetadataSystemFacts,
  pub fields: Vec<DocumentMetadataFieldValue>,
  pub audience: Vec<DocumentMetadataAudience>,
  pub template: Option<DocumentMetadataTemplateState>,
  pub journal: DocumentMetadataJournal,
  pub presentation: Option<DocumentMetadataPresentation>,
  pub integration: Option<DocumentMetadataIntegration>,
  pub policy: DocumentMetadataPolicy,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataPatch {
  pub expected_metadata_revision: Option<i64>,
  pub document_type_id: Option<Option<uuid::Uuid>>,
  pub classification_id: Option<Option<uuid::Uuid>>,
  pub retention_policy_id: Option<Option<uuid::Uuid>>,
  pub language_id: Option<Option<uuid::Uuid>>,
  pub responsible_user_id: Option<Option<uuid::Uuid>>,
  pub document_number: Option<Option<String>>,
  pub review_due_at: Option<Option<chrono::DateTime<chrono::Utc>>>,
  pub valid_from: Option<Option<chrono::DateTime<chrono::Utc>>>,
  pub valid_until: Option<Option<chrono::DateTime<chrono::Utc>>>,
  pub journal_date: Option<Option<chrono::NaiveDate>>,
  pub audience_ids: Option<Vec<uuid::Uuid>>,
  pub template_state: Option<Option<String>>,
  pub template_origin: Option<Option<String>>,
  pub template_category: Option<Option<String>>,
  pub template_tags: Option<Option<Vec<String>>>,
  pub template_id: Option<Option<uuid::Uuid>>,
  pub template_revision_id: Option<Option<uuid::Uuid>>,
  pub template_instance_id: Option<Option<uuid::Uuid>>,
  pub primary_mode: Option<Option<String>>,
  pub page_width: Option<Option<String>>,
  pub edgeless_color_theme: Option<Option<String>>,
  pub integration_type: Option<Option<String>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataMaterializationSummary {
  pub scanned_count: i64,
  pub changed_count: i64,
  pub materialized_count: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DocumentMetadataValidationCode {
  DocumentMetadataRequired,
  DocumentStatusTransitionBlocked,
  DocumentValidityExpired,
  DocumentClassificationBlocksShare,
  DocumentExportBlocked,
  DocumentStatusRequiresTransition,
  DocumentMetadataForbidden,
  DocumentWorkspaceOverrideForbidden,
  DocumentVersionProtected,
  DocumentVersionLabelConflict,
  DocumentConcurrencyConflict,
}

impl DocumentMetadataValidationCode {
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::DocumentMetadataRequired => "DOCUMENT_METADATA_REQUIRED",
      Self::DocumentStatusTransitionBlocked => "DOCUMENT_STATUS_TRANSITION_BLOCKED",
      Self::DocumentValidityExpired => "DOCUMENT_VALIDITY_EXPIRED",
      Self::DocumentClassificationBlocksShare => "DOCUMENT_CLASSIFICATION_BLOCKS_SHARE",
      Self::DocumentExportBlocked => "DOCUMENT_EXPORT_BLOCKED",
      Self::DocumentStatusRequiresTransition => "DOCUMENT_STATUS_REQUIRES_TRANSITION",
      Self::DocumentMetadataForbidden => "DOCUMENT_METADATA_FORBIDDEN",
      Self::DocumentWorkspaceOverrideForbidden => "DOCUMENT_WORKSPACE_OVERRIDE_FORBIDDEN",
      Self::DocumentVersionProtected => "DOCUMENT_VERSION_PROTECTED",
      Self::DocumentVersionLabelConflict => "DOCUMENT_VERSION_LABEL_CONFLICT",
      Self::DocumentConcurrencyConflict => "DOCUMENT_CONCURRENCY_CONFLICT",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentMetadataValidationSeverity {
  Info,
  Warning,
  Error,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataValidationIssue {
  pub code: DocumentMetadataValidationCode,
  pub key: Option<String>,
  pub message: String,
  pub severity: DocumentMetadataValidationSeverity,
  pub blocked_actions: Vec<String>,
  pub details: serde_json::Value,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentMetadataValidation {
  pub errors: Vec<DocumentMetadataValidationIssue>,
  pub warnings: Vec<DocumentMetadataValidationIssue>,
  pub missing_required_metadata_fields: Vec<String>,
  pub blocked_actions: Vec<String>,
}

impl DocumentMetadataValidation {
  pub fn valid(&self) -> bool {
    self.errors.is_empty()
  }
}

/// Trigger that causes the system to automatically create a named
/// [`DocumentVersion`] entry.
///
/// Serialised to/from kebab-case strings that match the SQL `TEXT[]` values
/// stored in `document_versioning_settings.auto_version_on`:
/// `"on-publish"`, `"on-pdf-export"`, `"daily"`.
///
/// Delivery package P-DOC-VER-01.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutoVersionTrigger {
  /// A new named version is created whenever the document is published.
  OnPublish,
  /// A new named version is created whenever a PDF export is started for this doc.
  OnPdfExport,
  /// A new named version is created once per day (nightly cron).
  Daily,
}

impl AutoVersionTrigger {
  /// Return the canonical kebab-case string stored in the SQL `TEXT[]` column.
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::OnPublish => "on-publish",
      Self::OnPdfExport => "on-pdf-export",
      Self::Daily => "daily",
    }
  }
}

impl std::fmt::Display for AutoVersionTrigger {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(self.as_str())
  }
}

impl From<&str> for AutoVersionTrigger {
  fn from(s: &str) -> Self {
    match s {
      "on-publish" => Self::OnPublish,
      "on-pdf-export" => Self::OnPdfExport,
      "daily" => Self::Daily,
      other => {
        tracing::warn!(
          trigger = other,
          "unknown AutoVersionTrigger string, defaulting to Daily"
        );
        Self::Daily
      }
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentVersionEvent {
  Manual,
  Publish,
  PdfExport,
  Daily,
  Api,
  Restore,
}

impl DocumentVersionEvent {
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::Manual => "manual",
      Self::Publish => "publish",
      Self::PdfExport => "pdf_export",
      Self::Daily => "daily",
      Self::Api => "api",
      Self::Restore => "restore",
    }
  }
}

impl From<&str> for DocumentVersionEvent {
  fn from(value: &str) -> Self {
    match value {
      "manual" => Self::Manual,
      "publish" => Self::Publish,
      "pdf_export" => Self::PdfExport,
      "daily" => Self::Daily,
      "api" => Self::Api,
      "restore" => Self::Restore,
      other => {
        tracing::warn!(event = other, "unknown document version event, defaulting to manual");
        Self::Manual
      }
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentVersionKind {
  Checkpoint,
  Milestone,
  Published,
  Exported,
  Restored,
}

impl DocumentVersionKind {
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::Checkpoint => "checkpoint",
      Self::Milestone => "milestone",
      Self::Published => "published",
      Self::Exported => "exported",
      Self::Restored => "restored",
    }
  }
}

impl From<&str> for DocumentVersionKind {
  fn from(value: &str) -> Self {
    match value {
      "checkpoint" => Self::Checkpoint,
      "milestone" => Self::Milestone,
      "published" => Self::Published,
      "exported" => Self::Exported,
      "restored" => Self::Restored,
      other => {
        tracing::warn!(kind = other, "unknown document version kind, defaulting to checkpoint");
        Self::Checkpoint
      }
    }
  }
}

/// A user-visible named snapshot of a document, layered on top of the
/// always-present `doc_histories` audit chain.
///
/// `doc_history_id` references `doc_histories.id` (a `BIGINT` surrogate key)
/// and points to the underlying Yjs state vector snapshot.  The `label` field
/// carries the human-readable version name (e.g. `"v1.0"`, `"before-review"`),
/// which is unique per document (`UNIQUE(doc_id, label)` in SQL).
///
/// Mirrors the canonical `document_version` table.
/// Delivery package P-DOC-VER-01.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentVersion {
  /// Primary key — stable UUID assigned at creation time.
  pub id: uuid::Uuid,
  /// The document this version belongs to.
  pub doc_id: uuid::Uuid,
  /// The workspace that contains the document.
  pub workspace_id: uuid::Uuid,
  /// FK to `doc_histories.id` (BIGINT) — the underlying Yjs snapshot.
  pub doc_history_id: i64,
  /// Monotonic per-document number. `None` is allowed only before insert while
  /// legacy callers still rely on the database trigger; persisted rows always
  /// have a value.
  pub version_no: Option<i64>,
  /// Human-readable label, unique per document (e.g. `"v1.0"`, `"pre-review"`).
  pub label: String,
  /// Optional longer description of what changed in this version.
  pub description: Option<String>,
  /// Why the version was created.
  pub event: DocumentVersionEvent,
  /// User-visible category of the version.
  pub kind: DocumentVersionKind,
  /// User who created this named version.
  pub created_by: uuid::Uuid,
  pub created_at: chrono::DateTime<chrono::Utc>,
  pub updated_by: Option<uuid::Uuid>,
  pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
  /// When `true`, this version is protected from automatic GC pruning.
  pub is_pinned: bool,
  /// Stronger policy/system protection; separate from user pinning.
  pub is_protected: bool,
  pub policy_id: Option<uuid::Uuid>,
  pub policy_snapshot: serde_json::Value,
  pub content_hash: Option<String>,
  pub metadata: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct DocumentVersionCreateInput {
  pub id: uuid::Uuid,
  pub doc_id: uuid::Uuid,
  pub workspace_id: uuid::Uuid,
  pub doc_history_id: i64,
  pub label: String,
  pub description: Option<String>,
  pub event: DocumentVersionEvent,
  pub kind: DocumentVersionKind,
  pub created_by: uuid::Uuid,
  pub created_at: chrono::DateTime<chrono::Utc>,
  pub is_pinned: bool,
  pub is_protected: bool,
  pub policy_id: Option<uuid::Uuid>,
  pub policy_snapshot: serde_json::Value,
  pub content_hash: Option<String>,
  pub metadata: serde_json::Value,
}

impl DocumentVersion {
  pub fn new_for_create(input: DocumentVersionCreateInput) -> Self {
    Self {
      id: input.id,
      doc_id: input.doc_id,
      workspace_id: input.workspace_id,
      doc_history_id: input.doc_history_id,
      version_no: None,
      label: input.label,
      description: input.description,
      event: input.event,
      kind: input.kind,
      created_by: input.created_by,
      created_at: input.created_at,
      updated_by: None,
      updated_at: None,
      is_pinned: input.is_pinned,
      is_protected: input.is_protected,
      policy_id: input.policy_id,
      policy_snapshot: input.policy_snapshot,
      content_hash: input.content_hash,
      metadata: input.metadata,
    }
  }
}

/// Per-document opt-in configuration for automatic named version creation.
///
/// Absence of a row for a `doc_id` is semantically equivalent to a row with
/// `enabled = false`, `auto_version_on = []`, `retention_count = 10`.
/// The `get` method on `DocumentVersioningSettingsRepository` returns those
/// defaults when no row exists.
///
/// Mirrors the canonical `document_versioning_settings` table. Architecture
/// decision D7: auto-versioning
/// is OPT-IN per doc; `doc_histories` runs independently and always-on.
///
/// Delivery package P-DOC-VER-01.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DocumentVersioningSettings {
  /// References `docs.id`.
  pub doc_id: uuid::Uuid,
  pub policy_id: Option<uuid::Uuid>,
  /// Triggers that cause automatic version creation.  Stored as `TEXT[]` in SQL.
  pub auto_version_on: Vec<AutoVersionTrigger>,
  /// Maximum number of unpinned versions retained before GC prunes the oldest.
  pub retention_count: i32,
  /// When `false`, no auto-trigger will fire for this document.
  pub enabled: bool,
  pub auto_version_on_override: Option<Vec<AutoVersionTrigger>>,
  pub retention_count_override: Option<i32>,
  pub enabled_override: Option<bool>,
  pub created_at: Option<chrono::DateTime<chrono::Utc>>,
  pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Optional workspace-level document-versioning overrides for the Admin UI.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceDocumentVersioningSettings {
  pub workspace_id: uuid::Uuid,
  pub workspace_name: Option<String>,
  pub enabled: Option<bool>,
  pub auto_version_on: Option<Vec<AutoVersionTrigger>>,
  pub retention_count: Option<i32>,
  /// Workspace override for unnamed edit capture. `None` inherits the server setting.
  pub edit_capture_enabled: Option<bool>,
  /// Workspace interval override in milliseconds. `None` inherits the server setting.
  pub edit_capture_interval_ms: Option<i64>,
  pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Patch for workspace-owned document-history settings.
///
/// The outer option distinguishes an omitted field from a submitted field;
/// the inner option distinguishes an explicit value from inheritance/reset.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceEditCaptureSettingsPatch {
  pub enabled: Option<Option<bool>>,
  pub auto_version_on: Option<Option<Vec<AutoVersionTrigger>>>,
  pub retention_count: Option<Option<i32>>,
  pub edit_capture_enabled: Option<Option<bool>>,
  pub edit_capture_interval_ms: Option<Option<i64>>,
}

/// Observed health and most recent successful automatic capture for a workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentEditCaptureRuntimeStatus {
  pub available: bool,
  pub last_success_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct WorkspaceVersioningSettingsRevision {
  pub enabled: Option<bool>,
  pub auto_version_on: Option<Vec<AutoVersionTrigger>>,
  pub retention_count: Option<i32>,
  pub edit_capture_enabled: Option<bool>,
  pub edit_capture_interval_ms: Option<i64>,
}

impl WorkspaceDocumentVersioningSettings {
  /// Optimistic revision for workspace versioning fields.
  pub fn edit_capture_revision(&self) -> String {
    serde_json::to_string(&WorkspaceVersioningSettingsRevision {
      enabled: self.enabled,
      auto_version_on: self.auto_version_on.clone(),
      retention_count: self.retention_count,
      edit_capture_enabled: self.edit_capture_enabled,
      edit_capture_interval_ms: self.edit_capture_interval_ms,
    })
    .expect("workspace settings revision is serializable")
  }

  /// Checks only submitted fields against an optimistic revision, allowing
  /// unrelated Admin and workspace edits to interleave safely.
  pub fn patch_matches_revision(&self, patch: &WorkspaceEditCaptureSettingsPatch, revision: &str) -> bool {
    let Ok(expected) = serde_json::from_str::<WorkspaceVersioningSettingsRevision>(revision) else {
      return false;
    };
    patch.enabled.is_none_or(|_| self.enabled == expected.enabled)
      && patch
        .auto_version_on
        .as_ref()
        .is_none_or(|_| self.auto_version_on == expected.auto_version_on)
      && patch
        .retention_count
        .is_none_or(|_| self.retention_count == expected.retention_count)
      && patch
        .edit_capture_enabled
        .is_none_or(|_| self.edit_capture_enabled == expected.edit_capture_enabled)
      && patch
        .edit_capture_interval_ms
        .is_none_or(|_| self.edit_capture_interval_ms == expected.edit_capture_interval_ms)
  }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentVersionPolicy {
  pub id: uuid::Uuid,
  pub scope: String,
  pub workspace_id: Option<uuid::Uuid>,
  pub name: String,
  pub is_default: bool,
  pub enabled_by_default: bool,
  pub scheme_preset: String,
  pub custom_pattern: Option<String>,
  pub timezone_mode: String,
  pub auto_version_on: Vec<AutoVersionTrigger>,
  pub retention_count: i32,
  pub pin_manual_versions: bool,
  pub pin_publish_versions: bool,
  pub published_versions_protected: bool,
  pub export_versions_protected: bool,
  pub metadata_schema: serde_json::Value,
  pub created_by: Option<uuid::Uuid>,
  pub created_at: chrono::DateTime<chrono::Utc>,
  pub updated_by: Option<uuid::Uuid>,
  pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentVersionRelation {
  pub id: uuid::Uuid,
  pub from_version_id: uuid::Uuid,
  pub to_version_id: uuid::Uuid,
  pub relation: String,
  pub created_by: Option<uuid::Uuid>,
  pub created_at: chrono::DateTime<chrono::Utc>,
  pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocumentVersionArtifact {
  pub id: uuid::Uuid,
  pub version_id: uuid::Uuid,
  pub artifact_kind: String,
  pub source_job_id: Option<uuid::Uuid>,
  pub storage_key: String,
  pub mime_type: String,
  pub size_bytes: Option<i64>,
  pub checksum_sha256: Option<String>,
  pub created_by: Option<uuid::Uuid>,
  pub created_at: chrono::DateTime<chrono::Utc>,
  pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
  pub metadata: serde_json::Value,
}

/// A document eligible for an automatic versioning trigger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentAutoVersionTarget {
  pub doc_id: uuid::Uuid,
  pub workspace_id: uuid::Uuid,
  /// Actor used for the generated `document_version.created_by` value. For
  /// worker-created versions this is the document's latest updater, falling back
  /// to the creator, so the non-null FK remains user-attributable.
  pub actor_id: uuid::Uuid,
}

/// A document whose named-version labels are subject to retention pruning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentVersionRetentionTarget {
  pub doc_id: uuid::Uuid,
  pub workspace_id: uuid::Uuid,
  pub retention_count: i32,
}

// ---------------------------------------------------------------------------
// P-PDF-TPL-COLOR-01 — ICC profiles
// ---------------------------------------------------------------------------

/// Color space class of an uploaded ICC profile.
///
/// Maps to the `profile_type` column in `pdf_icc_profiles` which stores the
/// canonical strings `'sRGB'` or `'CMYK'`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PdfIccProfileType {
  Srgb,
  Cmyk,
}

impl PdfIccProfileType {
  /// Return the canonical DB string (`'sRGB'` or `'CMYK'`).
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::Srgb => "sRGB",
      Self::Cmyk => "CMYK",
    }
  }
}

impl std::fmt::Display for PdfIccProfileType {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(self.as_str())
  }
}

impl From<&str> for PdfIccProfileType {
  fn from(s: &str) -> Self {
    match s {
      "sRGB" => Self::Srgb,
      "CMYK" => Self::Cmyk,
      other => {
        tracing::warn!(profile_type = other, "unknown PdfIccProfileType, defaulting to Srgb");
        Self::Srgb
      }
    }
  }
}

impl serde::Serialize for PdfIccProfileType {
  fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(self.as_str())
  }
}

impl<'de> serde::Deserialize<'de> for PdfIccProfileType {
  fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
    let s = String::deserialize(d)?;
    Ok(Self::from(s.as_str()))
  }
}

/// An admin-uploaded ICC color profile for PDF-Export V2.
///
/// Mirrors the canonical `pdf_icc_profiles` table.
/// Delivery package P-PDF-TPL-COLOR-01.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PdfIccProfile {
  pub id: uuid::Uuid,
  pub name: String,
  pub profile_type: PdfIccProfileType,
  pub blob_key: String,
  pub sha256: String,
  /// Admin who uploaded the profile, or `None` for system-seeded entries
  /// (e.g. bundled sRGB/CMYK profiles inserted at first server startup).
  pub uploaded_by: Option<uuid::Uuid>,
  pub uploaded_at: chrono::DateTime<chrono::Utc>,
}
