// SPDX-License-Identifier: AGPL-3.0-or-later

use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::permission::DocAction;
use myoxus_domain::workspace_overview::{OverviewSettingsError, OverviewSettingsScope, WorkspaceOverviewSettingsPatch};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};
use crate::doc::DocSpaceKind;
use crate::organizer::{OrganizerService, resolve_organizer_folder_id};
use crate::permission::{AccessController, DocResource};
use crate::workspace_overview::ordinary_page;

use super::WorkspaceSettingsService;

impl From<OverviewSettingsError> for AuthError {
  fn from(error: OverviewSettingsError) -> Self {
    match error {
      OverviewSettingsError::RevisionConflict { current_revision } => {
        Self::WorkspaceOverviewRevisionConflict { current_revision }
      }
      OverviewSettingsError::InvalidInput(message) => Self::InvalidInput(message.into()),
    }
  }
}

impl WorkspaceSettingsService {
  /// Validate new bindings only. Existing inaccessible/deleted bindings remain
  /// removable without making a different scope's update depend on them.
  pub(super) async fn validate_overview_patch(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    patch: &mut WorkspaceOverviewSettingsPatch,
  ) -> AuthResult<()> {
    if matches!(patch.scope, OverviewSettingsScope::Folder(_)) || matches!(patch.folder_ids, Some(Some(_))) {
      let snapshot = OrganizerService::new(self.documents.clone())
        .snapshot(workspace_id)
        .await
        .map_err(|_| AuthError::Storage("workspace Organizer could not be loaded".into()))?;
      if let OverviewSettingsScope::Folder(id) = &patch.scope {
        match resolve_organizer_folder_id(&snapshot, id) {
          Some(folder) if folder.path.is_empty() => patch.scope = OverviewSettingsScope::Workspace,
          Some(_) => {}
          None if patch.clears_folder_scope() => {}
          None => return Err(AuthError::InvalidInput("overview folder does not exist".into())),
        }
      }
      if let Some(Some(ids)) = &patch.folder_ids {
        for id in ids {
          if !resolve_organizer_folder_id(&snapshot, id).is_some_and(|folder| !folder.path.is_empty()) {
            return Err(AuthError::InvalidInput(
              "selected overview folder does not exist".into(),
            ));
          }
        }
      }
    }
    // Extract's structural root is the workspace scope, including root-only
    // folder selection. Validate the canonical scope rather than its old alias.
    patch.validate(workspace_id).map_err(AuthError::from)?;
    if let Some(Some(reference)) = &patch.introduction {
      let key = DocumentKey::parse(reference.resource_id()).map_err(AuthError::InvalidInput)?;
      let doc_id = self
        .documents
        .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &key)
        .await?
        .ok_or_else(|| AuthError::NotFound("introduction document".into()))?;
      let document = self
        .documents
        .get_metadata(doc_id)
        .await?
        .filter(|doc| {
          doc.workspace_id == Some(workspace_id) && !doc.is_workspace_root && !doc.blocked && doc.deleted_at.is_none()
        })
        .ok_or_else(|| AuthError::NotFound("introduction document".into()))?;
      self
        .permission
        .assert(
          &DocResource {
            user_id,
            workspace_id,
            doc_id: document.id,
          },
          DocAction::Read,
        )
        .await?;
      let metadata = self
        .metadata
        .as_ref()
        .ok_or_else(|| AuthError::Storage("document metadata index is unavailable".into()))?
        .list_metadata_index(workspace_id)
        .await
        .map_err(|_| AuthError::Storage("document metadata index could not be loaded".into()))?;
      let row = metadata
        .iter()
        .find(|row| row.doc_id == doc_id)
        .ok_or_else(|| AuthError::NotFound("introduction document".into()))?;
      if !ordinary_page(row) {
        return Err(AuthError::InvalidInput("introduction must be an ordinary Page".into()));
      }
    }
    Ok(())
  }
}
