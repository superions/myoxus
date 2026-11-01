//! WebSocket payload type definitions.
//!
//! Pure data types: request/response structs, fanout messages, handshake auth.
//! No logic, no runtime behavior. Extracted from `mod.rs` in P107-B.
//!
//! All field visibility is `pub(super)` so sibling submodules (`access`, `auth`,
//! `fanout`, `handlers`) can read/construct them, while external callers go
//! through re-exports in `mod.rs`.

use myoxus_application::doc::InitialDocumentProvenance;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub(super) struct ClientUpdateControlChangedPayload {}

#[cfg(test)]
mod client_update_control_tests {
  use super::*;

  #[test]
  fn client_update_wakeup_contains_no_policy_state() {
    assert_eq!(
      serde_json::to_value(ClientUpdateControlChangedPayload {}).expect("serialize wake-up"),
      serde_json::json!({})
    );
  }
}

// ---------------------------------------------------------------------------
// Space / doc payload types (client → server)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub(super) enum SpaceType {
  Workspace,
  Userspace,
}

impl std::fmt::Display for SpaceType {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      SpaceType::Workspace => write!(f, "workspace"),
      SpaceType::Userspace => write!(f, "userspace"),
    }
  }
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct SocketClientContextPayload {
  #[allow(dead_code)]
  pub(super) client: Option<String>,
  #[serde(rename = "clientFormat")]
  #[allow(dead_code)]
  pub(super) client_format: Option<String>,
  #[serde(rename = "clientCapabilities")]
  #[allow(dead_code)]
  pub(super) client_capabilities: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct JoinSpacePayload {
  #[serde(rename = "spaceType")]
  pub(super) space_type: SpaceType,
  #[serde(rename = "spaceId")]
  pub(super) space_id: String,
  #[serde(rename = "clientVersion")]
  pub(super) client_version: String,
  pub(super) client: Option<String>,
  #[serde(rename = "clientFormat")]
  pub(super) client_format: Option<String>,
  #[serde(rename = "clientCapabilities")]
  pub(super) client_capabilities: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct LeaveSpacePayload {
  #[serde(rename = "spaceType")]
  pub(super) space_type: SpaceType,
  #[serde(rename = "spaceId")]
  pub(super) space_id: String,
  #[serde(flatten)]
  #[allow(dead_code)]
  pub(super) client_context: SocketClientContextPayload,
}

#[derive(Debug, Deserialize)]
pub(super) struct JoinAwarenessPayload {
  #[serde(rename = "spaceType")]
  pub(super) space_type: SpaceType,
  #[serde(rename = "spaceId")]
  pub(super) space_id: String,
  #[serde(rename = "docId")]
  pub(super) doc_id: String,
  #[serde(rename = "clientVersion")]
  pub(super) client_version: String,
  pub(super) client: Option<String>,
  #[serde(rename = "clientFormat")]
  pub(super) client_format: Option<String>,
  #[serde(rename = "clientCapabilities")]
  pub(super) client_capabilities: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AwarenessPayload {
  #[serde(rename = "spaceType")]
  pub(super) space_type: SpaceType,
  #[serde(rename = "spaceId")]
  pub(super) space_id: String,
  #[serde(rename = "docId")]
  pub(super) doc_id: String,
  #[serde(flatten)]
  #[allow(dead_code)]
  pub(super) client_context: SocketClientContextPayload,
}

#[derive(Debug, Deserialize)]
pub(super) struct UpdateAwarenessPayload {
  #[serde(rename = "spaceType")]
  pub(super) space_type: SpaceType,
  #[serde(rename = "spaceId")]
  pub(super) space_id: String,
  #[serde(rename = "docId")]
  pub(super) doc_id: String,
  #[serde(rename = "awarenessUpdate")]
  pub(super) awareness_update: Option<String>,
  #[serde(flatten)]
  #[allow(dead_code)]
  pub(super) client_context: SocketClientContextPayload,
}

#[derive(Debug, Deserialize)]
pub(super) struct LoadDocPayload {
  #[serde(rename = "spaceType")]
  pub(super) space_type: SpaceType,
  #[serde(rename = "spaceId")]
  pub(super) space_id: String,
  #[serde(rename = "docId")]
  pub(super) doc_id: String,
  #[serde(rename = "stateVector")]
  pub(super) state_vector: Option<String>,
  #[serde(flatten)]
  #[allow(dead_code)]
  pub(super) client_context: SocketClientContextPayload,
}

#[derive(Debug, Deserialize)]
pub(super) struct LoadDocTimestampsPayload {
  #[serde(rename = "spaceType")]
  pub(super) space_type: SpaceType,
  #[serde(rename = "spaceId")]
  pub(super) space_id: String,
  pub(super) timestamp: Option<i64>,
  #[serde(flatten)]
  #[allow(dead_code)]
  pub(super) client_context: SocketClientContextPayload,
}

#[derive(Debug, Deserialize)]
pub(super) struct PushDocUpdatePayload {
  #[serde(rename = "spaceType")]
  pub(super) space_type: SpaceType,
  #[serde(rename = "spaceId")]
  pub(super) space_id: String,
  #[serde(rename = "docId")]
  pub(super) doc_id: String,
  pub(super) update: String,
  #[serde(rename = "initialDocumentProvenance")]
  pub(super) initial_document_provenance: Option<InitialDocumentProvenance>,
  #[serde(flatten)]
  #[allow(dead_code)]
  pub(super) client_context: SocketClientContextPayload,
}

#[derive(Debug, Deserialize)]
pub(super) struct DeleteDocPayload {
  #[serde(rename = "spaceType")]
  pub(super) space_type: SpaceType,
  #[serde(rename = "spaceId")]
  pub(super) space_id: String,
  #[serde(rename = "docId")]
  pub(super) doc_id: String,
  #[serde(flatten)]
  #[allow(dead_code)]
  pub(super) client_context: SocketClientContextPayload,
}

#[cfg(test)]
mod tests {
  use super::*;

  fn native_doc_payload(event_fields: &str) -> serde_json::Value {
    serde_json::from_str(&format!(
      r#"{{
        "spaceType": "workspace",
        "spaceId": "7f91e77d-18f3-4e88-b890-bf65dc26f005",
        "docId": "b23a47b1-9b9f-4e72-b08a-8028409af7de",
        {event_fields}
        "client": "storage",
        "clientFormat": "myoxus-native",
        "clientCapabilities": "document-metadata,sync"
      }}"#
    ))
    .expect("valid socket json")
  }

  #[test]
  fn doc_socket_payloads_preserve_native_client_context() {
    let load: LoadDocPayload =
      serde_json::from_value(native_doc_payload(r#""stateVector": "AQID","#)).expect("load-doc payload");
    assert_eq!(load.client_context.client.as_deref(), Some("storage"));
    assert_eq!(load.client_context.client_format.as_deref(), Some("myoxus-native"));
    assert_eq!(
      load.client_context.client_capabilities.as_deref(),
      Some("document-metadata,sync")
    );

    let push: PushDocUpdatePayload =
      serde_json::from_value(native_doc_payload(r#""update": "AQID","#)).expect("push-doc-update payload");
    assert_eq!(push.client_context.client_format.as_deref(), Some("myoxus-native"));
    assert!(push.initial_document_provenance.is_none());

    let delete: DeleteDocPayload = serde_json::from_value(native_doc_payload("")).expect("delete-doc payload");
    assert_eq!(
      delete.client_context.client_capabilities.as_deref(),
      Some("document-metadata,sync")
    );
  }
}

// ---------------------------------------------------------------------------
// Broadcast payloads (server → client)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub(super) struct BroadcastDocUpdateV25 {
  #[serde(rename = "spaceType")]
  pub(super) space_type: SpaceType,
  #[serde(rename = "spaceId")]
  pub(super) space_id: String,
  #[serde(rename = "docId")]
  pub(super) doc_id: String,
  pub(super) update: String,
  pub(super) timestamp: i64,
  pub(super) editor: String,
}

#[derive(Debug, Serialize)]
pub(super) struct BroadcastDocUpdatesV26 {
  #[serde(rename = "spaceType")]
  pub(super) space_type: SpaceType,
  #[serde(rename = "spaceId")]
  pub(super) space_id: String,
  #[serde(rename = "docId")]
  pub(super) doc_id: String,
  pub(super) updates: Vec<String>,
  pub(super) timestamp: i64,
  pub(super) editor: String,
  pub(super) compressed: bool,
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/// Auth data sent by the client in the socket.io handshake `auth` field.
/// Desktop/mobile clients send `{ token: sessionId, userId: uuid }`.
/// Web clients send `{}` (empty) and rely on HTTP cookies instead.
#[derive(Deserialize, Default, Debug)]
pub(super) struct HandshakeAuth {
  pub(super) token: Option<String>,
  /// Sent by Desktop/Mobile clients alongside `token`. Not used for auth
  /// (session lookup is by token only) but deserialized to match the NestJS
  /// handshake contract. May be used for multi-account switching in future.
  #[serde(alias = "userId")]
  #[allow(dead_code)]
  pub(super) user_id: Option<String>,
  /// Optional declared native client class. Cookie-authenticated connections
  /// are always derived as Browser Web by the server.
  #[serde(alias = "clientKind")]
  pub(super) client_kind: Option<String>,
  /// Legacy Browser Web field accepted for wire compatibility and ignored.
  #[serde(alias = "clientInstanceId")]
  #[allow(dead_code)]
  pub(super) client_instance_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Notification / Copilot envelopes (server → client)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(super) struct NotificationAckPayload {
  #[serde(rename = "eventId")]
  pub(super) event_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct TelemetryBatchPayload {
  pub(super) events: Option<Vec<myoxus_application::telemetry::TelemetryEvent>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct NotificationPushEnvelope {
  #[serde(rename = "eventId")]
  pub(super) event_id: String,
  #[serde(rename = "eventType")]
  pub(super) event_type: String,
  pub(super) payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub(super) struct CopilotUiEventEnvelope {
  #[serde(rename = "eventId")]
  pub(super) event_id: String,
  #[serde(rename = "eventType")]
  pub(super) event_type: String,
  #[serde(rename = "sessionId")]
  pub(super) session_id: String,
  pub(super) payload: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Fanout messages (internal tokio::broadcast channel)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(super) struct NotificationFanoutMessage {
  pub(super) user_id: Uuid,
  pub(super) event_id: String,
  pub(super) event_type: String,
  pub(super) payload: serde_json::Value,
}

#[derive(Debug, Clone)]
pub(super) struct CopilotUiFanoutMessage {
  pub(super) user_id: Uuid,
  pub(super) event_id: String,
  pub(super) session_id: String,
  pub(super) event_type: String,
  pub(super) payload: serde_json::Value,
}

/// Committed Database events and workspace Task hints share authenticated fanout.
/// `workspace_hint` selects the acknowledged workspace membership; ordinary
/// events retain their Database presence membership and existing wire payload.
#[derive(Debug, Clone)]
#[allow(dead_code)] // fields are read by handlers wired in P-DB-29B-C
pub(super) struct DatabaseChangeFanoutMessage {
  pub(super) workspace_hint: bool,
  pub(super) workspace_id: Uuid,
  pub(super) database_id: Uuid,
  pub(super) payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub(super) struct CalendarEventChangedEnvelope {
  #[serde(rename = "eventId")]
  pub(super) event_id: String,
  pub(super) op: String,
}
