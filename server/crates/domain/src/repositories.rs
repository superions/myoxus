//! Repository trait definitions for the Myoxus domain layer.
//!
//! Each trait in this module represents a storage port that must be implemented
//! by the infrastructure layer (e.g. via SQLx).  Application services depend on
//! these traits rather than concrete implementations, which keeps the domain
//! independent of any particular database technology.
//!
//! All methods are `async` and return [`RepoResult<T>`].  The infrastructure
//! implementations run inside transactions where stated by the application
//! service that calls them.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

use crate::document_graph::*;
use crate::entities::*;
use crate::ids::*;
use crate::workspace_automation::*;

/// Errors that may be returned by any repository method.
///
/// These variants are intentionally coarse-grained so that application services
/// can pattern-match on them without knowing database-specific error codes.
#[derive(Debug, Error)]
pub enum RepositoryError {
  /// The requested entity does not exist in the store.  The `&'static str`
  /// carries a human-readable entity name (e.g. `"user"`, `"workspace"`).
  #[error("not found: {0}")]
  NotFound(&'static str),
  /// A uniqueness or referential constraint was violated.
  #[error("conflict: {0}")]
  Conflict(&'static str),
  /// The provided data failed domain-level validation before hitting the store.
  #[error("validation failed: {0}")]
  Validation(String),
  /// An I/O or database error that is not otherwise categorised.
  #[error("storage failure: {0}")]
  Storage(String),
}

/// Convenience alias used by every repository method in this module.
pub type RepoResult<T> = Result<T, RepositoryError>;

/// Cursor-based pagination parameters used by list methods.
#[derive(Debug, Clone)]
pub struct PageRequest {
  /// Maximum number of rows to return.
  pub limit: i64,
  /// Number of rows to skip before returning results.
  pub offset: i64,
}

/// Sort field for full-text search queries.
#[derive(Debug, Clone)]
pub enum SearchSortBy {
  /// Sort by search-engine relevance score (default).
  Relevance,
  /// Sort by the document's last-updated timestamp.
  UpdatedAt,
}

/// Sort direction for ordered list queries.
#[derive(Debug, Clone)]
pub enum SortDirection {
  /// Ascending order (oldest / lowest first).
  Asc,
  /// Descending order (newest / highest first).
  Desc,
}

/// Parameters for a paginated full-text document search within a workspace.
#[derive(Debug, Clone)]
pub struct SearchPageRequest {
  /// The search query string.
  pub query: String,
  /// Optional BCP-47 language tag used to select the text-search dictionary
  /// (e.g. `"en"`, `"de"`).  When `None` the store uses its default language.
  pub language: Option<String>,
  /// Which field to sort results by.
  pub sort_by: SearchSortBy,
  /// Ascending or descending direction for `sort_by`.
  pub sort_direction: SortDirection,
  /// Only documents belonging to this workspace are searched.
  pub workspace_id: WorkspaceId,
  /// Pagination parameters.
  pub page: PageRequest,
}

/// Persistence operations for [`User`] entities.
#[async_trait]
pub trait UserRepository: Send + Sync {
  /// Persist a new user record and return it with any server-assigned fields.
  async fn create_user(&self, user: &User) -> RepoResult<User>;
  /// Look up a user by their primary identifier.  Returns `None` if no such
  /// user exists.
  async fn get_user_by_id(&self, id: UserId) -> RepoResult<Option<User>>;
  /// Look up a user by email address (case-insensitive).  Returns `None` if
  /// no account with that address exists.
  async fn get_user_by_email(&self, email: &str) -> RepoResult<Option<User>>;
  /// Apply a JSON merge-patch to a user's profile fields and return the
  /// updated entity.
  async fn update_profile(&self, id: UserId, patch: Value) -> RepoResult<User>;
}

/// Persistence operations for authentication artefacts: sessions, verification
/// tokens, and magic-link OTPs.
#[async_trait]
pub trait AuthRepository: Send + Sync {
  /// Insert a new session record and return it.
  async fn create_session(&self, session: &Session) -> RepoResult<Session>;
  /// Fetch an active session by its identifier.  Returns `None` if the
  /// session does not exist or has already been revoked.
  async fn get_session(&self, session_id: SessionId) -> RepoResult<Option<Session>>;
  /// Return all sessions (including revoked) for a given user, ordered by
  /// creation time descending.
  async fn list_user_sessions(&self, user_id: UserId) -> RepoResult<Vec<Session>>;
  /// Mark a session as revoked at `revoked_at`.  Subsequent calls to
  /// [`get_session`](Self::get_session) for the same ID will return `None`.
  async fn revoke_session(&self, session_id: SessionId, revoked_at: DateTime<Utc>) -> RepoResult<()>;
  /// Store a new email-verification token.
  async fn create_verification_token(&self, token: &VerificationToken) -> RepoResult<VerificationToken>;
  /// Atomically fetch and invalidate a verification token by its hash.
  /// Returns `None` if the token does not exist or has already expired.
  async fn consume_verification_token(
    &self,
    token_hash: &str,
    now: DateTime<Utc>,
  ) -> RepoResult<Option<VerificationToken>>;
  /// Store a new magic-link OTP record.
  async fn create_magic_link_otp(&self, otp: &MagicLinkOtp) -> RepoResult<MagicLinkOtp>;
  /// Atomically fetch and invalidate a magic-link OTP by email + hash.
  /// Returns `None` if the OTP does not exist, has been used, or has expired.
  async fn consume_magic_link_otp(
    &self,
    email: &str,
    otp_hash: &str,
    now: DateTime<Utc>,
  ) -> RepoResult<Option<MagicLinkOtp>>;
}

/// Persistence operations for [`Workspace`] entities.
#[async_trait]
pub trait WorkspaceRepository: Send + Sync {
  /// Insert a new workspace and return the persisted entity.
  async fn create_workspace(&self, workspace: &Workspace) -> RepoResult<Workspace>;
  /// Fetch a workspace by identifier.  Returns `None` for deleted or
  /// non-existent workspaces.
  async fn get_workspace(&self, workspace_id: WorkspaceId) -> RepoResult<Option<Workspace>>;
  /// Return all workspaces the given user is a member of.
  async fn list_user_workspaces(&self, user_id: UserId) -> RepoResult<Vec<Workspace>>;
  /// Apply a JSON merge-patch to a workspace's metadata fields.
  async fn update_workspace(&self, workspace_id: WorkspaceId, patch: Value) -> RepoResult<Workspace>;
  /// Mark the workspace as deleted at `when` without removing any rows.
  /// This is a soft-delete — the workspace record is retained for audit
  /// purposes and can be inspected by administrators.
  async fn soft_delete_workspace(&self, workspace_id: WorkspaceId, when: DateTime<Utc>) -> RepoResult<()>;
}

/// Persistence operations for workspace membership and invite links.
#[async_trait]
pub trait MembershipRepository: Send + Sync {
  /// Add a new member to a workspace.
  async fn add_membership(&self, membership: &WorkspaceMembership) -> RepoResult<WorkspaceMembership>;
  /// Retrieve the membership record for a specific user in a workspace.
  /// Returns `None` when the user is not a member.
  async fn get_membership(&self, workspace_id: WorkspaceId, user_id: UserId)
  -> RepoResult<Option<WorkspaceMembership>>;
  /// List all members of a workspace with pagination.
  async fn list_members(&self, workspace_id: WorkspaceId, page: PageRequest) -> RepoResult<Vec<WorkspaceMembership>>;
  /// Change the role of an existing member.
  async fn update_membership_role(
    &self,
    workspace_id: WorkspaceId,
    user_id: UserId,
    role: WorkspaceRole,
  ) -> RepoResult<WorkspaceMembership>;
  /// Change the status (e.g. pending → accepted) of an existing member.
  async fn update_membership_status(
    &self,
    workspace_id: WorkspaceId,
    user_id: UserId,
    status: MembershipStatus,
  ) -> RepoResult<WorkspaceMembership>;
  /// Persist a new invite link for the workspace.
  async fn create_invite_link(&self, invite: &WorkspaceInviteLink) -> RepoResult<WorkspaceInviteLink>;
  /// Look up an invite link by its token hash.
  async fn get_invite_link_by_hash(&self, token_hash: &str) -> RepoResult<Option<WorkspaceInviteLink>>;
  /// Revoke an invite link so it can no longer be used to join a workspace.
  async fn revoke_invite_link(&self, invite_id: InviteLinkId, revoked_at: DateTime<Utc>) -> RepoResult<()>;
}

/// Persistence operations for collaborative documents and their update history.
#[async_trait]
pub trait DocRepository: Send + Sync {
  /// Insert a new document record.
  async fn create_doc(&self, doc: &Doc) -> RepoResult<Doc>;
  /// Fetch a document by identifier.
  async fn get_doc(&self, doc_id: DocId) -> RepoResult<Option<Doc>>;
  /// List all documents within a workspace, paginated.
  async fn list_workspace_docs(&self, workspace_id: WorkspaceId, page: PageRequest) -> RepoResult<Vec<Doc>>;
  /// Apply a JSON merge-patch to document metadata.  `updated_by` records the
  /// user responsible for the change when audit logging is enabled.
  async fn update_doc_meta(&self, doc_id: DocId, meta: Value, updated_by: Option<UserId>) -> RepoResult<Doc>;
  /// Append a raw Yjs update payload to the document's update log.
  async fn append_doc_update(&self, update: &DocUpdate) -> RepoResult<DocUpdate>;
  /// Record a named snapshot of the document state (history entry).
  async fn create_doc_history(&self, history: &DocHistory) -> RepoResult<DocHistory>;
  /// List history snapshots for a document, optionally bounded by a timestamp.
  async fn list_doc_histories(
    &self,
    doc_id: DocId,
    before: Option<DateTime<Utc>>,
    page: PageRequest,
  ) -> RepoResult<Vec<DocHistory>>;
}

/// Persistence operations for binary blobs and multipart upload state.
#[async_trait]
pub trait BlobRepository: Send + Sync {
  /// Insert or update a blob record (identified by workspace + key).
  async fn upsert_blob(&self, blob: &Blob) -> RepoResult<Blob>;
  /// Retrieve a blob by its workspace-scoped key.
  async fn get_blob_by_key(&self, workspace_id: WorkspaceId, key: &str) -> RepoResult<Option<Blob>>;
  /// Soft-delete a blob at `when`.  The underlying object-store object is
  /// removed by a background garbage-collection job, not immediately.
  async fn mark_blob_deleted(&self, blob_id: BlobId, when: DateTime<Utc>) -> RepoResult<()>;
  /// Begin tracking a new multipart upload session.
  async fn create_multipart_upload(&self, upload: &MultipartUpload) -> RepoResult<MultipartUpload>;
  /// Fetch the current state of a multipart upload session.
  async fn get_multipart_upload(&self, upload_id: MultipartUploadId) -> RepoResult<Option<MultipartUpload>>;
  /// Transition a multipart upload to a new state (e.g. `Pending` → `Complete`).
  async fn update_multipart_upload_state(
    &self,
    upload_id: MultipartUploadId,
    state: MultipartUploadState,
    at: DateTime<Utc>,
  ) -> RepoResult<MultipartUpload>;
  /// Record a new file attachment associated with a comment.
  async fn create_comment_attachment(&self, attachment: &CommentAttachment) -> RepoResult<CommentAttachment>;
}

/// Persistence operations for document comments and their lifecycle.
#[async_trait]
pub trait CommentRepository: Send + Sync {
  /// Insert a new comment.
  async fn create_comment(&self, comment: &Comment) -> RepoResult<Comment>;
  /// Update the rich-text body of a comment, recording the edit timestamp.
  async fn update_comment_body(
    &self,
    comment_id: CommentId,
    body: Value,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<Comment>;
  /// Toggle the resolved state of a comment thread.
  async fn resolve_comment(
    &self,
    comment_id: CommentId,
    resolved: bool,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<Comment>;
  /// Soft-delete a comment at `deleted_at`.  The record is retained so that
  /// reply threads can still be displayed with a placeholder.
  async fn soft_delete_comment(&self, comment_id: CommentId, deleted_at: DateTime<Utc>) -> RepoResult<()>;
  /// List all non-deleted comments for a document, paginated.
  async fn list_comments_for_doc(&self, doc_id: DocId, page: PageRequest) -> RepoResult<Vec<Comment>>;
}

/// Persistence operations for user-facing in-app notifications.
#[async_trait]
pub trait NotificationRepository: Send + Sync {
  /// Insert a new notification for a user.
  async fn create_notification(&self, notification: &Notification) -> RepoResult<Notification>;
  /// List notifications for a user (unread first), paginated.
  async fn list_notifications(&self, user_id: UserId, page: PageRequest) -> RepoResult<Vec<Notification>>;
  /// Mark a single notification as read at `at`.
  async fn mark_notification_read(&self, notification_id: NotificationId, at: DateTime<Utc>) -> RepoResult<()>;
  /// Mark all unread notifications for a user as read at `at`.
  async fn mark_all_notifications_read(&self, user_id: UserId, at: DateTime<Utc>) -> RepoResult<()>;
}

/// Persistence operations for server-owned Workspace Automations.
#[async_trait]
#[allow(clippy::too_many_arguments)]
pub trait WorkspaceAutomationRepository: Send + Sync {
  async fn get_rule_run(
    &self,
    workspace: WorkspaceId,
    rule: WorkspaceAutomationId,
    key: &str,
  ) -> RepoResult<Option<WorkspaceAutomationRun>>;

  async fn configure_personal_automation(
    &self,
    rule: WorkspaceAutomation,
    expected_execution_revision: Option<i64>,
  ) -> RepoResult<WorkspaceAutomation>;
  async fn get_personal_automation(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    database: DatabaseId,
    trigger: WorkspaceAutomationTriggerType,
  ) -> RepoResult<Option<WorkspaceAutomation>>;

  async fn accept_task_maintenance(&self, accepted: AcceptedAutomationRun) -> RepoResult<WorkspaceAutomationRun>;
  async fn get_task_maintenance_request(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
  ) -> RepoResult<Option<WorkspaceAutomationRun>>;
  async fn task_correction_confirmation(
    &self,
    run: WorkspaceAutomationRunId,
  ) -> RepoResult<Option<TaskCorrectionConfirmationReceipt>>;
  async fn commit_task_inspection(&self, fence: AutomationEffectFence) -> RepoResult<serde_json::Value>;

  async fn accept_task_handover(&self, accepted: AcceptedAutomationRun) -> RepoResult<WorkspaceAutomationRun>;
  async fn get_task_handover_request(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: uuid::Uuid,
  ) -> RepoResult<Option<WorkspaceAutomationRun>>;
  async fn task_handover_state(&self, run: WorkspaceAutomationRunId) -> RepoResult<TaskHandoverState>;
  async fn get_document_review_request(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: uuid::Uuid,
  ) -> RepoResult<Option<WorkspaceAutomationRun>>;
  async fn get_document_review_for_task(
    &self,
    workspace: WorkspaceId,
    database: DatabaseId,
    row: DatabaseRowId,
  ) -> RepoResult<Option<WorkspaceAutomationRun>>;
  async fn document_review_decision(
    &self,
    run: WorkspaceAutomationRunId,
  ) -> RepoResult<Option<DocumentReviewDecisionReceipt>>;
  /// Validate a committed native intent; delivery never accepts a caller timestamp as authority.
  async fn validate_workflow_signal(&self, signal: &WorkflowSignalEnvelope) -> RepoResult<()>;
  /// Change only a queued/running Run whose status differs. Terminal native
  /// facts are immutable here; Some identifies the sole transition auditor.
  async fn synchronize_runtime_status(
    &self,
    run_id: WorkspaceAutomationRunId,
    status: WorkspaceAutomationRunStatus,
    reason: Option<String>,
  ) -> RepoResult<Option<WorkspaceAutomationRun>>;

  /// Stop and invalidate the current generation, synchronizing a confirmed
  /// native receipt in the same transaction. Existing effects remain intact.
  async fn stop_runtime_run(
    &self,
    actor: UserId,
    run_id: WorkspaceAutomationRunId,
  ) -> RepoResult<(WorkspaceAutomationRun, bool)>;

  /// Record a semantic confirmed-request failure only under the live claim.
  /// Permission revocation itself cannot prevent retaining this terminal fact.
  async fn fail_confirmed_run(
    &self,
    run_id: WorkspaceAutomationRunId,
    claim: AutomationExecutionClaim,
    reason: ContextWorkflowFailure,
  ) -> RepoResult<Option<WorkspaceAutomationRun>>;

  async fn get_effect(
    &self,
    run_id: WorkspaceAutomationRunId,
    node_key: &str,
    effect_key: &str,
  ) -> RepoResult<Option<WorkspaceAutomationEffectReceipt>>;

  /// Reserve once under the current execution claim; retries retain the first
  /// observed revision and result identity rather than recapturing newer data.
  async fn reserve_effect(
    &self,
    run_id: WorkspaceAutomationRunId,
    node_key: &str,
    effect_key: &str,
    fingerprint: &str,
    claim: AutomationExecutionClaim,
    expected_edit_revision: Option<i64>,
  ) -> RepoResult<WorkspaceAutomationEffectReceipt>;

  /// Return the committed effect result, or admit one dispatch under its live fence.
  async fn authorize_webhook_dispatch(&self, fence: AutomationEffectFence) -> RepoResult<Option<Value>>;

  async fn finish_webhook_effect(&self, fence: AutomationEffectFence, result: Value) -> RepoResult<()>;

  async fn create_automation(&self, automation: WorkspaceAutomation) -> RepoResult<WorkspaceAutomation>;

  async fn update_automation(
    &self,
    automation_id: WorkspaceAutomationId,
    name: Option<String>,
    description: Option<Option<String>>,
    status: Option<WorkspaceAutomationStatus>,
    trigger: Option<WorkspaceAutomationTrigger>,
    actions: Option<Vec<WorkspaceAutomationActionDefinition>>,
    updated_by: Option<UserId>,
  ) -> RepoResult<WorkspaceAutomation>;

  async fn get_automation(&self, automation_id: WorkspaceAutomationId) -> RepoResult<Option<WorkspaceAutomation>>;

  async fn list_automations(
    &self,
    workspace_id: WorkspaceId,
    page: PageRequest,
  ) -> RepoResult<Vec<WorkspaceAutomation>>;

  async fn list_matching_automations(
    &self,
    event: &WorkspaceAutomationTriggerEvent,
    limit: i64,
  ) -> RepoResult<Vec<WorkspaceAutomation>>;

  async fn disable_automation(
    &self,
    automation_id: WorkspaceAutomationId,
    updated_by: Option<UserId>,
  ) -> RepoResult<WorkspaceAutomation>;

  async fn create_run_if_absent(&self, run: WorkspaceAutomationRun) -> RepoResult<(WorkspaceAutomationRun, bool)>;

  async fn count_recent_runs(&self, workspace_id: WorkspaceId, since: DateTime<Utc>) -> RepoResult<i64>;

  async fn get_run(&self, run_id: WorkspaceAutomationRunId) -> RepoResult<Option<WorkspaceAutomationRun>>;

  /// Retain queue metadata after successful enqueue without changing run state.
  async fn record_run_job(&self, run_id: WorkspaceAutomationRunId, job_id: &str) -> RepoResult<()>;

  async fn list_runs(
    &self,
    workspace_id: WorkspaceId,
    automation_id: Option<WorkspaceAutomationId>,
    include_dead_letter: bool,
    page: PageRequest,
  ) -> RepoResult<Vec<WorkspaceAutomationRun>>;

  /// Retain only bounded safe diagnostics for an admitted, unacknowledged attempt.
  async fn record_webhook_failure(
    &self,
    fence: AutomationEffectFence,
    response_status: Option<i32>,
    safe_error_summary: String,
  ) -> RepoResult<()>;

  async fn list_dead_letter_runs(
    &self,
    workspace_id: Option<WorkspaceId>,
    page: PageRequest,
  ) -> RepoResult<Vec<WorkspaceAutomationRun>>;
}

/// Persistence port for the server-authoritative Document Graph.
///
/// Implementations store raw occurrence-level extraction results and index
/// state only. User-specific ACL redaction and node metadata projection belong
/// to the application service, not this storage port.
#[async_trait]
#[allow(clippy::too_many_arguments)]
pub trait DocumentGraphRepository: Send + Sync {
  async fn replace_doc_occurrences(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    source_updated_at: Option<DateTime<Utc>>,
    occurrences: Vec<DocumentGraphOccurrence>,
  ) -> RepoResult<()>;

  async fn mark_doc_graph_stale(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    reason: DocumentGraphReindexReason,
  ) -> RepoResult<()>;

  async fn mark_doc_graph_queued(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    reason: DocumentGraphReindexReason,
  ) -> RepoResult<()>;

  async fn mark_doc_graph_extracting(&self, workspace_id: WorkspaceId, doc_id: DocId) -> RepoResult<()>;

  async fn mark_doc_graph_failed(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    error_code: &str,
    error_message: &str,
  ) -> RepoResult<()>;

  async fn mark_doc_graph_deleted(&self, workspace_id: WorkspaceId, doc_id: DocId) -> RepoResult<()>;

  async fn list_doc_occurrences(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    direction: DocumentGraphDirection,
    page: PageRequest,
  ) -> RepoResult<Vec<DocumentGraphOccurrence>>;

  async fn list_workspace_edges(
    &self,
    workspace_id: WorkspaceId,
    query: DocumentGraphQuery,
  ) -> RepoResult<Vec<DocumentGraphEdge>>;

  async fn list_edge_occurrences(
    &self,
    workspace_id: WorkspaceId,
    source_doc_id: DocId,
    target_workspace_id: Option<WorkspaceId>,
    target_doc_id: Option<DocId>,
    raw_target_doc_id: &str,
    link_kind: DocumentGraphLinkKind,
    target_state: DocumentGraphTargetState,
    page: PageRequest,
  ) -> RepoResult<Vec<DocumentGraphOccurrence>>;

  async fn get_index_state(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
  ) -> RepoResult<Option<DocumentGraphIndexState>>;

  /// Resolve a native address to its current owner without reading target
  /// metadata or granting access. Reduced repositories retain indexed identity;
  /// production repositories follow the canonical committed redirect chain.
  async fn resolve_reference_target(
    &self,
    workspace_id: WorkspaceId,
    _external_id: &str,
    indexed_doc_id: Option<DocId>,
  ) -> RepoResult<Option<(WorkspaceId, DocId)>> {
    Ok(indexed_doc_id.map(|id| (workspace_id, id)))
  }

  async fn get_document_node(&self, workspace_id: WorkspaceId, doc_id: DocId) -> RepoResult<Option<DocumentGraphNode>>;

  async fn get_workspace_index_summary(&self, workspace_id: WorkspaceId) -> RepoResult<DocumentGraphIndexSummary>;

  async fn list_reindex_candidates(&self, workspace_id: WorkspaceId, limit: i64) -> RepoResult<Vec<DocId>>;

  async fn list_workspaces_with_reindex_candidates(&self, limit: i64) -> RepoResult<Vec<WorkspaceId>>;
}

/// Persistence operations for the transactional outbox pattern.
///
/// Events are written to the outbox table atomically with the business
/// transaction that produces them.  A background processor then reads and
/// forwards them to downstream consumers.
#[async_trait]
pub trait OutboxRepository: Send + Sync {
  /// Append a new event to the outbox.
  async fn enqueue_event(&self, event: &OutboxEvent) -> RepoResult<OutboxEvent>;
  /// Return events that have not yet been processed, in insertion order.
  async fn list_unprocessed_events(&self, page: PageRequest) -> RepoResult<Vec<OutboxEvent>>;
  /// Return events handled by the generic dispatcher, excluding the
  /// transaction-owning workspace-document broadcast consumer.
  async fn list_unprocessed_non_document_broadcast_events(&self, page: PageRequest) -> RepoResult<Vec<OutboxEvent>>;
  /// Mark an event as successfully processed so it is excluded from future
  /// `list_unprocessed_events` calls.
  async fn mark_event_processed(&self, event_id: uuid::Uuid, processed_at: DateTime<Utc>) -> RepoResult<()>;
}

/// Persistence and query operations for the full-text search index.
#[async_trait]
pub trait SearchRepository: Send + Sync {
  /// Fetch one indexed document in its workspace scope.
  async fn get_search_doc(&self, workspace_id: WorkspaceId, doc_id: DocId) -> RepoResult<Option<SearchDocument>>;
  /// Insert or replace a document's indexed representation.
  async fn upsert_search_doc(&self, doc: &SearchDocument) -> RepoResult<()>;
  /// Remove a document from the search index.
  async fn delete_search_doc(&self, workspace_id: WorkspaceId, doc_id: DocId) -> RepoResult<()>;
  /// Execute a paginated full-text search and return matching documents.
  async fn search_docs(&self, req: SearchPageRequest) -> RepoResult<Vec<SearchDocument>>;
  /// Execute a field-scoped FTS query.
  ///
  /// `field` must be one of `"plainText"` or `"title"` — the plan compiler is
  /// the only caller responsible for validating this and rejecting unknown
  /// fields. The implementation must dispatch on the supported field names
  /// and query the corresponding table column directly so the result reflects
  /// a real field restriction, not a search-vector approximation.
  async fn search_docs_in_field(
    &self,
    workspace_id: WorkspaceId,
    field: &str,
    keyword: &str,
    language: Option<&str>,
    page: PageRequest,
  ) -> RepoResult<Vec<SearchDocument>>;
  /// Return every indexed document id within the workspace, up to `limit`.
  ///
  /// Used by the P1 `MustNot` set-algebra step, which subtracts the matched
  /// set from the full workspace scope. Returning a bounded slice keeps the
  /// in-memory set algebra bounded even on very large workspaces.
  async fn list_doc_ids_in_workspace(&self, workspace_id: WorkspaceId, limit: i64) -> RepoResult<Vec<uuid::Uuid>>;
  /// Return every document id within the workspace whose `field` column is
  /// non-null and non-empty. Powers the P1 `Exists` operator.
  async fn list_doc_ids_with_field_exists(&self, workspace_id: WorkspaceId, field: &str)
  -> RepoResult<Vec<uuid::Uuid>>;
  /// Fetch every indexed `SearchDocument` whose `doc_id` is in `ids`.
  ///
  /// Used by the P1 plan evaluator to materialise `PlanHits::documents`
  /// after a non-trivial set-algebra step. Returns the rows in the order
  /// produced by the database (the resolver is responsible for sorting).
  async fn list_search_docs_by_ids(
    &self,
    workspace_id: WorkspaceId,
    ids: &[uuid::Uuid],
  ) -> RepoResult<Vec<SearchDocument>>;
  /// Remove index rows whose source document is currently trashed.
  async fn cleanup_trashed_documents(&self) -> RepoResult<u64>;
}

/// Optional fine-grained document anchor for a calendar event.
///
/// `source_doc_id` remains the fast primary link on `calendar_events`; this
/// anchor stores where inside the source document the event was derived from.
#[derive(Debug, Clone, Default)]
pub struct CalendarEventSourceAnchor {
  pub block_id: Option<String>,
  pub start_offset: Option<i32>,
  pub end_offset: Option<i32>,
  pub kind: Option<String>,
}

/// Session-scoped serialization token for one Calendar source event.
/// Implementations must prevent a connection with a held lock from returning
/// to their pool when the token is cancelled or dropped before release.
#[async_trait]
pub trait CalendarPendingWriteGuard: Send {
  async fn detach_delete_intent_and_delete_event(
    &mut self,
    event_id: CalendarEventId,
    snapshot: &CalendarDeleteSnapshot,
  ) -> RepoResult<CalendarPendingWrite>;
  async fn delete_calendar_event(&mut self, event_id: CalendarEventId) -> RepoResult<()>;
  async fn release(self: Box<Self>) -> RepoResult<()>;
}

/// Session-scoped serialization of one scheduling intent. No SQL transaction
/// or event row lock remains open while the caller sends SMTP. Implementations
/// close their owned connection on cancellation, including during lock acquisition.
#[async_trait]
pub trait CalendarMailDeliveryGuard: Send {
  async fn completed(&mut self) -> RepoResult<bool>;
  async fn superseded(&mut self, scope: &CalendarMailDeliveryScope) -> RepoResult<bool>;
  async fn complete(&mut self) -> RepoResult<()>;
  async fn release(self: Box<Self>) -> RepoResult<()>;
}

/// Exclusive reminder fanout ownership. Pending dispatch-log rows may be reclaimed;
/// recipient receipts and whole-reminder completion survive retries. Persistence
/// steps finish before SMTP, and cancellation closes the session during acquisition too.
#[async_trait]
pub trait CalendarReminderDeliveryGuard: Send {
  async fn begin_dispatch(
    &mut self,
    worker_job_id: Uuid,
    at: DateTime<Utc>,
    admission: Option<&crate::entities::CalendarReminderAdmission>,
  ) -> RepoResult<bool>;
  async fn contexts(&mut self) -> RepoResult<Vec<CalendarReminderContext>>;
  /// Revalidate before starting each recipient effect. An already running SMTP
  /// attempt may finish, but cannot acknowledge a replacement generation.
  async fn is_current(&mut self) -> RepoResult<bool>;
  async fn email_completed(&mut self, user: UserId) -> RepoResult<bool>;
  async fn complete_email(&mut self, user: UserId) -> RepoResult<()>;
  /// Atomically finalize the dispatch log and delivery timestamp; false means a
  /// native edit replaced this generation before whole-reminder completion.
  async fn complete(&mut self, at: DateTime<Utc>) -> RepoResult<bool>;
  async fn release(self: Box<Self>) -> RepoResult<()>;
}

/// Supersession compares the same iCalendar UID, recipient and occurrence.
pub struct CalendarMailDeliveryScope {
  pub uid: String,
  pub recipient: String,
  pub recurrence_id: Option<String>,
  pub sequence: i32,
}

/// Input DTO for creating a workspace-native calendar event.
///
/// Note: `description` and `location` are stored in `payload` JSON, not in
/// dedicated DB columns. Use `description_delta` for rich-text content.
#[derive(Debug, Clone)]
pub struct NativeEventInput {
  pub imported_recurrence: Option<crate::scheduling::calendar::ImportedCalendarSource>,
  /// Only masters carry a confirmed native rule; overrides retain their key.
  pub recurrence: Option<crate::scheduling::calendar::ConfirmedCalendarRecurrence>,
  pub workspace_id: WorkspaceId,
  pub title: Option<String>,
  pub description_delta: Option<Value>,
  pub starts_at: DateTime<Utc>,
  pub ends_at: DateTime<Utc>,
  /// Passed as `payload.allDay` (not a dedicated DB column).
  pub all_day: bool,
  pub all_members: bool,
  pub tag_id: Option<CalendarEventTagId>,
  pub source_doc_id: Option<DocId>,
  pub source_anchor: Option<CalendarEventSourceAnchor>,
  pub recurrence_parent_id: Option<CalendarEventId>,
  /// iCal RECURRENCE-ID value (e.g. `"20260501T090000Z"`) for override instances.
  /// Stored in `payload.recurrenceId` so the iCal serializer emits RECURRENCE-ID.
  pub recurrence_ical_id: Option<String>,
}

/// Partial-update DTO for a workspace-native calendar event.
/// `None` fields are left unchanged.
#[derive(Debug, Clone, Default)]
pub struct NativeEventUpdate {
  /// Absent preserves timing, explicit null removes it. Only a master All edit
  /// may change the canonical rule; native RRULE fields are projections.
  pub recurrence: Option<Option<crate::scheduling::calendar::ConfirmedCalendarRecurrence>>,
  pub title: Option<Option<String>>,
  pub description_delta: Option<Option<Value>>,
  pub starts_at: Option<DateTime<Utc>>,
  pub ends_at: Option<DateTime<Utc>>,
  /// Updates `payload.allDay` (not a dedicated DB column).
  pub all_day: Option<bool>,
  pub all_members: Option<bool>,
  pub tag_id: Option<Option<CalendarEventTagId>>,
  pub source_doc_id: Option<Option<DocId>>,
  pub source_anchor: Option<Option<CalendarEventSourceAnchor>>,
  /// Optional full replacement for the event's reminders. `None` leaves the
  /// existing rows untouched; `Some(vec![])` clears them atomically.
  pub reminders: Option<Vec<NativeEventReminderInput>>,
}

/// Domain-neutral reminder input used by native-event update patches.
///
/// Scheduled timestamps and persistence identifiers remain repository-owned;
/// the application service derives them from the target event's start time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeEventReminderInput {
  pub minutes_before: i32,
  pub channel: String,
}

/// One revision-fenced split/truncate, including timing, exception associations,
/// bounded cache reconciliation and scheduling intents in the same transaction.
#[derive(Debug, Clone)]
pub struct CalendarSplitWrite {
  pub original: CalendarEvent,
  pub tail: Option<CalendarEvent>,
  /// Original occurrence key, never the tail's edited display start.
  pub split_at: DateTime<Utc>,
  pub expected_updated_at: DateTime<Utc>,
  pub tail_ends_before: Option<DateTime<Utc>>,
  pub native_rules: Option<CalendarNativeSplitRules>,
  pub source_anchor: Option<Option<CalendarEventSourceAnchor>>,
}

#[derive(Debug, Clone)]
pub struct CalendarNativeSplitRules {
  pub original: crate::scheduling::calendar::ConfirmedCalendarRecurrence,
  pub tail: Option<crate::scheduling::calendar::ConfirmedCalendarRecurrence>,
}

/// Persistence operations for Calendar's existing sources and projections.
#[async_trait]
pub trait CalendarRepository: Send + Sync {
  async fn control_calendar_timing(
    &self,
    _event_id: CalendarEventId,
    _actor_id: UserId,
    _expected_revision: i64,
    _change: crate::scheduling::calendar::CalendarTimingChange,
  ) -> RepoResult<CalendarEvent> {
    Err(RepositoryError::Storage(
      "Calendar lifecycle persistence unavailable".into(),
    ))
  }
  async fn get_calendar_timing(
    &self,
    _event_id: CalendarEventId,
  ) -> RepoResult<Option<crate::scheduling::calendar::CalendarTiming>> {
    Ok(None)
  }
  /// Insert or update a calendar account (OAuth credential set) for a user.
  async fn upsert_calendar_account(&self, account: &CalendarAccount) -> RepoResult<CalendarAccount>;
  /// Update mutable fields of an existing calendar account (e.g. refresh
  /// token rotation).
  async fn update_calendar_account(&self, account: &CalendarAccount) -> RepoResult<CalendarAccount>;
  /// Delete a calendar account and all its associated subscriptions.
  async fn delete_calendar_account(&self, account_id: CalendarAccountId, user_id: UserId) -> RepoResult<()>;
  /// Return all calendar accounts linked to a user.
  async fn list_user_calendar_accounts(&self, user_id: UserId) -> RepoResult<Vec<CalendarAccount>>;
  /// Insert or update a calendar subscription within an account.
  async fn upsert_calendar_subscription(&self, subscription: &CalendarSubscription)
  -> RepoResult<CalendarSubscription>;
  /// Return all subscriptions for the given calendar account.
  async fn list_account_calendar_subscriptions(
    &self,
    account_id: CalendarAccountId,
  ) -> RepoResult<Vec<CalendarSubscription>>;
  /// Associate a synced calendar with a workspace.
  async fn upsert_workspace_calendar(&self, workspace_calendar: &WorkspaceCalendar) -> RepoResult<WorkspaceCalendar>;
  /// List all calendars visible inside a workspace.
  async fn list_workspace_calendars(&self, workspace_id: WorkspaceId) -> RepoResult<Vec<WorkspaceCalendar>>;
  /// Insert or update a calendar event.
  async fn upsert_calendar_event(&self, event: &CalendarEvent) -> RepoResult<CalendarEvent>;
  /// Product-authored external mutations persist event, relations and scheduling
  /// intent atomically. Provider imports use `upsert_calendar_event` instead.
  async fn save_authored_calendar_event(
    &self,
    _event: &CalendarEvent,
    _participants: &[CalendarEventParticipant],
    _reminders: &[CalendarReminder],
  ) -> RepoResult<CalendarEvent> {
    Err(RepositoryError::Storage(
      "Calendar authored persistence is unavailable".into(),
    ))
  }
  /// Cancel one occurrence and persist its detached scheduling intent together.
  async fn cancel_calendar_occurrence(
    &self,
    _event_id: CalendarEventId,
    _instance_start: DateTime<Utc>,
  ) -> RepoResult<()> {
    Err(RepositoryError::Storage(
      "Calendar occurrence cancellation is unavailable".into(),
    ))
  }
  /// Persist an authored occurrence override and scheduling intent atomically.
  async fn save_authored_calendar_instance(
    &self,
    _instance: &CalendarEventInstance,
  ) -> RepoResult<CalendarEventInstance> {
    Err(RepositoryError::Storage(
      "Calendar occurrence persistence unavailable".into(),
    ))
  }
  /// Split original/tail events and their mail intent in one transaction.
  async fn save_calendar_split(
    &self,
    _command: &CalendarSplitWrite,
  ) -> RepoResult<(CalendarEvent, Option<CalendarEvent>)> {
    Err(RepositoryError::Storage(
      "Calendar split persistence unavailable".into(),
    ))
  }
  /// Replace the full participant list for an event atomically.
  async fn replace_calendar_event_participants(
    &self,
    event_id: CalendarEventId,
    participants: &[CalendarEventParticipant],
  ) -> RepoResult<()>;
  /// Update the `response_status` of a single participant identified by
  /// `participant_id`.  Returns the updated participant or `None` if not found.
  async fn update_participant_response_status(
    &self,
    participant_id: CalendarEventParticipantId,
    status: &str,
  ) -> RepoResult<Option<CalendarEventParticipant>>;
  /// Replace the full reminder list for an event atomically.
  async fn replace_calendar_event_reminders(
    &self,
    event_id: CalendarEventId,
    reminders: &[CalendarReminder],
  ) -> RepoResult<()>;
  /// Record that a reminder was (or was not) delivered at `delivered_at`.
  async fn mark_calendar_reminder_status(
    &self,
    reminder_id: CalendarReminderId,
    delivered: bool,
    delivered_at: DateTime<Utc>,
  ) -> RepoResult<()>;
  async fn acquire_reminder_delivery_guard(
    &self,
    reminder_id: CalendarReminderId,
  ) -> RepoResult<Box<dyn CalendarReminderDeliveryGuard>>;
  /// Project events overlapping bounded `[from, to)`, preserving native/master
  /// IDs plus the original recurrence key on each virtual event copy.
  async fn list_workspace_events(
    &self,
    workspace_id: WorkspaceId,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> RepoResult<Vec<CalendarEvent>>;
  /// Authored sources for ICS export, not virtual occurrence copies. Import
  /// fidelity must not depend on the calculator supporting a preserved source.
  async fn list_workspace_event_sources(
    &self,
    workspace_id: WorkspaceId,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> RepoResult<Vec<CalendarEvent>> {
    self.list_workspace_events(workspace_id, from, to).await
  }
  /// Native series masters remain discoverable without a current occurrence,
  /// including paused, ended, unsupported and exhausted sources. No projection.
  async fn list_workspace_calendar_series(&self, _workspace_id: WorkspaceId) -> RepoResult<Vec<CalendarEvent>> {
    Err(RepositoryError::Storage("Calendar series lookup unavailable".into()))
  }

  /// Return all CalDAV calendar accounts across all users (for background sync).
  async fn list_caldav_accounts(&self) -> RepoResult<Vec<CalendarAccount>>;
  /// Return all Google Calendar accounts across all users (for background sync).
  async fn list_google_accounts(&self) -> RepoResult<Vec<CalendarAccount>>;
  /// Fetch a single calendar account by its primary key.
  ///
  /// Returns `None` if no account with the given ID exists.  Use this instead
  /// of `list_caldav_accounts` / `list_google_accounts` when only one specific
  /// account is needed — O(1) vs O(N).
  async fn get_calendar_account_by_id(&self, id: uuid::Uuid) -> RepoResult<Option<CalendarAccount>>;
  /// Fetch a single calendar subscription by its primary key.
  ///
  /// Returns `None` if no subscription with the given ID exists.
  async fn get_calendar_subscription_by_id(
    &self,
    subscription_id: CalendarSubscriptionId,
  ) -> RepoResult<Option<CalendarSubscription>>;
  /// Find a single subscription by its webhook `channel_id` stored in the JSONB
  /// `webhook_channel_json` column.  Used by the webhook endpoint to look up
  /// which account a Google push notification belongs to.
  async fn find_subscription_by_channel_id(&self, channel_id: &str) -> RepoResult<Option<CalendarSubscription>>;
  /// Mark a webhook-backed subscription as observed without changing its
  /// provider channel or sync token.
  async fn touch_calendar_subscription(&self, subscription_id: CalendarSubscriptionId) -> RepoResult<()>;
  /// Return all subscriptions whose webhook channel expires within the next
  /// `within_hours` hours.  Used by the renewal cron job.
  async fn list_subscriptions_expiring_within(&self, within_hours: i64) -> RepoResult<Vec<CalendarSubscription>>;
  /// Update only the `webhook_channel_json` field on a subscription atomically.
  async fn update_subscription_webhook_channel(
    &self,
    subscription_id: CalendarSubscriptionId,
    channel: Option<&crate::entities::WebhookChannelInfo>,
  ) -> RepoResult<()>;
  /// Return delivery context for a reminder (user_id, user_email, event_title,
  /// starts_at) needed by the dispatcher to route the notification.
  /// Returns `None` if the reminder or its related event/account/user no
  /// longer exist.
  async fn get_calendar_reminder_context(
    &self,
    reminder_id: CalendarReminderId,
  ) -> RepoResult<Option<CalendarReminderContext>>;
  /// Native workspace reminders may have several current recipients.
  async fn get_calendar_reminder_contexts(
    &self,
    reminder_id: CalendarReminderId,
  ) -> RepoResult<Vec<CalendarReminderContext>> {
    Ok(
      self
        .get_calendar_reminder_context(reminder_id)
        .await?
        .into_iter()
        .collect(),
    )
  }
  // ── Event-instance methods (RRULE expansion) ──────────────────────────

  /// Insert or update a single expanded recurrence instance.
  ///
  /// Conflict target: `(event_id, instance_start)`.  On conflict, all mutable
  /// fields are overwritten so that provider-side edits are reflected.
  async fn upsert_event_instance(&self, instance: &CalendarEventInstance) -> RepoResult<CalendarEventInstance>;

  /// Project/read instances overlapping bounded `[from, to)`, including retained
  /// cancellation receipts. Do not overwrite exceptions or unrelated windows.
  async fn list_event_instances(
    &self,
    event_id: CalendarEventId,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> RepoResult<Vec<CalendarEventInstance>>;

  /// Project busy instances overlapping bounded `[from, to)` across a workspace,
  /// excluding cancellations and applying effective override times.
  async fn list_instances_by_time_range(
    &self,
    workspace_id: WorkspaceId,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> RepoResult<Vec<CalendarEventInstance>>;

  /// Mark a specific occurrence as cancelled (`is_cancelled = true`).
  async fn cancel_event_instance(&self, instance_id: CalendarEventInstanceId) -> RepoResult<()>;

  /// Delete all instances for `event_id` (used before re-expanding or on
  /// event deletion; the FK cascade also handles the event-deletion case).
  async fn delete_event_instances_by_event(&self, event_id: CalendarEventId) -> RepoResult<()>;

  // ── ETag / write-back helpers ─────────────────────────────────────────

  /// Persist the ETag and remote href returned by the CalDAV / Google server
  /// after a successful create or update operation.
  async fn update_event_etag(&self, event_id: CalendarEventId, etag: &str, remote_href: &str) -> RepoResult<()>;

  // ── Offline pending-write queue ───────────────────────────────────────

  /// Enqueue a deferred write operation.
  async fn enqueue_pending_write(
    &self,
    event_id: CalendarEventId,
    operation: &str,
    payload: Option<serde_json::Value>,
  ) -> RepoResult<CalendarPendingWrite>;

  /// Persist a self-contained remote delete intent and remove its local source
  /// event atomically. The detached queue row must not retain the event FK.
  async fn detach_delete_intent_and_delete_event(
    &self,
    event_id: CalendarEventId,
    snapshot: &crate::entities::CalendarDeleteSnapshot,
  ) -> RepoResult<CalendarPendingWrite>;

  /// Hold the source-event serialization boundary across a bounded provider
  /// call and its queue acknowledgement.
  async fn acquire_pending_write_guard(
    &self,
    event_id: CalendarEventId,
  ) -> RepoResult<Box<dyn CalendarPendingWriteGuard>>;

  async fn acquire_mail_delivery_guard(&self, intent_id: Uuid) -> RepoResult<Box<dyn CalendarMailDeliveryGuard>>;

  /// Re-read one queued operation after acquiring its source-event guard.
  async fn get_pending_write(&self, id: uuid::Uuid) -> RepoResult<Option<CalendarPendingWrite>>;

  /// Return pending writes whose `next_retry_at` is `<= now` and `retry_count < 10`.
  async fn list_due_pending_writes(&self, now: DateTime<Utc>, limit: i64) -> RepoResult<Vec<CalendarPendingWrite>>;

  /// Update retry bookkeeping after a failed attempt.
  async fn update_pending_write_retry(
    &self,
    id: uuid::Uuid,
    retry_count: i32,
    next_retry_at: Option<DateTime<Utc>>,
    last_error: &str,
  ) -> RepoResult<()>;

  /// Remove a successfully-processed pending write.
  async fn delete_pending_write(&self, id: uuid::Uuid) -> RepoResult<()>;

  /// Fetch a single calendar event by its local ID.
  async fn get_calendar_event(&self, event_id: CalendarEventId) -> RepoResult<Option<CalendarEvent>>;
  /// Provider source identity can predate the current deterministic-ID scheme.
  /// Callers must retain the row returned by this exact account/source lookup.
  async fn find_calendar_event_by_source(
    &self,
    _account_id: CalendarAccountId,
    _remote_event_id: &str,
  ) -> RepoResult<Option<CalendarEvent>> {
    Err(RepositoryError::Storage("Calendar source lookup unavailable".into()))
  }
  /// Current standard export/writeback snapshot, including intentional timing
  /// suppression; normal authored reads continue to expose the retained base.
  async fn get_calendar_export_event(&self, event_id: CalendarEventId) -> RepoResult<Option<CalendarEvent>> {
    self.get_calendar_event(event_id).await
  }

  /// Delete a calendar event and all its related rows (FK cascade removes
  /// participants, reminders, and instances automatically).
  async fn delete_calendar_event(&self, event_id: CalendarEventId) -> RepoResult<()>;

  /// Find a single recurrence instance by `(event_id, instance_start)`.
  /// Returns `None` if no matching instance exists.
  async fn find_instance_by_event_and_start(
    &self,
    event_id: CalendarEventId,
    instance_start: DateTime<Utc>,
  ) -> RepoResult<Option<crate::entities::CalendarEventInstance>>;

  // ── Native event CRUD (P-JCAL-SERVER-01-B) ───────────────────────────

  /// Create a workspace-native calendar event (origin = native).
  ///
  /// Root events receive a new UUID. A recurrence override retains its identity
  /// for the same master and original recurrence ID. Persist its master EXDATE,
  /// override and scheduling intent atomically; a failed save changes none.
  async fn insert_native_event(&self, input: &NativeEventInput) -> RepoResult<CalendarEvent>;

  /// Update mutable fields of a native event by ID.
  ///
  /// Only fields present in [`NativeEventUpdate`] are written; the rest are
  /// untouched. Returns the updated row, or `None` if `event_id` is not found
  /// or belongs to an external event.
  async fn update_native_event(
    &self,
    event_id: CalendarEventId,
    input: &NativeEventUpdate,
  ) -> RepoResult<Option<CalendarEvent>>;

  // ── Workspace calendar settings (P-JCAL-SERVER-01-B) ─────────────────

  /// Insert or update workspace calendar settings (primary key: workspace_id).
  async fn upsert_workspace_calendar_settings(
    &self,
    settings: &WorkspaceCalendarSettings,
  ) -> RepoResult<WorkspaceCalendarSettings>;

  /// Return the calendar settings for a workspace, or `None` if unset.
  async fn get_workspace_calendar_settings(
    &self,
    workspace_id: WorkspaceId,
  ) -> RepoResult<Option<WorkspaceCalendarSettings>>;

  // ── Event tag CRUD (P-JCAL-SERVER-01-C) ──────────────────────────────

  /// Insert a new workspace event tag. Returns the persisted row.
  async fn insert_calendar_event_tag(&self, tag: &CalendarEventTag) -> RepoResult<CalendarEventTag>;

  /// Update name and/or color of an existing tag. Returns the updated row,
  /// or `None` if `tag_id` is not found or belongs to a different workspace.
  async fn update_calendar_event_tag(
    &self,
    tag_id: CalendarEventTagId,
    workspace_id: WorkspaceId,
    name: &str,
    color: &str,
  ) -> RepoResult<Option<CalendarEventTag>>;

  /// Delete a tag by ID. FK `ON DELETE SET NULL` clears `calendar_events.tag_id`
  /// for any events that reference this tag.
  async fn delete_calendar_event_tag(&self, tag_id: CalendarEventTagId, workspace_id: WorkspaceId) -> RepoResult<()>;

  /// List all event tags for a workspace, ordered by name.
  async fn list_calendar_event_tags(&self, workspace_id: WorkspaceId) -> RepoResult<Vec<CalendarEventTag>>;

  /// Append `instance_start` to the EXDATE array in the event's payload JSON.
  ///
  /// Used by the Scope=This delete/update path to exclude a single recurrence
  /// instance from the master series without touching any other field.
  /// No-ops if the event is external (`origin != 'native'`).
  async fn add_event_exdate(&self, event_id: CalendarEventId, instance_start: DateTime<Utc>) -> RepoResult<()>;
}

/// Persistence operations for AI copilot sessions, messages, tool calls, and
/// context management.
#[async_trait]
pub trait CopilotRepository: Send + Sync {
  /// Serialize against message append/delete/fork; compare the last turn and
  /// generation under that lock, preserve one prior revision and claim atomically.
  async fn claim_copilot_turn(
    &self,
    request: &crate::copilot_turn::CopilotTurnRequest,
  ) -> RepoResult<crate::copilot_turn::CopilotTurnClaim>;
  /// Owned user submission with optional transport correlation. Repeated keys
  /// return the same message only for the same payload; no client-owned lease.
  async fn submit_copilot_message(&self, user_id: UserId, message: &CopilotMessage) -> RepoResult<CopilotMessage>;
  /// Create a new copilot conversation session.
  async fn create_copilot_session(&self, session: &CopilotSession) -> RepoResult<CopilotSession>;
  /// Commit an application-prepared fork only if its entire source snapshot is
  /// unchanged. A conflict must leave neither a target session nor any messages.
  async fn commit_copilot_session_fork(&self, fork: &CopilotSessionFork) -> RepoResult<CopilotSession>;
  /// Retrieve a session by its identifier.
  async fn get_copilot_session(&self, session_id: CopilotSessionId) -> RepoResult<Option<CopilotSession>>;
  /// Filter the complete owned history before counting/paging. Access scopes
  /// cover all matches, including rows outside the bounded result page.
  async fn list_copilot_sessions(
    &self,
    user_id: UserId,
    filter: &CopilotSessionFilter,
    page: PageRequest,
  ) -> RepoResult<CopilotSessionPage>;
  /// Persist changes to a session (e.g. title update).
  async fn update_copilot_session(&self, session: &CopilotSession) -> RepoResult<CopilotSession>;
  /// Archive a session so it is hidden from the default list view.
  async fn archive_copilot_session(&self, session_id: CopilotSessionId, archived_at: DateTime<Utc>) -> RepoResult<()>;
  /// Soft-delete a session and all its messages.
  async fn delete_copilot_session(&self, session_id: CopilotSessionId, deleted_at: DateTime<Utc>) -> RepoResult<()>;
  /// Append a user or assistant message to a session.
  async fn append_copilot_message(&self, message: &CopilotMessage) -> RepoResult<CopilotMessage>;
  /// Fetch a single message by identifier.
  async fn get_copilot_message(&self, message_id: CopilotMessageId) -> RepoResult<Option<CopilotMessage>>;
  /// Update a message for deliberate editing or structured tool/attachment writes.
  /// Preserve current server-owned turn metadata under the write lock, even
  /// when the caller prepared the content from an older generation snapshot.
  async fn update_copilot_message(&self, message: &CopilotMessage) -> RepoResult<CopilotMessage>;
  /// Atomically write a running generation only while its server-owned stream ID
  /// and edit timestamp still match. False means terminal, superseded or edited;
  /// never overwrite those states or create deliberate-edit revisions.
  async fn update_copilot_stream(&self, message: &CopilotMessage, stream_id: Uuid) -> RepoResult<bool>;
  /// Record an alternative generation for a message (user-triggered retry).
  async fn append_copilot_message_revision(
    &self,
    message_id: CopilotMessageId,
    revision: &CopilotMessage,
  ) -> RepoResult<()>;
  /// List all revisions of a message, paginated.
  async fn list_copilot_message_revisions(
    &self,
    message_id: CopilotMessageId,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotMessage>>;
  /// List all messages in a session, paginated (oldest first).
  async fn list_copilot_messages(
    &self,
    session_id: CopilotSessionId,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotMessage>>;
  /// Record a tool call that was invoked during message generation.
  async fn append_copilot_tool_call(&self, tool_call: &CopilotToolCall) -> RepoResult<CopilotToolCall>;
  /// Associate an uploaded file or blob reference with a message.
  async fn append_copilot_attachment_ref(
    &self,
    attachment_ref: &CopilotAttachmentRef,
  ) -> RepoResult<CopilotAttachmentRef>;
  /// Compare live session authority/source under the session/message lock, then
  /// append only the file extension. Concurrent identical exports reuse a winner.
  async fn commit_copilot_generated_file(
    &self,
    _session: &CopilotSession,
    _source: &CopilotMessage,
    _file: &CopilotAttachmentRef,
  ) -> RepoResult<CopilotAttachmentRef> {
    Err(RepositoryError::Conflict(
      "generated output publication unavailable".into(),
    ))
  }
  /// Create a reusable context bundle (set of documents / pages pinned to the
  /// AI for a given user/workspace).
  async fn create_copilot_context(&self, context: &CopilotContext) -> RepoResult<CopilotContext>;
  /// Retrieve one context by its stable identifier.
  async fn get_copilot_context(&self, context_id: CopilotContextId) -> RepoResult<Option<CopilotContext>>;
  /// Find a user-owned context by its exact workspace-scoped name.
  async fn find_copilot_context(
    &self,
    user_id: UserId,
    workspace_id: WorkspaceId,
    name: &str,
  ) -> RepoResult<Option<CopilotContext>>;
  /// List context bundles for a user, optionally scoped to a workspace.
  async fn list_copilot_contexts(
    &self,
    user_id: UserId,
    workspace_id: Option<WorkspaceId>,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotContext>>;
  /// Add a document or URL reference to a context bundle.
  async fn append_copilot_context_item(&self, item: &CopilotContextItem) -> RepoResult<CopilotContextItem>;
  async fn get_copilot_context_item(&self, item_id: Uuid) -> RepoResult<Option<CopilotContextItem>>;
  /// Never inserts. Removal, retry or another worker invalidates the expected
  /// metadata and prevents a late result from replacing the current attempt.
  async fn compare_context_item_metadata(
    &self,
    item_id: Uuid,
    expected: &Value,
    replacement: &Value,
  ) -> RepoResult<bool>;
  /// Pending file work whose dispatch/processing lease expired. Claim each
  /// result with compare_context_item_metadata before redispatch.
  async fn due_context_ingestions(&self, now_ms: i64, limit: i64) -> RepoResult<Vec<CopilotContextItem>>;
  /// List all items within a context bundle, paginated.
  async fn list_copilot_context_items(
    &self,
    context_id: CopilotContextId,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotContextItem>>;
  /// Remove a specific item from a context bundle.  Returns `true` if the
  /// item was found and removed.
  async fn remove_copilot_context_item(
    &self,
    context_id: CopilotContextId,
    item_type: CopilotContextItemType,
    item_ref: &str,
  ) -> RepoResult<bool>;
  /// Insert or update the per-workspace copilot configuration (e.g. enabled
  /// model, quota overrides).
  async fn upsert_copilot_workspace_state(&self, state: &CopilotWorkspaceState) -> RepoResult<CopilotWorkspaceState>;
  /// Retrieve the copilot workspace configuration.
  async fn get_copilot_workspace_state(&self, workspace_id: WorkspaceId) -> RepoResult<Option<CopilotWorkspaceState>>;
  /// Enqueue a background AI processing job.
  async fn create_copilot_job(&self, job: &CopilotJob) -> RepoResult<CopilotJob>;
  /// Retrieve one job without weakening the caller's ownership checks.
  async fn get_copilot_job(&self, job_id: CopilotJobId) -> RepoResult<Option<CopilotJob>>;
  /// Replace the trusted execution payload of an existing job without creating
  /// a second job identity. Audio attempt transitions use their typed owner.
  async fn update_copilot_job_payload(
    &self,
    job_id: CopilotJobId,
    payload: serde_json::Value,
  ) -> RepoResult<CopilotJob>;
  /// Transition a copilot job to a new state, optionally recording an error
  /// message on failure.
  async fn update_copilot_job_state(
    &self,
    job_id: CopilotJobId,
    state: CopilotJobState,
    error_message: Option<String>,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<CopilotJob>;
  /// List copilot jobs, optionally filtered by workspace, user, and state.
  async fn list_copilot_jobs(
    &self,
    workspace_id: Option<WorkspaceId>,
    user_id: Option<UserId>,
    state: Option<CopilotJobState>,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotJob>>;
  /// Count all active (not soft-deleted) Copilot sessions.
  async fn count_active_copilot_sessions(&self) -> RepoResult<i64>;
  async fn purge_deleted_copilot_sessions_before(&self, cutoff: DateTime<Utc>) -> RepoResult<u64>;
  async fn clear_copilot_session_document(&self, doc_id: Uuid) -> RepoResult<u64>;
  async fn purge_empty_copilot_sessions_before(&self, cutoff: DateTime<Utc>) -> RepoResult<u64>;
  async fn list_untitled_copilot_session_ids(&self, limit: i64) -> RepoResult<Vec<Uuid>>;
  async fn list_active_copilot_attachment_blob_keys(&self) -> RepoResult<Vec<String>>;
  async fn list_orphaned_copilot_attachment_blob_keys(&self) -> RepoResult<Vec<String>>;
}

/// File-backed result from the workspace embedding projection.
#[derive(Debug, Clone)]
pub struct CopilotWorkspaceFileMatch {
  pub file_id: String,
  pub content: String,
  pub blob_id: Option<String>,
  pub name: String,
  pub mime_type: String,
  pub chunk: i32,
  pub distance: f64,
}

/// Document-backed result from the workspace embedding projection.
#[derive(Debug, Clone)]
pub struct CopilotWorkspaceDocMatch {
  pub doc_id: Uuid,
  pub content: String,
  pub chunk: i32,
  pub distance: f64,
}

#[derive(Debug, Clone, Default)]
pub struct CopilotIndexStatus {
  pub total: i64,
  pub embedded: i64,
  pub processing: bool,
  pub failed: bool,
}

/// Persistence operations for copilot document embeddings (pgvector-backed
/// semantic similarity search for RAG).
#[async_trait]
pub trait CopilotEmbeddingRepository: Send + Sync {
  /// Insert a single embedding row.
  async fn insert_embedding(&self, embedding: &CopilotEmbedding) -> RepoResult<()>;

  /// Batch-insert multiple embeddings. Implementations should chunk large
  /// batches to avoid exceeding PostgreSQL parameter limits.
  async fn insert_embeddings_batch(&self, embeddings: &[CopilotEmbedding]) -> RepoResult<()>;

  /// Publish one complete source/model atomically; failed batches retain the
  /// previous source rather than exposing a truncated successful replacement.
  /// An empty batch clears this source/model after successful empty projection.
  async fn replace_source_embeddings(
    &self,
    workspace_id: WorkspaceId,
    source_type: &CopilotEmbeddingSourceType,
    source_id: &str,
    model: &str,
    embeddings: &[CopilotEmbedding],
  ) -> RepoResult<()>;

  /// Delete all embeddings for a specific source document within a workspace.
  /// Returns the number of rows deleted.
  async fn delete_embeddings_by_source(
    &self,
    workspace_id: WorkspaceId,
    source_type: &CopilotEmbeddingSourceType,
    source_id: &str,
  ) -> RepoResult<u64>;

  /// Find the most similar embeddings to `query_embedding` within a workspace,
  /// ordered by ascending cosine distance.
  async fn similarity_search(
    &self,
    workspace_id: WorkspaceId,
    query_embedding: &[f32],
    limit: i32,
    model: &str,
    source_ids: &[Uuid],
  ) -> RepoResult<Vec<CopilotEmbeddingMatch>>;

  /// Search the established workspace-file embedding projection.
  async fn similarity_search_workspace_files(
    &self,
    workspace_id: WorkspaceId,
    query_embedding: &[f32],
    limit: i32,
    maximum_distance: Option<f64>,
    model: &str,
    source_ids: &[String],
  ) -> RepoResult<Vec<CopilotWorkspaceFileMatch>>;

  /// Search the established workspace-document embedding projection.
  async fn similarity_search_workspace_docs(
    &self,
    workspace_id: WorkspaceId,
    query_embedding: &[f32],
    limit: i32,
    maximum_distance: Option<f64>,
    model: &str,
    source_ids: &[Uuid],
  ) -> RepoResult<Vec<CopilotWorkspaceDocMatch>>;

  /// Count total embeddings stored for a workspace.
  async fn count_embeddings_by_workspace(&self, workspace_id: WorkspaceId) -> RepoResult<i64>;

  /// Eligible/fully indexed document counts and active/failed latest source jobs
  /// for this exact model/dimension; a historical timestamp is not readiness.
  async fn workspace_index_status(
    &self,
    workspace_id: WorkspaceId,
    model: &str,
    dimensions: u32,
  ) -> RepoResult<CopilotIndexStatus>;

  async fn has_indexed_file_sources(
    &self,
    workspace_id: WorkspaceId,
    model: &str,
    dimensions: u32,
    source_ids: &[String],
  ) -> RepoResult<bool>;

  /// Return distinct source identities for bounded orphan reconciliation.
  async fn list_embedding_sources(&self, workspace_id: WorkspaceId) -> RepoResult<Vec<(String, String)>>;

  /// Delete embeddings whose `source_id` is NOT in the provided set of valid
  /// IDs. Used for garbage-collecting embeddings of deleted documents.
  /// Returns the number of rows deleted.
  async fn delete_orphan_embeddings(&self, workspace_id: WorkspaceId, valid_source_ids: &[String]) -> RepoResult<u64>;
}

/// Persistence operations for workspace usage analytics (minute-resolution
/// time-series data).
#[async_trait]
pub trait AnalyticsRepository: Send + Sync {
  /// Upsert a single one-minute analytics record for a workspace.  Callers
  /// should bucket timestamps to the start of each minute before calling this.
  async fn upsert_workspace_analytics_minute(&self, record: &WorkspaceAnalyticsMinute) -> RepoResult<()>;
  /// Return all analytics records for a workspace within the given half-open
  /// time range `[from, to)`.
  async fn list_workspace_analytics(
    &self,
    workspace_id: WorkspaceId,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> RepoResult<Vec<WorkspaceAnalyticsMinute>>;
}

// --- PDF-Export V2 Repository Traits ---
// Mirrors the canonical PDF export tables.
// SQLx implementations live in `crates/infrastructure/src/pdf_export/`.

/// Persistence operations for PDF export templates (table: `pdf_templates`,
/// `pdf_template_files`).
///
/// Template files are written atomically together with the template header row
/// in [`create`](PdfTemplateRepository::create).
#[async_trait]
pub trait PdfTemplateRepository: Send + Sync {
  /// Return all templates, optionally including soft-deleted ones.
  async fn list(&self, include_deleted: bool) -> RepoResult<Vec<PdfTemplate>>;

  /// Look up a template by its UUID primary key. Returns `None` if not found.
  async fn get_by_id(&self, id: uuid::Uuid) -> RepoResult<Option<PdfTemplate>>;

  /// Look up a template by its stable kebab-case slug. Returns `None` if not
  /// found or if the template has been soft-deleted.
  async fn get_by_slug(&self, slug: &str) -> RepoResult<Option<PdfTemplate>>;

  /// Persist a new template header row together with its file records.
  ///
  /// Implementations must insert all rows in a single transaction so that a
  /// partial upload never leaves an inconsistent state. Its optional audit joins
  /// that transaction; caller rollback removes only operation-owned staging.
  async fn create(
    &self,
    tpl: &PdfTemplate,
    files: &[PdfTemplateFile],
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<()>;

  /// Return the stored bundle-file records for one template.
  async fn list_files(&self, id: uuid::Uuid) -> RepoResult<Vec<PdfTemplateFile>>;

  /// Atomically replace an existing template header and its complete bundle.
  ///
  /// Existing workspace assignments remain valid because the template UUID is
  /// preserved. Callers must materialize the replacement blobs under new keys
  /// before invoking this operation so a failed transaction cannot corrupt the
  /// currently referenced bundle. The complete observed header and file records
  /// are rechecked under the row lock, including ownership and same-version
  /// edits; version comparison alone cannot protect external system inputs.
  async fn replace_bundle(
    &self,
    tpl: &PdfTemplate,
    files: &[PdfTemplateFile],
    expected: &PdfTemplate,
    expected_files: &[PdfTemplateFile],
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<()>;

  /// Replace the stored manifest JSON for an existing template.
  ///
  /// Used when a template author uploads a patch version with updated
  /// capabilities but unchanged bundle files.
  async fn update_manifest(&self, id: uuid::Uuid, manifest: &serde_json::Value) -> RepoResult<()>;

  /// Patch only requested metadata under the row lock and return the committed
  /// operation snapshot. Mutation and optional authenticated audit are atomic.
  ///
  /// Used by the admin "rename / re-describe" mutation
  /// (`updatePdfTemplateMetadata`) to keep the column and the embedded
  /// `manifest.name` / `manifest.description` fields in lockstep — separate
  /// updates would leave a window where a reader sees the column value but
  /// the manifest still carries the old name (or vice versa).
  async fn update_metadata(
    &self,
    id: uuid::Uuid,
    name: Option<&str>,
    description: Option<&str>,
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<PdfTemplate>;

  /// Set `deleted_at = now()` on the template row (soft delete).
  ///
  /// The template's files are **not** removed from the blob store by this
  /// call; admitted exports and shared revisions retain their captured bytes.
  /// Missing/already-deleted rows return `false` without an audit. Assignment
  /// protection, deletion and optional authenticated audit share the row lock.
  async fn soft_delete(&self, id: uuid::Uuid, audit_actor: Option<crate::audit::AuditActor>) -> RepoResult<bool>;
}

/// Persistence operations for workspace ↔ template assignments
/// (table: `pdf_workspace_template_assignments`).
#[async_trait]
pub trait PdfWorkspaceTemplateAssignmentRepository: Send + Sync {
  /// Return all templates assigned to `ws`, including the `is_default` flag.
  async fn list_for_workspace(&self, ws: uuid::Uuid) -> RepoResult<Vec<PdfWorkspaceTemplateAssignment>>;

  /// Return all workspaces that have `tpl` assigned, ordered by `assigned_at`
  /// ascending. Used by the admin UI to show "this template is currently used
  /// by these workspaces".
  async fn list_for_template(&self, tpl: uuid::Uuid) -> RepoResult<Vec<PdfWorkspaceTemplateAssignment>>;

  /// Look up a single assignment row. Returns `None` if no row matches the
  /// `(workspace_id, template_id)` pair.
  async fn get(&self, ws: uuid::Uuid, tpl: uuid::Uuid) -> RepoResult<Option<PdfWorkspaceTemplateAssignment>>;

  /// Grant a workspace access to a template.
  ///
  /// Idempotent: if the assignment already exists, the call succeeds without
  /// error (no change to `is_default`).
  async fn assign(
    &self,
    ws: uuid::Uuid,
    tpl: uuid::Uuid,
    assigned_by: uuid::Uuid,
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<()>;

  /// Revoke a workspace's access to a template.
  ///
  /// Refuse removal of the workspace default. Missing assignments return false
  /// without an audit; assignment/default/settings and audit commit together.
  async fn unassign(
    &self,
    ws: uuid::Uuid,
    tpl: uuid::Uuid,
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<bool>;

  /// Atomically designate `tpl` as the default template for `ws`.
  ///
  /// Any previously-default template for `ws` has its `is_default` set to
  /// `false` in the same transaction, satisfying the partial unique index
  /// `uniq_default_per_ws`. The export-settings default and supplied audit
  /// are part of that same transaction; unassigned templates are rejected.
  async fn set_default(
    &self,
    ws: uuid::Uuid,
    tpl: uuid::Uuid,
    updated_by: uuid::Uuid,
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<()>;
}

/// Persistence operations for the PDF render projection. Reads intentionally
/// return the combined document-branding/settings snapshot the renderer needs;
/// writes stay owner-specific so settings-only mutations cannot clear document
/// branding fields and vice versa.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PdfWorkspaceDocumentBrandingReset {
  /// Whether a workspace-owned document-branding profile existed and was
  /// removed. Global document branding is never touched by this reset.
  pub removed_profile: bool,
  /// Print-logo keys removed from the live profile. Retain their committed
  /// bytes: admitted exports can still reference them after profile reset.
  pub removed_logo_blobs: Vec<String>,
  /// Number of workspace-owned print-logo `brand_assets` rows removed.
  pub removed_asset_rows: u64,
}

/// Complete metadata for one persisted document-branding logo object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfDocumentBrandLogoAsset {
  pub blob_key: String,
  pub sha256: String,
  pub mime: String,
  pub byte_size: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfDocumentColorPalette {
  pub theme_slug: String,
  pub theme_name: String,
  pub palette_key: String,
  pub name: String,
  pub primary_color: String,
  pub accent_color: String,
  pub rule_color: String,
  pub text_color: String,
  pub background_color: String,
  pub is_default: bool,
}

/// Partial PDF-settings mutation applied to the locked effective settings.
/// Omitted fields preserve the prior value; `Some(None)` explicitly clears a
/// nullable setting. The trusted CLI may omit audit without a synthetic actor.
#[derive(Debug, Clone, Default)]
pub struct PdfExportSettingsPatch {
  pub workspace_id: uuid::Uuid,
  pub default_template_id: Option<Option<uuid::Uuid>>,
  pub default_paper_size: Option<Option<String>>,
  pub default_locale: Option<Option<String>>,
  pub default_color_profile: Option<Option<String>>,
  pub default_image_quality: Option<Option<String>>,
  pub ligatures_enabled: Option<bool>,
  pub updated_at: chrono::DateTime<chrono::Utc>,
  pub updated_by: uuid::Uuid,
}

impl PdfExportSettingsPatch {
  /// Replace all settings for existing full-replacement/CLI callers.
  pub fn replace(asset: &PdfWorkspaceBrandAsset) -> Self {
    Self {
      workspace_id: asset.workspace_id,
      default_template_id: Some(asset.default_template_id),
      default_paper_size: Some(asset.default_paper_size.clone()),
      default_locale: Some(asset.default_locale.clone()),
      default_color_profile: Some(asset.default_color_profile.clone()),
      default_image_quality: Some(asset.default_image_quality.clone()),
      ligatures_enabled: Some(asset.ligatures_enabled),
      updated_at: asset.updated_at,
      updated_by: asset.updated_by,
    }
  }
}

/// Mutations capture before/after values under the workspace lock. A supplied
/// authenticated audit actor makes audit persistence part of the commit.
#[async_trait]
pub trait PdfWorkspaceBrandAssetRepository: Send + Sync {
  /// Return the effective render projection for a workspace.
  async fn get(&self, ws: uuid::Uuid) -> RepoResult<Option<PdfWorkspaceBrandAsset>>;

  /// Return document-safe palettes for the workspace's effective server theme.
  async fn list_document_color_palettes(&self, ws: uuid::Uuid) -> RepoResult<Vec<PdfDocumentColorPalette>>;

  /// Test whether a palette belongs to the workspace's effective server theme.
  async fn document_color_palette_exists(&self, ws: uuid::Uuid, palette_key: &str) -> RepoResult<bool>;

  /// Set exactly one document-logo slot and preserve all other document
  /// branding fields. Return the previous effective key captured under the
  /// workspace lock. A supplied audit commits atomically with the mutation.
  /// Committed previous bytes may remain captured by exports; do not delete them.
  async fn set_document_logo_blob(
    &self,
    ws: uuid::Uuid,
    slot: PdfDocumentBrandLogoSlot,
    asset: Option<PdfDocumentBrandLogoAsset>,
    updated_by: uuid::Uuid,
    updated_at: chrono::DateTime<chrono::Utc>,
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<Option<String>>;

  /// Set the document footer text and preserve logos and colour policy.
  async fn set_document_branding_text(
    &self,
    ws: uuid::Uuid,
    footer_text: Option<String>,
    updated_by: uuid::Uuid,
    updated_at: chrono::DateTime<chrono::Utc>,
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<()>;

  /// Set the document colour policy to either custom primary/accent colors or
  /// back to the theme palette, preserving logos and footer/legal text.
  async fn set_document_branding_colors(
    &self,
    ws: uuid::Uuid,
    primary: Option<String>,
    accent: Option<String>,
    updated_by: uuid::Uuid,
    updated_at: chrono::DateTime<chrono::Utc>,
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<()>;

  /// Select a server-owned document colour policy without touching logos or
  /// footer/legal text. `theme_palette` requires one of the seeded palette
  /// keys for the effective theme; `plain` must use the canonical `plain` key.
  async fn set_document_branding_color_policy(
    &self,
    ws: uuid::Uuid,
    policy: &str,
    palette_key: &str,
    updated_by: uuid::Uuid,
    updated_at: chrono::DateTime<chrono::Utc>,
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<()>;

  /// Remove the workspace-owned document-branding override and its
  /// workspace-owned print-logo asset rows. Global document branding and PDF
  /// export settings are outside this owner and must not be modified.
  async fn reset_workspace_document_branding(
    &self,
    ws: uuid::Uuid,
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<PdfWorkspaceDocumentBrandingReset>;

  /// Insert or update only PDF export settings:
  /// default template, paper size, locale, ICC profile, image quality and
  /// ligature policy.
  async fn upsert_pdf_export_settings(
    &self,
    patch: &PdfExportSettingsPatch,
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<()>;
}

/// Upload-only license metadata recorded with the authoritative font row.
#[derive(Debug, Clone)]
pub struct PdfFontUploadAudit {
  pub actor: crate::audit::AuditActor,
  pub license_description: Option<String>,
  pub license_url: Option<String>,
}

/// Authenticated approval/rejection audit; local CLI writes keep their own policy.
#[derive(Debug, Clone)]
pub struct PdfFontStatusAudit {
  pub actor: crate::audit::AuditActor,
  pub rejection_reason: Option<String>,
}

/// Persistence operations for the server-side font library
/// (table: `pdf_fonts`).
#[async_trait]
pub trait PdfFontRepository: Send + Sync {
  /// Return all fonts, optionally filtered to a specific license status.
  ///
  /// `status = None` returns all uploaded add-ons regardless of status. Bundled
  /// Theme DB assets are a separate owner.
  async fn list(&self, status: Option<PdfFontLicenseStatus>) -> RepoResult<Vec<PdfFont>>;

  /// Fetch a single font by primary key.
  ///
  /// Returns `None` for an unknown id or a bundled marker. Detail views use this
  /// reader; mutations read their own snapshots under the transaction lock.
  async fn get(&self, id: uuid::Uuid) -> RepoResult<Option<PdfFont>>;

  /// Look up a font by its SHA-256 content hash.
  ///
  /// Returns `None` if no font with that hash exists. Used for dedup on
  /// upload.
  async fn get_by_sha256(&self, sha256: &str) -> RepoResult<Option<PdfFont>>;

  /// Delete an uploaded row and its audit in one transaction, returning the
  /// locked removed row for post-commit blob cleanup, or `None` if absent.
  ///
  /// Bundled entries (`uploaded_by = None`) cannot be deleted through this port. Callers deleting uploaded rows are responsible for
  /// cleaning up the matching blob in storage.
  async fn delete(&self, id: uuid::Uuid, audit_actor: Option<crate::audit::AuditActor>) -> RepoResult<Option<PdfFont>>;

  /// Persist a new font record and optional authenticated audit atomically. The `sha256` column is UNIQUE; callers should
  /// call [`get_by_sha256`](PdfFontRepository::get_by_sha256) first to detect
  /// duplicates before calling this. Admin uploads pass `Some(user_id)`; existing
  /// bundled markers are not an operator-upload capability.
  async fn create(&self, font: &PdfFont, audit: Option<PdfFontUploadAudit>) -> RepoResult<()>;

  /// Update approval and an optional CLI license override under the same row
  /// lock as the audit; return the committed operation snapshot. Bundled rows
  /// remain outside this add-on mutation port. Audited rejection carries its reason.
  ///
  /// `approver` must be `Some` when `status` is `Approved` or `Rejected`.
  /// When `status` is `Pending` (e.g. to reset a mis-reviewed font),
  /// `approver` should be `None`.
  async fn set_status(
    &self,
    id: uuid::Uuid,
    status: PdfFontLicenseStatus,
    approver: Option<uuid::Uuid>,
    license_override: Option<PdfFontLicense>,
    audit: Option<PdfFontStatusAudit>,
  ) -> RepoResult<PdfFont>;

  /// Resolve the preferred approved PDF asset for a server Theme DB font
  /// family. Operator-uploaded `pdf_fonts` and bundled Theme DB fonts remain
  /// separate storage models behind this single PDF-font capability owner.
  async fn resolve_theme_font_asset(&self, family_slug: &str) -> RepoResult<Option<PdfThemeFontAsset>>;

  /// Return every approved uploaded font asset that may be materialized for a
  /// PDF render. Theme DB and operator-uploaded font storage stay hidden
  /// behind this single catalog projection.
  async fn list_approved_render_assets(&self) -> RepoResult<Vec<PdfApprovedFontAsset>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfThemeFontAsset {
  pub family_slug: String,
  pub family: String,
  pub asset_key: String,
  pub sha256: String,
  pub format: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfApprovedFontAsset {
  pub family: String,
  pub style: String,
  pub blob_key: String,
  pub sha256: String,
  pub format: String,
}

// --- Document Metadata Repository Traits ---
// P-DOC-ATTR-C keeps attribute persistence behind one coarse repository port
// while services own policy, validation and transition decisions.

#[async_trait::async_trait]
pub trait DocumentMetadataPolicyRepository: Send + Sync {
  /// Preview the native insert defaults without creating a document. This is
  /// metadata for an already admitted prepared import, never write authority.
  async fn initial_metadata_index(
    &self,
    _workspace_id: uuid::Uuid,
    _doc_id: uuid::Uuid,
    _actor_id: uuid::Uuid,
  ) -> RepoResult<DocumentMetadataIndexRow> {
    Err(RepositoryError::Storage(
      "native initial metadata preview is unavailable".into(),
    ))
  }

  async fn list_metadata_field_definitions(&self) -> RepoResult<Vec<DocumentMetadataFieldDefinition>>;
  async fn get_metadata_field_definition(&self, key: &str) -> RepoResult<Option<DocumentMetadataFieldDefinition>>;
  async fn create_metadata_field_definition(&self, definition: &DocumentMetadataFieldDefinition) -> RepoResult<()>;
  async fn update_metadata_field_definition(
    &self,
    key: &str,
    patch: &DocumentMetadataFieldDefinitionPatch,
  ) -> RepoResult<DocumentMetadataFieldDefinition>;

  async fn list_metadata_value_definitions(&self, field_key: &str) -> RepoResult<Vec<DocumentMetadataValueDefinition>>;
  async fn create_metadata_value_definition(
    &self,
    value: &DocumentMetadataValueDefinition,
  ) -> RepoResult<DocumentMetadataValueDefinition>;
  async fn upsert_metadata_value_definition(
    &self,
    value: &DocumentMetadataValueDefinition,
  ) -> RepoResult<DocumentMetadataValueDefinition>;

  async fn list_status_schemas(&self) -> RepoResult<Vec<DocumentStatusSchema>>;
  async fn upsert_status_schema(&self, schema: &DocumentStatusSchema) -> RepoResult<DocumentStatusSchema>;
  async fn list_status_values(&self, schema_key: &str) -> RepoResult<Vec<DocumentStatusValue>>;
  /// An omitted mapping preserves an existing value and defaults new values to draft.
  async fn upsert_status_value(
    &self,
    value: &DocumentStatusValue,
    okf_status: Option<DocumentOkfStatus>,
  ) -> RepoResult<DocumentStatusValue>;
  async fn transition_exists(&self, from_status_id: uuid::Uuid, to_status_id: uuid::Uuid) -> RepoResult<bool>;
  async fn get_transition(
    &self,
    from_status_id: uuid::Uuid,
    to_status_id: uuid::Uuid,
  ) -> RepoResult<Option<DocumentStatusTransition>>;
  async fn upsert_status_transition(
    &self,
    transition: &DocumentStatusTransition,
  ) -> RepoResult<DocumentStatusTransition>;

  async fn list_document_types(&self) -> RepoResult<Vec<DocumentTypeDefinition>>;
  async fn upsert_document_type(&self, doc_type: &DocumentTypeDefinition) -> RepoResult<DocumentTypeDefinition>;
  async fn get_workspace_settings(&self, workspace_id: uuid::Uuid) -> RepoResult<Option<DocumentWorkspaceSettings>>;
  async fn get_persisted_workspace_settings(
    &self,
    workspace_id: uuid::Uuid,
  ) -> RepoResult<Option<DocumentWorkspaceSettings>>;
  async fn upsert_workspace_settings(&self, settings: &DocumentWorkspaceSettings) -> RepoResult<()>;

  async fn get_metadata_state(&self, doc_id: uuid::Uuid) -> RepoResult<Option<DocumentMetadataState>>;
  async fn list_metadata_index(&self, workspace_id: uuid::Uuid) -> RepoResult<Vec<DocumentMetadataIndexRow>>;

  /// Read the workspace index version without reconstructing the index rows.
  async fn metadata_index_version(&self, workspace_id: uuid::Uuid) -> RepoResult<String>;

  /// Read version and rows from one repeatable-read database snapshot.
  async fn list_metadata_index_versioned(
    &self,
    workspace_id: uuid::Uuid,
  ) -> RepoResult<crate::entities::DocumentMetadataIndexSnapshot>;

  /// Resolve the supplied authorized row references, including historical labels.
  /// Version labels must belong to the supplied document, not just a matching ID.
  async fn metadata_index_labels(
    &self,
    rows: &[DocumentMetadataIndexRow],
  ) -> RepoResult<std::collections::BTreeMap<Uuid, DocumentMetadataIndexLabels>>;

  async fn document_runtime_overview(&self) -> RepoResult<DocumentRuntimeOverview>;
}

#[async_trait::async_trait]
pub trait DocumentMetadataRepository: Send + Sync {
  async fn workspace_id_for_document(&self, doc_id: uuid::Uuid) -> RepoResult<Option<uuid::Uuid>>;

  async fn get_projection(
    &self,
    doc_id: uuid::Uuid,
    workspace_id: uuid::Uuid,
  ) -> RepoResult<Option<DocumentMetadataProjection>>;

  /// Read the projection and the cache version from one database snapshot.
  ///
  /// Cache fills must use this method so a concurrent writer cannot attach an
  /// older projection to a newer version key.
  async fn get_projection_versioned(
    &self,
    doc_id: uuid::Uuid,
    workspace_id: uuid::Uuid,
  ) -> RepoResult<Option<(String, DocumentMetadataProjection)>>;

  async fn projection_version(&self, doc_id: uuid::Uuid, workspace_id: uuid::Uuid) -> RepoResult<Option<String>>;

  async fn apply_patch(
    &self,
    doc_id: uuid::Uuid,
    actor_id: uuid::Uuid,
    patch: &DocumentMetadataPatch,
  ) -> RepoResult<()>;

  async fn rematerialize_workspace_defaults(
    &self,
    workspace_id: uuid::Uuid,
    actor_id: Option<uuid::Uuid>,
  ) -> RepoResult<DocumentMetadataMaterializationSummary>;

  async fn mark_current_version(
    &self,
    doc_id: uuid::Uuid,
    version_id: uuid::Uuid,
    versioned_at: chrono::DateTime<chrono::Utc>,
    actor_id: uuid::Uuid,
  ) -> RepoResult<()>;

  async fn transition_status(&self, doc_id: uuid::Uuid, status_id: uuid::Uuid, actor_id: uuid::Uuid) -> RepoResult<()>;
}

// --- Document Versioning Repository Traits ---
// Mirrors the canonical document-version tables.
// SQLx implementations live in `crates/infrastructure/src/document_version/`.
// Delivery package: P-DOC-VER-01

/// Persistence operations for user-visible named document snapshots
/// (table: `document_version`).
///
/// Each named version wraps one `doc_histories` row (the Yjs snapshot) with a
/// human-readable label.  The `(doc_id, label)` UNIQUE constraint is enforced
/// at the SQL level; implementations must surface violations as
/// `RepositoryError::Conflict`.
#[async_trait::async_trait]
pub trait DocumentVersionRepository: Send + Sync {
  /// Return all named versions for a document, ordered by `created_at` ascending.
  async fn list_for_doc(&self, doc_id: uuid::Uuid) -> RepoResult<Vec<DocumentVersion>>;

  /// Fetch a single version by its primary key.  Returns `None` if not found.
  async fn get(&self, id: uuid::Uuid) -> RepoResult<Option<DocumentVersion>>;

  /// Return the underlying snapshot bytes for the latest named version of a
  /// document. Used by auto-versioning to skip unchanged daily snapshots without
  /// creating new `doc_histories` rows.
  async fn latest_snapshot_for_doc(&self, doc_id: uuid::Uuid) -> RepoResult<Option<Vec<u8>>>;

  /// Return one named version together with its immutable DocHistory snapshot.
  ///
  /// Diff/read paths use this join to keep authorization anchored on the
  /// user-visible version row while loading the binary snapshot in one
  /// repository call.
  async fn snapshot_for_version(&self, id: uuid::Uuid) -> RepoResult<Option<(DocumentVersion, Vec<u8>)>>;

  /// Persist a new named version row.
  ///
  /// Returns `RepositoryError::Conflict` if a version with the same
  /// `(doc_id, label)` already exists.
  async fn create(&self, version: &DocumentVersion) -> RepoResult<()>;

  async fn create_relation(&self, relation: &DocumentVersionRelation) -> RepoResult<()>;

  async fn list_relations_for_version(&self, version_id: uuid::Uuid) -> RepoResult<Vec<DocumentVersionRelation>>;

  async fn next_counter_value(&self, doc_id: uuid::Uuid, counter_key: &str) -> RepoResult<i64>;

  async fn default_policy(&self, workspace_id: Option<uuid::Uuid>) -> RepoResult<Option<DocumentVersionPolicy>>;
  async fn list_policies(&self) -> RepoResult<Vec<DocumentVersionPolicy>>;
  async fn upsert_policy(&self, policy: &DocumentVersionPolicy) -> RepoResult<DocumentVersionPolicy>;

  /// Mark a version as pinned (`is_pinned = true`).
  ///
  /// Pinned versions are excluded from GC by
  /// [`gc_unpinned_older_than_count`](Self::gc_unpinned_older_than_count).
  async fn pin(&self, id: uuid::Uuid) -> RepoResult<()>;

  /// Clear the pinned flag (`is_pinned = false`).
  async fn unpin(&self, id: uuid::Uuid) -> RepoResult<()>;

  /// Update mutable user-facing metadata for a named version.
  ///
  /// Implementations must keep the underlying `doc_history_id`, creator and
  /// timestamps immutable. `(doc_id, label)` uniqueness still applies and must
  /// surface as `RepositoryError::Conflict`.
  async fn update_metadata(&self, id: uuid::Uuid, label: &str, description: Option<&str>) -> RepoResult<()>;

  /// Delete a named version.
  ///
  /// Implementations **must** refuse to delete a pinned version and return
  /// `RepositoryError::Conflict("version is pinned")` in that case.
  ///
  /// Deleting a version does NOT affect the underlying `doc_histories` row
  /// (the FK is `ON DELETE RESTRICT` in reverse — deleting `doc_histories`
  /// would fail while any `document_version` row references it).
  async fn delete(&self, id: uuid::Uuid) -> RepoResult<()>;

  /// Prune unpinned versions for `doc_id` so that at most `retention_count`
  /// unpinned versions are kept (oldest first).
  ///
  /// Returns the deleted label rows so callers can emit one audit event per
  /// pruned version. The underlying `doc_histories` rows must remain untouched.
  async fn gc_unpinned_older_than_count(
    &self,
    doc_id: uuid::Uuid,
    retention_count: i32,
  ) -> RepoResult<Vec<DocumentVersion>>;
}

/// Persistence operations for per-document auto-versioning configuration
/// (table: `document_versioning_settings`).
///
/// The `get` method must return sensible defaults when no row exists for the
/// given `doc_id` (enabled=false, retention=10, triggers=[]).  It must NOT
/// insert a row on read.  All setters use `INSERT … ON CONFLICT DO UPDATE`.
#[async_trait::async_trait]
pub trait DocumentVersioningSettingsRepository: Send + Sync {
  /// Return worker heartbeat health and the workspace's last successful edit capture.
  async fn edit_capture_runtime_status(
    &self,
    workspace_id: uuid::Uuid,
  ) -> RepoResult<crate::entities::DocumentEditCaptureRuntimeStatus>;

  /// Return the versioning settings for `doc_id`.
  ///
  /// When no row exists, returns defaults:
  /// `enabled = false`, `retention_count = 10`, `auto_version_on = []`.
  async fn get(&self, doc_id: uuid::Uuid) -> RepoResult<DocumentVersioningSettings>;

  /// Return all live workspace documents whose versioning settings are enabled
  /// and include the given trigger.
  async fn list_enabled_for_trigger(&self, trigger: AutoVersionTrigger) -> RepoResult<Vec<DocumentAutoVersionTarget>>;

  /// Return all live workspace documents that have explicit versioning settings
  /// and therefore participate in retention-GC.
  async fn list_retention_targets(&self) -> RepoResult<Vec<DocumentVersionRetentionTarget>>;

  /// Replace the auto-trigger list for a document (upsert).
  async fn set_triggers(&self, doc_id: uuid::Uuid, triggers: &[AutoVersionTrigger]) -> RepoResult<()>;

  /// Update the GC retention count for a document (upsert).
  async fn set_retention_count(&self, doc_id: uuid::Uuid, n: i32) -> RepoResult<()>;

  /// Enable or disable auto-versioning for a document (upsert).
  async fn set_enabled(&self, doc_id: uuid::Uuid, enabled: bool) -> RepoResult<()>;

  /// List every active workspace with its optional versioning override.
  async fn list_workspace_overrides(&self) -> RepoResult<Vec<WorkspaceDocumentVersioningSettings>>;

  /// Read one active workspace and its optional versioning overrides without
  /// materializing an override row.
  async fn get_workspace_override(
    &self,
    workspace_id: uuid::Uuid,
  ) -> RepoResult<Option<WorkspaceDocumentVersioningSettings>>;

  /// Patch submitted history fields under the workspace settings lock.
  ///
  /// The revision covers every workspace history field, but conflicts are
  /// checked only for submitted members. Unrelated Admin and Web edits can
  /// therefore interleave without being overwritten or rejected.
  async fn patch_workspace_edit_capture(
    &self,
    workspace_id: uuid::Uuid,
    patch: WorkspaceEditCaptureSettingsPatch,
    expected_revision: &str,
    updated_by: uuid::Uuid,
  ) -> RepoResult<Option<WorkspaceDocumentVersioningSettings>>;

  /// Replace or clear one workspace override and return the resulting
  /// workspace projection. All `None` values remove the override row.
  async fn set_workspace_override(
    &self,
    workspace_id: uuid::Uuid,
    enabled: Option<bool>,
    auto_version_on: Option<Vec<AutoVersionTrigger>>,
    retention_count: Option<i32>,
    updated_by: uuid::Uuid,
  ) -> RepoResult<Option<WorkspaceDocumentVersioningSettings>>;
}

// ---------------------------------------------------------------------------
// P-PDF-TPL-COLOR-01 — ICC profile persistence
// ---------------------------------------------------------------------------

/// Persistence operations for admin-uploaded ICC color profiles
/// (table: `pdf_icc_profiles`).
///
/// Uniqueness is enforced at two levels:
/// - `name` must be unique across all profiles.
/// - `sha256` must be unique (content-addressed dedup).
///
/// Both constraints surface as [`RepositoryError::Conflict`].
#[async_trait::async_trait]
pub trait PdfIccProfileRepository: Send + Sync {
  /// List all ICC profiles, ordered by `name`.
  async fn list(&self) -> RepoResult<Vec<PdfIccProfile>>;

  /// Fetch a single profile by primary key. Returns `None` if not found.
  async fn get(&self, id: uuid::Uuid) -> RepoResult<Option<PdfIccProfile>>;

  /// Fetch a profile by its unique human-readable name. Returns `None` if not found.
  async fn get_by_name(&self, name: &str) -> RepoResult<Option<PdfIccProfile>>;

  /// Persist a new ICC profile and its optional authenticated audit atomically.
  ///
  /// Returns [`RepositoryError::Conflict`] if a profile with the same `name`
  /// or `sha256` already exists. `uploaded_by = None` is reserved for the
  /// system bootstrap (e.g. the bundled sRGB v4 seed); all admin uploads
  /// pass `Some(admin_id)`.
  async fn create(
    &self,
    name: &str,
    profile_type: PdfIccProfileType,
    blob_key: &str,
    sha256: &str,
    uploaded_by: Option<uuid::Uuid>,
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<PdfIccProfile>;

  /// Delete an ICC profile by primary key.
  ///
  /// Return the locked removed row for post-commit cleanup, or `None` if absent.
  /// Audit and existing ON DELETE SET NULL default references commit together;
  /// system entries retain the deployed deletion policy.
  async fn delete(
    &self,
    id: uuid::Uuid,
    audit_actor: Option<crate::audit::AuditActor>,
  ) -> RepoResult<Option<PdfIccProfile>>;
}

/// Persistence operations for the PDF-Export V2 render-audit log
/// (table: `pdf_export_render_audit`).
///
/// Compliance-mandated trail — one row per export call. Insertion is on
/// the synchronous critical path: the `start_pdf_export` mutation writes
/// the audit row before kicking off the render, and a DB failure here
/// aborts the render so a missing audit entry never goes unnoticed.
///
/// Listing/filtering operations stay deliberately small — production
/// access is via the admin GraphQL surface (P-PDF-TPL-AUDIT-01-04 — the
/// CLI purge subcommand is what handles retention). The trait
/// intentionally does not expose a `delete_one` method: render audit
/// entries are immutable.
#[async_trait::async_trait]
pub trait PdfExportRenderAuditRepository: Send + Sync {
  /// Persist a render-audit entry. The `id` and `created_at` fields are
  /// allocated by the implementation if their incoming values are
  /// [`Uuid::nil`] / `DateTime::default` (the GraphQL caller passes
  /// either explicit values or sentinel defaults).
  async fn record(&self, entry: &PdfExportRenderAudit) -> RepoResult<()>;

  /// Return the most recent `limit` audit entries for `workspace_id`,
  /// newest first. Used by the admin UI to render a per-workspace
  /// activity feed.
  async fn list_for_workspace(&self, workspace_id: uuid::Uuid, limit: i64) -> RepoResult<Vec<PdfExportRenderAudit>>;

  /// Return the most recent `limit` audit entries for `actor_id`, newest
  /// first. Used by per-user compliance reports.
  async fn list_for_actor(&self, actor_id: uuid::Uuid, limit: i64) -> RepoResult<Vec<PdfExportRenderAudit>>;

  /// Bulk delete every entry created strictly before `before`. Returns
  /// the number of rows removed. Backs the
  /// `myoxus-cli pdf audit purge` subcommand
  /// (P-PDF-TPL-AUDIT-01-04) — never called from request paths.
  async fn purge_before(&self, before: chrono::DateTime<chrono::Utc>) -> RepoResult<u64>;
}

/// Persistence operations for the `organization` mandant frame.
///
/// Single-tenant deployments hold exactly one row (key=`myoxus`). Multi-tenant
/// deployments would treat the same trait as a normal CRUD repository.
#[async_trait]
pub trait OrganizationRepository: Send + Sync {
  /// Look up an organization by stable key (`organization.key`). Returns
  /// `None` if the key is unknown.
  async fn get_by_key(&self, key: &str) -> RepoResult<Option<Organization>>;

  /// Look up an organization by id.
  async fn get_by_id(&self, id: OrganizationId) -> RepoResult<Option<Organization>>;

  /// Update name / slug / metadata. The key is immutable.
  async fn update(&self, id: OrganizationId, name: &str, slug: &str, metadata: &Value) -> RepoResult<Organization>;
}

/// Persistence operations for `organization_unit_type`.
#[async_trait]
pub trait OrganizationUnitTypeRepository: Send + Sync {
  /// Return all types of an organization. `include_inactive=true` includes
  /// soft-disabled types (admin diagnostic view).
  async fn list(&self, org: OrganizationId, include_inactive: bool) -> RepoResult<Vec<OrganizationUnitType>>;

  /// Deterministic bounded discovery (`is_preset DESC, key, id`).
  async fn list_page(
    &self,
    org: OrganizationId,
    include_inactive: bool,
    offset: i64,
    limit: i64,
  ) -> RepoResult<Vec<OrganizationUnitType>>;

  /// Look up by id.
  async fn get_by_id(&self, id: OrganizationUnitTypeId) -> RepoResult<Option<OrganizationUnitType>>;

  /// Look up by stable key within an organization.
  async fn get_by_key(&self, org: OrganizationId, key: &str) -> RepoResult<Option<OrganizationUnitType>>;

  /// Insert or update a type (upsert on `(organization_id, key)`). Returns
  /// the persisted row.
  async fn upsert(&self, ty: &OrganizationUnitType) -> RepoResult<OrganizationUnitType>;

  /// Soft-disable a type. Existing OUs that reference the type are not
  /// affected, but no new OU may be created with this type until reactivated.
  async fn deactivate(&self, id: OrganizationUnitTypeId) -> RepoResult<()>;
}

/// Persistence operations for `organization_unit`.
#[async_trait]
pub trait OrganizationUnitRepository: Send + Sync {
  /// List all units of an organization, optionally filtered by status.
  async fn list(
    &self,
    org: OrganizationId,
    status: Option<OrganizationUnitStatus>,
  ) -> RepoResult<Vec<OrganizationUnit>>;

  /// Children of `parent` (or root-level units if `parent` is `None`).
  async fn list_children(
    &self,
    org: OrganizationId,
    parent: Option<OrganizationUnitId>,
  ) -> RepoResult<Vec<OrganizationUnit>>;

  /// All units that contain `user` as member (any role).
  async fn list_for_user(&self, user: UserId) -> RepoResult<Vec<OrganizationUnit>>;

  /// Look up by id.
  async fn get_by_id(&self, id: OrganizationUnitId) -> RepoResult<Option<OrganizationUnit>>;

  /// Batch lookup for bounded membership projections; never scans all units.
  async fn get_by_ids(&self, ids: &[OrganizationUnitId]) -> RepoResult<Vec<OrganizationUnit>>;

  /// Insert or update an OU. Returns the persisted row.
  ///
  /// Implementations MUST refuse parent moves that would create a cycle and
  /// signal them as `RepositoryError::Conflict("organization_unit cycle")`.
  async fn upsert(&self, unit: &OrganizationUnit) -> RepoResult<OrganizationUnit>;

  /// Move `unit` under `new_parent` (root if `None`). Performs the same
  /// cycle check as `upsert`.
  async fn set_parent(&self, unit: OrganizationUnitId, new_parent: Option<OrganizationUnitId>) -> RepoResult<()>;

  /// Set status to `disabled` or `archived`. Hard delete is not exposed.
  async fn set_status(&self, unit: OrganizationUnitId, status: OrganizationUnitStatus) -> RepoResult<()>;

  /// Cached counts (children + members + workspaces) for tree-view rendering.
  async fn counts(&self, unit: OrganizationUnitId) -> RepoResult<OrganizationUnitCounts>;

  /// Free-text search over `name`/`slug` (ILIKE substring match). Used by
  /// the manager-/admin-scoped `searchOrganizationUnits` resolver
  /// (P-AR-0-S01). The implementation MUST clamp `limit` to `[1, 50]` and
  /// MUST sort results by `name ASC`. Membership-scoping is applied at the
  /// resolver layer, not in the repository — non-admin callers receive the
  /// full match-set here and the resolver intersects it with the user's
  /// OU membership list.
  async fn search(&self, query: &str, limit: i64) -> RepoResult<Vec<OrganizationUnit>>;

  /// Walk the parent chain of `unit` upwards (root-first) and return the
  /// list of ancestor names from the topmost ancestor down to the direct
  /// parent of `unit` (the unit itself is NOT included). Used by the
  /// `searchOrganizationUnits` resolver to render breadcrumbs without an
  /// extra round-trip per hit. Implementations MUST stop after at most
  /// `MAX_HIERARCHY_DEPTH` (32) hops to bound the query cost.
  async fn breadcrumb_for_unit(&self, unit: OrganizationUnitId) -> RepoResult<Vec<String>>;
}

/// Transactional persistence boundary for organization-unit lifecycle writes.
///
/// Implementations must lock the target row for move/status/delete and must
/// re-evaluate reference blockers in the same transaction as permanent delete.
#[async_trait]
pub trait OrganizationUnitLifecycleRepository: Send + Sync {
  async fn create(&self, unit: &OrganizationUnit) -> RepoResult<OrganizationUnit>;
  async fn update(&self, unit: &OrganizationUnit) -> RepoResult<OrganizationUnit>;
  async fn move_unit(
    &self,
    unit: OrganizationUnitId,
    parent: Option<OrganizationUnitId>,
  ) -> RepoResult<OrganizationUnit>;
  async fn set_lifecycle_status(
    &self,
    unit: OrganizationUnitId,
    status: OrganizationUnitStatus,
  ) -> RepoResult<OrganizationUnit>;
  async fn deletion_preview(&self, unit: OrganizationUnitId) -> RepoResult<OrganizationUnitDeletionPreview>;
  async fn delete_permanently(
    &self,
    unit: OrganizationUnitId,
    confirmed_name: &str,
    preview_revision: DateTime<Utc>,
  ) -> RepoResult<OrganizationUnit>;
}

/// Aggregate row used by tree-views to avoid N+1 queries.
#[derive(Debug, Clone)]
pub struct OrganizationUnitCounts {
  pub child_unit_count: i64,
  pub member_count: i64,
  pub workspace_count: i64,
}

/// Persistence operations for `organization_unit_member`.
#[async_trait]
pub trait OrganizationUnitMemberRepository: Send + Sync {
  /// All members of `unit`, optionally filtered by role.
  async fn list_members(
    &self,
    unit: OrganizationUnitId,
    role: Option<OrganizationUnitRole>,
  ) -> RepoResult<Vec<OrganizationUnitMember>>;

  /// All OU memberships of `user` (any role).
  async fn list_for_user(&self, user: UserId) -> RepoResult<Vec<OrganizationUnitMember>>;

  /// Bounded members ordered by creation time and user ID.
  async fn list_members_page(
    &self,
    unit: OrganizationUnitId,
    role: Option<OrganizationUnitRole>,
    offset: i64,
    limit: i64,
  ) -> RepoResult<Vec<OrganizationUnitMember>>;

  /// Indexed per-user discovery, ordered by OU name and ID. Diagnostic reads
  /// include retained assignments to inactive units explicitly.
  async fn list_for_user_page(
    &self,
    user: UserId,
    include_inactive: bool,
    offset: i64,
    limit: i64,
  ) -> RepoResult<Vec<OrganizationUnitMember>>;

  /// Look up a single membership row.
  async fn get(&self, unit: OrganizationUnitId, user: UserId) -> RepoResult<Option<OrganizationUnitMember>>;

  /// Insert or update a membership. Source defaults to `manual`.
  async fn upsert(&self, member: &OrganizationUnitMember) -> RepoResult<OrganizationUnitMember>;

  /// Remove `user` from `unit`. Idempotent.
  async fn remove(&self, unit: OrganizationUnitId, user: UserId) -> RepoResult<()>;
}

/// Persistence operations for `organization_unit_workspace`.
#[async_trait]
pub trait OrganizationUnitWorkspaceRepository: Send + Sync {
  /// Links from an OU to active, non-deleted workspaces. Unpublished targets stay hidden.
  async fn list_for_unit(&self, unit: OrganizationUnitId) -> RepoResult<Vec<OrganizationUnitWorkspace>>;

  /// Units linked to an active, non-deleted workspace; used for ordinary OU authority.
  async fn list_for_workspace(&self, workspace: WorkspaceId) -> RepoResult<Vec<OrganizationUnitWorkspace>>;

  /// Look up a single link row by `(unit, workspace, relationship)`.
  async fn get(
    &self,
    unit: OrganizationUnitId,
    workspace: WorkspaceId,
    relationship: OrganizationUnitWorkspaceRelationship,
  ) -> RepoResult<Option<OrganizationUnitWorkspace>>;

  /// Atomically set the single effective relationship for `(unit, workspace)`.
  /// Existing relationship rows for the pair are replaced. Setting `Owner`
  /// transfers OU ownership: the previous owner OU becomes `Managed`, and the
  /// workspace owner-principal projection changes to the new OU in the same
  /// transaction. A previous human Owner is retained as Admin; no user keeps
  /// Owner in an OU-owned shared workspace.
  async fn set_relationship(
    &self,
    unit: OrganizationUnitId,
    workspace: WorkspaceId,
    relationship: OrganizationUnitWorkspaceRelationship,
  ) -> RepoResult<()>;

  /// Remove a single link row. Idempotent.
  async fn unassign(
    &self,
    unit: OrganizationUnitId,
    workspace: WorkspaceId,
    relationship: OrganizationUnitWorkspaceRelationship,
  ) -> RepoResult<()>;
}

/// Persistence operations for `organization_policy` (one row per organization).
#[async_trait]
pub trait OrganizationPolicyRepository: Send + Sync {
  async fn get(&self, org: OrganizationId) -> RepoResult<OrganizationPolicy>;

  /// Update the entire policy row in a single statement.
  async fn upsert(&self, policy: &OrganizationPolicy) -> RepoResult<OrganizationPolicy>;
}

/// Persistence operations for `organization_project_request`.
#[async_trait]
pub trait OrganizationProjectRequestRepository: Send + Sync {
  /// List requests for an organization with optional status filter.
  async fn list(
    &self,
    org: OrganizationId,
    status: Option<ProjectRequestStatus>,
  ) -> RepoResult<Vec<OrganizationProjectRequest>>;

  /// Look up a single request.
  async fn get(&self, id: OrganizationProjectRequestId) -> RepoResult<Option<OrganizationProjectRequest>>;

  /// Create a new request (status `pending` by default).
  async fn create(&self, request: &OrganizationProjectRequest) -> RepoResult<OrganizationProjectRequest>;

  /// Decide on a request — sets status, decided_by, decided_at.
  async fn decide(
    &self,
    id: OrganizationProjectRequestId,
    new_status: ProjectRequestStatus,
    decider: UserId,
  ) -> RepoResult<()>;
}
