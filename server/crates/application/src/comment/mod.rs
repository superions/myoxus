//! Comment service, its storage and ACL ports, and supporting types.
//!
//! [`CommentService`] handles the full lifecycle of document comments:
//! creation (with permission checks), editing, thread resolution, deletion,
//! and @mention notifications.  Access control is delegated to
//! [`CommentAclStore`] and the domain-level [`fixup_doc_role`] function.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult, AuthStore};
use crate::permission::PermissionService;
use myoxus_domain::entities::{Comment, DocRole, WorkspaceRole};
use myoxus_domain::permission::{DocAction, fixup_doc_role};

/// A text-range anchor identifying where in a document a comment is anchored.
///
/// The `quote` is the verbatim excerpt at the anchor; `start`/`end` are
/// byte-level character offsets within the document.  `prefix` and `suffix`
/// provide surrounding context for anchor re-resolution after edits.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SelectionAnchor {
  /// Verbatim quoted text at the anchor position.
  pub quote: String,
  /// Start character offset within the document.
  pub start: Option<usize>,
  /// End character offset within the document.
  pub end: Option<usize>,
  /// Text immediately before the anchor (for context-based re-resolution).
  pub prefix: Option<String>,
  /// Text immediately after the anchor.
  pub suffix: Option<String>,
}

/// Strategy used to re-locate an anchor after the document has been edited.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnchorResolutionStrategy {
  /// The stored offsets still point to the correct position.
  DirectRange,
  /// The quote was found near the original offsets.
  NearbyQuoteSearch,
  /// The quote was found anywhere in the document (fallback).
  GlobalQuoteSearch,
  /// Resolved to a context boundary (paragraph start/end) near the anchor.
  ContextBoundarySearch,
}

/// The result of successfully re-locating a [`SelectionAnchor`] in an edited
/// document.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedSelectionAnchor {
  /// The verbatim text at the resolved position.
  pub quote: String,
  /// Resolved start offset.
  pub start: usize,
  /// Resolved end offset.
  pub end: usize,
  /// Which resolution strategy succeeded.
  pub strategy: AnchorResolutionStrategy,
}

/// Resolution result for an `@mention` token within a comment body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MentionResolution {
  /// The raw mention token (e.g. `"@alice"`).
  pub token: String,
  /// The resolved user ID, or `None` if the mention could not be resolved.
  pub user_id: Option<Uuid>,
}

/// A single entry in a comment's edit history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommentEditHistoryEntry {
  /// Sequential edit record ID.
  pub id: i64,
  /// The comment that was edited.
  pub comment_id: Uuid,
  /// The body value as it was **before** this edit.
  pub body: Value,
  /// User who made the edit.
  pub edited_by: Uuid,
  /// When the edit was made.
  pub edited_at: DateTime<Utc>,
}

/// Filter for listing comment threads within a document.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommentThreadFilter {
  /// Return all threads regardless of state.
  All,
  /// Return only unresolved threads.
  Open,
  /// Return only resolved threads.
  Resolved,
  /// Return only threads started by the requesting user.
  Mine,
}

/// A comment annotated with the requesting user's read state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentThreadView {
  /// The comment data.
  pub comment: Comment,
  /// When the requesting user last read this thread.
  pub read_at: Option<DateTime<Utc>>,
  /// `true` if there are replies posted after `read_at`.
  pub unread: bool,
}

/// ACL port required by the comment service to check document permissions.
#[async_trait]
pub trait CommentAclStore: Send + Sync {
  /// Return the user's role in the given workspace.
  async fn acl_workspace_role(&self, user_id: Uuid, workspace_id: Uuid) -> AuthResult<Option<WorkspaceRole>>;
  /// Return the user's per-document role override.
  async fn acl_doc_role(&self, user_id: Uuid, doc_id: Uuid) -> AuthResult<Option<DocRole>>;
}

#[async_trait]
impl<T> CommentAclStore for T
where
  T: AuthStore + Send + Sync + ?Sized,
{
  async fn acl_workspace_role(&self, user_id: Uuid, workspace_id: Uuid) -> AuthResult<Option<WorkspaceRole>> {
    self.get_workspace_role(user_id, workspace_id).await
  }

  async fn acl_doc_role(&self, user_id: Uuid, doc_id: Uuid) -> AuthResult<Option<DocRole>> {
    self.get_doc_role(user_id, doc_id).await
  }
}

/// Port for resolving persisted mention attributes and email tokens to registered users.
#[async_trait]
pub trait MentionStore: Send + Sync {
  /// Resolve an email address to the corresponding user ID, or `None` if no
  /// registered user has that address.
  async fn mention_user_by_email(&self, email: &str) -> AuthResult<Option<Uuid>>;
  async fn mention_user_by_id(&self, user_id: Uuid) -> AuthResult<Option<Uuid>>;
}

/// Adapts [`AuthStore`] to the [`CommentAclStore`] + [`MentionStore`] ports.
///
/// Allows a single `Arc<dyn AuthStore>` to be passed wherever the comment
/// service needs role resolution or mention lookup.
#[derive(Clone)]
pub struct AuthStoreCommentAdapter {
  store: Arc<dyn AuthStore>,
  permission_service: Option<Arc<PermissionService>>,
}

impl AuthStoreCommentAdapter {
  /// Wrap an auth store in the comment adapter.
  pub fn new(store: Arc<dyn AuthStore>) -> Self {
    Self {
      store,
      permission_service: None,
    }
  }

  /// Wrap an auth store while sharing the server's effective workspace-role
  /// authority. Production wiring must use this constructor so OU-derived
  /// manager access is identical for documents and their comment threads.
  pub fn new_with_permission_service(store: Arc<dyn AuthStore>, permission_service: Arc<PermissionService>) -> Self {
    Self {
      store,
      permission_service: Some(permission_service),
    }
  }
}

#[async_trait]
impl CommentAclStore for AuthStoreCommentAdapter {
  async fn acl_workspace_role(&self, user_id: Uuid, workspace_id: Uuid) -> AuthResult<Option<WorkspaceRole>> {
    match &self.permission_service {
      Some(permission_service) => {
        permission_service
          .get_effective_workspace_role(user_id, workspace_id)
          .await
      }
      None => self.store.get_workspace_role(user_id, workspace_id).await,
    }
  }

  async fn acl_doc_role(&self, user_id: Uuid, doc_id: Uuid) -> AuthResult<Option<DocRole>> {
    self.store.get_doc_role(user_id, doc_id).await
  }
}

#[async_trait]
impl MentionStore for AuthStoreCommentAdapter {
  async fn mention_user_by_email(&self, email: &str) -> AuthResult<Option<Uuid>> {
    Ok(self.store.get_user_by_email(email).await?.map(|u| u.id))
  }

  async fn mention_user_by_id(&self, user_id: Uuid) -> AuthResult<Option<Uuid>> {
    Ok(self.store.get_user_by_id(user_id).await?.map(|user| user.id))
  }
}

#[async_trait]
impl<T> MentionStore for T
where
  T: AuthStore + Send + Sync + ?Sized,
{
  async fn mention_user_by_email(&self, email: &str) -> AuthResult<Option<Uuid>> {
    Ok(self.get_user_by_email(email).await?.map(|u| u.id))
  }

  async fn mention_user_by_id(&self, user_id: Uuid) -> AuthResult<Option<Uuid>> {
    Ok(self.get_user_by_id(user_id).await?.map(|user| user.id))
  }
}

/// One recipient decision captured with a newly created comment. A mention
/// replaces a reply for the same recipient; the author never receives an intent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentNotificationIntent {
  pub user_id: Uuid,
  pub kind: CommentNotificationKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CommentNotificationKind {
  #[serde(rename = "comment_mention")]
  Mention,
  #[serde(rename = "comment_reply")]
  Reply,
}

impl CommentNotificationKind {
  pub fn as_storage(self) -> &'static str {
    match self {
      Self::Mention => "comment_mention",
      Self::Reply => "comment_reply",
    }
  }
}

impl CommentNotificationIntent {
  pub fn idempotency_key(&self, comment_id: Uuid) -> String {
    format!("comment:{comment_id}:{}", self.user_id)
  }

  /// Keep authoritative internal IDs in durable intent. Current readable titles
  /// and external document keys are projected when the Inbox is requested.
  pub fn payload(&self, comment: &Comment) -> Value {
    serde_json::json!({
      "userId": self.user_id,
      "workspaceId": comment.workspace_id,
      "docId": comment.doc_id,
      "commentId": comment.id,
      "authorId": comment.author_id,
      "notificationType": self.kind.as_storage(),
      "idempotencyKey": self.idempotency_key(comment.id),
    })
  }
}

/// The comment and its durable recipient intents form one commit boundary.
pub struct NewComment {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub parent_comment_id: Option<Uuid>,
  pub author_id: Uuid,
  pub body: Value,
  pub now: DateTime<Utc>,
  pub notification_intents: Vec<CommentNotificationIntent>,
}

/// Persistence port for comments and related state.
#[async_trait]
pub trait CommentStore: Send + Sync {
  /// Insert the comment and all recipient intents atomically. Failure must
  /// leave neither the comment nor an independently deliverable intent.
  async fn create_comment(&self, input: NewComment) -> AuthResult<Comment>;
  /// Fetch a comment by ID.
  async fn get_comment(&self, comment_id: Uuid) -> AuthResult<Option<Comment>>;
  /// Update the body of a comment and record an edit history entry.
  async fn update_comment_body(
    &self,
    comment_id: Uuid,
    body: Value,
    edited_by: Uuid,
    now: DateTime<Utc>,
  ) -> AuthResult<Comment>;
  /// Set the resolved state of a comment thread.
  async fn set_comment_resolved(
    &self,
    comment_id: Uuid,
    resolved: bool,
    acted_by: Uuid,
    now: DateTime<Utc>,
  ) -> AuthResult<Comment>;
  /// Soft-delete a comment (the record is retained for thread display).
  async fn soft_delete_comment(&self, comment_id: Uuid, deleted_by: Uuid, now: DateTime<Utc>) -> AuthResult<bool>;
  /// Insert or update the text-range anchor for a comment.
  async fn upsert_comment_anchor(
    &self,
    comment_id: Uuid,
    anchor: Value,
    edited_by: Uuid,
    now: DateTime<Utc>,
  ) -> AuthResult<()>;
  /// Retrieve the stored anchor JSON for a comment.
  async fn get_comment_anchor(&self, comment_id: Uuid) -> AuthResult<Option<Value>>;
  /// List comments in a document (or thread), paginated. Apply an optional
  /// thread filter before sorting/offset/limit; replies pass no filter.
  async fn list_comments(
    &self,
    doc_id: Uuid,
    parent_comment_id: Option<Uuid>,
    skip: i64,
    take: i64,
    thread_filter: Option<(CommentThreadFilter, Uuid)>,
  ) -> AuthResult<Vec<Comment>>;
  /// Return the edit history for a comment, paginated.
  async fn list_comment_edit_history(
    &self,
    comment_id: Uuid,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<CommentEditHistoryEntry>>;
  /// Record that `user_id` has read the given top-level comment thread.
  async fn mark_comment_thread_read(
    &self,
    user_id: Uuid,
    thread_comment_id: Uuid,
    read_at: DateTime<Utc>,
  ) -> AuthResult<()>;
  /// Upsert read state for every live top-level thread in this document in one
  /// operation, including already-read threads. Return the affected row count.
  async fn mark_all_comment_threads_read(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    read_at: DateTime<Utc>,
  ) -> AuthResult<i64>;
  /// Return the timestamp at which `user_id` last read this thread, or `None`
  /// if it has never been marked read.
  async fn get_comment_thread_read_at(
    &self,
    user_id: Uuid,
    thread_comment_id: Uuid,
  ) -> AuthResult<Option<DateTime<Utc>>>;
  /// Batch-fetch read-at timestamps for multiple threads at once.
  /// Returns a map from thread_comment_id to the read_at timestamp.
  /// Threads that have never been read are absent from the result.
  async fn get_comment_threads_read_at(
    &self,
    user_id: Uuid,
    thread_comment_ids: &[Uuid],
  ) -> AuthResult<HashMap<Uuid, DateTime<Utc>>>;
}

/// Transport-independent creation context. Bodies retain their stored JSON;
/// attachment keys and anchors use the existing Blob/Comment owners.
pub struct CommentCreationInput {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub parent_comment_id: Option<Uuid>,
  pub body: Value,
  pub attachment_keys: Vec<String>,
  pub selection_anchor: Option<SelectionAnchor>,
  pub doc_text: Option<String>,
}

/// Actual effects of composed creation; attachment/anchor work follows the
/// atomic comment/notification commit and can fail after durable creation.
pub struct CommentCreationResult {
  pub comment: Comment,
  pub attachment_keys: Vec<String>,
  pub selection_anchor: Option<ResolvedSelectionAnchor>,
}

/// High-level comment service.
///
/// Enforces ACL checks via [`CommentAclStore`] and resolves mentions via
/// [`MentionStore`]. Persistence owns the atomic comment/notification boundary;
/// optional mention resolution never changes reply delivery.
#[derive(Clone)]
pub struct CommentService {
  /// Persistence port for comments and anchors.
  store: Arc<dyn CommentStore>,
  /// ACL port for resolving workspace/doc roles.
  acl_store: Arc<dyn CommentAclStore>,
  /// Optional port for resolving `@email` tokens to user IDs.
  mention_store: Option<Arc<dyn MentionStore>>,
}

impl CommentService {
  pub fn new(store: Arc<dyn CommentStore>, acl_store: Arc<dyn CommentAclStore>) -> Self {
    Self {
      store,
      acl_store,
      mention_store: None,
    }
  }

  pub fn new_with_mentions(
    store: Arc<dyn CommentStore>,
    acl_store: Arc<dyn CommentAclStore>,
    mention_store: Arc<dyn MentionStore>,
  ) -> Self {
    Self {
      store,
      acl_store,
      mention_store: Some(mention_store),
    }
  }

  fn normalize_anchor(anchor: SelectionAnchor) -> AuthResult<SelectionAnchor> {
    let quote = anchor.quote.trim().to_string();
    if quote.is_empty() {
      return Err(AuthError::InvalidInput(
        "selection anchor quote must not be empty".to_string(),
      ));
    }
    if let (Some(start), Some(end)) = (anchor.start, anchor.end)
      && end < start
    {
      return Err(AuthError::InvalidInput(
        "selection anchor end must be >= start".to_string(),
      ));
    }
    Ok(SelectionAnchor { quote, ..anchor })
  }

  fn resolve_anchor_in_text(anchor: &SelectionAnchor, doc_text: &str) -> Option<ResolvedSelectionAnchor> {
    let quote = anchor.quote.as_str();
    let quote_len = quote.len();
    if quote_len == 0 {
      return None;
    }

    if let (Some(start), Some(end)) = (anchor.start, anchor.end)
      && end <= doc_text.len()
      && start <= end
      && let Some(slice) = doc_text.get(start..end)
      && slice == quote
    {
      return Some(ResolvedSelectionAnchor {
        quote: quote.to_string(),
        start,
        end,
        strategy: AnchorResolutionStrategy::DirectRange,
      });
    }

    if let Some(expected_start) = anchor.start {
      let window = 1024usize;
      let near_start = expected_start.saturating_sub(window);
      let near_end = (expected_start + window).min(doc_text.len());
      if let Some(near_slice) = doc_text.get(near_start..near_end)
        && let Some(local_idx) = near_slice.find(quote)
      {
        let start = near_start + local_idx;
        return Some(ResolvedSelectionAnchor {
          quote: quote.to_string(),
          start,
          end: start + quote_len,
          strategy: AnchorResolutionStrategy::NearbyQuoteSearch,
        });
      }
    }

    if let Some(idx) = doc_text.find(quote) {
      return Some(ResolvedSelectionAnchor {
        quote: quote.to_string(),
        start: idx,
        end: idx + quote_len,
        strategy: AnchorResolutionStrategy::GlobalQuoteSearch,
      });
    }

    if let (Some(prefix), Some(suffix)) = (anchor.prefix.as_deref(), anchor.suffix.as_deref()) {
      let pattern = format!("{prefix}{quote}{suffix}");
      if let Some(pattern_idx) = doc_text.find(&pattern) {
        let start = pattern_idx + prefix.len();
        return Some(ResolvedSelectionAnchor {
          quote: quote.to_string(),
          start,
          end: start + quote_len,
          strategy: AnchorResolutionStrategy::ContextBoundarySearch,
        });
      }
    }

    None
  }

  fn collect_mention_tokens(body: &Value, out: &mut Vec<String>) {
    match body {
      Value::Object(map) => {
        if let Some(Value::String(kind)) = map.get("type")
          && kind.eq_ignore_ascii_case("mention")
          && let Some(Value::String(email)) = map.get("email")
        {
          out.push(email.to_lowercase());
        }
        for value in map.values() {
          Self::collect_mention_tokens(value, out);
        }
      }
      Value::Array(arr) => {
        for value in arr {
          Self::collect_mention_tokens(value, out);
        }
      }
      Value::String(text) => {
        let bytes = text.as_bytes();
        let mut idx = 0usize;
        while idx < bytes.len() {
          if bytes[idx] == b'@' {
            let start = idx + 1;
            let mut end = start;
            while end < bytes.len() {
              let ch = bytes[end] as char;
              if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '+' | '@') {
                end += 1;
              } else {
                break;
              }
            }
            if end > start {
              let token = &text[start..end];
              if token.contains('@') {
                out.push(token.to_lowercase());
              }
            }
            idx = end;
            continue;
          }
          idx += 1;
        }
      }
      _ => {}
    }
  }

  fn collect_mention_members(body: &Value, out: &mut Vec<Uuid>) {
    match body {
      Value::Object(map) => {
        // This is the existing Virgultum text-delta mention attribute.
        if let Some(member) = map
          .get("attributes")
          .and_then(|attributes| attributes.get("mention"))
          .and_then(|mention| mention.get("member"))
          .and_then(Value::as_str)
          .and_then(|member| member.parse().ok())
        {
          out.push(member);
        }
        for value in map.values() {
          Self::collect_mention_members(value, out);
        }
      }
      Value::Array(values) => {
        for value in values {
          Self::collect_mention_members(value, out);
        }
      }
      _ => {}
    }
  }

  #[instrument(skip(self, body))]
  async fn resolve_mentions_from_body(&self, body: &Value) -> AuthResult<Vec<MentionResolution>> {
    let Some(mention_store) = &self.mention_store else {
      return Ok(Vec::new());
    };
    let mut tokens = Vec::new();
    Self::collect_mention_tokens(body, &mut tokens);
    tokens.sort();
    tokens.dedup();

    let mut members = Vec::new();
    Self::collect_mention_members(body, &mut members);
    members.sort();
    members.dedup();
    let mut resolved = Vec::with_capacity(tokens.len() + members.len());
    for token in tokens {
      let user_id = mention_store.mention_user_by_email(&token).await?;
      resolved.push(MentionResolution { token, user_id });
    }
    for member in members {
      let user_id = mention_store.mention_user_by_id(member).await?;
      resolved.push(MentionResolution {
        token: member.to_string(),
        user_id,
      });
    }
    Ok(resolved)
  }

  #[instrument(skip(self))]
  async fn effective_doc_role(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<myoxus_domain::entities::DocRole> {
    let workspace_role = self.acl_store.acl_workspace_role(user_id, workspace_id).await?;
    let doc_role = self.acl_store.acl_doc_role(user_id, doc_id).await?;
    Ok(fixup_doc_role(workspace_role, doc_role))
  }

  #[instrument(skip(self))]
  async fn assert_can_create_comment(&self, user_id: Uuid, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<()> {
    let role = self.effective_doc_role(user_id, workspace_id, doc_id).await?;
    if role.can(DocAction::CommentsCreate) {
      return Ok(());
    }
    warn!(%user_id, %workspace_id, %doc_id, ?role, "comment create forbidden by ACL");
    Err(AuthError::ActionForbidden)
  }

  #[instrument(skip(self))]
  async fn assert_can_manage_comment(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    author_id: Uuid,
    action: DocAction,
  ) -> AuthResult<()> {
    let role = self.effective_doc_role(user_id, workspace_id, doc_id).await?;
    if role.can(action) {
      return Ok(());
    }
    if user_id == author_id && role.can(DocAction::CommentsCreate) {
      debug!(
          %user_id,
          %workspace_id,
          %doc_id,
          author_id = %author_id,
          ?action,
          ?role,
          "allowing comment operation for original author via create permission fallback"
      );
      return Ok(());
    }
    warn!(
        %user_id,
        %workspace_id,
        %doc_id,
        author_id = %author_id,
        ?action,
        ?role,
        "comment operation forbidden by ACL"
    );
    Err(AuthError::ActionForbidden)
  }

  /// Create a new top-level comment or reply.
  ///
  /// Checks `CommentsCreate` permission and persists the comment and its
  /// resolved recipient union in one transaction.
  /// Delivery subsequently rechecks recipient access and uses current email preferences.
  #[instrument(skip(self, body))]
  pub async fn create_comment(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    parent_comment_id: Option<Uuid>,
    body: Value,
  ) -> AuthResult<Comment> {
    self.assert_can_create_comment(user_id, workspace_id, doc_id).await?;
    let notification_intents = self
      .notification_intents(user_id, workspace_id, doc_id, parent_comment_id, &body)
      .await?;
    let comment = self
      .store
      .create_comment(NewComment {
        workspace_id,
        doc_id,
        parent_comment_id,
        author_id: user_id,
        body,
        now: Utc::now(),
        notification_intents,
      })
      .await?;
    info!(comment_id = %comment.id, %workspace_id, %doc_id, author_id = %user_id, "comment created");
    Ok(comment)
  }

  /// Create with the existing GraphQL attachment and anchor composition.
  /// Available preconditions are checked before creation. Subsequent storage
  /// failures retain partial effects; this is not an atomic multi-owner write.
  #[instrument(skip_all)]
  pub async fn create_comment_with_context(
    &self,
    user_id: Uuid,
    input: CommentCreationInput,
    blob: &crate::ports::blob_service::BlobService,
  ) -> AuthResult<CommentCreationResult> {
    self.validate_comment_creation_context(user_id, &input, blob).await?;
    let comment = self
      .create_comment(
        user_id,
        input.workspace_id,
        input.doc_id,
        input.parent_comment_id,
        input.body,
      )
      .await?;
    let mut attachment_keys = Vec::new();
    for key in input.attachment_keys {
      if blob
        .attach_comment_attachment_to_comment(input.workspace_id, input.doc_id, comment.id, &key, user_id)
        .await?
      {
        attachment_keys.push(key);
      } else {
        // Preserve the shipped non-linking result for an already-bound or
        // other-author attachment in this document; never claim it was linked.
        warn!(comment_id=%comment.id, workspace_id=%input.workspace_id, doc_id=%input.doc_id, %user_id, "attachment key could not be linked to comment");
      }
    }
    let selection_anchor = if let Some(anchor) = input.selection_anchor {
      if let Some(text) = input.doc_text.as_deref() {
        Some(
          self
            .upsert_comment_selection_anchor(user_id, comment.id, anchor, text)
            .await?,
        )
      } else {
        warn!(comment_id=%comment.id,%user_id,"selection anchor provided without doc_text, skipping anchor persistence");
        None
      }
    } else {
      None
    };
    Ok(CommentCreationResult {
      comment,
      attachment_keys,
      selection_anchor,
    })
  }

  /// Check the currently available creation preconditions without writing.
  /// MCP calls this before admission; composed creation repeats it to preserve
  /// the same GraphQL owner and fail closed if a prerequisite changed.
  #[instrument(skip_all)]
  pub async fn validate_comment_creation_context(
    &self,
    user_id: Uuid,
    input: &CommentCreationInput,
    blob: &crate::ports::blob_service::BlobService,
  ) -> AuthResult<()> {
    self
      .assert_can_create_comment(user_id, input.workspace_id, input.doc_id)
      .await?;
    // Bind the parent before attachment or anchor validation.
    // The creation owner rechecks it at the atomic comment/outbox boundary.
    self
      .validate_comment_parent(input.workspace_id, input.doc_id, input.parent_comment_id)
      .await?;
    for key in &input.attachment_keys {
      if blob
        .comment_attachment_download(input.workspace_id, input.doc_id, key)
        .await?
        .is_none()
      {
        return Err(AuthError::InvalidInput("invalid document attachment reference".into()));
      }
    }
    if let (Some(anchor), Some(text)) = (&input.selection_anchor, &input.doc_text) {
      let normalized = Self::normalize_anchor(anchor.clone())?;
      Self::resolve_anchor_in_text(&normalized, text)
        .ok_or_else(|| AuthError::InvalidInput("unable to resolve selection anchor against current document".into()))?;
    }
    Ok(())
  }

  /// Bind an optional live creation parent to the already authorized document.
  /// This check grants no permission; transports/use cases must authorize first.
  /// Replies retain the existing ability to target a live nested comment.
  #[instrument(skip(self))]
  pub async fn validate_comment_parent(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    parent_comment_id: Option<Uuid>,
  ) -> AuthResult<Option<Comment>> {
    match parent_comment_id {
      None => Ok(None),
      Some(id) => self
        .store
        .get_comment(id)
        .await?
        .filter(|parent| parent.workspace_id == workspace_id && parent.doc_id == doc_id && parent.deleted_at.is_none())
        .map(Some)
        .ok_or_else(|| AuthError::InvalidInput("invalid parent comment reference".into())),
    }
  }

  /// Resolve the creation-time recipient union. The pending-event boundary also
  /// uses this policy for deployed comment events lacking a canonical recipient.
  #[instrument(skip(self, body))]
  pub async fn notification_intents(
    &self,
    author_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    parent_comment_id: Option<Uuid>,
    body: &Value,
  ) -> AuthResult<Vec<CommentNotificationIntent>> {
    let mut recipients = BTreeMap::new();
    if let Some(parent) = self
      .validate_comment_parent(workspace_id, doc_id, parent_comment_id)
      .await?
    {
      if parent.author_id != author_id {
        recipients.insert(parent.author_id, CommentNotificationKind::Reply);
      }
    }
    for mention in self.resolve_mentions_from_body(body).await? {
      if let Some(user_id) = mention.user_id
        && user_id != author_id
      {
        recipients.insert(user_id, CommentNotificationKind::Mention);
      }
    }
    Ok(
      recipients
        .into_iter()
        .map(|(user_id, kind)| CommentNotificationIntent { user_id, kind })
        .collect(),
    )
  }

  /// Check current lifecycle authority and bind the retained comment to the
  /// selected document before MCP admission/replay. This grants no write by
  /// itself; mutating owners recheck authority immediately before their Store call.
  #[instrument(skip(self))]
  pub async fn validate_comment_management(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    comment_id: Uuid,
    action: DocAction,
  ) -> AuthResult<()> {
    if !matches!(
      action,
      DocAction::CommentsUpdate | DocAction::CommentsDelete | DocAction::CommentsResolve
    ) {
      return Err(AuthError::InvalidInput("invalid comment management action".into()));
    }
    let existing = self
      .comment_in_document(comment_id, workspace_id, doc_id)
      .await?
      .ok_or_else(|| AuthError::InvalidInput("comment not found".into()))?;
    self
      .assert_can_manage_comment(user_id, workspace_id, doc_id, existing.author_id, action)
      .await
  }

  /// Update the body of an existing comment.
  ///
  /// Requires `CommentsUpdate` permission or ownership (`CommentsCreate`)
  /// on the comment's document.  The old body is preserved in edit history.
  #[instrument(skip(self, body))]
  pub async fn update_comment(&self, user_id: Uuid, comment_id: Uuid, body: Value) -> AuthResult<Comment> {
    let existing = self
      .store
      .get_comment(comment_id)
      .await?
      .ok_or_else(|| AuthError::InvalidInput("comment not found".to_string()))?;
    self
      .assert_can_manage_comment(
        user_id,
        existing.workspace_id,
        existing.doc_id,
        existing.author_id,
        DocAction::CommentsUpdate,
      )
      .await?;
    let updated = self
      .store
      .update_comment_body(comment_id, body, user_id, Utc::now())
      .await?;
    info!(comment_id = %updated.id, acted_by = %user_id, "comment updated");
    Ok(updated)
  }

  /// Set the resolved/unresolved state of a comment thread.
  ///
  /// Requires `CommentsResolve` permission or ownership on the comment's
  /// document.
  #[instrument(skip(self))]
  pub async fn set_comment_resolved(&self, user_id: Uuid, comment_id: Uuid, resolved: bool) -> AuthResult<Comment> {
    let existing = self
      .store
      .get_comment(comment_id)
      .await?
      .ok_or_else(|| AuthError::InvalidInput("comment not found".to_string()))?;
    self
      .assert_can_manage_comment(
        user_id,
        existing.workspace_id,
        existing.doc_id,
        existing.author_id,
        DocAction::CommentsResolve,
      )
      .await?;
    let updated = self
      .store
      .set_comment_resolved(comment_id, resolved, user_id, Utc::now())
      .await?;
    info!(comment_id = %updated.id, acted_by = %user_id, resolved, "comment resolve state changed");
    Ok(updated)
  }

  /// Soft-delete a comment.
  ///
  /// The record is retained (for thread display continuity) but its content
  /// is effectively hidden.  Requires `CommentsDelete` permission or
  /// ownership on the comment's document.
  #[instrument(skip(self))]
  pub async fn delete_comment(&self, user_id: Uuid, comment_id: Uuid) -> AuthResult<bool> {
    let existing = self
      .store
      .get_comment(comment_id)
      .await?
      .ok_or_else(|| AuthError::InvalidInput("comment not found".to_string()))?;
    self
      .assert_can_manage_comment(
        user_id,
        existing.workspace_id,
        existing.doc_id,
        existing.author_id,
        DocAction::CommentsDelete,
      )
      .await?;
    let deleted = self.store.soft_delete_comment(comment_id, user_id, Utc::now()).await?;
    info!(comment_id = %comment_id, acted_by = %user_id, deleted, "comment delete handled");
    Ok(deleted)
  }

  /// Fetch a single comment by ID (no ACL check — callers apply one if
  /// needed).
  #[instrument(skip(self))]
  pub async fn get_comment(&self, comment_id: Uuid) -> AuthResult<Option<Comment>> {
    self.store.get_comment(comment_id).await
  }

  /// Resolve a [`SelectionAnchor`] against the current document text and
  /// persist it.
  ///
  /// The anchor is normalised, resolved using a cascade of strategies
  /// (direct range → nearby quote → global quote → context boundary), and
  /// stored as JSON.  Returns the resolved position.  Requires
  /// `CommentsUpdate` permission or ownership.
  #[instrument(skip(self, anchor, doc_text))]
  pub async fn upsert_comment_selection_anchor(
    &self,
    user_id: Uuid,
    comment_id: Uuid,
    anchor: SelectionAnchor,
    doc_text: &str,
  ) -> AuthResult<ResolvedSelectionAnchor> {
    let existing = self
      .store
      .get_comment(comment_id)
      .await?
      .ok_or_else(|| AuthError::InvalidInput("comment not found".to_string()))?;
    self
      .assert_can_manage_comment(
        user_id,
        existing.workspace_id,
        existing.doc_id,
        existing.author_id,
        DocAction::CommentsUpdate,
      )
      .await?;

    let normalized = Self::normalize_anchor(anchor)?;
    let resolved = Self::resolve_anchor_in_text(&normalized, doc_text).ok_or_else(|| {
      AuthError::InvalidInput("unable to resolve selection anchor against current document".to_string())
    })?;
    let serialized = serde_json::to_value(&resolved)
      .map_err(|e| AuthError::Storage(format!("failed to serialize resolved selection anchor: {e}")))?;
    self
      .store
      .upsert_comment_anchor(comment_id, serialized, user_id, Utc::now())
      .await?;
    info!(
        comment_id = %comment_id,
        acted_by = %user_id,
        strategy = ?resolved.strategy,
        start = resolved.start,
        end = resolved.end,
        "comment selection anchor resolved and persisted"
    );
    Ok(resolved)
  }

  /// Return top-level comment threads for a document, optionally filtered.
  ///
  /// Checks `CommentsRead` permission, applies the [`CommentThreadFilter`],
  /// and attaches per-thread read state (last-read timestamp + unread flag).
  #[instrument(skip(self))]
  pub async fn list_comment_threads(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    skip: i64,
    take: i64,
    filter: CommentThreadFilter,
  ) -> AuthResult<Vec<CommentThreadView>> {
    let role = self.effective_doc_role(user_id, workspace_id, doc_id).await?;
    if !role.can(DocAction::CommentsRead) {
      warn!(%user_id, %workspace_id, %doc_id, ?role, "thread list forbidden by ACL");
      return Err(AuthError::ActionForbidden);
    }
    let threads = self
      .store
      .list_comments(doc_id, None, skip.max(0), take.clamp(1, 200), Some((filter, user_id)))
      .await?;
    // Persistence paginates the filtered result set. Read state must not
    // change its membership or offsets after that page has been selected.
    let included_threads = threads;
    // Batch-fetch read state for all included threads in ONE query.
    let thread_ids: Vec<Uuid> = included_threads.iter().map(|t| t.id).collect();
    let read_at_map = self.store.get_comment_threads_read_at(user_id, &thread_ids).await?;
    let mut out = Vec::new();
    for thread in included_threads {
      let read_at = read_at_map.get(&thread.id).copied();
      let unread = read_at.map(|at| at < thread.updated_at).unwrap_or(true);
      out.push(CommentThreadView {
        comment: thread,
        read_at,
        unread,
      });
    }
    Ok(out)
  }

  /// Return replies to a top-level comment thread, paginated.
  ///
  /// Requires `CommentsRead` permission on the document.
  #[instrument(skip(self))]
  pub async fn list_comment_replies(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    parent_comment_id: Uuid,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<Comment>> {
    let role = self.effective_doc_role(user_id, workspace_id, doc_id).await?;
    if !role.can(DocAction::CommentsRead) {
      warn!(%user_id, %workspace_id, %doc_id, parent_comment_id = %parent_comment_id, ?role, "reply list forbidden by ACL");
      return Err(AuthError::ActionForbidden);
    }
    if self
      .comment_in_document(parent_comment_id, workspace_id, doc_id)
      .await?
      .is_none()
    {
      return Ok(Vec::new());
    }
    self
      .store
      .list_comments(doc_id, Some(parent_comment_id), skip.max(0), take.clamp(1, 200), None)
      .await
  }

  /// Return the edit history for a comment, paginated.
  ///
  /// Requires `CommentsRead` permission on the document.
  #[instrument(skip(self))]
  pub async fn list_comment_edit_history(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    comment_id: Uuid,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<CommentEditHistoryEntry>> {
    let role = self.effective_doc_role(user_id, workspace_id, doc_id).await?;
    if !role.can(DocAction::CommentsRead) {
      warn!(%user_id, %workspace_id, %doc_id, comment_id = %comment_id, ?role, "comment edit history forbidden by ACL");
      return Err(AuthError::ActionForbidden);
    }
    if self
      .comment_in_document(comment_id, workspace_id, doc_id)
      .await?
      .is_none()
    {
      return Ok(Vec::new());
    }
    self
      .store
      .list_comment_edit_history(comment_id, skip.max(0), take.clamp(1, 200))
      .await
  }

  /// Bind ID-based reads to the already authorized document. Retained deleted
  /// records remain usable for historical reads; missing IDs keep empty results.
  async fn comment_in_document(
    &self,
    comment_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Option<Comment>> {
    let comment = self.store.get_comment(comment_id).await?;
    if comment
      .as_ref()
      .is_some_and(|comment| comment.workspace_id != workspace_id || comment.doc_id != doc_id)
    {
      return Err(AuthError::ActionForbidden);
    }
    Ok(comment)
  }

  /// Check read authority and require a live top-level thread of this document.
  /// The check precedes both the Store write and MCP admission/replay.
  #[instrument(skip(self))]
  pub async fn validate_comment_thread_read(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    thread_comment_id: Uuid,
  ) -> AuthResult<()> {
    let role = self.effective_doc_role(user_id, workspace_id, doc_id).await?;
    if !role.can(DocAction::CommentsRead) {
      return Err(AuthError::ActionForbidden);
    }
    let thread = self
      .comment_in_document(thread_comment_id, workspace_id, doc_id)
      .await?
      .ok_or_else(|| AuthError::InvalidInput("comment thread not found".into()))?;
    if thread.deleted_at.is_some() || thread.parent_comment_id.is_some() {
      return Err(AuthError::InvalidInput(
        "a live top-level comment thread is required".into(),
      ));
    }
    Ok(())
  }

  /// Mark a live top-level thread of the authorized document read by this user.
  #[instrument(skip(self))]
  pub async fn mark_comment_thread_read(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    thread_comment_id: Uuid,
  ) -> AuthResult<bool> {
    self
      .validate_comment_thread_read(user_id, workspace_id, doc_id, thread_comment_id)
      .await?;
    self
      .store
      .mark_comment_thread_read(user_id, thread_comment_id, Utc::now())
      .await?;
    Ok(true)
  }

  /// Mark every live top-level thread read, without the lister's page limit.
  /// Returns the count actually upserted for this user/document, including
  /// already-read threads. Other documents and users remain untouched.
  #[instrument(skip(self))]
  pub async fn mark_all_comment_threads_read(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<i64> {
    let role = self.effective_doc_role(user_id, workspace_id, doc_id).await?;
    if !role.can(DocAction::CommentsRead) {
      return Err(AuthError::ActionForbidden);
    }
    self
      .store
      .mark_all_comment_threads_read(user_id, workspace_id, doc_id, Utc::now())
      .await
  }
}

/// In-memory [`CommentStore`] backed by `std::sync::Mutex`-guarded hash maps.
///
/// Intended for unit tests only — not safe for concurrent production use.
#[derive(Default)]
pub struct InMemoryCommentStore {
  /// All comments keyed by their ID.
  comments: Mutex<HashMap<Uuid, Comment>>,
  notification_intents: Mutex<HashMap<Uuid, Vec<CommentNotificationIntent>>>,
  /// Stored anchor JSON keyed by comment ID.
  anchors: Mutex<HashMap<Uuid, Value>>,
  /// Sequential edit history entries across all comments.
  edit_history: Mutex<Vec<CommentEditHistoryEntry>>,
  /// Per-`(user_id, thread_comment_id)` read timestamp.
  thread_read_state: Mutex<HashMap<(Uuid, Uuid), DateTime<Utc>>>,
}

#[async_trait]
impl CommentStore for InMemoryCommentStore {
  async fn create_comment(&self, input: NewComment) -> AuthResult<Comment> {
    let NewComment {
      workspace_id,
      doc_id,
      parent_comment_id,
      author_id,
      body,
      now,
      notification_intents,
    } = input;
    let comment = Comment {
      id: Uuid::new_v4(),
      workspace_id,
      doc_id,
      parent_comment_id,
      author_id,
      body,
      resolved: false,
      created_at: now,
      updated_at: now,
      deleted_at: None,
    };
    let mut comments = self
      .comments
      .lock()
      .map_err(|e| AuthError::Storage(format!("comment lock poisoned: {e}")))?;
    let mut intents = self
      .notification_intents
      .lock()
      .map_err(|e| AuthError::Storage(format!("comment intent lock poisoned: {e}")))?;
    if let Some(parent_id) = parent_comment_id
      && !comments.get(&parent_id).is_some_and(|parent| {
        parent.workspace_id == workspace_id && parent.doc_id == doc_id && parent.deleted_at.is_none()
      })
    {
      return Err(AuthError::InvalidInput("invalid parent comment reference".into()));
    }
    comments.insert(comment.id, comment.clone());
    intents.insert(comment.id, notification_intents);
    Ok(comment)
  }

  async fn get_comment(&self, comment_id: Uuid) -> AuthResult<Option<Comment>> {
    Ok(
      self
        .comments
        .lock()
        .map_err(|e| AuthError::Storage(format!("comment lock poisoned: {e}")))?
        .get(&comment_id)
        .cloned(),
    )
  }

  async fn update_comment_body(
    &self,
    comment_id: Uuid,
    body: Value,
    edited_by: Uuid,
    now: DateTime<Utc>,
  ) -> AuthResult<Comment> {
    let mut comments = self
      .comments
      .lock()
      .map_err(|e| AuthError::Storage(format!("comment lock poisoned: {e}")))?;
    let comment = comments
      .get_mut(&comment_id)
      .ok_or_else(|| AuthError::InvalidInput("comment not found".to_string()))?;
    let previous_body = comment.body.clone();
    let mut history = self
      .edit_history
      .lock()
      .map_err(|e| AuthError::Storage(format!("edit history lock poisoned: {e}")))?;
    let next_id = (history.len() + 1) as i64;
    history.push(CommentEditHistoryEntry {
      id: next_id,
      comment_id,
      body: previous_body,
      edited_by,
      edited_at: now,
    });
    comment.body = body;
    comment.updated_at = now;
    Ok(comment.clone())
  }

  async fn set_comment_resolved(
    &self,
    comment_id: Uuid,
    resolved: bool,
    _acted_by: Uuid,
    now: DateTime<Utc>,
  ) -> AuthResult<Comment> {
    let mut comments = self
      .comments
      .lock()
      .map_err(|e| AuthError::Storage(format!("comment lock poisoned: {e}")))?;
    let comment = comments
      .get_mut(&comment_id)
      .ok_or_else(|| AuthError::InvalidInput("comment not found".to_string()))?;
    comment.resolved = resolved;
    comment.updated_at = now;
    Ok(comment.clone())
  }

  async fn soft_delete_comment(&self, comment_id: Uuid, _deleted_by: Uuid, now: DateTime<Utc>) -> AuthResult<bool> {
    let mut comments = self
      .comments
      .lock()
      .map_err(|e| AuthError::Storage(format!("comment lock poisoned: {e}")))?;
    let Some(comment) = comments.get_mut(&comment_id) else {
      return Ok(false);
    };
    if comment.deleted_at.is_none() {
      comment.deleted_at = Some(now);
    }
    Ok(true)
  }

  async fn upsert_comment_anchor(
    &self,
    comment_id: Uuid,
    anchor: Value,
    _edited_by: Uuid,
    _now: DateTime<Utc>,
  ) -> AuthResult<()> {
    self
      .anchors
      .lock()
      .map_err(|e| AuthError::Storage(format!("anchor lock poisoned: {e}")))?
      .insert(comment_id, anchor);
    Ok(())
  }

  async fn get_comment_anchor(&self, comment_id: Uuid) -> AuthResult<Option<Value>> {
    Ok(
      self
        .anchors
        .lock()
        .map_err(|e| AuthError::Storage(format!("anchor lock poisoned: {e}")))?
        .get(&comment_id)
        .cloned(),
    )
  }

  async fn list_comments(
    &self,
    doc_id: Uuid,
    parent_comment_id: Option<Uuid>,
    skip: i64,
    take: i64,
    thread_filter: Option<(CommentThreadFilter, Uuid)>,
  ) -> AuthResult<Vec<Comment>> {
    let mut out = self
      .comments
      .lock()
      .map_err(|e| AuthError::Storage(format!("comment lock poisoned: {e}")))?
      .values()
      .filter(|comment| {
        comment.doc_id == doc_id
          && comment.parent_comment_id == parent_comment_id
          && comment.deleted_at.is_none()
          && thread_filter.is_none_or(|(filter, actor)| match filter {
            CommentThreadFilter::All => true,
            CommentThreadFilter::Open => !comment.resolved,
            CommentThreadFilter::Resolved => comment.resolved,
            CommentThreadFilter::Mine => comment.author_id == actor,
          })
      })
      .cloned()
      .collect::<Vec<_>>();
    out.sort_by_key(|comment| (comment.created_at, comment.id));
    Ok(
      out
        .into_iter()
        .skip(skip.max(0) as usize)
        .take(take.clamp(1, 200) as usize)
        .collect(),
    )
  }

  async fn list_comment_edit_history(
    &self,
    comment_id: Uuid,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<CommentEditHistoryEntry>> {
    let mut out = self
      .edit_history
      .lock()
      .map_err(|e| AuthError::Storage(format!("edit history lock poisoned: {e}")))?
      .iter()
      .filter(|entry| entry.comment_id == comment_id)
      .cloned()
      .collect::<Vec<_>>();
    out.sort_by_key(|entry| entry.edited_at);
    Ok(
      out
        .into_iter()
        .skip(skip.max(0) as usize)
        .take(take.clamp(1, 200) as usize)
        .collect(),
    )
  }

  async fn mark_comment_thread_read(
    &self,
    user_id: Uuid,
    thread_comment_id: Uuid,
    read_at: DateTime<Utc>,
  ) -> AuthResult<()> {
    self
      .thread_read_state
      .lock()
      .map_err(|e| AuthError::Storage(format!("thread read lock poisoned: {e}")))?
      .insert((user_id, thread_comment_id), read_at);
    Ok(())
  }

  async fn mark_all_comment_threads_read(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    read_at: DateTime<Utc>,
  ) -> AuthResult<i64> {
    let comments = self
      .comments
      .lock()
      .map_err(|e| AuthError::Storage(format!("comments lock poisoned: {e}")))?;
    let mut state = self
      .thread_read_state
      .lock()
      .map_err(|e| AuthError::Storage(format!("thread read lock poisoned: {e}")))?;
    let mut count = 0;
    for comment in comments.values().filter(|c| {
      c.workspace_id == workspace_id && c.doc_id == doc_id && c.parent_comment_id.is_none() && c.deleted_at.is_none()
    }) {
      state.insert((user_id, comment.id), read_at);
      count += 1;
    }
    Ok(count)
  }

  async fn get_comment_thread_read_at(
    &self,
    user_id: Uuid,
    thread_comment_id: Uuid,
  ) -> AuthResult<Option<DateTime<Utc>>> {
    Ok(
      self
        .thread_read_state
        .lock()
        .map_err(|e| AuthError::Storage(format!("thread read lock poisoned: {e}")))?
        .get(&(user_id, thread_comment_id))
        .copied(),
    )
  }

  async fn get_comment_threads_read_at(
    &self,
    user_id: Uuid,
    thread_comment_ids: &[Uuid],
  ) -> AuthResult<HashMap<Uuid, DateTime<Utc>>> {
    let state = self
      .thread_read_state
      .lock()
      .map_err(|e| AuthError::Storage(format!("thread read lock poisoned: {e}")))?;
    let mut result = HashMap::with_capacity(thread_comment_ids.len());
    for tid in thread_comment_ids {
      if let Some(&read_at) = state.get(&(user_id, *tid)) {
        result.insert(*tid, read_at);
      }
    }
    Ok(result)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;
  use tokio::sync::Mutex;

  struct MockAclStore {
    ws_role: Option<WorkspaceRole>,
    doc_role: Option<DocRole>,
  }

  #[async_trait]
  impl CommentAclStore for MockAclStore {
    async fn acl_workspace_role(&self, _user_id: Uuid, _workspace_id: Uuid) -> AuthResult<Option<WorkspaceRole>> {
      Ok(self.ws_role)
    }

    async fn acl_doc_role(&self, _user_id: Uuid, _doc_id: Uuid) -> AuthResult<Option<DocRole>> {
      Ok(self.doc_role)
    }
  }

  struct MockMentionStore {
    by_email: HashMap<String, Uuid>,
  }

  #[async_trait]
  impl MentionStore for MockMentionStore {
    async fn mention_user_by_email(&self, email: &str) -> AuthResult<Option<Uuid>> {
      Ok(self.by_email.get(&email.to_lowercase()).copied())
    }
    async fn mention_user_by_id(&self, user_id: Uuid) -> AuthResult<Option<Uuid>> {
      Ok(self.by_email.values().find(|id| **id == user_id).copied())
    }
  }

  #[derive(Default)]
  struct MockCommentStore {
    comments: Mutex<HashMap<Uuid, Comment>>,
    notification_intents: Mutex<HashMap<Uuid, Vec<CommentNotificationIntent>>>,
    anchors: Mutex<HashMap<Uuid, Value>>,
    edit_history: Mutex<Vec<CommentEditHistoryEntry>>,
    thread_read_state: Mutex<HashMap<(Uuid, Uuid), DateTime<Utc>>>,
  }

  #[async_trait]
  impl CommentStore for MockCommentStore {
    async fn create_comment(&self, input: NewComment) -> AuthResult<Comment> {
      let NewComment {
        workspace_id,
        doc_id,
        parent_comment_id,
        author_id,
        body,
        now,
        notification_intents,
      } = input;
      let comment = Comment {
        id: Uuid::new_v4(),
        workspace_id,
        doc_id,
        parent_comment_id,
        author_id,
        body,
        resolved: false,
        created_at: now,
        updated_at: now,
        deleted_at: None,
      };
      let mut comments = self.comments.lock().await;
      let mut intents = self.notification_intents.lock().await;
      comments.insert(comment.id, comment.clone());
      intents.insert(comment.id, notification_intents);
      Ok(comment)
    }

    async fn get_comment(&self, comment_id: Uuid) -> AuthResult<Option<Comment>> {
      Ok(self.comments.lock().await.get(&comment_id).cloned())
    }

    async fn update_comment_body(
      &self,
      comment_id: Uuid,
      body: Value,
      edited_by: Uuid,
      now: DateTime<Utc>,
    ) -> AuthResult<Comment> {
      let mut guard = self.comments.lock().await;
      let previous_body = guard
        .get_mut(&comment_id)
        .ok_or_else(|| AuthError::InvalidInput("comment not found".to_string()))?
        .body
        .clone();
      drop(guard);

      let mut history = self.edit_history.lock().await;
      let next_id = (history.len() + 1) as i64;
      history.push(CommentEditHistoryEntry {
        id: next_id,
        comment_id,
        body: previous_body,
        edited_by,
        edited_at: now,
      });
      drop(history);

      let mut guard = self.comments.lock().await;
      let comment = guard
        .get_mut(&comment_id)
        .ok_or_else(|| AuthError::InvalidInput("comment not found".to_string()))?;
      comment.body = body;
      comment.updated_at = now;
      Ok(comment.clone())
    }

    async fn set_comment_resolved(
      &self,
      comment_id: Uuid,
      resolved: bool,
      _acted_by: Uuid,
      now: DateTime<Utc>,
    ) -> AuthResult<Comment> {
      let mut guard = self.comments.lock().await;
      let comment = guard
        .get_mut(&comment_id)
        .ok_or_else(|| AuthError::InvalidInput("comment not found".to_string()))?;
      comment.resolved = resolved;
      comment.updated_at = now;
      Ok(comment.clone())
    }

    async fn soft_delete_comment(&self, comment_id: Uuid, _deleted_by: Uuid, now: DateTime<Utc>) -> AuthResult<bool> {
      let mut guard = self.comments.lock().await;
      let Some(comment) = guard.get_mut(&comment_id) else {
        return Ok(false);
      };
      if comment.deleted_at.is_none() {
        comment.deleted_at = Some(now);
      }
      Ok(true)
    }

    async fn upsert_comment_anchor(
      &self,
      comment_id: Uuid,
      anchor: Value,
      _edited_by: Uuid,
      _now: DateTime<Utc>,
    ) -> AuthResult<()> {
      self.anchors.lock().await.insert(comment_id, anchor);
      Ok(())
    }

    async fn get_comment_anchor(&self, comment_id: Uuid) -> AuthResult<Option<Value>> {
      Ok(self.anchors.lock().await.get(&comment_id).cloned())
    }

    async fn list_comments(
      &self,
      doc_id: Uuid,
      parent_comment_id: Option<Uuid>,
      skip: i64,
      take: i64,
      thread_filter: Option<(CommentThreadFilter, Uuid)>,
    ) -> AuthResult<Vec<Comment>> {
      let mut out = self
        .comments
        .lock()
        .await
        .values()
        .filter(|comment| {
          comment.doc_id == doc_id
            && comment.parent_comment_id == parent_comment_id
            && comment.deleted_at.is_none()
            && thread_filter.is_none_or(|(filter, actor)| match filter {
              CommentThreadFilter::All => true,
              CommentThreadFilter::Open => !comment.resolved,
              CommentThreadFilter::Resolved => comment.resolved,
              CommentThreadFilter::Mine => comment.author_id == actor,
            })
        })
        .cloned()
        .collect::<Vec<_>>();
      out.sort_by_key(|comment| (comment.created_at, comment.id));
      Ok(
        out
          .into_iter()
          .skip(skip.max(0) as usize)
          .take(take.clamp(1, 200) as usize)
          .collect(),
      )
    }

    async fn list_comment_edit_history(
      &self,
      comment_id: Uuid,
      skip: i64,
      take: i64,
    ) -> AuthResult<Vec<CommentEditHistoryEntry>> {
      let mut out = self
        .edit_history
        .lock()
        .await
        .iter()
        .filter(|entry| entry.comment_id == comment_id)
        .cloned()
        .collect::<Vec<_>>();
      out.sort_by_key(|entry| entry.edited_at);
      Ok(
        out
          .into_iter()
          .skip(skip.max(0) as usize)
          .take(take.clamp(1, 200) as usize)
          .collect(),
      )
    }

    async fn mark_comment_thread_read(
      &self,
      user_id: Uuid,
      thread_comment_id: Uuid,
      read_at: DateTime<Utc>,
    ) -> AuthResult<()> {
      self
        .thread_read_state
        .lock()
        .await
        .insert((user_id, thread_comment_id), read_at);
      Ok(())
    }

    async fn mark_all_comment_threads_read(
      &self,
      user_id: Uuid,
      workspace_id: Uuid,
      doc_id: Uuid,
      read_at: DateTime<Utc>,
    ) -> AuthResult<i64> {
      let comments = self.comments.lock().await;
      let mut state = self.thread_read_state.lock().await;
      let mut count = 0;
      for comment in comments.values().filter(|c| {
        c.workspace_id == workspace_id && c.doc_id == doc_id && c.parent_comment_id.is_none() && c.deleted_at.is_none()
      }) {
        state.insert((user_id, comment.id), read_at);
        count += 1;
      }
      Ok(count)
    }

    async fn get_comment_thread_read_at(
      &self,
      user_id: Uuid,
      thread_comment_id: Uuid,
    ) -> AuthResult<Option<DateTime<Utc>>> {
      Ok(
        self
          .thread_read_state
          .lock()
          .await
          .get(&(user_id, thread_comment_id))
          .copied(),
      )
    }

    async fn get_comment_threads_read_at(
      &self,
      user_id: Uuid,
      thread_comment_ids: &[Uuid],
    ) -> AuthResult<HashMap<Uuid, DateTime<Utc>>> {
      let state = self.thread_read_state.lock().await;
      let mut result = HashMap::with_capacity(thread_comment_ids.len());
      for tid in thread_comment_ids {
        if let Some(&read_at) = state.get(&(user_id, *tid)) {
          result.insert(*tid, read_at);
        }
      }
      Ok(result)
    }
  }

  #[tokio::test]
  async fn comment_service_enforces_create_acl() {
    let store = Arc::new(MockCommentStore::default());
    let denied_acl = Arc::new(MockAclStore {
      ws_role: Some(WorkspaceRole::External),
      doc_role: Some(DocRole::Reader),
    });
    let service = CommentService::new(store, denied_acl);

    let result = service
      .create_comment(
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        None,
        serde_json::json!({"text":"forbidden"}),
      )
      .await;
    assert!(matches!(result, Err(AuthError::ActionForbidden)));
  }

  #[tokio::test]
  async fn comment_service_allows_author_update_with_create_fallback() {
    let store = Arc::new(MockCommentStore::default());
    let user_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let acl = Arc::new(MockAclStore {
      ws_role: Some(WorkspaceRole::External),
      doc_role: Some(DocRole::Commenter),
    });
    let service = CommentService::new(store.clone(), acl);

    let created = service
      .create_comment(
        user_id,
        workspace_id,
        doc_id,
        None,
        serde_json::json!({"text":"initial"}),
      )
      .await
      .expect("comment create should succeed");

    let updated = service
      .update_comment(user_id, created.id, serde_json::json!({"text":"edited"}))
      .await
      .expect("author should be allowed to update with fallback");
    assert_eq!(updated.body["text"], "edited");
  }

  #[tokio::test]
  async fn comment_service_resolves_selection_anchor_with_drift_fallback() {
    let store = Arc::new(MockCommentStore::default());
    let user_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let acl = Arc::new(MockAclStore {
      ws_role: Some(WorkspaceRole::Collaborator),
      doc_role: Some(DocRole::Editor),
    });
    let service = CommentService::new(store.clone(), acl);

    let created = service
      .create_comment(
        user_id,
        workspace_id,
        doc_id,
        None,
        serde_json::json!({"text":"anchor"}),
      )
      .await
      .expect("comment create should succeed");

    let doc_text = "prefix text and the selected quote appears here and suffix";
    let anchor = SelectionAnchor {
      quote: "selected quote".to_string(),
      start: Some(2),
      end: Some(16),
      prefix: Some("the ".to_string()),
      suffix: Some(" appears".to_string()),
    };
    let resolved = service
      .upsert_comment_selection_anchor(user_id, created.id, anchor, doc_text)
      .await
      .expect("anchor should resolve with fallback");
    assert_eq!(resolved.quote, "selected quote");
    assert_eq!(resolved.strategy, AnchorResolutionStrategy::NearbyQuoteSearch);

    let persisted = store
      .get_comment_anchor(created.id)
      .await
      .expect("anchor read should succeed")
      .expect("anchor must exist");
    assert_eq!(persisted["quote"], "selected quote");
    assert_eq!(persisted["start"], resolved.start);
    assert_eq!(persisted["end"], resolved.end);
  }

  #[tokio::test]
  async fn comment_service_parses_mentions_without_blocking_on_unresolved_tokens() {
    let store = Arc::new(MockCommentStore::default());
    let user_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let mentioned_user = Uuid::new_v4();

    let acl = Arc::new(MockAclStore {
      ws_role: Some(WorkspaceRole::Collaborator),
      doc_role: Some(DocRole::Editor),
    });
    let mention_store = Arc::new(MockMentionStore {
      by_email: HashMap::from([("known.user@example.com".to_string(), mentioned_user)]),
    });
    let service = CommentService::new_with_mentions(store, acl, mention_store);

    let comment = service
      .create_comment(
        user_id,
        workspace_id,
        doc_id,
        None,
        serde_json::json!({
            "text": "Hi @known.user@example.com and @unknown.user@example.com",
            "nodes": [
                {"type":"mention","email":"known.user@example.com"}
            ]
        }),
      )
      .await
      .expect("comment creation should not fail due to unresolved mentions");
    assert_eq!(comment.author_id, user_id);
  }

  #[tokio::test]
  async fn comment_service_lists_threads_replies_and_edit_history() {
    let store = Arc::new(MockCommentStore::default());
    let user_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let acl = Arc::new(MockAclStore {
      ws_role: Some(WorkspaceRole::Collaborator),
      doc_role: Some(DocRole::Editor),
    });
    let service = CommentService::new(store, acl);

    let root = service
      .create_comment(user_id, workspace_id, doc_id, None, serde_json::json!({"text":"root"}))
      .await
      .expect("root create");
    let _reply = service
      .create_comment(
        user_id,
        workspace_id,
        doc_id,
        Some(root.id),
        serde_json::json!({"text":"reply"}),
      )
      .await
      .expect("reply create");
    let _updated = service
      .update_comment(user_id, root.id, serde_json::json!({"text":"root edited"}))
      .await
      .expect("root update");

    let threads = service
      .list_comment_threads(user_id, workspace_id, doc_id, 0, 50, CommentThreadFilter::All)
      .await
      .expect("thread list");
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].comment.id, root.id);

    let replies = service
      .list_comment_replies(user_id, workspace_id, doc_id, root.id, 0, 50)
      .await
      .expect("reply list");
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].parent_comment_id, Some(root.id));

    let edits = service
      .list_comment_edit_history(user_id, workspace_id, doc_id, root.id, 0, 50)
      .await
      .expect("edit history");
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0].comment_id, root.id);
  }
}
