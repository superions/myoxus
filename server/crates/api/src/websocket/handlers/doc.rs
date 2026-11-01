//! Doc-level event handlers for the Socket.IO layer.
//!
//! - `handle_load_doc` (`space:load-doc` with ACK)
//! - `handle_load_doc_timestamps` (`space:load-doc-timestamps` with ACK)
//! - `handle_delete_doc` (`space:delete-doc` fire-and-forget)
//! - `handle_push_update` (`space:push-doc-update` with ACK)
//!
//! Extracted from `mod.rs` in P107-I; the module boundary does not change the
//! protocol behavior.

use std::sync::Arc;

use myoxus_application::auth::AuthError;
use myoxus_application::doc::{
  DocLoadCancellationReason, DocSpaceKind, DocSyncConnectionContext, PermanentDeleteMode, PermanentDeleteRequest,
};
use myoxus_application::metrics::{MetricsCategory, MetricsService};
use serde_json::{Map as JsonMap, Value, json};
use socketioxide::extract::{AckSender, SocketRef};
use tracing::{debug, error, trace, warn};
use uuid::Uuid;

use crate::state::ApiState;

use super::super::access::{DocumentAccess, check_space_access, check_space_access_with_ack, parse_document_key};
use super::super::circuit_breaker;
use super::super::error::{
  WsErrorCategory, classify_auth_error, decode_external_update, stable_doc_load_error, stable_external_ingress_error,
};
use super::super::room::get_room;
use super::super::state::SOCKET_CLIENT_CONTEXTS;
use super::super::types::{
  BroadcastDocUpdateV25, BroadcastDocUpdatesV26, DeleteDocPayload, LoadDocPayload, LoadDocTimestampsPayload,
  PushDocUpdatePayload, SpaceType,
};

#[derive(Clone, Copy)]
struct DocSyncLoadMetricDimensions {
  client_kind: &'static str,
  space_type: &'static str,
  is_root: bool,
}

#[derive(Clone, Copy)]
enum DocSyncLoadOutcome {
  Success,
  InvalidDocId,
  InvalidSpaceId,
  NotFound,
  ResolutionFailed,
  InvalidStateVector,
  Busy,
  PayloadTooLarge,
  DecoderUnavailable,
  Cancelled,
  Failed,
}

impl DocSyncLoadOutcome {
  const fn as_str(self) -> &'static str {
    match self {
      Self::Success => "success",
      Self::InvalidDocId => "invalid_doc_id",
      Self::InvalidSpaceId => "invalid_space_id",
      Self::NotFound => "not_found",
      Self::ResolutionFailed => "resolution_failed",
      Self::InvalidStateVector => "invalid_state_vector",
      Self::Busy => "busy",
      Self::PayloadTooLarge => "payload_too_large",
      Self::DecoderUnavailable => "decoder_unavailable",
      Self::Cancelled => "cancelled",
      Self::Failed => "failed",
    }
  }
}

#[derive(Default)]
struct DocSyncLoadMetricValues {
  input_bytes: usize,
  output_bytes: usize,
  decoder_wait_ms: u64,
  materialize_ms: u64,
}

fn doc_sync_client_kind(client: Option<&str>) -> &'static str {
  match client {
    Some("web") => "web",
    Some("myoxus-electron") => "electron",
    Some("ios" | "android" | "mobile") => "mobile",
    Some("storage" | "core") => "storage",
    _ => "unknown",
  }
}

fn log_doc_sync_load_started(sync_operation_id: Uuid, dimensions: DocSyncLoadMetricDimensions, has_state_vector: bool) {
  debug!(
    event = "doc_sync.load.started",
    %sync_operation_id,
    client_kind = dimensions.client_kind,
    space_type = dimensions.space_type,
    has_state_vector,
    "document sync load started"
  );
}

fn log_doc_sync_load_rejected(sync_operation_id: Uuid, outcome: DocSyncLoadOutcome, retry_after_ms: Option<u64>) {
  warn!(
    event = "doc_sync.load.rejected",
    %sync_operation_id,
    reason = outcome.as_str(),
    retry_after_ms,
    "document sync load rejected"
  );
}

fn log_doc_sync_load_cancelled(sync_operation_id: Uuid, reason: DocLoadCancellationReason) {
  debug!(
    event = "doc_sync.load.cancelled",
    %sync_operation_id,
    phase = "load",
    reason = reason.as_str(),
    "document sync load cancelled"
  );
}

fn log_doc_sync_load_completed(
  sync_operation_id: Uuid,
  space_uuid: Uuid,
  doc_uuid: Uuid,
  values: &DocSyncLoadMetricValues,
  update_count: usize,
) {
  debug!(
    event = "doc_sync.load.completed",
    %sync_operation_id,
    %space_uuid,
    %doc_uuid,
    input_bytes = values.input_bytes,
    output_bytes = values.output_bytes,
    update_count,
    decoder_wait_ms = values.decoder_wait_ms,
    materialize_ms = values.materialize_ms,
    "document sync load completed"
  );
}

fn record_doc_sync_push_outcome(metrics: &MetricsService, outcome: &str) {
  metrics.record(MetricsCategory::Collab, "doc_sync_push_total", &[("outcome", outcome)]);
}

fn log_doc_sync_push_completed(
  sync_operation_id: Uuid,
  space_uuid: Option<Uuid>,
  doc_uuid: Option<Uuid>,
  input_bytes: usize,
  outcome: &str,
) {
  debug!(
    event = "doc_sync.push.completed",
    %sync_operation_id,
    ?space_uuid,
    ?doc_uuid,
    input_bytes,
    outcome,
    "document sync push completed"
  );
}

fn record_doc_sync_load_metrics(
  metrics: &MetricsService,
  dimensions: DocSyncLoadMetricDimensions,
  outcome: DocSyncLoadOutcome,
  values: DocSyncLoadMetricValues,
) {
  let outcome = outcome.as_str();
  let labels = [
    ("outcome", outcome),
    ("client_kind", dimensions.client_kind),
    ("space_type", dimensions.space_type),
    ("is_root", if dimensions.is_root { "true" } else { "false" }),
  ];
  metrics.record(MetricsCategory::Collab, "doc_sync_load_total", &labels);
  let labels_json = || {
    labels
      .iter()
      .map(|(key, value)| ((*key).to_string(), Value::String((*value).to_string())))
      .collect::<JsonMap<String, Value>>()
  };
  metrics.record_with(
    MetricsCategory::Collab,
    "doc_sync_load_input_bytes_total",
    labels_json(),
    values.input_bytes as f64,
  );
  metrics.record_with(
    MetricsCategory::Collab,
    "doc_sync_load_output_bytes_total",
    labels_json(),
    values.output_bytes as f64,
  );
  for (metric, value) in [
    ("doc_sync_load_decoder_wait_ms_total", values.decoder_wait_ms as f64),
    ("doc_sync_load_materialize_ms_total", values.materialize_ms as f64),
  ] {
    let mut outcome_label = JsonMap::new();
    outcome_label.insert("outcome".to_string(), Value::String(outcome.to_string()));
    metrics.record_with(MetricsCategory::Collab, metric, outcome_label, value);
  }
}

#[expect(
  clippy::too_many_arguments,
  reason = "sync rejection must retain every protocol and cancellation field"
)]
fn reject_doc_sync_load(
  state: &ApiState,
  ack: AckSender,
  sync_operation_id: Uuid,
  dimensions: DocSyncLoadMetricDimensions,
  outcome: DocSyncLoadOutcome,
  error_name: &'static str,
  message: &'static str,
  retryable: bool,
  retry_after_ms: Option<u64>,
  cancellation_reason: Option<DocLoadCancellationReason>,
) {
  record_doc_sync_load_metrics(state.metrics(), dimensions, outcome, DocSyncLoadMetricValues::default());
  if let Some(reason) = cancellation_reason {
    log_doc_sync_load_cancelled(sync_operation_id, reason);
    state.metrics().record(
      MetricsCategory::Collab,
      "doc_sync_cancel_total",
      &[("phase", "load"), ("reason", reason.as_str())],
    );
  } else {
    log_doc_sync_load_rejected(sync_operation_id, outcome, retry_after_ms);
  }
  let mut error = json!({
    "name": error_name,
    "message": message,
    "retryable": retryable,
  });
  if let (Some(retry_after_ms), Some(object)) = (retry_after_ms, error.as_object_mut()) {
    object.insert("retryAfterMs".to_string(), json!(retry_after_ms));
  }
  ack.send(&json!({ "error": error })).ok();
}

/// Handles the acknowledged `space:load-doc` event.
///
/// The dispatcher has already authenticated the socket, joined or auto-joined
/// the space, and applied [`DocumentAccess::ReadOrNotFound`]. This handler then
/// validates the workspace-local key and resolves it to an internal UUID in the
/// authorized space. An unknown workspace key returns `DOC_NOT_FOUND` without
/// creating a document; the owner-only userspace empty-first-load contract is
/// intentionally separate.
///
/// The load service streams one repeatable-read snapshot and ordered update
/// tail through a capacity-one channel into one decoder-gated Yjs document.
/// Server state vector and missing Yjs-v1 diff come from that same
/// materialization. Invalid input, cancellation and diff failures are terminal
/// for this request and never trigger a full-document fallback.
///
/// # ACK
///
/// ```json
/// { "data": { "missing": "<base64>", "state": "<base64>", "timestamp": <millis> } }
/// ```
///
/// Errors use `{ "error": { "name": "...", "message": "..." } }`.
///
/// Successful workspace loads schedule deduplicated view tracking. The ACK
/// timestamp is the response time, not the document's persisted `updated_at`.
pub(in crate::websocket) async fn handle_load_doc(
  data: LoadDocPayload,
  user_id: Uuid,
  socket_id: String,
  state: Arc<ApiState>,
  ack: AckSender,
) {
  use base64::{Engine as _, engine::general_purpose::STANDARD};
  let sync_operation_id = Uuid::new_v4();
  let mut metric_dimensions = DocSyncLoadMetricDimensions {
    client_kind: doc_sync_client_kind(data.client_context.client.as_deref()),
    space_type: match data.space_type {
      SpaceType::Workspace => "workspace",
      SpaceType::Userspace => "userspace",
    },
    is_root: false,
  };
  let has_state_vector = data.state_vector.is_some();
  log_doc_sync_load_started(sync_operation_id, metric_dimensions, has_state_vector);
  let document_key = match parse_document_key(&data.doc_id) {
    Ok(document_key) => document_key,
    Err(_) => {
      reject_doc_sync_load(
        &state,
        ack,
        sync_operation_id,
        metric_dimensions,
        DocSyncLoadOutcome::InvalidDocId,
        "INVALID_DOC_ID",
        "invalid document id",
        false,
        None,
        None,
      );
      return;
    }
  };
  let space_uuid = match Uuid::parse_str(&data.space_id) {
    Ok(id) => id,
    Err(_) => {
      reject_doc_sync_load(
        &state,
        ack,
        sync_operation_id,
        metric_dimensions,
        DocSyncLoadOutcome::InvalidSpaceId,
        "INVALID_SPACE_ID",
        "invalid space id",
        false,
        None,
        None,
      );
      return;
    }
  };
  let space_kind = match data.space_type {
    SpaceType::Workspace => DocSpaceKind::Workspace,
    SpaceType::Userspace => DocSpaceKind::Userspace,
  };
  let doc_uuid = match state
    .doc()
    .resolve_document_key(space_uuid, space_kind.clone(), &document_key)
    .await
  {
    Ok(Some(doc_id)) => doc_id,
    Ok(None) if matches!(space_kind, DocSpaceKind::Userspace) => Uuid::nil(),
    Ok(None) => {
      // Missing alone is not deletion: interrupted first uploads need recovery.
      let deleted = match state.doc().is_page_permanently_deleted(space_uuid, &document_key).await {
        Ok(deleted) => deleted,
        Err(_) => {
          reject_doc_sync_load(
            &state,
            ack,
            sync_operation_id,
            metric_dimensions,
            DocSyncLoadOutcome::ResolutionFailed,
            "INTERNAL_ERROR",
            "failed to resolve deletion evidence",
            true,
            None,
            None,
          );
          return;
        }
      };
      let moved = match if deleted {
        Ok(false)
      } else {
        state.doc().is_page_moved(space_uuid, &document_key).await
      } {
        Ok(moved) => moved,
        Err(_) => {
          reject_doc_sync_load(
            &state,
            ack,
            sync_operation_id,
            metric_dimensions,
            DocSyncLoadOutcome::ResolutionFailed,
            "INTERNAL_ERROR",
            "failed to resolve move evidence",
            true,
            None,
            None,
          );
          return;
        }
      };
      reject_doc_sync_load(
        &state,
        ack,
        sync_operation_id,
        metric_dimensions,
        DocSyncLoadOutcome::NotFound,
        if deleted {
          "DOC_DELETED"
        } else if moved {
          "DOC_MOVED"
        } else {
          "DOC_NOT_FOUND"
        },
        if deleted {
          "document permanently deleted"
        } else if moved {
          "document moved from this workspace"
        } else {
          "doc not found"
        },
        false,
        None,
        None,
      );
      return;
    }
    Err(_) => {
      reject_doc_sync_load(
        &state,
        ack,
        sync_operation_id,
        metric_dimensions,
        DocSyncLoadOutcome::ResolutionFailed,
        "INTERNAL_ERROR",
        "failed to resolve document",
        true,
        None,
        None,
      );
      return;
    }
  };
  metric_dimensions.is_root = doc_uuid == space_uuid;
  let client_state_vector = match data.state_vector.as_deref() {
    Some(encoded) => match STANDARD.decode(encoded) {
      Ok(decoded) => Some(decoded),
      Err(_) => {
        reject_doc_sync_load(
          &state,
          ack,
          sync_operation_id,
          metric_dimensions,
          DocSyncLoadOutcome::InvalidStateVector,
          "INVALID_STATE_VECTOR",
          "invalid Yjs state vector",
          false,
          None,
          None,
        );
        return;
      }
    },
    None => None,
  };
  let Some(load_guard) = super::super::state::try_begin_doc_load(&socket_id, space_uuid, doc_uuid) else {
    reject_doc_sync_load(
      &state,
      ack,
      sync_operation_id,
      metric_dimensions,
      DocSyncLoadOutcome::Busy,
      "SYNC_BUSY",
      "document sync load already in progress",
      true,
      Some(250),
      None,
    );
    return;
  };
  let is_workspace_space = data.space_type != SpaceType::Userspace;
  let max_payload_bytes = state.config.websocket.max_http_buffer_size().min(usize::MAX as u64) as usize;
  let cancellation = load_guard.cancellation();
  let load_result = match state
    .doc()
    .load
    .load_diff_with_meta(
      sync_operation_id,
      space_uuid,
      doc_uuid,
      client_state_vector,
      max_payload_bytes,
      cancellation.clone(),
    )
    .await
  {
    Ok(r) => {
      // P103-B-02 / LRN-20260424-USERSPACE-LOAD: exists=false has TWO meanings:
      //   - workspace docs: row in `docs` is missing / soft-deleted → DOC_NOT_FOUND
      //   - userspace docs: personal space has NO row in `docs` on first load — this
      //     is the normal empty-first-load state and must NOT surface as DOC_NOT_FOUND
      //     (Journal root doc bug 2026-04-24: blank page on first visit).
      if is_workspace_space && !r.exists {
        reject_doc_sync_load(
          &state,
          ack,
          sync_operation_id,
          metric_dimensions,
          DocSyncLoadOutcome::NotFound,
          "DOC_NOT_FOUND",
          "doc not found",
          false,
          None,
          None,
        );
        return;
      }
      r
    }
    Err(error) => {
      let (outcome, cancellation_reason) = match &error {
        AuthError::InvalidYjsStateVector => (DocSyncLoadOutcome::InvalidStateVector, None),
        AuthError::DocSyncPayloadTooLarge { .. } => (DocSyncLoadOutcome::PayloadTooLarge, None),
        AuthError::DocSyncCancelled => (
          DocSyncLoadOutcome::Cancelled,
          Some(cancellation.reason().unwrap_or(DocLoadCancellationReason::Explicit)),
        ),
        AuthError::YjsDecoderUnavailable => (DocSyncLoadOutcome::DecoderUnavailable, None),
        _ => (DocSyncLoadOutcome::Failed, None),
      };
      let (name, message, retryable) =
        stable_doc_load_error(&error).unwrap_or(("INTERNAL_ERROR", "failed to load document", true));
      reject_doc_sync_load(
        &state,
        ack,
        sync_operation_id,
        metric_dimensions,
        outcome,
        name,
        message,
        retryable,
        None,
        cancellation_reason,
      );
      return;
    }
  };
  let missing_for_wire = STANDARD.encode(&load_result.missing);
  let state_for_wire = STANDARD.encode(&load_result.state_vector);
  if missing_for_wire
    .len()
    .saturating_add(state_for_wire.len())
    .saturating_add(256)
    > max_payload_bytes
  {
    reject_doc_sync_load(
      &state,
      ack,
      sync_operation_id,
      metric_dimensions,
      DocSyncLoadOutcome::PayloadTooLarge,
      "SYNC_PAYLOAD_TOO_LARGE",
      "document sync payload exceeds the configured size limit",
      true,
      None,
      None,
    );
    return;
  }
  if is_workspace_space {
    state
      .doc()
      .load
      .fire_view_tracking(space_uuid, doc_uuid, user_id, true, state.workspace().clone());
  }

  let page_registration = if is_workspace_space {
    match state.doc().page_registration_state(space_uuid, doc_uuid).await {
      Ok(value) => value,
      Err(_) => {
        ack.send(&json!({"error": {"name": "INTERNAL_ERROR", "message": "page registration could not be loaded", "retryable": true}})).ok();
        return;
      }
    }
  } else {
    None
  };
  let metric_values = DocSyncLoadMetricValues {
    input_bytes: load_result.input_bytes,
    output_bytes: load_result.missing.len() + load_result.state_vector.len(),
    decoder_wait_ms: load_result.decoder_wait_ms,
    materialize_ms: load_result.materialize_ms,
  };
  log_doc_sync_load_completed(
    sync_operation_id,
    space_uuid,
    doc_uuid,
    &metric_values,
    load_result.update_count,
  );
  record_doc_sync_load_metrics(
    state.metrics(),
    metric_dimensions,
    DocSyncLoadOutcome::Success,
    metric_values,
  );

  ack
    .send(&json!({
        "data": {
            "missing": missing_for_wire,
            "state": state_for_wire,
            "timestamp": chrono::Utc::now().timestamp_millis(),
            "pageRegistration": page_registration,
        }
    }))
    .ok();
}

/// Handles the acknowledged `space:load-doc-timestamps` event.
///
/// The optional millisecond timestamp is an exclusive lower bound used for
/// incremental synchronization. Results use workspace-local external keys and
/// are filtered through the caller's effective `DocAction::Read` permission;
/// the timestamp map must never disclose an unreadable document.
///
/// # ACK
///
/// ```json
/// { "data": { "<doc_id>": <timestamp_millis>, ... }, "timestamp": <millis> }
/// ```
///
/// Errors use `{ "error": { "name": "...", "message": "..." } }`.
pub(in crate::websocket) async fn handle_load_doc_timestamps(
  data: LoadDocTimestampsPayload,
  user_id: Uuid,
  state: Arc<ApiState>,
  ack: AckSender,
) {
  let space_uuid = match Uuid::parse_str(&data.space_id) {
    Ok(id) => id,
    Err(_) => {
      ack
        .send(&json!({ "error": { "name": "INVALID_SPACE_ID", "message": "invalid space id" } }))
        .ok();
      return;
    }
  };
  let timestamps_result = state.doc().get_space_doc_timestamps(space_uuid, data.timestamp).await;
  match timestamps_result {
    Ok(timestamps) => {
      let timestamps = if data.space_type == SpaceType::Workspace {
        match state.doc().list_workspace_docs(space_uuid, i64::MAX, 0).await {
          Ok(documents) => {
            match crate::document_access::filter_readable_workspace_documents(&state, user_id, space_uuid, documents)
              .await
            {
              Ok(documents) => {
                let allowed_keys: std::collections::HashSet<_> =
                  documents.into_iter().map(|doc| doc.external_id).collect();
                timestamps
                  .into_iter()
                  .filter(|(external_id, _)| allowed_keys.contains(external_id))
                  .collect()
              }
              Err(error) => {
                error!(%space_uuid, %error, "failed to filter timestamp map by document ACL");
                ack
                  .send(&json!({ "error": { "name": "INTERNAL_ERROR", "message": "failed to load timestamps" } }))
                  .ok();
                return;
              }
            }
          }
          Err(error) => {
            error!(%space_uuid, %error, "failed to load document metadata for timestamp ACL");
            ack
              .send(&json!({ "error": { "name": "INTERNAL_ERROR", "message": "failed to load timestamps" } }))
              .ok();
            return;
          }
        }
      } else {
        timestamps
      };
      ack
        .send(&json!({
            "data": timestamps,
            "timestamp": chrono::Utc::now().timestamp_millis(),
        }))
        .ok();
    }
    Err(e) => {
      // P101-WS-ERR-01/04: Classify and log with context.
      let category = classify_auth_error(&e);
      error!(
        %space_uuid,
        space_type = %data.space_type,
        error_category = %category.as_log_label(),
        error = %e,
        "failed to load doc timestamps"
      );
      ack
        .send(&json!({ "error": { "name": category.as_error_name(), "message": "failed to load timestamps" } }))
        .ok();
    }
  }
}

/// Handles the fire-and-forget `space:delete-doc` compatibility event.
///
/// This is permanent deletion, not the root-Yjs trash projection. The
/// dispatcher has already required [`DocumentAccess::Existing`] with
/// `DocAction::Delete`; the handler delegates to the same authoritative
/// application workflow used by the acknowledged GraphQL path. That workflow
/// removes root metadata before relational document state.
///
/// Success broadcasts `space:doc-delete` to other local clients and, when
/// configured, through Redis to other server instances. Because the protocol
/// has no ACK, failures are logged and surfaced as `sync-error`; no delete
/// broadcast is emitted on failure.
pub(in crate::websocket) async fn handle_delete_doc(
  socket: SocketRef,
  data: DeleteDocPayload,
  user_id: Uuid,
  state: Arc<ApiState>,
) {
  let space_uuid = match Uuid::parse_str(&data.space_id) {
    Ok(id) => id,
    Err(_) => return,
  };
  let document_key = match parse_document_key(&data.doc_id) {
    Ok(document_key) => document_key,
    Err(_) => return,
  };

  let delete_result = state
    .doc()
    .permanently_delete_documents(PermanentDeleteRequest {
      workspace_id: space_uuid,
      actor_user_id: Some(user_id),
      mode: PermanentDeleteMode::SelectedDocs,
      doc_ids: vec![data.doc_id.clone()],
    })
    .await;

  let delete_result = match delete_result {
    Ok(result) => result,
    Err(e) => {
      // P101-WS-ERR-01/04: Classify and log with full context.
      let category = classify_auth_error(&e);
      error!(
        external_id = %document_key,
        space_type = %data.space_type,
        space_id = %data.space_id,
        error_category = %category.as_log_label(),
        error = %e,
        "failed to delete document via websocket"
      );
      return;
    }
  };
  if delete_result.failed > 0 || delete_result.forbidden > 0 {
    error!(
      external_id = %document_key,
      space_type = %data.space_type,
      space_id = %data.space_id,
      failed = delete_result.failed,
      forbidden = delete_result.forbidden,
      "permanent delete via websocket did not complete cleanly"
    );
    return;
  }

  state.metrics().record(
    myoxus_application::metrics::MetricsCategory::Doc,
    "doc_deleted",
    &[("source", "ws")],
  );

  let room = get_room(data.space_type, &data.space_id, "sync");
  let sender_sid = socket.id.to_string();
  let delete_payload = json!({ "docId": data.doc_id });
  let io_ref = state.socket_io.read().unwrap_or_else(|e| e.into_inner()).clone();
  if let Some(io) = &io_ref {
    let _ = io
      .to(room)
      .except(sender_sid.clone())
      .emit("space:doc-delete", &delete_payload)
      .await;

    // SC-M-01: Publish doc-delete to Redis Pub/Sub for cross-instance fan-out.
    if data.space_type == SpaceType::Workspace
      && let Some(adapter) = state.redis_ws_adapter()
    {
      adapter
        .broadcast_to_workspace(&data.space_id, "space:doc-delete", &delete_payload, &sender_sid)
        .await;
    }
  }
}

/// Handles the acknowledged `space:push-doc-update` event.
///
/// The dispatcher has already selected [`DocumentAccess::UpdateOrCreate`]: an
/// existing active document requires `DocAction::Update`, while a genuinely
/// unknown workspace key requires `WorkspaceAction::CreateDoc`. Blocked and
/// soft-deleted rows never enter the create branch.
///
/// This handler validates the workspace-local key, decodes Base64, and delegates
/// client-controlled bytes to `DocService::push_external_update_with_context`.
/// That application boundary enforces decoded size and structural Yjs-v1
/// validity before the persistence layer atomically resolves or materializes
/// the document and appends the update.
///
/// # ACK
///
/// ```json
/// { "data": { "accepted": true, "timestamp": <millis> } }
/// ```
///
/// A success ACK is sent only after the transaction has durably persisted new
/// CRDT information or classified the payload under the document lock as an
/// exact replay/CRDT no-op. Errors use `{ "error": { "name": "...", "message":
/// "..." } }`, allowing the client to retry without treating data loss as
/// success.
///
/// Only newly persisted updates reach protocol 0.25/0.26 broadcasts, Redis,
/// search indexing, cache invalidation and compaction. Repeated
/// per-socket/document failures are classified by the circuit breaker to
/// prevent an unbounded client retry storm.
pub(in crate::websocket) async fn handle_push_update(
  socket: SocketRef,
  data: PushDocUpdatePayload,
  user_id: Uuid,
  state: Arc<ApiState>,
  ack: AckSender,
) {
  let sync_operation_id = Uuid::new_v4();
  let connection_context = SOCKET_CLIENT_CONTEXTS
    .get(&socket.id.to_string())
    .map(|context| DocSyncConnectionContext {
      client_kind: context.kind,
    });
  let space_uuid = match Uuid::parse_str(&data.space_id) {
    Ok(id) => id,
    Err(_) => {
      record_doc_sync_push_outcome(state.metrics(), "rejected");
      log_doc_sync_push_completed(sync_operation_id, None, None, data.update.len(), "rejected");
      ack
        .send(&json!({ "error": { "name": "INVALID_SPACE_ID", "message": "invalid space id" } }))
        .ok();
      return;
    }
  };
  let document_key = match parse_document_key(&data.doc_id) {
    Ok(document_key) => document_key,
    Err(e) => {
      record_doc_sync_push_outcome(state.metrics(), "rejected");
      log_doc_sync_push_completed(sync_operation_id, Some(space_uuid), None, data.update.len(), "rejected");
      ack
        .send(&json!({ "error": { "name": "INVALID_DOC_ID", "message": e } }))
        .ok();
      return;
    }
  };
  trace!(
    external_id = %document_key,
    space_id = %data.space_id,
    update_size = data.update.len(),
    client_kind = connection_context.as_ref().map(|context| context.client_kind.as_str()).unwrap_or("unknown"),
    "handle_push_update: processing"
  );
  let update_binary = match decode_external_update(&data.update) {
    Ok(b) => b,
    Err(_) => {
      record_doc_sync_push_outcome(state.metrics(), "rejected");
      log_doc_sync_push_completed(sync_operation_id, Some(space_uuid), None, data.update.len(), "rejected");
      ack
        .send(&json!({ "error": { "name": "INVALID_YJS_UPDATE", "message": "invalid Yjs update" } }))
        .ok();
      return;
    }
  };

  let timestamp = chrono::Utc::now().timestamp_millis();
  let persistence = match state
    .doc()
    .push_external_update_with_context(
      sync_operation_id,
      connection_context,
      space_uuid,
      document_key.clone(),
      update_binary.clone(),
      timestamp,
      match data.space_type {
        SpaceType::Workspace => DocSpaceKind::Workspace,
        SpaceType::Userspace => DocSpaceKind::Userspace,
      },
      Some(user_id),
      data.client_context.client_format.clone(),
      data.client_context.client_capabilities.clone(),
      data.initial_document_provenance.clone(),
    )
    .await
  {
    Ok(persistence) => persistence,
    Err(e) => {
      record_doc_sync_push_outcome(state.metrics(), "rejected");
      log_doc_sync_push_completed(
        sync_operation_id,
        Some(space_uuid),
        None,
        update_binary.len(),
        "rejected",
      );
      if matches!(data.space_type, SpaceType::Workspace)
        && matches!(&e, myoxus_application::auth::AuthError::NotFound(_))
        && matches!(
          state.doc().is_page_permanently_deleted(space_uuid, &document_key).await,
          Ok(true)
        )
      {
        ack.send(&json!({ "error": { "name": "DOC_DELETED", "message": "document permanently deleted", "retryable": false } })).ok();
        return;
      }
      if matches!(data.space_type, SpaceType::Workspace)
        && matches!(&e, myoxus_application::auth::AuthError::NotFound(_))
      {
        match state.doc().is_page_moved(space_uuid, &document_key).await {
          Ok(true) => {
            ack.send(&json!({ "error": { "name": "DOC_MOVED", "message": "document moved from this workspace", "retryable": false } })).ok();
            return;
          }
          Err(_) => {
            // Unavailable evidence must not turn retirement into creation recovery.
            ack.send(&json!({ "error": { "name": "INTERNAL_ERROR", "message": "failed to resolve move evidence", "retryable": true } })).ok();
            return;
          }
          Ok(false) => {}
        }
      }

      // P0-04: malformed or oversized external updates are permanent ingress
      // failures. Resolve them before the generic circuit-breaker mapping so
      // retries cannot rewrite the stable client contract to PERMANENT_ERROR.
      let stable_ingress_error = stable_external_ingress_error(&e);
      if let Some((name, message)) = stable_ingress_error {
        warn!(
          external_id = %document_key,
          space_id = %data.space_id,
          update_size = update_binary.len(),
          error_name = name,
          "external Yjs update rejected before persistence"
        );
        ack.send(&json!({ "error": { "name": name, "message": message } })).ok();
        return;
      }

      // P101-WS-ERR-01: Classify the error to give the client actionable information.
      let category = classify_auth_error(&e);

      // P101-WS-ERR-03: Record failure in circuit breaker and check threshold.
      let circuit_status = circuit_breaker::record_failure(&socket.id.to_string(), &data.space_id, &data.doc_id);

      // P101-WS-ERR-03: If circuit breaker is open, escalate to PERMANENT_ERROR
      // regardless of the original category — the client should stop retrying.
      let effective_category = if circuit_status.is_open() {
        WsErrorCategory::Permanent
      } else {
        category
      };

      // P101-WS-ERR-04: Structured error logging with full context.
      let space_type_label = match data.space_type {
        SpaceType::Workspace => "workspace",
        SpaceType::Userspace => "userspace",
      };

      // P101-WS-ERR-03: Reduce log level for circuit-open docs to avoid log flooding.
      if circuit_status.is_open() {
        debug!(
          external_id = %document_key,
          space_type = %space_type_label,
          space_id = %data.space_id,
          error_category = %effective_category.as_log_label(),
          retry_count = circuit_status.retry_count(),
          error = %e,
          "push_update failed (circuit open, suppressing further error logs)"
        );
      } else {
        error!(
          external_id = %document_key,
          space_type = %space_type_label,
          space_id = %data.space_id,
          error_category = %category.as_log_label(),
          retry_count = circuit_status.retry_count(),
          error = %e,
          "failed to persist doc update"
        );
      }

      // ACK success must mean durable persistence for both space kinds. The
      // storage client already throws on this error shape, keeping the update in
      // the sync failure path instead of advancing its remote clock falsely.
      ack
        .send(&json!({ "error": { "name": effective_category.as_error_name(), "message": "failed to save update" } }))
        .ok();
      return;
    }
  };

  // P101-WS-ERR-03: Record success — reset circuit breaker for this doc.
  circuit_breaker::record_success(&socket.id.to_string(), &data.space_id, &data.doc_id);

  let doc_uuid = persistence.doc_id;
  record_doc_sync_push_outcome(state.metrics(), persistence.outcome.as_str());
  log_doc_sync_push_completed(
    sync_operation_id,
    Some(space_uuid),
    Some(doc_uuid),
    update_binary.len(),
    persistence.outcome.as_str(),
  );

  if !persistence.outcome.is_persisted() {
    ack
      .send(&json!({ "data": { "accepted": true, "timestamp": timestamp, "pageRegistration": persistence.page_registration } }))
      .ok();
    return;
  }

  state.metrics().record(
    myoxus_application::metrics::MetricsCategory::Collab,
    "doc_update_pushed",
    &[(
      "space_type",
      match data.space_type {
        SpaceType::Workspace => "workspace",
        SpaceType::Userspace => "userspace",
      },
    )],
  );

  // Debounced search indexing: enqueue at most one deferred snapshot job per
  // document within a 5-second window.  Redis stores a short-lived marker to
  // avoid redundant enqueues for rapid keystrokes.
  if data.space_type == SpaceType::Workspace
    && doc_uuid != space_uuid
    && let Some(indexer) = state.search_indexer()
  {
    let debounce_key = format!("search:debounce:{doc_uuid}");
    let already_pending = state
      .redis_port()
      .get_string(&debounce_key)
      .await
      .ok()
      .flatten()
      .is_some();
    if !already_pending {
      let _ = state.redis_port().set_string(&debounce_key, "1", Some(5)).await;
      if let Err(e) = indexer.enqueue_deferred_snapshot(space_uuid, doc_uuid, 5).await {
        warn!(%doc_uuid, error = %e, "failed to enqueue deferred search snapshot");
      }
    }
  }

  // Workspace fan-out is owned by the durable outbox row committed with this
  // update. Wake that consumer for low-latency delivery; the periodic poller
  // remains the crash/retry fallback. Userspace has no workspace outbox event
  // and retains the direct room path.
  if data.space_type == SpaceType::Workspace {
    state.resource_updates.wake(space_uuid);
    crate::document_broadcast_outbox::wake_workspace_doc_broadcast_consumer(state.clone());
    ack
      .send(&json!({ "data": { "accepted": true, "timestamp": timestamp, "pageRegistration": persistence.page_registration } }))
      .ok();
    return;
  }

  let editor = user_id.to_string();

  // Userspace fanout preserves both protocol rooms. on_connect joins each
  // socket's private SID room, making except(sender_sid) suppress local echoes.
  let room_025 = get_room(data.space_type, &data.space_id, "sync-025");
  let room_026 = get_room(data.space_type, &data.space_id, "sync-026");
  let sender_sid = socket.id.to_string();

  let io_ref = state.socket_io.read().unwrap_or_else(|e| e.into_inner()).clone();
  if let Some(io) = &io_ref {
    let payload_v25 = BroadcastDocUpdateV25 {
      space_type: data.space_type,
      space_id: data.space_id.clone(),
      doc_id: data.doc_id.clone(),
      update: data.update.clone(),
      timestamp,
      editor: editor.clone(),
    };
    if let Err(e) = io
      .to(room_025)
      .except(sender_sid.clone())
      .emit("space:broadcast-doc-update", &payload_v25)
      .await
    {
      warn!(doc_id = %data.doc_id, space_id = %data.space_id, error = %e, "broadcast v25 failed");
    }

    let payload_v26 = BroadcastDocUpdatesV26 {
      space_type: data.space_type,
      space_id: data.space_id.clone(),
      doc_id: data.doc_id.clone(),
      updates: vec![data.update],
      timestamp,
      editor,
      compressed: false,
    };
    if let Err(e) = io
      .to(room_026)
      .except(sender_sid.clone())
      .emit("space:broadcast-doc-updates", &payload_v26)
      .await
    {
      warn!(doc_id = %data.doc_id, space_id = %data.space_id, error = %e, "broadcast v26 failed");
    }

    // SC-M-01: Publish both broadcast formats to Redis Pub/Sub for cross-instance fan-out.
    if let Some(adapter) = state.redis_ws_adapter() {
      adapter
        .broadcast_to_workspace(
          &data.space_id,
          "space:broadcast-doc-update",
          &serde_json::to_value(&payload_v25).unwrap_or_default(),
          &sender_sid,
        )
        .await;
      adapter
        .broadcast_to_workspace(
          &data.space_id,
          "space:broadcast-doc-updates",
          &serde_json::to_value(&payload_v26).unwrap_or_default(),
          &sender_sid,
        )
        .await;
    }
  }

  ack
    .send(&json!({ "data": { "accepted": true, "timestamp": timestamp, "pageRegistration": persistence.page_registration } }))
    .ok();
}

// ─── Dispatch wrappers (Slot I, P108) ────────────────────────────────────────
//
// Each dispatch function runs the shared access-check preamble
// (check_space_access_with_ack / check_space_access) and then delegates to
// the corresponding handler.  These are the functions registered in
// on_connect; they replace the per-event inline closures that previously
// inlined the guard chain.

/// `space:load-doc` — access-check then delegate.
pub(in crate::websocket) async fn dispatch_load_doc(
  state: Arc<ApiState>,
  socket: SocketRef,
  data: LoadDocPayload,
  ack: AckSender,
) {
  let Ok((user_id, ack)) = check_space_access_with_ack(
    &state,
    &socket,
    ack,
    data.space_type,
    &data.space_id,
    Some(&data.doc_id),
    DocumentAccess::ReadOrNotFound,
    "space:load-doc",
  )
  .await
  else {
    return;
  };
  handle_load_doc(data, user_id, socket.id.to_string(), state, ack).await
}

/// `space:push-doc-update` — access-check then delegate.
///
/// `UpdateOrCreate` is intentional: the first durable Yjs push creates the
/// document row, so requiring `DocAction::Update` unconditionally would reject
/// every native create before a document ACL can exist. The access resolver
/// keeps blocked and deleted rows on the existing-document path.
pub(in crate::websocket) async fn dispatch_push_update(
  state: Arc<ApiState>,
  socket: SocketRef,
  data: PushDocUpdatePayload,
  ack: AckSender,
) {
  let Ok((user_id, ack)) = check_space_access_with_ack(
    &state,
    &socket,
    ack,
    data.space_type,
    &data.space_id,
    Some(&data.doc_id),
    DocumentAccess::UpdateOrCreate,
    "space:push-doc-update",
  )
  .await
  else {
    return;
  };
  handle_push_update(socket, data, user_id, state, ack).await
}

/// `space:load-doc-timestamps` — access-check then delegate.
pub(in crate::websocket) async fn dispatch_load_doc_timestamps(
  state: Arc<ApiState>,
  socket: SocketRef,
  data: LoadDocTimestampsPayload,
  ack: AckSender,
) {
  let Ok((user_id, ack)) = check_space_access_with_ack(
    &state,
    &socket,
    ack,
    data.space_type,
    &data.space_id,
    None,
    DocumentAccess::Existing(myoxus_domain::permission::DocAction::Read),
    "space:load-doc-timestamps",
  )
  .await
  else {
    return;
  };
  handle_load_doc_timestamps(data, user_id, state, ack).await
}

/// `space:delete-doc` — access-check then delegate.
pub(in crate::websocket) async fn dispatch_delete_doc(state: Arc<ApiState>, socket: SocketRef, data: DeleteDocPayload) {
  let Ok(user_id) = check_space_access(
    &state,
    &socket,
    data.space_type,
    &data.space_id,
    Some(&data.doc_id),
    DocumentAccess::Existing(myoxus_domain::permission::DocAction::Delete),
    "space:delete-doc",
  )
  .await
  else {
    return;
  };
  handle_delete_doc(socket, data, user_id, state).await
}

#[cfg(test)]
mod sync_load_metric_tests {
  use super::*;
  use myoxus_application::metrics::{
    InMemoryMetricsRecorder, MetricsPolicy, MetricsRecorder, service::InMemoryMetricsRepo,
  };
  use std::io::Write;
  use std::sync::Mutex;

  #[derive(Clone, Default)]
  struct TestLogWriter(Arc<Mutex<Vec<u8>>>);

  impl Write for TestLogWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
      self.0.lock().expect("test log lock").extend_from_slice(buffer);
      Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
      Ok(())
    }
  }

  impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for TestLogWriter {
    type Writer = Self;

    fn make_writer(&'writer self) -> Self::Writer {
      self.clone()
    }
  }

  #[test]
  fn client_kind_is_a_closed_low_cardinality_dimension() {
    assert_eq!(doc_sync_client_kind(Some("web")), "web");
    assert_eq!(doc_sync_client_kind(Some("myoxus-electron")), "electron");
    assert_eq!(doc_sync_client_kind(Some("ios")), "mobile");
    assert_eq!(doc_sync_client_kind(Some("attacker-controlled-value")), "unknown");
    assert_eq!(doc_sync_client_kind(None), "unknown");
  }

  #[test]
  fn load_metrics_emit_only_catalogued_labels_and_never_ids() {
    let mut policy = MetricsPolicy {
      enabled: true,
      cardinality_limit_per_metric: 32,
      ..Default::default()
    };
    policy
      .categories
      .insert(MetricsCategory::Collab.as_str().to_string(), true);
    let recorder = Arc::new(InMemoryMetricsRecorder::new(policy));
    let metrics = MetricsService::new(recorder.clone(), Arc::new(InMemoryMetricsRepo));

    record_doc_sync_load_metrics(
      &metrics,
      DocSyncLoadMetricDimensions {
        client_kind: "web",
        space_type: "workspace",
        is_root: true,
      },
      DocSyncLoadOutcome::Success,
      DocSyncLoadMetricValues {
        input_bytes: 1024,
        output_bytes: 256,
        decoder_wait_ms: 4,
        materialize_ms: 8,
      },
    );

    let samples = recorder.inspect_series(chrono::Utc::now());
    assert_eq!(samples.len(), 5, "the catalogue defines five load series");
    for sample in samples {
      let labels = sample.labels.as_object().expect("labels are an object");
      assert!(!labels.contains_key("workspace_id"));
      assert!(!labels.contains_key("doc_id"));
      assert!(!labels.contains_key("socket_id"));
      assert!(!labels.contains_key("sync_operation_id"));
      match sample.metric_name.as_str() {
        "doc_sync_load_total" | "doc_sync_load_input_bytes_total" | "doc_sync_load_output_bytes_total" => {
          assert_eq!(labels.len(), 4);
          assert_eq!(labels.get("outcome").and_then(Value::as_str), Some("success"));
          assert_eq!(labels.get("client_kind").and_then(Value::as_str), Some("web"));
          assert_eq!(labels.get("space_type").and_then(Value::as_str), Some("workspace"));
          assert_eq!(labels.get("is_root").and_then(Value::as_str), Some("true"));
        }
        "doc_sync_load_decoder_wait_ms_total" | "doc_sync_load_materialize_ms_total" => {
          assert_eq!(labels.len(), 1);
          assert_eq!(labels.get("outcome").and_then(Value::as_str), Some("success"));
        }
        other => panic!("unexpected metric outside the catalogue: {other}"),
      }
    }
  }

  #[test]
  fn push_metrics_use_exactly_the_four_catalogued_outcomes() {
    let mut policy = MetricsPolicy {
      enabled: true,
      cardinality_limit_per_metric: 8,
      ..Default::default()
    };
    policy
      .categories
      .insert(MetricsCategory::Collab.as_str().to_string(), true);
    let recorder = Arc::new(InMemoryMetricsRecorder::new(policy));
    let metrics = MetricsService::new(recorder.clone(), Arc::new(InMemoryMetricsRepo));

    for outcome in ["persisted", "exact_replay", "crdt_noop", "rejected"] {
      record_doc_sync_push_outcome(&metrics, outcome);
    }

    let mut outcomes = recorder
      .inspect_series(chrono::Utc::now())
      .into_iter()
      .map(|sample| {
        assert_eq!(sample.metric_name, "doc_sync_push_total");
        let labels = sample.labels.as_object().expect("labels are an object");
        assert_eq!(labels.len(), 1);
        labels
          .get("outcome")
          .and_then(Value::as_str)
          .expect("outcome label")
          .to_string()
      })
      .collect::<Vec<_>>();
    outcomes.sort();
    assert_eq!(outcomes, ["crdt_noop", "exact_replay", "persisted", "rejected"]);
  }

  #[test]
  fn load_log_contract_correlates_terminal_outcome_without_sensitive_payloads() {
    let writer = TestLogWriter::default();
    let subscriber = tracing_subscriber::fmt()
      .with_ansi(false)
      .without_time()
      .with_max_level(tracing::Level::TRACE)
      .with_writer(writer.clone())
      .finish();
    let dispatch = tracing::Dispatch::new(subscriber);
    let operation_id = Uuid::new_v4();

    tracing::dispatcher::with_default(&dispatch, || {
      tracing::callsite::rebuild_interest_cache();
      log_doc_sync_load_started(
        operation_id,
        DocSyncLoadMetricDimensions {
          client_kind: "web",
          space_type: "workspace",
          is_root: false,
        },
        true,
      );
      log_doc_sync_load_rejected(operation_id, DocSyncLoadOutcome::InvalidStateVector, None);
    });

    let output = String::from_utf8(writer.0.lock().expect("test log lock").clone()).expect("UTF-8 log output");
    assert!(output.contains("doc_sync.load.started"));
    assert!(output.contains("doc_sync.load.rejected"));
    assert_eq!(output.matches("doc_sync.load.started").count(), 1);
    assert_eq!(output.matches("doc_sync.load.rejected").count(), 1);
    assert!(output.contains(&operation_id.to_string()));
    assert_eq!(output.matches(&operation_id.to_string()).count(), 2);
    assert!(output.contains("invalid_state_vector"));
    for forbidden_field in [
      "document_content=",
      "payload=",
      "state_vector_bytes=",
      "authorization=",
      "token=",
      "cookie=",
      "session_id=",
      "socket_id=",
    ] {
      assert!(
        !output.contains(forbidden_field),
        "sensitive field leaked into sync logs: {forbidden_field}"
      );
    }
  }

  #[test]
  fn push_log_contract_contains_correlation_outcome_and_no_payload() {
    let writer = TestLogWriter::default();
    let subscriber = tracing_subscriber::fmt()
      .with_ansi(false)
      .without_time()
      .with_max_level(tracing::Level::TRACE)
      .with_writer(writer.clone())
      .finish();
    let dispatch = tracing::Dispatch::new(subscriber);
    let operation_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();

    tracing::dispatcher::with_default(&dispatch, || {
      tracing::callsite::rebuild_interest_cache();
      log_doc_sync_push_completed(operation_id, Some(workspace_id), Some(doc_id), 23, "exact_replay");
    });

    let output = String::from_utf8(writer.0.lock().expect("test log lock").clone()).expect("UTF-8 log output");
    assert_eq!(output.matches("doc_sync.push.completed").count(), 1);
    assert!(output.contains("DEBUG"));
    assert!(!output.contains(" WARN "));
    assert!(!output.contains(" ERROR "));
    assert!(output.contains(&operation_id.to_string()));
    assert!(output.contains("exact_replay"));
    assert!(output.contains("input_bytes=23"));
    for forbidden in ["payload=", "state_vector=", "authorization=", "token=", "cookie="] {
      assert!(!output.contains(forbidden), "sensitive push field leaked: {forbidden}");
    }
  }
}
