// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only remote inspection and guarded repair of Git-Sync metadata.
//!
//! The remote branch and its manifest are facts. Reconciliation may repair
//! Myoxus persistence to those verified facts, but never writes to Git.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::git_sync::{
  GitSyncBaseline, GitSyncBinding, GitSyncFileBaseline, GitSyncFileBinding, GitSyncProfile, GitSyncRun,
  GitSyncVersionLink, ProfileId, RunStatus,
};
use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use thiserror::Error;
use tracing::{info, instrument};
use uuid::Uuid;

use super::export::{
  ExportFrontmatter, GIT_SYNC_MANIFEST_SCHEMA_VERSION, GitSyncManifest, GitSyncManifestDocument, PathPlanDocument,
  plan_document_paths, split_markdown_file,
};
use super::projection::structure_hash;
use super::{GitAuth, GitRepositoryPort};
use crate::markdown::content_hash;

#[derive(Debug, Clone)]
pub struct ReconciliationDocument {
  pub id: Uuid,
  pub title: String,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct GitSyncReconciliationInventory {
  pub profile: GitSyncProfile,
  pub scope: super::export::GitSyncWriterScope,
  pub documents: Vec<ReconciliationDocument>,
  pub bindings: Vec<GitSyncBinding>,
  pub tombstoned_bindings: Vec<GitSyncBinding>,
  pub baselines: Vec<GitSyncBaseline>,
  pub file_bindings: Vec<GitSyncFileBinding>,
  pub file_baselines: Vec<GitSyncFileBaseline>,
  pub runs: Vec<GitSyncRun>,
  pub version_links: Vec<GitSyncVersionLink>,
}

#[derive(Debug, Clone)]
pub struct GitSyncBindingAdoption {
  pub binding: GitSyncBinding,
  pub baseline: GitSyncBaseline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncReconciliationDocumentIdentity {
  pub doc_id: Uuid,
  pub sync_id: Uuid,
  pub repo_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncUnresolvedRemoteDocument {
  pub doc_id: Uuid,
  pub sync_id: Uuid,
  pub repo_path: String,
  pub reason: String,
}

#[derive(Debug, Clone)]
pub struct GitSyncReconciliationPlan {
  pub profile_id: ProfileId,
  pub profile_updated_at: DateTime<Utc>,
  pub expected_remote_oid: String,
  pub binding_adoptions: Vec<GitSyncBindingAdoption>,
  pub unresolved_remote_documents: Vec<GitSyncUnresolvedRemoteDocument>,
  pub binding_updates: Vec<GitSyncBinding>,
  pub baseline_upserts: Vec<GitSyncBaseline>,
  pub baseline_deletes: Vec<Uuid>,
  pub file_baseline_updates: Vec<GitSyncFileBaseline>,
  pub version_link_clear_commits: Vec<Uuid>,
  pub completed_reconciliation_runs: Vec<Uuid>,
  pub report: GitSyncReconciliationReport,
}

impl GitSyncReconciliationPlan {
  pub fn has_changes(&self) -> bool {
    !self.binding_adoptions.is_empty()
      || !self.unresolved_remote_documents.is_empty()
      || !self.binding_updates.is_empty()
      || !self.baseline_upserts.is_empty()
      || !self.baseline_deletes.is_empty()
      || !self.file_baseline_updates.is_empty()
      || !self.version_link_clear_commits.is_empty()
      || !self.completed_reconciliation_runs.is_empty()
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncReconciliationCounts {
  pub documents: usize,
  pub bindings: usize,
  pub baselines: usize,
  pub file_bindings: usize,
  pub file_baselines: usize,
  pub runs: usize,
  pub version_links: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncReconciliationReport {
  pub profile_id: ProfileId,
  pub workspace_id: Uuid,
  pub remote_oid: String,
  pub manifest_schema_version: u32,
  pub manifest_documents: usize,
  pub inventory: GitSyncReconciliationCounts,
  pub binding_updates: usize,
  pub baseline_upserts: usize,
  pub baseline_deletes: usize,
  pub file_baseline_commit_clears: usize,
  pub version_link_commit_clears: usize,
  pub completed_reconciliation_runs: usize,
  pub binding_adoptions: Vec<GitSyncReconciliationDocumentIdentity>,
  pub unresolved_remote_documents: Vec<GitSyncUnresolvedRemoteDocument>,
  pub changes_required: bool,
}

#[derive(Debug, Error)]
pub enum GitSyncReconciliationStoreError {
  #[error("Git-Sync profile not found")]
  NotFound,
  #[error("Git-Sync profile must be disabled before reconciliation")]
  ProfileEnabled,
  #[error("Git-Sync profile has a running sync and cannot be reconciled")]
  RunningSync,
  #[error("Git-Sync reconciliation state changed: {0}")]
  Conflict(String),
  #[error("Git-Sync reconciliation persistence failed: {0}")]
  Storage(String),
}

#[async_trait]
pub trait GitSyncReconciliationStore: Send + Sync {
  async fn inventory(
    &self,
    profile_id: ProfileId,
  ) -> Result<GitSyncReconciliationInventory, GitSyncReconciliationStoreError>;

  async fn apply(&self, plan: GitSyncReconciliationPlan) -> Result<(), GitSyncReconciliationStoreError>;
}

#[derive(Debug, Error)]
pub enum GitSyncReconciliationError {
  #[error(transparent)]
  Store(#[from] GitSyncReconciliationStoreError),
  #[error("remote inspection failed: {0}")]
  Remote(String),
  #[error("invalid Git-Sync manifest: {0}")]
  InvalidManifest(String),
  #[error("remote branch changed during reconciliation: expected {expected}, observed {observed}")]
  RemoteChanged { expected: String, observed: String },
  #[error("reconciliation has {count} unresolved remote document(s); inspect the report before apply")]
  UnresolvedRemoteDocuments { count: usize },
}

#[derive(Clone)]
pub struct GitSyncReconciliationService {
  store: Arc<dyn GitSyncReconciliationStore>,
  repository: Arc<dyn GitRepositoryPort>,
}

impl GitSyncReconciliationService {
  pub fn new(store: Arc<dyn GitSyncReconciliationStore>, repository: Arc<dyn GitRepositoryPort>) -> Self {
    Self { store, repository }
  }

  #[instrument(skip(self, auth), fields(%profile_id), err)]
  pub async fn inspect(
    &self,
    profile_id: ProfileId,
    auth: &GitAuth,
  ) -> Result<GitSyncReconciliationPlan, GitSyncReconciliationError> {
    let inventory = self.store.inventory(profile_id).await?;
    if inventory.profile.enabled {
      return Err(GitSyncReconciliationStoreError::ProfileEnabled.into());
    }
    let probe = self
      .repository
      .probe_remote(&inventory.profile.repo_url, Some(&inventory.profile.branch), auth)
      .await
      .map_err(|error| GitSyncReconciliationError::Remote(error.to_string()))?;
    let remote_oid = probe
      .observed_remote_oid
      .ok_or_else(|| GitSyncReconciliationError::Remote("exact branch probe returned no OID".to_string()))?;
    let checkout = TempDir::new().map_err(|error| GitSyncReconciliationError::Remote(error.to_string()))?;
    self
      .repository
      .clone_repo_full(
        &inventory.profile.repo_url,
        checkout.path(),
        &inventory.profile.branch,
        auth,
      )
      .await
      .map_err(|error| GitSyncReconciliationError::Remote(error.to_string()))?;
    let head_oid = self
      .repository
      .head_oid()
      .await
      .map_err(|error| GitSyncReconciliationError::Remote(error.to_string()))?;
    if head_oid != remote_oid {
      return Err(GitSyncReconciliationError::RemoteChanged {
        expected: remote_oid,
        observed: head_oid,
      });
    }
    let manifest_bytes = self
      .repository
      .read_file(&inventory.profile.manifest_path)
      .await
      .map_err(|error| GitSyncReconciliationError::InvalidManifest(error.to_string()))?;
    let manifest: GitSyncManifest = serde_json::from_slice(&manifest_bytes).map_err(|error| {
      GitSyncReconciliationError::InvalidManifest(format!(
        "invalid manifest JSON at {}:{}",
        error.line(),
        error.column()
      ))
    })?;
    validate_manifest(&inventory.profile, &manifest)?;
    let manifest = inventory
      .scope
      .owned_manifest(&manifest)
      .map_err(|error| GitSyncReconciliationError::InvalidManifest(error.to_string()))?;
    // SQL document paths may be exactly the stale state being repaired after a
    // successful push. The captured manifest owns current ordinary paths;
    // generated bytes are verified separately and never adopted as bindings.
    manifest
      .validate_overviews(
        inventory.profile.workspace_id,
        inventory
          .file_bindings
          .iter()
          .filter(|binding| !binding.tombstoned)
          .map(|binding| binding.repo_path.as_str()),
      )
      .map_err(GitSyncReconciliationError::InvalidManifest)?;
    for output in manifest.overview_outputs() {
      let bytes = self
        .repository
        .read_file(&output.repo_path)
        .await
        .map_err(|error| GitSyncReconciliationError::InvalidManifest(error.to_string()))?;
      super::overview::verify_git_overview_bytes(&bytes, &output.content_hash)
        .map_err(|reason| GitSyncReconciliationError::InvalidManifest(format!("{}: {reason}", output.repo_path)))?;
    }
    let verified = self.verify_manifest_documents(&inventory.profile, &manifest).await?;
    self.build_plan(inventory, manifest, verified, remote_oid).await
  }

  #[instrument(skip(self, auth, plan), fields(profile_id = %plan.profile_id), err)]
  pub async fn apply(
    &self,
    plan: GitSyncReconciliationPlan,
    expected_remote_oid: &str,
    auth: &GitAuth,
  ) -> Result<GitSyncReconciliationReport, GitSyncReconciliationError> {
    if !plan.unresolved_remote_documents.is_empty() {
      return Err(GitSyncReconciliationError::UnresolvedRemoteDocuments {
        count: plan.unresolved_remote_documents.len(),
      });
    }
    if expected_remote_oid != plan.expected_remote_oid {
      return Err(GitSyncReconciliationError::RemoteChanged {
        expected: expected_remote_oid.to_string(),
        observed: plan.expected_remote_oid,
      });
    }
    let inventory = self.store.inventory(plan.profile_id).await?;
    let probe = self
      .repository
      .probe_remote(&inventory.profile.repo_url, Some(&inventory.profile.branch), auth)
      .await
      .map_err(|error| GitSyncReconciliationError::Remote(error.to_string()))?;
    let observed = probe.observed_remote_oid.unwrap_or_default();
    if observed != expected_remote_oid {
      return Err(GitSyncReconciliationError::RemoteChanged {
        expected: expected_remote_oid.to_string(),
        observed,
      });
    }
    let report = plan.report.clone();
    self.store.apply(plan).await?;
    info!(profile_id = %report.profile_id, remote_oid = %report.remote_oid, "Git-Sync reconciliation applied");
    Ok(report)
  }

  async fn verify_manifest_documents(
    &self,
    profile: &GitSyncProfile,
    manifest: &GitSyncManifest,
  ) -> Result<HashMap<Uuid, (ExportFrontmatter, String)>, GitSyncReconciliationError> {
    let mut verified = HashMap::new();
    for document in &manifest.documents {
      let bytes = self
        .repository
        .read_file(&document.repo_path)
        .await
        .map_err(|error| GitSyncReconciliationError::InvalidManifest(error.to_string()))?;
      let file = String::from_utf8(bytes)
        .map_err(|_| GitSyncReconciliationError::InvalidManifest(format!("{} is not UTF-8", document.repo_path)))?;
      let (yaml, markdown) = split_markdown_file(&file);
      let frontmatter = yaml.as_deref().and_then(ExportFrontmatter::from_yaml).ok_or_else(|| {
        GitSyncReconciliationError::InvalidManifest(format!("{} has no valid Myoxus frontmatter", document.repo_path))
      })?;
      if frontmatter.workspace_id != profile.workspace_id || frontmatter.doc_id != document.doc_id {
        return Err(GitSyncReconciliationError::InvalidManifest(format!(
          "{} identity does not match the profile/manifest",
          document.repo_path
        )));
      }
      let actual_hash = content_hash(&markdown);
      if actual_hash != document.content_hash {
        return Err(GitSyncReconciliationError::InvalidManifest(format!(
          "{} content hash does not match the manifest",
          document.repo_path
        )));
      }
      verified.insert(document.doc_id, (frontmatter, markdown));
    }
    Ok(verified)
  }

  async fn build_plan(
    &self,
    inventory: GitSyncReconciliationInventory,
    manifest: GitSyncManifest,
    verified: HashMap<Uuid, (ExportFrontmatter, String)>,
    remote_oid: String,
  ) -> Result<GitSyncReconciliationPlan, GitSyncReconciliationError> {
    let manifest_by_doc: HashMap<_, _> = manifest
      .documents
      .iter()
      .map(|document| (document.doc_id, document))
      .collect();
    let mut bindings_by_doc = HashMap::<Uuid, Vec<&GitSyncBinding>>::new();
    for binding in &inventory.bindings {
      bindings_by_doc.entry(binding.doc_id).or_default().push(binding);
    }
    let baselines_by_binding: HashMap<_, _> = inventory
      .baselines
      .iter()
      .map(|baseline| (baseline.binding_id, baseline))
      .collect();
    let mut documents_by_id = HashMap::<Uuid, Vec<&ReconciliationDocument>>::new();
    for document in &inventory.documents {
      documents_by_id.entry(document.id).or_default().push(document);
    }
    let tombstoned_doc_ids = inventory
      .tombstoned_bindings
      .iter()
      .map(|binding| binding.doc_id)
      .collect::<HashSet<_>>();
    let tombstoned_sync_ids = inventory
      .tombstoned_bindings
      .iter()
      .map(|binding| binding.sync_id)
      .collect::<HashSet<_>>();
    let tombstoned_repo_paths = inventory
      .tombstoned_bindings
      .iter()
      .map(|binding| binding.repo_path.as_str())
      .collect::<HashSet<_>>();
    let active_sync_ids = inventory
      .bindings
      .iter()
      .map(|binding| binding.sync_id)
      .collect::<HashSet<_>>();
    let active_repo_paths = inventory
      .bindings
      .iter()
      .map(|binding| binding.repo_path.as_str())
      .collect::<HashSet<_>>();
    let active_file_paths = inventory
      .file_bindings
      .iter()
      .map(|binding| binding.repo_path.as_str())
      .collect::<HashSet<_>>();
    let mut remote_sync_counts = HashMap::<Uuid, usize>::new();
    for (frontmatter, _) in verified.values() {
      *remote_sync_counts.entry(frontmatter.sync_id).or_default() += 1;
    }

    let mut binding_adoptions = Vec::new();
    let mut unresolved_remote_documents = Vec::new();
    let mut unresolved_doc_ids = HashSet::new();
    for remote in &manifest.documents {
      let (frontmatter, _) = verified.get(&remote.doc_id).expect("verified manifest entry");
      let active_for_document = bindings_by_doc
        .get(&remote.doc_id)
        .map(Vec::as_slice)
        .unwrap_or_default();
      if active_for_document.len() > 1 {
        unresolved_doc_ids.insert(remote.doc_id);
        unresolved_remote_documents.push(unresolved_remote(
          remote,
          frontmatter.sync_id,
          "ambiguous_active_document_binding",
        ));
        continue;
      }
      if let Some(binding) = active_for_document.first() {
        if binding.sync_id != frontmatter.sync_id {
          unresolved_doc_ids.insert(remote.doc_id);
          unresolved_remote_documents.push(unresolved_remote(
            remote,
            frontmatter.sync_id,
            "active_binding_sync_id_mismatch",
          ));
        } else if active_file_paths.contains(remote.repo_path.as_str()) {
          unresolved_doc_ids.insert(remote.doc_id);
          unresolved_remote_documents.push(unresolved_remote(remote, frontmatter.sync_id, "file_path_conflict"));
        }
        continue;
      }

      let local_documents = documents_by_id
        .get(&remote.doc_id)
        .map(Vec::as_slice)
        .unwrap_or_default();
      let reason = if local_documents.is_empty() {
        Some("unknown_document_id")
      } else if local_documents.len() > 1 {
        Some("ambiguous_document_id")
      } else if remote_sync_counts
        .get(&frontmatter.sync_id)
        .copied()
        .unwrap_or_default()
        > 1
      {
        Some("duplicate_remote_sync_id")
      } else if tombstoned_doc_ids.contains(&remote.doc_id)
        || tombstoned_sync_ids.contains(&frontmatter.sync_id)
        || tombstoned_repo_paths.contains(remote.repo_path.as_str())
      {
        Some("tombstoned_binding_conflict")
      } else if active_sync_ids.contains(&frontmatter.sync_id) {
        Some("duplicate_sync_id")
      } else if active_repo_paths.contains(remote.repo_path.as_str()) {
        Some("document_path_conflict")
      } else if active_file_paths.contains(remote.repo_path.as_str()) {
        Some("file_path_conflict")
      } else {
        None
      };
      if let Some(reason) = reason {
        unresolved_doc_ids.insert(remote.doc_id);
        unresolved_remote_documents.push(unresolved_remote(remote, frontmatter.sync_id, reason));
        continue;
      }

      let local_document = local_documents[0];
      let binding_id = Uuid::new_v4();
      binding_adoptions.push(GitSyncBindingAdoption {
        binding: GitSyncBinding {
          id: binding_id,
          profile_id: inventory.profile.id,
          workspace_id: inventory.profile.workspace_id,
          doc_id: remote.doc_id,
          sync_id: frontmatter.sync_id,
          repo_path: remote.repo_path.clone(),
          last_commit_oid: Some(remote_oid.clone()),
          content_hash: Some(remote.content_hash.clone()),
          structure_hash: Some(structure_hash(&remote.repo_path, &local_document.title)),
          tombstone: false,
          created_at: Utc::now(),
          updated_at: Utc::now(),
        },
        baseline: GitSyncBaseline {
          binding_id,
          content_hash: remote.content_hash.clone(),
          commit_oid: remote_oid.clone(),
          myoxus_updated_at: local_document.updated_at,
          captured_at: Utc::now(),
        },
      });
    }
    let mut occupied = BTreeMap::new();
    for document in &manifest.documents {
      occupied.insert(
        document.repo_path.clone(),
        format!("manifest document {}", document.doc_id),
      );
    }
    for binding in &inventory.file_bindings {
      occupied.insert(binding.repo_path.clone(), format!("file binding {}", binding.id));
    }
    for output in manifest.overview_outputs() {
      occupied.insert(output.repo_path.clone(), "derived overview".into());
    }
    let local_only: Vec<_> = inventory
      .bindings
      .iter()
      .filter(|binding| !manifest_by_doc.contains_key(&binding.doc_id))
      .map(|binding| {
        let title = documents_by_id
          .get(&binding.doc_id)
          .and_then(|documents| documents.first())
          .map(|document| document.title.clone())
          .unwrap_or_else(|| binding.doc_id.to_string());
        PathPlanDocument {
          doc_id: binding.doc_id,
          title,
          folder_names: Vec::new(),
          existing_repo_path: Some(binding.repo_path.clone()),
        }
      })
      .collect();
    let planned_local_paths = plan_document_paths(&inventory.profile.root_path, &local_only, &occupied)
      .map_err(|error| GitSyncReconciliationError::InvalidManifest(error.to_string()))?
      .into_iter()
      .map(|path| (path.doc_id, path.repo_path.into_inner()))
      .collect::<HashMap<_, _>>();

    let mut reachability = HashMap::<String, bool>::new();
    let mut binding_updates = Vec::new();
    let mut baseline_upserts = Vec::new();
    let mut baseline_deletes = Vec::new();
    for binding in &inventory.bindings {
      let mut repaired = binding.clone();
      if let Some(remote) = manifest_by_doc.get(&binding.doc_id) {
        if unresolved_doc_ids.contains(&binding.doc_id) {
          continue;
        }
        let (frontmatter, _) = verified.get(&binding.doc_id).expect("verified manifest entry");
        debug_assert_eq!(binding.sync_id, frontmatter.sync_id);
        repaired.repo_path = remote.repo_path.clone();
        repaired.last_commit_oid = Some(remote_oid.clone());
        repaired.content_hash = Some(remote.content_hash.clone());
        let updated_at = documents_by_id
          .get(&binding.doc_id)
          .and_then(|documents| documents.first())
          .map(|document| document.updated_at)
          .unwrap_or(binding.updated_at);
        let baseline = GitSyncBaseline {
          binding_id: binding.id,
          content_hash: remote.content_hash.clone(),
          commit_oid: remote_oid.clone(),
          myoxus_updated_at: updated_at,
          captured_at: Utc::now(),
        };
        if baselines_by_binding.get(&binding.id).is_none_or(|existing| {
          existing.content_hash != baseline.content_hash || existing.commit_oid != baseline.commit_oid
        }) {
          baseline_upserts.push(baseline);
        }
      } else {
        repaired.repo_path = planned_local_paths
          .get(&binding.doc_id)
          .cloned()
          .unwrap_or_else(|| binding.repo_path.clone());
        if let Some(oid) = &binding.last_commit_oid
          && !self.reachable(oid, &remote_oid, &mut reachability).await?
        {
          repaired.last_commit_oid = None;
        }
        if baselines_by_binding.contains_key(&binding.id) {
          baseline_deletes.push(binding.id);
        }
      }
      if repaired.repo_path != binding.repo_path
        || repaired.last_commit_oid != binding.last_commit_oid
        || repaired.content_hash != binding.content_hash
      {
        binding_updates.push(repaired);
      }
    }

    let mut file_baseline_updates = Vec::new();
    for baseline in &inventory.file_baselines {
      if let Some(oid) = &baseline.commit_oid
        && !self.reachable(oid, &remote_oid, &mut reachability).await?
      {
        let mut repaired = baseline.clone();
        repaired.commit_oid = None;
        file_baseline_updates.push(repaired);
      }
    }
    let mut version_link_clear_commits = Vec::new();
    for link in &inventory.version_links {
      if let Some(oid) = &link.git_commit_oid
        && !self.reachable(oid, &remote_oid, &mut reachability).await?
      {
        version_link_clear_commits.push(link.id);
      }
    }
    let completed_reconciliation_runs = inventory
      .runs
      .iter()
      .filter(|run| {
        run.status == RunStatus::Failed
          && run.reconciliation_required
          && run.observed_remote_oid.as_deref() == Some(remote_oid.as_str())
      })
      .map(|run| run.id)
      .collect::<Vec<_>>();
    let inventory_counts = GitSyncReconciliationCounts {
      documents: inventory.documents.len(),
      bindings: inventory.bindings.len(),
      baselines: inventory.baselines.len(),
      file_bindings: inventory.file_bindings.len(),
      file_baselines: inventory.file_baselines.len(),
      runs: inventory.runs.len(),
      version_links: inventory.version_links.len(),
    };
    let changes_required = !binding_adoptions.is_empty()
      || !unresolved_remote_documents.is_empty()
      || !binding_updates.is_empty()
      || !baseline_upserts.is_empty()
      || !baseline_deletes.is_empty()
      || !file_baseline_updates.is_empty()
      || !version_link_clear_commits.is_empty()
      || !completed_reconciliation_runs.is_empty();
    let report = GitSyncReconciliationReport {
      profile_id: inventory.profile.id,
      workspace_id: inventory.profile.workspace_id,
      remote_oid: remote_oid.clone(),
      manifest_schema_version: manifest.schema_version,
      manifest_documents: manifest.documents.len(),
      inventory: inventory_counts,
      binding_updates: binding_updates.len(),
      baseline_upserts: baseline_upserts.len(),
      baseline_deletes: baseline_deletes.len(),
      file_baseline_commit_clears: file_baseline_updates.len(),
      version_link_commit_clears: version_link_clear_commits.len(),
      completed_reconciliation_runs: completed_reconciliation_runs.len(),
      binding_adoptions: binding_adoptions
        .iter()
        .map(|adoption| GitSyncReconciliationDocumentIdentity {
          doc_id: adoption.binding.doc_id,
          sync_id: adoption.binding.sync_id,
          repo_path: adoption.binding.repo_path.clone(),
        })
        .collect(),
      unresolved_remote_documents: unresolved_remote_documents.clone(),
      changes_required,
    };
    Ok(GitSyncReconciliationPlan {
      profile_id: inventory.profile.id,
      profile_updated_at: inventory.profile.updated_at,
      expected_remote_oid: remote_oid,
      binding_adoptions,
      unresolved_remote_documents,
      binding_updates,
      baseline_upserts,
      baseline_deletes,
      file_baseline_updates,
      version_link_clear_commits,
      completed_reconciliation_runs,
      report,
    })
  }

  async fn reachable(
    &self,
    oid: &str,
    remote_oid: &str,
    cache: &mut HashMap<String, bool>,
  ) -> Result<bool, GitSyncReconciliationError> {
    if let Some(reachable) = cache.get(oid) {
      return Ok(*reachable);
    }
    let reachable = self
      .repository
      .commit_is_ancestor(oid, remote_oid)
      .await
      .map_err(|error| GitSyncReconciliationError::Remote(error.to_string()))?;
    cache.insert(oid.to_string(), reachable);
    Ok(reachable)
  }
}

fn validate_manifest(profile: &GitSyncProfile, manifest: &GitSyncManifest) -> Result<(), GitSyncReconciliationError> {
  if manifest.schema_version != GIT_SYNC_MANIFEST_SCHEMA_VERSION {
    return Err(GitSyncReconciliationError::InvalidManifest(format!(
      "unsupported schema version {}",
      manifest.schema_version
    )));
  }
  if manifest.workspace_id != profile.workspace_id {
    return Err(GitSyncReconciliationError::InvalidManifest(
      "workspace identity does not match the profile".to_string(),
    ));
  }
  let mut ids = HashSet::new();
  let mut paths = BTreeSet::new();
  for document in &manifest.documents {
    if !ids.insert(document.doc_id) {
      return Err(GitSyncReconciliationError::InvalidManifest(format!(
        "duplicate document identity {}",
        document.doc_id
      )));
    }
    if !paths.insert(document.repo_path.as_str()) {
      return Err(GitSyncReconciliationError::InvalidManifest(format!(
        "duplicate repository path {}",
        document.repo_path
      )));
    }
  }
  Ok(())
}

fn unresolved_remote(
  document: &GitSyncManifestDocument,
  sync_id: Uuid,
  reason: &str,
) -> GitSyncUnresolvedRemoteDocument {
  GitSyncUnresolvedRemoteDocument {
    doc_id: document.doc_id,
    sync_id,
    repo_path: document.repo_path.clone(),
    reason: reason.to_string(),
  }
}

#[cfg(test)]
mod tests {
  use std::path::Path;
  use std::sync::Mutex;

  use super::super::backend::{ChangedFile, GitError, GitPushReceipt, GitRemoteProbe};
  use super::super::export::{GitSyncManifestDocument, compose_markdown_file};
  use super::*;
  use myoxus_domain::git_sync::{AuthMethod, ErrorClass, GitSyncRunSource, SyncDirection, TriggerMode};

  struct FakeRepository {
    remote_oid: String,
    manifest: Vec<u8>,
    document_path: String,
    document: Vec<u8>,
    overview: Option<Vec<u8>>,
  }

  #[async_trait]
  impl GitRepositoryPort for FakeRepository {
    async fn probe_remote(&self, _: &str, branch: Option<&str>, _: &GitAuth) -> Result<GitRemoteProbe, GitError> {
      Ok(GitRemoteProbe {
        branch: branch.map(str::to_string),
        observed_remote_oid: Some(self.remote_oid.clone()),
      })
    }
    async fn clone_repo(&self, _: &str, _: &Path, _: &str, _: &GitAuth) -> Result<(), GitError> {
      Ok(())
    }
    async fn clone_repo_full(&self, _: &str, _: &Path, _: &str, _: &GitAuth) -> Result<(), GitError> {
      Ok(())
    }
    async fn open_repo(&self, _: &Path) -> Result<(), GitError> {
      unreachable!()
    }
    async fn fetch(&self, _: &GitAuth) -> Result<(), GitError> {
      unreachable!()
    }
    async fn checkout_branch(&self, _: &str) -> Result<(), GitError> {
      unreachable!()
    }
    async fn reset_to_remote(&self, _: &str) -> Result<String, GitError> {
      unreachable!()
    }
    async fn head_oid(&self) -> Result<String, GitError> {
      Ok(self.remote_oid.clone())
    }
    async fn commit_is_ancestor(&self, ancestor: &str, _: &str) -> Result<bool, GitError> {
      Ok(ancestor == self.remote_oid)
    }
    async fn remote_branch_oid(&self, _: &str, _: &GitAuth) -> Result<String, GitError> {
      unreachable!()
    }
    async fn changed_files(&self, _: Option<&str>, _: Option<&str>) -> Result<Vec<ChangedFile>, GitError> {
      unreachable!()
    }
    async fn read_file(&self, path: &str) -> Result<Vec<u8>, GitError> {
      if path == crate::git_sync::export::GIT_SYNC_MANIFEST_PATH {
        Ok(self.manifest.clone())
      } else if path == "content/README.md" {
        self
          .overview
          .clone()
          .ok_or_else(|| GitError::NotFound(path.to_string()))
      } else if path == self.document_path {
        Ok(self.document.clone())
      } else {
        Err(GitError::NotFound(path.to_string()))
      }
    }
    async fn write_file(&self, _: &str, _: &[u8]) -> Result<(), GitError> {
      unreachable!()
    }
    async fn delete_file(&self, _: &str) -> Result<(), GitError> {
      unreachable!()
    }
    async fn rename_file(&self, _: &str, _: &str) -> Result<(), GitError> {
      unreachable!()
    }
    async fn commit(&self, _: &str, _: &str, _: &str) -> Result<String, GitError> {
      unreachable!()
    }
    async fn push(&self, _: &str, _: &str, _: &GitAuth) -> Result<GitPushReceipt, GitError> {
      unreachable!()
    }
  }

  struct FakeStore {
    inventory: GitSyncReconciliationInventory,
    applied: Mutex<Vec<GitSyncReconciliationPlan>>,
  }

  #[async_trait]
  impl GitSyncReconciliationStore for FakeStore {
    async fn inventory(&self, _: ProfileId) -> Result<GitSyncReconciliationInventory, GitSyncReconciliationStoreError> {
      Ok(self.inventory.clone())
    }

    async fn apply(&self, plan: GitSyncReconciliationPlan) -> Result<(), GitSyncReconciliationStoreError> {
      self.applied.lock().unwrap().push(plan);
      Ok(())
    }
  }

  fn fixture() -> (Arc<FakeStore>, Arc<FakeRepository>, Uuid, String) {
    let now = Utc::now();
    let profile_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let owner_id = Uuid::new_v4();
    let remote_doc_id = Uuid::new_v4();
    let local_doc_id = Uuid::new_v4();
    let remote_sync_id = Uuid::new_v4();
    let remote_binding_id = Uuid::new_v4();
    let local_binding_id = Uuid::new_v4();
    let remote_oid = "a".repeat(40);
    let stale_oid = "b".repeat(40);
    let markdown = "# Verified\n\nRemote truth.\n";
    let remote_path = "content/verified.md".to_string();
    let frontmatter = ExportFrontmatter {
      sync_id: remote_sync_id,
      doc_id: remote_doc_id,
      workspace_id,
      title: "Verified".to_string(),
    };
    let document = compose_markdown_file(&frontmatter, markdown).into_bytes();
    let manifest = GitSyncManifest::new(
      workspace_id,
      "fixture".to_string(),
      Vec::new(),
      vec![GitSyncManifestDocument {
        doc_id: remote_doc_id,
        organizer_entry_id: None,
        organizer_folder_ids: Vec::new(),
        repo_path: remote_path.clone(),
        title: "Verified".to_string(),
        content_hash: content_hash(markdown),
      }],
    )
    .to_json()
    .unwrap()
    .into_bytes();
    let profile = GitSyncProfile {
      id: profile_id,
      workspace_id,
      owner_id,
      repo_url: "https://git.example.test/team/repository.git".to_string(),
      branch: "main".to_string(),
      root_path: "content/".to_string(),
      manifest_path: crate::git_sync::export::GIT_SYNC_MANIFEST_PATH.to_string(),
      scope_revision: 0,
      sync_direction: SyncDirection::MyoxusToGit,
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
    };
    let binding = |id, doc_id, sync_id, path: &str| GitSyncBinding {
      id,
      profile_id,
      workspace_id,
      doc_id,
      sync_id,
      repo_path: path.to_string(),
      last_commit_oid: Some(stale_oid.clone()),
      content_hash: Some("stale".to_string()),
      structure_hash: None,
      tombstone: false,
      created_at: now,
      updated_at: now,
    };
    let failed_run_id = Uuid::new_v4();
    let inventory = GitSyncReconciliationInventory {
      profile,
      scope: super::super::export::GitSyncWriterScope::new(Vec::new()),
      documents: vec![
        ReconciliationDocument {
          id: remote_doc_id,
          title: "Verified".to_string(),
          updated_at: now,
        },
        ReconciliationDocument {
          id: local_doc_id,
          title: "Local only".to_string(),
          updated_at: now,
        },
      ],
      bindings: vec![
        binding(remote_binding_id, remote_doc_id, remote_sync_id, "content/old.md"),
        binding(local_binding_id, local_doc_id, Uuid::new_v4(), "content/verified.md"),
      ],
      tombstoned_bindings: Vec::new(),
      baselines: vec![GitSyncBaseline {
        binding_id: local_binding_id,
        content_hash: "stale".to_string(),
        commit_oid: stale_oid.clone(),
        myoxus_updated_at: now,
        captured_at: now,
      }],
      file_bindings: Vec::new(),
      file_baselines: vec![GitSyncFileBaseline {
        id: Uuid::new_v4(),
        profile_id,
        blob_key: "blob".to_string(),
        content_hash: "file".to_string(),
        commit_oid: Some(stale_oid.clone()),
        synced_at: now,
      }],
      runs: vec![GitSyncRun {
        id: failed_run_id,
        profile_id,
        direction: SyncDirection::MyoxusToGit,
        trigger_source: GitSyncRunSource::Manual,
        scheduled_for: None,
        status: RunStatus::Failed,
        started_at: now,
        finished_at: Some(now),
        commit_before: None,
        commit_after: None,
        observed_remote_oid: Some(remote_oid.clone()),
        reconciliation_required: true,
        reconciliation_reason: Some("post-push finalization failed".to_string()),
        docs_created: 0,
        docs_updated: 1,
        docs_deleted: 0,
        conflicts_found: 0,
        error_message: Some("reconciliation required".to_string()),
        error_class: Some(ErrorClass::InternalError),
        job_id: Some("fixture-job".to_string()),
      }],
      version_links: vec![GitSyncVersionLink {
        id: Uuid::new_v4(),
        profile_id,
        run_id: failed_run_id,
        sync_object_kind: "doc".to_string(),
        sync_object_id: local_doc_id.to_string(),
        direction: "push".to_string(),
        git_commit_oid: Some(stale_oid),
        myoxus_history_id: None,
        repo_path: "content/local-only.md".to_string(),
        content_hash: Some("stale".to_string()),
        created_at: now,
      }],
    };
    (
      Arc::new(FakeStore {
        inventory,
        applied: Mutex::new(Vec::new()),
      }),
      Arc::new(FakeRepository {
        remote_oid: remote_oid.clone(),
        manifest,
        document_path: remote_path,
        document,
        overview: None,
      }),
      profile_id,
      remote_oid,
    )
  }

  fn make_remote_document_unbound(store: &mut Arc<FakeStore>) -> (Uuid, Uuid, String, GitSyncBinding) {
    let inventory = &mut Arc::get_mut(store).expect("unique fixture store").inventory;
    let remote_repo_path = "content/verified.md".to_string();
    let remote_doc_id = inventory
      .documents
      .iter()
      .find(|document| document.title == "Verified")
      .expect("remote fixture document")
      .id;
    let index = inventory
      .bindings
      .iter()
      .position(|binding| binding.doc_id == remote_doc_id)
      .expect("remote fixture binding");
    let binding = inventory.bindings.remove(index);
    for local in &mut inventory.bindings {
      if local.repo_path == remote_repo_path {
        local.repo_path = "content/local-only.md".to_string();
      }
    }
    (remote_doc_id, binding.sync_id, remote_repo_path, binding)
  }

  #[tokio::test]
  async fn inspection_repairs_only_verified_remote_facts_and_shared_paths() {
    let (mut store, repository, profile_id, remote_oid) = fixture();
    Arc::get_mut(&mut store).unwrap().inventory.bindings[1].repo_path = "content/README.md".into();
    let mut repository = repository;
    let marker = crate::workspace_overview::markdown::GIT_OVERVIEW_MARKER
      .as_bytes()
      .to_vec();
    let remote = Arc::get_mut(&mut repository).unwrap();
    let mut manifest: GitSyncManifest = serde_json::from_slice(&remote.manifest).unwrap();
    manifest.overview = Some(super::super::export::GitSyncManifestOverview {
      repo_path: "content/README.md".into(),
      content_hash: content_hash(std::str::from_utf8(&marker).unwrap()),
    });
    remote.manifest = serde_json::to_vec(&manifest).unwrap();
    remote.overview = Some(marker);
    let service = GitSyncReconciliationService::new(store.clone(), repository.clone());
    let plan = service
      .inspect(
        profile_id,
        &GitAuth::HttpsToken {
          username: "operator".to_string(),
          token: "secret".to_string(),
        },
      )
      .await
      .unwrap();

    assert_eq!(plan.report.binding_updates, 2);
    assert_eq!(plan.report.baseline_upserts, 1);
    assert_eq!(plan.report.baseline_deletes, 1);
    assert_eq!(plan.report.file_baseline_commit_clears, 1);
    assert_eq!(plan.report.version_link_commit_clears, 1);
    assert_eq!(plan.report.completed_reconciliation_runs, 1);
    assert_eq!(
      plan
        .binding_updates
        .iter()
        .find(|binding| binding.repo_path == "content/verified.md")
        .unwrap()
        .last_commit_oid
        .as_deref(),
      Some(remote_oid.as_str())
    );
    assert!(
      plan
        .binding_updates
        .iter()
        .any(|binding| binding.repo_path.starts_with("content/local-only"))
    );
    assert!(
      plan
        .binding_updates
        .iter()
        .all(|binding| binding.repo_path != "content/README.md")
    );
    drop(service);
    let remote = Arc::get_mut(&mut repository).unwrap();
    remote.overview = Some(b"tampered derived bytes".to_vec());
    let service = GitSyncReconciliationService::new(store, repository);
    assert!(matches!(
      service
        .inspect(
          profile_id,
          &GitAuth::HttpsToken {
            username: "operator".into(),
            token: "secret".into()
          }
        )
        .await,
      Err(GitSyncReconciliationError::InvalidManifest(_))
    ));
  }

  #[tokio::test]
  async fn apply_refuses_wrong_expected_oid_before_store_mutation() {
    let (store, repository, profile_id, _) = fixture();
    let service = GitSyncReconciliationService::new(store.clone(), repository);
    let auth = GitAuth::HttpsToken {
      username: "operator".to_string(),
      token: "secret".to_string(),
    };
    let plan = service.inspect(profile_id, &auth).await.unwrap();
    let error = service.apply(plan, &"f".repeat(40), &auth).await.unwrap_err();

    assert!(matches!(error, GitSyncReconciliationError::RemoteChanged { .. }));
    assert!(store.applied.lock().unwrap().is_empty());
  }

  #[tokio::test]
  async fn verified_unbound_remote_document_is_an_explicit_adoption_and_change() {
    let (mut store, repository, profile_id, _) = fixture();
    let (doc_id, sync_id, repo_path, _) = make_remote_document_unbound(&mut store);
    let service = GitSyncReconciliationService::new(store, repository);
    let plan = service
      .inspect(
        profile_id,
        &GitAuth::HttpsToken {
          username: "operator".to_string(),
          token: "secret".to_string(),
        },
      )
      .await
      .expect("inspect adoptable remote document");

    assert!(plan.report.changes_required);
    assert!(plan.unresolved_remote_documents.is_empty());
    assert_eq!(plan.binding_adoptions.len(), 1);
    assert_eq!(
      plan.report.binding_adoptions,
      vec![GitSyncReconciliationDocumentIdentity {
        doc_id,
        sync_id,
        repo_path,
      }]
    );
  }

  #[tokio::test]
  async fn remote_document_identity_failures_are_explicit_and_block_apply() {
    for (expected_reason, mutate) in [
      ("unknown_document_id", 0_u8),
      ("ambiguous_document_id", 1_u8),
      ("tombstoned_binding_conflict", 2_u8),
      ("duplicate_sync_id", 3_u8),
      ("file_path_conflict", 4_u8),
    ] {
      let (mut store, repository, profile_id, remote_oid) = fixture();
      let (doc_id, sync_id, repo_path, mut removed_binding) = make_remote_document_unbound(&mut store);
      let inventory = &mut Arc::get_mut(&mut store).expect("unique fixture store").inventory;
      match mutate {
        0 => inventory.documents.retain(|document| document.id != doc_id),
        1 => {
          let duplicate = inventory
            .documents
            .iter()
            .find(|document| document.id == doc_id)
            .expect("remote fixture document")
            .clone();
          inventory.documents.push(duplicate);
        }
        2 => {
          removed_binding.tombstone = true;
          inventory.tombstoned_bindings.push(removed_binding);
        }
        3 => inventory.bindings[0].sync_id = sync_id,
        4 => inventory.file_bindings.push(GitSyncFileBinding {
          id: Uuid::new_v4(),
          profile_id,
          workspace_id: inventory.profile.workspace_id,
          blob_key: "shared/path-conflict".to_string(),
          repo_path: repo_path.clone(),
          content_hash: "c".repeat(64),
          mime_type: "application/octet-stream".to_string(),
          file_size: 1,
          tombstoned: false,
          created_at: Utc::now(),
          updated_at: Utc::now(),
        }),
        _ => unreachable!(),
      }
      let service = GitSyncReconciliationService::new(store.clone(), repository);
      let auth = GitAuth::HttpsToken {
        username: "operator".to_string(),
        token: "secret".to_string(),
      };
      let plan = service
        .inspect(profile_id, &auth)
        .await
        .expect("inspect unresolved remote");

      assert!(plan.report.changes_required, "{expected_reason}");
      assert!(plan.binding_adoptions.is_empty(), "{expected_reason}");
      assert_eq!(plan.unresolved_remote_documents.len(), 1, "{expected_reason}");
      assert_eq!(
        plan.unresolved_remote_documents[0].reason, expected_reason,
        "{expected_reason}"
      );
      let error = service
        .apply(plan, &remote_oid, &auth)
        .await
        .expect_err("unresolved reconciliation must not reach the store");
      assert!(matches!(
        error,
        GitSyncReconciliationError::UnresolvedRemoteDocuments { count: 1 }
      ));
      assert!(store.applied.lock().unwrap().is_empty(), "{expected_reason}");
    }
  }

  #[tokio::test]
  async fn existing_binding_cannot_repair_onto_a_file_owned_path() {
    let (mut store, repository, profile_id, remote_oid) = fixture();
    let inventory = &mut Arc::get_mut(&mut store).expect("unique fixture store").inventory;
    inventory.file_bindings.push(GitSyncFileBinding {
      id: Uuid::new_v4(),
      profile_id,
      workspace_id: inventory.profile.workspace_id,
      blob_key: "bound-path-conflict".to_string(),
      repo_path: "content/verified.md".to_string(),
      content_hash: "c".repeat(64),
      mime_type: "application/octet-stream".to_string(),
      file_size: 1,
      tombstoned: false,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    });
    let service = GitSyncReconciliationService::new(store.clone(), repository);
    let auth = GitAuth::HttpsToken {
      username: "operator".to_string(),
      token: "secret".to_string(),
    };
    let plan = service
      .inspect(profile_id, &auth)
      .await
      .expect("inspect bound file-path collision");

    assert_eq!(plan.unresolved_remote_documents.len(), 1);
    assert_eq!(plan.unresolved_remote_documents[0].reason, "file_path_conflict");
    let error = service
      .apply(plan, &remote_oid, &auth)
      .await
      .expect_err("bound file-path collision must block all repairs");
    assert!(matches!(
      error,
      GitSyncReconciliationError::UnresolvedRemoteDocuments { count: 1 }
    ));
    assert!(store.applied.lock().unwrap().is_empty());
  }
}
