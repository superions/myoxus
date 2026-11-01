// SPDX-License-Identifier: AGPL-3.0-or-later
//! Signed binary upload endpoint for account-scoped workspace imports.

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use myoxus_application::ports::blob_service::WorkspaceImportPartUploadSignature;
use serde::Deserialize;
use uuid::Uuid;

use crate::state::ApiState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportPartQuery {
  actor_id: String,
  import_id: String,
  part_number: i32,
  size_bytes: i64,
  content_hash: String,
  expires: i64,
  token: String,
}

#[tracing::instrument(skip_all)]
pub async fn workspace_import_part_upload_handler(
  State(state): State<ApiState>,
  Query(params): Query<WorkspaceImportPartQuery>,
  body: Bytes,
) -> Result<impl IntoResponse, StatusCode> {
  let actor_id = Uuid::parse_str(&params.actor_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let import_id = Uuid::parse_str(&params.import_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  if params.size_bytes < 1
    || params.size_bytes as usize != body.len()
    || body.len() > myoxus_application::workspace_import::WORKSPACE_IMPORT_PART_BYTES
  {
    return Err(StatusCode::PAYLOAD_TOO_LARGE);
  }
  if !state
    .blob()
    .verify_signed_workspace_import_part_upload_url(WorkspaceImportPartUploadSignature {
      path: "/api/workspace-import/upload-part",
      actor_id,
      import_id,
      part_number: params.part_number,
      size_bytes: params.size_bytes,
      content_hash: &params.content_hash,
      expires_at: params.expires,
      token: &params.token,
    })
  {
    return Err(StatusCode::UNAUTHORIZED);
  }
  let service = state
    .workspace_import_service()
    .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
  service
    .upload_part(actor_id, import_id, params.part_number, &params.content_hash, body)
    .await
    .map_err(map_upload_error)?;
  Ok(StatusCode::NO_CONTENT)
}

fn map_upload_error(error: myoxus_application::auth::AuthError) -> StatusCode {
  match error {
    myoxus_application::auth::AuthError::ActionForbidden
    | myoxus_application::auth::AuthError::AuthenticationRequired => StatusCode::FORBIDDEN,
    myoxus_application::auth::AuthError::NotFound(_) => StatusCode::NOT_FOUND,
    myoxus_application::auth::AuthError::InvalidInput(message)
      if message.contains("limit") || message.contains("size") =>
    {
      StatusCode::PAYLOAD_TOO_LARGE
    }
    myoxus_application::auth::AuthError::InvalidInput(_) => StatusCode::CONFLICT,
    _ => StatusCode::INTERNAL_SERVER_ERROR,
  }
}
