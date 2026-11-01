//! Handler for `telemetry:batch` Socket.IO events.
//!
//! Unauthenticated, best-effort ingestion.  The client sends a batch of
//! [`TelemetryEvent`]s; the handler passes them through
//! [`TelemetryIngestService::ingest_batch`] and ACKs with an accept/drop
//! count.  Unlike the old ACK-only stub this path persists (via the flush
//! worker) — INV-TEL-01..INV-TEL-04 apply.

use serde_json::json;
use socketioxide::extract::SocketRef;

use std::sync::Arc;

use super::super::types::TelemetryBatchPayload;
use crate::state::ApiState;

/// Handle a `telemetry:batch` event.
pub(in crate::websocket) async fn handle_telemetry_batch(
  socket: SocketRef,
  data: TelemetryBatchPayload,
  state: Arc<ApiState>,
) {
  let events = data.events.unwrap_or_default();
  let policy = state.telemetry_policy();

  // INV-TEL-03: drop everything when globally disabled.
  if !policy.enabled {
    let ack = json!({
      "data": { "ok": false, "accepted": 0, "dropped": events.len() }
    });
    let _ = socket.emit("telemetry:batch", &ack);
    return;
  }

  let (accepted, dropped) = state.telemetry().ingest_batch(events, &policy).await;
  let ack = json!({
    "data": { "ok": true, "accepted": accepted, "dropped": dropped }
  });
  let _ = socket.emit("telemetry:batch", &ack);
}
