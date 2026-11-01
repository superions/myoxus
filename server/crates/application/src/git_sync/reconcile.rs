// SPDX-License-Identifier: AGPL-3.0-or-later
//! Reconcile engine: 3-way comparison between Myoxus, Git, and Baseline.
//!
//! Determines the correct action for each document binding by comparing
//! content hashes against the last known baseline state.

use myoxus_domain::git_sync::{ConflictType, SyncDirection};
use tracing::{debug, info, instrument};

/// The state of a document on one side (Myoxus or Git).
#[derive(Debug, Clone)]
pub struct SideState {
  pub exists: bool,
  pub content_hash: Option<String>,
  pub content: Option<String>, // Markdown content for conflict display
}

/// The baseline (last known common state).
#[derive(Debug, Clone)]
pub struct BaselineState {
  pub content_hash: String,
}

/// Result of reconciling a single document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconcileAction {
  /// No changes on either side.
  NoChange,
  /// Only Myoxus changed — push to Git.
  PushToGit,
  /// Only Git changed — pull to Myoxus.
  PullToMyoxus,
  /// New document in Myoxus — create in Git.
  CreateInGit,
  /// New document in Git — create in Myoxus.
  CreateInMyoxus,
  /// Deleted in Myoxus — delete in Git.
  DeleteInGit,
  /// Deleted in Git — delete in Myoxus.
  DeleteInMyoxus,
  /// Both sides changed — conflict.
  Conflict(ConflictType),
  /// Deleted on one side, modified on other — conflict.
  DeleteConflict(ConflictType),
  /// Skipped due to sync direction policy.
  SkippedByPolicy,
}

/// Reconcile a single document binding.
#[instrument(skip(myoxus, git, baseline))]
pub fn reconcile_binding(
  myoxus: &SideState,
  git: &SideState,
  baseline: Option<&BaselineState>,
  direction: SyncDirection,
) -> ReconcileAction {
  reconcile_binding_with_git_baseline(myoxus, git, baseline, None, direction)
}

/// Reconcile a document whose Git source spelling may differ from its
/// normalized Myoxus projection.
///
/// `git_baseline_hash` is the exact body hash last observed in Git. The
/// regular baseline remains the normalized hash produced by the Myoxus
/// loader. Keeping the two observations separate prevents harmless Markdown
/// normalization from looking like a new remote edit on every run.
#[instrument(skip(myoxus, git, baseline))]
pub fn reconcile_binding_with_git_baseline(
  myoxus: &SideState,
  git: &SideState,
  baseline: Option<&BaselineState>,
  git_baseline_hash: Option<&str>,
  direction: SyncDirection,
) -> ReconcileAction {
  // Direction filtering
  let can_push = matches!(direction, SyncDirection::Bidirectional | SyncDirection::MyoxusToGit);
  let can_pull = matches!(direction, SyncDirection::Bidirectional | SyncDirection::GitToMyoxus);

  match (myoxus.exists, git.exists) {
    // Both exist
    (true, true) => {
      let myoxus_hash = myoxus.content_hash.as_deref();
      let git_hash = git.content_hash.as_deref();

      if let Some(base) = baseline {
        let git_base = git_baseline_hash.unwrap_or(&base.content_hash);
        let myoxus_changed = myoxus_hash.is_none_or(|h| h != base.content_hash);
        let git_changed = git_hash.is_none_or(|h| h != git_base);

        match (myoxus_changed, git_changed) {
          (true, false) => {
            if can_push {
              ReconcileAction::PushToGit
            } else {
              ReconcileAction::SkippedByPolicy
            }
          }
          (false, true) => {
            if can_pull {
              ReconcileAction::PullToMyoxus
            } else {
              ReconcileAction::SkippedByPolicy
            }
          }
          (true, true) => {
            if myoxus_hash == git_hash {
              debug!("both sides converged on identical content");
              return ReconcileAction::NoChange;
            }
            info!("both sides changed — conflict");
            ReconcileAction::Conflict(ConflictType::BothModified)
          }
          (false, false) => {
            debug!("both sides match their last observed representations");
            ReconcileAction::NoChange
          }
        }
      } else {
        // LOW-01: without a baseline, equal Option values are genuinely
        // identical; differing values are an unresolved first-sync conflict.
        if myoxus_hash != git_hash {
          info!("no baseline, content differs — conflict");
          ReconcileAction::Conflict(ConflictType::BothModified)
        } else {
          ReconcileAction::NoChange
        }
      }
    }

    // Only in Myoxus
    (true, false) => {
      if let Some(base) = baseline {
        // Was in baseline → deleted in Git
        if can_pull {
          let myoxus_changed = myoxus.content_hash.as_deref() != Some(&base.content_hash);
          if myoxus_changed {
            ReconcileAction::DeleteConflict(ConflictType::ModifyVsDelete)
          } else {
            ReconcileAction::DeleteInMyoxus
          }
        } else {
          ReconcileAction::SkippedByPolicy
        }
      } else {
        // New in Myoxus
        if can_push {
          ReconcileAction::CreateInGit
        } else {
          ReconcileAction::SkippedByPolicy
        }
      }
    }

    // Only in Git
    (false, true) => {
      if let Some(base) = baseline {
        // Was in baseline → deleted in Myoxus
        if can_push {
          let git_base = git_baseline_hash.unwrap_or(&base.content_hash);
          let git_changed = git.content_hash.as_deref() != Some(git_base);
          if git_changed {
            ReconcileAction::DeleteConflict(ConflictType::DeleteVsModify)
          } else {
            ReconcileAction::DeleteInGit
          }
        } else {
          ReconcileAction::SkippedByPolicy
        }
      } else {
        // New in Git
        if can_pull {
          ReconcileAction::CreateInMyoxus
        } else {
          ReconcileAction::SkippedByPolicy
        }
      }
    }

    // Neither exists (shouldn't happen, but handle gracefully)
    (false, false) => {
      debug!("both sides missing — nothing to do");
      ReconcileAction::NoChange
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // ── Helpers ──────────────────────────────────────────────────────────

  fn side(exists: bool, hash: &str) -> SideState {
    SideState {
      exists,
      content_hash: if exists { Some(hash.to_string()) } else { None },
      content: None,
    }
  }

  fn absent() -> SideState {
    SideState {
      exists: false,
      content_hash: None,
      content: None,
    }
  }

  fn baseline(hash: &str) -> BaselineState {
    BaselineState {
      content_hash: hash.to_string(),
    }
  }

  // ── Both exist, identical ───────────────────────────────────────────

  #[test]
  fn both_identical_no_change() {
    let action = reconcile_binding(
      &side(true, "abc"),
      &side(true, "abc"),
      Some(&baseline("abc")),
      SyncDirection::Bidirectional,
    );
    assert_eq!(action, ReconcileAction::NoChange);
  }

  #[test]
  fn both_identical_no_baseline_no_change() {
    let action = reconcile_binding(
      &side(true, "abc"),
      &side(true, "abc"),
      None,
      SyncDirection::Bidirectional,
    );
    assert_eq!(action, ReconcileAction::NoChange);
  }

  // ── Only Myoxus changed ─────────────────────────────────────────────

  #[test]
  fn only_myoxus_changed_push_to_git() {
    let action = reconcile_binding(
      &side(true, "new"),
      &side(true, "old"),
      Some(&baseline("old")),
      SyncDirection::Bidirectional,
    );
    assert_eq!(action, ReconcileAction::PushToGit);
  }

  #[test]
  fn only_myoxus_changed_myoxus_to_git_direction() {
    let action = reconcile_binding(
      &side(true, "new"),
      &side(true, "old"),
      Some(&baseline("old")),
      SyncDirection::MyoxusToGit,
    );
    assert_eq!(action, ReconcileAction::PushToGit);
  }

  #[test]
  fn only_myoxus_changed_git_to_myoxus_skipped() {
    let action = reconcile_binding(
      &side(true, "new"),
      &side(true, "old"),
      Some(&baseline("old")),
      SyncDirection::GitToMyoxus,
    );
    assert_eq!(action, ReconcileAction::SkippedByPolicy);
  }

  // ── Only Git changed ────────────────────────────────────────────────

  #[test]
  fn only_git_changed_pull_to_myoxus() {
    let action = reconcile_binding(
      &side(true, "old"),
      &side(true, "new"),
      Some(&baseline("old")),
      SyncDirection::Bidirectional,
    );
    assert_eq!(action, ReconcileAction::PullToMyoxus);
  }

  #[test]
  fn only_git_changed_git_to_myoxus_direction() {
    let action = reconcile_binding(
      &side(true, "old"),
      &side(true, "new"),
      Some(&baseline("old")),
      SyncDirection::GitToMyoxus,
    );
    assert_eq!(action, ReconcileAction::PullToMyoxus);
  }

  #[test]
  fn only_git_changed_myoxus_to_git_skipped() {
    let action = reconcile_binding(
      &side(true, "old"),
      &side(true, "new"),
      Some(&baseline("old")),
      SyncDirection::MyoxusToGit,
    );
    assert_eq!(action, ReconcileAction::SkippedByPolicy);
  }

  // ── Both changed — conflict ─────────────────────────────────────────

  #[test]
  fn both_changed_conflict() {
    let action = reconcile_binding(
      &side(true, "m_new"),
      &side(true, "g_new"),
      Some(&baseline("old")),
      SyncDirection::Bidirectional,
    );
    assert_eq!(action, ReconcileAction::Conflict(ConflictType::BothModified));
  }

  #[test]
  fn no_baseline_content_differs_conflict() {
    let action = reconcile_binding(
      &side(true, "m_ver"),
      &side(true, "g_ver"),
      None,
      SyncDirection::Bidirectional,
    );
    assert_eq!(action, ReconcileAction::Conflict(ConflictType::BothModified));
  }

  // ── New in Myoxus (no baseline) — create in Git ─────────────────────

  #[test]
  fn new_in_myoxus_create_in_git() {
    let action = reconcile_binding(&side(true, "new"), &absent(), None, SyncDirection::Bidirectional);
    assert_eq!(action, ReconcileAction::CreateInGit);
  }

  #[test]
  fn new_in_myoxus_git_to_myoxus_skipped() {
    let action = reconcile_binding(&side(true, "new"), &absent(), None, SyncDirection::GitToMyoxus);
    assert_eq!(action, ReconcileAction::SkippedByPolicy);
  }

  // ── New in Git (no baseline) — create in Myoxus ─────────────────────

  #[test]
  fn new_in_git_create_in_myoxus() {
    let action = reconcile_binding(&absent(), &side(true, "new"), None, SyncDirection::Bidirectional);
    assert_eq!(action, ReconcileAction::CreateInMyoxus);
  }

  #[test]
  fn new_in_git_myoxus_to_git_skipped() {
    let action = reconcile_binding(&absent(), &side(true, "new"), None, SyncDirection::MyoxusToGit);
    assert_eq!(action, ReconcileAction::SkippedByPolicy);
  }

  // ── Deleted in Git, Myoxus unchanged — delete in Myoxus ─────────────

  #[test]
  fn deleted_in_git_myoxus_unchanged_delete_in_myoxus() {
    let action = reconcile_binding(
      &side(true, "old"),
      &absent(),
      Some(&baseline("old")),
      SyncDirection::Bidirectional,
    );
    assert_eq!(action, ReconcileAction::DeleteInMyoxus);
  }

  #[test]
  fn deleted_in_git_myoxus_to_git_skipped() {
    let action = reconcile_binding(
      &side(true, "old"),
      &absent(),
      Some(&baseline("old")),
      SyncDirection::MyoxusToGit,
    );
    assert_eq!(action, ReconcileAction::SkippedByPolicy);
  }

  // ── Deleted in Git, Myoxus modified — delete conflict ───────────────

  #[test]
  fn deleted_in_git_myoxus_modified_delete_conflict() {
    let action = reconcile_binding(
      &side(true, "modified"),
      &absent(),
      Some(&baseline("old")),
      SyncDirection::Bidirectional,
    );
    assert_eq!(action, ReconcileAction::DeleteConflict(ConflictType::ModifyVsDelete));
  }

  // ── Deleted in Myoxus, Git unchanged — delete in Git ────────────────

  #[test]
  fn deleted_in_myoxus_git_unchanged_delete_in_git() {
    let action = reconcile_binding(
      &absent(),
      &side(true, "old"),
      Some(&baseline("old")),
      SyncDirection::Bidirectional,
    );
    assert_eq!(action, ReconcileAction::DeleteInGit);
  }

  #[test]
  fn deleted_in_myoxus_git_to_myoxus_skipped() {
    let action = reconcile_binding(
      &absent(),
      &side(true, "old"),
      Some(&baseline("old")),
      SyncDirection::GitToMyoxus,
    );
    assert_eq!(action, ReconcileAction::SkippedByPolicy);
  }

  // ── Deleted in Myoxus, Git modified — delete conflict ───────────────

  #[test]
  fn deleted_in_myoxus_git_modified_delete_conflict() {
    let action = reconcile_binding(
      &absent(),
      &side(true, "modified"),
      Some(&baseline("old")),
      SyncDirection::Bidirectional,
    );
    assert_eq!(action, ReconcileAction::DeleteConflict(ConflictType::DeleteVsModify));
  }

  // ── Both missing ────────────────────────────────────────────────────

  #[test]
  fn both_missing_no_change() {
    let action = reconcile_binding(&absent(), &absent(), None, SyncDirection::Bidirectional);
    assert_eq!(action, ReconcileAction::NoChange);
  }

  #[test]
  fn both_missing_with_baseline_no_change() {
    let action = reconcile_binding(
      &absent(),
      &absent(),
      Some(&baseline("old")),
      SyncDirection::Bidirectional,
    );
    assert_eq!(action, ReconcileAction::NoChange);
  }

  // ── Direction policy edge cases ─────────────────────────────────────

  #[test]
  fn both_changed_conflict_regardless_of_direction() {
    // Conflicts are reported even with restricted direction
    for dir in [
      SyncDirection::Bidirectional,
      SyncDirection::MyoxusToGit,
      SyncDirection::GitToMyoxus,
    ] {
      let action = reconcile_binding(&side(true, "m_new"), &side(true, "g_new"), Some(&baseline("old")), dir);
      assert_eq!(
        action,
        ReconcileAction::Conflict(ConflictType::BothModified),
        "conflict should be reported for direction {dir}"
      );
    }
  }

  #[test]
  fn create_in_git_requires_push_direction() {
    let m = side(true, "new");
    let g = absent();

    let bidi = reconcile_binding(&m, &g, None, SyncDirection::Bidirectional);
    assert_eq!(bidi, ReconcileAction::CreateInGit);

    let m2g = reconcile_binding(&m, &g, None, SyncDirection::MyoxusToGit);
    assert_eq!(m2g, ReconcileAction::CreateInGit);

    let g2m = reconcile_binding(&m, &g, None, SyncDirection::GitToMyoxus);
    assert_eq!(g2m, ReconcileAction::SkippedByPolicy);
  }

  #[test]
  fn create_in_myoxus_requires_pull_direction() {
    let m = absent();
    let g = side(true, "new");

    let bidi = reconcile_binding(&m, &g, None, SyncDirection::Bidirectional);
    assert_eq!(bidi, ReconcileAction::CreateInMyoxus);

    let g2m = reconcile_binding(&m, &g, None, SyncDirection::GitToMyoxus);
    assert_eq!(g2m, ReconcileAction::CreateInMyoxus);

    let m2g = reconcile_binding(&m, &g, None, SyncDirection::MyoxusToGit);
    assert_eq!(m2g, ReconcileAction::SkippedByPolicy);
  }
}
