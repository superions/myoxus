// SPDX-License-Identifier: AGPL-3.0-or-later
//! Semantic Git-Sync conflict resolution.
//!
//! Resolving a conflict must change the next sync decision, not only the
//! `git_sync_conflicts.resolution` marker. This module owns the server-side
//! side effects so GraphQL/Admin clients cannot accidentally implement product
//! logic locally.

use async_graphql::Error;
use bytes::Bytes;
use sha2::{Digest, Sha256};
use tracing::{info, instrument};
use uuid::Uuid;

use myoxus_application::git_sync::backend::GitRepositoryPort;
use myoxus_application::git_sync::export;
use myoxus_application::git_sync::file_reconcile::blob_key_for_repo_path;
use myoxus_application::markdown::{content_hash, prepare_markdown_import, yjs_to_markdown};
use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest};
use myoxus_domain::git_sync::{
  ConflictResolution, GitSyncConflict, GitSyncFileBaseline, GitSyncFileBinding, GitSyncFileConflict, GitSyncProfile,
};
use myoxus_infrastructure::git_sync::{Git2Adapter, SqlxGitSyncStore};

use crate::config::AppConfig;

use super::{credential, repo};

/// Apply a document conflict resolution and persist the resolved marker.
///
/// The baseline update is intentionally asymmetric:
/// - `GitWins` writes Git content into Myoxus, records its exact Git-source
///   hash in the binding, and baselines the normalized Myoxus projection.
/// - `ManualMerge` writes merged content into Myoxus but baselines to the
///   previous Myoxus projection while recording the current Git-source hash,
///   so the next run pushes the merge result to Git.
/// - `MyoxusWins` keeps Myoxus content and applies the same comparison state,
///   so the next run pushes Myoxus to Git.
/// - `Dismissed` only marks the conflict; it deliberately does not hide the
///   underlying divergence from a later sync run.
#[instrument(skip(store, conflict, profile, merged_content), fields(conflict_id = %conflict.id, resolution = %resolution))]
pub async fn resolve_document_conflict(
  store: &SqlxGitSyncStore,
  conflict: &GitSyncConflict,
  profile: &GitSyncProfile,
  resolution: ConflictResolution,
  merged_content: Option<String>,
  resolved_by: Uuid,
) -> Result<(), Error> {
  if conflict.resolution != ConflictResolution::Open
    || !store
      .conflict_is_open(conflict.id, false)
      .await
      .map_err(|_| Error::new("conflict state is unavailable"))?
  {
    return Err(Error::new("conflict is already resolved"));
  }

  match resolution {
    ConflictResolution::Open => Err(Error::new("Open is not a valid resolution target")),
    ConflictResolution::GitWins => {
      let git_markdown = conflict
        .git_content
        .as_deref()
        .ok_or_else(|| Error::new("git content is required for GitWins resolution"))?;
      let chosen = normalize_markdown_for_snapshot(conflict, git_markdown)?;
      let normalized_hash = upsert_doc_snapshot_from_markdown(
        store,
        profile,
        conflict.doc_id,
        &chosen.title,
        &chosen.body,
        resolved_by,
      )
      .await?;
      update_binding_after_resolution(
        store,
        conflict,
        chosen.hash_for_baseline.as_deref(),
        Some(&normalized_hash),
      )
      .await?;
      store
        .resolve_conflict(conflict.id, resolution, resolved_by)
        .await
        .map_err(|e| Error::new(format!("failed to mark conflict resolved: {e}")))?;
      info!(doc_id = %conflict.doc_id, "git-sync conflict resolved with Git content");
      Ok(())
    }
    ConflictResolution::ManualMerge => {
      let merged = merged_content
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| Error::new("mergedContent is required for ManualMerge resolution"))?;
      let chosen = normalize_markdown_for_snapshot(conflict, merged)?;
      let git_hash = conflict
        .git_content
        .as_deref()
        .map(|content| content_hash(&export::split_markdown_file(content).1));
      upsert_doc_snapshot_from_markdown(
        store,
        profile,
        conflict.doc_id,
        &chosen.title,
        &chosen.body,
        resolved_by,
      )
      .await?;
      update_binding_after_resolution(store, conflict, git_hash.as_deref(), None).await?;
      store
        .resolve_conflict(conflict.id, resolution, resolved_by)
        .await
        .map_err(|e| Error::new(format!("failed to mark conflict resolved: {e}")))?;
      info!(doc_id = %conflict.doc_id, "git-sync conflict resolved with manual merge");
      Ok(())
    }
    ConflictResolution::MyoxusWins => {
      let _myoxus_content = conflict
        .myoxus_content
        .as_deref()
        .ok_or_else(|| Error::new("myoxus content is required for MyoxusWins resolution"))?;
      let git_hash = conflict
        .git_content
        .as_deref()
        .map(|content| content_hash(&export::split_markdown_file(content).1));
      update_binding_after_resolution(store, conflict, git_hash.as_deref(), None).await?;
      store
        .resolve_conflict(conflict.id, resolution, resolved_by)
        .await
        .map_err(|e| Error::new(format!("failed to mark conflict resolved: {e}")))?;
      info!(doc_id = %conflict.doc_id, "git-sync conflict resolved with Myoxus content");
      Ok(())
    }
    ConflictResolution::Dismissed => {
      store
        .resolve_conflict(conflict.id, resolution, resolved_by)
        .await
        .map_err(|e| Error::new(format!("failed to mark conflict dismissed: {e}")))?;
      info!(doc_id = %conflict.doc_id, "git-sync conflict dismissed without side effects");
      Ok(())
    }
  }
}

struct SnapshotMarkdown {
  title: String,
  body: String,
  hash_for_baseline: Option<String>,
}

fn normalize_markdown_for_snapshot(conflict: &GitSyncConflict, content: &str) -> Result<SnapshotMarkdown, Error> {
  let (_, body) = export::split_markdown_file(content);
  let title = myoxus_application::git_sync::import::parse_imported_file(&conflict.repo_path, content)
    .ok()
    .map(|parsed| parsed.title)
    .filter(|title| !title.trim().is_empty())
    .or_else(|| select_markdown_heading(&body))
    .unwrap_or_else(|| "Git Sync Conflict Resolution".to_string());
  Ok(SnapshotMarkdown {
    hash_for_baseline: Some(content_hash(&body)),
    title,
    body,
  })
}

fn select_markdown_heading(markdown: &str) -> Option<String> {
  markdown.lines().find_map(|line| {
    let trimmed = line.trim();
    trimmed
      .strip_prefix("# ")
      .map(str::trim)
      .filter(|title| !title.is_empty())
      .map(ToOwned::to_owned)
  })
}

async fn upsert_doc_snapshot_from_markdown(
  store: &SqlxGitSyncStore,
  profile: &GitSyncProfile,
  doc_id: Uuid,
  title: &str,
  markdown: &str,
  actor_id: Uuid,
) -> Result<String, Error> {
  let title = title.to_string();
  let conversion_title = title.clone();
  let markdown = markdown.to_string();
  let (yjs_binary, normalized_hash) = tokio::task::spawn_blocking(move || {
    let prepared = prepare_markdown_import(&conversion_title, &markdown)
      .map_err(|error| format!("failed to convert markdown to Yjs snapshot: {error}"))?;
    let normalized = yjs_to_markdown(&prepared.yjs_binary)
      .map_err(|error| format!("failed to project resolved Yjs snapshot: {error}"))?
      .ok_or_else(|| "resolved Yjs snapshot has no page".to_string())?;
    Ok::<_, String>((prepared.yjs_binary, content_hash(&normalized.markdown)))
  })
  .await
  .map_err(|error| Error::new(format!("resolved Markdown conversion task failed: {error}")))?
  .map_err(Error::new)?;
  store
    .apply_resolved_document_snapshot(profile.workspace_id, doc_id, &title, actor_id, &yjs_binary)
    .await
    .map_err(|error| match error {
      myoxus_infrastructure::git_sync::GitSyncStoreError::NotFound => {
        Error::new("document for conflict no longer exists in this workspace")
      }
      other => Error::new(format!("failed to persist resolved document snapshot: {other}")),
    })?;
  Ok(normalized_hash)
}

/// Apply a file conflict resolution and persist the resolved marker.
///
/// File conflicts do not expose text bodies and cannot be manually merged.
/// `GitWins` materializes the Git bytes into the Myoxus blob store immediately.
/// `MyoxusWins` keeps the blob as-is and advances the file baseline to the
/// current Git hash, so the next normal runner pass deterministically pushes the
/// Myoxus blob to Git. `Dismissed` intentionally has no side effect.
#[instrument(skip(store, conflict, profile, blob_storage, config, policy), fields(conflict_id = %conflict.id, resolution = %resolution))]
#[expect(
  clippy::too_many_arguments,
  reason = "conflict resolution keeps repository, transport, profile, and policy boundaries explicit"
)]
pub async fn resolve_file_conflict(
  store: &SqlxGitSyncStore,
  conflict: &GitSyncFileConflict,
  profile: &GitSyncProfile,
  resolution: ConflictResolution,
  resolved_by: Uuid,
  blob_storage: &dyn BlobStoragePort,
  config: &AppConfig,
  policy: &super::policy::EffectiveGitSyncPolicy,
) -> Result<(), Error> {
  let mut git_repo = None;
  if !store
    .conflict_is_open(conflict.id, true)
    .await
    .map_err(|_| Error::new("file conflict state is unavailable"))?
  {
    return Err(Error::new("file conflict is already resolved"));
  }
  let mut commit_oid = None;
  if resolution == ConflictResolution::GitWins {
    let prepared = prepare_git_repo_for_file_resolution(store, profile, config, policy).await?;
    commit_oid = prepared.head_oid().await.ok();
    git_repo = Some(prepared);
  }

  let repo_ref = git_repo.as_ref().map(|repo| repo as &dyn GitRepositoryPort);
  resolve_file_conflict_with_prepared_git_repo(
    store,
    conflict,
    profile,
    resolution,
    resolved_by,
    blob_storage,
    repo_ref,
    commit_oid.as_deref(),
  )
  .await
}

/// Testable core for file conflict resolution.
///
/// Production uses [`resolve_file_conflict`], which prepares the mirror and
/// supplies a real Git backend for `GitWins`. Tests inject a small fake Git
/// backend here to prove byte materialization without network or credentials.
#[instrument(skip(store, conflict, profile, blob_storage, git_repo), fields(conflict_id = %conflict.id, resolution = %resolution))]
#[allow(clippy::too_many_arguments)]
pub async fn resolve_file_conflict_with_prepared_git_repo(
  store: &SqlxGitSyncStore,
  conflict: &GitSyncFileConflict,
  profile: &GitSyncProfile,
  resolution: ConflictResolution,
  resolved_by: Uuid,
  blob_storage: &dyn BlobStoragePort,
  git_repo: Option<&dyn GitRepositoryPort>,
  commit_oid: Option<&str>,
) -> Result<(), Error> {
  if conflict.resolution != ConflictResolution::Open
    || !store
      .conflict_is_open(conflict.id, true)
      .await
      .map_err(|_| Error::new("file conflict state is unavailable"))?
  {
    return Err(Error::new("file conflict is already resolved"));
  }

  match resolution {
    ConflictResolution::Open => Err(Error::new("Open is not a valid file resolution target")),
    ConflictResolution::ManualMerge => Err(Error::new("ManualMerge is not valid for file conflicts")),
    ConflictResolution::Dismissed => {
      store
        .resolve_file_conflict(conflict.id, resolution, resolved_by)
        .await
        .map_err(|e| Error::new(format!("failed to mark file conflict dismissed: {e}")))?;
      info!(repo_path = %conflict.repo_path, "git-sync file conflict dismissed without side effects");
      Ok(())
    }
    ConflictResolution::MyoxusWins => {
      let mut binding = require_file_binding(store, conflict).await?;
      let myoxus_hash = conflict
        .myoxus_hash
        .as_deref()
        .filter(|hash| !hash.is_empty())
        .ok_or_else(|| Error::new("myoxus hash is required for MyoxusWins file resolution"))?;
      let git_hash = conflict
        .git_hash
        .as_deref()
        .filter(|hash| !hash.is_empty())
        .ok_or_else(|| Error::new("git hash is required for MyoxusWins file resolution"))?;

      binding.content_hash = myoxus_hash.to_string();
      binding.tombstoned = false;
      store
        .upsert_file_binding(&binding)
        .await
        .map_err(|e| Error::new(format!("failed to update file binding: {e}")))?;
      upsert_file_resolution_baseline(store, profile.id, &binding.blob_key, git_hash, commit_oid).await?;
      store
        .resolve_file_conflict(conflict.id, resolution, resolved_by)
        .await
        .map_err(|e| Error::new(format!("failed to mark file conflict resolved: {e}")))?;
      info!(repo_path = %conflict.repo_path, blob_key = %binding.blob_key, "git-sync file conflict resolved with Myoxus blob");
      Ok(())
    }
    ConflictResolution::GitWins => {
      let git_repo =
        git_repo.ok_or_else(|| Error::new("prepared git repository is required for GitWins file resolution"))?;
      let bytes = git_repo
        .read_file(&conflict.repo_path)
        .await
        .map_err(|e| Error::new(format!("failed to read Git file for resolution: {e}")))?;
      let content_hash = conflict
        .git_hash
        .clone()
        .filter(|hash| !hash.is_empty())
        .unwrap_or_else(|| sha256_hex(&bytes));
      let existing_binding = load_file_binding_for_conflict(store, conflict).await?;
      let blob_key = conflict
        .blob_key
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| existing_binding.as_ref().map(|binding| binding.blob_key.clone()))
        .unwrap_or_else(|| blob_key_for_repo_path(profile.id, &conflict.repo_path));
      let mime_type = existing_binding
        .as_ref()
        .map(|binding| binding.mime_type.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
          myoxus_application::mime_policy::detect_mime(&bytes, &conflict.repo_path, "application/octet-stream")
            .effective_mime
        });

      blob_storage
        .write_blob(BlobWriteRequest {
          key: blob_key.clone(),
          content_type: Some(mime_type.clone()),
          body: Bytes::copy_from_slice(&bytes),
        })
        .await
        .map_err(|e| Error::new(format!("failed to write resolved Git file into blob storage: {e}")))?;

      let binding = existing_binding
        .map(|mut binding| {
          binding.blob_key = blob_key.clone();
          binding.content_hash = content_hash.clone();
          binding.mime_type = mime_type.clone();
          binding.file_size = bytes.len() as i64;
          binding.tombstoned = false;
          binding
        })
        .unwrap_or_else(|| GitSyncFileBinding {
          id: Uuid::new_v4(),
          profile_id: profile.id,
          workspace_id: profile.workspace_id,
          blob_key: blob_key.clone(),
          repo_path: conflict.repo_path.clone(),
          content_hash: content_hash.clone(),
          mime_type: mime_type.clone(),
          file_size: bytes.len() as i64,
          tombstoned: false,
          created_at: chrono::Utc::now(),
          updated_at: chrono::Utc::now(),
        });
      store
        .upsert_file_binding(&binding)
        .await
        .map_err(|e| Error::new(format!("failed to upsert resolved file binding: {e}")))?;
      upsert_file_resolution_baseline(store, profile.id, &blob_key, &content_hash, commit_oid).await?;
      store
        .resolve_file_conflict(conflict.id, resolution, resolved_by)
        .await
        .map_err(|e| Error::new(format!("failed to mark file conflict resolved: {e}")))?;
      info!(repo_path = %conflict.repo_path, blob_key = %blob_key, "git-sync file conflict resolved with Git bytes");
      Ok(())
    }
  }
}

async fn prepare_git_repo_for_file_resolution(
  store: &SqlxGitSyncStore,
  profile: &GitSyncProfile,
  config: &AppConfig,
  effective_policy: &super::policy::EffectiveGitSyncPolicy,
) -> Result<Git2Adapter, Error> {
  let credential_id = profile
    .credential_id
    .ok_or_else(|| Error::new("git sync profile has no credential configured"))?;
  let encrypted = store
    .get_credential_encrypted_data(credential_id)
    .await
    .map_err(|e| Error::new(format!("failed to load git sync credential: {e}")))?;
  let cred_json =
    credential::decrypt(&config.crypto.private_key, &encrypted).map_err(|e| Error::new(format!("{e}")))?;
  let auth =
    credential::build_auth(profile.id, profile.auth_method, &cred_json).map_err(|e| Error::new(format!("{e}")))?;

  let repo_base_dir = std::path::PathBuf::from(&config.git_sync.repo_base_dir);
  let effective_mirror_limit_mb = match profile.max_mirror_storage_mb {
    Some(limit) if limit >= 0 => limit as u64,
    Some(limit) => return Err(Error::new(format!("invalid max_mirror_storage_mb override: {limit}"))),
    None => config.git_sync.max_mirror_storage_mb,
  };
  if let Err(msg) = myoxus_infrastructure::disk::preflight_check(
    &repo_base_dir,
    effective_mirror_limit_mb,
    config.git_sync.min_free_disk_mb,
  )
  .await
  {
    return Err(Error::new(msg));
  }

  let ssh_host_key_policy = effective_policy.ssh_host_key_policy;
  let https_certificate_policy = effective_policy.https_certificate_policy;
  let allowed_hosts = effective_policy.allowed_hosts.iter().cloned().collect::<Vec<_>>();
  let git_repo = Git2Adapter::with_config(
    config.git_sync.network_timeout_secs,
    config.git_sync.local_timeout_secs,
    config.git_sync.clone_depth,
  )
  .with_ssh_host_key_policy(store.pool(), ssh_host_key_policy, "conflict_resolution", None)
  .with_https_certificate_policy(https_certificate_policy, allowed_hosts);
  repo::prepare(&git_repo, profile, &auth, &repo_base_dir, None, &|_| Ok(()))
    .await
    .map_err(|e| Error::new(format!("{e}")))?;
  Ok(git_repo)
}

async fn require_file_binding(
  store: &SqlxGitSyncStore,
  conflict: &GitSyncFileConflict,
) -> Result<GitSyncFileBinding, Error> {
  load_file_binding_for_conflict(store, conflict)
    .await?
    .ok_or_else(|| Error::new("myoxus file binding is required for this file resolution"))
}

async fn load_file_binding_for_conflict(
  store: &SqlxGitSyncStore,
  conflict: &GitSyncFileConflict,
) -> Result<Option<GitSyncFileBinding>, Error> {
  if let Some(binding_id) = conflict.binding_id {
    return store
      .get_file_binding(binding_id)
      .await
      .map(Some)
      .map_err(|e| Error::new(format!("failed to load file binding: {e}")));
  }
  store
    .get_file_binding_by_profile_path(conflict.profile_id, &conflict.repo_path)
    .await
    .map_err(|e| Error::new(format!("failed to load file binding: {e}")))
}

async fn upsert_file_resolution_baseline(
  store: &SqlxGitSyncStore,
  profile_id: Uuid,
  blob_key: &str,
  content_hash: &str,
  commit_oid: Option<&str>,
) -> Result<(), Error> {
  store
    .upsert_file_baseline(&GitSyncFileBaseline {
      id: Uuid::new_v4(),
      profile_id,
      blob_key: blob_key.to_string(),
      content_hash: content_hash.to_string(),
      commit_oid: commit_oid.map(ToOwned::to_owned),
      synced_at: chrono::Utc::now(),
    })
    .await
    .map_err(|e| Error::new(format!("failed to update file baseline: {e}")))
}

fn sha256_hex(bytes: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  format!("{:x}", hasher.finalize())
}

async fn update_binding_after_resolution(
  store: &SqlxGitSyncStore,
  conflict: &GitSyncConflict,
  git_source_hash: Option<&str>,
  myoxus_baseline_hash: Option<&str>,
) -> Result<(), Error> {
  let Some(binding_id) = conflict.binding_id else {
    return Ok(());
  };
  let mut binding = store
    .get_binding(binding_id)
    .await
    .map_err(|e| Error::new(format!("failed to load conflict binding: {e}")))?;
  binding.content_hash = git_source_hash.map(ToOwned::to_owned);
  store
    .update_binding(&binding)
    .await
    .map_err(|e| Error::new(format!("failed to update conflict binding: {e}")))?;

  if let Some(hash) = myoxus_baseline_hash.filter(|value| !value.is_empty()) {
    store
      .upsert_baseline(&myoxus_domain::git_sync::GitSyncBaseline {
        binding_id,
        content_hash: hash.to_string(),
        commit_oid: binding.last_commit_oid.clone().unwrap_or_default(),
        myoxus_updated_at: chrono::Utc::now(),
        captured_at: chrono::Utc::now(),
      })
      .await
      .map_err(|e| Error::new(format!("failed to update conflict baseline: {e}")))?;
  }
  Ok(())
}
