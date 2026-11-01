// SPDX-License-Identifier: AGPL-3.0-or-later
//! Permission-checked resolution of durable XWS redirects.

use myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode;
use std::collections::BTreeSet;
use std::sync::Arc;

use myoxus_domain::ids::UserId;
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::workspace_content_operation::{WorkspaceContentResourceKind, WorkspaceContentResourceRef};
use tracing::instrument;

use crate::auth::{AuthError, AuthResult};
use crate::doc::{DocService, DocSpaceKind};
use crate::permission::{AccessController, PermissionService, WorkspaceResource};

use super::WorkspaceContentRedirectRepository;

pub const MAX_REDIRECT_CHAIN_LENGTH: usize = 8;

#[derive(Clone)]
pub struct WorkspaceContentRedirectService {
  repository: Arc<dyn WorkspaceContentRedirectRepository>,
  permission: Arc<PermissionService>,
  doc: DocService,
}

impl WorkspaceContentRedirectService {
  pub fn new(
    repository: Arc<dyn WorkspaceContentRedirectRepository>,
    permission: Arc<PermissionService>,
    doc: DocService,
  ) -> Self {
    Self {
      repository,
      permission,
      doc,
    }
  }

  /// Resolve to the current target without revealing whether a denied target
  /// exists. Missing, denied, cyclic and overlong chains share `NotFound`.
  #[instrument(skip(self), fields(actor_id = %actor_id, source_workspace_id = %source.workspace_id()))]
  pub async fn resolve(
    &self,
    actor_id: UserId,
    source: WorkspaceContentResourceRef,
  ) -> AuthResult<WorkspaceContentResourceRef> {
    let mut current = source;
    let mut seen = BTreeSet::new();
    for _ in 0..MAX_REDIRECT_CHAIN_LENGTH {
      if !seen.insert(current.clone()) {
        return Err(neutral_not_found());
      }
      // Copy can recreate a workspace-qualified key after Move. Its live
      // resource owns that address; an older redirect must not shadow it or
      // bypass its current read ACL.
      if self.repository.resource_exists(&current).await? {
        return if self.can_read(actor_id, &current).await? {
          Ok(current)
        } else {
          Err(neutral_not_found())
        };
      }
      match self.repository.resolve_redirect(&current).await? {
        Some(next) => current = next,
        None => return Err(neutral_not_found()),
      }
    }
    Err(neutral_not_found())
  }

  async fn can_read(&self, actor_id: UserId, target: &WorkspaceContentResourceRef) -> AuthResult<bool> {
    let workspace = WorkspaceResource {
      user_id: actor_id,
      workspace_id: target.workspace_id(),
    };
    match target.kind() {
      WorkspaceContentResourceKind::Document => {
        let key =
          myoxus_domain::document_key::DocumentKey::parse(target.resource_id()).map_err(|_| neutral_not_found())?;
        let Some(doc_id) = self
          .doc
          .resolve_document_key(target.workspace_id(), DocSpaceKind::Workspace, &key)
          .await?
        else {
          return Ok(false);
        };
        Ok(
          self
            .permission
            .get_effective_doc_role(actor_id, target.workspace_id(), doc_id)
            .await?
            .can(DocAction::Read),
        )
      }
      // Folder redirects expose normal workspace navigation; Collections keep
      // their separate Organizer read contract.
      WorkspaceContentResourceKind::Folder => Ok(self.permission.can(&workspace, WorkspaceAction::Read).await),
      WorkspaceContentResourceKind::Collection => {
        Ok(self.permission.can(&workspace, WorkspaceAction::OrganizeRead).await)
      }
      WorkspaceContentResourceKind::Tag => Ok(self.permission.can(&workspace, WorkspaceAction::PropertiesRead).await),
      WorkspaceContentResourceKind::Blob => Ok(self.permission.can(&workspace, WorkspaceAction::BlobsRead).await),
      WorkspaceContentResourceKind::Database => Ok(self.permission.can(&workspace, WorkspaceAction::Read).await),
    }
  }
}

fn neutral_not_found() -> AuthError {
  AuthError::NotFound(WorkspaceContentErrorCode::SourceDocumentMissing.as_str().to_string())
}
