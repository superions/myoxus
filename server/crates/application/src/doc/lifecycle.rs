// SPDX-License-Identifier: AGPL-3.0-or-later
//! Atomic lifecycle for normal workspace pages.
//!
//! This service is the only application write boundary that coordinates page
//! metadata, the leaf document and workspace-root `meta.pages`. The repository
//! locks workspace root and leaf by ascending UUID in one PostgreSQL
//! transaction and commits all durable writes there. A returned commit therefore
//! contains the exact deltas and sequences that are safe to broadcast; an
//! error means no lifecycle write committed and requires no compensation.

use std::{sync::Arc, time::Instant};

use chrono::Utc;
use tracing::{info, instrument};
use uuid::Uuid;

use crate::{
  auth::{AuthError, AuthResult},
  metrics::{MetricsCategory, MetricsService},
};

use super::{
  DocCachePort, DocStore, PageLifecycleCommand, PageLifecycleCommit,
  content_mutation::{DocumentFragment, DocumentMutation},
};

/// Exact persisted CRDT deltas produced while creating a workspace page.
///
/// Server-authored creation paths publish the leaf before the root projection.
/// Existing clients can therefore load the document as soon as `meta.pages`
/// makes its identity discoverable.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatedPageSyncUpdates {
  pub document: Vec<u8>,
  pub document_sequence: i64,
  pub workspace_root: Vec<u8>,
  pub workspace_root_sequence: i64,
}

#[derive(Clone)]
pub struct PageLifecycleService {
  store: Arc<dyn DocStore>,
  cache: Option<Arc<dyn DocCachePort>>,
  metrics: Option<Arc<MetricsService>>,
}

impl PageLifecycleService {
  pub fn new(store: Arc<dyn DocStore>) -> Self {
    Self {
      store,
      cache: None,
      metrics: None,
    }
  }

  pub fn with_doc_cache(mut self, cache: Arc<dyn DocCachePort>) -> Self {
    self.cache = Some(cache);
    self
  }

  pub fn with_metrics_service(mut self, metrics: Arc<MetricsService>) -> Self {
    self.metrics = Some(metrics);
    self
  }

  /// Create one discoverable page in a single commit.
  ///
  /// Optional initial content is appended through the same typed direct-Yjs
  /// mutation helper used by ordinary semantic document writes. No Markdown or
  /// HTML import is involved.
  #[instrument(skip(self, title, initial_content), fields(%workspace_id, %actor_user_id, operation = "create"))]
  pub async fn create(
    &self,
    workspace_id: Uuid,
    actor_user_id: Uuid,
    title: Option<String>,
    initial_content: Option<DocumentFragment>,
  ) -> AuthResult<PageLifecycleCommit> {
    let title = normalize_title(title.as_deref().unwrap_or("Untitled"))?;
    let doc_id = Uuid::new_v4();
    let base = crate::markdown::empty_page_to_yjs(&title);
    let initial_leaf_update = if let Some(fragment) = initial_content {
      let appended = yjs::apply_document_mutation(&base, &DocumentMutation::AppendBlocks { fragment })
        .map_err(map_initial_content_error)?;
      yjs::merge_updates(vec![base, appended.delta])
        .map_err(|_| AuthError::Storage("initial page Yjs state is invalid".to_string()))?
    } else {
      base
    };
    self
      .commit(PageLifecycleCommand::Create {
        workspace_id,
        doc_id,
        actor_user_id,
        title,
        initial_leaf_update,
        source_purpose: None,
        committed_at: Utc::now(),
      })
      .await
  }

  #[tracing::instrument(skip_all)]
  pub(crate) async fn create_automation(
    &self,
    workspace_id: Uuid,
    actor_user_id: Uuid,
    doc_id: Uuid,
    title: String,
    content: Option<super::AutomationPageContent>,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> AuthResult<super::AutomationPageLifecycleResult> {
    let title = normalize_title(&title)?;
    let (initial_leaf_update, committed_at, row_content) = match content {
      Some(content) => (content.initial_leaf_update, content.committed_at, Some(content.target)),
      None => (crate::markdown::empty_page_to_yjs(&title), Utc::now(), None),
    };
    let result = self
      .store
      .commit_automation_page_lifecycle(
        PageLifecycleCommand::Create {
          workspace_id,
          doc_id,
          actor_user_id,
          title,
          initial_leaf_update,
          source_purpose: None,
          committed_at,
        },
        row_content,
        fence,
      )
      .await?;
    if let super::AutomationPageLifecycleResult::Committed(commit) = &result {
      self.invalidate(commit).await
    }
    Ok(result)
  }

  /// Create a discoverable page from one complete, server-owned Yjs snapshot.
  ///
  /// This is the cloning boundary for trusted template content. Applying a
  /// complete source page as an update to an already-created page would leave
  /// two independent page/note roots and make one body unreachable to the
  /// editor. The snapshot therefore becomes the initial leaf state itself,
  /// while the requested title is projected into that state before the atomic
  /// leaf/root lifecycle commit.
  #[instrument(skip(self, source_snapshot, title), fields(%workspace_id, %actor_user_id, operation = "create_from_snapshot"))]
  pub async fn create_from_snapshot(
    &self,
    workspace_id: Uuid,
    actor_user_id: Uuid,
    title: Option<String>,
    source_snapshot: Vec<u8>,
    source_purpose: Option<crate::template_registry::bundle::TemplatePurpose>,
  ) -> AuthResult<PageLifecycleCommit> {
    let title = normalize_title(title.as_deref().unwrap_or("Untitled"))?;
    let title_delta = yjs::update_document_title(&source_snapshot, &title)
      .map_err(|error| AuthError::Storage(format!("source page Yjs state is invalid: {error}")))?;
    let initial_leaf_update = yjs::merge_updates(vec![source_snapshot, title_delta])
      .map_err(|error| AuthError::Storage(format!("source page Yjs state could not be materialized: {error}")))?;
    let doc_id = Uuid::new_v4();
    self
      .commit(PageLifecycleCommand::Create {
        workspace_id,
        doc_id,
        actor_user_id,
        title,
        initial_leaf_update,
        source_purpose,
        committed_at: Utc::now(),
      })
      .await
  }

  /// The same command timestamp is persisted as docs.created_at. Native template
  /// creation facts are expanded against it before this atomic publication.
  #[instrument(skip_all)]
  pub(crate) async fn create_project_from_snapshot(
    &self,
    workspace_id: Uuid,
    actor_user_id: Uuid,
    doc_id: Uuid,
    title: String,
    source_snapshot: Vec<u8>,
    committed_at: chrono::DateTime<Utc>,
    ack: crate::workspace::ProjectDocumentAck,
  ) -> AuthResult<PageLifecycleCommit> {
    let title = normalize_title(&title)?;
    let title_delta = yjs::update_document_title(&source_snapshot, &title).map_err(AuthError::Storage)?;
    let initial_leaf_update = yjs::merge_updates(vec![source_snapshot, title_delta]).map_err(AuthError::Storage)?;
    let committed = self
      .store
      .commit_project_page_lifecycle(
        PageLifecycleCommand::Create {
          workspace_id,
          doc_id,
          actor_user_id,
          title,
          initial_leaf_update,
          source_purpose: None,
          committed_at,
        },
        ack,
      )
      .await?;
    self.invalidate(&committed).await;
    Ok(committed)
  }

  #[instrument(skip(self, title), fields(%workspace_id, %doc_id, %actor_user_id, operation = "rename"))]
  pub async fn rename(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Uuid,
    title: String,
    expected_sequence: Option<i64>,
  ) -> AuthResult<PageLifecycleCommit> {
    self
      .commit(PageLifecycleCommand::Rename {
        workspace_id,
        doc_id,
        actor_user_id,
        title: normalize_title(&title)?,
        expected_sequence,
        committed_at: Utc::now(),
      })
      .await
  }

  #[instrument(skip(self), fields(%workspace_id, %doc_id, %actor_user_id, operation = "trash"))]
  pub async fn trash(&self, workspace_id: Uuid, doc_id: Uuid, actor_user_id: Uuid) -> AuthResult<PageLifecycleCommit> {
    self.set_trash(workspace_id, doc_id, actor_user_id, true).await
  }

  #[instrument(skip(self), fields(%workspace_id, %doc_id, %actor_user_id, operation = "restore"))]
  pub async fn restore(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Uuid,
  ) -> AuthResult<PageLifecycleCommit> {
    self.set_trash(workspace_id, doc_id, actor_user_id, false).await
  }

  async fn set_trash(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Uuid,
    is_trashed: bool,
  ) -> AuthResult<PageLifecycleCommit> {
    self
      .commit(PageLifecycleCommand::SetTrash {
        workspace_id,
        doc_id,
        actor_user_id,
        is_trashed,
        committed_at: Utc::now(),
      })
      .await
  }

  async fn commit(&self, command: PageLifecycleCommand) -> AuthResult<PageLifecycleCommit> {
    let started = Instant::now();
    let kind = command.kind();
    let result = self.store.commit_page_lifecycle(command).await;
    let outcome = if result.is_ok() { "committed" } else { "failed" };
    if let Some(metrics) = &self.metrics {
      metrics.record(
        MetricsCategory::Collab,
        "page_lifecycle_total",
        &[("operation", kind.as_str()), ("outcome", outcome)],
      );
    }
    let committed = result?;
    self.invalidate(&committed).await;
    info!(
      operation = kind.as_str(),
      leaf_sequence = committed.leaf.as_ref().map(|delta| delta.sequence),
      root_sequence = committed.workspace_root.sequence,
      duration_ms = started.elapsed().as_millis(),
      "page_lifecycle.committed"
    );
    Ok(committed)
  }

  async fn invalidate(&self, committed: &PageLifecycleCommit) {
    let Some(cache) = &self.cache else {
      return;
    };
    let workspace_id = committed.workspace_root.doc_id;
    cache.invalidate_metadata(committed.document.id).await;
    cache.invalidate_snapshot(workspace_id, committed.document.id).await;
    cache.invalidate_snapshot(workspace_id, workspace_id).await;
    cache.invalidate_timestamps(workspace_id).await;
  }
}

fn normalize_title(title: &str) -> AuthResult<String> {
  let title = title.trim();
  if title.is_empty() {
    return Err(AuthError::InvalidInput("MIX_PAGE_TITLE_REQUIRED".to_string()));
  }
  Ok(title.to_string())
}

fn map_initial_content_error(error: yjs::DocumentMutationError) -> AuthError {
  let code = match error {
    yjs::DocumentMutationError::EmptyFragment => "MIX_DOCUMENT_MUTATION_FRAGMENT_EMPTY",
    yjs::DocumentMutationError::InvalidFragment => "MIX_DOCUMENT_MUTATION_FRAGMENT_INVALID",
    _ => "MIX_DOCUMENT_MUTATION_FRAGMENT_INVALID",
  };
  AuthError::InvalidInput(code.to_string())
}
