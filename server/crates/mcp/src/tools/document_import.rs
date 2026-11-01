// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded single-document import composed from the existing lifecycle and Organizer owners.

use myoxus_application::doc::DocumentFragmentBlock;
use myoxus_application::organizer::{CreateOrganizerLink, OrganizerError, OrganizerLinkType};
use myoxus_application::workspace_content_operation::link::WorkspaceContentLinkError;
use myoxus_domain::permission::WorkspaceAction;
use rmcp::{RoleServer, model::ProgressNotificationParam, service::RequestContext};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tracing::warn;
use uuid::Uuid;

use crate::auth::McpAuthContext;

use super::{
  McpToolState, assert_workspace_permission, begin_mcp_idempotency_with_payload, check_workspace_membership,
  finish_or_abort_mcp_write, folder, map_page_lifecycle_error, mcp_json_response, require_completed_image_asset,
  with_internal_document_identity, workspace_content_link_service,
};

const REFERENCE_UNSUPPORTED: &str =
  "MIX_MCP_DOCUMENT_IMPORT_REFERENCE_UNSUPPORTED: native document references require the Phase 2 reference workflow";
const COMPENSATED: &str = "MIX_MCP_DOCUMENT_IMPORT_COMPENSATED: document placement failed and the new page was trashed";
const COMPENSATION_FAILED: &str = "MIX_MCP_DOCUMENT_IMPORT_COMPENSATION_FAILED";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentImportRequest {
  workspace_id: Uuid,
  title: String,
  fragment: Option<Value>,
  content_markdown: Option<String>,
  #[serde(rename = "strict_loss")]
  _strict_loss: Option<bool>,
  folder_id: Option<String>,
  folder_path: Option<Vec<String>>,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

pub(super) async fn import_document(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
  context: Option<&RequestContext<RoleServer>>,
) -> Result<Value, (i32, String)> {
  let request: DocumentImportRequest = serde_json::from_value(params.clone())
    .map_err(|error| (-32602, format!("Invalid document_import arguments: {error}")))?;
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
  folder::validate_destination_selector(request.folder_id.as_deref(), request.folder_path.as_deref())?;
  if request.fragment.as_ref().is_some_and(contains_native_reference) {
    return Err((-32602, REFERENCE_UNSUPPORTED.to_string()));
  }
  let (fragment, diagnostics) =
    super::document::parse_fragment_with_diagnostics(params, true, request.workspace_id, auth, state).await?;
  let structured_asset_refs = (input_mode == "fragment").then(|| collect_image_sources(&fragment.blocks));
  let block_count = count_blocks(&fragment.blocks);

  check_workspace_membership(&state.workspace_service, auth.user_id, request.workspace_id).await?;
  // One CreateDoc decision owns both page creation and placement in an existing
  // folder. Requiring an Organizer role here would incorrectly exclude normal
  // editors without adding protection for the document or destination.
  assert_workspace_permission(state, auth.user_id, request.workspace_id, WorkspaceAction::CreateDoc).await?;
  if let Some(asset_refs) = &structured_asset_refs
    && !asset_refs.is_empty()
  {
    assert_workspace_permission(state, auth.user_id, request.workspace_id, WorkspaceAction::BlobsRead).await?;
    for asset_ref in asset_refs {
      require_completed_image_asset(state, request.workspace_id, asset_ref).await?;
    }
  }
  let destination = folder::resolve_existing_destination(
    state,
    request.workspace_id,
    request.folder_id.as_deref(),
    request.folder_path.as_deref(),
  )
  .await?;

  report_progress(context, 1.0, "Import validated").await;
  let semantic_payload = json!({
    "workspaceId": request.workspace_id,
    "title": title,
    "fragment": fragment,
    "folderId": destination.folder_id,
    "inputMode": input_mode,
  });
  let guard = match begin_mcp_idempotency_with_payload("document_import", params, Some(&semantic_payload), auth, state)
    .await?
  {
    Ok(guard) => guard,
    Err(response) => {
      let doc_id = response
        .get("_mcpInternalDocumentId")
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or_else(|| (-32002, "MIX_MCP_DOCUMENT_IMPORT_INVALID_RECEIPT".into()))?;
      // Receipts are lifecycle evidence, including compensated trash. Check
      // current ownership before applying the workspace-derived role floor;
      // an old receipt must not authorize a moved or administratively blocked
      // target through its former workspace.
      let current = state
        .doc_service
        .get_metadata_including_deleted(doc_id)
        .await
        .map_err(|_| (-32002, "MIX_MCP_DOCUMENT_IMPORT_RECOVERY_READ_FAILED".into()))?
        .ok_or_else(|| (-32004, "Document not found".into()))?;
      if current.workspace_id != Some(request.workspace_id) || current.blocked {
        return Err((-32003, "Permission denied: import outcome target is unavailable".into()));
      }
      super::assert_doc_permission(
        state,
        auth.user_id,
        request.workspace_id,
        doc_id,
        myoxus_domain::permission::DocAction::Read,
      )
      .await?;
      if let Some(recovery) = response.get("_mcpImportRecovery") {
        return Err((
          -32002,
          format!(
            "MIX_MCP_DOCUMENT_IMPORT_RECOVERY_REQUIRED: step={}; inspect existing externalId={} and entryId={} using read_doc and folder_entry_list, then repair that page through the existing document/folder tools; do not create another page or use a new key",
            recovery["step"].as_str().unwrap_or_default(),
            recovery["externalId"].as_str().unwrap_or_default(),
            recovery["entryId"].as_str().unwrap_or_default()
          ),
        ));
      }
      report_progress(context, 4.0, "Existing import replayed; no page created").await;
      return Ok(response);
    }
  };
  // Allocate the placement identity before creation so its durable receipt can
  // identify both sides even if the request disappears immediately afterwards.
  let entry_id = Uuid::new_v4().to_string();
  let recovery_entry_id = entry_id.clone();
  let result = async {
    let committed = guard
      .document_write_with_response(
        auth,
        Arc::new(move |outcome| {
          let myoxus_application::mcp::McpDocumentWriteCommit::Lifecycle(commit) = outcome else {
            return Err(myoxus_application::auth::AuthError::InvalidInput(
              "MIX_MCP_DOCUMENT_IMPORT_INVALID_COMMIT".into(),
            ));
          };
          Ok(with_internal_document_identity(
            json!({"_mcpImportRecovery": {
              "step": "created", "externalId": commit.document.external_id,
              "entryId": recovery_entry_id, "documentRevision": commit.leaf.as_ref().map(|leaf| leaf.sequence),
              "rootRevision": commit.workspace_root.sequence,
            }}),
            commit.document.id,
          ))
        }),
        state.doc_service.create_page_lifecycle(
          request.workspace_id,
          auth.user_id,
          Some(title.clone()),
          Some(fragment),
        ),
      )
      .await
      .map_err(map_page_lifecycle_error)?;
    let doc_id = committed.document.id;
    let external_id = committed.document.external_id.clone();
    let document_revision = committed.leaf.as_ref().map(|delta| delta.sequence).ok_or_else(|| {
      (
        -32002,
        "MIX_MCP_DOCUMENT_IMPORT_INVALID_COMMIT: create omitted document revision".to_string(),
      )
    })?;
    report_progress(context, 2.0, "Document created").await;
    let links = workspace_content_link_service(state);
    let entry = match links
      .create(
        auth.user_id,
        request.workspace_id,
        CreateOrganizerLink {
          id: entry_id.clone(),
          parent_id: destination.folder_id.clone(),
          link_type: OrganizerLinkType::Doc,
          target_id: external_id.clone(),
          target_workspace_id: None,
          index: None,
        },
      )
      .await
    {
      Ok(entry) => entry,
      Err(_placement_error) => {
        let receipt = |step: &str| {
          with_internal_document_identity(
            json!({"_mcpImportRecovery": {
              "step": step, "externalId": external_id, "entryId": entry_id,
              "documentRevision": document_revision, "rootRevision": committed.workspace_root.sequence,
            }}),
            doc_id,
          )
        };
        guard
          .record_composed_step(&state.idempotency, &receipt("compensating"))
          .await?;
        let entry_clean = match links.delete(auth.user_id, request.workspace_id, &entry_id).await {
          Ok(()) | Err(WorkspaceContentLinkError::Organizer(OrganizerError::EntryNotFound(_))) => true,
          Err(_) => false,
        };
        // A failed removal may leave a published link. Never trash its target
        // until the canonical placement owner proves that link is absent.
        let page_trashed = entry_clean
          && state
            .doc_service
            .trash_page(request.workspace_id, doc_id, auth.user_id)
            .await
            .is_ok();
        warn!(
          workspace_id = %request.workspace_id,
          entry_removed = entry_clean,
          page_trashed,
          "MCP document import placement failed and compensation ran"
        );
        guard
          .record_composed_step(
            &state.idempotency,
            &receipt(if entry_clean && page_trashed {
              "compensated"
            } else {
              "compensation_incomplete"
            }),
          )
          .await?;
        return if entry_clean && page_trashed {
          Err((-32002, format!("{COMPENSATED}; externalId={external_id}; entryId={entry_id}; inspect the existing trashed page and retained same-key outcome; do not create another page or use a new key")))
        } else {
          Err((
            -32002,
            format!("{COMPENSATION_FAILED}: entryRemoved={entry_clean}; pageTrashed={page_trashed}; externalId={external_id}; entryId={entry_id}; inspect and repair those existing identities through the document/folder tools; do not create another page or use a new key"),
          ))
        };
      }
    };

    report_progress(context, 3.0, "Document placed").await;
    Ok(with_internal_document_identity(
      mcp_json_response(super::document::with_fragment_diagnostics(json!({
        "externalId": external_id,
        "title": title,
        "documentRevision": document_revision,
        "rootRevision": committed.workspace_root.sequence,
        "folderId": destination.folder_id,
        "folderPath": destination.path,
        "entryId": entry.id,
        "blockCount": block_count,
        "inputMode": input_mode,
        "markdownDiagnosticCount": diagnostics.diagnostic_count,
      }), &diagnostics)),
      doc_id,
    ))
  }
  .await;
  let result = finish_or_abort_mcp_write(guard, state, auth, result).await;
  if result.is_ok() {
    report_progress(context, 4.0, "Import completed").await;
  }
  result
}

/// Progress is advisory and scoped to this request's supplied SDK token. A
/// closed notification channel must not undo/reclassify a committed import or
/// prevent the remaining composition/recovery steps from running.
async fn report_progress(context: Option<&RequestContext<RoleServer>>, progress: f64, message: &'static str) {
  let Some(context) = context else {
    return;
  };
  let Some(token) = context.meta.get_progress_token() else {
    return;
  };
  tokio::select! {
    biased;
    _ = context.ct.cancelled() => {},
    result = context.peer.notify_progress(ProgressNotificationParam::new(token, progress).with_total(4.0).with_message(message)) => {
      if result.is_err() {
        tracing::debug!("MCP import progress channel is unavailable; preserving import outcome");
      }
    }
  }
}

pub(super) fn summary(value: &Value) -> String {
  let blocks = value["blockCount"].as_u64().unwrap_or_default();
  format!("Document imported with {blocks} block(s) and placed in the requested folder.")
}

fn collect_image_sources(blocks: &[DocumentFragmentBlock]) -> Vec<String> {
  blocks
    .iter()
    .flat_map(|block| match block {
      DocumentFragmentBlock::Image { source, .. } => vec![source.clone()],
      DocumentFragmentBlock::ListItem { children, .. } => collect_image_sources(children),
      _ => Vec::new(),
    })
    .collect()
}

fn contains_native_reference(value: &Value) -> bool {
  match value {
    Value::Object(object) => object.contains_key("reference") || object.values().any(contains_native_reference),
    Value::Array(values) => values.iter().any(contains_native_reference),
    _ => false,
  }
}

fn count_blocks(blocks: &[DocumentFragmentBlock]) -> usize {
  blocks
    .iter()
    .map(|block| match block {
      DocumentFragmentBlock::ListItem { children, .. } => 1 + count_blocks(children),
      _ => 1,
    })
    .sum()
}
