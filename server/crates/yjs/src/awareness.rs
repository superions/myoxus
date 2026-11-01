//! In-memory awareness state for real-time collaboration.
//!
//! [`Awareness`] is a `tokio::sync::RwLock`-guarded map from client ID strings
//! to [`AwarenessState`] values, which carry optional cursor positions, user
//! identity, and arbitrary extra JSON. It is used by the WebSocket layer to
//! broadcast live presence updates to other connected clients in the same space.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AwarenessState {
  pub cursor: Option<CursorPosition>,
  pub user: Option<UserInfo>,
  // arbitrary JSON data
  #[serde(flatten)]
  pub extra: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorPosition {
  pub x: f64,
  pub y: f64,
  pub doc_pos: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
  pub name: String,
  pub color: String,
}

#[derive(Clone)]
pub struct Awareness {
  inner: Arc<RwLock<HashMap<String, AwarenessState>>>,
}

impl Awareness {
  pub fn new() -> Self {
    Self {
      inner: Arc::new(RwLock::new(HashMap::new())),
    }
  }

  pub async fn set(&self, client_id: &str, state: AwarenessState) {
    let mut map = self.inner.write().await;
    map.insert(client_id.to_string(), state);
  }

  pub async fn remove(&self, client_id: &str) {
    let mut map = self.inner.write().await;
    map.remove(client_id);
  }

  pub async fn get_all(&self) -> HashMap<String, AwarenessState> {
    self.inner.read().await.clone()
  }

  pub async fn encode_updates(&self) -> Vec<u8> {
    // For simplicity, we encode as JSON; Yjs awareness uses its own binary format.
    // We'll need to implement Yjs awareness protocol later.
    let map = self.inner.read().await;
    serde_json::to_vec(&*map).unwrap_or_default()
  }

  pub async fn apply_updates(&self, updates: &[u8]) -> Result<(), serde_json::Error> {
    let new_map: HashMap<String, AwarenessState> = serde_json::from_slice(updates)?;
    let mut map = self.inner.write().await;
    for (client_id, state) in new_map {
      map.insert(client_id, state);
    }
    Ok(())
  }
}

impl Default for Awareness {
  fn default() -> Self {
    Self::new()
  }
}

pub type SharedAwareness = Arc<Awareness>;
