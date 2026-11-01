//! Permission model for workspace and document access control.
//!
//! This module defines the complete set of actions that users may perform on
//! workspaces and documents, and provides the role-to-action mapping that
//! drives every authorisation check in the application layer.
//!
//! The permission hierarchy is additive: each role inherits all actions of the
//! role below it.  [`fixup_doc_role`] computes the effective document role by
//! merging a user's workspace role with any per-document role override.

use crate::entities::{DocRole, WorkspaceRole};
use serde::{Deserialize, Serialize};

/// Fine-grained actions that can be performed on a workspace.
///
/// Variants are serialised using the dotted-namespace convention expected by
/// the client-side permission model (e.g. `"Blobs.Write"`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum WorkspaceAction {
  /// View the workspace and its public documents.
  Read,
  /// Connect and sync Yjs document updates via the real-time protocol.
  Sync,
  /// Create new documents inside the workspace.
  CreateDoc,
  /// Permanently delete the workspace.
  Delete,
  /// Transfer ownership to another member.
  TransferOwner,
  /// Browse the workspace's document organisation / hierarchy.
  #[serde(rename = "Organize.Read")]
  OrganizeRead,
  /// Modify the workspace's document organisation / hierarchy.
  #[serde(rename = "Organize.Update")]
  OrganizeUpdate,
  /// Transfer canonical content to another workspace in the same deployment.
  #[serde(rename = "Content.Transfer")]
  ContentTransfer,
  /// View the workspace member list.
  #[serde(rename = "Users.Read")]
  UsersRead,
  /// Invite, remove, and change roles of workspace members.
  #[serde(rename = "Users.Manage")]
  UsersManage,
  /// Grant or revoke admin privileges for other members.
  #[serde(rename = "Administrators.Manage")]
  AdministratorsManage,
  /// Read custom document properties defined on the workspace.
  #[serde(rename = "Properties.Read")]
  PropertiesRead,
  /// Define new custom document properties.
  #[serde(rename = "Properties.Create")]
  PropertiesCreate,
  /// Edit existing custom document property definitions.
  #[serde(rename = "Properties.Update")]
  PropertiesUpdate,
  /// Remove custom document property definitions.
  #[serde(rename = "Properties.Delete")]
  PropertiesDelete,
  /// Read workspace-level settings.
  #[serde(rename = "Settings.Read")]
  SettingsRead,
  /// Modify workspace-level settings.
  #[serde(rename = "Settings.Update")]
  SettingsUpdate,
  /// Download blobs stored in the workspace.
  #[serde(rename = "Blobs.Read")]
  BlobsRead,
  /// Enumerate blobs stored in the workspace.
  #[serde(rename = "Blobs.List")]
  BlobsList,
  /// Upload new blobs to the workspace.
  #[serde(rename = "Blobs.Write")]
  BlobsWrite,
  /// Invoke the AI copilot features within the workspace.
  Copilot,
  /// Recognize speech in authorized workspace audio, independently of Copilot.
  Transcription,
}

/// Fine-grained actions that can be performed on a single document.
///
/// Variants are serialised using the dotted-namespace convention expected by
/// the client-side permission model.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DocAction {
  /// Read the document content.
  Read,
  /// Copy the document to another location.
  Copy,
  /// Duplicate the document within the same workspace.
  Duplicate,
  /// Move the document to the trash (soft-delete).
  Trash,
  /// Restore the document from the trash.
  Restore,
  /// Permanently delete the document.
  Delete,
  /// Edit the document content.
  Update,
  /// Publish the document to the public web.
  Publish,
  /// Transfer document ownership to another user.
  TransferOwner,
  /// Read custom properties attached to the document.
  #[serde(rename = "Properties.Read")]
  PropertiesRead,
  /// Edit custom properties attached to the document.
  #[serde(rename = "Properties.Update")]
  PropertiesUpdate,
  /// View the per-document collaborator list.
  #[serde(rename = "Users.Read")]
  UsersRead,
  /// Add, remove, or change per-document collaborators.
  #[serde(rename = "Users.Manage")]
  UsersManage,
  /// View comments on the document.
  #[serde(rename = "Comments.Read")]
  CommentsRead,
  /// Post new comments on the document.
  #[serde(rename = "Comments.Create")]
  CommentsCreate,
  /// Edit own comments.
  #[serde(rename = "Comments.Update")]
  CommentsUpdate,
  /// Delete any comment on the document.
  #[serde(rename = "Comments.Delete")]
  CommentsDelete,
  /// Mark comment threads as resolved or re-open them.
  #[serde(rename = "Comments.Resolve")]
  CommentsResolve,
}

impl WorkspaceRole {
  /// Return the complete set of [`WorkspaceAction`]s granted by this role.
  ///
  /// Roles are additive: each role includes all actions of the role below it
  /// in the hierarchy (`External < Reader < Commenter < Collaborator < Manager < Admin < Owner`).
  pub fn actions(&self) -> Vec<WorkspaceAction> {
    match self {
      WorkspaceRole::External => vec![
        WorkspaceAction::Read,
        WorkspaceAction::OrganizeRead,
        WorkspaceAction::PropertiesRead,
        WorkspaceAction::BlobsRead,
      ],
      WorkspaceRole::Reader => {
        let mut actions = WorkspaceRole::External.actions();
        actions.extend(vec![WorkspaceAction::Sync, WorkspaceAction::BlobsList]);
        actions
      }
      WorkspaceRole::Commenter => {
        // Same as Reader — commenting is a doc-level permission, not workspace-level.
        WorkspaceRole::Reader.actions()
      }
      WorkspaceRole::Collaborator => {
        let mut actions = WorkspaceRole::Commenter.actions();
        actions.extend(vec![
          WorkspaceAction::CreateDoc,
          WorkspaceAction::UsersRead,
          WorkspaceAction::SettingsRead,
          WorkspaceAction::BlobsWrite,
          WorkspaceAction::Copilot,
          WorkspaceAction::Transcription,
        ]);
        actions
      }
      WorkspaceRole::Manager => {
        let mut actions = WorkspaceRole::Collaborator.actions();
        actions.extend(vec![
          WorkspaceAction::OrganizeUpdate,
          WorkspaceAction::ContentTransfer,
          WorkspaceAction::PropertiesCreate,
          WorkspaceAction::PropertiesUpdate,
          WorkspaceAction::PropertiesDelete,
        ]);
        actions
      }
      WorkspaceRole::Admin => {
        let mut actions = WorkspaceRole::Manager.actions();
        actions.extend(vec![WorkspaceAction::UsersManage, WorkspaceAction::SettingsUpdate]);
        actions
      }
      WorkspaceRole::Owner => {
        let mut actions = WorkspaceRole::Admin.actions();
        actions.extend(vec![
          WorkspaceAction::Delete,
          WorkspaceAction::AdministratorsManage,
          WorkspaceAction::TransferOwner,
        ]);
        actions
      }
    }
  }

  /// Return `true` if this role grants the given [`WorkspaceAction`].
  pub fn can(&self, action: WorkspaceAction) -> bool {
    self.actions().contains(&action)
  }
}

impl DocRole {
  /// Return the complete set of [`DocAction`]s granted by this role.
  ///
  /// Roles are additive: `None < External < Reader < Commenter < Editor <
  /// Manager < Owner`.
  pub fn actions(&self) -> Vec<DocAction> {
    match self {
      DocRole::None => vec![],
      DocRole::External => vec![
        DocAction::Read,
        DocAction::Copy,
        DocAction::PropertiesRead,
        DocAction::CommentsRead,
      ],
      DocRole::Reader => {
        let mut actions = DocRole::External.actions();
        actions.extend(vec![DocAction::UsersRead, DocAction::Duplicate]);
        actions
      }
      DocRole::Commenter => {
        let mut actions = DocRole::Reader.actions();
        actions.extend(vec![DocAction::CommentsCreate]);
        actions
      }
      DocRole::Editor => {
        let mut actions = DocRole::Commenter.actions();
        actions.extend(vec![
          DocAction::Trash,
          DocAction::Restore,
          DocAction::Delete,
          DocAction::PropertiesUpdate,
          DocAction::Update,
          DocAction::CommentsResolve,
          DocAction::CommentsDelete,
        ]);
        actions
      }
      DocRole::Manager => {
        let mut actions = DocRole::Editor.actions();
        actions.extend(vec![DocAction::Publish, DocAction::UsersManage]);
        actions
      }
      DocRole::Owner => {
        let mut actions = DocRole::Manager.actions();
        actions.extend(vec![DocAction::TransferOwner]);
        actions
      }
    }
  }

  /// Return `true` if this role grants the given [`DocAction`].
  pub fn can(&self, action: DocAction) -> bool {
    self.actions().contains(&action)
  }
}

/// Compute the effective document role by merging a user's workspace role with
/// an optional per-document role override.
///
/// The workspace role sets a floor on document access:
/// - `Owner` → always [`DocRole::Owner`]
/// - `Admin` → at least [`DocRole::Manager`]
/// - `Collaborator` → at least [`DocRole::Editor`]
/// - `Reader` → exactly [`DocRole::Reader`] (per-doc role is ignored)
/// - `External` → the per-document role is used as-is (may be [`DocRole::None`])
pub fn fixup_doc_role(workspace_role: Option<WorkspaceRole>, doc_role: Option<DocRole>) -> DocRole {
  let ws_role = workspace_role.unwrap_or(WorkspaceRole::External);
  let d_role = doc_role.unwrap_or(DocRole::None);

  match ws_role {
    WorkspaceRole::Owner => DocRole::Owner,
    WorkspaceRole::Admin | WorkspaceRole::Manager => {
      if d_role > DocRole::Manager {
        d_role
      } else {
        DocRole::Manager
      }
    }
    WorkspaceRole::Collaborator => {
      if d_role > DocRole::Editor {
        d_role
      } else {
        DocRole::Editor
      }
    }
    WorkspaceRole::Commenter => {
      if d_role > DocRole::Commenter {
        d_role
      } else {
        DocRole::Commenter
      }
    }
    WorkspaceRole::Reader => DocRole::Reader,
    WorkspaceRole::External => d_role,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn document_role_floor_is_exhaustive() {
    for (workspace_role, expected_doc_role) in [
      (WorkspaceRole::Owner, DocRole::Owner),
      (WorkspaceRole::Admin, DocRole::Manager),
      (WorkspaceRole::Manager, DocRole::Manager),
      (WorkspaceRole::Collaborator, DocRole::Editor),
      (WorkspaceRole::Commenter, DocRole::Commenter),
      (WorkspaceRole::Reader, DocRole::Reader),
      (WorkspaceRole::External, DocRole::None),
    ] {
      let actual = fixup_doc_role(Some(workspace_role), None);
      assert_eq!(
        actual, expected_doc_role,
        "unexpected document floor for {workspace_role:?}"
      );
    }
    assert_eq!(
      fixup_doc_role(Some(WorkspaceRole::Admin), Some(DocRole::Reader)),
      DocRole::Manager
    );
    assert_eq!(
      fixup_doc_role(Some(WorkspaceRole::Collaborator), Some(DocRole::Owner)),
      DocRole::Owner
    );
  }

  #[test]
  fn pre_xws_workspace_action_matrix_remains_exact() {
    use WorkspaceAction::*;

    let cases: &[(WorkspaceRole, &[WorkspaceAction])] = &[
      (
        WorkspaceRole::External,
        &[Read, OrganizeRead, PropertiesRead, BlobsRead],
      ),
      (
        WorkspaceRole::Reader,
        &[Read, OrganizeRead, PropertiesRead, BlobsRead, Sync, BlobsList],
      ),
      (
        WorkspaceRole::Commenter,
        &[Read, OrganizeRead, PropertiesRead, BlobsRead, Sync, BlobsList],
      ),
      (
        WorkspaceRole::Collaborator,
        &[
          Read,
          OrganizeRead,
          PropertiesRead,
          BlobsRead,
          Sync,
          BlobsList,
          CreateDoc,
          UsersRead,
          SettingsRead,
          BlobsWrite,
          Copilot,
        ],
      ),
      (
        WorkspaceRole::Manager,
        &[
          Read,
          OrganizeRead,
          PropertiesRead,
          BlobsRead,
          Sync,
          BlobsList,
          CreateDoc,
          UsersRead,
          SettingsRead,
          BlobsWrite,
          Copilot,
          PropertiesCreate,
          PropertiesUpdate,
          PropertiesDelete,
        ],
      ),
      (
        WorkspaceRole::Admin,
        &[
          Read,
          OrganizeRead,
          PropertiesRead,
          BlobsRead,
          Sync,
          BlobsList,
          CreateDoc,
          UsersRead,
          SettingsRead,
          BlobsWrite,
          Copilot,
          PropertiesCreate,
          PropertiesUpdate,
          PropertiesDelete,
          UsersManage,
          SettingsUpdate,
        ],
      ),
      (
        WorkspaceRole::Owner,
        &[
          Read,
          OrganizeRead,
          PropertiesRead,
          BlobsRead,
          Sync,
          BlobsList,
          CreateDoc,
          UsersRead,
          SettingsRead,
          BlobsWrite,
          Copilot,
          PropertiesCreate,
          PropertiesUpdate,
          PropertiesDelete,
          UsersManage,
          SettingsUpdate,
          Delete,
          AdministratorsManage,
          TransferOwner,
        ],
      ),
    ];

    for (role, expected) in cases {
      let existing: Vec<_> = role
        .actions()
        .into_iter()
        .filter(|action| !matches!(action, OrganizeUpdate | ContentTransfer | Transcription))
        .collect();
      assert_eq!(&existing, expected, "pre-XWS capabilities changed for {role:?}");
    }
  }

  #[test]
  fn xws_actions_follow_the_existing_additive_role_hierarchy() {
    for role in [
      WorkspaceRole::External,
      WorkspaceRole::Reader,
      WorkspaceRole::Commenter,
      WorkspaceRole::Collaborator,
    ] {
      assert!(!role.can(WorkspaceAction::OrganizeUpdate), "{role:?}");
      assert!(!role.can(WorkspaceAction::ContentTransfer), "{role:?}");
    }
    assert!(WorkspaceRole::Manager.can(WorkspaceAction::OrganizeUpdate));
    assert!(WorkspaceRole::Manager.can(WorkspaceAction::ContentTransfer));
    for role in [WorkspaceRole::Admin, WorkspaceRole::Owner] {
      assert!(role.can(WorkspaceAction::OrganizeUpdate), "{role:?}");
      assert!(role.can(WorkspaceAction::ContentTransfer), "{role:?}");
    }
  }

  #[test]
  fn workspace_role_ordering_remains_the_permission_floor() {
    assert_eq!(
      [
        WorkspaceRole::External,
        WorkspaceRole::Reader,
        WorkspaceRole::Commenter,
        WorkspaceRole::Collaborator,
        WorkspaceRole::Manager,
        WorkspaceRole::Admin,
        WorkspaceRole::Owner,
      ],
      {
        let mut roles = [
          WorkspaceRole::Owner,
          WorkspaceRole::Collaborator,
          WorkspaceRole::Reader,
          WorkspaceRole::Admin,
          WorkspaceRole::External,
          WorkspaceRole::Manager,
          WorkspaceRole::Commenter,
        ];
        roles.sort();
        roles
      }
    );
  }
}
