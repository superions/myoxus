// SPDX-License-Identifier: AGPL-3.0-or-later
//! Partial-Sync session planning for `max_docs_per_sync`.
//!
//! The sync runner still reconciles against complete state. This module only
//! limits which already-planned document/markdown actions may mutate state in a
//! given run, preventing false deletes/conflicts that would result from slicing
//! loader inputs.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use tracing::{info, instrument};
use uuid::Uuid;

use myoxus_application::git_sync::doc_reconcile_plan::SyncAction;
use myoxus_application::git_sync::finalization::PartialItemFinalization;
use myoxus_application::git_sync::reconcile::ReconcileAction;
use myoxus_domain::git_sync::{
  GitSyncPartialItem, GitSyncPartialSession, PartialItemKind, PartialItemStatus, PartialSessionStatus, SyncDirection,
};
use myoxus_infrastructure::git_sync::SqlxGitSyncStore;

use super::error::SyncError;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PartialActionKey {
  kind: PartialItemKind,
  item_key: String,
}

impl PartialActionKey {
  fn from_item(item: &GitSyncPartialItem) -> Self {
    Self {
      kind: item.item_kind,
      item_key: item.item_key.clone(),
    }
  }
}

#[derive(Debug)]
pub struct PartialBatch {
  pub session: Option<GitSyncPartialSession>,
  pub selected_items: Vec<GitSyncPartialItem>,
  pub selected_keys: HashSet<PartialActionKey>,
  pub has_more: bool,
}

impl PartialBatch {
  pub fn inactive() -> Self {
    Self {
      session: None,
      selected_items: Vec::new(),
      selected_keys: HashSet::new(),
      has_more: false,
    }
  }

  pub fn is_active(&self) -> bool {
    self.session.is_some()
  }
}

#[instrument(skip_all, fields(profile_id = %profile_id, run_id = %run_id, limit = max_items))]
#[allow(clippy::too_many_arguments)]
pub async fn prepare_partial_batch(
  store: &SqlxGitSyncStore,
  profile_id: Uuid,
  direction: SyncDirection,
  run_id: Uuid,
  max_items: usize,
  workspace_watermark: Option<DateTime<Utc>>,
  git_commit_oid: Option<String>,
  planned_actions: &[SyncAction],
) -> Result<PartialBatch, SyncError> {
  let limit = if max_items == 0 { usize::MAX } else { max_items };
  let new_session_id = Uuid::new_v4();
  let actionable_items = build_session_items(new_session_id, profile_id, run_id, planned_actions);
  let open = store
    .get_open_partial_session(profile_id)
    .await
    .map_err(|e| SyncError::permanent(format!("load partial session: {e}"), profile_id, "partial_session"))?;

  if open.is_none() && (max_items == 0 || actionable_items.len() <= max_items) {
    return Ok(PartialBatch::inactive());
  }

  let session = match open {
    Some(session) => session,
    None => {
      let now = Utc::now();
      let session = GitSyncPartialSession {
        id: new_session_id,
        profile_id,
        direction,
        source_workspace_watermark: workspace_watermark,
        source_git_commit_oid: git_commit_oid,
        status: PartialSessionStatus::Open,
        total_items: actionable_items.len() as i32,
        processed_items: 0,
        failed_items: 0,
        created_run_id: run_id,
        last_run_id: Some(run_id),
        created_at: now,
        updated_at: now,
        completed_at: None,
      };
      store
        .create_partial_session_with_items(&session, &actionable_items)
        .await
        .map_err(|e| SyncError::permanent(format!("create partial session: {e}"), profile_id, "partial_session"))?
    }
  };

  let selected_items = store
    .claim_next_partial_items(session.id, run_id, limit)
    .await
    .map_err(|e| SyncError::permanent(format!("claim partial items: {e}"), profile_id, "partial_items"))?;
  let selected_keys = selected_items
    .iter()
    .map(PartialActionKey::from_item)
    .collect::<HashSet<_>>();
  let has_more = (session.processed_items as usize + selected_items.len()) < session.total_items as usize;

  info!(
    session_id = %session.id,
    selected = selected_items.len(),
    total = session.total_items,
    processed = session.processed_items,
    failed = session.failed_items,
    has_more,
    "partial sync batch prepared"
  );

  Ok(PartialBatch {
    session: Some(session),
    selected_items,
    selected_keys,
    has_more,
  })
}

pub fn filter_doc_actions_for_partial(actions: &[SyncAction], batch: &PartialBatch) -> Vec<SyncAction> {
  if !batch.is_active() {
    return actions.to_vec();
  }
  actions
    .iter()
    .filter(|action| {
      if !is_actionable(action) {
        return true;
      }
      action_key(action).is_some_and(|key| batch.selected_keys.contains(&key))
    })
    .cloned()
    .collect()
}

pub fn build_partial_finalization(
  batch: &PartialBatch,
  run_id: Uuid,
  selected_actions: &[SyncAction],
  failed_doc_ids: &[Uuid],
) -> Option<PartialItemFinalization> {
  let session = batch.session.as_ref()?;
  let item_by_key = batch
    .selected_items
    .iter()
    .map(|item| (PartialActionKey::from_item(item), item.id))
    .collect::<HashMap<_, _>>();
  let failed_doc_ids = failed_doc_ids.iter().copied().collect::<HashSet<_>>();
  let mut completed_item_ids = Vec::new();
  let mut failed_item_ids = Vec::new();
  let mut conflicted_item_ids = Vec::new();
  let mut observed = HashSet::new();

  for action in selected_actions.iter().filter(|action| is_actionable(action)) {
    let Some(key) = action_key(action) else {
      continue;
    };
    let Some(item_id) = item_by_key.get(&key).copied() else {
      continue;
    };
    observed.insert(item_id);
    match action.action {
      ReconcileAction::Conflict(_) | ReconcileAction::DeleteConflict(_) => conflicted_item_ids.push(item_id),
      _ if failed_doc_ids.contains(&action.doc_id) => failed_item_ids.push(item_id),
      _ => completed_item_ids.push(item_id),
    }
  }
  for item in &batch.selected_items {
    if !observed.contains(&item.id) {
      completed_item_ids.push(item.id);
    }
  }
  Some(PartialItemFinalization {
    session_id: session.id,
    run_id,
    completed_item_ids,
    failed_item_ids,
    conflicted_item_ids,
  })
}

pub fn count_selected_actions(actions: &[SyncAction]) -> (i32, i32, i32, i32) {
  let mut created = 0;
  let mut updated = 0;
  let mut deleted = 0;
  let mut conflicts = 0;
  for action in actions {
    match action.action {
      ReconcileAction::CreateInGit | ReconcileAction::CreateInMyoxus => created += 1,
      ReconcileAction::PushToGit | ReconcileAction::PullToMyoxus => updated += 1,
      ReconcileAction::DeleteInGit | ReconcileAction::DeleteInMyoxus => deleted += 1,
      ReconcileAction::Conflict(_) | ReconcileAction::DeleteConflict(_) => conflicts += 1,
      _ => {}
    }
  }
  (created, updated, deleted, conflicts)
}

fn build_session_items(
  session_id: Uuid,
  profile_id: Uuid,
  run_id: Uuid,
  actions: &[SyncAction],
) -> Vec<GitSyncPartialItem> {
  let now = Utc::now();
  let mut seen = HashSet::new();
  let mut items = Vec::new();
  for action in actions.iter().filter(|action| is_actionable(action)) {
    let Some((kind, item_key, sort_key, doc_id, repo_path)) = item_identity(action) else {
      continue;
    };
    if !seen.insert((kind, item_key.clone())) {
      continue;
    }
    items.push(GitSyncPartialItem {
      id: Uuid::new_v4(),
      session_id: Uuid::nil(),
      profile_id,
      item_kind: kind,
      item_key,
      doc_id,
      repo_path,
      sort_key,
      status: PartialItemStatus::Pending,
      attempts: 0,
      last_run_id: Some(run_id),
      error_class: None,
      error_message: None,
      created_at: now,
      updated_at: now,
    });
  }
  items.sort_by(|a, b| a.sort_key.cmp(&b.sort_key).then(a.item_key.cmp(&b.item_key)));
  for item in &mut items {
    item.session_id = session_id;
  }
  items
}

type PartialItemIdentity = (PartialItemKind, String, String, Option<Uuid>, Option<String>);

fn item_identity(action: &SyncAction) -> Option<PartialItemIdentity> {
  match action.action {
    ReconcileAction::CreateInMyoxus | ReconcileAction::PullToMyoxus => {
      let repo_path = action.repo_path.clone()?;
      Some((
        PartialItemKind::GitMarkdown,
        repo_path.clone(),
        format!("git:{repo_path}"),
        Some(action.doc_id),
        Some(repo_path),
      ))
    }
    _ => Some((
      PartialItemKind::Doc,
      action.doc_id.to_string(),
      format!("doc:{}", action.doc_id),
      Some(action.doc_id),
      action.repo_path.clone(),
    )),
  }
}

fn action_key(action: &SyncAction) -> Option<PartialActionKey> {
  item_identity(action).map(|(kind, item_key, _sort_key, _doc_id, _repo_path)| PartialActionKey { kind, item_key })
}

fn is_actionable(action: &SyncAction) -> bool {
  !matches!(
    action.action,
    ReconcileAction::NoChange | ReconcileAction::SkippedByPolicy
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  fn action(doc_id: Uuid, repo_path: Option<&str>, action: ReconcileAction) -> SyncAction {
    SyncAction {
      binding_id: Uuid::nil(),
      doc_id,
      sync_id: Uuid::new_v4(),
      action,
      repo_path: repo_path.map(str::to_string),
    }
  }

  #[test]
  fn count_selected_actions_ignores_nochange_and_policy_skips() {
    let actions = vec![
      action(Uuid::new_v4(), None, ReconcileAction::CreateInGit),
      action(Uuid::new_v4(), None, ReconcileAction::PushToGit),
      action(Uuid::new_v4(), None, ReconcileAction::DeleteInGit),
      action(
        Uuid::new_v4(),
        None,
        ReconcileAction::Conflict(myoxus_domain::git_sync::ConflictType::BothModified),
      ),
      action(Uuid::new_v4(), None, ReconcileAction::NoChange),
      action(Uuid::new_v4(), None, ReconcileAction::SkippedByPolicy),
    ];

    assert_eq!(count_selected_actions(&actions), (1, 1, 1, 1));
  }
}
