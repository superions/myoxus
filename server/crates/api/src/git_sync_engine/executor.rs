// SPDX-License-Identifier: AGPL-3.0-or-later
//! Action execution: apply reconcile results to Git working tree and Myoxus DB.
//!
//! This module handles two independent execution paths:
//!
//! 1. **Document actions** — markdown docs synced via Yjs snapshots (existing).
//! 2. **File actions** — binary/non-markdown files synced via the blob store (M2-C1).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use bytes::Bytes;
use tracing::{debug, info, instrument, trace, warn};
use uuid::Uuid;

use myoxus_application::doc::{DocService, InitialDocumentProvenance, InitialDocumentProvenanceMode};
use myoxus_application::git_sync::backend::GitRepositoryPort;
use myoxus_application::git_sync::doc_reconcile_plan::{MyoxusDocState, SyncAction};
use myoxus_application::git_sync::export::{self, ExportFrontmatter};
use myoxus_application::git_sync::file_reconcile::{FileReconcileAction, blob_key_for_content};
use myoxus_application::git_sync::finalization::PreparedDocumentUpsert;
use myoxus_application::git_sync::import;
use myoxus_application::git_sync::reconcile::ReconcileAction;
use myoxus_application::markdown::{
  AuthorizedMarkdownBatchDocument, AuthorizedMarkdownDocument, MarkdownBatchReferenceInventory,
  MarkdownProjectionPolicy, markdown_image_sources, prepare_markdown_batch_import,
  project_document_in_batch_with_images, rewrite_markdown_image_sources,
};
use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest, PortError};
use myoxus_domain::git_sync::{GitSyncBinding, GitSyncProfile};
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::git_sync::SqlxGitSyncStore;

use super::error::ActionOutcome;

/// Result of executing a batch of actions.
#[derive(Debug, Default)]
pub struct ActionBatchResult {
  pub successes: i32,
  pub failures: i32,
  pub git_changed: bool,
  /// Doc IDs of actions that failed, for diagnostic logging and potential retry.
  pub failed_doc_ids: Vec<uuid::Uuid>,
  /// Map of doc_id → actual repo_path for files successfully written to git.
  /// Used by the atomic post-push plan to retain the actual written path.
  pub written_paths: HashMap<Uuid, String>,
}

#[derive(Debug, Default)]
pub struct PreparedMyoxusDocumentActions {
  pub actions: Vec<SyncAction>,
  pub upserts: Vec<PreparedDocumentUpsert>,
  pub deletes: Vec<Uuid>,
  /// Canonical persisted-body baseline and independently observed Git body hash.
  /// Both are captured by the same prepared import, never a second conversion.
  pub imported_hashes: HashMap<Uuid, (String, String)>,
}

/// Validate and materialize every Myoxus-side document mutation before Git can
/// move. The returned values contain no borrowed Git input and can be applied
/// inside the single post-push database transaction.
pub async fn prepare_myoxus_document_actions(
  pool: &sqlx::PgPool,
  actions: &[SyncAction],
  git_files: &[(String, String)],
  profile: &GitSyncProfile,
  server_origin: &str,
  authorized_documents: &[AuthorizedMarkdownDocument],
  external_ids_by_doc: &std::collections::HashMap<Uuid, String>,
  bindings: &[GitSyncBinding],
  planned_paths: &HashMap<Uuid, String>,
  asset_keys_by_path: &HashMap<String, String>,
) -> Result<PreparedMyoxusDocumentActions, String> {
  let mut prepared = PreparedMyoxusDocumentActions {
    actions: actions.to_vec(),
    ..PreparedMyoxusDocumentActions::default()
  };
  for action in &mut prepared.actions {
    if matches!(
      action.action,
      ReconcileAction::CreateInMyoxus | ReconcileAction::PullToMyoxus
    ) && action.doc_id.is_nil()
    {
      action.doc_id = Uuid::new_v4();
    }
  }
  let parsed_files = if prepared.actions.iter().any(|action| {
    matches!(
      action.action,
      ReconcileAction::CreateInMyoxus | ReconcileAction::PullToMyoxus
    )
  }) {
    git_files
      .iter()
      .map(|(path, content)| {
        import::parse_imported_file(path, content).map_err(|error| format!("parse imported Markdown {path}: {error}"))
      })
      .collect::<Result<Vec<_>, _>>()?
  } else {
    Vec::new()
  };
  let mut imports = Vec::new();
  for (index, action) in prepared.actions.iter().enumerate() {
    match action.action {
      ReconcileAction::CreateInMyoxus | ReconcileAction::PullToMyoxus => {
        let (file_index, _) = parsed_files
          .iter()
          .enumerate()
          .find(|(_, imported)| imported.sync_id == Some(action.sync_id))
          .or_else(|| {
            action.repo_path.as_ref().and_then(|target| {
              parsed_files
                .iter()
                .enumerate()
                .find(|(_, imported)| &imported.repo_path == target)
            })
          })
          .ok_or_else(|| {
            format!(
              "no matching Git file for sync_id {} (repo_path: {:?})",
              action.sync_id, action.repo_path
            )
          })?;
        imports.push((index, file_index));
      }
      ReconcileAction::DeleteInMyoxus => prepared.deletes.push(action.doc_id),
      _ => {}
    }
  }
  if imports.is_empty() {
    return Ok(prepared);
  }
  let deleted = prepared.deletes.iter().copied().collect::<HashSet<_>>();
  let replaced = imports
    .iter()
    .map(|(index, _)| prepared.actions[*index].doc_id)
    .collect::<HashSet<_>>();
  // Existing file identities come from authorized bindings, never frontmatter
  // doc_id values. Unchanged targets keep their current native trees; only
  // documents actually replaced in this batch receive a reserved namespace.
  let metadata_by_external = authorized_documents
    .iter()
    .map(|document| (document.external_id.as_str(), document))
    .collect::<HashMap<_, _>>();
  let mut batch = planned_paths
    .iter()
    .filter_map(|(doc_id, path)| {
      if deleted.contains(doc_id) {
        return None;
      }
      let external_id = external_ids_by_doc.get(doc_id)?;
      let document = metadata_by_external.get(external_id.as_str())?;
      Some((
        external_id.clone(),
        AuthorizedMarkdownBatchDocument {
          external_id: external_id.clone(),
          title: document.title.clone(),
          path: path.clone(),
        },
      ))
    })
    .collect::<HashMap<_, _>>();
  let bound_documents = bindings
    .iter()
    .filter_map(|binding| {
      if deleted.contains(&binding.doc_id) {
        return None;
      }
      let external_id = external_ids_by_doc.get(&binding.doc_id)?;
      let metadata = metadata_by_external.get(external_id.as_str())?;
      let path = parsed_files
        .iter()
        .find(|imported| imported.sync_id == Some(binding.sync_id))
        .map(|imported| imported.repo_path.clone())
        .or_else(|| {
          git_files
            .iter()
            .any(|(path, _)| path == &binding.repo_path)
            .then(|| binding.repo_path.clone())
        })?;
      Some((
        external_id.clone(),
        AuthorizedMarkdownBatchDocument {
          external_id: external_id.clone(),
          title: metadata.title.clone(),
          path,
        },
      ))
    })
    .collect::<HashMap<_, _>>();
  batch.extend(bound_documents);
  let mut internal_ids_by_external = external_ids_by_doc
    .iter()
    .map(|(id, external)| (external.clone(), *id))
    .collect::<HashMap<_, _>>();
  for (index, file_index) in &imports {
    let imported = &parsed_files[*file_index];
    let document = AuthorizedMarkdownBatchDocument {
      external_id: external_ids_by_doc
        .get(&prepared.actions[*index].doc_id)
        .cloned()
        .unwrap_or_else(|| prepared.actions[*index].doc_id.to_string()),
      title: imported.title.clone(),
      path: imported.repo_path.clone(),
    };
    internal_ids_by_external.insert(document.external_id.clone(), prepared.actions[*index].doc_id);
    batch.insert(document.external_id.clone(), document);
  }
  let deleted_external_ids = deleted
    .iter()
    .filter_map(|id| external_ids_by_doc.get(id))
    .collect::<HashSet<_>>();
  let document_base_url = format!(
    "{}/workspace/{}",
    server_origin.trim_end_matches('/'),
    profile.workspace_id
  );
  let authorized = authorized_documents
    .iter()
    .filter(|document| !deleted_external_ids.contains(&document.external_id))
    .cloned()
    .collect::<Vec<_>>();
  let batch = batch.into_values().collect::<Vec<_>>();
  let input_paths = batch
    .iter()
    .map(|document| (document.external_id.clone(), document.path.clone()))
    .collect::<HashMap<_, _>>();
  let export_batch = batch
    .iter()
    .cloned()
    .map(|mut document| {
      if let Some(path) = internal_ids_by_external
        .get(&document.external_id)
        .and_then(|id| planned_paths.get(id))
      {
        document.path = path.clone();
      }
      document
    })
    .collect::<Vec<_>>();
  let export_paths = export_batch
    .iter()
    .map(|document| (internal_ids_by_external[&document.external_id], document.path.clone()))
    .collect::<HashMap<_, _>>();
  let export_inventory =
    MarkdownBatchReferenceInventory::new_with_authorized(&document_base_url, authorized.iter().cloned(), export_batch)
      .map_err(|error| format!("Markdown baseline path batch: {error}"))?;
  let inventory = MarkdownBatchReferenceInventory::new_with_authorized(&document_base_url, authorized, batch)
    .map_err(|error| format!("Markdown reference batch: {error}"))?;
  let current_ids = external_ids_by_doc
    .keys()
    .filter(|id| !deleted.contains(id) && !replaced.contains(id))
    .copied()
    .collect::<HashSet<_>>();
  let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let current = super::loader::load_projection_snapshots(&service, profile.workspace_id, &current_ids)
    .await
    .map_err(|error| format!("Markdown target snapshots: {error}"))?;
  let current = current
    .into_iter()
    .map(|(id, binary)| (external_ids_by_doc[&id].clone(), binary))
    .collect::<Vec<_>>();
  let workspace_id = profile.workspace_id;
  let actor_user_id = profile.owner_id;
  let profile_id = profile.id;
  let external_ids_by_doc = external_ids_by_doc.clone();
  let asset_keys_by_path = asset_keys_by_path.clone();
  tokio::task::spawn_blocking(move || {
    let mut snapshots = current.into_iter().collect::<HashMap<_, _>>();
    let inventory = inventory
      .with_target_snapshots(snapshots.iter().map(|(id, binary)| (id.as_str(), binary.as_slice())))
      .and_then(|inventory| {
        inventory.with_exported_target_sources(snapshots.keys().filter_map(|id| {
          let path = input_paths.get(id)?;
          let observed = parsed_files.iter().find(|imported| &imported.repo_path == path)?;
          Some((id.as_str(), observed.markdown.as_str()))
        }))
      })
      .and_then(|inventory| {
        inventory.with_import_sources(imports.iter().map(|(_, file_index)| {
          let imported = &parsed_files[*file_index];
          (imported.repo_path.as_str(), imported.markdown.as_str())
        }))
      })
      .map_err(|error| format!("Markdown target batch: {error}"))?;
    let mut baseline_inputs = Vec::with_capacity(imports.len());
    for (index, file_index) in imports {
      let imported = &parsed_files[file_index];
      let action = &prepared.actions[index];
      let references = inventory
        .for_source(&imported.repo_path)
        .map_err(|error| format!("Markdown references for {}: {error}", imported.repo_path))?;
      let replacements = markdown_image_sources(&imported.markdown)
        .into_iter()
        .filter_map(|source| {
          let path = references.resolve_import_asset_path(&source)?;
          let key = asset_keys_by_path.get(&path)?;
          Some((source, key.clone()))
        })
        .collect();
      let markdown = rewrite_markdown_image_sources(&imported.markdown, &replacements)
        .map_err(|error| format!("Markdown image preparation: {error}"))?;
      let payload = prepare_markdown_batch_import(&imported.title, &markdown, &references)
        .map_err(|error| format!("Markdown to Yjs for {}: {error}", imported.repo_path))?;
      if !payload.diagnostics.is_empty() {
        warn!(
          path = %imported.repo_path,
          diagnostics = payload.diagnostics.len(),
          "Git Markdown import retained unresolved document references"
        );
      }
      let external_id = external_ids_by_doc
        .get(&action.doc_id)
        .cloned()
        .unwrap_or_else(|| action.doc_id.to_string());
      snapshots.insert(external_id.clone(), payload.yjs_binary.clone());
      baseline_inputs.push((action.doc_id, external_id, file_index));
      prepared.upserts.push(PreparedDocumentUpsert {
        observed_at: chrono::DateTime::from_timestamp_micros(chrono::Utc::now().timestamp_micros())
          .expect("current server timestamp"),
        doc_id: action.doc_id,
        workspace_id,
        expected_create: matches!(action.action, ReconcileAction::CreateInMyoxus),
        title: imported.title.clone(),
        actor_user_id,
        payload: payload.yjs_binary,
        provenance: InitialDocumentProvenance {
          idempotency_key: Some(format!(
            "git-sync-import:{}:{}:{}",
            profile_id, action.sync_id, action.doc_id
          )),
          client_family: Some("git-sync".to_string()),
          client_version: None,
          client_instance_id: Some(profile_id.to_string()),
          provenance_mode: InitialDocumentProvenanceMode::ExplicitImport,
          client_created_at: None,
          client_updated_at: None,
          client_created_by: None,
          client_updated_by: None,
          historical_user_mapping_id: None,
          source_property_doc_revision: action.repo_path.clone(),
        },
      });
    }
    // Import resolves the paths actually read from Git; the persisted-body
    // baseline uses the outbound plan, including target moves in this run.
    let exported = export_inventory
      .prepare_export_snapshots(snapshots)
      .map_err(|error| format!("prepare persisted import baselines: {error}"))?;
    for (doc_id, external_id, file_index) in baseline_inputs {
      let imported = &parsed_files[file_index];
      let references = exported
        .references
        .for_source(&export_paths[&doc_id])
        .map_err(|error| format!("import baseline references: {error}"))?;
      let projected = project_document_in_batch_with_images(
        &exported.snapshots[&external_id],
        &imported.title,
        MarkdownProjectionPolicy::default(),
        &references,
        &|key| {
          asset_keys_by_path
            .iter()
            .filter(|(_, asset)| asset.as_str() == key)
            .map(|(path, _)| path)
            .min()
            .and_then(|path| references.resolve_export_asset_path(path))
            .or_else(|| Some(key.to_string()))
        },
      )
      .map_err(|error| format!("project persisted import baseline: {error}"))?;
      prepared
        .imported_hashes
        .insert(doc_id, (projected.content_hash, imported.content_hash.clone()));
    }
    Ok(prepared)
  })
  .await
  .map_err(|error| format!("Markdown import worker: {error}"))?
}

/// Execute all git-side actions (write/delete files in the working tree).
///
/// Individual failures are logged and tracked but do NOT abort the sync.
/// The caller can inspect `failed_doc_ids` for diagnostics.
#[instrument(skip_all)]
pub async fn execute_git_actions(
  git_repo: &dyn GitRepositoryPort,
  actions: &[SyncAction],
  myoxus_docs: &[MyoxusDocState],
  profile: &GitSyncProfile,
  bindings: &[GitSyncBinding],
) -> ActionBatchResult {
  let mut result = ActionBatchResult::default();

  // P38-E-03: Pre-build HashMaps for O(1) lookups instead of linear scans.
  let doc_map: HashMap<Uuid, &MyoxusDocState> = myoxus_docs.iter().map(|d| (d.doc_id, d)).collect();
  let binding_map: HashMap<Uuid, &GitSyncBinding> = bindings.iter().map(|b| (b.id, b)).collect();

  for action in actions {
    let outcome = match &action.action {
      ReconcileAction::CreateInGit | ReconcileAction::PushToGit => {
        execute_write_to_git(git_repo, action, &doc_map, &binding_map, profile).await
      }
      ReconcileAction::DeleteInGit => execute_delete_from_git(git_repo, action, &binding_map).await,
      _ => ActionOutcome::Skipped,
    };

    // Track the written path for successful writes
    if matches!(
      &action.action,
      ReconcileAction::CreateInGit | ReconcileAction::PushToGit
    ) && matches!(&outcome, ActionOutcome::Success)
      && let Some(doc) = doc_map.get(&action.doc_id)
      && let Some(repo_path) = &doc.planned_repo_path
    {
      result.written_paths.insert(action.doc_id, repo_path.clone());
    }

    match outcome {
      ActionOutcome::Success => {
        result.successes += 1;
        result.git_changed = true;
      }
      ActionOutcome::PartialFailure(msg) => {
        warn!(action_doc = %action.doc_id, error = %msg, "git action partial failure");
        result.failures += 1;
        result.failed_doc_ids.push(action.doc_id);
      }
      ActionOutcome::Skipped => {}
    }
  }

  result
}

/// Execute all Myoxus-side actions (create/update/delete docs in DB).
///
/// Uses transactions per doc for atomicity. Returns batch result with tracking.
/// Write a Myoxus doc to the Git working tree as a markdown file with frontmatter.
async fn execute_write_to_git(
  git_repo: &dyn GitRepositoryPort,
  action: &SyncAction,
  doc_map: &HashMap<Uuid, &MyoxusDocState>,
  binding_map: &HashMap<Uuid, &GitSyncBinding>,
  profile: &GitSyncProfile,
) -> ActionOutcome {
  let Some(doc) = doc_map.get(&action.doc_id) else {
    return ActionOutcome::PartialFailure(format!("doc {} not found in myoxus state", action.doc_id));
  };
  let Some(markdown) = &doc.markdown else {
    return ActionOutcome::PartialFailure(format!(
      "doc {} reached outbound execution without a loaded body",
      action.doc_id
    ));
  };

  let markdown = markdown.as_str();

  let frontmatter = ExportFrontmatter {
    sync_id: action.sync_id,
    doc_id: doc.doc_id,
    workspace_id: profile.workspace_id,
    title: doc.title.clone(),
  };
  let Some(repo_path) = &doc.planned_repo_path else {
    return ActionOutcome::PartialFailure(format!("doc {} has no preflighted repository path", action.doc_id));
  };
  let file_content = export::compose_markdown_file(&frontmatter, markdown);

  match git_repo.write_file(repo_path, file_content.as_bytes()).await {
    Ok(()) => {
      if let Some(binding) = binding_map.get(&action.binding_id)
        && binding.repo_path != *repo_path
        && let Err(error) = git_repo.delete_file(&binding.repo_path).await
      {
        let rollback = git_repo
          .delete_file(repo_path)
          .await
          .err()
          .map(|cleanup| format!("; failed to remove new path during rollback: {cleanup}"))
          .unwrap_or_default();
        return ActionOutcome::PartialFailure(format!(
          "move {} to {}: failed to delete old path: {error}{rollback}",
          binding.repo_path, repo_path
        ));
      }
      debug!(doc_id = %action.doc_id, %repo_path, "wrote file to git");
      ActionOutcome::Success
    }
    Err(e) => ActionOutcome::PartialFailure(format!("write_file({repo_path}): {e}")),
  }
}

/// Delete a file from the Git working tree.
async fn execute_delete_from_git(
  git_repo: &dyn GitRepositoryPort,
  action: &SyncAction,
  binding_map: &HashMap<Uuid, &GitSyncBinding>,
) -> ActionOutcome {
  let Some(binding) = binding_map.get(&action.binding_id) else {
    return ActionOutcome::PartialFailure(format!(
      "binding {} not found in loaded bindings — cannot determine file path for deletion",
      action.binding_id
    ));
  };

  match git_repo.delete_file(&binding.repo_path).await {
    Ok(()) => {
      debug!(binding_id = %action.binding_id, repo_path = %binding.repo_path, "deleted file from git");
      ActionOutcome::Success
    }
    Err(e) => ActionOutcome::PartialFailure(format!("delete_file({}): {e}", binding.repo_path)),
  }
}

// ─── File Execution (M2-C1) ──────────────────────────────────────────────────

/// A file successfully pulled from Git into the Myoxus blob store.
#[derive(Debug, Clone)]
pub struct PulledFile {
  /// Path of the file inside the Git repository.
  pub repo_path: String,
  /// Blob store key where the bytes were written.
  pub blob_key: String,
  /// Physical workspace-scoped key; references and file bindings use blob_key.
  pub storage_key: String,
  /// Content hash of the pulled file.
  pub content_hash: String,
  /// Effective MIME type of the file.
  pub mime_type: String,
  /// Size in bytes.
  pub size: u64,
  /// True when this run created the immutable final object and may remove it
  /// after a database rollback.
  pub newly_promoted: bool,
  /// Durable recovery identity when the production runner owns this promotion.
  pub promotion_id: Option<Uuid>,
  /// Temporary object retained until the database outcome is known.
  pub stage_key: Option<String>,
}

/// A file successfully pushed from the Myoxus blob store to Git.
#[derive(Debug, Clone)]
pub struct PushedFile {
  /// Path of the file inside the Git repository.
  pub repo_path: String,
  /// Blob store key that was read.
  pub blob_key: String,
  /// Content hash of the pushed file.
  pub content_hash: String,
}

/// A file conflict detected during reconciliation.
#[derive(Debug, Clone)]
pub struct FileConflict {
  pub repo_path: String,
  pub git_hash: String,
  pub myoxus_hash: String,
  pub baseline_hash: String,
}

/// An error that occurred while executing a single file action.
#[derive(Debug, Clone)]
pub struct FileExecutionError {
  pub repo_path: String,
  pub action: String,
  pub message: String,
}

/// Result of executing a batch of file reconcile actions.
#[derive(Debug, Default)]
pub struct FileExecutionResult {
  /// Files successfully pulled from Git into the blob store.
  pub pulled: Vec<PulledFile>,
  /// Files successfully pushed from the blob store to Git.
  pub pushed: Vec<PushedFile>,
  /// Repo paths of files deleted from Git.
  pub deleted_git: Vec<String>,
  /// Blob keys marked for soft-deletion in Myoxus.
  pub deleted_myoxus: Vec<String>,
  /// Repo paths whose Myoxus-side blobs were deleted successfully.
  pub deleted_myoxus_paths: Vec<String>,
  /// Unresolvable conflicts (reported, not executed).
  pub conflicts: Vec<FileConflict>,
  /// Per-file errors (partial failures — other files still processed).
  pub errors: Vec<FileExecutionError>,
  /// Whether any file was written to or deleted from the Git working tree.
  pub git_changed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileExecutionPhase {
  /// Mutates only the Git working tree. Must run before commit_and_push so
  /// file pushes/deletes are part of the remote commit.
  GitBeforeCommit,
  /// Prepares Myoxus blob storage before the remote can move. The final SQL
  /// transaction adopts the durable promotion after a verified push.
  MyoxusBeforeCommit,
}

/// Execute only file actions that mutate the Git working tree.
///
/// This phase is intentionally separate from Myoxus blob mutations. Any
/// `PushToGit`/`DeleteFromGit` must happen before `commit_and_push`; otherwise
/// the run can persist a successful file push while the remote commit does not
/// contain the bytes.
#[instrument(skip_all)]
pub async fn execute_file_git_actions(
  actions: &[FileReconcileAction],
  git_repo: &dyn GitRepositoryPort,
  blob_storage: &dyn BlobStoragePort,
  workspace_id: Uuid,
  profile_id: Uuid,
) -> FileExecutionResult {
  execute_file_actions_for_phase(
    actions,
    git_repo,
    blob_storage,
    workspace_id,
    profile_id,
    FileExecutionPhase::GitBeforeCommit,
    None,
  )
  .await
}

/// Prepare Myoxus blob mutations before the remote can move.
///
/// Every promotion is recorded before the stage is written. The final SQL
/// transaction adopts those objects after a verified push; an earlier failure
/// still owns and removes its staging and newly promoted objects.
#[instrument(skip_all)]
#[allow(clippy::too_many_arguments)]
pub async fn execute_file_myoxus_actions_durable(
  actions: &[FileReconcileAction],
  git_repo: &dyn GitRepositoryPort,
  blob_storage: &dyn BlobStoragePort,
  workspace_id: Uuid,
  profile_id: Uuid,
  store: &SqlxGitSyncStore,
  run_id: Uuid,
) -> FileExecutionResult {
  execute_file_actions_for_phase(
    actions,
    git_repo,
    blob_storage,
    workspace_id,
    profile_id,
    FileExecutionPhase::MyoxusBeforeCommit,
    Some((store, run_id)),
  )
  .await
}

/// Complete the durable blob-promotion saga after PostgreSQL finalization has a
/// proven outcome. Cleanup happens before deleting the ledger; a cleanup or
/// ledger failure therefore remains recoverable by the periodic reconciler.
pub async fn cleanup_file_promotions(
  store: &SqlxGitSyncStore,
  blob_storage: &dyn BlobStoragePort,
  pulled: &[PulledFile],
  committed: bool,
) -> Result<(), String> {
  if committed {
    cleanup_committed_file_stages(blob_storage, pulled).await?;
  } else {
    cleanup_uncommitted_file_objects(blob_storage, pulled, Some(store)).await?;
  }
  let promotion_ids = pulled.iter().filter_map(|file| file.promotion_id).collect::<Vec<_>>();
  let deleted = store
    .delete_blob_promotion_records(&promotion_ids)
    .await
    .map_err(|error| format!("delete blob promotion ledger: {error}"))?;
  if deleted != promotion_ids.len() as u64 {
    return Err(format!(
      "deleted {deleted} of {} blob promotion ledger rows",
      promotion_ids.len()
    ));
  }
  Ok(())
}

async fn execute_file_actions_for_phase(
  actions: &[FileReconcileAction],
  git_repo: &dyn GitRepositoryPort,
  blob_storage: &dyn BlobStoragePort,
  workspace_id: Uuid,
  profile_id: Uuid,
  phase: FileExecutionPhase,
  promotion_context: Option<(&SqlxGitSyncStore, Uuid)>,
) -> FileExecutionResult {
  let mut result = FileExecutionResult::default();

  for action in actions {
    match action {
      FileReconcileAction::PullToMyoxus {
        repo_path,
        content_hash,
        bytes,
        mime_type,
      } => {
        if phase != FileExecutionPhase::MyoxusBeforeCommit {
          continue;
        }
        match execute_file_pull_to_myoxus(
          blob_storage,
          workspace_id,
          profile_id,
          repo_path,
          content_hash,
          bytes,
          mime_type,
          promotion_context,
        )
        .await
        {
          Ok(pulled) => {
            info!(
              repo_path = %pulled.repo_path,
              blob_key = %pulled.blob_key,
              size = pulled.size,
              mime = %pulled.mime_type,
              "file pulled from git to blob store"
            );
            result.pulled.push(pulled);
          }
          Err(msg) => {
            warn!(repo_path = %repo_path, error = %msg, "file pull to myoxus failed");
            result.errors.push(FileExecutionError {
              repo_path: repo_path.clone(),
              action: "PullToMyoxus".to_string(),
              message: msg,
            });
          }
        }
      }

      FileReconcileAction::PushToGit {
        repo_path,
        blob_key,
        content_hash,
      } => {
        if phase != FileExecutionPhase::GitBeforeCommit {
          continue;
        }
        match execute_file_push_to_git(git_repo, blob_storage, workspace_id, repo_path, blob_key, content_hash).await {
          Ok(()) => {
            info!(repo_path = %repo_path, blob_key = %blob_key, "file pushed from blob store to git");
            result.pushed.push(PushedFile {
              repo_path: repo_path.clone(),
              blob_key: blob_key.clone(),
              content_hash: content_hash.clone(),
            });
            result.git_changed = true;
          }
          Err(msg) => {
            warn!(repo_path = %repo_path, blob_key = %blob_key, error = %msg, "file push to git failed");
            result.errors.push(FileExecutionError {
              repo_path: repo_path.clone(),
              action: "PushToGit".to_string(),
              message: msg,
            });
          }
        }
      }

      FileReconcileAction::DeleteFromGit { repo_path, .. } => {
        if phase != FileExecutionPhase::GitBeforeCommit {
          continue;
        }
        match git_repo.delete_file(repo_path).await {
          Ok(()) => {
            info!(repo_path = %repo_path, "file deleted from git");
            result.deleted_git.push(repo_path.clone());
            result.git_changed = true;
          }
          Err(e) => {
            warn!(repo_path = %repo_path, error = %e, "file delete from git failed");
            result.errors.push(FileExecutionError {
              repo_path: repo_path.clone(),
              action: "DeleteFromGit".to_string(),
              message: format!("delete_file: {e}"),
            });
          }
        }
      }

      FileReconcileAction::DeleteFromMyoxus { repo_path, blob_key } => {
        if phase != FileExecutionPhase::MyoxusBeforeCommit {
          continue;
        }
        // The transaction tombstones the binding and removes its baseline.
        // Physical deletion is deferred to reference-aware GC so a rollback
        // can never remove an object still referenced by committed state.
        result.deleted_myoxus.push(blob_key.clone());
        result.deleted_myoxus_paths.push(repo_path.clone());
      }

      FileReconcileAction::Conflict {
        repo_path,
        git_hash,
        myoxus_hash,
        baseline_hash,
      } => {
        if phase != FileExecutionPhase::MyoxusBeforeCommit {
          continue;
        }
        info!(
          repo_path = %repo_path,
          git_hash = %git_hash,
          myoxus_hash = %myoxus_hash,
          baseline_hash = %baseline_hash,
          "file conflict detected — requires manual resolution"
        );
        result.conflicts.push(FileConflict {
          repo_path: repo_path.clone(),
          git_hash: git_hash.clone(),
          myoxus_hash: myoxus_hash.clone(),
          baseline_hash: baseline_hash.clone(),
        });
      }

      FileReconcileAction::NoChange { repo_path } => {
        trace!(repo_path = %repo_path, "file unchanged — no action");
      }
    }
  }

  info!(
    pulled = result.pulled.len(),
    pushed = result.pushed.len(),
    deleted_git = result.deleted_git.len(),
    deleted_myoxus = result.deleted_myoxus.len(),
    conflicts = result.conflicts.len(),
    errors = result.errors.len(),
    git_changed = result.git_changed,
    phase = ?phase,
    "file action batch completed"
  );

  result
}

/// Pull a file from Git into the Myoxus blob store.
///
/// Stages bytes, promotes them to an immutable content-addressed key, verifies
/// the promoted bytes, and returns rollback ownership to the caller.
#[expect(
  clippy::too_many_arguments,
  reason = "file promotion keeps source identity, bytes, and optional transaction context explicit"
)]
async fn execute_file_pull_to_myoxus(
  blob_storage: &dyn BlobStoragePort,
  workspace_id: Uuid,
  profile_id: Uuid,
  repo_path: &str,
  content_hash: &str,
  bytes: &[u8],
  mime_type: &str,
  promotion_context: Option<(&SqlxGitSyncStore, Uuid)>,
) -> Result<PulledFile, String> {
  let blob_key = blob_key_for_content(profile_id, content_hash);
  let storage_key = myoxus_application::ports::blob::BlobKey::parse(&blob_key)?.storage_key(workspace_id);
  let stage_key = format!("git-sync-staging/{profile_id}/{}", Uuid::new_v4());
  let promotion_id = promotion_context.map(|_| Uuid::new_v4());
  let size = bytes.len() as u64;
  if let (Some((store, run_id)), Some(promotion_id)) = (promotion_context, promotion_id) {
    store
      .create_blob_promotion(promotion_id, run_id, profile_id, workspace_id, &stage_key, &storage_key)
      .await
      .map_err(|error| format!("record blob promotion for {repo_path}: {error}"))?;
  }

  trace!(
    repo_path = repo_path,
    blob_key = %blob_key,
    content_hash = content_hash,
    mime_type = mime_type,
    size = size,
    "staging git file bytes before immutable promotion"
  );
  if let Err(error) = blob_storage
    .write_blob(BlobWriteRequest {
      key: stage_key.clone(),
      content_type: Some(mime_type.to_string()),
      body: Bytes::copy_from_slice(bytes),
    })
    .await
  {
    rollback_blob_promotion(
      blob_storage,
      promotion_context.map(|value| value.0),
      promotion_id,
      &stage_key,
      None,
    )
    .await?;
    return Err(format!("stage blob for {repo_path} (key={stage_key}): {error}"));
  }
  let newly_promoted = match blob_storage.read_blob(&storage_key).await {
    Ok(existing) if existing.data.as_ref() == bytes => false,
    Ok(_) => {
      rollback_blob_promotion(
        blob_storage,
        promotion_context.map(|value| value.0),
        promotion_id,
        &stage_key,
        None,
      )
      .await?;
      return Err(format!("immutable blob collision for {repo_path} (key={blob_key})"));
    }
    Err(PortError::NotFound(_)) => {
      if let Err(error) = blob_storage
        .write_blob(BlobWriteRequest {
          key: storage_key.clone(),
          content_type: Some(mime_type.to_string()),
          body: Bytes::copy_from_slice(bytes),
        })
        .await
      {
        rollback_blob_promotion(
          blob_storage,
          promotion_context.map(|value| value.0),
          promotion_id,
          &stage_key,
          Some(&storage_key),
        )
        .await?;
        return Err(format!("promote blob for {repo_path} (key={blob_key}): {error}"));
      }
      true
    }
    Err(error) => {
      rollback_blob_promotion(
        blob_storage,
        promotion_context.map(|value| value.0),
        promotion_id,
        &stage_key,
        None,
      )
      .await?;
      return Err(format!(
        "inspect immutable blob for {repo_path} (key={blob_key}): {error}"
      ));
    }
  };
  let promoted = match blob_storage.read_blob(&storage_key).await {
    Ok(promoted) => promoted,
    Err(error) => {
      rollback_blob_promotion(
        blob_storage,
        promotion_context.map(|value| value.0),
        promotion_id,
        &stage_key,
        newly_promoted.then_some(storage_key.as_str()),
      )
      .await?;
      return Err(format!(
        "verify promoted blob for {repo_path} (key={blob_key}): {error}"
      ));
    }
  };
  if promoted.data.as_ref() != bytes {
    rollback_blob_promotion(
      blob_storage,
      promotion_context.map(|value| value.0),
      promotion_id,
      &stage_key,
      newly_promoted.then_some(storage_key.as_str()),
    )
    .await?;
    return Err(format!("promoted blob verification mismatch for {repo_path}"));
  }
  if let (Some((store, _)), Some(promotion_id)) = (promotion_context, promotion_id) {
    if let Err(error) = store.mark_blob_promotion_prepared(promotion_id, newly_promoted).await {
      rollback_blob_promotion(
        blob_storage,
        Some(store),
        Some(promotion_id),
        &stage_key,
        newly_promoted.then_some(storage_key.as_str()),
      )
      .await?;
      return Err(format!("mark blob promotion prepared for {repo_path}: {error}"));
    }
  } else if let Err(error) = blob_storage.delete_blob(&stage_key).await {
    if newly_promoted {
      blob_storage
        .delete_blob(&storage_key)
        .await
        .map_err(|cleanup| format!("remove promoted blob after stage cleanup failure: {cleanup}"))?;
    }
    return Err(format!("remove staged blob for {repo_path} (key={stage_key}): {error}"));
  }

  Ok(PulledFile {
    repo_path: repo_path.to_string(),
    blob_key,
    storage_key,
    content_hash: content_hash.to_string(),
    mime_type: mime_type.to_string(),
    size,
    newly_promoted,
    promotion_id,
    stage_key: promotion_id.map(|_| stage_key),
  })
}

async fn rollback_blob_promotion(
  blob_storage: &dyn BlobStoragePort,
  store: Option<&SqlxGitSyncStore>,
  promotion_id: Option<Uuid>,
  stage_key: &str,
  final_key: Option<&str>,
) -> Result<(), String> {
  let mut failures = Vec::new();
  if let Some(final_key) = final_key {
    let result = if let Some(store) = store {
      store
        .cleanup_unreferenced_blob_object(blob_storage, final_key)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
    } else {
      blob_storage
        .delete_blob(final_key)
        .await
        .map_err(|error| error.to_string())
    };
    if let Err(error) = result {
      failures.push(format!("{final_key}: {error}"));
    }
  }
  if let Err(error) = blob_storage.delete_blob(stage_key).await {
    failures.push(format!("{stage_key}: {error}"));
  }
  if failures.is_empty()
    && let (Some(store), Some(promotion_id)) = (store, promotion_id)
    && let Err(error) = store.delete_blob_promotion_records(&[promotion_id]).await
  {
    failures.push(format!("promotion ledger {promotion_id}: {error}"));
  }
  if failures.is_empty() {
    Ok(())
  } else {
    Err(format!("blob promotion cleanup failed: {}", failures.join("; ")))
  }
}

async fn cleanup_uncommitted_file_objects(
  blob_storage: &dyn BlobStoragePort,
  pulled: &[PulledFile],
  store: Option<&SqlxGitSyncStore>,
) -> Result<(), String> {
  let mut failures = Vec::new();
  for file in pulled.iter().filter(|file| file.newly_promoted) {
    let result = if let Some(store) = store {
      store
        .cleanup_unreferenced_blob_object(blob_storage, &file.storage_key)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
    } else {
      blob_storage
        .delete_blob(&file.storage_key)
        .await
        .map_err(|error| error.to_string())
    };
    if let Err(error) = result {
      warn!(blob_key = %file.blob_key, %error, "failed to clean uncommitted immutable Git-Sync blob");
      failures.push(format!("{}: {error}", file.blob_key));
    }
  }
  for file in pulled {
    if let Some(stage_key) = &file.stage_key
      && let Err(error) = blob_storage.delete_blob(stage_key).await
    {
      warn!(%stage_key, %error, "failed to clean uncommitted Git-Sync stage");
      failures.push(format!("{stage_key}: {error}"));
    }
  }
  if failures.is_empty() {
    Ok(())
  } else {
    Err(format!("failed to clean {} uncommitted blob object(s)", failures.len()))
  }
}

async fn cleanup_committed_file_stages(
  blob_storage: &dyn BlobStoragePort,
  pulled: &[PulledFile],
) -> Result<(), String> {
  let mut failures = Vec::new();
  for file in pulled {
    if let Some(stage_key) = &file.stage_key
      && let Err(error) = blob_storage.delete_blob(stage_key).await
    {
      failures.push(format!("{stage_key}: {error}"));
    }
  }
  if failures.is_empty() {
    Ok(())
  } else {
    Err(format!("failed to clean {} committed blob stage(s)", failures.len()))
  }
}

/// Push a file from the Myoxus blob store to the Git working tree.
///
/// Reads the blob bytes via `BlobStoragePort` and writes them to the
/// repository working tree at the given `repo_path`.
async fn execute_file_push_to_git(
  git_repo: &dyn GitRepositoryPort,
  blob_storage: &dyn BlobStoragePort,
  workspace_id: Uuid,
  repo_path: &str,
  blob_key: &str,
  content_hash: &str,
) -> Result<(), String> {
  trace!(
    repo_path = repo_path,
    blob_key = blob_key,
    "reading blob bytes for push to git"
  );

  let key = myoxus_application::ports::blob::BlobKey::parse(blob_key)?.storage_key(workspace_id);
  let read_resp = match blob_storage.read_blob(&key).await {
    Ok(response) => response,
    // Existing deployed Git file bindings predate normal workspace blob
    // publication. Their immutable raw object remains readable until a pull
    // republishes it through the normal owner; no new raw writes are made.
    Err(PortError::NotFound(_)) => blob_storage
      .read_blob(blob_key)
      .await
      .map_err(|error| format!("legacy Git blob read: {error}"))?,
    Err(error) => return Err(format!("workspace Git blob read: {error}")),
  };
  use sha2::Digest;
  if hex::encode(sha2::Sha256::digest(&read_resp.data)) != content_hash {
    return Err("Git blob checksum changed before delivery".into());
  }

  trace!(
    repo_path = repo_path,
    blob_key = blob_key,
    size = read_resp.data.len(),
    "writing blob bytes to git working tree"
  );

  git_repo
    .write_file(repo_path, &read_resp.data)
    .await
    .map_err(|e| format!("write_file({repo_path}): {e}"))?;

  Ok(())
}

/// The manifest is an output inventory, not the full reconciliation input.
/// Retain verified current files for deferred/conflicted actions, and introduce
/// planned paths only for writes selected in this batch. Prepared inbound facts
/// share their observed Git source path before their atomic SQL publication.
pub(super) fn effective_manifest_documents(
  workspace_id: Uuid,
  docs: &[MyoxusDocState],
  actions: &[SyncAction],
  bindings: &[GitSyncBinding],
  git_files: &[(String, String)],
  prepared: &PreparedMyoxusDocumentActions,
  previous: Option<&export::GitSyncManifest>,
) -> Result<(Vec<export::GitSyncManifestDocument>, HashMap<Uuid, String>), String> {
  let observed = git_files
    .iter()
    .map(|(path, content)| (path.as_str(), content.as_str()))
    .collect::<HashMap<_, _>>();
  let current = docs.iter().map(|doc| (doc.doc_id, doc)).collect::<HashMap<_, _>>();
  let placement = |id: Uuid, path: String, title: String, hash: String| {
    let doc = current.get(&id);
    let old = previous.and_then(|manifest| manifest.documents.iter().find(|doc| doc.doc_id == id));
    export::GitSyncManifestDocument {
      doc_id: id,
      repo_path: path,
      title,
      content_hash: hash,
      organizer_entry_id: doc
        .map(|doc| doc.organizer_entry_id.clone())
        .unwrap_or_else(|| old.and_then(|doc| doc.organizer_entry_id.clone())),
      organizer_folder_ids: doc
        .map(|doc| doc.organizer_folder_ids.clone())
        .or_else(|| old.map(|doc| doc.organizer_folder_ids.clone()))
        .unwrap_or_default(),
    }
  };
  let mut entries = std::collections::BTreeMap::new();
  let mut bodies = HashMap::new();
  for binding in bindings.iter().filter(|binding| !binding.tombstone) {
    let Some(content) = observed.get(binding.repo_path.as_str()) else {
      continue;
    };
    let (yaml, body) = export::split_markdown_file(content);
    if let Some(header) = yaml.as_deref().and_then(export::ExportFrontmatter::from_yaml) {
      if header.workspace_id != workspace_id || header.doc_id != binding.doc_id || header.sync_id != binding.sync_id {
        continue;
      }
    } else if yaml.is_some() {
      continue;
    }
    let parsed = import::parse_imported_file(&binding.repo_path, content)?;
    entries.insert(
      binding.doc_id,
      placement(
        binding.doc_id,
        binding.repo_path.clone(),
        parsed.title,
        myoxus_application::markdown::content_hash(&body),
      ),
    );
    bodies.insert(binding.doc_id, body);
  }
  for action in actions {
    match action.action {
      ReconcileAction::DeleteInGit | ReconcileAction::DeleteInMyoxus => {
        entries.remove(&action.doc_id);
        bodies.remove(&action.doc_id);
      }
      ReconcileAction::CreateInGit | ReconcileAction::PushToGit => {
        let doc = current
          .get(&action.doc_id)
          .ok_or("selected outbound document is missing")?;
        let path = doc
          .planned_repo_path
          .clone()
          .ok_or("selected outbound path is missing")?;
        let body = doc.markdown.clone().ok_or("selected outbound body is missing")?;
        entries.insert(
          action.doc_id,
          placement(
            action.doc_id,
            path,
            doc.title.clone(),
            myoxus_application::markdown::content_hash(&body),
          ),
        );
        bodies.insert(action.doc_id, body);
      }
      _ => {}
    }
  }
  for document in &prepared.upserts {
    let action = actions
      .iter()
      .find(|action| action.doc_id == document.doc_id)
      .ok_or("prepared inbound action is missing")?;
    let path = action
      .repo_path
      .clone()
      .ok_or("prepared inbound source path is missing")?;
    let raw = observed.get(path.as_str()).ok_or("prepared inbound file is missing")?;
    let (_, body) = export::split_markdown_file(raw);
    entries.insert(
      document.doc_id,
      placement(
        document.doc_id,
        path,
        document.title.clone(),
        myoxus_application::markdown::content_hash(&body),
      ),
    );
    bodies.insert(document.doc_id, body);
  }
  Ok((entries.into_values().collect(), bodies))
}

pub(super) struct PreparedOverviewPublication {
  pub manifest: export::GitSyncManifest,
  pub writes: std::collections::BTreeMap<String, Vec<u8>>,
  pub deletes: Vec<String>,
}

/// Prepare the complete derived batch without touching the mirror. Ordinary
/// actions retain their complete inputs and existing execution/finalization.
#[allow(clippy::too_many_arguments)]
pub(super) async fn prepare_overview_publication(
  pool: &sqlx::PgPool,
  profile: &GitSyncProfile,
  origin: &str,
  service: &myoxus_application::workspace_overview::WorkspaceOverviewService,
  snapshot: &myoxus_application::organizer::OrganizerSnapshot,
  mut manifest: export::GitSyncManifest,
  bodies: HashMap<Uuid, String>,
  prepared: &PreparedMyoxusDocumentActions,
  actions: &[SyncAction],
  bindings: &[GitSyncBinding],
  file_actions: &[FileReconcileAction],
  file_bindings: &[myoxus_domain::git_sync::GitSyncFileBinding],
  mut observed: std::collections::BTreeSet<String>,
  previous: Option<&export::GitSyncManifest>,
  asset_paths: &HashMap<String, String>,
  capture: myoxus_application::markdown::PreparedMarkdownBatchExport,
  scope: &export::GitSyncWriterScope,
) -> Result<PreparedOverviewPublication, String> {
  use myoxus_application::{
    git_sync::{overview::plan_git_overview_paths, projection::OrganizerProjection},
    markdown::{AuthorizedMarkdownBatchDocument, AuthorizedMarkdownDocument},
  };
  let emitted = manifest.documents.iter().map(|doc| doc.doc_id).collect::<HashSet<_>>();
  let permissions = super::loader::projection_permissions(pool);
  let (source, overview) = service
    .read_git_source(
      profile.owner_id,
      &permissions,
      snapshot,
      &emitted,
      &prepared.upserts,
      &prepared.deletes,
    )
    .await
    .map_err(|error| error.to_string())?;
  for action in actions {
    if matches!(action.action, ReconcileAction::DeleteInGit | ReconcileAction::PushToGit) {
      if let Some(binding) = bindings.iter().find(|binding| binding.id == action.binding_id) {
        observed.remove(&binding.repo_path);
      }
    }
  }
  let mut file_owners = file_bindings
    .iter()
    .filter(|binding| !binding.tombstoned)
    .map(|binding| (binding.repo_path.clone(), binding.id.to_string()))
    .collect::<std::collections::BTreeMap<_, _>>();
  for action in file_actions {
    match action {
      FileReconcileAction::DeleteFromGit { repo_path, .. } => {
        observed.remove(repo_path);
        file_owners.remove(repo_path);
      }
      FileReconcileAction::DeleteFromMyoxus { repo_path, .. } => {
        file_owners.remove(repo_path);
      }
      FileReconcileAction::PushToGit {
        repo_path, blob_key, ..
      } => {
        observed.insert(repo_path.clone());
        file_owners.insert(repo_path.clone(), blob_key.clone());
      }
      FileReconcileAction::PullToMyoxus { repo_path, .. } => {
        file_owners.insert(repo_path.clone(), "prepared inbound file".into());
      }
      _ => {}
    }
  }
  let final_documents = manifest
    .documents
    .iter()
    .map(|doc| (doc.doc_id, doc.repo_path.clone()))
    .collect::<HashMap<_, _>>();
  observed.extend(final_documents.values().cloned());
  let paths = plan_git_overview_paths(
    profile.workspace_id,
    &profile.root_path,
    &OrganizerProjection {
      revision: snapshot.revision.clone(),
      folders: manifest.folders.clone(),
      documents: Default::default(),
    },
    &final_documents,
    &file_owners,
    &observed,
    previous,
  )
  .map_err(|error| error.to_string())?;
  let external = source
    .documents
    .iter()
    .map(|doc| (doc.doc_id, doc.reference.resource_id().to_string()))
    .collect::<HashMap<_, _>>();
  let authorized = source.documents.iter().map(|doc| AuthorizedMarkdownDocument {
    external_id: doc.reference.resource_id().into(),
    title: doc.title.clone(),
  });
  let batch = manifest.documents.iter().filter_map(|doc| {
    Some(AuthorizedMarkdownBatchDocument {
      external_id: external.get(&doc.doc_id)?.clone(),
      title: doc.title.clone(),
      path: doc.repo_path.clone(),
    })
  });
  let inventory = MarkdownBatchReferenceInventory::new_with_authorized(
    &format!("{}/workspace/{}", origin.trim_end_matches('/'), profile.workspace_id),
    authorized,
    batch,
  )
  .map_err(|error| error.to_string())?;
  let pages = std::iter::once(&overview.root)
    .chain(&overview.folders)
    .collect::<Vec<_>>();
  let intro_ids = pages
    .iter()
    .filter_map(|page| page.introduction.as_ref().map(|doc| doc.doc_id))
    .collect::<HashSet<_>>();
  let mut snapshots = capture.snapshots;
  for document in &prepared.upserts {
    if let Some(key) = external.get(&document.doc_id) {
      snapshots.insert(key.clone(), document.payload.clone());
    }
  }
  let missing = intro_ids
    .iter()
    .filter(|id| external.get(id).is_some_and(|key| !snapshots.contains_key(key)))
    .copied()
    .collect::<HashSet<_>>();
  let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  for (id, body) in super::loader::load_projection_snapshots(&doc_service, profile.workspace_id, &missing)
    .await
    .map_err(|error| error.to_string())?
  {
    snapshots.insert(external.get(&id).ok_or("missing introduction identity")?.clone(), body);
  }
  drop(pages);
  let intro_keys = intro_ids
    .iter()
    .filter_map(|id| external.get(id).cloned())
    .collect::<HashSet<_>>();
  let (mut inventory, mut snapshots, exact_targets) = tokio::task::spawn_blocking(move || {
    let exact = intro_keys
      .iter()
      .filter_map(|key| snapshots.get(key))
      .try_fold(false, |needed, body| {
        inventory
          .requires_native_export_targets(body)
          .map(|current| needed || current)
      })
      .map_err(|error| error.to_string())?;
    Ok::<_, String>((inventory, snapshots, exact))
  })
  .await
  .map_err(|error| error.to_string())??;
  if exact_targets {
    let missing = emitted
      .iter()
      .filter(|id| external.get(id).is_some_and(|key| !snapshots.contains_key(key)))
      .copied()
      .collect::<HashSet<_>>();
    for (id, body) in super::loader::load_projection_snapshots(&doc_service, profile.workspace_id, &missing)
      .await
      .map_err(|error| error.to_string())?
    {
      if let Some(key) = external.get(&id) {
        snapshots.insert(key.clone(), body);
      }
    }
  }
  let asset_paths = asset_paths.clone();
  let scope = scope.clone();
  tokio::task::spawn_blocking(move || {
    if exact_targets {
      let allowed = external.values().map(String::as_str).collect::<HashSet<_>>();
      inventory = inventory
        .with_target_snapshots(
          snapshots
            .iter()
            .filter(|(key, _)| allowed.contains(key.as_str()))
            .map(|(key, body)| (key.as_str(), body.as_slice())),
        )
        .and_then(|inventory| {
          inventory.with_materialized_target_sources(
            bodies
              .iter()
              .filter_map(|(id, body)| Some((external.get(id)?.as_str(), body.as_str()))),
          )
        })
        .map_err(|error| error.to_string())?;
    }
    let writes = myoxus_application::git_sync::overview::render_git_overview_batch(
      &source.workspace.name,
      &overview,
      &paths,
      &inventory,
      &snapshots,
      &|key| asset_paths.get(key).filter(|path| observed.contains(*path)).cloned(),
      &mut manifest,
    )?;
    for path in writes
      .keys()
      .map(String::as_str)
      .chain(paths.retired.iter().map(|path| path.as_str()))
    {
      if scope.excludes(path).map_err(|error| error.to_string())? {
        return Err("generated Git-Sync output enters a delegated repository scope".to_string());
      }
    }
    manifest.validate_overviews(manifest.workspace_id, file_owners.keys().map(String::as_str))?;
    // The complete ordinary map is kept by the caller; no pending action was
    // removed from reconciliation to obtain this output-only projection.
    Ok(PreparedOverviewPublication {
      manifest,
      writes,
      deletes: paths
        .retired
        .into_iter()
        .map(|path| path.as_str().to_string())
        .collect(),
    })
  })
  .await
  .map_err(|error| error.to_string())?
}
