// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Shared document authorization at the API boundary.
//!
//! Transport handlers may keep their native error adapters, but they must use
//! these operations before touching document payloads or side effects. The
//! resolver is the only place where a client-visible key becomes the internal
//! document id used by the permission service.

use axum::http::StatusCode;
use myoxus_application::{
  auth::{AuthError, AuthResult},
  doc::DocSpaceKind,
  permission::{AccessController, DocResource},
};
use myoxus_domain::{
  document_key::DocumentKey,
  entities::{Doc, DocRole},
  permission::DocAction,
};
use uuid::Uuid;

use crate::state::ApiState;

/// The identity a transport may safely pass to a payload or mutation service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthorizedDocument {
  /// The authorized space, retained to prevent cross-workspace hand-off.
  pub(crate) workspace_id: Uuid,
  /// The client-visible key used by the request.
  pub(crate) external_key: DocumentKey,
  /// The server-authoritative document surrogate.
  pub(crate) doc_id: Uuid,
}

/// Resolve and authorize one document before any document-derived data access.
///
/// `DocSpaceKind::Workspace` applies the document ACL even to the workspace
/// root. `DocSpaceKind::Userspace` deliberately has no workspace-role path:
/// only the owner represented by `space_id` may proceed.
#[tracing::instrument(skip(state, external_key), fields(user_id = %user_id, space_id = %space_id, action = ?action, space_kind = ?space_kind))]
pub(crate) async fn authorize_workspace_document(
  state: &ApiState,
  user_id: Uuid,
  space_id: Uuid,
  space_kind: DocSpaceKind,
  external_key: &DocumentKey,
  action: DocAction,
) -> AuthResult<AuthorizedDocument> {
  let doc_id = state
    .doc()
    .resolve_document_key(space_id, space_kind.clone(), external_key)
    .await?
    .ok_or_else(|| AuthError::NotFound("document not found".to_string()))?;
  authorize_resolved_document(state, user_id, space_id, space_kind, external_key, doc_id, action).await
}

/// Filter already loaded workspace metadata without performing per-document
/// role queries. This function intentionally never loads document payloads.
#[tracing::instrument(skip(state, documents), fields(user_id = %user_id, workspace_id = %workspace_id, candidates = documents.len()))]
pub(crate) async fn filter_readable_workspace_documents(
  state: &ApiState,
  user_id: Uuid,
  workspace_id: Uuid,
  documents: Vec<Doc>,
) -> AuthResult<Vec<Doc>> {
  Ok(
    readable_workspace_documents_with_roles(state, user_id, workspace_id, documents)
      .await?
      .into_iter()
      .map(|(doc, _role)| doc)
      .collect(),
  )
}

/// Filter workspace metadata and retain each effective role for an
/// action-specific list projection, still without per-document role queries.
#[tracing::instrument(skip(state, documents), fields(user_id = %user_id, workspace_id = %workspace_id, candidates = documents.len()))]
pub(crate) async fn readable_workspace_documents_with_roles(
  state: &ApiState,
  user_id: Uuid,
  workspace_id: Uuid,
  documents: Vec<Doc>,
) -> AuthResult<Vec<(Doc, DocRole)>> {
  let candidate_ids: Vec<Uuid> = documents
    .iter()
    .filter(|doc| doc.workspace_id == Some(workspace_id) && !doc.blocked && doc.deleted_at.is_none())
    .map(|doc| doc.id)
    .collect();
  let roles = state
    .permission_service()
    .effective_doc_roles(user_id, workspace_id, &candidate_ids)
    .await?;
  Ok(
    documents
      .into_iter()
      .filter_map(|doc| {
        let role = roles.get(&doc.id).copied()?;
        (doc.workspace_id == Some(workspace_id)
          && !doc.blocked
          && doc.deleted_at.is_none()
          && role.can(DocAction::Read))
        .then_some((doc, role))
      })
      .collect(),
  )
}

/// Map shared authorization outcomes to the status contract of REST/RPC and
/// attachment handlers without exposing document metadata on denial.
pub(crate) fn status_from_auth_error(error: AuthError) -> StatusCode {
  match error {
    AuthError::NotFound(_) => StatusCode::NOT_FOUND,
    AuthError::ActionForbidden => StatusCode::FORBIDDEN,
    AuthError::AuthenticationRequired | AuthError::InvalidToken | AuthError::ExpiredToken => StatusCode::UNAUTHORIZED,
    AuthError::InvalidInput(_) => StatusCode::BAD_REQUEST,
    _ => StatusCode::INTERNAL_SERVER_ERROR,
  }
}

async fn authorize_resolved_document(
  state: &ApiState,
  user_id: Uuid,
  space_id: Uuid,
  space_kind: DocSpaceKind,
  external_key: &DocumentKey,
  doc_id: Uuid,
  action: DocAction,
) -> AuthResult<AuthorizedDocument> {
  let metadata = state
    .doc()
    .get_metadata_including_deleted(doc_id)
    .await?
    .ok_or_else(|| AuthError::NotFound("document not found".to_string()))?;

  match space_kind {
    DocSpaceKind::Workspace => {
      if metadata.workspace_id != Some(space_id) {
        return Err(AuthError::NotFound("document not found".to_string()));
      }
      if metadata.blocked {
        return Err(AuthError::ActionForbidden);
      }
      // Trash is a lifecycle state, not a data-disclosure permission. A
      // caller with Delete/Restore may still address a soft-deleted document
      // so permanent deletion and restoration remain possible; every read or
      // ordinary mutation remains denied while the document is in trash.
      if metadata.deleted_at.is_some() && !matches!(action, DocAction::Delete | DocAction::Restore) {
        return Err(AuthError::ActionForbidden);
      }
      let template_read = if action == DocAction::Read {
        match state.document_template_service() {
          Some(templates) => {
            templates
              .authorize_source_read_if_template(user_id, space_id, doc_id)
              .await?
          }
          None => false,
        }
      } else {
        false
      };
      if !template_read {
        state
          .permission_service()
          .assert(
            &DocResource {
              user_id,
              workspace_id: space_id,
              doc_id,
            },
            action,
          )
          .await?;
      }
    }
    DocSpaceKind::Userspace => {
      if metadata.userspace_owner_id != Some(space_id) || user_id != space_id {
        return Err(AuthError::ActionForbidden);
      }
      if metadata.blocked || metadata.deleted_at.is_some() {
        return Err(AuthError::ActionForbidden);
      }
    }
  }

  Ok(AuthorizedDocument {
    workspace_id: space_id,
    external_key: external_key.clone(),
    doc_id,
  })
}
