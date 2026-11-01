// SPDX-License-Identifier: AGPL-3.0-or-later
//! Admission and private readback for newly authored native semantic spans.
//! Native writers and stored historical attributes stay independent of MCP policy.

use super::{
  McpToolState, assert_doc_permission, assert_workspace_permission, load_blob_metadata, resolve_doc_in_workspace,
  resolve_external_document_for_mcp,
};
use crate::auth::McpAuthContext;
use myoxus_domain::{
  entities::MembershipStatus,
  permission::{DocAction, WorkspaceAction},
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Default)]
pub(super) struct ResolvedSpans {
  references: HashMap<String, String>,
  members: HashSet<Uuid>,
  members_authorized: bool,
}

async fn active_member(workspace_id: Uuid, member: Uuid, state: &McpToolState) -> Result<bool, (i32, String)> {
  state
    .workspace_service
    .get_member(workspace_id, member)
    .await
    .map(|value| value.is_some_and(|m| m.status == MembershipStatus::Accepted && !m.user.disabled))
    .map_err(|_| {
      (
        -32002,
        "MIX_MCP_DOCUMENT_MEMBER_LOOKUP_FAILED: workspace member lookup unavailable".into(),
      )
    })
}

/// Rechecked before idempotency admission, including every replay. Only new
/// mention objects need an active member; untouched historical atoms stay native.
pub(super) async fn authorize_spans(
  spans: &mut [yjs::DocumentTextSegment],
  workspace_id: Uuid,
  auth: &McpAuthContext,
  state: &McpToolState,
  resolved: &mut ResolvedSpans,
) -> Result<(), (i32, String)> {
  for span in spans {
    if let Some(reference) = &mut span.reference {
      let key = reference.page_id.trim().to_string();
      let external = if let Some(external) = resolved.references.get(&key) {
        external.clone()
      } else {
        let target = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &key).await?;
        resolve_doc_in_workspace(&state.doc_service, workspace_id, target.internal_id).await?;
        assert_doc_permission(state, auth.user_id, workspace_id, target.internal_id, DocAction::Read).await?;
        resolved.references.insert(key, target.external_id.clone());
        target.external_id
      };
      reference.page_id = external;
    }
    if let Some(mention) = &mut span.mention {
      if !resolved.members_authorized {
        assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::UsersRead).await?;
        resolved.members_authorized = true;
      }
      let member = Uuid::parse_str(&mention.member).map_err(|_| (-32602, "mention.member must be a UUID".into()))?;
      if !resolved.members.contains(&member) {
        if !active_member(workspace_id, member, state).await? {
          return Err((
            -32004,
            "MIX_MCP_DOCUMENT_MEMBER_UNAVAILABLE: mention requires an active accepted workspace member".into(),
          ));
        }
        resolved.members.insert(member);
      }
      mention.member = member.to_string();
    }
  }
  Ok(())
}

/// Rechecked before idempotency admission, including every replay. A newly
/// supplied citation target must be resolvable and readable in its selected
/// workspace; a supplied `workspaceId` selects that workspace, and omission
/// uses the document workspace. Untouched historical references stay native.
pub(super) async fn authorize_citation_reference(
  reference: &mut Value,
  workspace_id: Uuid,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<(), (i32, String)> {
  // Authorize and persist the same identity before replay admission. Only an
  // omitted field falls back; explicit null, empty and invalid values fail.
  let target_workspace = match reference.get("workspaceId") {
    Some(Value::String(value)) => {
      let id = Uuid::parse_str(value).map_err(|_| (-32602, "reference.workspaceId must be a UUID".to_string()))?;
      reference["workspaceId"] = Value::String(id.to_string());
      id
    }
    None => workspace_id,
    Some(_) => return Err((-32602, "reference.workspaceId must be a UUID string".to_string())),
  };
  match reference.get("type").and_then(|kind| kind.as_str()) {
    Some("doc") => {
      let doc_id = reference.get("docId").and_then(|value| value.as_str()).unwrap_or("");
      let target = resolve_external_document_for_mcp(&state.doc_service, target_workspace, doc_id).await?;
      resolve_doc_in_workspace(&state.doc_service, target_workspace, target.internal_id).await?;
      assert_doc_permission(
        state,
        auth.user_id,
        target_workspace,
        target.internal_id,
        DocAction::Read,
      )
      .await?;
    }
    Some("attachment") => {
      assert_workspace_permission(state, auth.user_id, target_workspace, WorkspaceAction::BlobsRead).await?;
      let blob_id = reference.get("blobId").and_then(|value| value.as_str()).unwrap_or("");
      load_blob_metadata(state, target_workspace, blob_id).await?;
    }
    _ => {}
  }
  Ok(())
}

pub(super) async fn authorize_fragment(
  fragment: &mut yjs::DocumentFragment,
  workspace_id: Uuid,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<(), (i32, String)> {
  use yjs::DocumentFragmentBlock as B;
  let mut pending: Vec<_> = fragment.blocks.iter_mut().collect();
  let mut resolved = ResolvedSpans::default();
  while let Some(block) = pending.pop() {
    match block {
      B::Paragraph { text, .. } | B::Heading { text, .. } | B::Quote { text, .. } => {
        authorize_spans(text, workspace_id, auth, state, &mut resolved).await?
      }
      B::Callout { text, children, .. } | B::ListItem { text, children, .. } => {
        authorize_spans(text, workspace_id, auth, state, &mut resolved).await?;
        pending.extend(children.iter_mut());
      }
      B::FootnoteDefinition { children, .. } => pending.extend(children.iter_mut()),
      B::Table { rows, .. } => {
        for cell in rows.iter_mut().flatten() {
          authorize_spans(cell, workspace_id, auth, state, &mut resolved).await?;
        }
      }
      _ => {}
    }
  }
  Ok(())
}

/// Current member visibility also governs cached receipts. Omission affects only
/// private metadata: the native atom, offsets and historical notification remain.
async fn visible_members(
  members: HashSet<Uuid>,
  workspace_id: Uuid,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> HashSet<Uuid> {
  let mut visible = HashSet::new();
  if members.is_empty()
    || assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::UsersRead)
      .await
      .is_err()
  {
    return visible;
  }
  for member in members {
    match active_member(workspace_id, member, state).await {
      Ok(true) => {
        visible.insert(member);
      }
      Ok(false) => {}
      Err(_) => tracing::warn!("MCP mention readback omitted unavailable member metadata"),
    }
  }
  visible
}

/// Serialize only returned blocks before filtering, so an affected-block receipt
/// never performs member lookups for unreturned content elsewhere in the page.
pub(super) async fn private_blocks(
  readback: &myoxus_application::doc::DocumentMutationReadback,
  workspace_id: Uuid,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Value {
  let mut blocks = serde_json::json!(readback.serialized_blocks());
  redact_mentions(&mut blocks, workspace_id, auth, state).await;
  blocks
}

// Walk only the declared block/native/field/span shape; literal authored text and
// other semantic payloads must never be interpreted as a member envelope.
fn visit_spans(value: &mut Value, visit: &mut impl FnMut(&mut serde_json::Map<String, Value>)) {
  match value {
    Value::Array(values) => {
      for value in values {
        visit_spans(value, visit);
      }
    }
    Value::Object(object) => {
      if object.get("blockId").is_some_and(Value::is_string) {
        if let Some(fields) = object
          .get_mut("native")
          .and_then(|v| v.get_mut("fields"))
          .and_then(Value::as_array_mut)
        {
          for field in fields {
            if let Some(spans) = field.get_mut("spans").and_then(Value::as_array_mut) {
              for span in spans {
                if let Some(span) = span.as_object_mut() {
                  visit(span);
                }
              }
            }
          }
        }
      }
      for (key, value) in object {
        if key != "native" {
          visit_spans(value, visit);
        }
      }
    }
    _ => {}
  }
}

pub(super) async fn redact_mentions(
  value: &mut Value,
  workspace_id: Uuid,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> bool {
  let mut members = HashSet::new();
  let mut has_mentions = false;
  visit_spans(value, &mut |span| {
    if let Some(mention) = span.get("mention") {
      has_mentions = true;
      if let Some(id) = mention["member"].as_str().and_then(|id| Uuid::parse_str(id).ok()) {
        members.insert(id);
      }
    }
  });
  if !has_mentions {
    return false;
  }
  let visible = visible_members(members, workspace_id, auth, state).await;
  let mut changed = false;
  visit_spans(value, &mut |span| {
    if span.get("mention").is_some_and(|m| {
      m["member"]
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
        .is_none_or(|id| !visible.contains(&id))
    }) {
      span.remove("mention");
      changed = true;
    }
  });
  changed
}
