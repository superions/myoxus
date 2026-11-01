//! JSON adapter types for the Yjs wire protocol.
//!
//! Defines [`YjsUpdateMessage`], a serialisable envelope that carries binary
//! Yjs data (base64-encoded) over JSON-based transports such as WebSockets or
//! SSE. Supports `update`, `state`, and `diff` message types.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct YjsUpdateMessage {
  #[serde(rename = "type")]
  pub msg_type: String,
  pub data: String, // base64 encoded Yjs update
}

impl YjsUpdateMessage {
  pub fn new_update(update: &[u8]) -> Self {
    Self {
      msg_type: "update".to_string(),
      data: STANDARD.encode(update),
    }
  }

  pub fn new_state(state: &[u8]) -> Self {
    Self {
      msg_type: "state".to_string(),
      data: STANDARD.encode(state),
    }
  }

  pub fn new_diff(diff: &[u8]) -> Self {
    Self {
      msg_type: "diff".to_string(),
      data: STANDARD.encode(diff),
    }
  }

  pub fn to_json(&self) -> String {
    serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
  }

  pub fn from_json(json: &str) -> Option<Self> {
    serde_json::from_str(json).ok()
  }

  pub fn decode_data(&self) -> Option<Vec<u8>> {
    STANDARD.decode(&self.data).ok()
  }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct YjsAwarenessMessage {
  #[serde(rename = "type")]
  pub msg_type: String,
  pub data: serde_json::Value,
}

impl YjsAwarenessMessage {
  pub fn new(data: serde_json::Value) -> Self {
    Self {
      msg_type: "awareness".to_string(),
      data,
    }
  }

  pub fn to_json(&self) -> String {
    serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
  }

  pub fn from_json(json: &str) -> Option<Self> {
    serde_json::from_str(json).ok()
  }
}
