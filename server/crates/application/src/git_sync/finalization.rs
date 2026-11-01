// SPDX-License-Identifier: AGPL-3.0-or-later
//! Prepared facts for the single Git-Sync post-push database transaction.
//!
//! Network, Git, Markdown conversion and blob I/O must finish before this plan
//! is submitted. The infrastructure store either commits every listed fact
//! together with the terminal run transition or commits none of them.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::doc::InitialDocumentProvenance;
use myoxus_domain::git_sync::{
  GitSyncBaseline, GitSyncBinding, GitSyncConflict, GitSyncFileBaseline, GitSyncFileBinding, GitSyncFileConflict,
  GitSyncRun, GitSyncVersionLink,
};

#[derive(Debug, Clone)]
pub struct PreparedDocumentUpsert {
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  /// Planner expectation used to reconcile committed create/update counters
  /// with the actual row outcome inside the final transaction.
  pub expected_create: bool,
  pub title: String,
  pub actor_user_id: Uuid,
  pub payload: Vec<u8>,
  /// Server capture shared by projected rows and this attempt’s atomic native writes.
  /// Microsecond precision matches PostgreSQL; never supplied by the Git payload.
  pub observed_at: DateTime<Utc>,
  pub provenance: InitialDocumentProvenance,
}

#[derive(Debug, Clone)]
pub struct PartialItemFinalization {
  pub session_id: Uuid,
  pub run_id: Uuid,
  pub completed_item_ids: Vec<Uuid>,
  pub failed_item_ids: Vec<Uuid>,
  pub conflicted_item_ids: Vec<Uuid>,
}

#[derive(Debug, Clone)]
pub struct DocumentBaselineDraft {
  pub binding_id: Uuid,
  pub content_hash: String,
  pub myoxus_updated_at: DateTime<Utc>,
  pub captured_at: DateTime<Utc>,
}

/// Revision-independent normal-state facts prepared before a remote mutation.
///
/// OID-bearing domain values must carry `None` here. Document baselines use a
/// dedicated draft because their persisted contract requires a commit OID.
#[derive(Debug, Clone, Default)]
pub struct GitSyncPersistenceDraft {
  pub document_bindings: Vec<GitSyncBinding>,
  pub document_tombstone_ids: Vec<Uuid>,
  pub document_baselines: Vec<DocumentBaselineDraft>,
  pub document_conflicts: Vec<GitSyncConflict>,
  pub file_bindings: Vec<GitSyncFileBinding>,
  pub file_tombstone_paths: Vec<String>,
  pub file_baselines: Vec<GitSyncFileBaseline>,
  pub file_baseline_deletes: Vec<String>,
  pub file_conflicts: Vec<GitSyncFileConflict>,
  pub version_links: Vec<GitSyncVersionLink>,
}

/// Complete deterministic finalization input owned by one running queue job.
///
/// Construction, object preparation and validation finish before commit/push.
/// [`Self::bind_remote_oid`] is intentionally pure: it only stamps the
/// authenticated remote revision onto prepared values and transitions the
/// cloned run to `Completed`.
#[derive(Debug, Clone)]
pub struct GitSyncRunFinalizationDraft {
  pub run: GitSyncRun,
  pub workspace_id: Uuid,
  pub expected_job_id: String,
  pub document_upserts: Vec<PreparedDocumentUpsert>,
  pub document_deletes: Vec<Uuid>,
  pub persistence: GitSyncPersistenceDraft,
  pub blob_promotion_ids: Vec<Uuid>,
  pub partial: Option<PartialItemFinalization>,
}

impl GitSyncRunFinalizationDraft {
  pub fn validate(&self) -> Result<(), String> {
    if self.expected_job_id.trim().is_empty() || self.run.job_id.as_deref() != Some(self.expected_job_id.as_str()) {
      return Err("finalization draft has inconsistent queue job identity".to_string());
    }
    if self.run.status != myoxus_domain::git_sync::RunStatus::Running {
      return Err(format!(
        "finalization draft run is {}, expected Running",
        self.run.status
      ));
    }
    if self.run.commit_after.is_some() || self.run.observed_remote_oid.is_some() || self.run.reconciliation_required {
      return Err("finalization draft already carries remote completion state".to_string());
    }
    if [
      self.run.docs_created,
      self.run.docs_updated,
      self.run.docs_deleted,
      self.run.conflicts_found,
    ]
    .iter()
    .any(|counter| *counter < 0)
    {
      return Err("finalization draft contains a negative run counter".to_string());
    }

    let mut upserts = HashSet::new();
    for document in &self.document_upserts {
      if document.workspace_id != self.workspace_id {
        return Err(format!("document {} belongs to a different workspace", document.doc_id));
      }
      if !upserts.insert(document.doc_id) {
        return Err(format!(
          "document {} appears more than once in the finalization draft",
          document.doc_id
        ));
      }
    }
    let deletes = self.document_deletes.iter().copied().collect::<HashSet<_>>();
    if deletes.len() != self.document_deletes.len() {
      return Err("finalization draft contains duplicate document deletes".to_string());
    }
    if let Some(doc_id) = upserts.intersection(&deletes).next() {
      return Err(format!("document {doc_id} is both upserted and deleted"));
    }

    let mut binding_ids = HashSet::new();
    let mut document_paths = HashSet::new();
    for binding in &self.persistence.document_bindings {
      if binding.profile_id != self.run.profile_id || binding.workspace_id != self.workspace_id {
        return Err(format!("document binding {} crosses draft ownership", binding.id));
      }
      if binding.last_commit_oid.is_some() {
        return Err(format!("document binding {} is already revision-bound", binding.id));
      }
      if binding.repo_path.trim().is_empty()
        || !binding_ids.insert(binding.id)
        || !document_paths.insert(binding.repo_path.as_str())
      {
        return Err(format!(
          "document binding {} has duplicate or empty identity",
          binding.id
        ));
      }
    }
    let mut baseline_bindings = HashSet::new();
    for baseline in &self.persistence.document_baselines {
      if baseline.content_hash.trim().is_empty()
        || !binding_ids.contains(&baseline.binding_id)
        || !baseline_bindings.insert(baseline.binding_id)
      {
        return Err(format!(
          "document baseline {} has missing, duplicate or empty binding facts",
          baseline.binding_id
        ));
      }
    }
    let mut document_conflict_ids = HashSet::new();
    for conflict in &self.persistence.document_conflicts {
      if conflict.profile_id != self.run.profile_id
        || conflict.repo_path.trim().is_empty()
        || !document_conflict_ids.insert(conflict.id)
      {
        return Err(format!("document conflict {} crosses draft ownership", conflict.id));
      }
    }
    let document_tombstones = self
      .persistence
      .document_tombstone_ids
      .iter()
      .copied()
      .collect::<HashSet<_>>();
    if document_tombstones.len() != self.persistence.document_tombstone_ids.len()
      || document_tombstones.iter().any(|id| binding_ids.contains(id))
    {
      return Err("document tombstone draft contains duplicate or concurrently active bindings".to_string());
    }

    let mut file_paths = HashSet::new();
    let mut file_binding_ids = HashSet::new();
    for binding in &self.persistence.file_bindings {
      if binding.profile_id != self.run.profile_id
        || binding.workspace_id != self.workspace_id
        || binding.repo_path.trim().is_empty()
        || !file_binding_ids.insert(binding.id)
        || !file_paths.insert(binding.repo_path.as_str())
      {
        return Err(format!("file binding {} has inconsistent draft ownership", binding.id));
      }
    }
    if let Some(path) = document_paths.intersection(&file_paths).next() {
      return Err(format!("repository path {path} is claimed by document and file drafts"));
    }
    let file_tombstone_paths = self
      .persistence
      .file_tombstone_paths
      .iter()
      .map(String::as_str)
      .collect::<HashSet<_>>();
    if file_tombstone_paths.len() != self.persistence.file_tombstone_paths.len()
      || file_tombstone_paths
        .iter()
        .any(|path| path.trim().is_empty() || file_paths.contains(path))
    {
      return Err("file tombstone draft contains duplicate, empty or concurrently active paths".to_string());
    }
    let mut file_baseline_ids = HashSet::new();
    let mut file_baseline_keys = HashSet::new();
    for baseline in &self.persistence.file_baselines {
      if baseline.profile_id != self.run.profile_id
        || baseline.commit_oid.is_some()
        || baseline.blob_key.trim().is_empty()
        || baseline.content_hash.trim().is_empty()
        || !file_baseline_ids.insert(baseline.id)
        || !file_baseline_keys.insert(baseline.blob_key.as_str())
      {
        return Err(format!(
          "file baseline {} has duplicate, empty, incorrectly owned or revision-bound facts",
          baseline.id
        ));
      }
    }
    let file_baseline_deletes = self
      .persistence
      .file_baseline_deletes
      .iter()
      .map(String::as_str)
      .collect::<HashSet<_>>();
    if file_baseline_deletes.len() != self.persistence.file_baseline_deletes.len()
      || file_baseline_deletes
        .iter()
        .any(|key| key.trim().is_empty() || file_baseline_keys.contains(key))
    {
      return Err("file baseline deletion draft contains duplicate, empty or concurrently active keys".to_string());
    }
    let mut file_conflict_ids = HashSet::new();
    for conflict in &self.persistence.file_conflicts {
      if conflict.profile_id != self.run.profile_id
        || conflict.run_id != self.run.id
        || conflict.repo_path.trim().is_empty()
        || !file_conflict_ids.insert(conflict.id)
      {
        return Err(format!("file conflict {} crosses draft ownership", conflict.id));
      }
    }
    let mut version_link_ids = HashSet::new();
    for link in &self.persistence.version_links {
      if link.profile_id != self.run.profile_id
        || link.run_id != self.run.id
        || link.git_commit_oid.is_some()
        || link.repo_path.trim().is_empty()
        || link.sync_object_id.trim().is_empty()
        || !matches!(link.sync_object_kind.as_str(), "doc" | "file")
        || !matches!(link.direction.as_str(), "push" | "pull")
        || !version_link_ids.insert(link.id)
      {
        return Err(format!("version link {} has inconsistent draft ownership", link.id));
      }
    }
    let unique_promotions = self.blob_promotion_ids.iter().copied().collect::<HashSet<_>>();
    if unique_promotions.len() != self.blob_promotion_ids.len() {
      return Err("finalization draft contains duplicate blob promotion IDs".to_string());
    }
    if let Some(partial) = &self.partial {
      if partial.run_id != self.run.id {
        return Err("partial finalization belongs to a different run".to_string());
      }
      let completed = partial.completed_item_ids.iter().copied().collect::<HashSet<_>>();
      let failed = partial.failed_item_ids.iter().copied().collect::<HashSet<_>>();
      let conflicted = partial.conflicted_item_ids.iter().copied().collect::<HashSet<_>>();
      if completed.len() != partial.completed_item_ids.len()
        || failed.len() != partial.failed_item_ids.len()
        || conflicted.len() != partial.conflicted_item_ids.len()
        || !completed.is_disjoint(&failed)
        || !completed.is_disjoint(&conflicted)
        || !failed.is_disjoint(&conflicted)
      {
        return Err("partial finalization contains duplicate or contradictory item outcomes".to_string());
      }
    }
    Ok(())
  }

  pub fn bind_remote_oid(mut self, remote_oid: impl Into<String>) -> Result<GitSyncPostPushPlan, String> {
    self.validate()?;
    let remote_oid = remote_oid.into();
    if remote_oid.trim().is_empty() {
      return Err("cannot bind an empty remote OID".to_string());
    }

    self.run.observed_remote_oid = Some(remote_oid.clone());
    self
      .run
      .complete(Some(remote_oid.clone()))
      .map_err(|error| format!("finalize run domain state: {error}"))?;
    for binding in &mut self.persistence.document_bindings {
      binding.last_commit_oid = Some(remote_oid.clone());
    }
    for baseline in &mut self.persistence.file_baselines {
      baseline.commit_oid = Some(remote_oid.clone());
    }
    for link in &mut self.persistence.version_links {
      link.git_commit_oid = Some(remote_oid.clone());
    }
    let document_baselines = self
      .persistence
      .document_baselines
      .into_iter()
      .map(|baseline| GitSyncBaseline {
        binding_id: baseline.binding_id,
        content_hash: baseline.content_hash,
        commit_oid: remote_oid.clone(),
        myoxus_updated_at: baseline.myoxus_updated_at,
        captured_at: baseline.captured_at,
      })
      .collect();
    let plan = GitSyncPostPushPlan {
      run: self.run,
      workspace_id: self.workspace_id,
      expected_job_id: self.expected_job_id,
      document_upserts: self.document_upserts,
      document_deletes: self.document_deletes,
      document_bindings: self.persistence.document_bindings,
      document_tombstone_ids: self.persistence.document_tombstone_ids,
      document_baselines,
      document_conflicts: self.persistence.document_conflicts,
      file_bindings: self.persistence.file_bindings,
      file_tombstone_paths: self.persistence.file_tombstone_paths,
      file_baselines: self.persistence.file_baselines,
      file_baseline_deletes: self.persistence.file_baseline_deletes,
      file_conflicts: self.persistence.file_conflicts,
      version_links: self.persistence.version_links,
      blob_promotion_ids: self.blob_promotion_ids,
      partial: self.partial,
    };
    plan.validate()?;
    Ok(plan)
  }
}

#[derive(Debug, Clone)]
pub struct GitSyncPostPushPlan {
  pub run: GitSyncRun,
  pub workspace_id: Uuid,
  pub expected_job_id: String,
  pub document_upserts: Vec<PreparedDocumentUpsert>,
  pub document_deletes: Vec<Uuid>,
  pub document_bindings: Vec<GitSyncBinding>,
  pub document_tombstone_ids: Vec<Uuid>,
  pub document_baselines: Vec<GitSyncBaseline>,
  pub document_conflicts: Vec<GitSyncConflict>,
  pub file_bindings: Vec<GitSyncFileBinding>,
  pub file_tombstone_paths: Vec<String>,
  pub file_baselines: Vec<GitSyncFileBaseline>,
  pub file_baseline_deletes: Vec<String>,
  pub file_conflicts: Vec<GitSyncFileConflict>,
  pub version_links: Vec<GitSyncVersionLink>,
  pub blob_promotion_ids: Vec<Uuid>,
  pub partial: Option<PartialItemFinalization>,
}

impl GitSyncPostPushPlan {
  /// Validate cross-aggregate ownership and remote-revision invariants before
  /// infrastructure opens the final transaction.
  pub fn validate(&self) -> Result<(), String> {
    if self.expected_job_id.trim().is_empty() {
      return Err("post-push plan has no queue job identity".to_string());
    }
    if self.run.status != myoxus_domain::git_sync::RunStatus::Completed {
      return Err(format!("post-push plan run is {}, expected Completed", self.run.status));
    }
    if self.run.reconciliation_required {
      return Err("normal post-push plan cannot require reconciliation".to_string());
    }
    let remote_oid = self
      .run
      .observed_remote_oid
      .as_deref()
      .filter(|oid| !oid.trim().is_empty())
      .ok_or_else(|| "post-push plan has no observed remote OID".to_string())?;
    if self.run.commit_after.as_deref() != Some(remote_oid) {
      return Err("commit_after does not equal the observed remote OID".to_string());
    }

    let mut upserts = HashSet::new();
    for document in &self.document_upserts {
      if document.workspace_id != self.workspace_id {
        return Err(format!("document {} belongs to a different workspace", document.doc_id));
      }
      if !upserts.insert(document.doc_id) {
        return Err(format!(
          "document {} appears more than once in the post-push plan",
          document.doc_id
        ));
      }
    }
    let deletes = self.document_deletes.iter().copied().collect::<HashSet<_>>();
    if let Some(doc_id) = upserts.intersection(&deletes).next() {
      return Err(format!("document {doc_id} is both upserted and deleted"));
    }
    for binding in &self.document_bindings {
      if binding.profile_id != self.run.profile_id || binding.workspace_id != self.workspace_id {
        return Err(format!("document binding {} crosses plan ownership", binding.id));
      }
      if binding.last_commit_oid.as_deref() != Some(remote_oid) {
        return Err(format!("document binding {} has a stale remote OID", binding.id));
      }
    }
    for baseline in &self.document_baselines {
      if baseline.commit_oid != remote_oid {
        return Err(format!(
          "document baseline {} has a stale remote OID",
          baseline.binding_id
        ));
      }
    }
    for conflict in &self.document_conflicts {
      if conflict.profile_id != self.run.profile_id {
        return Err(format!("document conflict {} crosses plan ownership", conflict.id));
      }
    }
    for binding in &self.file_bindings {
      if binding.profile_id != self.run.profile_id || binding.workspace_id != self.workspace_id {
        return Err(format!("file binding {} crosses plan ownership", binding.id));
      }
    }
    for baseline in &self.file_baselines {
      if baseline.profile_id != self.run.profile_id || baseline.commit_oid.as_deref() != Some(remote_oid) {
        return Err(format!(
          "file baseline {} has inconsistent ownership or remote OID",
          baseline.id
        ));
      }
    }
    for conflict in &self.file_conflicts {
      if conflict.profile_id != self.run.profile_id || conflict.run_id != self.run.id {
        return Err(format!("file conflict {} crosses plan ownership", conflict.id));
      }
    }
    for link in &self.version_links {
      if link.profile_id != self.run.profile_id
        || link.run_id != self.run.id
        || link.git_commit_oid.as_deref() != Some(remote_oid)
      {
        return Err(format!(
          "version link {} has inconsistent ownership or remote OID",
          link.id
        ));
      }
    }
    let unique_promotions = self.blob_promotion_ids.iter().copied().collect::<HashSet<_>>();
    if unique_promotions.len() != self.blob_promotion_ids.len() {
      return Err("post-push plan contains duplicate blob promotion IDs".to_string());
    }
    if let Some(partial) = &self.partial
      && partial.run_id != self.run.id
    {
      return Err("partial finalization belongs to a different run".to_string());
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_domain::git_sync::{GitSyncRunSource, RunStatus, SyncDirection};

  fn running_run(profile_id: Uuid, job_id: &str) -> GitSyncRun {
    GitSyncRun {
      id: Uuid::new_v4(),
      profile_id,
      direction: SyncDirection::Bidirectional,
      trigger_source: GitSyncRunSource::Manual,
      scheduled_for: None,
      status: RunStatus::Running,
      started_at: Utc::now(),
      finished_at: None,
      commit_before: Some("1".repeat(40)),
      commit_after: None,
      observed_remote_oid: None,
      reconciliation_required: false,
      reconciliation_reason: None,
      docs_created: 1,
      docs_updated: 0,
      docs_deleted: 0,
      conflicts_found: 0,
      error_message: None,
      error_class: None,
      job_id: Some(job_id.to_string()),
    }
  }

  fn document_draft() -> GitSyncRunFinalizationDraft {
    let profile_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let job_id = "git-sync-finalization-test";
    let binding_id = Uuid::new_v4();
    GitSyncRunFinalizationDraft {
      run: running_run(profile_id, job_id),
      workspace_id,
      expected_job_id: job_id.to_string(),
      document_upserts: vec![],
      document_deletes: vec![],
      persistence: GitSyncPersistenceDraft {
        document_bindings: vec![GitSyncBinding {
          id: binding_id,
          profile_id,
          workspace_id,
          doc_id: Uuid::new_v4(),
          sync_id: Uuid::new_v4(),
          repo_path: "content/draft.md".to_string(),
          last_commit_oid: None,
          content_hash: Some("a".repeat(64)),
          structure_hash: Some("b".repeat(64)),
          tombstone: false,
          created_at: Utc::now(),
          updated_at: Utc::now(),
        }],
        document_baselines: vec![DocumentBaselineDraft {
          binding_id,
          content_hash: "a".repeat(64),
          myoxus_updated_at: Utc::now(),
          captured_at: Utc::now(),
        }],
        ..GitSyncPersistenceDraft::default()
      },
      blob_promotion_ids: vec![],
      partial: None,
    }
  }

  #[test]
  fn remote_oid_binding_is_pure_and_uses_the_verified_rebased_revision() {
    let draft = document_draft();
    let remote_oid = "f".repeat(40);
    let plan = draft.bind_remote_oid(remote_oid.clone()).expect("bind remote receipt");

    assert_eq!(plan.run.status, RunStatus::Completed);
    assert_eq!(plan.run.commit_after.as_deref(), Some(remote_oid.as_str()));
    assert_eq!(plan.run.observed_remote_oid.as_deref(), Some(remote_oid.as_str()));
    assert_eq!(
      plan.document_bindings[0].last_commit_oid.as_deref(),
      Some(remote_oid.as_str())
    );
    assert_eq!(plan.document_baselines[0].commit_oid, remote_oid);
  }

  #[test]
  fn draft_validation_rejects_a_removed_outbound_path_before_receipt_binding() {
    let mut draft = document_draft();
    draft.persistence.document_bindings[0].repo_path.clear();

    assert!(draft.validate().is_err());
    assert!(draft.bind_remote_oid("f".repeat(40)).is_err());
  }

  #[test]
  fn draft_validation_rejects_duplicate_promotion_ownership() {
    let mut draft = document_draft();
    let promotion_id = Uuid::new_v4();
    draft.blob_promotion_ids = vec![promotion_id, promotion_id];

    assert!(draft.validate().is_err());
  }
}
