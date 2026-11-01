// SPDX-License-Identifier: AGPL-3.0-or-later
//! Permanent document delete use-case.
//!
//! This module keeps the destructive delete semantics in the application layer:
//! API adapters provide auth context and transport shape, while this code owns
//! ID normalization, root-doc metadata cleanup and structured per-document
//! outcomes.

use std::collections::{HashMap, HashSet};

use myoxus_domain::document_key::DocumentKey;
use tracing::{debug, error, info, instrument, warn};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};
use crate::doc::{ASSIGNED_TEMPLATE_SOURCE_PROTECTED, DocDeleteCandidate, DocService, DocSpaceKind};

const MAX_SELECTED_DELETE_DOCS: usize = 500;
const EMPTY_TRASH_LIMIT: i64 = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermanentDeleteMode {
  SelectedDocs,
  AllTrashed,
}

/// Native ownership proof required in addition to the captured content revision.
/// Storage rechecks it under the document locks; these authorities never fall
/// back to each other when attribution changes during recovery.
#[derive(Debug, Clone, Copy)]
pub enum SourceRetirementOwnership {
  ManagedAssignment,
  ConfirmedUnboundTemplate,
}

#[derive(Debug, Clone)]
pub struct PermanentDeleteRequest {
  pub workspace_id: Uuid,
  pub actor_user_id: Option<Uuid>,
  pub mode: PermanentDeleteMode,
  pub doc_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermanentDeleteStatus {
  Deleted,
  NotFound,
  Forbidden,
  AlreadyDeleted,
  NotTrashed,
  Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermanentDeleteDocumentResult {
  pub client_doc_id: String,
  pub resolved_doc_id: Option<Uuid>,
  pub title: Option<String>,
  pub status: PermanentDeleteStatus,
  pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermanentDeleteSummary {
  pub requested: usize,
  pub deleted: usize,
  pub not_found: usize,
  pub forbidden: usize,
  pub already_deleted: usize,
  pub not_trashed: usize,
  pub failed: usize,
  pub root_meta_removed: usize,
  pub documents: Vec<PermanentDeleteDocumentResult>,
}

impl PermanentDeleteSummary {
  fn new(requested: usize) -> Self {
    Self {
      requested,
      deleted: 0,
      not_found: 0,
      forbidden: 0,
      already_deleted: 0,
      not_trashed: 0,
      failed: 0,
      root_meta_removed: 0,
      documents: Vec::new(),
    }
  }

  fn push(&mut self, result: PermanentDeleteDocumentResult) {
    match result.status {
      PermanentDeleteStatus::Deleted => self.deleted += 1,
      PermanentDeleteStatus::NotFound => self.not_found += 1,
      PermanentDeleteStatus::Forbidden => self.forbidden += 1,
      PermanentDeleteStatus::AlreadyDeleted => self.already_deleted += 1,
      PermanentDeleteStatus::NotTrashed => self.not_trashed += 1,
      PermanentDeleteStatus::Failed => self.failed += 1,
    }
    self.documents.push(result);
  }

  pub fn is_success(&self) -> bool {
    self.failed == 0 && self.forbidden == 0
  }
}

impl DocService {
  #[instrument(skip(self, request), fields(workspace_id = %request.workspace_id, actor_user_id = ?request.actor_user_id, mode = ?request.mode))]
  pub async fn permanently_delete_documents(
    &self,
    request: PermanentDeleteRequest,
  ) -> AuthResult<PermanentDeleteSummary> {
    self.permanently_delete_documents_inner(request, None).await
  }

  /// Use the ordinary permanent-delete lifecycle, fenced to the content that
  /// justified automatic retirement. User-requested deletion is unconditional.
  pub(crate) async fn permanently_delete_source_at_revision(
    &self,
    request: PermanentDeleteRequest,
    doc_id: Uuid,
    revision: i64,
  ) -> AuthResult<PermanentDeleteSummary> {
    self
      .permanently_delete_source_with_fence(request, doc_id, revision, SourceRetirementOwnership::ManagedAssignment)
      .await
  }

  /// Retire an operator-confirmed standalone native template, never an ordinary
  /// document or a source still bound to a Registry instance. Identity, content
  /// revision and positive unbound template state are rechecked before deletion.
  /// Per-document fence failures appear in the returned unsuccessful summary.
  pub async fn permanently_delete_confirmed_template_source_at_revision(
    &self,
    request: PermanentDeleteRequest,
    doc_id: Uuid,
    revision: i64,
  ) -> AuthResult<PermanentDeleteSummary> {
    self
      .permanently_delete_source_with_fence(
        request,
        doc_id,
        revision,
        SourceRetirementOwnership::ConfirmedUnboundTemplate,
      )
      .await
  }

  async fn permanently_delete_source_with_fence(
    &self,
    request: PermanentDeleteRequest,
    doc_id: Uuid,
    revision: i64,
    ownership: SourceRetirementOwnership,
  ) -> AuthResult<PermanentDeleteSummary> {
    if !matches!(request.mode, PermanentDeleteMode::SelectedDocs) || request.doc_ids.len() != 1 {
      return Err(AuthError::InvalidInput(
        "source retirement requires one selected document".into(),
      ));
    }
    self
      .permanently_delete_documents_inner(request, Some((doc_id, revision, ownership)))
      .await
  }

  async fn permanently_delete_documents_inner(
    &self,
    request: PermanentDeleteRequest,
    source_revision: Option<(Uuid, i64, SourceRetirementOwnership)>,
  ) -> AuthResult<PermanentDeleteSummary> {
    let candidates = match request.mode {
      PermanentDeleteMode::SelectedDocs => self.resolve_selected_delete_candidates(&request).await?,
      PermanentDeleteMode::AllTrashed => {
        self
          .store
          .list_trashed_delete_candidates(request.workspace_id, EMPTY_TRASH_LIMIT)
          .await?
      }
    };
    let candidate_client_ids: HashSet<String> = candidates
      .iter()
      .map(|candidate| candidate.client_doc_id.clone())
      .collect();
    let (stale_trashed_root_page_ids, all_trashed_root_full_doc) =
      if matches!(request.mode, PermanentDeleteMode::AllTrashed) {
        let full_doc = self
          .load
          .load_full_doc(request.workspace_id, request.workspace_id)
          .await?;
        let stale_ids = stale_trashed_root_page_ids(&full_doc, request.workspace_id, &candidate_client_ids)?;
        (stale_ids, Some(full_doc))
      } else {
        (Vec::new(), None)
      };

    let mut summary = PermanentDeleteSummary::new(match request.mode {
      PermanentDeleteMode::SelectedDocs => dedupe_strings(&request.doc_ids).len(),
      PermanentDeleteMode::AllTrashed => candidates
        .iter()
        .map(|candidate| candidate.client_doc_id.clone())
        .chain(stale_trashed_root_page_ids.iter().cloned())
        .chain(dedupe_strings(&request.doc_ids))
        .collect::<HashSet<_>>()
        .len(),
    });

    let mut candidate_by_id: HashMap<String, DocDeleteCandidate> = candidates
      .into_iter()
      .map(|candidate| (candidate.client_doc_id.clone(), candidate))
      .collect();

    let mut missing_selected_ids = Vec::new();
    if matches!(request.mode, PermanentDeleteMode::SelectedDocs) {
      for document_key in normalized_selected_ids(&request.doc_ids)? {
        if let Some(candidate) = candidate_by_id.remove(document_key.as_str()) {
          if is_protected_delete_candidate(request.workspace_id, &candidate) {
            summary.push(PermanentDeleteDocumentResult {
              client_doc_id: candidate.client_doc_id,
              resolved_doc_id: Some(candidate.doc_id),
              title: Some(candidate.title),
              status: PermanentDeleteStatus::Forbidden,
              reason: Some("root and system documents are not deleted by the document trash flow".to_string()),
            });
          } else {
            candidate_by_id.insert(candidate.client_doc_id.clone(), candidate);
          }
        } else {
          missing_selected_ids.push(document_key);
        }
      }
    } else {
      let protected: Vec<String> = candidate_by_id
        .iter()
        .filter_map(|(id, candidate)| {
          is_protected_delete_candidate(request.workspace_id, candidate).then_some(id.clone())
        })
        .collect();
      for id in protected {
        if let Some(candidate) = candidate_by_id.remove(&id) {
          summary.push(PermanentDeleteDocumentResult {
            client_doc_id: candidate.client_doc_id,
            resolved_doc_id: Some(candidate.doc_id),
            title: Some(candidate.title),
            status: PermanentDeleteStatus::Forbidden,
            reason: Some("root and system documents are not deleted by emptyTrash".to_string()),
          });
        }
      }
    }

    let candidates_to_delete: Vec<DocDeleteCandidate> = candidate_by_id.into_values().collect();
    // Existing candidates are removed from the root by the atomic hard-delete
    // store path after its Registry protection check. Only already-missing
    // document rows need this separate stale-root cleanup.
    let mut root_page_ids: Vec<String> = Vec::new();
    for stale_root_id in &stale_trashed_root_page_ids {
      root_page_ids.push(stale_root_id.clone());
      summary.push(PermanentDeleteDocumentResult {
        client_doc_id: stale_root_id.clone(),
        resolved_doc_id: None,
        title: None,
        status: PermanentDeleteStatus::AlreadyDeleted,
        reason: Some("document row was already absent; stale trashed root metadata was removed".to_string()),
      });
    }

    if matches!(request.mode, PermanentDeleteMode::AllTrashed) && !request.doc_ids.is_empty() {
      let server_root_entries = yjs::extract_page_trash_state(all_trashed_root_full_doc.as_deref().unwrap_or_default())
        .map_err(|e| AuthError::Storage(format!("root meta client-trash reconciliation failed: {e}")))?;
      let root_entry_by_id: HashMap<String, yjs::TrashEntry> = server_root_entries
        .into_iter()
        .map(|entry| (entry.id.clone(), entry))
        .collect();
      let already_reported: HashSet<String> = summary
        .documents
        .iter()
        .map(|document| document.client_doc_id.clone())
        .chain(root_page_ids.iter().cloned())
        .collect();

      for client_doc_id in dedupe_strings(&request.doc_ids) {
        if client_doc_id.is_empty()
          || already_reported.contains(&client_doc_id)
          || candidate_client_ids.contains(&client_doc_id)
        {
          continue;
        }
        if client_doc_id == request.workspace_id.to_string() {
          summary.push(PermanentDeleteDocumentResult {
            client_doc_id,
            resolved_doc_id: Some(request.workspace_id),
            title: None,
            status: PermanentDeleteStatus::Forbidden,
            reason: Some("workspace root is not deleted by emptyTrash".to_string()),
          });
          continue;
        }

        match root_entry_by_id.get(&client_doc_id) {
          Some(entry) if !entry.is_trashed => {
            summary.push(PermanentDeleteDocumentResult {
              client_doc_id: client_doc_id.clone(),
              resolved_doc_id: None,
              title: entry.title.clone(),
              status: PermanentDeleteStatus::NotTrashed,
              reason: Some(
                "document is live in the authoritative workspace root; local trash projection should be restored"
                  .to_string(),
              ),
            });
          }
          Some(_) => {}
          None => {
            summary.push(PermanentDeleteDocumentResult {
              client_doc_id: client_doc_id.clone(),
              resolved_doc_id: None,
              title: None,
              status: PermanentDeleteStatus::AlreadyDeleted,
              reason: Some(
                "document is absent from the authoritative workspace root; local stale trash projection may be removed"
                  .to_string(),
              ),
            });
          }
        }
      }
    }

    let root_full_doc =
      if candidates_to_delete.is_empty() && missing_selected_ids.is_empty() && stale_trashed_root_page_ids.is_empty() {
        Vec::new()
      } else if let Some(full_doc) = all_trashed_root_full_doc {
        full_doc
      } else {
        self
          .load
          .load_full_doc(request.workspace_id, request.workspace_id)
          .await?
      };
    let candidate_root_entry_counts = if candidates_to_delete.is_empty() {
      HashMap::new()
    } else {
      yjs::extract_page_trash_state(&root_full_doc)
        .map_err(|e| AuthError::Storage(format!("root meta delete accounting failed: {e}")))?
        .into_iter()
        .fold(HashMap::<String, usize>::new(), |mut counts, entry| {
          *counts.entry(entry.id).or_default() += 1;
          counts
        })
    };

    if matches!(request.mode, PermanentDeleteMode::SelectedDocs) && !missing_selected_ids.is_empty() {
      let root_visible_ids: HashSet<String> = yjs::extract_page_trash_state(&root_full_doc)
        .map_err(|e| AuthError::Storage(format!("root meta stale-page inspection failed: {e}")))?
        .into_iter()
        .map(|entry| entry.id)
        .collect();

      for document_key in missing_selected_ids {
        let client_doc_id = document_key.into_string();
        if client_doc_id == request.workspace_id.to_string() || client_doc_id.starts_with("db$") {
          summary.push(PermanentDeleteDocumentResult {
            client_doc_id,
            resolved_doc_id: None,
            title: None,
            status: PermanentDeleteStatus::Forbidden,
            reason: Some("root and system documents are not deleted by the document trash flow".to_string()),
          });
        } else if root_visible_ids.contains(&client_doc_id) {
          root_page_ids.push(client_doc_id.clone());
          summary.push(PermanentDeleteDocumentResult {
            client_doc_id,
            resolved_doc_id: None,
            title: None,
            status: PermanentDeleteStatus::AlreadyDeleted,
            reason: Some("document row was already absent; stale root metadata was removed".to_string()),
          });
        } else {
          summary.push(PermanentDeleteDocumentResult {
            client_doc_id,
            resolved_doc_id: None,
            title: None,
            status: PermanentDeleteStatus::NotFound,
            reason: Some("document not found in workspace".to_string()),
          });
        }
      }
    }

    if !root_page_ids.is_empty() {
      let root_removal = yjs::remove_pages_from_root_doc(&root_full_doc, &root_page_ids)
        .map_err(|e| AuthError::Storage(format!("root meta removal failed: {e}")))?;

      if !root_removal.update.is_empty() {
        self
          .write
          .push_update_raw(
            request.workspace_id,
            request.workspace_id,
            root_removal.update,
            DocSpaceKind::Workspace,
          )
          .await
          .map_err(|e| AuthError::Storage(format!("root meta update failed before permanent delete: {e}")))?;
        summary.root_meta_removed = root_removal.removed_entries;
      } else {
        debug!(workspace_id = %request.workspace_id, "permanent delete found no matching root meta entries");
      }
    }

    if candidates_to_delete.is_empty() {
      return Ok(summary);
    }

    for candidate in candidates_to_delete {
      let database_reference_refreshes = self
        .database_reference_refreshes_before_delete(request.workspace_id, candidate.doc_id)
        .await;
      let deleted = match source_revision {
        Some((expected_id, revision, ownership)) if expected_id == candidate.doc_id => {
          self
            .store
            .hard_delete_doc_scoped_at_revision(request.workspace_id, candidate.doc_id, revision, ownership)
            .await
        }
        Some(_) => Err(AuthError::InvalidInput(
          "source retirement document identity changed".into(),
        )),
        None => {
          self
            .store
            .hard_delete_doc_scoped(request.workspace_id, candidate.doc_id)
            .await
        }
      };
      match deleted {
        Ok(true) => {
          summary.root_meta_removed += candidate_root_entry_counts
            .get(&candidate.client_doc_id)
            .copied()
            .unwrap_or_default();
          if let Some(cache) = &self.doc_cache {
            cache.invalidate_metadata(candidate.doc_id).await;
            cache.invalidate_snapshot(request.workspace_id, candidate.doc_id).await;
            cache.invalidate_timestamps(request.workspace_id).await;
          }
          self
            .notify_document_graph_deleted(request.workspace_id, candidate.doc_id)
            .await;
          self
            .enqueue_database_reference_refreshes(request.workspace_id, candidate.doc_id, database_reference_refreshes)
            .await;
          summary.push(PermanentDeleteDocumentResult {
            client_doc_id: candidate.client_doc_id,
            resolved_doc_id: Some(candidate.doc_id),
            title: Some(candidate.title),
            status: PermanentDeleteStatus::Deleted,
            reason: None,
          });
        }
        Ok(false) => {
          summary.push(PermanentDeleteDocumentResult {
            client_doc_id: candidate.client_doc_id,
            resolved_doc_id: Some(candidate.doc_id),
            title: Some(candidate.title),
            status: PermanentDeleteStatus::AlreadyDeleted,
            reason: Some("document was already deleted concurrently".to_string()),
          });
        }
        Err(AuthError::InvalidInput(code)) if code == ASSIGNED_TEMPLATE_SOURCE_PROTECTED => {
          summary.push(PermanentDeleteDocumentResult {
            client_doc_id: candidate.client_doc_id,
            resolved_doc_id: Some(candidate.doc_id),
            title: Some(candidate.title),
            status: PermanentDeleteStatus::Forbidden,
            reason: Some(code),
          });
        }
        Err(error) => {
          warn!(workspace_id = %request.workspace_id, doc_id = %candidate.doc_id, error = %error, "permanent document delete failed");
          summary.push(PermanentDeleteDocumentResult {
            client_doc_id: candidate.client_doc_id,
            resolved_doc_id: Some(candidate.doc_id),
            title: Some(candidate.title),
            status: PermanentDeleteStatus::Failed,
            reason: Some(error.to_string()),
          });
        }
      }
    }

    info!(
      workspace_id = %request.workspace_id,
      actor_user_id = ?request.actor_user_id,
      requested = summary.requested,
      deleted = summary.deleted,
      failed = summary.failed,
      forbidden = summary.forbidden,
      not_found = summary.not_found,
      root_meta_removed = summary.root_meta_removed,
      "permanent document delete completed"
    );
    Ok(summary)
  }

  async fn resolve_selected_delete_candidates(
    &self,
    request: &PermanentDeleteRequest,
  ) -> AuthResult<Vec<DocDeleteCandidate>> {
    if request.doc_ids.is_empty() {
      return Err(AuthError::InvalidInput(
        "doc_ids must not be empty for selected permanent delete".to_string(),
      ));
    }
    let parsed = normalized_selected_ids(&request.doc_ids)?;
    if parsed.len() > MAX_SELECTED_DELETE_DOCS {
      return Err(AuthError::InvalidInput(format!(
        "selected permanent delete accepts at most {MAX_SELECTED_DELETE_DOCS} documents"
      )));
    }
    let external_ids: Vec<String> = parsed.into_iter().map(DocumentKey::into_string).collect();
    self
      .store
      .list_delete_candidates(request.workspace_id, &external_ids)
      .await
  }

  #[instrument(skip(self))]
  pub async fn delete_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<()> {
    let result = self
      .permanently_delete_documents(PermanentDeleteRequest {
        workspace_id,
        actor_user_id: None,
        mode: PermanentDeleteMode::SelectedDocs,
        doc_ids: vec![doc_id.to_string()],
      })
      .await?;

    if result.deleted == 1 || result.already_deleted == 1 || result.not_found == 1 {
      return Ok(());
    }

    error!(%workspace_id, %doc_id, ?result, "legacy delete_doc did not complete cleanly");
    Err(AuthError::Storage("legacy permanent delete failed".to_string()))
  }
}

fn normalized_selected_ids(doc_ids: &[String]) -> AuthResult<Vec<DocumentKey>> {
  dedupe_strings(doc_ids)
    .into_iter()
    .map(|client_doc_id| {
      DocumentKey::parse(client_doc_id.clone())
        .map_err(|e| AuthError::InvalidInput(format!("invalid document id '{client_doc_id}': {e}")))
    })
    .collect()
}

fn dedupe_strings(values: &[String]) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut deduped = Vec::new();
  for value in values {
    if seen.insert(value.clone()) {
      deduped.push(value.clone());
    }
  }
  deduped
}

fn is_protected_delete_candidate(workspace_id: Uuid, candidate: &DocDeleteCandidate) -> bool {
  candidate.is_workspace_root || candidate.doc_id == workspace_id || candidate.client_doc_id.starts_with("db$")
}

fn stale_trashed_root_page_ids(
  root_full_doc: &[u8],
  workspace_id: Uuid,
  candidate_client_ids: &HashSet<String>,
) -> AuthResult<Vec<String>> {
  let mut seen = HashSet::new();
  let mut ids = Vec::new();
  for entry in yjs::extract_page_trash_state(root_full_doc)
    .map_err(|e| AuthError::Storage(format!("root meta stale-trash inspection failed: {e}")))?
  {
    if !entry.is_trashed || candidate_client_ids.contains(&entry.id) {
      continue;
    }
    if entry.id == workspace_id.to_string() {
      continue;
    }
    if seen.insert(entry.id.clone()) {
      ids.push(entry.id);
    }
  }
  Ok(ids)
}
