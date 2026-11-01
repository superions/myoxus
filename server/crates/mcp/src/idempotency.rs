// SPDX-License-Identifier: AGPL-3.0-or-later
//! Durable replay protection for MCP write tools.
//!
//! Keys are scoped by API-key ID, tool name, and caller-supplied key. Only the
//! SHA-256 hash of a recursively canonicalized semantic payload is retained;
//! raw argument payloads are never stored or logged. Reset-link replay
//! intentionally retains its authorized URL/expiry in the credential-scoped
//! response until key deletion; it is never logged or audited and replay neither
//! refreshes expiry nor mints another token. A completed row owns the exact wire response, including bounded commit-bound
//! document readback where the tool contract requires it. Document handlers check
//! current Read scope and ACL again before returning replayed content. Replay
//! performs no domain mutation, outbox write, or mutation audit. Canonical document
//! transactions persist a recoverable response before committing. Abandoned
//! pre-commit admissions can be reclaimed with a new fencing ID; active writers
//! hold the ledger row locked. Legacy ambiguous admissions never expire.
//!
//! Rows use the existing `mcp_idempotency_keys` storage boundary and are
//! deleted with their API key. Retention beyond that boundary is an operations
//! policy concern; this guard does not create a second table or cleanup model.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;

use myoxus_application::mcp::{McpIdempotencyAdmission, McpIdempotencyRepository};
use tracing::warn;
use uuid::Uuid;

use crate::auth::McpAuthContext;

const REPLAY_MARKER: &str = "__myoxus_mcp_idempotency_replay";
const UNCERTAIN_WRITE_MARKER: &str = "__myoxus_mcp_uncertain_write";

pub(crate) type HandlerError = (i32, String);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Requirement {
  Optional,
  Required,
}

pub(crate) enum BeginOutcome {
  Execute(Guard),
  Replay(Value),
}

pub(crate) enum Guard {
  Bypass,
  Pending {
    row_id: Uuid,
    tool_name: String,
    recoverable: bool,
  },
}

impl Guard {
  /// Advance bounded composed-operation evidence, never discard creation.
  /// Reduced fixtures do not have an atomic receipt and keep their old path.
  pub(crate) async fn record_composed_step(
    &self,
    repository: &Arc<dyn McpIdempotencyRepository>,
    response: &Value,
  ) -> Result<(), HandlerError> {
    let Self::Pending {
      row_id,
      recoverable: true,
      ..
    } = self
    else {
      return Ok(());
    };
    match repository.complete(*row_id, response).await {
      Ok(true) => Ok(()),
      _ => Err((
        -32002,
        "MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED: retry the same key; composed-step persistence is uncertain".into(),
      )),
    }
  }
  /// Couple this admitted document write to its existing transaction owner.
  /// The bounded fallback survives interruption before optional readback; the
  /// normal completion replaces it with the exact authorized wire response.
  pub(crate) async fn document_write<T>(
    &self,
    auth: &McpAuthContext,
    params: &Value,
    operation: impl std::future::Future<Output = T>,
  ) -> T {
    let params = params.clone();
    self
      .document_write_with_response(
        auth,
        Arc::new(move |commit| super::tools::document_replay_response(&params, commit)),
        operation,
      )
      .await
  }

  /// Composed handlers scope this to creation only. Subsequent owners must not
  /// replace its receipt with an unrelated content or lifecycle outcome.
  pub(crate) async fn document_write_with_response<T>(
    &self,
    auth: &McpAuthContext,
    response: myoxus_application::mcp::McpDocumentResponseBuilder,
    operation: impl std::future::Future<Output = T>,
  ) -> T {
    let Self::Pending {
      row_id,
      recoverable: true,
      ..
    } = self
    else {
      return operation.await;
    };
    let replay = myoxus_application::mcp::McpDocumentWriteReplay {
      row_id: *row_id,
      api_key_id: auth.key_id,
      user_id: auth.user_id,
      response,
    };
    myoxus_application::mcp::with_mcp_document_write(replay, operation).await
  }
}

/// Begin a write using either the raw argument object or a typed semantic
/// projection supplied by the handler. `idempotency_key` is never hashed into
/// the payload and is never part of the replayed response.
pub(crate) async fn begin(
  requirement: Requirement,
  tool_name: &str,
  params: &Value,
  semantic_payload: Option<&Value>,
  auth: &McpAuthContext,
  repository: &Arc<dyn McpIdempotencyRepository>,
) -> Result<BeginOutcome, HandlerError> {
  if requirement == Requirement::Required {
    validate_required_key(params)?;
  }
  let key = params.get("idempotency_key").and_then(Value::as_str);
  let Some(key) = key else {
    return match requirement {
      Requirement::Optional => Ok(BeginOutcome::Execute(Guard::Bypass)),
      Requirement::Required => Err((-32602, "Missing required parameter: idempotency_key".to_string())),
    };
  };
  if key.trim().is_empty() {
    return Err((-32602, "idempotency_key must not be empty".to_string()));
  }
  if key.len() > 160 {
    return Err((-32602, "idempotency_key must not exceed 160 characters".to_string()));
  }
  let payload = semantic_payload.cloned().unwrap_or_else(|| {
    let mut payload = params.clone();
    if let Some(object) = payload.as_object_mut() {
      object.remove("idempotency_key");
    }
    payload
  });
  let payload_sha256 = payload_sha256(&payload)?;
  let document_payload_format = i16::from(matches!(
    tool_name,
    "create_page" | "document_import" | "update_doc" | "doc_patch"
  ));
  let row_id = Uuid::new_v4();
  let admission = repository
    .begin(
      row_id,
      auth.key_id,
      auth.user_id,
      tool_name,
      key,
      &payload_sha256,
      document_payload_format,
    )
    .await
    .map_err(|error| {
      warn!(tool = tool_name, error = %error, "MCP idempotency begin failed");
      (
        -32002,
        "MIX_MCP_IDEMPOTENCY_STORE_UNAVAILABLE: idempotency begin failed".to_string(),
      )
    })?;
  let McpIdempotencyAdmission::Existing {
    payload_sha256: existing_hash,
    document_payload_format: existing_format,
    response,
  } = admission
  else {
    return Ok(BeginOutcome::Execute(Guard::Pending {
      row_id,
      tool_name: tool_name.to_string(),
      recoverable: repository.document_transaction_recovery()
        && myoxus_application::mcp::atomic_document_write_tool(tool_name),
    }));
  };
  // Only historical Markdown admissions may match the former normalization.
  // The SQL lease recovery above compares the current hash, so this fallback
  // can replay a receipt but can never execute the changed native fragment.
  let historical_match = existing_format == 0
    && document_payload_format == 1
    && params.get("fragment").is_none()
    && params
      .get("content_markdown")
      .and_then(Value::as_str)
      .is_some_and(|source| !yjs::markdown::markdown_contains_html_blocks(source))
    && historical_markdown_hash(&payload)?.is_some_and(|hash| hash == existing_hash);
  if existing_hash != payload_sha256 && !historical_match {
    return Err((
      -32010,
      "MIX_MCP_IDEMPOTENCY_CONFLICT: idempotency_key was already used with a different payload".to_string(),
    ));
  }
  let response = response.ok_or_else(|| {
    (
      -32010,
      "MIX_MCP_IDEMPOTENCY_IN_PROGRESS: idempotency_key is already in progress; retry later".to_string(),
    )
  })?;
  if response.get(UNCERTAIN_WRITE_MARKER).and_then(Value::as_bool) == Some(true) {
    return Err((-32002, "MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED_UNCERTAIN: inspect the original operation; its effects are uncertain and must not be repeated with a new key".into()));
  }
  Ok(BeginOutcome::Replay(mark_replay(response)?))
}

/// Remove only the newly derived GFM count from normalized fragment blocks.
/// Callers restrict this to Markdown input and historical receipts; structured
/// counts and format-one receipts never enter this comparison.
fn historical_markdown_hash(payload: &Value) -> Result<Option<String>, HandlerError> {
  fn strip(blocks: &mut Value) -> bool {
    let Some(blocks) = blocks.as_array_mut() else {
      return false;
    };
    let mut changed = false;
    for block in blocks {
      if block.get("kind").and_then(Value::as_str) == Some("table") && block.get("headerRows") == Some(&Value::from(1))
      {
        block.as_object_mut().expect("table object").remove("headerRows");
        changed = true;
      }
      if let Some(children) = block.get_mut("children") {
        changed |= strip(children);
      }
    }
    changed
  }
  let mut previous = payload.clone();
  let fragment = if previous.get("initialContent").is_some() {
    previous.get_mut("initialContent")
  } else if previous.get("fragment").is_some() {
    previous.get_mut("fragment")
  } else {
    previous
      .get_mut("mutation")
      .and_then(|mutation| mutation.get_mut("fragment"))
  };
  let changed = fragment
    .and_then(|fragment| fragment.get_mut("blocks"))
    .is_some_and(strip);
  if changed {
    payload_sha256(&previous).map(Some)
  } else {
    Ok(None)
  }
}

pub(crate) fn validate_required_key(params: &Value) -> Result<(), HandlerError> {
  match params.get("idempotency_key").and_then(Value::as_str) {
    None => Err((-32602, "Missing required parameter: idempotency_key".to_string())),
    Some(key) if key.trim().is_empty() => Err((-32602, "idempotency_key must not be empty".to_string())),
    Some(key) if key.len() > 160 => Err((-32602, "idempotency_key must not exceed 160 characters".to_string())),
    Some(_) => Ok(()),
  }
}

/// Persist a successful response without claiming success when durability is
/// unknown. Atomic document receipts remain recoverable if this final write
/// fails. A bypassed call preserves shipped non-idempotent behavior.
pub(crate) async fn finish_or_abort(
  guard: Guard,
  repository: &Arc<dyn McpIdempotencyRepository>,
  result: Result<Value, HandlerError>,
) -> Result<Value, HandlerError> {
  let Guard::Pending {
    row_id,
    tool_name,
    recoverable,
  } = guard
  else {
    return result;
  };
  match result {
    Ok(response) => match repository.complete(row_id, &response).await {
      Ok(true) => Ok(response),
      outcome => {
        warn!(tool = %tool_name, stored = outcome.is_ok(), "MCP replay response persistence is uncertain");
        Err((
          -32002,
          "MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED: retry the same key; completion durability is uncertain".into(),
        ))
      }
    },
    Err(error) => {
      // Atomic owners fence final effects with the receipt. PDF may retain
      // an immutable source first; its history request ledger makes recapture
      // replayable when final job publication rolled back.
      // Composed and other shared callers can fail after a durable effect;
      // retaining admission is safer than authorizing that effect twice.
      let atomic_owner = myoxus_application::mcp::atomic_document_write_tool(&tool_name);
      if recoverable || (atomic_owner && tool_name != "document_import") {
        if repository.abort(row_id).await.is_err() {
          warn!(tool = %tool_name, "failed to remove aborted MCP idempotency guard");
        }
      } else {
        // The marker contains no arguments or backend error. Even if this
        // acknowledgement fails, the original admission remains retained.
        if repository
          .complete(row_id, &serde_json::json!({UNCERTAIN_WRITE_MARKER: true}))
          .await
          .is_err()
        {
          warn!(tool = %tool_name, "failed to persist uncertain MCP write outcome");
        }
      }
      Err(error)
    }
  }
}

pub(crate) fn is_replay(value: &Value) -> bool {
  value.get(REPLAY_MARKER).and_then(Value::as_bool) == Some(true)
}

pub(crate) fn strip_replay_marker(value: &mut Value) {
  if let Some(object) = value.as_object_mut() {
    object.remove(REPLAY_MARKER);
  }
}

fn mark_replay(mut response: Value) -> Result<Value, HandlerError> {
  let object = response.as_object_mut().ok_or_else(|| {
    (
      -32002,
      "MIX_MCP_IDEMPOTENCY_INVALID_RESPONSE: stored MCP response is not an object".to_string(),
    )
  })?;
  object.insert(REPLAY_MARKER.to_string(), Value::Bool(true));
  Ok(response)
}

pub(crate) fn payload_sha256(payload: &Value) -> Result<String, HandlerError> {
  let canonical = canonicalize_json(payload);
  let bytes = serde_json::to_vec(&canonical).map_err(|_| {
    (
      -32602,
      "MIX_MCP_IDEMPOTENCY_PAYLOAD_INVALID: arguments cannot be canonicalized".to_string(),
    )
  })?;
  Ok(hex::encode(Sha256::digest(bytes)))
}

fn canonicalize_json(value: &Value) -> Value {
  match value {
    Value::Array(values) => Value::Array(values.iter().map(canonicalize_json).collect()),
    Value::Object(values) => {
      let sorted = values
        .iter()
        .map(|(key, value)| (key.clone(), canonicalize_json(value)))
        .collect::<std::collections::BTreeMap<_, _>>();
      Value::Object(sorted.into_iter().collect())
    }
    _ => value.clone(),
  }
}

#[cfg(test)]
mod tests {
  use serde_json::json;

  use super::*;

  #[tokio::test]
  async fn historical_markdown_replays_only_completed_format_zero_receipts() {
    let repository: Arc<dyn McpIdempotencyRepository> =
      Arc::new(myoxus_application::mcp::InMemoryMcpIdempotencyRepository::default());
    let auth = McpAuthContext {
      user_id: Uuid::new_v4(),
      key_id: Uuid::new_v4(),
      scopes: vec!["write:docs".into()],
    };
    let fragment = json!({"schemaVersion":"myoxus.document-fragment.v1","blocks":[{"kind":"list_item","children":[{"kind":"table","rows":[[[{"text":"Header"}]]],"headerRows":1}]}]});
    for (tool, payload) in [
      ("create_page", json!({"initialContent":fragment})),
      ("document_import", json!({"fragment":fragment,"inputMode":"markdown"})),
      (
        "update_doc",
        json!({"mutation":{"operation":"replace_all","fragment":fragment}}),
      ),
      (
        "doc_patch",
        json!({"mutation":{"operation":"append_blocks","fragment":fragment}}),
      ),
    ] {
      let mut previous = payload.clone();
      let fragment_path = match tool {
        "create_page" => "/initialContent",
        "document_import" => "/fragment",
        _ => "/mutation/fragment",
      };
      previous
        .pointer_mut(&format!("{fragment_path}/blocks/0/children/0"))
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("headerRows");
      let old = payload_sha256(&previous).unwrap();
      assert_eq!(historical_markdown_hash(&payload).unwrap(), Some(old.clone()));
      let params = json!({"idempotency_key":tool,"content_markdown":"- | Header |\n  | --- |"});
      let row = Uuid::new_v4();
      repository
        .begin(row, auth.key_id, auth.user_id, tool, tool, &old, 0)
        .await
        .unwrap();
      assert!(
        matches!(begin(Requirement::Required,tool,&params,Some(&payload),&auth,&repository).await,Err((-32010,message)) if message.starts_with("MIX_MCP_IDEMPOTENCY_IN_PROGRESS"))
      );
      assert!(repository.complete(row, &json!({"outcome":"original"})).await.unwrap());
      let BeginOutcome::Replay(response) =
        begin(Requirement::Required, tool, &params, Some(&payload), &auth, &repository)
          .await
          .unwrap()
      else {
        panic!("historical completed result must replay")
      };
      assert_eq!(response["outcome"], "original");
      let html =
        json!({"idempotency_key":tool,"content_markdown":"<table><thead><tr><th>Header</th></tr></thead></table>"});
      assert!(
        matches!(begin(Requirement::Required,tool,&html,Some(&payload),&auth,&repository).await,Err((-32010,message)) if message.starts_with("MIX_MCP_IDEMPOTENCY_CONFLICT")),
        "new HTML cannot use a former GFM normalization"
      );
      let fenced = json!({"idempotency_key":tool,"content_markdown":"| Header |\n| --- |\n\n```html\n<table>literal</table>\n```"});
      assert!(
        matches!(
          begin(Requirement::Required, tool, &fenced, Some(&payload), &auth, &repository).await,
          Ok(BeginOutcome::Replay(_))
        ),
        "fenced HTML remains literal for historical replay"
      );

      let structured = json!({"idempotency_key":tool,"fragment":fragment});
      assert!(
        matches!(begin(Requirement::Required,tool,&structured,Some(&payload),&auth,&repository).await,Err((-32010,message)) if message.starts_with("MIX_MCP_IDEMPOTENCY_CONFLICT"))
      );
      let mut changed = payload.clone();
      changed["title"] = json!("changed");
      assert!(
        matches!(begin(Requirement::Required,tool,&params,Some(&changed),&auth,&repository).await,Err((-32010,message)) if message.starts_with("MIX_MCP_IDEMPOTENCY_CONFLICT"))
      );
      let new_params = json!({"idempotency_key":format!("new-{tool}"),"content_markdown":"| Header |\n| --- |"});
      // Even a format-one row containing the former hash cannot use fallback.
      let row = Uuid::new_v4();
      repository
        .begin(
          row,
          auth.key_id,
          auth.user_id,
          tool,
          new_params["idempotency_key"].as_str().unwrap(),
          &old,
          1,
        )
        .await
        .unwrap();
      repository.complete(row, &json!({"outcome":"new"})).await.unwrap();
      assert!(
        matches!(begin(Requirement::Required,tool,&new_params,Some(&payload),&auth,&repository).await,Err((-32010,message)) if message.starts_with("MIX_MCP_IDEMPOTENCY_CONFLICT"))
      );
    }
    assert_eq!(
      historical_markdown_hash(&json!({"fragment":{"blocks":[{"kind":"table","headerRows":0,"rows":[]}]}})).unwrap(),
      None
    );
    assert_eq!(
      historical_markdown_hash(&json!({"fragment":{"blocks":[{"kind":"table","headerRows":2,"rows":[]}]}})).unwrap(),
      None
    );
  }

  #[test]
  fn canonical_hash_ignores_object_order_but_preserves_array_order() {
    let left = json!({ "target": { "b": 2, "a": 1 }, "blocks": ["first", "second"] });
    let reordered = json!({ "blocks": ["first", "second"], "target": { "a": 1, "b": 2 } });
    let changed_order = json!({ "target": { "a": 1, "b": 2 }, "blocks": ["second", "first"] });
    assert_eq!(payload_sha256(&left).unwrap(), payload_sha256(&reordered).unwrap());
    assert_ne!(payload_sha256(&left).unwrap(), payload_sha256(&changed_order).unwrap());
  }
}
