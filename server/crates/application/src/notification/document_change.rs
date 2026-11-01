// SPDX-License-Identifier: AGPL-3.0-or-later
//! Creator notifications from immutable, due document windows. SQL pending
//! state owns retries; authorization and preferences are resolved at dispatch.

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::entities::{Doc, Notification};
use tracing::{instrument, warn};
use uuid::Uuid;

use super::NotificationCreateOutcome;
use crate::{
  auth::{AuthResult, AuthService, AuthUser, UserPreferenceDefaults},
  doc::DocService,
  permission::PermissionService,
};

pub const DOCUMENT_CHANGE_WINDOW_SECONDS: i64 = 600;

/// These actor facts exist only for this pending window, never as provenance.
#[derive(Debug, Clone)]
pub struct DocumentChangeActor {
  pub user_id: Uuid,
  pub first_sequence: i64,
  pub last_sequence: i64,
}

#[derive(Debug, Clone)]
pub struct DocumentChangeBatch {
  pub id: Uuid,
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  pub started_at: DateTime<Utc>,
  pub last_changed_at: DateTime<Utc>,
  pub due_at: DateTime<Utc>,
  pub actors: Vec<DocumentChangeActor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentChangeRecipient {
  pub user_id: Uuid,
  pub latest_actor_id: Uuid,
  pub actor_count: usize,
}

/// The creator's own edits never subtract an otherwise qualifying foreign edit.
pub fn creator_recipient(creator: Uuid, actors: &[DocumentChangeActor]) -> Option<DocumentChangeRecipient> {
  let foreign: HashMap<_, _> = actors
    .iter()
    .filter(|actor| actor.user_id != creator)
    .map(|actor| (actor.user_id, actor))
    .collect();
  let latest = foreign
    .values()
    .max_by_key(|actor| (actor.last_sequence, actor.user_id))?;
  Some(DocumentChangeRecipient {
    user_id: creator,
    latest_actor_id: latest.user_id,
    actor_count: foreign.len(),
  })
}

#[async_trait]
pub trait DocumentChangeStore: Send + Sync {
  /// Seal before loading actor facts. A writer can then only open a new window.
  async fn due_batches(&self, now: DateTime<Utc>, limit: i64) -> AuthResult<Vec<DocumentChangeBatch>>;

  /// Recheck and lock the due window, insert in-app rows and delete pending
  /// state in one transaction. `None` also completes an ineligible window.
  /// Rollback retains it; concurrent or repeated completion returns `None`.
  async fn complete_batch(
    &self,
    batch: &DocumentChangeBatch,
    recipient: Option<&DocumentChangeRecipient>,
    now: DateTime<Utc>,
  ) -> AuthResult<Option<NotificationCreateOutcome>>;
}

pub struct DocumentChangeDispatcher {
  store: Arc<dyn DocumentChangeStore>,
  auth: AuthService,
  docs: DocService,
  permissions: Arc<PermissionService>,
}

impl DocumentChangeDispatcher {
  pub fn new(
    store: Arc<dyn DocumentChangeStore>,
    auth: AuthService,
    docs: DocService,
    permissions: Arc<PermissionService>,
  ) -> Self {
    Self {
      store,
      auth,
      docs,
      permissions,
    }
  }

  async fn recipient(
    &self,
    batch: &DocumentChangeBatch,
    metadata: &HashMap<Uuid, Doc>,
    users: &HashMap<Uuid, AuthUser>,
    defaults: &UserPreferenceDefaults,
  ) -> AuthResult<Option<DocumentChangeRecipient>> {
    let Some(doc) = metadata
      .get(&batch.doc_id)
      .filter(|doc| doc.workspace_id == Some(batch.workspace_id) && !doc.blocked && doc.deleted_at.is_none())
    else {
      return Ok(None);
    };
    let Some(creator) = doc
      .created_by
      .filter(|id| users.get(id).is_some_and(|user| !user.disabled))
    else {
      return Ok(None);
    };
    let actors = batch
      .actors
      .iter()
      .filter(|actor| users.get(&actor.user_id).is_some_and(|user| !user.disabled))
      .cloned()
      .collect::<Vec<_>>();
    let Some(recipient) = creator_recipient(creator, &actors) else {
      return Ok(None);
    };
    if !self
      .auth
      .get_user_preferences(creator)
      .await?
      .values
      .resolve(defaults)
      .notify_created_documents
    {
      return Ok(None);
    }
    if !self
      .permissions
      .readable_doc_ids(creator, batch.workspace_id, &[batch.doc_id])
      .await?
      .contains(&batch.doc_id)
    {
      return Ok(None);
    }
    Ok(Some(recipient))
  }

  /// No Redis or email dependency participates in pending-state completion.
  #[instrument(skip_all, fields(limit))]
  pub async fn dispatch_due(
    &self,
    now: DateTime<Utc>,
    limit: i64,
    defaults: &UserPreferenceDefaults,
  ) -> AuthResult<Vec<Notification>> {
    let batches = self.store.due_batches(now, limit).await?;
    if batches.is_empty() {
      return Ok(Vec::new());
    }
    let metadata = self
      .docs
      .get_metadata_batch(&batches.iter().map(|batch| batch.doc_id).collect::<Vec<_>>())
      .await?;
    let mut user_ids = batches
      .iter()
      .flat_map(|batch| batch.actors.iter().map(|actor| actor.user_id))
      .collect::<Vec<_>>();
    user_ids.extend(metadata.values().filter_map(|doc| doc.created_by));
    user_ids.sort_unstable();
    user_ids.dedup();
    let users = self.auth.get_users_by_ids(&user_ids).await?;
    let mut created = Vec::new();
    for batch in batches {
      let result = async {
        let recipient = self.recipient(&batch, &metadata, &users, defaults).await?;
        self.store.complete_batch(&batch, recipient.as_ref(), now).await
      }
      .await;
      match result {
        Ok(Some(outcome)) if outcome.inserted => created.push(outcome.notification),
        Ok(_) => {}
        Err(error) => warn!(batch_id = %batch.id, error = %error, "document change window remains pending"),
      }
    }
    Ok(created)
  }
}
