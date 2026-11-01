// SPDX-License-Identifier: AGPL-3.0-or-later
//! Authenticated workspace interchange downloads.

use axum::{
  extract::{Path, State},
  http::{HeaderMap, StatusCode, header},
  response::IntoResponse,
};
use myoxus_application::workspace_export::WorkspaceExportError;
use uuid::Uuid;

use crate::state::ApiState;

#[tracing::instrument(skip_all, fields(%workspace_id))]
pub async fn obsidian_vault_export_handler(
  State(state): State<ApiState>,
  Path(workspace_id): Path<Uuid>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let actor_id = crate::require_workspace_read_user(&state, &headers, workspace_id).await?;
  let service = state
    .workspace_export_service()
    .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
  let artifact = service.export(actor_id, workspace_id).await.map_err(map_export_error)?;
  let filename = artifact
    .filename
    .chars()
    .map(|character| {
      if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
        character
      } else {
        '_'
      }
    })
    .collect::<String>();
  Ok((
    StatusCode::OK,
    [
      (header::CONTENT_TYPE, "application/zip".to_string()),
      (header::CACHE_CONTROL, "no-store".to_string()),
      (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
      (
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{filename}\""),
      ),
    ],
    artifact.bytes,
  ))
}

fn map_export_error(error: WorkspaceExportError) -> StatusCode {
  match error {
    WorkspaceExportError::Authorization(myoxus_application::auth::AuthError::AuthenticationRequired) => {
      StatusCode::UNAUTHORIZED
    }
    WorkspaceExportError::Authorization(myoxus_application::auth::AuthError::ActionForbidden) => StatusCode::FORBIDDEN,
    WorkspaceExportError::WorkspaceNotFound => StatusCode::NOT_FOUND,
    WorkspaceExportError::InventoryLimit | WorkspaceExportError::OutputLimit => StatusCode::PAYLOAD_TOO_LARGE,
    WorkspaceExportError::MissingContent(_) => StatusCode::CONFLICT,
    WorkspaceExportError::Authorization(_)
    | WorkspaceExportError::Path(_)
    | WorkspaceExportError::Projection
    | WorkspaceExportError::Archive => StatusCode::INTERNAL_SERVER_ERROR,
  }
}

#[cfg(test)]
mod tests {
  use myoxus_application::auth::AuthError;

  use super::*;

  #[test]
  fn maps_export_failures_without_turning_partial_archives_into_successes() {
    assert_eq!(
      map_export_error(WorkspaceExportError::Authorization(AuthError::AuthenticationRequired)),
      StatusCode::UNAUTHORIZED
    );
    assert_eq!(
      map_export_error(WorkspaceExportError::Authorization(AuthError::ActionForbidden)),
      StatusCode::FORBIDDEN
    );
    assert_eq!(
      map_export_error(WorkspaceExportError::MissingContent("document".into())),
      StatusCode::CONFLICT
    );
    assert_eq!(
      map_export_error(WorkspaceExportError::InventoryLimit),
      StatusCode::PAYLOAD_TOO_LARGE
    );
  }
}
