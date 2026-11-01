// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded insertion of an already uploaded editor-native image block.

use myoxus_application::doc::{DocumentFragment, DocumentFragmentBlock, DocumentMutation};
use myoxus_domain::permission::WorkspaceAction;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::McpAuthContext;

use super::{
  McpToolState, assert_workspace_permission, begin_mcp_idempotency_with_payload, document, finish_or_abort_mcp_write,
  mcp_json_response, require_completed_image_asset, with_internal_document_identity,
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentImageInsertRequest {
  workspace_id: Uuid,
  external_id: String,
  asset_ref: String,
  after_block_id: Option<String>,
  caption: Option<String>,
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
  let request: DocumentImageInsertRequest = serde_json::from_value(params.clone())
    .map_err(|error| (-32602, format!("Invalid document_image_insert arguments: {error}")))?;
  let asset_ref = required_non_empty(&request.asset_ref, "asset_ref")?;
  let after_block_id = request
    .after_block_id
    .as_deref()
    .map(|value| required_non_empty(value, "after_block_id"))
    .transpose()?;
  let caption = request.caption.unwrap_or_default();
  if caption.chars().count() > 4096 {
    return Err((-32602, "caption must contain at most 4096 characters".to_string()));
  }

  let access_params = json!({
    "workspace_id": request.workspace_id,
    "external_id": request.external_id,
  });
  let (workspace_id, document) = document::require_document_write_access(&access_params, auth, state).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::BlobsRead).await?;
  require_completed_image_asset(state, workspace_id, &asset_ref).await?;

  let fragment = DocumentFragment {
    schema_version: yjs::DOCUMENT_FRAGMENT_SCHEMA.to_string(),
    blocks: vec![DocumentFragmentBlock::Image {
      source: asset_ref.clone(),
      alt: caption.clone(),
    }],
  };
  let mutation = if let Some(block_id) = after_block_id {
    DocumentMutation::InsertAfterBlock { block_id, fragment }
  } else {
    DocumentMutation::AppendBlocks { fragment }
  };
  let mut semantic_payload = json!({
    "workspaceId": workspace_id,
    "documentId": document.internal_id,
    "assetRef": asset_ref,
    "caption": caption,
    "mutation": mutation,
  });
  // Preserve the shipped revisionless replay hash; supplied preconditions are
  // part of the mutation identity and cannot be changed when retrying a key.
  if let Some(revision) = request.expected_revision {
    semantic_payload["expectedRevision"] = json!(revision);
  }
  let guard =
    match begin_mcp_idempotency_with_payload("document_image_insert", params, Some(&semantic_payload), auth, state)
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
        document.internal_id,
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
        "MIX_MCP_DOCUMENT_IMAGE_INVALID_COMMIT: mutation omitted inserted block ID".to_string(),
      )
    })?;
    Ok(with_internal_document_identity(
      mcp_json_response(json!({
        "externalId": document.external_id,
        "assetRef": asset_ref,
        "insertedBlockId": inserted_block_id,
        "revision": committed.sequence,
      })),
      document.internal_id,
    ))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn required_non_empty(value: &str, field: &str) -> Result<String, (i32, String)> {
  let value = value.trim();
  if value.is_empty() {
    return Err((-32602, format!("{field} is required")));
  }
  Ok(value.to_string())
}
