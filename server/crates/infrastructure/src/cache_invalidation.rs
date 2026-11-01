// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared publication contract for process-local API cache invalidations.

use crate::redis::RedisAdapter;
use myoxus_application::organization::OrganizationMembershipEffects;
use myoxus_application::ports::RedisPort;
use myoxus_domain::ids::UserId;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

pub const CHANNEL: &str = "myoxus:cache:invalidate";
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvalidationMessage {
  pub cache: String,
  pub key: String,
  /// Process identity; API subscribers skip only their own publications.
  pub source: String,
}

pub async fn publish(adapter: &RedisAdapter, source: Uuid, cache: &str, key: &str) -> Result<usize, String> {
  let payload = serde_json::to_string(&InvalidationMessage {
    cache: cache.into(),
    key: key.into(),
    source: source.to_string(),
  })
  .map_err(|error| format!("cache invalidation serialization: {error}"))?;
  let mut conn = adapter
    .command_connection()
    .await
    .map_err(|error| format!("redis connection: {error}"))?;
  conn
    .publish::<_, _, usize>(CHANNEL, payload)
    .await
    .map_err(|error| format!("redis PUBLISH: {error}"))
}

/// CLI cache effects use the configured cache role and the API's existing L2
/// namespace and publication contract. No API-local cache exists in the CLI.
pub struct RedisMembershipEffects {
  adapter: Option<Arc<RedisAdapter>>,
  source: Uuid,
}
impl RedisMembershipEffects {
  pub fn new(adapter: Option<Arc<RedisAdapter>>) -> Self {
    Self {
      adapter,
      source: Uuid::new_v4(),
    }
  }
}
#[async_trait::async_trait]
impl OrganizationMembershipEffects for RedisMembershipEffects {
  async fn invalidate_features(&self, user: UserId) {
    if let Some(adapter) = &self.adapter {
      if let Err(error) = adapter.delete_key(&format!("cache:features:{user}")).await {
        tracing::warn!(%user, %error, "committed membership feature cache deletion failed");
      }
      if let Err(error) = publish(adapter, self.source, "user_features", &user.to_string()).await {
        tracing::warn!(%user, %error, "committed membership feature cache publication failed");
      }
    }
  }
}

/// Session revocations use the existing cache-bus envelope. Publication is
/// awaited so short-lived CLI processes cannot drop an unpolled side effect.
pub struct RedisSessionRevocationEffects {
  adapter: Option<Arc<RedisAdapter>>,
  source: Uuid,
}

impl RedisSessionRevocationEffects {
  pub fn new(adapter: Option<Arc<RedisAdapter>>, source: Uuid) -> Self {
    Self { adapter, source }
  }

  async fn publish_revocation(&self, kind: &str, id: Uuid) {
    if let Some(adapter) = &self.adapter {
      if publish(adapter, self.source, kind, &id.to_string()).await.is_err() {
        tracing::error!(kind, "session revocation committed; live-load publication failed");
      }
    }
  }
}

#[async_trait::async_trait]
impl myoxus_application::auth::SessionRevocationEffects for RedisSessionRevocationEffects {
  async fn session_revoked(&self, session_id: Uuid) {
    self.publish_revocation("auth_session_revoked", session_id).await;
  }
  async fn user_sessions_revoked(&self, user_id: Uuid) {
    self.publish_revocation("auth_user_sessions_revoked", user_id).await;
  }
}
