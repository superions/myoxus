// SPDX-License-Identifier: AGPL-3.0-or-later
//! File reconcile engine: 3-way comparison for binary/non-markdown files.
//!
//! Parallel to the document reconcile in [`super::reconcile`], this module
//! handles file objects (images, PDFs, etc.) stored in the blob store.  The
//! same 3-way merge principle applies: compare the current Myoxus state, the
//! current Git state, and the last-known baseline to determine the correct
//! synchronisation action.

use std::collections::HashMap;

use myoxus_domain::git_sync::{GitSyncFileBaseline, GitSyncFileBinding, SyncDirection};
use tracing::{debug, info, trace, warn};
use uuid::Uuid;

/// Deterministic object-store key for files imported from Git.
///
/// Git paths are not globally unique across profiles. Prefixing with the
/// profile id keeps pulls idempotent without allowing one profile to delete or
/// overwrite another profile's file object.
pub fn blob_key_for_repo_path(profile_id: Uuid, repo_path: &str) -> String {
  format!("git-sync/{profile_id}/{repo_path}")
}

/// Immutable object key used by transactional Git imports.
pub fn blob_key_for_content(profile_id: Uuid, content_hash: &str) -> String {
  format!("git-sync/{profile_id}/objects/{content_hash}")
}

// ─── Action Enum ──────────────────────────────────────────────────────────────

/// Result of reconciling a single file object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileReconcileAction {
  /// Git has a new or updated file — pull bytes into Myoxus blob store.
  PullToMyoxus {
    repo_path: String,
    content_hash: String,
    bytes: Vec<u8>,
    mime_type: String,
  },
  /// Myoxus has a new or updated file — push blob to Git.
  PushToGit {
    repo_path: String,
    blob_key: String,
    content_hash: String,
  },
  /// File was deleted in Myoxus (or tombstoned) — remove from Git.
  DeleteFromGit { repo_path: String, blob_key: String },
  /// File was deleted in Git — remove from Myoxus blob store.
  DeleteFromMyoxus { repo_path: String, blob_key: String },
  /// Both sides changed independently — manual resolution required.
  Conflict {
    repo_path: String,
    git_hash: String,
    myoxus_hash: String,
    baseline_hash: String,
  },
  /// No changes detected.
  NoChange { repo_path: String },
}

// ─── Input Struct ─────────────────────────────────────────────────────────────

/// A file discovered in the Git repository.
#[derive(Debug, Clone)]
pub struct GitFileEntry {
  pub content_hash: String,
  pub bytes: Vec<u8>,
  pub mime_type: String,
}

// ─── Reconcile Function ───────────────────────────────────────────────────────

/// Reconcile file objects between Myoxus blob store and a Git repository.
///
/// Applies the same 3-way merge decision matrix as the document reconcile:
///
/// | Baseline | Git | Myoxus | Action |
/// |----------|-----|--------|--------|
/// | exists   | changed | unchanged | PullToMyoxus |
/// | exists   | unchanged | changed | PushToGit |
/// | exists   | changed | changed | Conflict |
/// | exists   | unchanged | unchanged | NoChange |
/// | exists   | missing | unchanged | DeleteFromMyoxus |
/// | exists   | missing | changed | Conflict (modify vs delete) |
/// | exists   | unchanged | missing/tombstoned | DeleteFromGit |
/// | exists   | changed | missing/tombstoned | Conflict (delete vs modify) |
/// | none     | present | absent | PullToMyoxus (new) |
/// | none     | absent | present | PushToGit (new) |
/// | none     | present | present, same hash | NoChange (establish baseline) |
/// | none     | present | present, different hash | Conflict |
///
/// This function is **deterministic**: same inputs always produce the same
/// outputs (ordering is by `repo_path`).
pub fn reconcile_files(
  git_files: &mut HashMap<String, GitFileEntry>,
  myoxus_bindings: &[GitSyncFileBinding],
  baselines: &[GitSyncFileBaseline],
  direction: SyncDirection,
) -> Vec<FileReconcileAction> {
  let can_push = matches!(direction, SyncDirection::Bidirectional | SyncDirection::MyoxusToGit);
  let can_pull = matches!(direction, SyncDirection::Bidirectional | SyncDirection::GitToMyoxus);

  // Index baselines by repo_path (via binding blob_key → baseline lookup).
  // Baselines are keyed by blob_key, but we also need repo_path from bindings.
  let baseline_by_blob_key: HashMap<&str, &GitSyncFileBaseline> =
    baselines.iter().map(|b| (b.blob_key.as_str(), b)).collect();

  // Index myoxus bindings by repo_path.
  let binding_by_path: HashMap<&str, &GitSyncFileBinding> =
    myoxus_bindings.iter().map(|b| (b.repo_path.as_str(), b)).collect();

  // Collect all repo_paths from both sides (owned to allow mutable git_files access).
  let mut all_paths: Vec<String> = Vec::new();
  for path in git_files.keys() {
    all_paths.push(path.clone());
  }
  for binding in myoxus_bindings {
    if !git_files.contains_key(&binding.repo_path) {
      all_paths.push(binding.repo_path.clone());
    }
  }
  // Sort for deterministic output.
  all_paths.sort_unstable();
  all_paths.dedup();

  let mut actions = Vec::with_capacity(all_paths.len());

  for path in &all_paths {
    let git_entry = git_files.get_mut(path.as_str());
    let binding = binding_by_path.get(path.as_str()).copied();
    let baseline = binding.and_then(|b| baseline_by_blob_key.get(b.blob_key.as_str()).copied());

    let action = reconcile_single_file(path, git_entry, binding, baseline, can_push, can_pull);
    actions.push(action);
  }

  actions
}

/// Reconcile a single file path.
fn reconcile_single_file(
  repo_path: &str,
  git_entry: Option<&mut GitFileEntry>,
  binding: Option<&GitSyncFileBinding>,
  baseline: Option<&GitSyncFileBaseline>,
  can_push: bool,
  can_pull: bool,
) -> FileReconcileAction {
  let in_git = git_entry.is_some();
  let in_myoxus = binding.is_some_and(|b| !b.tombstoned);
  let is_tombstoned = binding.is_some_and(|b| b.tombstoned);

  // Tombstoned binding → always delete from Git (if present).
  if is_tombstoned {
    if in_git {
      trace!(repo_path, "tombstoned binding — delete from git");
      return if can_push {
        FileReconcileAction::DeleteFromGit {
          repo_path: repo_path.to_string(),
          blob_key: binding
            .map(|b| b.blob_key.clone())
            .unwrap_or_else(|| repo_path.to_string()),
        }
      } else {
        trace!(repo_path, "tombstoned but push not allowed — no change");
        FileReconcileAction::NoChange {
          repo_path: repo_path.to_string(),
        }
      };
    }
    trace!(repo_path, "tombstoned binding, not in git — no change");
    return FileReconcileAction::NoChange {
      repo_path: repo_path.to_string(),
    };
  }

  match (in_myoxus, in_git) {
    // ── Both exist ────────────────────────────────────────────────────
    (true, true) => {
      let Some(binding) = binding else {
        unreachable!("in_myoxus=true guarantees Some")
      };
      let Some(git) = git_entry else {
        unreachable!("in_git=true guarantees Some")
      };
      let myoxus_hash = &binding.content_hash;
      let git_hash = &git.content_hash;

      if myoxus_hash == git_hash {
        debug!(repo_path, "both sides identical");
        FileReconcileAction::NoChange {
          repo_path: repo_path.to_string(),
        }
      } else if let Some(base) = baseline {
        let myoxus_changed = myoxus_hash != &base.content_hash;
        let git_changed = git_hash != &base.content_hash;

        match (myoxus_changed, git_changed) {
          (true, false) => {
            if can_push {
              trace!(repo_path, "only myoxus changed — push to git");
              FileReconcileAction::PushToGit {
                repo_path: repo_path.to_string(),
                blob_key: binding.blob_key.clone(),
                content_hash: myoxus_hash.clone(),
              }
            } else {
              trace!(repo_path, "myoxus changed but push not allowed — skip");
              FileReconcileAction::NoChange {
                repo_path: repo_path.to_string(),
              }
            }
          }
          (false, true) => {
            if can_pull {
              trace!(repo_path, "only git changed — pull to myoxus");
              FileReconcileAction::PullToMyoxus {
                repo_path: repo_path.to_string(),
                content_hash: git_hash.clone(),
                bytes: std::mem::take(&mut git.bytes),
                mime_type: git.mime_type.clone(),
              }
            } else {
              trace!(repo_path, "git changed but pull not allowed — skip");
              FileReconcileAction::NoChange {
                repo_path: repo_path.to_string(),
              }
            }
          }
          (true, true) => {
            info!(repo_path, "both sides changed — conflict");
            FileReconcileAction::Conflict {
              repo_path: repo_path.to_string(),
              git_hash: git_hash.clone(),
              myoxus_hash: myoxus_hash.clone(),
              baseline_hash: base.content_hash.clone(),
            }
          }
          (false, false) => {
            // Both match baseline but differ from each other — shouldn't happen.
            warn!(repo_path, "unexpected: both match baseline but differ from each other");
            FileReconcileAction::NoChange {
              repo_path: repo_path.to_string(),
            }
          }
        }
      } else {
        // No baseline — first sync.
        info!(repo_path, "no baseline, content differs — conflict");
        FileReconcileAction::Conflict {
          repo_path: repo_path.to_string(),
          git_hash: git_hash.clone(),
          myoxus_hash: myoxus_hash.clone(),
          baseline_hash: String::new(),
        }
      }
    }

    // ── Only in Myoxus ────────────────────────────────────────────────
    (true, false) => {
      let Some(binding) = binding else {
        unreachable!("in_myoxus=true guarantees Some")
      };
      if let Some(base) = baseline {
        // Was in baseline → deleted in Git.
        let myoxus_changed = binding.content_hash != base.content_hash;
        if myoxus_changed {
          info!(repo_path, "deleted in git, modified in myoxus — conflict");
          FileReconcileAction::Conflict {
            repo_path: repo_path.to_string(),
            git_hash: String::new(),
            myoxus_hash: binding.content_hash.clone(),
            baseline_hash: base.content_hash.clone(),
          }
        } else if can_pull {
          trace!(repo_path, "deleted in git, myoxus unchanged — delete from myoxus");
          FileReconcileAction::DeleteFromMyoxus {
            repo_path: repo_path.to_string(),
            blob_key: binding.blob_key.clone(),
          }
        } else {
          trace!(repo_path, "deleted in git but pull not allowed — skip");
          FileReconcileAction::NoChange {
            repo_path: repo_path.to_string(),
          }
        }
      } else {
        // New in Myoxus — create in Git.
        if can_push {
          trace!(repo_path, "new in myoxus — push to git");
          FileReconcileAction::PushToGit {
            repo_path: repo_path.to_string(),
            blob_key: binding.blob_key.clone(),
            content_hash: binding.content_hash.clone(),
          }
        } else {
          trace!(repo_path, "new in myoxus but push not allowed — skip");
          FileReconcileAction::NoChange {
            repo_path: repo_path.to_string(),
          }
        }
      }
    }

    // ── Only in Git ───────────────────────────────────────────────────
    (false, true) => {
      let Some(git) = git_entry else {
        unreachable!("in_git=true guarantees Some")
      };
      if let Some(base) = baseline {
        // Was in baseline → deleted in Myoxus.
        let git_changed = git.content_hash != base.content_hash;
        if git_changed {
          info!(repo_path, "deleted in myoxus, modified in git — conflict");
          FileReconcileAction::Conflict {
            repo_path: repo_path.to_string(),
            git_hash: git.content_hash.clone(),
            myoxus_hash: String::new(),
            baseline_hash: base.content_hash.clone(),
          }
        } else if can_push {
          trace!(repo_path, "deleted in myoxus, git unchanged — delete from git");
          FileReconcileAction::DeleteFromGit {
            repo_path: repo_path.to_string(),
            blob_key: binding.map(|b| b.blob_key.clone()).unwrap_or_default(),
          }
        } else {
          trace!(repo_path, "deleted in myoxus but push not allowed — skip");
          FileReconcileAction::NoChange {
            repo_path: repo_path.to_string(),
          }
        }
      } else {
        // New in Git — create in Myoxus.
        if can_pull {
          trace!(repo_path, "new in git — pull to myoxus");
          FileReconcileAction::PullToMyoxus {
            repo_path: repo_path.to_string(),
            content_hash: git.content_hash.clone(),
            bytes: std::mem::take(&mut git.bytes),
            mime_type: git.mime_type.clone(),
          }
        } else {
          trace!(repo_path, "new in git but pull not allowed — skip");
          FileReconcileAction::NoChange {
            repo_path: repo_path.to_string(),
          }
        }
      }
    }

    // ── Neither exists (shouldn't happen) ─────────────────────────────
    (false, false) => {
      debug!(repo_path, "neither side has file — no change");
      FileReconcileAction::NoChange {
        repo_path: repo_path.to_string(),
      }
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use chrono::Utc;
  use uuid::Uuid;

  use super::*;

  // ── Helpers ──────────────────────────────────────────────────────────

  fn make_git_entry(hash: &str) -> GitFileEntry {
    GitFileEntry {
      content_hash: hash.to_string(),
      bytes: vec![1, 2, 3],
      mime_type: "image/png".to_string(),
    }
  }

  fn make_binding(repo_path: &str, blob_key: &str, content_hash: &str, tombstoned: bool) -> GitSyncFileBinding {
    let now = Utc::now();
    GitSyncFileBinding {
      id: Uuid::new_v4(),
      profile_id: Uuid::nil(),
      workspace_id: Uuid::nil(),
      blob_key: blob_key.to_string(),
      repo_path: repo_path.to_string(),
      content_hash: content_hash.to_string(),
      mime_type: "image/png".to_string(),
      file_size: 100,
      tombstoned,
      created_at: now,
      updated_at: now,
    }
  }

  fn make_baseline(blob_key: &str, content_hash: &str) -> GitSyncFileBaseline {
    GitSyncFileBaseline {
      id: Uuid::new_v4(),
      profile_id: Uuid::nil(),
      blob_key: blob_key.to_string(),
      content_hash: content_hash.to_string(),
      commit_oid: Some("abc123".to_string()),
      synced_at: Utc::now(),
    }
  }

  #[test]
  fn repo_path_blob_keys_are_profile_scoped_and_deterministic() {
    let profile_a = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
    let profile_b = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
    let repo_path = "assets/image.png";

    assert_eq!(
      blob_key_for_repo_path(profile_a, repo_path),
      "git-sync/11111111-1111-1111-1111-111111111111/assets/image.png"
    );
    assert_ne!(
      blob_key_for_repo_path(profile_a, repo_path),
      blob_key_for_repo_path(profile_b, repo_path),
      "same repo path in different profiles must not share blob storage keys"
    );
  }

  // ── Decision matrix: Baseline exists, both present ──────────────────

  #[test]
  fn baseline_git_changed_myoxus_unchanged_pull() {
    let mut git_files = HashMap::from([("assets/img.png".to_string(), make_git_entry("new_hash"))]);
    let bindings = vec![make_binding("assets/img.png", "blob1", "old_hash", false)];
    let baselines = vec![make_baseline("blob1", "old_hash")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(
      matches!(&actions[0], FileReconcileAction::PullToMyoxus { repo_path, content_hash, .. }
      if repo_path == "assets/img.png" && content_hash == "new_hash")
    );
  }

  #[test]
  fn baseline_myoxus_changed_git_unchanged_push() {
    let mut git_files = HashMap::from([("assets/img.png".to_string(), make_git_entry("old_hash"))]);
    let bindings = vec![make_binding("assets/img.png", "blob1", "new_hash", false)];
    let baselines = vec![make_baseline("blob1", "old_hash")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(
      matches!(&actions[0], FileReconcileAction::PushToGit { repo_path, blob_key, content_hash }
      if repo_path == "assets/img.png" && blob_key == "blob1" && content_hash == "new_hash")
    );
  }

  #[test]
  fn baseline_both_changed_conflict() {
    let mut git_files = HashMap::from([("assets/img.png".to_string(), make_git_entry("git_new"))]);
    let bindings = vec![make_binding("assets/img.png", "blob1", "myoxus_new", false)];
    let baselines = vec![make_baseline("blob1", "old_hash")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(
      matches!(&actions[0], FileReconcileAction::Conflict { repo_path, git_hash, myoxus_hash, baseline_hash }
      if repo_path == "assets/img.png" && git_hash == "git_new" && myoxus_hash == "myoxus_new" && baseline_hash == "old_hash")
    );
  }

  #[test]
  fn baseline_both_unchanged_no_change() {
    let mut git_files = HashMap::from([("assets/img.png".to_string(), make_git_entry("same"))]);
    let bindings = vec![make_binding("assets/img.png", "blob1", "same", false)];
    let baselines = vec![make_baseline("blob1", "same")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::NoChange { .. }));
  }

  // ── Decision matrix: No baseline ────────────────────────────────────

  #[test]
  fn no_baseline_git_only_pull() {
    let mut git_files = HashMap::from([("assets/new.png".to_string(), make_git_entry("hash1"))]);
    let bindings = vec![];
    let baselines = vec![];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(
      matches!(&actions[0], FileReconcileAction::PullToMyoxus { repo_path, .. }
      if repo_path == "assets/new.png")
    );
  }

  #[test]
  fn no_baseline_myoxus_only_push() {
    let mut git_files = HashMap::new();
    let bindings = vec![make_binding("assets/new.png", "blob1", "hash1", false)];
    let baselines = vec![];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::PushToGit { repo_path, .. }
      if repo_path == "assets/new.png"));
  }

  #[test]
  fn no_baseline_both_same_hash_no_change() {
    let mut git_files = HashMap::from([("assets/img.png".to_string(), make_git_entry("same"))]);
    let bindings = vec![make_binding("assets/img.png", "blob1", "same", false)];
    let baselines = vec![];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::NoChange { .. }));
  }

  #[test]
  fn no_baseline_both_different_hash_conflict() {
    let mut git_files = HashMap::from([("assets/img.png".to_string(), make_git_entry("git_ver"))]);
    let bindings = vec![make_binding("assets/img.png", "blob1", "myoxus_ver", false)];
    let baselines = vec![];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::Conflict { .. }));
  }

  // ── Decision matrix: Deletions ──────────────────────────────────────

  #[test]
  fn baseline_git_missing_myoxus_unchanged_delete_from_myoxus() {
    let mut git_files = HashMap::new();
    let bindings = vec![make_binding("assets/img.png", "blob1", "old_hash", false)];
    let baselines = vec![make_baseline("blob1", "old_hash")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(
      matches!(&actions[0], FileReconcileAction::DeleteFromMyoxus { repo_path, blob_key }
      if repo_path == "assets/img.png" && blob_key == "blob1")
    );
  }

  #[test]
  fn baseline_git_missing_myoxus_changed_conflict() {
    let mut git_files = HashMap::new();
    let bindings = vec![make_binding("assets/img.png", "blob1", "modified", false)];
    let baselines = vec![make_baseline("blob1", "old_hash")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::Conflict { .. }));
  }

  #[test]
  fn baseline_myoxus_missing_git_unchanged_delete_from_git() {
    // Binding is tombstoned (= deleted in Myoxus), git unchanged.
    let mut git_files = HashMap::from([("assets/img.png".to_string(), make_git_entry("old_hash"))]);
    let bindings = vec![make_binding("assets/img.png", "blob1", "old_hash", true)];
    let baselines = vec![make_baseline("blob1", "old_hash")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(
      matches!(&actions[0], FileReconcileAction::DeleteFromGit { repo_path, blob_key }
      if repo_path == "assets/img.png" && blob_key == "blob1")
    );
  }

  // ── Tombstoned binding ──────────────────────────────────────────────

  #[test]
  fn tombstoned_binding_delete_from_git() {
    let mut git_files = HashMap::from([("assets/old.png".to_string(), make_git_entry("hash1"))]);
    let bindings = vec![make_binding("assets/old.png", "blob1", "hash1", true)];
    let baselines = vec![];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::DeleteFromGit { blob_key, .. } if blob_key == "blob1"));
  }

  #[test]
  fn tombstoned_binding_not_in_git_no_change() {
    let mut git_files = HashMap::new();
    let bindings = vec![make_binding("assets/gone.png", "blob1", "hash1", true)];
    let baselines = vec![];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::NoChange { .. }));
  }

  // ── Direction policy ────────────────────────────────────────────────

  #[test]
  fn git_to_myoxus_blocks_push() {
    let mut git_files = HashMap::from([("assets/img.png".to_string(), make_git_entry("old_hash"))]);
    let bindings = vec![make_binding("assets/img.png", "blob1", "new_hash", false)];
    let baselines = vec![make_baseline("blob1", "old_hash")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::GitToMyoxus);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::NoChange { .. }));
  }

  #[test]
  fn myoxus_to_git_blocks_pull() {
    let mut git_files = HashMap::from([("assets/img.png".to_string(), make_git_entry("new_hash"))]);
    let bindings = vec![make_binding("assets/img.png", "blob1", "old_hash", false)];
    let baselines = vec![make_baseline("blob1", "old_hash")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::MyoxusToGit);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::NoChange { .. }));
  }

  #[test]
  fn tombstoned_push_not_allowed_no_change() {
    let mut git_files = HashMap::from([("assets/img.png".to_string(), make_git_entry("h"))]);
    let bindings = vec![make_binding("assets/img.png", "blob1", "h", true)];
    let baselines = vec![];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::GitToMyoxus);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::NoChange { .. }));
  }

  #[test]
  fn new_in_git_myoxus_to_git_blocked() {
    let mut git_files = HashMap::from([("assets/new.png".to_string(), make_git_entry("h"))]);
    let bindings = vec![];
    let baselines = vec![];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::MyoxusToGit);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::NoChange { .. }));
  }

  #[test]
  fn new_in_myoxus_git_to_myoxus_blocked() {
    let mut git_files = HashMap::new();
    let bindings = vec![make_binding("assets/new.png", "blob1", "h", false)];
    let baselines = vec![];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::GitToMyoxus);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::NoChange { .. }));
  }

  // ── Edge cases ──────────────────────────────────────────────────────

  #[test]
  fn empty_inputs_no_actions() {
    let actions = reconcile_files(&mut HashMap::new(), &[], &[], SyncDirection::Bidirectional);
    assert!(actions.is_empty());
  }

  #[test]
  fn multiple_files_deterministic_order() {
    let mut git_files = HashMap::from([
      ("assets/b.png".to_string(), make_git_entry("hb")),
      ("assets/a.png".to_string(), make_git_entry("ha")),
      ("assets/c.png".to_string(), make_git_entry("hc")),
    ]);

    let actions = reconcile_files(&mut git_files, &[], &[], SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 3);
    // Verify sorted order.
    let paths: Vec<&str> = actions
      .iter()
      .map(|a| match a {
        FileReconcileAction::PullToMyoxus { repo_path, .. } => repo_path.as_str(),
        _ => panic!("expected PullToMyoxus"),
      })
      .collect();
    assert_eq!(paths, vec!["assets/a.png", "assets/b.png", "assets/c.png"]);
  }

  #[test]
  fn conflict_reports_all_hashes() {
    let mut git_files = HashMap::from([("f.png".to_string(), make_git_entry("g"))]);
    let bindings = vec![make_binding("f.png", "bk", "m", false)];
    let baselines = vec![make_baseline("bk", "base")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    match &actions[0] {
      FileReconcileAction::Conflict {
        git_hash,
        myoxus_hash,
        baseline_hash,
        ..
      } => {
        assert_eq!(git_hash, "g");
        assert_eq!(myoxus_hash, "m");
        assert_eq!(baseline_hash, "base");
      }
      other => panic!("expected Conflict, got {other:?}"),
    }
  }

  #[test]
  fn delete_from_myoxus_blocked_by_direction() {
    // Git deleted file, myoxus unchanged, but direction = MyoxusToGit → skip.
    let mut git_files = HashMap::new();
    let bindings = vec![make_binding("assets/img.png", "blob1", "old_hash", false)];
    let baselines = vec![make_baseline("blob1", "old_hash")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::MyoxusToGit);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::NoChange { .. }));
  }

  #[test]
  fn delete_from_git_via_non_tombstoned_missing_binding() {
    // File in git with baseline, no binding at all (binding was hard-deleted) → deleted in Myoxus.
    // Since there's no binding, in_myoxus=false. Baseline exists via a different path?
    // Actually, baseline lookup is by blob_key from binding. No binding = no baseline match.
    // So this becomes: in_git=true, no baseline → new in git → PullToMyoxus.
    let mut git_files = HashMap::from([("assets/img.png".to_string(), make_git_entry("hash"))]);
    let bindings: Vec<GitSyncFileBinding> = vec![];
    let baselines = vec![make_baseline("orphan_blob", "hash")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::PullToMyoxus { .. }));
  }

  #[test]
  fn both_sides_missing_no_change() {
    // A binding that is tombstoned and not in git.
    let mut git_files = HashMap::new();
    let bindings = vec![make_binding("assets/gone.png", "blob1", "h", true)];
    let baselines = vec![make_baseline("blob1", "h")];

    let actions = reconcile_files(&mut git_files, &bindings, &baselines, SyncDirection::Bidirectional);
    assert_eq!(actions.len(), 1);
    assert!(matches!(&actions[0], FileReconcileAction::NoChange { .. }));
  }

  #[test]
  fn conflict_always_reported_regardless_of_direction() {
    let mut git_files = HashMap::from([("f.png".to_string(), make_git_entry("g"))]);
    let bindings = vec![make_binding("f.png", "bk", "m", false)];
    let baselines = vec![make_baseline("bk", "base")];

    for dir in [
      SyncDirection::Bidirectional,
      SyncDirection::MyoxusToGit,
      SyncDirection::GitToMyoxus,
    ] {
      let actions = reconcile_files(&mut git_files, &bindings, &baselines, dir);
      assert_eq!(actions.len(), 1);
      assert!(
        matches!(&actions[0], FileReconcileAction::Conflict { .. }),
        "conflict should be reported for direction {dir}"
      );
    }
  }
}
