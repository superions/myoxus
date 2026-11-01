// SPDX-License-Identifier: AGPL-3.0-or-later
//! Post-sync persistence: update bindings, baselines, and run status in DB.

use std::collections::HashMap;

use tracing::{info, instrument, trace};
use uuid::Uuid;

use myoxus_application::git_sync::doc_reconcile_plan::{MyoxusDocState, SyncAction};
use myoxus_application::git_sync::file_reconcile::{FileReconcileAction, blob_key_for_content, blob_key_for_repo_path};
use myoxus_application::git_sync::finalization::{
  DocumentBaselineDraft, GitSyncPersistenceDraft, PreparedDocumentUpsert,
};
use myoxus_application::git_sync::projection;
use myoxus_application::git_sync::reconcile::ReconcileAction;
use myoxus_domain::git_sync::{
  ConflictResolution, ConflictType, GitSyncBinding, GitSyncConflict, GitSyncFileBaseline, GitSyncFileBinding,
  GitSyncFileConflict, GitSyncProfile, GitSyncRun, GitSyncVersionLink,
};
use myoxus_infrastructure::git_sync::SqlxGitSyncStore;

#[allow(clippy::too_many_arguments)]
pub fn build_persistence_draft(
  actions: &[SyncAction],
  myoxus_docs: &[MyoxusDocState],
  existing_bindings: &[GitSyncBinding],
  git_files: &[(String, String)],
  written_paths: &HashMap<Uuid, String>,
  file_actions: &[FileReconcileAction],
  existing_file_bindings: &[GitSyncFileBinding],
  prepared_documents: &[PreparedDocumentUpsert],
  imported_hashes: &HashMap<Uuid, (String, String)>,
  profile: &GitSyncProfile,
  run_id: Uuid,
) -> Result<GitSyncPersistenceDraft, String> {
  let mut facts = GitSyncPersistenceDraft::default();
  let now = chrono::Utc::now();
  let docs_by_id: HashMap<Uuid, &MyoxusDocState> = myoxus_docs.iter().map(|doc| (doc.doc_id, doc)).collect();
  let prepared_titles: HashMap<Uuid, &str> = prepared_documents
    .iter()
    .map(|document| (document.doc_id, document.title.as_str()))
    .collect();
  let bindings_by_id: HashMap<Uuid, &GitSyncBinding> =
    existing_bindings.iter().map(|binding| (binding.id, binding)).collect();
  let file_bindings_by_path: HashMap<&str, &GitSyncFileBinding> = existing_file_bindings
    .iter()
    .map(|binding| (binding.repo_path.as_str(), binding))
    .collect();

  for action in actions {
    match action.action {
      ReconcileAction::CreateInGit
      | ReconcileAction::PushToGit
      | ReconcileAction::CreateInMyoxus
      | ReconcileAction::PullToMyoxus => {
        let repo_path = written_paths
          .get(&action.doc_id)
          .cloned()
          .or_else(|| action.repo_path.clone())
          .or_else(|| {
            bindings_by_id
              .get(&action.binding_id)
              .map(|binding| binding.repo_path.clone())
          })
          .ok_or_else(|| format!("successful document action {} has no repository path", action.doc_id))?;
        let (baseline_hash, git_source_hash) = match action.action {
          ReconcileAction::CreateInGit | ReconcileAction::PushToGit => {
            let hash = docs_by_id
              .get(&action.doc_id)
              .and_then(|doc| doc.content_hash.clone())
              .ok_or_else(|| {
                format!(
                  "successful outbound document action {} has no content hash",
                  action.doc_id
                )
              })?;
            (hash.clone(), hash)
          }
          _ => imported_hashes.get(&action.doc_id).cloned().ok_or_else(|| {
            format!(
              "successful inbound document action {} has no prepared baseline",
              action.doc_id
            )
          })?,
        };
        let mut binding = if action.binding_id.is_nil() {
          GitSyncBinding {
            id: Uuid::new_v4(),
            profile_id: profile.id,
            workspace_id: profile.workspace_id,
            doc_id: action.doc_id,
            sync_id: action.sync_id,
            repo_path: repo_path.clone(),
            last_commit_oid: None,
            content_hash: Some(git_source_hash.clone()),
            structure_hash: prepared_titles
              .get(&action.doc_id)
              .copied()
              .or_else(|| docs_by_id.get(&action.doc_id).map(|doc| doc.title.as_str()))
              .map(|title| projection::structure_hash(&repo_path, title)),
            tombstone: false,
            created_at: now,
            updated_at: now,
          }
        } else {
          let mut binding = (*bindings_by_id
            .get(&action.binding_id)
            .ok_or_else(|| format!("binding {} missing from current state", action.binding_id))?)
          .clone();
          binding.repo_path = repo_path.clone();
          binding.last_commit_oid = None;
          binding.content_hash = Some(git_source_hash.clone());
          binding.structure_hash = prepared_titles
            .get(&action.doc_id)
            .copied()
            .or_else(|| docs_by_id.get(&action.doc_id).map(|doc| doc.title.as_str()))
            .map(|title| projection::structure_hash(&repo_path, title));
          binding
        };
        binding.tombstone = false;
        facts.document_bindings.push(binding.clone());
        facts.document_baselines.push(DocumentBaselineDraft {
          binding_id: binding.id,
          content_hash: baseline_hash,
          myoxus_updated_at: now,
          captured_at: now,
        });
      }
      ReconcileAction::DeleteInGit | ReconcileAction::DeleteInMyoxus => {
        if action.binding_id.is_nil() {
          return Err(format!("delete action {} has no binding", action.doc_id));
        }
        facts.document_tombstone_ids.push(action.binding_id);
      }
      ReconcileAction::Conflict(conflict_type) | ReconcileAction::DeleteConflict(conflict_type) => {
        let binding = bindings_by_id.get(&action.binding_id).copied();
        let repo_path = binding
          .map(|value| value.repo_path.clone())
          .or_else(|| action.repo_path.clone())
          .filter(|path| !path.trim().is_empty())
          .ok_or_else(|| format!("document conflict {} has no repository path", action.doc_id))?;
        // Candidate identity only: the SQL observation rule may reuse an older
        // open decision. Only committed insert counts are reported as created.
        facts.document_conflicts.push(GitSyncConflict {
          id: Uuid::new_v4(),
          profile_id: profile.id,
          binding_id: binding.map(|value| value.id),
          doc_id: action.doc_id,
          repo_path: repo_path.clone(),
          conflict_type,
          resolution: ConflictResolution::Open,
          base_content: None,
          myoxus_content: docs_by_id.get(&action.doc_id).and_then(|doc| doc.markdown.clone()),
          git_content: git_files
            .iter()
            .find(|(path, _)| path == &repo_path)
            .map(|(_, content)| content.clone()),
          created_at: now,
          resolved_at: None,
          resolved_by: None,
        });
      }
      ReconcileAction::NoChange | ReconcileAction::SkippedByPolicy => {}
    }
  }

  for action in file_actions {
    match action {
      FileReconcileAction::PullToMyoxus {
        repo_path,
        content_hash,
        bytes,
        mime_type,
      } => {
        let blob_key = blob_key_for_content(profile.id, content_hash);
        facts.file_bindings.push(GitSyncFileBinding {
          id: file_bindings_by_path
            .get(repo_path.as_str())
            .map(|binding| binding.id)
            .unwrap_or_else(Uuid::new_v4),
          profile_id: profile.id,
          workspace_id: profile.workspace_id,
          blob_key: blob_key.clone(),
          repo_path: repo_path.clone(),
          content_hash: content_hash.clone(),
          mime_type: mime_type.clone(),
          file_size: bytes.len() as i64,
          tombstoned: false,
          created_at: now,
          updated_at: now,
        });
        facts.file_baselines.push(GitSyncFileBaseline {
          id: Uuid::new_v4(),
          profile_id: profile.id,
          blob_key,
          content_hash: content_hash.clone(),
          commit_oid: None,
          synced_at: now,
        });
      }
      FileReconcileAction::PushToGit {
        repo_path,
        blob_key,
        content_hash,
      } => {
        let mut binding = (**file_bindings_by_path
          .get(repo_path.as_str())
          .ok_or_else(|| format!("missing prepared file binding for {repo_path}"))?)
        .clone();
        binding.content_hash = content_hash.clone();
        binding.updated_at = now;
        binding.tombstoned = false;
        facts.file_bindings.push(binding);
        facts.file_baselines.push(GitSyncFileBaseline {
          id: Uuid::new_v4(),
          profile_id: profile.id,
          blob_key: blob_key.clone(),
          content_hash: content_hash.clone(),
          commit_oid: None,
          synced_at: now,
        });
      }
      FileReconcileAction::DeleteFromGit { repo_path, blob_key }
      | FileReconcileAction::DeleteFromMyoxus { repo_path, blob_key } => {
        facts.file_tombstone_paths.push(repo_path.clone());
        facts.file_baseline_deletes.push(blob_key.clone());
      }
      FileReconcileAction::Conflict {
        repo_path,
        git_hash,
        myoxus_hash,
        baseline_hash,
      } => {
        let binding = file_bindings_by_path.get(repo_path.as_str()).copied();
        facts.file_conflicts.push(GitSyncFileConflict {
          id: Uuid::new_v4(),
          profile_id: profile.id,
          run_id,
          binding_id: binding.map(|value| value.id),
          blob_key: binding
            .map(|value| value.blob_key.clone())
            .or_else(|| Some(blob_key_for_repo_path(profile.id, repo_path))),
          repo_path: repo_path.clone(),
          conflict_type: ConflictType::BothModified,
          resolution: ConflictResolution::Open,
          git_hash: Some(git_hash.clone()),
          myoxus_hash: Some(myoxus_hash.clone()),
          baseline_hash: Some(baseline_hash.clone()),
          created_at: now,
          resolved_at: None,
          resolved_by: None,
        });
      }
      FileReconcileAction::NoChange { .. } => {}
    }
  }

  // Content-addressed blobs may be shared by multiple repository paths.
  // Persist one baseline fact per (profile, blob key), while rejecting an
  // impossible hash disagreement before the remote can move.
  let mut baseline_hashes = HashMap::new();
  let mut normalized_baselines = Vec::with_capacity(facts.file_baselines.len());
  for baseline in facts.file_baselines.drain(..) {
    match baseline_hashes.get(&baseline.blob_key) {
      Some(existing_hash) if existing_hash == &baseline.content_hash => {}
      Some(_) => {
        return Err(format!(
          "file baseline {} has conflicting hashes for shared blob key {}",
          baseline.id, baseline.blob_key
        ));
      }
      None => {
        baseline_hashes.insert(baseline.blob_key.clone(), baseline.content_hash.clone());
        normalized_baselines.push(baseline);
      }
    }
  }
  facts.file_baselines = normalized_baselines;

  facts.version_links = build_version_links(
    profile.id,
    run_id,
    None,
    actions,
    myoxus_docs,
    existing_bindings,
    written_paths,
    file_actions,
  )?;
  Ok(facts)
}

#[allow(clippy::too_many_arguments)]
pub fn build_version_links(
  profile_id: Uuid,
  run_id: Uuid,
  commit_oid: Option<&str>,
  doc_actions: &[SyncAction],
  myoxus_docs: &[MyoxusDocState],
  existing_bindings: &[GitSyncBinding],
  written_paths: &HashMap<Uuid, String>,
  file_actions: &[FileReconcileAction],
) -> Result<Vec<GitSyncVersionLink>, String> {
  let doc_map: HashMap<Uuid, &MyoxusDocState> = myoxus_docs.iter().map(|d| (d.doc_id, d)).collect();
  let binding_paths: HashMap<Uuid, &str> = existing_bindings
    .iter()
    .map(|binding| (binding.id, binding.repo_path.as_str()))
    .collect();

  let mut links: Vec<GitSyncVersionLink> = Vec::new();
  let now = chrono::Utc::now();

  // ── Doc links ──────────────────────────────────────────────────────────
  for action in doc_actions {
    let direction = match action.action {
      ReconcileAction::PushToGit | ReconcileAction::CreateInGit => "push",
      ReconcileAction::PullToMyoxus | ReconcileAction::CreateInMyoxus => "pull",
      _ => continue, // NoChange, Delete*, Conflict — no version link
    };

    // For push: only create link if the doc was actually written to git.
    if matches!(action.action, ReconcileAction::PushToGit | ReconcileAction::CreateInGit)
      && !written_paths.contains_key(&action.doc_id)
    {
      trace!(doc_id = %action.doc_id, "skipping version link — doc not written to git");
      continue;
    }

    let repo_path = written_paths
      .get(&action.doc_id)
      .cloned()
      .or_else(|| action.repo_path.clone())
      .or_else(|| binding_paths.get(&action.binding_id).map(|path| (*path).to_string()))
      .filter(|path| !path.trim().is_empty())
      .ok_or_else(|| format!("version link for document {} has no repository path", action.doc_id))?;

    let content_hash = doc_map.get(&action.doc_id).and_then(|d| d.content_hash.clone());

    links.push(GitSyncVersionLink {
      id: Uuid::new_v4(),
      profile_id,
      run_id,
      sync_object_kind: "doc".to_string(),
      sync_object_id: action.doc_id.to_string(),
      direction: direction.to_string(),
      git_commit_oid: commit_oid.map(|s| s.to_string()),
      myoxus_history_id: None,
      repo_path,
      content_hash,
      created_at: now,
    });
  }

  // ── File links ─────────────────────────────────────────────────────────
  for action in file_actions {
    match action {
      FileReconcileAction::PullToMyoxus {
        repo_path,
        content_hash,
        ..
      } => {
        links.push(GitSyncVersionLink {
          id: Uuid::new_v4(),
          profile_id,
          run_id,
          sync_object_kind: "file".to_string(),
          sync_object_id: repo_path.clone(),
          direction: "pull".to_string(),
          git_commit_oid: commit_oid.map(|s| s.to_string()),
          myoxus_history_id: None,
          repo_path: repo_path.clone(),
          content_hash: Some(content_hash.clone()),
          created_at: now,
        });
      }
      FileReconcileAction::PushToGit {
        repo_path,
        blob_key,
        content_hash,
      } => {
        links.push(GitSyncVersionLink {
          id: Uuid::new_v4(),
          profile_id,
          run_id,
          sync_object_kind: "file".to_string(),
          sync_object_id: blob_key.clone(),
          direction: "push".to_string(),
          git_commit_oid: commit_oid.map(|s| s.to_string()),
          myoxus_history_id: None,
          repo_path: repo_path.clone(),
          content_hash: Some(content_hash.clone()),
          created_at: now,
        });
      }
      // Delete, Conflict, NoChange — no version link needed.
      _ => {}
    }
  }

  Ok(links)
}

/// Finalize the run record: set status to Completed or Failed, record counts and commit OID.
#[instrument(skip_all)]
#[allow(clippy::too_many_arguments)]
pub async fn finalize_run(
  store: &SqlxGitSyncStore,
  run: &mut GitSyncRun,
  docs_created: i32,
  docs_updated: i32,
  docs_deleted: i32,
  conflicts_found: i32,
  commit_oid: Option<String>,
  error: Option<(String, myoxus_domain::git_sync::ErrorClass)>,
) -> Result<(), super::error::SyncError> {
  run.docs_created = docs_created;
  run.docs_updated = docs_updated;
  run.docs_deleted = docs_deleted;
  run.conflicts_found = conflicts_found;

  if let Some((msg, class)) = error {
    run.fail(msg, class).map_err(|error| {
      super::error::SyncError::permanent(format!("fail run domain state: {error}"), run.profile_id, "finalize")
    })?;
  } else {
    run.complete(commit_oid).map_err(|error| {
      super::error::SyncError::permanent(
        format!("complete run domain state: {error}"),
        run.profile_id,
        "finalize",
      )
    })?;
  }

  store.update_run(run).await.map_err(|error| {
    super::error::SyncError::permanent(
      format!("persist terminal Git-Sync run state: {error}"),
      run.profile_id,
      "finalize",
    )
  })?;
  info!(
    run_id = %run.id,
    status = %run.status,
    created = docs_created,
    updated = docs_updated,
    deleted = docs_deleted,
    conflicts = conflicts_found,
    "sync run finalized"
  );
  Ok(())
}
