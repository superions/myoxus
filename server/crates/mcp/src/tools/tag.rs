// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thin MCP adapters for server-authoritative workspace Labels (API name: Tags).
//!
//! MCP validates its credential scope in the registry/dispatcher, while
//! [`WorkspaceTagService`] owns workspace authorization and persistence. Tags
//! are workspace-visible document metadata: reads use workspace `Read`, while
//! reversible lifecycle writes use `CreateDoc`; irreversible deletion uses
//! the service-owned `PropertiesDelete` capability. Organizer administration
//! is intentionally not involved. MCP `read:docs`/`write:docs`
//! scopes remain a separate credential boundary. Document keys are resolved
//! once within the supplied workspace; internal document UUIDs never enter the
//! response. Tag UUIDs are canonical assignment identities. Complete ordered
//! replacement, archived-reference validation and SQL writes remain service-owned.

use myoxus_application::workspace_tags::{
  ERR_TAG_ARCHIVED_WRITE, ERR_TAG_CROSS_WORKSPACE, ERR_TAG_DUPLICATE_SLUG, ERR_TAG_FORBIDDEN, ERR_TAG_INVALID_COLOR,
  ERR_TAG_INVALID_NAME, ERR_TAG_NOT_ARCHIVED, ERR_TAG_NOT_FOUND, WorkspaceTagService, WorkspaceTagServiceError,
};
use myoxus_domain::repositories::PageRequest;
use myoxus_domain::workspace_tags::WorkspaceTag;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::McpAuthContext;

use super::{
  McpToolState, assert_doc_permission, begin_mcp_idempotency, check_workspace_membership, finish_or_abort_mcp_write,
  mcp_json_response, resolve_doc_in_workspace, resolve_external_document_for_mcp,
};

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceTagListRequest {
  workspace_id: Uuid,
  #[serde(default)]
  include_archived: bool,
  #[serde(default)]
  offset: usize,
  #[serde(default = "default_limit")]
  limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceTagGetRequest {
  workspace_id: Uuid,
  tag_id: Uuid,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentTagsGetRequest {
  workspace_id: Uuid,
  external_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceTagCreateRequest {
  workspace_id: Uuid,
  name: String,
  color_role: String,
  #[serde(default)]
  description: Option<String>,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceTagRenameRequest {
  workspace_id: Uuid,
  tag_id: Uuid,
  name: String,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceTagRecolorRequest {
  workspace_id: Uuid,
  tag_id: Uuid,
  color_role: String,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceTagDescriptionRequest {
  workspace_id: Uuid,
  tag_id: Uuid,
  description: Option<String>,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceTagLifecycleRequest {
  workspace_id: Uuid,
  tag_id: Uuid,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceTagPermanentDeleteRequest {
  workspace_id: Uuid,
  tag_id: Uuid,
  confirm_permanent_delete: bool,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentTagsSetRequest {
  workspace_id: Uuid,
  external_id: String,
  tag_ids: Vec<Uuid>,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

const fn default_limit() -> usize {
  DEFAULT_LIMIT
}

fn service(state: &McpToolState) -> Result<&WorkspaceTagService, (i32, String)> {
  state.workspace_tag_service.as_deref().ok_or_else(|| {
    (
      -32002,
      "MIX_MCP_WORKSPACE_TAG_SERVICE_UNAVAILABLE: workspace Tag service is not configured".to_string(),
    )
  })
}

pub(super) async fn list(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  let request: WorkspaceTagListRequest = serde_json::from_value(params.clone())
    .map_err(|error| (-32602, format!("Invalid workspace_tag_list arguments: {error}")))?;
  if !(1..=MAX_LIMIT).contains(&request.limit) {
    return Err((-32602, format!("limit must be between 1 and {MAX_LIMIT}")));
  }

  // Do not duplicate ACL checks here: the application service enforces
  // WorkspaceAction::Read before touching its repository. Together with the
  // dispatcher's read:docs check, this is the intended two-boundary policy.
  let offset = i64::try_from(request.offset).map_err(|_| (-32602, "offset is too large".to_string()))?;
  let mut tags = service(state)?
    .list_tags_page(
      auth.user_id,
      request.workspace_id,
      request.include_archived,
      PageRequest {
        limit: request.limit as i64 + 1,
        offset,
      },
    )
    .await
    .map_err(map_service_error)?;
  let has_more = tags.len() > request.limit;
  tags.truncate(request.limit);
  let next_offset = has_more.then_some(request.offset.saturating_add(tags.len()));
  let items = tags.iter().map(compact_tag).collect::<Vec<_>>();

  Ok(mcp_json_response(json!({
    "items": items,
    "offset": request.offset,
    "limit": request.limit,
    "nextOffset": next_offset,
  })))
}

pub(super) async fn get(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  let request: WorkspaceTagGetRequest = serde_json::from_value(params.clone())
    .map_err(|error| (-32602, format!("Invalid workspace_tag_get arguments: {error}")))?;
  let tag = service(state)?
    .get_tag(auth.user_id, request.workspace_id, request.tag_id)
    .await
    .map_err(map_service_error)?
    .ok_or_else(|| {
      (
        -32004,
        "MIX_WORKSPACE_TAG_NOT_FOUND: workspace Tag not found".to_string(),
      )
    })?;

  Ok(mcp_json_response(tag_with_description(&tag)))
}

pub(super) async fn document_tags_get(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let request: DocumentTagsGetRequest = serde_json::from_value(params.clone())
    .map_err(|error| (-32602, format!("Invalid document_tags_get arguments: {error}")))?;
  let external_id = request.external_id.trim();
  if external_id.is_empty() {
    return Err((-32602, "external_id must not be empty".to_string()));
  }
  check_workspace_membership(&state.workspace_service, auth.user_id, request.workspace_id).await?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, request.workspace_id, external_id).await?;
  resolve_doc_in_workspace(&state.doc_service, request.workspace_id, resolved.internal_id).await?;
  assert_doc_permission(
    state,
    auth.user_id,
    request.workspace_id,
    resolved.internal_id,
    myoxus_domain::permission::DocAction::Read,
  )
  .await?;
  let service = service(state)?;
  // Document-specific assignments require Read in addition to workspace access.
  // The resolved internal UUID stays confined to this adapter call.
  let tag_ids = service
    .document_tag_ids(auth.user_id, request.workspace_id, resolved.internal_id)
    .await
    .map_err(map_service_error)?;
  let tags = service
    .resolve_tags(auth.user_id, request.workspace_id, &tag_ids)
    .await
    .map_err(map_service_error)?;

  Ok(mcp_json_response(json!({
    "externalId": resolved.external_id,
    "tags": tags.iter().map(compact_tag).collect::<Vec<_>>(),
  })))
}

pub(super) async fn create(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let request: WorkspaceTagCreateRequest = parse_write_request("workspace_tag_create", params)?;
  let service = service(state)?;
  let guard = match begin_mcp_idempotency("workspace_tag_create", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  // The registry/dispatcher has already enforced write:docs. The application
  // call below must still enforce CreateDoc: a credential may attempt document
  // writes globally without granting its actor access to this workspace.
  let result = service
    .create_tag(
      auth.user_id,
      request.workspace_id,
      &request.name,
      &request.color_role,
      request.description,
    )
    .await
    .map(|tag| mcp_json_response(tag_with_description(&tag)))
    .map_err(map_service_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn rename(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let request: WorkspaceTagRenameRequest = parse_write_request("workspace_tag_rename", params)?;
  let service = service(state)?;
  let guard = match begin_mcp_idempotency("workspace_tag_rename", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = service
    .rename_tag(auth.user_id, request.workspace_id, request.tag_id, &request.name)
    .await
    .map(|tag| mcp_json_response(tag_with_description(&tag)))
    .map_err(map_service_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn recolor(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let request: WorkspaceTagRecolorRequest = parse_write_request("workspace_tag_recolor", params)?;
  let service = service(state)?;
  let guard = match begin_mcp_idempotency("workspace_tag_recolor", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = service
    .recolor_tag(auth.user_id, request.workspace_id, request.tag_id, &request.color_role)
    .await
    .map(|tag| mcp_json_response(tag_with_description(&tag)))
    .map_err(map_service_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn description_update(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !params
    .as_object()
    .is_some_and(|params| params.contains_key("description"))
  {
    return Err((-32602, "Missing required parameter: description".to_string()));
  }
  let request: WorkspaceTagDescriptionRequest = parse_write_request("workspace_tag_description_update", params)?;
  let service = service(state)?;
  let guard = match begin_mcp_idempotency("workspace_tag_description_update", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = service
    .update_description(auth.user_id, request.workspace_id, request.tag_id, request.description)
    .await
    .map(|tag| mcp_json_response(tag_with_description(&tag)))
    .map_err(map_service_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn archive(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let request: WorkspaceTagLifecycleRequest = parse_write_request("workspace_tag_archive", params)?;
  let service = service(state)?;
  let guard = match begin_mcp_idempotency("workspace_tag_archive", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = service
    .archive_tag(auth.user_id, request.workspace_id, request.tag_id)
    .await
    .map(|tag| mcp_json_response(tag_with_description(&tag)))
    .map_err(map_service_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn restore(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let request: WorkspaceTagLifecycleRequest = parse_write_request("workspace_tag_restore", params)?;
  let service = service(state)?;
  let guard = match begin_mcp_idempotency("workspace_tag_restore", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = service
    .restore_tag(auth.user_id, request.workspace_id, request.tag_id)
    .await
    .map(|tag| mcp_json_response(tag_with_description(&tag)))
    .map_err(map_service_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn delete_permanently(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let request: WorkspaceTagPermanentDeleteRequest = parse_write_request("workspace_tag_delete_permanently", params)?;
  if !request.confirm_permanent_delete {
    return Err((
      -32602,
      "confirm_permanent_delete must be true for permanent Tag deletion".to_string(),
    ));
  }
  let service = service(state)?;
  let guard = match begin_mcp_idempotency("workspace_tag_delete_permanently", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  // `write:docs` only delegates the credential to request document metadata
  // mutation. The Application service remains authoritative and separately
  // requires PropertiesDelete because this irreversible operation removes the
  // shared Tag and every persisted reference to it.
  let result = service
    .delete_tag_permanently(auth.user_id, request.workspace_id, request.tag_id)
    .await
    .map(|deleted| {
      mcp_json_response(json!({
        "tagId": deleted.tag_id,
        "deleted": true,
      }))
    })
    .map_err(map_service_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn document_tags_set(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let request: DocumentTagsSetRequest = parse_write_request("document_tags_set", params)?;
  let external_id = request.external_id.trim();
  if external_id.is_empty() {
    return Err((-32602, "external_id must not be empty".to_string()));
  }
  let resolved = resolve_external_document_for_mcp(&state.doc_service, request.workspace_id, external_id).await?;
  let service = service(state)?;
  let guard = match begin_mcp_idempotency("document_tags_set", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  // write:docs admits the credential at dispatch. The service independently
  // enforces workspace CreateDoc and target PropertiesUpdate, then validates the complete canonical
  // Tag-ID set; this adapter never resolves names or creates missing Tags.
  let result = service
    .set_document_tags(
      auth.user_id,
      request.workspace_id,
      resolved.internal_id,
      &request.tag_ids,
    )
    .await
    .map(|tags| {
      mcp_json_response(json!({
        "externalId": resolved.external_id,
        "tags": tags.iter().map(compact_tag).collect::<Vec<_>>(),
      }))
    })
    .map_err(map_service_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn parse_write_request<T>(tool_name: &str, params: &Value) -> Result<T, (i32, String)>
where
  T: for<'de> Deserialize<'de>,
{
  serde_json::from_value(params.clone()).map_err(|error| (-32602, format!("Invalid {tool_name} arguments: {error}")))
}

fn compact_tag(tag: &WorkspaceTag) -> Value {
  json!({
    "id": tag.id,
    "name": tag.name,
    "colorRole": tag.color_role.as_str(),
    "archived": tag.archived_at.is_some(),
  })
}

fn tag_with_description(tag: &WorkspaceTag) -> Value {
  json!({
    "id": tag.id,
    "name": tag.name,
    "colorRole": tag.color_role.as_str(),
    "archived": tag.archived_at.is_some(),
    "description": tag.description,
  })
}

fn map_service_error(error: WorkspaceTagServiceError) -> (i32, String) {
  match error.code {
    ERR_TAG_FORBIDDEN => (
      -32003,
      "MIX_WORKSPACE_TAG_FORBIDDEN: workspace Tag action forbidden".to_string(),
    ),
    ERR_TAG_NOT_FOUND => (
      -32004,
      "MIX_WORKSPACE_TAG_NOT_FOUND: workspace Tag not found".to_string(),
    ),
    ERR_TAG_INVALID_NAME | ERR_TAG_INVALID_COLOR => {
      (-32602, format!("{}: workspace Tag arguments are invalid", error.code))
    }
    ERR_TAG_DUPLICATE_SLUG => (
      -32009,
      "MIX_WORKSPACE_TAG_DUPLICATE_SLUG: workspace Tag name conflicts with an active Tag".to_string(),
    ),
    ERR_TAG_CROSS_WORKSPACE => (
      -32602,
      "MIX_WORKSPACE_TAG_CROSS_WORKSPACE: Tag IDs must be unique and belong to the workspace".to_string(),
    ),
    ERR_TAG_ARCHIVED_WRITE => (
      -32009,
      "MIX_WORKSPACE_TAG_ARCHIVED_WRITE: archived Tags cannot be newly assigned".to_string(),
    ),
    ERR_TAG_NOT_ARCHIVED => (
      -32009,
      "MIX_WORKSPACE_TAG_NOT_ARCHIVED: active Tags must be archived before permanent deletion".to_string(),
    ),
    _ => (
      -32002,
      "MIX_MCP_WORKSPACE_TAG_ACTION_FAILED: workspace Tag action failed".to_string(),
    ),
  }
}
