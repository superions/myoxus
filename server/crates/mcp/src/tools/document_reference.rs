// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded insertion of editor-native document references.

use myoxus_application::doc::DocumentMutation;
use myoxus_domain::permission::DocAction;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::McpAuthContext;

use super::{
  McpToolState, assert_doc_permission, begin_mcp_idempotency_with_payload, document, finish_or_abort_mcp_write,
  mcp_json_response, resolve_doc_in_workspace, resolve_external_document_for_mcp, with_internal_document_identity,
};

const MAX_REFERENCE_LABEL_CHARS: usize = 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentReferenceInsertRequest {
  workspace_id: Uuid,
  external_id: String,
  target_external_id: String,
  label: String,
  after_block_id: Option<String>,
  expected_revision: Option<i64>,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

pub(super) async fn insert(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  document::parse_expected_sequence(params)?;
  let request: DocumentReferenceInsertRequest = serde_json::from_value(params.clone())
    .map_err(|error| (-32602, format!("Invalid document_reference_insert arguments: {error}")))?;
  let external_id = non_empty(&request.external_id, "external_id")?;
  let target_external_id = non_empty(&request.target_external_id, "target_external_id")?;
  let label = non_empty(&request.label, "label")?;
  if label.chars().count() > MAX_REFERENCE_LABEL_CHARS {
    return Err((
      -32602,
      format!("label must contain at most {MAX_REFERENCE_LABEL_CHARS} characters"),
    ));
  }
  let after_block_id = request
    .after_block_id
    .as_deref()
    .map(|value| non_empty(value, "after_block_id"))
    .transpose()?;

  let access_params = json!({
    "workspace_id": request.workspace_id,
    "external_id": external_id,
  });
  let (workspace_id, source) = document::require_document_write_access(&access_params, auth, state).await?;
  let target = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &target_external_id).await?;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, target.internal_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, target.internal_id, DocAction::Read).await?;

  let mutation = DocumentMutation::InsertLinkedPageReference {
    target_external_id: target.external_id.clone(),
    label: label.clone(),
    after_block_id,
  };
  let mut semantic_payload = json!({
    "workspaceId": workspace_id,
    "sourceDocumentId": source.internal_id,
    "targetDocumentId": target.internal_id,
    "mutation": mutation,
  });
  // Adding this optional capability must not invalidate shipped revisionless
  // replay hashes. A supplied revision is nevertheless part of the identity.
  if let Some(revision) = request.expected_revision {
    semantic_payload["expectedRevision"] = json!(revision);
  }
  let guard = match begin_mcp_idempotency_with_payload(
    "document_reference_insert",
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
  let result = async {
    let committed = state
      .doc_service
      .mutate_content(
        workspace_id,
        source.internal_id,
        Some(auth.user_id),
        mutation,
        false,
        request.expected_revision,
      )
      .await
      .map_err(document::map_mutation_error)?;
    let inserted_block_id = committed.inserted_block_ids.first().cloned().ok_or_else(|| {
      (
        -32002,
        "MIX_MCP_DOCUMENT_REFERENCE_INVALID_COMMIT: mutation omitted inserted block ID".to_string(),
      )
    })?;
    Ok(with_internal_document_identity(
      mcp_json_response(json!({
        "sourceExternalId": source.external_id,
        "targetExternalId": target.external_id,
        "insertedBlockId": inserted_block_id,
        "revision": committed.sequence,
      })),
      source.internal_id,
    ))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn non_empty(value: &str, field: &str) -> Result<String, (i32, String)> {
  let value = value.trim();
  if value.is_empty() {
    return Err((-32602, format!("{field} is required")));
  }
  Ok(value.to_string())
}
