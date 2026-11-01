// SPDX-License-Identifier: AGPL-3.0-or-later
//! Comment transport projections over the shared GraphQL application owner.

use super::{
  McpAuthContext, McpToolState, assert_doc_permission, map_page_lifecycle_error, mcp_json_response, parse_uuid,
  required_string, resolve_doc_in_workspace, resolve_external_document_for_mcp,
};
use myoxus_application::{auth::HistoricalUserProfile, comment::CommentThreadFilter};
use myoxus_domain::{entities::Comment, permission::DocAction};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

/// Authorization and document binding precede both body reads and attribution.
#[tracing::instrument(skip_all)]
pub(super) async fn read(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "read:docs scope required".into()));
  }
  let selector = match name {
    "comment_thread_list" => "filter",
    "comment_reply_list" => "parent_comment_id",
    _ => "comment_id",
  };
  let args = params
    .as_object()
    .ok_or_else(|| (-32602, "Expected comment arguments object".into()))?;
  if args
    .keys()
    .any(|key| !["workspace_id", "external_id", "offset", "limit", selector].contains(&key.as_str()))
  {
    return Err((-32602, "Unknown comment argument".into()));
  }
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let external_id = required_string(params, "external_id")?;
  let offset = bounded_integer(params, "offset", 0, 0, i64::MAX - 200)?;
  let limit = bounded_integer(params, "limit", 50, 1, 200)?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::CommentsRead).await?;
  let comments = state
    .comment_service
    .as_ref()
    .ok_or_else(|| (-32002, "Comment service is not enabled".into()))?;
  let users = state
    .users
    .as_ref()
    .ok_or_else(|| (-32002, "Comment attribution service is not enabled".into()))?;
  let mut output = json!({"workspaceId":workspace_id,"externalId":resolved.external_id,"offset":offset,"limit":limit});
  let length;
  match name {
    "comment_thread_list" => {
      let filter = match params.get("filter") {
        None => CommentThreadFilter::All,
        Some(Value::String(s)) => match s.as_str() {
          "all" => CommentThreadFilter::All,
          "open" => CommentThreadFilter::Open,
          "resolved" => CommentThreadFilter::Resolved,
          "mine" => CommentThreadFilter::Mine,
          _ => return Err((-32602, "Invalid thread filter".into())),
        },
        _ => return Err((-32602, "Invalid thread filter".into())),
      };
      let rows = comments
        .list_comment_threads(auth.user_id, workspace_id, doc_id, offset, limit, filter)
        .await
        .map_err(map_page_lifecycle_error)?;
      let profiles = users
        .auth
        .get_historical_profiles(&rows.iter().map(|r| r.comment.author_id).collect::<Vec<_>>())
        .await
        .map_err(map_page_lifecycle_error)?;
      length = rows.len();
      output["filter"] = json!(filter);
      output["threads"] = json!(
        rows
          .into_iter()
          .map(|row| {
            let mut v = comment_json(&row.comment, &profiles);
            v["readAt"] = json!(row.read_at);
            v["unread"] = json!(row.unread);
            v
          })
          .collect::<Vec<_>>()
      );
    }
    "comment_reply_list" => {
      let parent = parse_uuid(params, "parent_comment_id")?;
      let rows = comments
        .list_comment_replies(auth.user_id, workspace_id, doc_id, parent, offset, limit)
        .await
        .map_err(map_page_lifecycle_error)?;
      let profiles = users
        .auth
        .get_historical_profiles(&rows.iter().map(|r| r.author_id).collect::<Vec<_>>())
        .await
        .map_err(map_page_lifecycle_error)?;
      length = rows.len();
      output["parentCommentId"] = json!(parent);
      output["replies"] = json!(rows.iter().map(|r| comment_json(r, &profiles)).collect::<Vec<_>>());
    }
    _ => {
      let id = parse_uuid(params, "comment_id")?;
      let rows = comments
        .list_comment_edit_history(auth.user_id, workspace_id, doc_id, id, offset, limit)
        .await
        .map_err(map_page_lifecycle_error)?;
      let profiles = users
        .auth
        .get_historical_profiles(&rows.iter().map(|r| r.edited_by).collect::<Vec<_>>())
        .await
        .map_err(map_page_lifecycle_error)?;
      length = rows.len();
      output["commentId"] = json!(id);
      output["history"] = json!(
        rows
          .iter()
          .map(|r| json!({"id":r.id,"body":r.body,"editor":attribution(r.edited_by,&profiles),"editedAt":r.edited_at}))
          .collect::<Vec<_>>()
      );
    }
  }
  // The owner caps pages at 200. A full page advertises a possible next page;
  // reaching its end may return an empty page, without silently truncating data.
  output["next_offset"] = if length as i64 == limit {
    json!(offset + length as i64)
  } else {
    Value::Null
  };
  if serde_json::to_vec(&output)
    .map_err(|_| (-32603, "Comment serialization failed".into()))?
    .len()
    > state.document_export_max_bytes
  {
    return Err((
      -32602,
      "Comment page exceeds document output limit; request a smaller limit".into(),
    ));
  }
  Ok(mcp_json_response(output))
}

fn bounded_integer(params: &Value, key: &str, default: i64, min: i64, max: i64) -> Result<i64, (i32, String)> {
  let value = match params.get(key) {
    None => default,
    Some(value) => value.as_i64().ok_or_else(|| (-32602, format!("Invalid {key}")))?,
  };
  if !(min..=max).contains(&value) {
    return Err((-32602, format!("Invalid {key}")));
  }
  Ok(value)
}

fn attribution(id: Uuid, profiles: &HashMap<Uuid, HistoricalUserProfile>) -> Value {
  json!({"id":id,"name":profiles.get(&id).and_then(|p|p.name.as_ref())})
}
fn comment_json(comment: &Comment, profiles: &HashMap<Uuid, HistoricalUserProfile>) -> Value {
  json!({"id":comment.id,"parentCommentId":comment.parent_comment_id,"author":attribution(comment.author_id,profiles),"body":comment.body,"resolved":comment.resolved,"createdAt":comment.created_at,"updatedAt":comment.updated_at})
}

/// Composed creation keeps uncertain admissions after any possible durable
/// effect; replay never recreates comments, attachments or notification intents.
#[tracing::instrument(skip_all)]
pub(super) async fn create(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  use super::{IdempotencyBeginOutcome, IdempotencyRequirement, finish_or_abort_mcp_write};
  use myoxus_application::comment::{CommentCreationInput, SelectionAnchor};
  if !auth.has_scope("write:docs") {
    return Err((-32003, "write:docs scope required".into()));
  }
  let args = params
    .as_object()
    .ok_or_else(|| (-32602, "Expected comment arguments object".into()))?;
  if args.keys().any(|key| {
    ![
      "workspace_id",
      "external_id",
      "body",
      "parent_comment_id",
      "attachment_keys",
      "selection_anchor",
      "doc_text",
      "idempotency_key",
    ]
    .contains(&key.as_str())
  }) {
    return Err((-32602, "Unknown comment argument".into()));
  }
  if serde_json::to_vec(params)
    .map_err(|_| (-32602, "Invalid comment input".into()))?
    .len()
    > state.document_export_max_bytes
  {
    return Err((-32602, "Comment input exceeds document byte limit".into()));
  }
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let external_id = required_string(params, "external_id")?;
  let body = params
    .get("body")
    .cloned()
    .ok_or_else(|| (-32602, "body is required".into()))?;
  let parent = match params.get("parent_comment_id") {
    None | Some(Value::Null) => None,
    Some(_) => Some(parse_uuid(params, "parent_comment_id")?),
  };
  let attachment_keys = match params.get("attachment_keys") {
    None | Some(Value::Null) => Vec::new(),
    Some(Value::Array(values)) if values.len() <= 100 => {
      let mut keys = Vec::new();
      for value in values {
        let raw = value
          .as_str()
          .filter(|key| !key.is_empty() && key.len() <= 1024)
          .ok_or_else(|| (-32602, "Invalid attachment key".into()))?;
        let key = myoxus_application::ports::blob::BlobKey::parse(raw)
          .map_err(|_| (-32602, "Invalid attachment key".into()))?
          .as_str()
          .to_owned();
        if keys.contains(&key) {
          return Err((-32602, "Duplicate attachment key".into()));
        }
        keys.push(key);
      }
      keys
    }
    _ => return Err((-32602, "Invalid attachment_keys".into())),
  };
  let selection_anchor: Option<SelectionAnchor> = match params.get("selection_anchor") {
    None | Some(Value::Null) => None,
    Some(value) => {
      let fields = value
        .as_object()
        .ok_or_else(|| (-32602, "Invalid selection anchor".into()))?;
      if fields
        .keys()
        .any(|key| !["quote", "start", "end", "prefix", "suffix"].contains(&key.as_str()))
      {
        return Err((-32602, "Unknown selection anchor argument".into()));
      }
      let anchor: SelectionAnchor =
        serde_json::from_value(value.clone()).map_err(|_| (-32602, "Invalid selection anchor".into()))?;
      if anchor.quote.is_empty()
        || anchor.quote.chars().count() > 8192
        || [anchor.prefix.as_deref(), anchor.suffix.as_deref()]
          .into_iter()
          .flatten()
          .any(|s| s.chars().count() > 8192)
        || [anchor.start, anchor.end]
          .into_iter()
          .flatten()
          .any(|n| n > i32::MAX as usize)
      {
        return Err((-32602, "Invalid selection anchor bounds".into()));
      }
      Some(anchor)
    }
  };
  let doc_text = match params.get("doc_text") {
    None | Some(Value::Null) => None,
    Some(Value::String(text)) if text.chars().count() <= 8 * 1024 * 1024 => Some(text.clone()),
    _ => return Err((-32602, "Invalid doc_text".into())),
  };
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::CommentsCreate).await?;
  let comments = state
    .comment_service
    .as_ref()
    .ok_or_else(|| (-32002, "Comment service is not enabled".into()))?;
  let blob = state
    .blob_service
    .as_ref()
    .ok_or_else(|| (-32002, "Comment attachment service is not enabled".into()))?;
  let input = CommentCreationInput {
    workspace_id,
    doc_id,
    parent_comment_id: parent,
    body: body.clone(),
    attachment_keys: attachment_keys.clone(),
    selection_anchor: selection_anchor.clone(),
    doc_text: doc_text.clone(),
  };
  // Current authorization, parent binding and context preconditions precede
  // admission/replay; no comment or attachment has been written here.
  comments
    .validate_comment_creation_context(auth.user_id, &input, blob)
    .await
    .map_err(map_page_lifecycle_error)?;
  let semantic = json!({"workspace_id":workspace_id,"external_id":resolved.external_id,"body":body,"parent_comment_id":parent,"attachment_keys":attachment_keys,"selection_anchor":selection_anchor,"doc_text":doc_text});
  let guard = match crate::idempotency::begin(
    IdempotencyRequirement::Required,
    "comment_create",
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    IdempotencyBeginOutcome::Execute(guard) => guard,
    IdempotencyBeginOutcome::Replay(response) => return Ok(response),
  };
  let result=async {
    let created=comments.create_comment_with_context(auth.user_id,input,blob).await
      .map_err(|_|(-32002,"MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED_UNCERTAIN: comment creation requires operator readback".to_owned()))?;
    let mut result=mcp_json_response(json!({"workspaceId":workspace_id,"externalId":resolved.external_id,"commentId":created.comment.id,"parentCommentId":created.comment.parent_comment_id,"created":true,"attachmentKeys":created.attachment_keys,"selectionAnchor":created.selection_anchor}));
    result["_mcpInternalDocumentId"]=json!(doc_id);
    Ok(result)
  }.await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

/// Fresh document/lifecycle authority is checked before durable admission.
/// The shared owner repeats its own permission check at the actual Store write.
#[tracing::instrument(skip_all)]
pub(super) async fn mutate(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  use super::{IdempotencyBeginOutcome, IdempotencyRequirement};
  if !matches!(
    name,
    "comment_update"
      | "comment_set_resolved"
      | "comment_delete"
      | "comment_thread_mark_read"
      | "comment_threads_mark_all_read"
  ) {
    return Err((-32601, "Unknown comment operation".into()));
  }
  if !auth.has_scope("write:docs") {
    return Err((-32003, "write:docs scope required".into()));
  }
  let args = params
    .as_object()
    .ok_or_else(|| (-32602, "Expected comment arguments object".into()))?;
  let all = name == "comment_threads_mark_all_read";
  let value_arg = match name {
    "comment_update" => Some("body"),
    "comment_set_resolved" => Some("resolved"),
    _ => None,
  };
  if args.keys().any(|key| {
    !["workspace_id", "external_id", "idempotency_key"].contains(&key.as_str())
      && !(key == "comment_id" && !all)
      && value_arg != Some(key.as_str())
  }) {
    return Err((-32602, "Unknown comment argument".into()));
  }
  if serde_json::to_vec(params)
    .map_err(|_| (-32602, "Invalid comment input".into()))?
    .len()
    > state.document_export_max_bytes
  {
    return Err((-32602, "Comment input exceeds document byte limit".into()));
  }
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let external_id = required_string(params, "external_id")?;
  let comment_id = if all {
    None
  } else {
    Some(parse_uuid(params, "comment_id")?)
  };
  let body = if name == "comment_update" {
    Some(
      params
        .get("body")
        .cloned()
        .ok_or_else(|| (-32602, "body is required".into()))?,
    )
  } else {
    None
  };
  let resolved_flag = if name == "comment_set_resolved" {
    Some(
      params
        .get("resolved")
        .and_then(Value::as_bool)
        .ok_or_else(|| (-32602, "resolved must be a boolean".into()))?,
    )
  } else {
    None
  };
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::CommentsRead).await?;
  let comments = state
    .comment_service
    .as_ref()
    .ok_or_else(|| (-32002, "Comment service is not enabled".into()))?;
  if let Some(id) = comment_id {
    if name == "comment_thread_mark_read" {
      comments
        .validate_comment_thread_read(auth.user_id, workspace_id, doc_id, id)
        .await
        .map_err(map_page_lifecycle_error)?;
    } else {
      let action = match name {
        "comment_update" => DocAction::CommentsUpdate,
        "comment_set_resolved" => DocAction::CommentsResolve,
        _ => DocAction::CommentsDelete,
      };
      comments
        .validate_comment_management(auth.user_id, workspace_id, doc_id, id, action)
        .await
        .map_err(map_page_lifecycle_error)?;
    }
  }
  let semantic = json!({"workspace_id":workspace_id,"external_id":resolved.external_id,"comment_id":comment_id,"body":body,"resolved":resolved_flag});
  let guard = match crate::idempotency::begin(
    IdempotencyRequirement::Required,
    name,
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    IdempotencyBeginOutcome::Replay(response) => return Ok(response),
    IdempotencyBeginOutcome::Execute(guard) => guard,
  };
  let result = async {
    let mut output = json!({"workspaceId":workspace_id,"externalId":resolved.external_id});
    if let Some(id) = comment_id {
      output["commentId"] = json!(id);
    }
    let failure = |_| {
      (
        -32002,
        "MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED_UNCERTAIN: comment operation requires operator readback".to_owned(),
      )
    };
    match name {
      "comment_update" => {
        comments
          .update_comment(
            auth.user_id,
            comment_id.expect("validated comment ID"),
            body.expect("validated body"),
          )
          .await
          .map_err(failure)?;
        output["updated"] = json!(true);
      }
      "comment_set_resolved" => {
        let flag = resolved_flag.expect("validated resolved flag");
        comments
          .set_comment_resolved(auth.user_id, comment_id.expect("validated comment ID"), flag)
          .await
          .map_err(failure)?;
        output["resolved"] = json!(flag);
      }
      "comment_delete" => {
        output["deleted"] = json!(
          comments
            .delete_comment(auth.user_id, comment_id.expect("validated comment ID"))
            .await
            .map_err(failure)?
        );
      }
      "comment_thread_mark_read" => {
        output["markedRead"] = json!(
          comments
            .mark_comment_thread_read(
              auth.user_id,
              workspace_id,
              doc_id,
              comment_id.expect("validated thread ID")
            )
            .await
            .map_err(failure)?
        );
        output["userId"] = json!(auth.user_id);
      }
      _ => {
        output["affectedThreads"] = json!(
          comments
            .mark_all_comment_threads_read(auth.user_id, workspace_id, doc_id)
            .await
            .map_err(failure)?
        );
        output["userId"] = json!(auth.user_id);
      }
    }
    let mut response = mcp_json_response(output);
    response["_mcpInternalDocumentId"] = json!(doc_id);
    Ok(response)
  }
  .await;
  super::finish_or_abort_mcp_write(guard, state, auth, result).await
}
