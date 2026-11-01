// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thin MCP adapters for user-visible canonical document templates.

use std::collections::HashMap;

use myoxus_application::document_template::{
  CreateDocumentTemplate, DEFAULT_DOCUMENT_TEMPLATE_LIMIT, DocumentTemplateError, DocumentTemplateFolderSelector,
  DocumentTemplateService, DocumentTemplateVariable,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::McpAuthContext;

use super::{
  McpToolState, begin_mcp_idempotency_with_payload, finish_or_abort_mcp_write, mcp_json_response,
  with_internal_document_identity,
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentTemplateListRequest {
  workspace_id: Uuid,
  #[serde(default)]
  offset: usize,
  #[serde(default = "default_limit")]
  limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentTemplateGetRequest {
  workspace_id: Uuid,
  external_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentTemplateCreateRequest {
  workspace_id: Uuid,
  title: String,
  fragment: Option<Value>,
  content_markdown: Option<String>,
  folder_id: Option<String>,
  folder_path: Option<Vec<String>>,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentTemplateStateRequest {
  workspace_id: Uuid,
  external_id: String,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentTemplateInstantiateRequest {
  workspace_id: Uuid,
  template_external_id: String,
  context_parent_external_id: Option<String>,
  title: Option<String>,
  #[serde(default)]
  variables: HashMap<String, DocumentTemplateVariable>,
  folder_id: Option<String>,
  folder_path: Option<Vec<String>>,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

const fn default_limit() -> usize {
  DEFAULT_DOCUMENT_TEMPLATE_LIMIT
}

pub(super) async fn list(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  let request: DocumentTemplateListRequest = parse_request("document_template_list", params)?;
  // The registry has already admitted only read:docs credentials. The
  // Application owner independently enforces workspace Read and document Read;
  // the adapter never treats MCP scope as a workspace membership grant.
  let page = service(state)?
    .list(auth.user_id, request.workspace_id, request.limit, request.offset)
    .await
    .map_err(map_service_error)?;
  Ok(mcp_json_response(json!({
    "offset": request.offset,
    "limit": request.limit,
    "templates": page.templates,
    "nextOffset": page.next_offset,
  })))
}

pub(super) async fn get(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  let request: DocumentTemplateGetRequest = parse_request("document_template_get", params)?;
  let external_id = request.external_id.trim();
  if external_id.is_empty() {
    return Err((-32602, "external_id must not be empty".to_string()));
  }
  let template = service(state)?
    .get_by_external_id(auth.user_id, request.workspace_id, external_id)
    .await
    .map_err(map_service_error)?;
  Ok(mcp_json_response(serde_json::to_value(template).map_err(|_| {
    (
      -32002,
      "MIX_MCP_DOCUMENT_TEMPLATE_SERIALIZATION: template result is invalid".to_string(),
    )
  })?))
}

pub(super) async fn create(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let request: DocumentTemplateCreateRequest = parse_request("document_template_create", params)?;
  let title = request.title.trim().to_string();
  if title.is_empty() || title.chars().count() > 1024 {
    return Err((-32602, "title must contain 1 to 1024 characters".to_string()));
  }
  let input_mode = match (request.fragment.is_some(), request.content_markdown.is_some()) {
    (true, false) => "fragment",
    (false, true) => "markdown",
    _ => {
      return Err((
        -32602,
        "exactly one of fragment or content_markdown is required".to_string(),
      ));
    }
  };
  let selector = parse_destination(request.folder_id, request.folder_path)?;
  let fragment = super::document::parse_fragment(params, true, request.workspace_id, auth, state).await?;
  let templates = service(state)?;
  let destination = templates
    .preflight_create(auth.user_id, request.workspace_id, &selector)
    .await
    .map_err(map_write_service_error)?;
  let semantic_payload = json!({
    "workspaceId": request.workspace_id,
    "title": title,
    "fragment": fragment,
    "destination": destination,
    "inputMode": input_mode,
  });
  let guard =
    match begin_mcp_idempotency_with_payload("document_template_create", params, Some(&semantic_payload), auth, state)
      .await?
    {
      Ok(guard) => guard,
      Err(response) => return Ok(response),
    };
  let result = templates
    .create(CreateDocumentTemplate {
      workspace_id: request.workspace_id,
      actor_id: auth.user_id,
      title,
      fragment,
      destination,
    })
    .await
    .map_err(map_write_service_error)
    .map(|created| {
      with_internal_document_identity(
        mcp_json_response(json!({
          "externalId": created.external_id,
          "title": created.title,
          "isTemplate": true,
          "documentRevision": created.document_revision,
          "rootRevision": created.root_revision,
          "folderId": created.folder_id,
          "folderPath": created.folder_path,
          "entryId": created.entry_id,
          "inputMode": input_mode,
        })),
        created.doc_id,
      )
    });
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn instantiate(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let request: DocumentTemplateInstantiateRequest = parse_request("document_template_instantiate", params)?;
  let source_external_id = request.template_external_id.trim();
  if source_external_id.is_empty() {
    return Err((-32602, "template_external_id must not be empty".to_string()));
  }
  let selector = parse_destination(request.folder_id, request.folder_path)?;
  let templates = service(state)?;
  // `write:docs` at the registry delegates the API-key call only. This
  // Application preflight independently checks source Doc Read, destination
  // CreateDoc and any referenced blob's BlobsRead visibility before the
  // durable idempotency row or product content can be written.
  // Omitted automatic facts use the shared application resolver. The semantic
  // payload below still describes authored values, not this attempt's date,
  // preferences, names or late committed creation facts.
  let prepared = templates
    .preflight_instantiate(
      auth.user_id,
      request.workspace_id,
      source_external_id,
      &selector,
      request.title.as_deref(),
      &request.variables,
      request.context_parent_external_id.as_deref(),
    )
    .await
    .map_err(map_write_service_error)?;
  let semantic_payload = json!({
    "workspaceId": request.workspace_id,
    "templateExternalId": prepared.semantic_source_external_id(),
    "title": prepared.semantic_title(),
    "variables": request.variables,
    "destination": { "folder_id": prepared.semantic_destination_id() },
    "contextParentId": prepared.semantic_context_parent_id(),
  });
  let guard = match begin_mcp_idempotency_with_payload(
    "document_template_instantiate",
    params,
    Some(&semantic_payload),
    auth,
    state,
  )
  .await?
  {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = templates
    .instantiate(auth.user_id, request.workspace_id, prepared)
    .await
    .map_err(map_write_service_error)
    .map(|created| {
      with_internal_document_identity(
        mcp_json_response(json!({
          "externalId": created.external_id,
          "documentRevision": created.document_revision,
          "rootRevision": created.root_revision,
          "folderId": created.folder_id,
          "folderPath": created.folder_path,
          "entryId": created.entry_id,
        })),
        created.doc_id,
      )
    });
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn mark(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  set_template_state("document_template_mark", params, auth, state, true).await
}

pub(super) async fn unmark(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  set_template_state("document_template_unmark", params, auth, state, false).await
}

async fn set_template_state(
  tool_name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
  is_template: bool,
) -> Result<Value, (i32, String)> {
  let request: DocumentTemplateStateRequest = parse_request(tool_name, params)?;
  let external_id = request.external_id.trim();
  if external_id.is_empty() {
    return Err((-32602, "external_id must not be empty".to_string()));
  }
  let semantic_payload = json!({
    "workspaceId": request.workspace_id,
    "externalId": external_id,
    "isTemplate": is_template,
  });
  let templates = service(state)?;
  templates
    .preflight_template_state_change(auth.user_id, request.workspace_id, external_id)
    .await
    .map_err(map_write_service_error)?;
  let guard = match begin_mcp_idempotency_with_payload(tool_name, params, Some(&semantic_payload), auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = templates
    .set_template_state_by_external_id(auth.user_id, request.workspace_id, external_id, is_template)
    .await
    .map_err(map_write_service_error)
    .map(|change| {
      with_internal_document_identity(
        mcp_json_response(json!({
          "externalId": change.external_id,
          "isTemplate": change.is_template,
        })),
        change.doc_id,
      )
    });
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn parse_destination(
  folder_id: Option<String>,
  folder_path: Option<Vec<String>>,
) -> Result<DocumentTemplateFolderSelector, (i32, String)> {
  match (folder_id, folder_path) {
    (Some(folder_id), None) if !folder_id.trim().is_empty() => Ok(DocumentTemplateFolderSelector::Id(folder_id)),
    (None, Some(path))
      if !path.is_empty()
        && path
          .iter()
          .all(|segment| !segment.trim().is_empty() && segment.chars().count() <= 256) =>
    {
      Ok(DocumentTemplateFolderSelector::Path(path))
    }
    _ => Err((
      -32602,
      "exactly one valid folder_id or folder_path is required".to_string(),
    )),
  }
}

fn service(state: &McpToolState) -> Result<&DocumentTemplateService, (i32, String)> {
  state.document_template_service.as_deref().ok_or_else(|| {
    (
      -32002,
      "MIX_MCP_DOCUMENT_TEMPLATE_UNAVAILABLE: document template service unavailable".to_string(),
    )
  })
}

fn parse_request<T>(tool_name: &str, params: &Value) -> Result<T, (i32, String)>
where
  T: for<'de> Deserialize<'de>,
{
  serde_json::from_value(params.clone()).map_err(|error| (-32602, format!("Invalid {tool_name} arguments: {error}")))
}

fn map_service_error(error: DocumentTemplateError) -> (i32, String) {
  match error {
    DocumentTemplateError::Forbidden => (-32003, "MIX_MCP_DOCUMENT_TEMPLATE_FORBIDDEN".to_string()),
    DocumentTemplateError::NotFound => (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_NOT_FOUND".to_string()),
    DocumentTemplateError::InvalidPagination => (-32602, "MIX_MCP_DOCUMENT_TEMPLATE_PAGINATION_INVALID".to_string()),
    DocumentTemplateError::InvalidDocumentKey => (-32602, "MIX_MCP_DOCUMENT_TEMPLATE_EXTERNAL_ID_INVALID".to_string()),
    DocumentTemplateError::InvalidVariables => (-32602, "MIX_MCP_DOCUMENT_TEMPLATE_VARIABLES_INVALID".to_string()),
    DocumentTemplateError::OrganizationUnavailable => {
      (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_ORGANIZATION_UNAVAILABLE".into())
    }
    DocumentTemplateError::OwnerUnitUnavailable => (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_OWNER_UNIT_UNAVAILABLE".into()),
    DocumentTemplateError::ParentUnavailable => (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_PARENT_UNAVAILABLE".into()),
    DocumentTemplateError::CreatorUnavailable
    | DocumentTemplateError::ActorUnavailable
    | DocumentTemplateError::CreationUnavailable
    | DocumentTemplateError::MemberUnavailable
    | DocumentTemplateError::EmptyField => (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_CONTEXT_UNAVAILABLE".into()),
    DocumentTemplateError::UnresolvedVariables => {
      (-32602, "MIX_MCP_DOCUMENT_TEMPLATE_VARIABLES_UNRESOLVED".to_string())
    }
    DocumentTemplateError::AssetNotVisible => (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_ASSET_NOT_FOUND".to_string()),
    DocumentTemplateError::DestinationNotFound => {
      (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_DESTINATION_NOT_FOUND".to_string())
    }
    DocumentTemplateError::DestinationAmbiguous => {
      (-32009, "MIX_MCP_DOCUMENT_TEMPLATE_DESTINATION_AMBIGUOUS".to_string())
    }
    DocumentTemplateError::Compensated => (-32002, "MIX_MCP_DOCUMENT_TEMPLATE_COMPENSATED".to_string()),
    DocumentTemplateError::CompensationFailed => (-32002, "MIX_MCP_DOCUMENT_TEMPLATE_COMPENSATION_FAILED".to_string()),
    DocumentTemplateError::Repository(_)
    | DocumentTemplateError::Content
    | DocumentTemplateError::MutationUnavailable
    | DocumentTemplateError::Metadata(_)
    | DocumentTemplateError::Organizer(_)
    | DocumentTemplateError::Placement(_)
    | DocumentTemplateError::Lifecycle => (-32002, "MIX_MCP_DOCUMENT_TEMPLATE_READ_FAILED".to_string()),
  }
}

fn map_write_service_error(error: DocumentTemplateError) -> (i32, String) {
  match error {
    DocumentTemplateError::Forbidden => (-32003, "MIX_MCP_DOCUMENT_TEMPLATE_FORBIDDEN".to_string()),
    DocumentTemplateError::NotFound => (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_NOT_FOUND".to_string()),
    DocumentTemplateError::InvalidPagination => (-32602, "MIX_MCP_DOCUMENT_TEMPLATE_PAGINATION_INVALID".to_string()),
    DocumentTemplateError::InvalidDocumentKey => (-32602, "MIX_MCP_DOCUMENT_TEMPLATE_EXTERNAL_ID_INVALID".to_string()),
    DocumentTemplateError::InvalidVariables => (-32602, "MIX_MCP_DOCUMENT_TEMPLATE_VARIABLES_INVALID".to_string()),
    DocumentTemplateError::OrganizationUnavailable => {
      (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_ORGANIZATION_UNAVAILABLE".into())
    }
    DocumentTemplateError::OwnerUnitUnavailable => (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_OWNER_UNIT_UNAVAILABLE".into()),
    DocumentTemplateError::ParentUnavailable => (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_PARENT_UNAVAILABLE".into()),
    DocumentTemplateError::CreatorUnavailable
    | DocumentTemplateError::ActorUnavailable
    | DocumentTemplateError::CreationUnavailable
    | DocumentTemplateError::MemberUnavailable
    | DocumentTemplateError::EmptyField => (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_CONTEXT_UNAVAILABLE".into()),
    DocumentTemplateError::UnresolvedVariables => {
      (-32602, "MIX_MCP_DOCUMENT_TEMPLATE_VARIABLES_UNRESOLVED".to_string())
    }
    DocumentTemplateError::AssetNotVisible => (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_ASSET_NOT_FOUND".to_string()),
    DocumentTemplateError::DestinationNotFound => {
      (-32004, "MIX_MCP_DOCUMENT_TEMPLATE_DESTINATION_NOT_FOUND".to_string())
    }
    DocumentTemplateError::DestinationAmbiguous => {
      (-32009, "MIX_MCP_DOCUMENT_TEMPLATE_DESTINATION_AMBIGUOUS".to_string())
    }
    DocumentTemplateError::Compensated => (-32002, "MIX_MCP_DOCUMENT_TEMPLATE_COMPENSATED".to_string()),
    DocumentTemplateError::CompensationFailed => (-32002, "MIX_MCP_DOCUMENT_TEMPLATE_COMPENSATION_FAILED".to_string()),
    DocumentTemplateError::Repository(_)
    | DocumentTemplateError::Content
    | DocumentTemplateError::MutationUnavailable
    | DocumentTemplateError::Metadata(_)
    | DocumentTemplateError::Organizer(_)
    | DocumentTemplateError::Placement(_)
    | DocumentTemplateError::Lifecycle => (-32002, "MIX_MCP_DOCUMENT_TEMPLATE_WRITE_FAILED".to_string()),
  }
}
