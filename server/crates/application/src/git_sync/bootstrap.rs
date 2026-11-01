// SPDX-License-Identifier: AGPL-3.0-or-later
//! Deterministic outbound bootstrap planning for Git-Sync.
//!
//! This module has no transport or database access. It turns one authoritative
//! Myoxus snapshot plus one authenticated Git tree into the complete desired
//! tree and persistence facts consumed by the CLI recovery saga.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use myoxus_domain::git_sync::{
  GitSyncBaseline, GitSyncBinding, GitSyncFileBaseline, GitSyncFileBinding, GitSyncProfile,
};

use super::export::{
  ExportFrontmatter, GitSyncManifest, GitSyncManifestDocument, GitSyncManifestFolder, PathPlanDocument,
  compose_markdown_file, paths_by_document, plan_document_paths,
};

#[derive(Debug, Clone)]
pub struct BootstrapDocument {
  pub doc_id: Uuid,
  pub title: String,
  pub markdown: String,
  pub content_hash: String,
  pub updated_at: DateTime<Utc>,
  pub folder_names: Vec<String>,
  pub organizer_folder_ids: Vec<String>,
  pub organizer_entry_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BootstrapFile {
  pub binding: GitSyncFileBinding,
  pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapReport {
  pub profile_id: Uuid,
  pub workspace_id: Uuid,
  pub expected_remote_oid: String,
  pub desired_tree_fingerprint: String,
  pub documents: usize,
  pub files: usize,
  pub writes: Vec<String>,
  pub deletes: Vec<String>,
  pub unchanged: Vec<String>,
  pub tombstoned_document_bindings: usize,
  pub tombstoned_file_bindings: usize,
  pub no_op: bool,
}

#[derive(Debug, Clone)]
pub struct BootstrapPlan {
  pub report: BootstrapReport,
  pub desired_files: BTreeMap<String, Vec<u8>>,
  pub deletes: Vec<String>,
  pub document_bindings: Vec<GitSyncBinding>,
  pub document_baselines: Vec<GitSyncBaseline>,
  pub tombstone_document_binding_ids: Vec<Uuid>,
  pub file_bindings: Vec<GitSyncFileBinding>,
  pub file_baselines: Vec<GitSyncFileBaseline>,
  pub tombstone_file_binding_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BootstrapAttemptPhase {
  Prepared,
  RemoteApplied,
  Completed,
  Failed,
}

impl BootstrapAttemptPhase {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Prepared => "Prepared",
      Self::RemoteApplied => "RemoteApplied",
      Self::Completed => "Completed",
      Self::Failed => "Failed",
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapAttempt {
  pub id: Uuid,
  pub profile_id: Uuid,
  pub phase: BootstrapAttemptPhase,
  pub expected_remote_oid: String,
  pub observed_remote_oid: Option<String>,
  pub desired_tree_fingerprint: String,
  pub report: BootstrapReport,
  pub error_class: Option<String>,
  pub error_message: Option<String>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapResumeAction {
  Push,
  AdoptObservedRemote,
  FinalizeSql,
  AlreadyCompleted,
  FailedTerminal,
  Diverged,
}

/// Classify one resume without performing a remote mutation.
///
/// `remote_tree_matches` means a fresh authenticated clone exactly matches the
/// persisted desired-tree fingerprint. It is the only evidence that may turn a
/// moved OID into SQL-only recovery.
pub fn classify_bootstrap_resume(
  attempt: &BootstrapAttempt,
  observed_remote_oid: &str,
  remote_tree_matches: bool,
) -> BootstrapResumeAction {
  match attempt.phase {
    BootstrapAttemptPhase::Completed => BootstrapResumeAction::AlreadyCompleted,
    BootstrapAttemptPhase::Failed => BootstrapResumeAction::FailedTerminal,
    BootstrapAttemptPhase::RemoteApplied if attempt.observed_remote_oid.as_deref() == Some(observed_remote_oid) => {
      BootstrapResumeAction::FinalizeSql
    }
    BootstrapAttemptPhase::RemoteApplied => BootstrapResumeAction::Diverged,
    BootstrapAttemptPhase::Prepared if observed_remote_oid == attempt.expected_remote_oid => {
      BootstrapResumeAction::Push
    }
    BootstrapAttemptPhase::Prepared if remote_tree_matches => BootstrapResumeAction::AdoptObservedRemote,
    BootstrapAttemptPhase::Prepared => BootstrapResumeAction::Diverged,
  }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BootstrapPlanError {
  #[error("profile {0} must be disabled before bootstrap")]
  ProfileEnabled(Uuid),
  #[error("document {0} appears more than once in the authoritative snapshot")]
  DuplicateDocument(Uuid),
  #[error("document {0} has more than one active binding")]
  AmbiguousDocumentBinding(Uuid),
  #[error("file path `{0}` is owned by more than one active binding")]
  AmbiguousFilePath(String),
  #[error("bound blob `{blob_key}` does not match persisted hash `{expected}` (observed `{observed}`)")]
  BlobHashMismatch {
    blob_key: String,
    expected: String,
    observed: String,
  },
  #[error("active file binding {0} has no supplied blob content")]
  MissingBoundBlob(Uuid),
  #[error("unexpected Git-Sync control content must be removed explicitly: {0:?}")]
  UnexpectedControlContent(Vec<String>),
  #[error("unknown non-Markdown content below the managed root must be classified explicitly: {0:?}")]
  UnknownManagedContent(Vec<String>),
  #[error("path planning failed: {0}")]
  PathPlanning(String),
  #[error("manifest serialization failed: {0}")]
  Manifest(String),
}

/// Plan from the complete remote capture. The supplied writer scope removes
/// delegated paths from ownership classification but still reserves their
/// namespaces so neither deletion nor new output can enter a child subtree.
#[allow(clippy::too_many_arguments)]
pub fn plan_bootstrap(
  profile: &GitSyncProfile,
  scope: &super::export::GitSyncWriterScope,
  expected_remote_oid: &str,
  documents: Vec<BootstrapDocument>,
  organizer_revision: String,
  organizer_folders: Vec<GitSyncManifestFolder>,
  current_document_bindings: Vec<GitSyncBinding>,
  current_file_bindings: Vec<GitSyncFileBinding>,
  files: Vec<BootstrapFile>,
  remote_files: BTreeMap<String, Vec<u8>>,
  now: DateTime<Utc>,
  // Runs inside the pure planner before comparison/fingerprinting. The caller
  // supplies the shared overview projection over this exact ordinary result.
  project_overviews: impl FnOnce(&mut GitSyncManifest, &mut BTreeMap<String, Vec<u8>>) -> Result<Vec<String>, String>,
) -> Result<BootstrapPlan, BootstrapPlanError> {
  if profile.enabled {
    return Err(BootstrapPlanError::ProfileEnabled(profile.id));
  }

  // Remote ownership is admitted before authoritative bootstrap can classify
  // deletes or reserve new ordinary destinations. A marker alone is insufficient.
  let previous = remote_files
    .get(&profile.manifest_path)
    .map(|bytes| {
      serde_json::from_slice::<GitSyncManifest>(bytes)
        .map_err(|error| BootstrapPlanError::Manifest(format!("invalid JSON at {}:{}", error.line(), error.column())))
    })
    .transpose()?
    .map(|manifest| {
      scope
        .owned_manifest(&manifest)
        .map_err(|error| BootstrapPlanError::Manifest(error.to_string()))
    })
    .transpose()?;
  let owned_remote_files = remote_files
    .iter()
    .filter_map(|(path, bytes)| match scope.excludes(path) {
      Ok(false) => Some(Ok((path.clone(), bytes.clone()))),
      Ok(true) => None,
      Err(error) => Some(Err(BootstrapPlanError::Manifest(error.to_string()))),
    })
    .collect::<Result<BTreeMap<_, _>, _>>()?;
  super::overview::classify_git_overview_paths(
    profile.workspace_id,
    previous.as_ref(),
    current_document_bindings
      .iter()
      .map(|binding| binding.repo_path.as_str())
      .chain(
        current_file_bindings
          .iter()
          .filter(|binding| !binding.tombstoned)
          .map(|binding| binding.repo_path.as_str()),
      ),
    owned_remote_files
      .iter()
      .map(|(path, bytes)| (path.as_str(), bytes.as_slice())),
  )
  .map_err(BootstrapPlanError::Manifest)?;

  let mut document_ids = BTreeSet::new();
  for document in &documents {
    if !document_ids.insert(document.doc_id) {
      return Err(BootstrapPlanError::DuplicateDocument(document.doc_id));
    }
  }

  let mut bindings_by_doc = HashMap::<Uuid, Vec<GitSyncBinding>>::new();
  for binding in current_document_bindings {
    if scope
      .excludes(&binding.repo_path)
      .map_err(|error| BootstrapPlanError::Manifest(error.to_string()))?
    {
      return Err(BootstrapPlanError::Manifest(
        "active document binding enters a delegated repository scope".into(),
      ));
    }
    bindings_by_doc.entry(binding.doc_id).or_default().push(binding);
  }
  if let Some((doc_id, _)) = bindings_by_doc.iter().find(|(_, bindings)| bindings.len() > 1) {
    return Err(BootstrapPlanError::AmbiguousDocumentBinding(*doc_id));
  }

  let mut active_files_by_path = HashMap::new();
  for binding in current_file_bindings {
    if !binding.tombstoned
      && scope
        .excludes(&binding.repo_path)
        .map_err(|error| BootstrapPlanError::Manifest(error.to_string()))?
    {
      return Err(BootstrapPlanError::Manifest(
        "active file binding enters a delegated repository scope".into(),
      ));
    }
    let repo_path = binding.repo_path.clone();
    if active_files_by_path.insert(repo_path.clone(), binding).is_some() {
      return Err(BootstrapPlanError::AmbiguousFilePath(repo_path));
    }
  }
  let supplied_files = files
    .into_iter()
    .map(|file| (file.binding.id, file))
    .collect::<HashMap<_, _>>();

  let mut occupied = BTreeMap::new();
  for fence in scope.exclusions() {
    occupied.insert(
      fence.repo_path.as_str().to_string(),
      "delegated repository scope".into(),
    );
  }
  for binding in active_files_by_path.values() {
    occupied.insert(binding.repo_path.clone(), format!("file binding {}", binding.id));
  }
  super::overview::occupy_git_export_files(
    profile.workspace_id,
    &document_ids,
    &mut occupied,
    &owned_remote_files,
    previous.as_ref(),
  )
  .map_err(BootstrapPlanError::Manifest)?;
  let path_inputs = documents
    .iter()
    .map(|document| PathPlanDocument {
      doc_id: document.doc_id,
      title: document.title.clone(),
      folder_names: document.folder_names.clone(),
      existing_repo_path: bindings_by_doc
        .get(&document.doc_id)
        .and_then(|bindings| bindings.first())
        .map(|binding| binding.repo_path.clone()),
    })
    .collect::<Vec<_>>();
  let planned_paths = plan_document_paths(&profile.root_path, &path_inputs, &occupied)
    .map_err(|error| BootstrapPlanError::PathPlanning(error.to_string()))?;
  for entry in &planned_paths {
    if scope
      .excludes(entry.repo_path.as_str())
      .map_err(|error| BootstrapPlanError::Manifest(error.to_string()))?
    {
      return Err(BootstrapPlanError::Manifest(
        "bootstrap document enters a delegated repository scope".into(),
      ));
    }
  }
  let paths = paths_by_document(&planned_paths);

  let mut desired_files = BTreeMap::new();
  let mut desired_bindings = Vec::with_capacity(documents.len());
  let mut desired_baselines = Vec::with_capacity(documents.len());
  let mut manifest_documents = Vec::with_capacity(documents.len());
  for document in &documents {
    let repo_path = paths
      .get(&document.doc_id)
      .expect("path planner returns one path per document")
      .clone();
    let existing = bindings_by_doc
      .remove(&document.doc_id)
      .and_then(|mut values| values.pop());
    let binding_id = existing.as_ref().map_or_else(
      || Uuid::new_v5(&profile.id, format!("bootstrap-binding:{}", document.doc_id).as_bytes()),
      |binding| binding.id,
    );
    let sync_id = existing.as_ref().map_or_else(
      || {
        Uuid::new_v5(
          &profile.workspace_id,
          format!("git-sync-export:{}", document.doc_id).as_bytes(),
        )
      },
      |binding| binding.sync_id,
    );
    let created_at = existing.as_ref().map_or(now, |binding| binding.created_at);
    desired_files.insert(
      repo_path.clone(),
      compose_markdown_file(
        &ExportFrontmatter {
          sync_id,
          doc_id: document.doc_id,
          workspace_id: profile.workspace_id,
          title: document.title.clone(),
        },
        &document.markdown,
      )
      .into_bytes(),
    );
    desired_bindings.push(GitSyncBinding {
      id: binding_id,
      profile_id: profile.id,
      workspace_id: profile.workspace_id,
      doc_id: document.doc_id,
      sync_id,
      repo_path: repo_path.clone(),
      last_commit_oid: None,
      content_hash: Some(document.content_hash.clone()),
      structure_hash: None,
      tombstone: false,
      created_at,
      updated_at: now,
    });
    desired_baselines.push(GitSyncBaseline {
      binding_id,
      content_hash: document.content_hash.clone(),
      commit_oid: String::new(),
      myoxus_updated_at: document.updated_at,
      captured_at: now,
    });
    manifest_documents.push(GitSyncManifestDocument {
      doc_id: document.doc_id,
      organizer_entry_id: document.organizer_entry_id.clone(),
      organizer_folder_ids: document.organizer_folder_ids.clone(),
      repo_path,
      title: document.title.clone(),
      content_hash: document.content_hash.clone(),
    });
  }
  let tombstone_document_binding_ids = bindings_by_doc
    .into_values()
    .flatten()
    .map(|binding| binding.id)
    .collect::<Vec<_>>();

  let mut desired_file_bindings = Vec::with_capacity(active_files_by_path.len());
  let mut desired_file_baselines = Vec::with_capacity(active_files_by_path.len());
  let mut baseline_blob_keys = BTreeSet::new();
  for binding in active_files_by_path.values() {
    let file = supplied_files
      .get(&binding.id)
      .ok_or(BootstrapPlanError::MissingBoundBlob(binding.id))?;
    let observed = hex::encode(Sha256::digest(&file.bytes));
    if observed != binding.content_hash {
      return Err(BootstrapPlanError::BlobHashMismatch {
        blob_key: binding.blob_key.clone(),
        expected: binding.content_hash.clone(),
        observed,
      });
    }
    desired_files.insert(binding.repo_path.clone(), file.bytes.clone());
    let mut desired = binding.clone();
    desired.tombstoned = false;
    desired.updated_at = now;
    desired_file_bindings.push(desired);
    if baseline_blob_keys.insert(binding.blob_key.clone()) {
      desired_file_baselines.push(GitSyncFileBaseline {
        id: Uuid::new_v4(),
        profile_id: profile.id,
        blob_key: binding.blob_key.clone(),
        content_hash: binding.content_hash.clone(),
        commit_oid: None,
        synced_at: now,
      });
    }
  }

  let mut manifest = GitSyncManifest::new(
    profile.workspace_id,
    organizer_revision,
    organizer_folders,
    manifest_documents,
  );
  let retired = project_overviews(&mut manifest, &mut desired_files).map_err(BootstrapPlanError::Manifest)?;
  manifest
    .validate_overviews(
      profile.workspace_id,
      desired_file_bindings.iter().map(|file| file.repo_path.as_str()),
    )
    .map_err(BootstrapPlanError::Manifest)?;
  for output in manifest.overview_outputs() {
    let bytes = desired_files
      .get(&output.repo_path)
      .ok_or_else(|| BootstrapPlanError::Manifest("missing overview bytes".into()))?;
    super::overview::verify_git_overview_bytes(bytes, &output.content_hash).map_err(BootstrapPlanError::Manifest)?;
  }
  desired_files.insert(
    profile.manifest_path.clone(),
    manifest
      .to_json()
      .map_err(|error| BootstrapPlanError::Manifest(error.to_string()))?
      .into_bytes(),
  );
  for path in desired_files.keys() {
    if scope
      .excludes(path)
      .map_err(|error| BootstrapPlanError::Manifest(error.to_string()))?
    {
      return Err(BootstrapPlanError::Manifest(
        "bootstrap output enters a delegated repository scope".into(),
      ));
    }
  }

  let root = profile.root_path.trim().trim_matches('/');
  let below_root = |path: &str| root.is_empty() || path == root || path.starts_with(&format!("{root}/"));
  let desired_paths = desired_files.keys().map(String::as_str).collect::<BTreeSet<_>>();
  let mut unexpected_control = Vec::new();
  let mut unknown_managed = Vec::new();
  let mut deletes = retired
    .into_iter()
    .filter(|path| owned_remote_files.contains_key(path) && !desired_paths.contains(path.as_str()))
    .collect::<Vec<_>>();
  for path in remote_files.keys() {
    if scope
      .excludes(path)
      .map_err(|error| BootstrapPlanError::Manifest(error.to_string()))?
    {
      continue;
    }
    if super::export::is_git_sync_control_path(path) && path != &profile.manifest_path && below_root(path) {
      unexpected_control.push(path.clone());
    } else if below_root(path) && !desired_paths.contains(path.as_str()) {
      if deletes.contains(path) || path.to_ascii_lowercase().ends_with(".md") {
        if !deletes.contains(path) {
          deletes.push(path.clone());
        }
      } else {
        unknown_managed.push(path.clone());
      }
    }
  }
  if !unexpected_control.is_empty() {
    return Err(BootstrapPlanError::UnexpectedControlContent(unexpected_control));
  }
  if !unknown_managed.is_empty() {
    return Err(BootstrapPlanError::UnknownManagedContent(unknown_managed));
  }

  let writes = desired_files
    .iter()
    .filter(|(path, bytes)| remote_files.get(*path) != Some(*bytes))
    .map(|(path, _)| path.clone())
    .collect::<Vec<_>>();
  let unchanged = desired_files
    .iter()
    .filter(|(path, bytes)| remote_files.get(*path) == Some(*bytes))
    .map(|(path, _)| path.clone())
    .collect::<Vec<_>>();
  let fingerprint = desired_tree_fingerprint(&desired_files);
  let no_op = writes.is_empty() && deletes.is_empty();
  Ok(BootstrapPlan {
    report: BootstrapReport {
      profile_id: profile.id,
      workspace_id: profile.workspace_id,
      expected_remote_oid: expected_remote_oid.to_string(),
      desired_tree_fingerprint: fingerprint,
      documents: documents.len(),
      files: desired_file_bindings.len(),
      writes,
      deletes: deletes.clone(),
      unchanged,
      tombstoned_document_bindings: tombstone_document_binding_ids.len(),
      tombstoned_file_bindings: 0,
      no_op,
    },
    desired_files,
    deletes,
    document_bindings: desired_bindings,
    document_baselines: desired_baselines,
    tombstone_document_binding_ids,
    file_bindings: desired_file_bindings,
    file_baselines: desired_file_baselines,
    tombstone_file_binding_ids: Vec::new(),
  })
}

pub fn desired_tree_fingerprint(desired_files: &BTreeMap<String, Vec<u8>>) -> String {
  let mut hasher = Sha256::new();
  for (path, bytes) in desired_files {
    hasher.update((path.len() as u64).to_be_bytes());
    hasher.update(path.as_bytes());
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
  }
  hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_domain::git_sync::{AuthMethod, SyncDirection, TriggerMode};

  fn profile() -> GitSyncProfile {
    let now = Utc::now();
    GitSyncProfile {
      id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      owner_id: Uuid::new_v4(),
      repo_url: "https://example.invalid/repo.git".into(),
      branch: "main".into(),
      root_path: "content/".into(),
      manifest_path: crate::git_sync::export::GIT_SYNC_MANIFEST_PATH.into(),
      scope_revision: 0,
      sync_direction: SyncDirection::Bidirectional,
      trigger_mode: TriggerMode::Manual,
      polling_interval_secs: None,
      cron_expression: None,
      cron_timezone: None,
      cron_misfire_policy: None,
      cron_next_scheduled_at: None,
      cron_pending_misfire_scheduled_for: None,
      auth_method: AuthMethod::HttpsToken,
      credential_id: Some(Uuid::new_v4()),
      enabled: false,
      max_mirror_storage_mb: None,
      created_at: now,
      updated_at: now,
    }
  }

  #[test]
  fn empty_document_is_exported_and_git_only_markdown_is_deleted() {
    let profile = profile();
    let now = Utc::now();
    let unknown = plan_bootstrap(
      &profile,
      &super::super::export::GitSyncWriterScope::new(Vec::new()),
      "remote",
      vec![],
      "capture".into(),
      vec![],
      vec![],
      vec![],
      vec![],
      BTreeMap::from([(
        "content/copied.md".into(),
        crate::workspace_overview::markdown::GIT_OVERVIEW_MARKER
          .as_bytes()
          .to_vec(),
      )]),
      now,
      |_, _| Ok(Vec::new()),
    );
    assert!(
      matches!(unknown, Err(BootstrapPlanError::Manifest(_))),
      "bootstrap cannot silently delete or adopt an unknown derived page"
    );
    let doc_id = Uuid::new_v4();
    let plan = plan_bootstrap(
      &profile,
      &super::super::export::GitSyncWriterScope::new(Vec::new()),
      "a".repeat(40).as_str(),
      vec![BootstrapDocument {
        doc_id,
        title: "Empty".into(),
        markdown: String::new(),
        content_hash: hex::encode(Sha256::digest([])),
        updated_at: now,
        folder_names: vec![],
        organizer_folder_ids: vec![],
        organizer_entry_id: None,
      }],
      "revision".into(),
      vec![],
      vec![],
      vec![],
      vec![],
      BTreeMap::from([("content/stale.md".into(), b"stale".to_vec())]),
      now,
      |_, _| Ok(Vec::new()),
    )
    .unwrap();

    assert_eq!(plan.report.documents, 1);
    assert_eq!(plan.deletes, vec!["content/stale.md"]);
    assert!(plan.desired_files.get("content/empty.md").unwrap().ends_with(b"---\n"));
  }

  #[test]
  fn unknown_managed_binary_and_control_content_fail_closed() {
    let profile = profile();
    let base = || {
      plan_bootstrap(
        &profile,
        &super::super::export::GitSyncWriterScope::new(Vec::new()),
        "a",
        vec![],
        "revision".into(),
        vec![],
        vec![],
        vec![],
        vec![],
        BTreeMap::new(),
        Utc::now(),
        |_, _| Ok(Vec::new()),
      )
    };
    assert!(base().is_ok());
    let error = plan_bootstrap(
      &profile,
      &super::super::export::GitSyncWriterScope::new(Vec::new()),
      "a",
      vec![],
      "revision".into(),
      vec![],
      vec![],
      vec![],
      vec![],
      BTreeMap::from([("content/unknown.bin".into(), vec![1])]),
      Utc::now(),
      |_, _| Ok(Vec::new()),
    )
    .unwrap_err();
    assert!(matches!(error, BootstrapPlanError::UnknownManagedContent(_)));
  }

  #[test]
  fn resume_matrix_never_repeats_an_unclassified_remote_mutation() {
    let now = Utc::now();
    let report = BootstrapReport {
      profile_id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      expected_remote_oid: "expected".into(),
      desired_tree_fingerprint: "tree".into(),
      documents: 0,
      files: 0,
      writes: vec![],
      deletes: vec![],
      unchanged: vec![],
      tombstoned_document_bindings: 0,
      tombstoned_file_bindings: 0,
      no_op: true,
    };
    let attempt = |phase, observed_remote_oid| BootstrapAttempt {
      id: Uuid::new_v4(),
      profile_id: report.profile_id,
      phase,
      expected_remote_oid: "expected".into(),
      observed_remote_oid,
      desired_tree_fingerprint: "tree".into(),
      report: report.clone(),
      error_class: None,
      error_message: None,
      created_at: now,
      updated_at: now,
      completed_at: None,
    };

    assert_eq!(
      classify_bootstrap_resume(&attempt(BootstrapAttemptPhase::Prepared, None), "expected", false),
      BootstrapResumeAction::Push
    );
    assert_eq!(
      classify_bootstrap_resume(&attempt(BootstrapAttemptPhase::Prepared, None), "pushed", true),
      BootstrapResumeAction::AdoptObservedRemote
    );
    assert_eq!(
      classify_bootstrap_resume(&attempt(BootstrapAttemptPhase::Prepared, None), "foreign", false),
      BootstrapResumeAction::Diverged
    );
    assert_eq!(
      classify_bootstrap_resume(
        &attempt(BootstrapAttemptPhase::RemoteApplied, Some("pushed".into())),
        "pushed",
        true
      ),
      BootstrapResumeAction::FinalizeSql
    );
    assert_eq!(
      classify_bootstrap_resume(
        &attempt(BootstrapAttemptPhase::RemoteApplied, Some("pushed".into())),
        "foreign",
        true
      ),
      BootstrapResumeAction::Diverged
    );
    assert_eq!(
      classify_bootstrap_resume(
        &attempt(BootstrapAttemptPhase::Completed, Some("pushed".into())),
        "pushed",
        true
      ),
      BootstrapResumeAction::AlreadyCompleted
    );
    assert_eq!(
      classify_bootstrap_resume(&attempt(BootstrapAttemptPhase::Failed, None), "expected", false),
      BootstrapResumeAction::FailedTerminal
    );
  }
}
