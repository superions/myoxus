// SPDX-License-Identifier: AGPL-3.0-or-later
//! MCP resource handler implementations.
//!
//! Resources are identified by URI and returned with MIME types.
//! Legacy literal keys and canonical RFC 6570 document path components are
//! separate contracts: never percent-decode a deployed `myoxus://` key.

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use rmcp::model::{
  CompleteRequestParams, CompleteResult, CompletionInfo, ListResourceTemplatesResult, ListResourcesResult,
  ReadResourceResult, Resource, ResourceContents, ResourceTemplate,
};
use serde_json::{Value, json};
use tracing::instrument;
use uuid::Uuid;

use base64::{Engine, engine::general_purpose::STANDARD};
use myoxus_application::doc::{DocService, DocSpaceKind};
use myoxus_application::permission::{AccessController, WorkspaceResource};
use myoxus_application::workspace::WorkspaceService;
use myoxus_application::workspace::resource_inventory::WorkspaceResourceInventory;
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::permission::WorkspaceAction;

use crate::auth::McpAuthContext;
use crate::tools::{McpToolState, project_authorized_document};

const WORKSPACE_TEMPLATE: &str = "myoxus://{workspace_id}";
const DOCUMENT_TEMPLATE: &str = "myoxus-document://{workspace_id}/{external_id}";
const INVENTORY_TEMPLATE: &str = "myoxus-workspace://{workspace_id}/inventory";
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');

/// RFC 6570 simple expansion keeps the entire external key in one component.
pub fn document_resource_uri(workspace_id: Uuid, key: &DocumentKey) -> String {
  format!(
    "myoxus-document://{workspace_id}/{}",
    utf8_percent_encode(key.as_str(), COMPONENT)
  )
}

/// Parse before authorization, without URL normalization or a second decode at
/// DocumentKey resolution. In particular `%252F` identifies the literal `%2F`.
pub(crate) fn resource_target(uri: &str) -> Result<(Uuid, Option<DocumentKey>), (i32, String)> {
  let (path, canonical) = if let Some(path) = uri.strip_prefix("myoxus-document://") {
    (path, true)
  } else if let Some(path) = uri.strip_prefix("myoxus://") {
    (path, false)
  } else {
    return Err((-32602, "Invalid resource URI scheme".to_string()));
  };
  let (workspace, key) = path
    .split_once('/')
    .map_or((path, None), |(workspace, key)| (workspace, Some(key)));
  let workspace_id =
    Uuid::parse_str(workspace).map_err(|_| (-32602, "Invalid workspace_id in resource URI".to_string()))?;
  let key = match (key, canonical) {
    (None, true) => return Err((-32602, "Canonical document URI requires an external key".to_string())),
    (None, false) => None,
    (Some(key), false) => Some(DocumentKey::parse(key).map_err(|error| (-32602, error))?),
    (Some(key), true) => {
      let decoded = percent_decode_str(key)
        .decode_utf8()
        .map_err(|_| (-32602, "Invalid UTF-8 in document URI".to_string()))?;
      // A canonical template expansion contains only unreserved bytes or
      // percent triplets. Reject raw slash/query/fragment and malformed escapes.
      if !utf8_percent_encode(&decoded, COMPONENT)
        .to_string()
        .eq_ignore_ascii_case(key)
      {
        return Err((
          -32602,
          "Document URI key must be one encoded path component".to_string(),
        ));
      }
      Some(DocumentKey::parse(decoded.into_owned()).map_err(|error| (-32602, error))?)
    }
  };
  Ok((workspace_id, key))
}

pub(crate) fn list_resource_templates(auth: &McpAuthContext) -> ListResourceTemplatesResult {
  let mut templates = Vec::new();
  if auth.has_scope("read:workspaces") {
    templates.push(
      ResourceTemplate::new(WORKSPACE_TEMPLATE, "workspace")
        .with_description("Current authorized workspace metadata")
        .with_mime_type("application/json"),
    );
    if auth.has_scope("read:docs") {
      templates.push(
        ResourceTemplate::new(DOCUMENT_TEMPLATE, "document")
          .with_description("Complete authorized Markdown; encode the external key as one RFC 6570 path component")
          .with_mime_type("text/markdown"),
      );
      templates.push(
        ResourceTemplate::new(INVENTORY_TEMPLATE, "workspace-inventory")
          .with_description("Paged current authorized documents and visible structure; not history")
          .with_mime_type("application/json"),
      );
    }
  }
  ListResourceTemplatesResult::with_all_items(templates)
}

/// Completion is discovery, not authority cached for the subsequent read. Bound
/// candidate scans exactly like list_pages and omit an unknown total when the
/// candidate budget or SDK result limit leaves more possible results.
#[instrument(skip_all)]
pub(crate) async fn complete(
  request: CompleteRequestParams,
  state: &McpToolState,
  auth: &McpAuthContext,
) -> Result<CompleteResult, (i32, String)> {
  let template = request
    .r#ref
    .as_resource_uri()
    .filter(|uri| *uri == WORKSPACE_TEMPLATE || *uri == DOCUMENT_TEMPLATE || *uri == INVENTORY_TEMPLATE)
    .ok_or_else(|| (-32602, "Unsupported resource completion reference".to_string()))?;
  if !auth.has_scope("read:workspaces") || (template != WORKSPACE_TEMPLATE && !auth.has_scope("read:docs")) {
    return Err((-32003, "Missing resource discovery scope".to_string()));
  }
  let prefix = &request.argument.value;
  if prefix.len() > myoxus_domain::document_key::MAX_DOCUMENT_KEY_LENGTH {
    return Err((-32602, "Completion prefix is too long".to_string()));
  }
  let (mut values, more) = match request.argument.name.as_str() {
    "workspace_id" => {
      let workspaces = state
        .workspace_service
        .list_workspaces(auth.user_id)
        .await
        .map_err(|_| (-32002, "Workspace resource discovery is unavailable".to_string()))?;
      let mut values = Vec::new();
      for workspace in workspaces.iter().filter(|workspace| workspace.deleted_at.is_none()) {
        let id = workspace.id.to_string();
        if id.starts_with(prefix)
          && state
            .permission_service
            .get_effective_workspace_role(auth.user_id, workspace.id)
            .await
            .map_err(|_| (-32002, "Workspace read authorization failed".to_string()))?
            .is_some_and(|role| role.can(WorkspaceAction::Read))
        {
          values.push(id);
        }
      }
      values.sort();
      let more = values.len() > CompletionInfo::MAX_VALUES;
      (values, more)
    }
    "external_id" if template == DOCUMENT_TEMPLATE => {
      let workspace = request
        .context
        .as_ref()
        .and_then(|context| context.get_argument("workspace_id"))
        .ok_or_else(|| (-32602, "Document completion requires workspace_id context".to_string()))?;
      let workspace_id =
        Uuid::parse_str(workspace).map_err(|_| (-32602, "Invalid workspace_id context".to_string()))?;
      let role = state
        .permission_service
        .get_effective_workspace_role(auth.user_id, workspace_id)
        .await
        .map_err(|_| (-32002, "Workspace read authorization failed".to_string()))?;
      if !role.is_some_and(|role| role.can(WorkspaceAction::Read)) {
        return Err((-32003, "Permission denied: workspace Read required".to_string()));
      }
      let (docs, cursor) =
        crate::tools::readable_document_page(state, auth, workspace_id, 0, CompletionInfo::MAX_VALUES, prefix).await?;
      (docs.into_iter().map(|doc| doc.external_id).collect(), cursor.is_some())
    }
    _ => return Err((-32602, "Unsupported resource template argument".to_string())),
  };
  values.truncate(CompletionInfo::MAX_VALUES);
  let total = (!more).then_some(values.len() as u32);
  Ok(CompleteResult::new(
    CompletionInfo::with_pagination(values, total, more).expect("completion values are SDK-bounded"),
  ))
}

/// List MCP resources (workspaces) for the authenticated user.
///
/// Missing `read:workspaces` yields the documented empty inventory. Storage
/// failures remain errors so callers can distinguish unavailable discovery from
/// an authorized user who has no workspaces.
#[instrument(skip(workspace_service, auth))]
pub async fn list_resources(
  workspace_service: &WorkspaceService,
  auth: &McpAuthContext,
) -> Result<ListResourcesResult, (i32, String)> {
  if !auth.has_scope("read:workspaces") {
    tracing::warn!("resources/list denied: missing read:workspaces scope");
    return Ok(ListResourcesResult::default());
  }
  let workspaces = match workspace_service.list_workspaces(auth.user_id).await {
    Ok(ws) => ws,
    Err(e) => {
      tracing::warn!(error = %e, "failed to list workspaces for resources/list");
      return Err((-32002, "Workspace resource discovery is unavailable".to_string()));
    }
  };

  let resources = workspaces
    .iter()
    .filter(|w| w.deleted_at.is_none())
    .map(|w| {
      Resource::new(format!("myoxus://{}", w.id), w.name.clone())
        .with_mime_type("application/json")
        .with_description(format!("Workspace: {}", w.name))
    })
    .collect();

  Ok(ListResourcesResult::with_all_items(resources))
}

/// Read a specific resource by URI.
///
/// MCP-RV-08: Requires `read:workspaces` scope (and `read:docs` for doc-level URIs).
#[instrument(skip_all)]
pub async fn read_resource(
  uri: &str,
  state: &McpToolState,
  auth: &McpAuthContext,
) -> Result<ReadResourceResult, (i32, String)> {
  if !auth.has_scope("read:workspaces") {
    return Err((-32600, "Missing scope: read:workspaces".to_string()));
  }
  if uri.starts_with("myoxus-workspace://") {
    if !auth.has_scope("read:docs") {
      return Err((-32003, "Missing scope: read:docs".into()));
    }
    let (workspace, offset) = inventory_target(uri)?;
    let page = resource_inventory(state)
      .page(auth.user_id, workspace, offset, 200, state.document_export_max_bytes)
      .await
      .map_err(|error| match error {
        myoxus_application::auth::AuthError::ActionForbidden => (-32003, "Workspace inventory access denied".into()),
        _ => (
          -32002,
          "Workspace inventory is unavailable or exceeds its byte budget".into(),
        ),
      })?;
    let text = serde_json::to_string(&page).map_err(|_| (-32603, "Workspace inventory serialization failed".into()))?;
    return Ok(ReadResourceResult::new(vec![
      ResourceContents::text(text, uri).with_mime_type("application/json"),
    ]));
  }
  let (workspace_id, document_key) = resource_target(uri)?;

  // Check membership
  let workspaces = state
    .workspace_service
    .list_workspaces(auth.user_id)
    .await
    .map_err(|e| (-32002, format!("Failed to check workspace access: {e}")))?;

  if !workspaces
    .iter()
    .any(|w| w.id == workspace_id && w.deleted_at.is_none())
  {
    return Err((-32003, "Permission denied: not a member of this workspace".to_string()));
  }

  if document_key.is_none() {
    // Workspace metadata resource
    let ws = workspaces
      .into_iter()
      .find(|w| w.id == workspace_id)
      .ok_or_else(|| (-32004, "Workspace not found".to_string()))?;
    state
      .permission_service
      .assert(
        &WorkspaceResource {
          user_id: auth.user_id,
          workspace_id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(|_| (-32003, "Permission denied: workspace Read required".to_string()))?;
    let mut projection = crate::tools::workspace::workspace_projection(state, workspace_id).await?;
    projection["created_at"] = json!(ws.created_at.to_rfc3339());

    Ok(ReadResourceResult::new(vec![
      ResourceContents::text(serde_json::to_string_pretty(&projection).unwrap_or_default(), uri)
        .with_mime_type("application/json"),
    ]))
  } else {
    let projection = project_authorized_document(
      &json!({
        "workspace_id": workspace_id,
        "external_id": document_key.expect("document resource key").as_str(),
        "representation": "markdown",
      }),
      auth,
      state,
    )
    .await
    .map_err(|(code, message)| {
      if message.contains("EXPORT_TOO_LARGE") || message.contains("BLOCK_TOO_LARGE") {
        resource_projection_incomplete()
      } else {
        (code, message)
      }
    })?;
    document_resource_response(uri, projection)
  }
}

fn resource_projection_incomplete() -> (i32, String) {
  (
    -32002,
    "MIX_MCP_RESOURCE_PROJECTION_INCOMPLETE: use paginated read_doc with representation structured".to_string(),
  )
}

pub(crate) fn resource_inventory(state: &McpToolState) -> WorkspaceResourceInventory {
  WorkspaceResourceInventory::new(
    state.workspace_service.clone(),
    state.doc_service.clone(),
    state.permission_service.clone(),
    crate::tools::workspace_content_link_service(state),
  )
}

/// Only this new scheme interprets a query cursor. Legacy document keys remain
/// literal even when they contain question marks or percent sequences.
pub(crate) fn inventory_target(uri: &str) -> Result<(Uuid, i64), (i32, String)> {
  let path = uri
    .strip_prefix("myoxus-workspace://")
    .ok_or_else(|| (-32602, "Invalid inventory URI".into()))?;
  let (path, query) = path.split_once('?').unwrap_or((path, ""));
  let (workspace, tail) = path
    .split_once('/')
    .ok_or_else(|| (-32602, "Invalid inventory URI".into()))?;
  if tail != "inventory" {
    return Err((-32602, "Invalid inventory resource path".into()));
  }
  let workspace = Uuid::parse_str(workspace).map_err(|_| (-32602, "Invalid inventory workspace".into()))?;
  let mut offset = None;
  for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
    if name != "cursor" || offset.is_some() {
      return Err((-32602, "Invalid inventory query".into()));
    }
    let bytes = STANDARD
      .decode(value.as_bytes())
      .map_err(|_| (-32602, "Invalid inventory cursor".into()))?;
    offset = Some(
      std::str::from_utf8(&bytes)
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .ok_or_else(|| (-32602, "Invalid inventory cursor".into()))?,
    );
  }
  Ok((workspace, offset.unwrap_or(0)))
}

/// Resource responses cannot carry continuation or projection diagnostics. Never
/// silently return a partial export through their legacy text-only contract.
fn document_resource_response(uri: &str, projection: Value) -> Result<ReadResourceResult, (i32, String)> {
  if projection.get("complete").and_then(Value::as_bool) != Some(true) {
    return Err(resource_projection_incomplete());
  }
  let content = projection
    .get("data")
    .and_then(Value::as_str)
    .ok_or_else(resource_projection_incomplete)?;
  Ok(ReadResourceResult::new(vec![
    ResourceContents::text(content, uri).with_mime_type("text/markdown"),
  ]))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn canonical_document_keys_decode_once_without_reinterpreting_legacy_uris() {
    let workspace_id = Uuid::new_v4();
    let mut uris = std::collections::HashSet::new();
    for external_id in [
      "plain-key",
      "two words",
      "🦀/日本語",
      "a/b",
      "a%2Fb",
      "a%b",
      "?x#y",
      "a+b",
    ] {
      let key = DocumentKey::parse(external_id).unwrap();
      let uri = document_resource_uri(workspace_id, &key);
      assert!(uris.insert(uri.clone()), "distinct document keys cannot share a URI");
      assert_eq!(resource_target(&uri).unwrap(), (workspace_id, Some(key.clone())));
      assert_eq!(
        resource_target(&format!("myoxus://{workspace_id}/{external_id}")).unwrap(),
        (workspace_id, Some(key))
      );
    }
    for key in ["a/b", "a%b", "%FF", "%", "a?x", "a#x"] {
      assert!(resource_target(&format!("myoxus-document://{workspace_id}/{key}")).is_err());
    }
  }

  #[test]
  fn inv_mcp_core_resources_preserve_complete_unicode_and_reject_partial_exports() {
    let text = format!("{}🦀 complete", "a".repeat(99_999));
    let response = document_resource_response("myoxus://workspace/key", json!({"complete": true, "data": text}))
      .expect("complete resource");
    let response = serde_json::to_value(response).expect("serialize SDK resource");
    assert_eq!(response["contents"][0]["text"], text);
    assert_eq!(response["contents"][0]["mimeType"], "text/markdown");
    for projection in [
      json!({"complete": false, "data": "partial"}),
      json!({"complete": true}),
      json!({"data": "raw"}),
    ] {
      assert_eq!(
        document_resource_response("myoxus://workspace/key", projection),
        Err(resource_projection_incomplete())
      );
    }
  }
}

/// Resolve the same external document URI used by `resources/read` for
/// internal subscription cleanup. Workspace membership is checked before the
/// external key is resolved.
pub(crate) async fn resolve_document_resource_uri(
  uri: &str,
  workspace_service: &WorkspaceService,
  doc_service: &DocService,
  auth: &McpAuthContext,
) -> Result<Option<Uuid>, (i32, String)> {
  if !auth.has_scope("read:workspaces") {
    return Err((-32600, "Missing scope: read:workspaces".to_string()));
  }
  let (workspace_id, document_key) = resource_target(uri)?;
  let workspaces = workspace_service
    .list_workspaces(auth.user_id)
    .await
    .map_err(|error| (-32002, format!("Failed to check workspace access: {error}")))?;
  if !workspaces.iter().any(|workspace| workspace.id == workspace_id) {
    return Err((-32003, "Permission denied: not a member of this workspace".to_string()));
  }
  let Some(document_key) = document_key else {
    return Ok(None);
  };
  doc_service
    .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &document_key)
    .await
    .map_err(|error| (-32002, format!("Failed to resolve document resource: {error}")))?
    .map(Some)
    .ok_or_else(|| (-32004, "Document not found".to_string()))
}
