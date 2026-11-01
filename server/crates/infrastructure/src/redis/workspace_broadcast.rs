// SPDX-License-Identifier: AGPL-3.0-or-later
//! Existing socket-role workspace broadcast wire, shared by API and local CLI.

use super::RedisAdapter;
use async_trait::async_trait;
use myoxus_application::{
  auth::{AuthError, AuthResult},
  template_registry::TemplateBuilderNotificationPort,
};
use myoxus_domain::ids::WorkspaceId;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Message published to a workspace broadcast channel via Redis Pub/Sub.
/// Serialized as JSON for cross-instance transport.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrossInstanceBroadcast {
  /// The instance that originated the broadcast (used to skip local re-delivery).
  pub origin_instance: String,
  /// Socket.IO event name (e.g. "space:broadcast-doc-update").
  pub event: String,
  /// The workspace being broadcast to.
  pub workspace_id: String,
  /// JSON-encoded event payload.
  pub payload: serde_json::Value,
  /// Sender's socket ID (excluded from re-broadcast on the originating instance).
  pub sender_socket_id: String,
}

pub fn broadcast_channel(namespace: &str, workspace_id: &str) -> String {
  format!("{namespace}:ws:broadcast:{workspace_id}")
}

/// One publish attempt; recipient counts do not prove Socket.IO delivery.
pub async fn publish_workspace_broadcast(
  adapter: &RedisAdapter,
  message: &CrossInstanceBroadcast,
) -> Result<usize, String> {
  let serialized = serde_json::to_string(message).map_err(|error| error.to_string())?;
  let mut connection = adapter.command_connection().await.map_err(|error| error.to_string())?;
  connection
    .publish(
      broadcast_channel(adapter.namespace(), &message.workspace_id),
      serialized,
    )
    .await
    .map_err(|error| format!("redis PUBLISH: {error}"))
}

pub struct RedisTemplateBuilderNotifications(pub Arc<RedisAdapter>);

#[async_trait]
impl TemplateBuilderNotificationPort for RedisTemplateBuilderNotifications {
  async fn notify(&self, workspace_id: WorkspaceId, slug: &str, builder_version: u32) -> AuthResult<()> {
    let message = CrossInstanceBroadcast {
      // No local socket emit precedes this publish. Every API subscriber,
      // including the caller's instance, must forward the committed hint.
      origin_instance: "server:template-registry".to_string(),
      event: "template:reconcile-needed".to_string(),
      workspace_id: workspace_id.to_string(),
      payload: serde_json::json!({"workspaceId":workspace_id.to_string(), "slug":slug, "builderVersion":builder_version}),
      sender_socket_id: String::new(),
    };
    publish_workspace_broadcast(&self.0, &message)
      .await
      .map_err(AuthError::Storage)?;
    Ok(())
  }
}
