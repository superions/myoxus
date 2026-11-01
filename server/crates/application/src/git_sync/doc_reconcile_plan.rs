// SPDX-License-Identifier: AGPL-3.0-or-later
//! Git Sync document reconcile planning.
//!
//! This module plans document-level sync actions from already-loaded Myoxus
//! and Git state. It deliberately performs no Git, database, blob-store or
//! worker orchestration; the API git-sync engine owns runtime execution.

use std::collections::HashMap;

use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use super::import::{ImportClassification, parse_imported_file};
use super::reconcile::{
  BaselineState, ReconcileAction, SideState, reconcile_binding, reconcile_binding_with_git_baseline,
};
use myoxus_domain::git_sync::*;

/// Output of pure document reconciliation planning.
#[derive(Debug)]
pub struct DocReconcilePlan {
  pub run_id: Uuid,
  pub status: RunStatus,
  pub docs_created: i32,
  pub docs_updated: i32,
  pub docs_deleted: i32,
  pub conflicts_found: i32,
  pub error_message: Option<String>,
  pub error_class: Option<ErrorClass>,
  pub commit_oid: Option<String>,
  /// The full list of reconciled actions. The API git-sync engine executes
  /// these actions and records only successfully applied side effects.
  pub actions: Vec<SyncAction>,
}

/// A single document action to be executed by the API git-sync engine.
#[derive(Debug, Clone)]
pub struct SyncAction {
  /// Binding ID (nil for new bindings).
  pub binding_id: Uuid,
  /// Document ID in Myoxus.
  pub doc_id: Uuid,
  /// Stable sync ID for Git frontmatter.
  pub sync_id: Uuid,
  /// What to do.
  pub action: ReconcileAction,
  /// Repo path of the source git file (set for CreateInMyoxus/PullToMyoxus).
  pub repo_path: Option<String>,
}

/// Represents a document's state on the Myoxus side.
#[derive(Debug)]
pub struct MyoxusDocState {
  pub doc_id: Uuid,
  pub title: String,
  pub markdown: Option<String>,
  pub content_hash: Option<String>,
  /// Organizer folder names from root to the document's parent.
  pub folder_path: Vec<String>,
  /// Stable Organizer folder identities corresponding to `folder_path`.
  pub organizer_folder_ids: Vec<String>,
  /// Stable Organizer link-row identity; absent only for unlinked documents.
  pub organizer_entry_id: Option<String>,
  /// Canonical outbound path allocated by the batch planner.
  pub planned_repo_path: Option<String>,
}

/// Plan a document sync run from already-loaded state.
///
/// This is a **pure reconciliation function** — it compares Myoxus and Git
/// states, determines the correct action for each document, and returns
/// aggregate counts. It does NOT perform I/O (no file writes, no DB updates,
/// no Git operations).
///
/// The caller (API git-sync engine) is responsible for:
/// 1. Loading all inputs (docs, bindings, baselines, git files)
/// 2. Calling this function to get the reconciled action list
/// 3. Executing the actions (write files, create bindings, update baselines)
/// 4. Persisting the run status after the plan was applied
///
/// Returns a [`DocReconcilePlan`] containing both aggregate counts and the full
/// [`SyncAction`] list in `result.actions`.
#[instrument(skip(myoxus_docs, existing_bindings, baselines, git_files))]
pub fn plan_doc_sync(
  profile: &GitSyncProfile,
  myoxus_docs: &[MyoxusDocState],
  existing_bindings: &[GitSyncBinding],
  baselines: &[(BindingId, BaselineState)],
  git_files: &[(String, String)], // (repo_path, file_content)
) -> DocReconcilePlan {
  plan_doc_sync_for_direction(
    profile,
    profile.sync_direction,
    myoxus_docs,
    existing_bindings,
    baselines,
    git_files,
  )
}

/// Plan a run with its persisted effective direction. Automatic outgoing
/// sources can therefore reuse a bidirectional profile without enabling any
/// inbound actions. `git_files` must be the complete ordinary inventory after
/// manifest-derived overview classification; a filename or marker alone cannot
/// authorize exclusion. Operational callers fail classification before this planner.
#[instrument(skip(myoxus_docs, existing_bindings, baselines, git_files))]
pub fn plan_doc_sync_for_direction(
  profile: &GitSyncProfile,
  direction: SyncDirection,
  myoxus_docs: &[MyoxusDocState],
  existing_bindings: &[GitSyncBinding],
  baselines: &[(BindingId, BaselineState)],
  git_files: &[(String, String)],
) -> DocReconcilePlan {
  let mut result = DocReconcilePlan {
    run_id: Uuid::new_v4(),
    status: RunStatus::Running,
    docs_created: 0,
    docs_updated: 0,
    docs_deleted: 0,
    conflicts_found: 0,
    error_message: None,
    error_class: None,
    commit_oid: None,
    actions: Vec::new(),
  };

  info!(
      profile_id = %profile.id,
      direction = %direction,
      myoxus_docs = myoxus_docs.len(),
      git_files = git_files.len(),
      bindings = existing_bindings.len(),
      "planning document sync"
  );

  // Build lookup maps (LOW-04: O(1) lookups instead of O(n*m) linear scans)
  let baseline_map: HashMap<BindingId, &BaselineState> = baselines.iter().map(|(id, b)| (*id, b)).collect();

  // Parse git files
  let git_parsed: Vec<_> = git_files
    .iter()
    .filter_map(|(path, content)| match parse_imported_file(path, content) {
      Ok(doc) => Some(doc),
      Err(e) => {
        warn!(path, error = %e, "failed to parse git file");
        None
      }
    })
    .collect();

  // Index-based lookup maps for O(1) matching
  let myoxus_by_doc_id: HashMap<Uuid, &MyoxusDocState> = myoxus_docs.iter().map(|d| (d.doc_id, d)).collect();
  let git_by_sync_id: HashMap<Uuid, &super::import::ImportedDoc> = git_parsed
    .iter()
    .filter_map(|g| g.sync_id.map(|sid| (sid, g)))
    .collect();
  let git_by_path = git_parsed
    .iter()
    .map(|document| (document.repo_path.as_str(), document))
    .collect::<HashMap<_, _>>();
  let git_by_doc_id: HashMap<Uuid, &super::import::ImportedDoc> =
    git_parsed.iter().filter_map(|g| g.doc_id.map(|did| (did, g))).collect();
  let active_binding_doc_ids: std::collections::HashSet<Uuid> = existing_bindings
    .iter()
    .filter(|b| !b.tombstone)
    .map(|b| b.doc_id)
    .collect();
  let active_binding_sync_ids: std::collections::HashSet<Uuid> = existing_bindings
    .iter()
    .filter(|b| !b.tombstone)
    .map(|b| b.sync_id)
    .collect();
  let myoxus_doc_ids: std::collections::HashSet<Uuid> = myoxus_docs.iter().map(|d| d.doc_id).collect();

  // Match bindings and reconcile
  let mut actions = Vec::new();
  let mut matched_binding_paths = std::collections::HashSet::new();

  // For each existing binding, find both sides
  for binding in existing_bindings {
    if binding.tombstone {
      continue;
    }

    let myoxus_state = myoxus_by_doc_id
      .get(&binding.doc_id)
      .map(|d| SideState {
        exists: true,
        content_hash: d.content_hash.clone(),
        content: d.markdown.clone(),
      })
      .unwrap_or(SideState {
        exists: false,
        content_hash: None,
        content: None,
      });

    // A plain Markdown file does not gain frontmatter merely by being pulled.
    // Its existing authorized binding owns this path on subsequent reads.
    // Never use this fallback for a file claiming a different sync identity.
    let matched_git = git_by_sync_id.get(&binding.sync_id).copied().or_else(|| {
      git_by_path
        .get(binding.repo_path.as_str())
        .copied()
        .filter(|document| document.classification == ImportClassification::NewDoc)
    });
    if let Some(document) = matched_git {
      matched_binding_paths.insert(document.repo_path.as_str());
    }
    let git_state = matched_git
      .map(|g| SideState {
        exists: true,
        content_hash: Some(g.content_hash.clone()),
        content: Some(g.markdown.clone()),
      })
      .unwrap_or(SideState {
        exists: false,
        content_hash: None,
        content: None,
      });

    let baseline = baseline_map.get(&binding.id).copied();
    let action = reconcile_binding_with_git_baseline(
      &myoxus_state,
      &git_state,
      baseline,
      binding.content_hash.as_deref(),
      direction,
    );

    let inbound_path = matches!(action, ReconcileAction::PullToMyoxus)
      .then(|| matched_git.map(|document| document.repo_path.clone()))
      .flatten();
    actions.push((binding.id, binding.doc_id, binding.sync_id, action, inbound_path));
  }

  // Direction policy checks
  let can_push = matches!(direction, SyncDirection::Bidirectional | SyncDirection::MyoxusToGit);
  let can_pull = matches!(direction, SyncDirection::Bidirectional | SyncDirection::GitToMyoxus);

  // Handle new docs in Myoxus (no binding yet)
  for doc in myoxus_docs {
    if active_binding_doc_ids.contains(&doc.doc_id) {
      continue; // already handled by the binding loop above
    }

    // P53-C: Check if a git file already references this doc_id (e.g., binding
    // was not loaded but the file exists with matching frontmatter). This prevents
    // inflated CreateInGit counts on re-sync when bindings are stale/missing.
    if let Some(matched_git) = git_by_doc_id.get(&doc.doc_id) {
      // File already exists in git for this doc — reconcile content instead
      // of blindly creating a new file.
      let myoxus_state = SideState {
        exists: true,
        content_hash: doc.content_hash.clone(),
        content: doc.markdown.clone(),
      };
      let git_state = SideState {
        exists: true,
        content_hash: Some(matched_git.content_hash.clone()),
        content: Some(matched_git.markdown.clone()),
      };
      let action = reconcile_binding(&myoxus_state, &git_state, None, direction);
      let sync_id = matched_git.sync_id.unwrap_or_else(Uuid::new_v4);
      debug!(
        doc_id = %doc.doc_id,
        sync_id = %sync_id,
        ?action,
        "Myoxus doc matched git file by doc_id (no binding) — reconciling"
      );
      actions.push((
        Uuid::nil(),
        doc.doc_id,
        sync_id,
        action,
        Some(matched_git.repo_path.clone()),
      ));
      continue;
    }

    let action = if can_push {
      ReconcileAction::CreateInGit
    } else {
      debug!(doc_id = %doc.doc_id, "new Myoxus doc skipped by direction policy");
      ReconcileAction::SkippedByPolicy
    };
    actions.push((Uuid::nil(), doc.doc_id, Uuid::new_v4(), action, None));
  }

  // Handle new files in Git (no matching binding)
  for parsed in &git_parsed {
    if matched_binding_paths.contains(parsed.repo_path.as_str()) {
      continue;
    }
    // P53-A: ExistingDoc files whose sync_id has no matching binding should
    // be treated as new docs (e.g., file created by a different profile or
    // externally with valid frontmatter but no binding in this profile).
    let has_binding = parsed.sync_id.is_some_and(|sid| active_binding_sync_ids.contains(&sid));

    // P53-C: Skip git files already matched by doc_id in the Myoxus docs loop above
    let already_matched_by_doc_id = parsed.doc_id.is_some_and(|did| myoxus_doc_ids.contains(&did));
    if already_matched_by_doc_id {
      continue;
    }

    if parsed.classification == ImportClassification::NewDoc
      || (parsed.classification == ImportClassification::ExistingDoc && !has_binding)
    {
      if !can_pull {
        debug!(repo_path = %parsed.repo_path, "new Git file skipped by direction policy");
        continue;
      }
      if parsed.classification == ImportClassification::ExistingDoc && !has_binding {
        debug!(
          repo_path = %parsed.repo_path,
          sync_id = ?parsed.sync_id,
          "ExistingDoc with no binding — treating as CreateInMyoxus"
        );
      }
      // For ExistingDoc without binding, preserve the sync_id from frontmatter
      let sync_id = parsed.sync_id.unwrap_or_else(Uuid::new_v4);
      let doc_id = parsed.doc_id.unwrap_or_else(Uuid::new_v4);
      actions.push((
        Uuid::nil(),
        doc_id,
        sync_id,
        ReconcileAction::CreateInMyoxus,
        Some(parsed.repo_path.clone()),
      ));
    }
  }

  // Count results
  for (_, _, _, action, _) in &actions {
    match action {
      ReconcileAction::CreateInGit | ReconcileAction::CreateInMyoxus => {
        result.docs_created += 1;
      }
      ReconcileAction::PushToGit | ReconcileAction::PullToMyoxus => {
        result.docs_updated += 1;
      }
      ReconcileAction::DeleteInGit | ReconcileAction::DeleteInMyoxus => {
        result.docs_deleted += 1;
      }
      ReconcileAction::Conflict(_) | ReconcileAction::DeleteConflict(_) => {
        result.conflicts_found += 1;
      }
      _ => {}
    }
  }

  result.actions = actions
    .into_iter()
    .map(|(binding_id, doc_id, sync_id, action, repo_path)| SyncAction {
      binding_id,
      doc_id,
      sync_id,
      action,
      repo_path,
    })
    .collect();
  result.status = RunStatus::Completed;
  info!(
    created = result.docs_created,
    updated = result.docs_updated,
    deleted = result.docs_deleted,
    conflicts = result.conflicts_found,
    actions = result.actions.len(),
    "sync run completed"
  );

  result
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Utc;

  // ── Helpers ──────────────────────────────────────────────────────────

  fn make_profile(direction: SyncDirection) -> GitSyncProfile {
    let now = Utc::now();
    GitSyncProfile {
      id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      owner_id: Uuid::new_v4(),
      repo_url: "https://example.com/repo.git".into(),
      branch: "main".into(),
      root_path: "content/".into(),
      manifest_path: crate::git_sync::export::GIT_SYNC_MANIFEST_PATH.into(),
      scope_revision: 0,
      sync_direction: direction,
      trigger_mode: TriggerMode::Manual,
      polling_interval_secs: None,
      cron_expression: None,
      cron_timezone: None,
      cron_misfire_policy: None,
      cron_next_scheduled_at: None,
      cron_pending_misfire_scheduled_for: None,
      auth_method: AuthMethod::HttpsToken,
      credential_id: None,
      enabled: true,
      max_mirror_storage_mb: None,
      created_at: now,
      updated_at: now,
    }
  }

  fn make_binding(profile_id: ProfileId, doc_id: Uuid, sync_id: Uuid) -> GitSyncBinding {
    let now = Utc::now();
    GitSyncBinding {
      id: Uuid::new_v4(),
      profile_id,
      workspace_id: Uuid::new_v4(),
      doc_id,
      sync_id,
      repo_path: "content/test.md".into(),
      last_commit_oid: None,
      content_hash: Some("oldhash".into()),
      structure_hash: None,
      tombstone: false,
      created_at: now,
      updated_at: now,
    }
  }

  fn make_myoxus_doc(doc_id: Uuid, title: &str, hash: &str) -> MyoxusDocState {
    MyoxusDocState {
      doc_id,
      title: title.into(),
      markdown: Some(format!("# {title}\n\nContent")),
      content_hash: Some(hash.into()),
      folder_path: vec![],
      organizer_folder_ids: vec![],
      organizer_entry_id: None,
      planned_repo_path: None,
    }
  }

  // ── Empty inputs → no-op result ─────────────────────────────────────

  #[test]
  fn empty_inputs_produces_noop_result() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let result = plan_doc_sync(&profile, &[], &[], &[], &[]);

    assert_eq!(result.status, RunStatus::Completed);
    assert_eq!(result.docs_created, 0);
    assert_eq!(result.docs_updated, 0);
    assert_eq!(result.docs_deleted, 0);
    assert_eq!(result.conflicts_found, 0);
    assert!(result.error_message.is_none());
  }

  // ── Myoxus docs only → all CreateInGit ──────────────────────────────

  #[test]
  fn myoxus_docs_only_creates_in_git() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let doc1 = make_myoxus_doc(Uuid::new_v4(), "Doc One", "hash1");
    let doc2 = make_myoxus_doc(Uuid::new_v4(), "Doc Two", "hash2");

    let result = plan_doc_sync(&profile, &[doc1, doc2], &[], &[], &[]);

    assert_eq!(result.status, RunStatus::Completed);
    assert_eq!(result.docs_created, 2);
    assert_eq!(result.docs_updated, 0);
    assert_eq!(result.docs_deleted, 0);
  }

  // ── Git files only → all CreateInMyoxus ─────────────────────────────

  #[test]
  fn git_files_only_creates_in_myoxus() {
    let profile = make_profile(SyncDirection::Bidirectional);
    // Files without frontmatter = NewDoc classification
    let git_files = vec![
      ("content/new-doc.md".to_string(), "# New Doc\n\nHello\n".to_string()),
      ("content/another.md".to_string(), "# Another\n\nWorld\n".to_string()),
    ];

    let result = plan_doc_sync(&profile, &[], &[], &[], &git_files);

    assert_eq!(result.status, RunStatus::Completed);
    assert_eq!(result.docs_created, 2);
  }

  // ── Matching content → NoChange ─────────────────────────────────────

  #[test]
  fn matching_content_produces_no_change() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let doc_id = Uuid::new_v4();
    let sync_id = Uuid::new_v4();
    let ws_id = profile.workspace_id;

    // Both sides have same content hash
    let content = "# Test\n\nSame content\n";
    let hash = crate::markdown::content_hash(content);

    let myoxus_doc = MyoxusDocState {
      doc_id,
      title: "Test".into(),
      markdown: Some(content.into()),
      content_hash: Some(hash.clone()),
      folder_path: vec![],
      organizer_folder_ids: vec![],
      organizer_entry_id: None,
      planned_repo_path: None,
    };

    // Build a git file with frontmatter so it gets classified as ExistingDoc
    let frontmatter =
      format!("---\nsync_id: {sync_id}\ndoc_id: {doc_id}\nworkspace_id: {ws_id}\ntitle: \"Test\"\n---\n{content}");

    let mut binding = make_binding(profile.id, doc_id, sync_id);
    binding.content_hash = Some(hash.clone());
    let baseline = (
      binding.id,
      BaselineState {
        content_hash: hash.clone(),
      },
    );

    let git_files = vec![("content/test.md".to_string(), frontmatter)];

    let result = plan_doc_sync(&profile, &[myoxus_doc], &[binding], &[baseline], &git_files);

    assert_eq!(result.status, RunStatus::Completed);
    assert_eq!(result.docs_created, 0);
    assert_eq!(result.docs_updated, 0);
    assert_eq!(result.docs_deleted, 0);
    assert_eq!(result.conflicts_found, 0);
  }

  // ── Tombstoned bindings are skipped ─────────────────────────────────

  #[test]
  fn tombstoned_bindings_are_skipped() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let doc_id = Uuid::new_v4();
    let sync_id = Uuid::new_v4();

    let mut binding = make_binding(profile.id, doc_id, sync_id);
    binding.tombstone = true;

    let myoxus_doc = make_myoxus_doc(doc_id, "Test", "hash1");

    let result = plan_doc_sync(&profile, &[myoxus_doc], &[binding], &[], &[]);

    // The tombstoned binding is skipped, so the doc appears as "new" → CreateInGit
    assert_eq!(result.docs_created, 1);
  }

  // ── P21-15f: Full-workspace completeness — no docs silently skipped ─

  #[test]
  fn all_myoxus_docs_produce_actions() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let docs: Vec<MyoxusDocState> = (0..5)
      .map(|i| make_myoxus_doc(Uuid::new_v4(), &format!("Doc {i}"), &format!("hash{i}")))
      .collect();

    let result = plan_doc_sync(&profile, &docs, &[], &[], &[]);

    // All 5 docs should produce CreateInGit actions
    assert_eq!(
      result.docs_created, 5,
      "all docs must be processed, none silently skipped"
    );
    assert_eq!(result.status, RunStatus::Completed);
  }

  #[test]
  fn all_git_files_produce_actions() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let git_files: Vec<(String, String)> = (0..4)
      .map(|i| (format!("content/doc-{i}.md"), format!("# Doc {i}\n\nContent {i}\n")))
      .collect();

    let result = plan_doc_sync(&profile, &[], &[], &[], &git_files);

    assert_eq!(
      result.docs_created, 4,
      "all git files must be processed, none silently skipped"
    );
  }

  #[test]
  fn mixed_inputs_all_accounted_for() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let doc_id = Uuid::new_v4();
    let sync_id = Uuid::new_v4();
    let ws_id = profile.workspace_id;

    // 1 existing binding with matching content (NoChange)
    let hash = crate::markdown::content_hash("# Existing\n\nSame\n");
    let myoxus_existing = MyoxusDocState {
      doc_id,
      title: "Existing".into(),
      markdown: Some("# Existing\n\nSame\n".into()),
      content_hash: Some(hash.clone()),
      folder_path: vec![],
      organizer_folder_ids: vec![],
      organizer_entry_id: None,
      planned_repo_path: None,
    };
    let mut binding = make_binding(profile.id, doc_id, sync_id);
    binding.content_hash = Some(hash.clone());
    let baseline = (
      binding.id,
      BaselineState {
        content_hash: hash.clone(),
      },
    );
    let git_existing = format!(
      "---\nsync_id: {sync_id}\ndoc_id: {doc_id}\nworkspace_id: {ws_id}\ntitle: \"Existing\"\n---\n# Existing\n\nSame\n"
    );

    // 1 new Myoxus doc (CreateInGit)
    let new_doc = make_myoxus_doc(Uuid::new_v4(), "New Doc", "newhash");

    // 1 new Git file (CreateInMyoxus)
    let new_git = ("content/from-git.md".to_string(), "# From Git\n\nHello\n".to_string());

    let result = plan_doc_sync(
      &profile,
      &[myoxus_existing, new_doc],
      &[binding],
      &[baseline],
      &[("content/existing.md".into(), git_existing), new_git],
    );

    // 1 CreateInGit + 1 CreateInMyoxus = 2 created, 0 updated, 0 conflicts
    assert_eq!(result.docs_created, 2);
    assert_eq!(result.docs_updated, 0);
    assert_eq!(result.conflicts_found, 0);
    assert_eq!(result.status, RunStatus::Completed);
  }

  // ── P53-A: ExistingDoc with no binding → CreateInMyoxus ────────────

  #[test]
  fn existing_doc_without_binding_creates_in_myoxus() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let sync_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let ws_id = profile.workspace_id;

    // Git file has valid frontmatter (ExistingDoc) but NO binding exists
    let frontmatter = format!(
      "---\nsync_id: {sync_id}\ndoc_id: {doc_id}\nworkspace_id: {ws_id}\ntitle: \"Orphan\"\n---\n# Orphan\n\nContent\n"
    );
    let git_files = vec![("content/orphan.md".to_string(), frontmatter)];

    let result = plan_doc_sync(&profile, &[], &[], &[], &git_files);

    assert_eq!(
      result.docs_created, 1,
      "ExistingDoc without binding must create in Myoxus"
    );
    assert!(
      result
        .actions
        .iter()
        .any(|a| a.action == ReconcileAction::CreateInMyoxus),
      "action must be CreateInMyoxus"
    );
    // Preserve the original sync_id from frontmatter
    assert!(
      result.actions.iter().any(|a| a.sync_id == sync_id),
      "sync_id from frontmatter must be preserved"
    );
  }

  #[test]
  fn existing_doc_with_binding_not_duplicated() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let doc_id = Uuid::new_v4();
    let sync_id = Uuid::new_v4();
    let ws_id = profile.workspace_id;
    let hash = crate::markdown::content_hash("# Bound\n\nContent\n");

    let mut binding = make_binding(profile.id, doc_id, sync_id);
    binding.content_hash = Some(hash.clone());
    let baseline = (
      binding.id,
      BaselineState {
        content_hash: hash.clone(),
      },
    );

    let myoxus_doc = MyoxusDocState {
      doc_id,
      title: "Bound".into(),
      markdown: Some("# Bound\n\nContent\n".into()),
      content_hash: Some(hash.clone()),
      folder_path: vec![],
      organizer_folder_ids: vec![],
      organizer_entry_id: None,
      planned_repo_path: None,
    };

    let frontmatter = format!(
      "---\nsync_id: {sync_id}\ndoc_id: {doc_id}\nworkspace_id: {ws_id}\ntitle: \"Bound\"\n---\n# Bound\n\nContent\n"
    );
    let git_files = vec![("content/bound.md".to_string(), frontmatter)];
    let result = plan_doc_sync(&profile, &[myoxus_doc], &[binding], &[baseline], &git_files);
    assert_eq!(result.docs_created, 0, "bound doc must not be re-created");
  }

  // ── P53-B: SyncAction includes repo_path for new git files ────────

  #[test]
  fn new_git_file_action_has_repo_path() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let git_files = vec![("content/new-file.md".to_string(), "# New\n\nHello\n".to_string())];

    let result = plan_doc_sync(&profile, &[], &[], &[], &git_files);

    assert_eq!(result.docs_created, 1);
    let action = &result.actions[0];
    assert_eq!(action.action, ReconcileAction::CreateInMyoxus);
    assert_eq!(
      action.repo_path.as_deref(),
      Some("content/new-file.md"),
      "repo_path must be set for new git files"
    );
  }

  // ── CreateInGit action has repo_path=None (derived by persist layer from title)

  #[test]
  fn create_in_git_action_has_no_repo_path() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let doc = make_myoxus_doc(Uuid::new_v4(), "My Document", "hash1");

    let result = plan_doc_sync(&profile, &[doc], &[], &[], &[]);

    assert_eq!(result.docs_created, 1);
    let action = &result.actions[0];
    assert_eq!(action.action, ReconcileAction::CreateInGit);
    assert!(
      action.repo_path.is_none(),
      "CreateInGit must have repo_path=None (derived from doc title by persist layer)"
    );
  }

  // ── CreateInMyoxus action carries actual git file path (not derived from title)

  #[test]
  fn create_in_myoxus_action_has_actual_git_path() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let git_files = vec![
      (
        "content/projektplan-q1.md".to_string(),
        "# Projektplan Q1\n\nDetails\n".to_string(),
      ),
      (
        "content/subfolder/notes.md".to_string(),
        "# Notes\n\nMore\n".to_string(),
      ),
    ];

    let result = plan_doc_sync(&profile, &[], &[], &[], &git_files);

    assert_eq!(result.docs_created, 2);
    for action in &result.actions {
      assert_eq!(action.action, ReconcileAction::CreateInMyoxus);
      assert!(
        action.repo_path.is_some(),
        "CreateInMyoxus must carry the actual git file path"
      );
    }
    let paths: Vec<_> = result.actions.iter().filter_map(|a| a.repo_path.as_deref()).collect();
    assert!(paths.contains(&"content/projektplan-q1.md"), "must contain actual path");
    assert!(
      paths.contains(&"content/subfolder/notes.md"),
      "must contain subfolder path"
    );
  }

  // ── P53-C: Re-sync with matching doc_id → NoChange, not CreateInGit

  #[test]
  fn resync_doc_with_matching_git_file_no_duplicate_create() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let doc_id = Uuid::new_v4();
    let sync_id = Uuid::new_v4();
    let ws_id = profile.workspace_id;
    let content = "# Re-synced\n\nSame content\n";
    let hash = crate::markdown::content_hash(content);

    // Myoxus doc exists but has NO binding
    let myoxus_doc = MyoxusDocState {
      doc_id,
      title: "Re-synced".into(),
      markdown: Some(content.into()),
      content_hash: Some(hash.clone()),
      folder_path: vec![],
      organizer_folder_ids: vec![],
      organizer_entry_id: None,
      planned_repo_path: None,
    };

    // Git file references this doc_id in frontmatter, same content
    let frontmatter =
      format!("---\nsync_id: {sync_id}\ndoc_id: {doc_id}\nworkspace_id: {ws_id}\ntitle: \"Re-synced\"\n---\n{content}");
    let git_files = vec![("content/re-synced.md".to_string(), frontmatter)];

    // NO bindings passed — simulates stale/missing binding state
    let result = plan_doc_sync(&profile, &[myoxus_doc], &[], &[], &git_files);

    // Both sides have same content → NoChange, NOT CreateInGit + CreateInMyoxus
    assert_eq!(result.docs_created, 0, "matching content must not inflate create count");
    assert_eq!(result.docs_updated, 0);
    // Should produce NoChange action, not CreateInGit
    assert!(
      !result.actions.iter().any(|a| a.action == ReconcileAction::CreateInGit),
      "must not generate CreateInGit when git file already exists for this doc"
    );
  }

  // ── P53-C-02: Re-sync counter — no duplicate CreateInGit actions ────

  #[test]
  fn resync_with_existing_bindings_and_matching_content_no_duplicate_create() {
    // Scenario: Initial sync produced CreateInGit actions.
    // On re-sync, bindings now exist and content matches on both sides.
    // Verify: no CreateInGit actions are generated (all should be NoChange).
    let profile = make_profile(SyncDirection::Bidirectional);
    let doc_id = Uuid::new_v4();
    let sync_id = Uuid::new_v4();
    let ws_id = profile.workspace_id;
    let content = "# Doc\n\nContent\n";
    let hash = crate::markdown::content_hash(content);

    // Myoxus doc exists
    let myoxus_doc = MyoxusDocState {
      doc_id,
      title: "Doc".into(),
      markdown: Some(content.into()),
      content_hash: Some(hash.clone()),
      folder_path: vec![],
      organizer_folder_ids: vec![],
      organizer_entry_id: None,
      planned_repo_path: None,
    };

    // Binding exists (was created during first sync)
    let mut binding = make_binding(profile.id, doc_id, sync_id);
    binding.content_hash = Some(hash.clone());
    let baseline = (
      binding.id,
      BaselineState {
        content_hash: hash.clone(),
      },
    );

    // Git file exists with same content
    let frontmatter =
      format!("---\nsync_id: {sync_id}\ndoc_id: {doc_id}\nworkspace_id: {ws_id}\ntitle: \"Doc\"\n---\n{content}");
    let git_files = vec![("content/doc.md".to_string(), frontmatter)];

    let result = plan_doc_sync(&profile, &[myoxus_doc], &[binding], &[baseline], &git_files);

    // With matching content and existing binding+baseline, no creates should occur
    assert_eq!(
      result.docs_created, 0,
      "re-sync with matching content must not create duplicates"
    );
    assert_eq!(result.docs_updated, 0, "re-sync with matching content must not update");
    assert!(
      !result.actions.iter().any(|a| a.action == ReconcileAction::CreateInGit),
      "must not generate CreateInGit when binding exists and content matches"
    );
  }

  // ── P51-D-08: Both sides changed with baseline → Conflict ──────────

  #[test]
  fn both_changed_produces_conflict() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let doc_id = Uuid::new_v4();
    let sync_id = Uuid::new_v4();
    let ws_id = profile.workspace_id;

    // Baseline content hash (the last known common state)
    let baseline_content = "# Doc\n\nOriginal content\n";
    let baseline_hash = crate::markdown::content_hash(baseline_content);

    // Myoxus doc has DIFFERENT content than baseline
    let myoxus_content = "# Doc\n\nMyoxus edited version\n";
    let myoxus_hash = crate::markdown::content_hash(myoxus_content);
    assert_ne!(myoxus_hash, baseline_hash, "precondition: myoxus differs from baseline");

    let myoxus_doc = MyoxusDocState {
      doc_id,
      title: "Doc".into(),
      markdown: Some(myoxus_content.into()),
      content_hash: Some(myoxus_hash),
      folder_path: vec![],
      organizer_folder_ids: vec![],
      organizer_entry_id: None,
      planned_repo_path: None,
    };

    // Git file has DIFFERENT content than both baseline and Myoxus
    let git_content = "# Doc\n\nGit edited version\n";
    let git_hash = crate::markdown::content_hash(git_content);
    assert_ne!(git_hash, baseline_hash, "precondition: git differs from baseline");
    assert_ne!(
      git_hash,
      crate::markdown::content_hash(myoxus_content),
      "precondition: git differs from myoxus"
    );

    let frontmatter =
      format!("---\nsync_id: {sync_id}\ndoc_id: {doc_id}\nworkspace_id: {ws_id}\ntitle: \"Doc\"\n---\n{git_content}");
    let git_files = vec![("content/doc.md".to_string(), frontmatter)];

    // Binding exists with baseline pointing to original content
    let binding = make_binding(profile.id, doc_id, sync_id);
    let baseline = (
      binding.id,
      BaselineState {
        content_hash: baseline_hash,
      },
    );

    let result = plan_doc_sync(&profile, &[myoxus_doc], &[binding], &[baseline], &git_files);

    assert_eq!(result.status, RunStatus::Completed);
    assert_eq!(result.conflicts_found, 1, "both sides changed → must detect conflict");
    assert!(
      result
        .actions
        .iter()
        .any(|a| matches!(a.action, ReconcileAction::Conflict(_))),
      "must produce Conflict action type"
    );
    assert_eq!(result.docs_created, 0, "conflict must not create");
    assert_eq!(result.docs_updated, 0, "conflict must not update");
  }

  #[test]
  fn resync_doc_with_changed_git_file_produces_conflict() {
    let profile = make_profile(SyncDirection::Bidirectional);
    let doc_id = Uuid::new_v4();
    let sync_id = Uuid::new_v4();
    let ws_id = profile.workspace_id;

    // Myoxus doc
    let myoxus_doc = MyoxusDocState {
      doc_id,
      title: "Doc".into(),
      markdown: Some("# Doc\n\nMyoxus version\n".into()),
      content_hash: Some(crate::markdown::content_hash("# Doc\n\nMyoxus version\n")),
      folder_path: vec![],
      organizer_folder_ids: vec![],
      organizer_entry_id: None,
      planned_repo_path: None,
    };

    // Git file with different content
    let frontmatter = format!(
      "---\nsync_id: {sync_id}\ndoc_id: {doc_id}\nworkspace_id: {ws_id}\ntitle: \"Doc\"\n---\n# Doc\n\nGit version\n"
    );
    let git_files = vec![("content/doc.md".to_string(), frontmatter)];

    let result = plan_doc_sync(&profile, &[myoxus_doc], &[], &[], &git_files);

    // Different content, no baseline → conflict (not 2x create)
    assert_eq!(result.docs_created, 0, "must not create when content differs");
    assert_eq!(
      result.conflicts_found, 1,
      "different content without baseline → conflict"
    );
  }
}
