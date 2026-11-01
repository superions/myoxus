//! Redis Pub/Sub cache invalidation bus for cross-instance cache sync (P84-I).
//!
//! In multi-instance deployments, when Server A invalidates its local moka cache
//! after `adminUpdateConfig`, Server B doesn't know.  This module adds a Redis
//! Pub/Sub channel (`myoxus:cache:invalidate`) that broadcasts invalidation
//! events so all instances stay consistent.
//!
//! ## Architecture
//!
//! - **Publisher**: Each mutation site calls [`CacheInvalidationBus::publish`] after
//!   invalidating the local cache.  The message includes the originating `instance_id`
//!   so the subscriber can skip self-originated events.
//! - **Subscriber**: A background tokio task ([`CacheInvalidationBus::start_subscriber`])
//!   subscribes to the channel and invalidates the local [`QueryCache`] when a
//!   message arrives from *another* instance.
//!
//! ## Graceful degradation
//!
//! - If Redis is unavailable at startup, no subscriber is created (warning logged).
//! - If the connection drops at runtime, the subscriber reconnects with exponential
//!   backoff (1s → 2s → 4s → … → 30s max) and invalidates ALL caches on reconnect
//!   (conservative safety net).
//! - Publish failures are logged as warnings, throttled to max 1 per minute.
//!
//! ## Why doc caches (P102-CACHE-01..05) do NOT use the CacheBus
//!
//! Redis keys are **globally shared** across all server instances. When instance A
//! writes or invalidates a doc snapshot/metadata/timestamps key, the change is
//! immediately visible to instance B on its next Redis lookup — no Pub/Sub
//! notification needed. The `CacheBus` also cancels process-local pending
//! document loads after committed session/user revocation. It coordinates
//! resources whose state is local to each process. Redis-backed doc caches are
//! inherently cross-instance without any additional coordination layer.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use myoxus_infrastructure::redis::RedisAdapter;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, trace, warn};
use uuid::Uuid;

use crate::cache::QueryCache;

use myoxus_infrastructure::cache_invalidation::{CHANNEL, InvalidationMessage};

/// Minimum interval between publish-failure warnings (60 seconds).
const THROTTLE_INTERVAL_SECS: u64 = 60;

/// Maximum reconnect backoff delay.
const MAX_BACKOFF_SECS: u64 = 30;

/// Cross-instance cache invalidation bus backed by Redis Pub/Sub.
pub struct CacheInvalidationBus {
  /// Unique identifier for this server instance.
  instance_id: Uuid,
  /// Redis adapter for the cache role.
  adapter: Arc<RedisAdapter>,
  /// Timestamp (epoch seconds) of the last publish-failure warning.
  /// Used to throttle warning logs to max 1 per minute.
  last_warn_timestamp: AtomicU64,
}

impl CacheInvalidationBus {
  /// Create a new bus instance.
  pub fn new(instance_id: Uuid, adapter: Arc<RedisAdapter>) -> Self {
    info!(
        %instance_id,
        channel = CHANNEL,
        "P84-I: CacheInvalidationBus created"
    );
    Self {
      instance_id,
      adapter,
      last_warn_timestamp: AtomicU64::new(0),
    }
  }

  /// Verify that the shared cache transport is reachable.
  ///
  /// Operation-admission paths use this fail-closed probe. Ordinary cache
  /// callers retain the existing graceful-degradation behavior in
  /// [`Self::publish`].
  pub async fn probe(&self) -> Result<(), String> {
    self.adapter.ping().await.map_err(|error| error.to_string())
  }

  /// Publish an invalidation and return transport failures to a caller that
  /// owns durable retry state.
  pub async fn try_publish(&self, cache_name: &str, key: &str) -> Result<usize, String> {
    myoxus_infrastructure::cache_invalidation::publish(&self.adapter, self.instance_id, cache_name, key).await
  }

  /// Publish an invalidation message to the Redis Pub/Sub channel.
  ///
  /// Called after local cache invalidation in mutation handlers.
  /// Failures are logged as warnings, throttled to max 1 per minute.
  pub async fn publish(&self, cache_name: &str, key: &str) {
    match self.try_publish(cache_name, key).await {
      Ok(receivers) => {
        debug!(
          cache = cache_name,
          key = key,
          receivers,
          "P84-I: cache invalidation published"
        );
      }
      Err(error) => {
        // Throttle warnings to max 1 per minute.
        let now = std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .unwrap_or_default()
          .as_secs();
        let last = self.last_warn_timestamp.load(Ordering::Relaxed);
        if now.saturating_sub(last) >= THROTTLE_INTERVAL_SECS {
          self.last_warn_timestamp.store(now, Ordering::Relaxed);
          warn!(
              cache = cache_name,
              key = key,
              %error,
              "P84-I: failed to publish cache invalidation (throttled warning, max 1/min)"
          );
        }
      }
    }
  }

  /// Spawn a background subscriber task that listens for invalidation messages
  /// from other instances and invalidates the local [`QueryCache`].
  ///
  /// Returns:
  /// - The `JoinHandle` for the spawned background task.
  /// - A `oneshot::Receiver<()>` that fires exactly once when the subscriber
  ///   has successfully subscribed to the Redis channel.  Callers that need to
  ///   publish *after* the subscription is established (e.g. tests) can `await`
  ///   this receiver.  Production callers may ignore it with `let (handle, _) =`.
  ///
  /// If Redis is unavailable at startup the subscriber task retries with backoff
  /// and the ready-receiver will fire only after the first successful subscribe.
  pub fn start_subscriber(
    cache: QueryCache,
    adapter: Arc<RedisAdapter>,
    instance_id: Uuid,
    config_refresh: Option<mpsc::UnboundedSender<()>>,
  ) -> (JoinHandle<()>, oneshot::Receiver<()>) {
    let local_instance = instance_id.to_string();
    let (ready_tx, ready_rx) = oneshot::channel::<()>();
    // Wrap in Option so we can send exactly once and then drop.
    let mut ready_tx = Some(ready_tx);

    let handle = tokio::spawn(async move {
      info!(
          channel = CHANNEL,
          instance_id = %instance_id,
          "P84-I: starting cache invalidation subscriber"
      );

      let mut backoff_secs: u64 = 1;

      loop {
        match adapter.client().get_async_pubsub().await {
          Ok(mut pubsub) => {
            if let Err(e) = pubsub.subscribe(CHANNEL).await {
              error!(
                  error = %e,
                  backoff_secs,
                  "P84-I: failed to subscribe to invalidation channel — retrying"
              );
              tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
              backoff_secs = (backoff_secs * 2).min(MAX_BACKOFF_SECS);
              continue;
            }

            info!(channel = CHANNEL, "P84-I: subscribed to cache invalidation channel");

            // Signal readiness on the first successful subscription.
            if let Some(tx) = ready_tx.take() {
              let _ = tx.send(());
            }
            // Reset backoff on successful subscription.
            backoff_secs = 1;

            loop {
              use futures_util::StreamExt;
              let msg = pubsub.on_message().next().await;
              match msg {
                Some(msg) => {
                  let payload: String = match msg.get_payload() {
                    Ok(p) => p,
                    Err(e) => {
                      warn!(
                          error = %e,
                          "P84-I: invalid message payload"
                      );
                      continue;
                    }
                  };
                  let message: InvalidationMessage = match serde_json::from_str(&payload) {
                    Ok(m) => m,
                    Err(e) => {
                      warn!(
                          error = %e,
                          "P84-I: malformed invalidation JSON"
                      );
                      continue;
                    }
                  };

                  // Skip self-originated messages.
                  if message.source == local_instance {
                    trace!("P84-I: skipping self-originated invalidation");
                    continue;
                  }

                  if message.cache == "auth_session_revoked" {
                    // Session UUIDs also identify browser credentials. The bus
                    // needs the target for cancellation; logs need only the kind.
                    info!(cache = %message.cache, source = %message.source, "received session revocation");
                  } else {
                    info!(
                        cache = %message.cache,
                        key = %message.key,
                        source = %message.source,
                        "P84-I: received cross-instance cache invalidation"
                    );
                  }

                  if message.cache == "app_config" {
                    if let Some(refresh) = &config_refresh {
                      let _ = refresh.send(());
                    }
                  } else {
                    apply_invalidation(&cache, &message.cache, &message.key, Some(adapter.as_ref())).await;
                  }
                }
                None => {
                  warn!("P84-I: message stream ended — reconnecting with backoff");
                  break; // Break inner loop to reconnect.
                }
              }
            }
          }
          Err(e) => {
            error!(
                error = %e,
                backoff_secs,
                "P84-I: Redis pubsub connection failed — retrying"
            );
          }
        }

        // Reconnect with exponential backoff.
        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(MAX_BACKOFF_SECS);

        // Conservative: invalidate ALL caches on reconnect to ensure
        // we don't miss any invalidation that occurred while disconnected.
        info!("P84-I: invalidating ALL caches after reconnect (conservative)");
        cache.server_config.invalidate_all();
        cache.throttle_config.invalidate_all();
        invalidate_all_user_features(&cache).await;
        invalidate_all_ws_settings(&cache).await;
        if let Some(refresh) = &config_refresh {
          let _ = refresh.send(());
        }
      }
    });

    (handle, ready_rx)
  }
}

async fn invalidate_all_user_features(cache: &QueryCache) {
  let guard = cache.user_features_global_fill_guard();
  let _guard = guard.write().await;
  cache.invalidate_all_user_features();
}

async fn invalidate_all_ws_settings(cache: &QueryCache) {
  let guard = cache.ws_settings_global_fill_guard();
  let _guard = guard.write().await;
  cache.invalidate_all_ws_settings();
}

/// Apply an invalidation to the local cache based on the message contents.
///
/// P84-J-01: Records the invalidation on the appropriate `CacheMetrics`
/// counter (`invalidations_remote`) so TTL-tuning cycles can observe
/// cross-instance invalidation frequency.
pub(crate) async fn apply_invalidation(
  cache: &QueryCache,
  cache_name: &str,
  key: &str,
  redis: Option<&dyn myoxus_application::ports::RedisPort>,
) {
  match cache_name {
    "auth_session_revoked" | "auth_user_sessions_revoked" => {
      if let Ok(id) = Uuid::parse_str(key) {
        use myoxus_application::auth::SessionRevocationObserver;
        let observer = crate::websocket::WebsocketSessionRevocationObserver;
        if cache_name == "auth_session_revoked" {
          observer.session_revoked(id);
        } else {
          observer.user_sessions_revoked(id, &[]);
        }
      } else {
        warn!(cache_name, "invalid session revocation identity ignored");
      }
    }
    "server_config" => {
      if key == "all" {
        cache.server_config.invalidate_all();
      } else {
        cache.server_config.invalidate(&key.to_string()).await;
      }
      cache.metrics_server_config.record_invalidation_remote();
    }
    "throttle_config" => {
      if key == "all" {
        cache.throttle_config.invalidate_all();
      } else {
        cache.throttle_config.invalidate(&key.to_string()).await;
      }
      cache.metrics_throttle_config.record_invalidation_remote();
    }
    "user_features" => {
      if key == "all" {
        invalidate_all_user_features(cache).await;
      } else if let Ok(uid) = Uuid::parse_str(key) {
        let guard = cache.user_features_fill_guard(uid);
        let _guard = guard.lock().await;
        // A remote CLI writer cannot take this process's fill guard. Delete
        // L2 under it too, so a fill racing the original remote DEL cannot
        // repopulate this instance from its stale result after publication.
        if let Some(redis) = redis {
          if let Err(error) = redis.delete_key(&format!("cache:features:{uid}")).await {
            warn!(%uid, %error, "remote user feature L2 invalidation failed");
          }
        }
        cache.invalidate_user_features(uid).await;
      } else {
        warn!(
          cache_name = cache_name,
          key = key,
          "P84-I: invalid user_features key (not a UUID) — invalidating all"
        );
        invalidate_all_user_features(cache).await;
      }
      cache.metrics_user_features.record_invalidation_remote();
    }
    // XWS content publication can change effective workspace membership and
    // settings projections. Document/organizer caches are Redis-backed and
    // are invalidated through their shared cache port, so they do not need a
    // second process-local Pub/Sub model here.
    "workspace_content" => {
      if let Ok(ws_id) = Uuid::parse_str(key) {
        let guard = cache.ws_settings_fill_guard(ws_id);
        let _guard = guard.lock().await;
        cache.invalidate_ws_settings(ws_id).await;
      } else {
        warn!(
          cache_name = cache_name,
          key = key,
          "P84-I: invalid workspace_content key — invalidating workspace projections"
        );
        invalidate_all_ws_settings(cache).await;
      }
      cache.metrics_ws_settings.record_invalidation_remote();
    }
    // P84-I-II: Workspace settings cache (three-tier L1 moka).
    "ws_settings" => {
      if key == "all" {
        invalidate_all_ws_settings(cache).await;
      } else if let Ok(ws_id) = Uuid::parse_str(key) {
        let guard = cache.ws_settings_fill_guard(ws_id);
        let _guard = guard.lock().await;
        cache.invalidate_ws_settings(ws_id).await;
      } else {
        warn!(
          cache_name = cache_name,
          key = key,
          "P84-I: invalid ws_settings key (not a UUID) — invalidating all"
        );
        invalidate_all_ws_settings(cache).await;
      }
      cache.metrics_ws_settings.record_invalidation_remote();
    }
    "oidc_discovery" => {
      if key == "all" {
        cache.oidc_discovery.invalidate_all();
      } else {
        cache.oidc_discovery.invalidate(&key.to_string()).await;
      }
    }
    "oidc_jwks" => {
      if key == "all" {
        cache.oidc_jwks.invalidate_all();
      } else {
        cache.oidc_jwks.invalidate(&key.to_string()).await;
      }
    }
    unknown => {
      warn!(
        cache_name = unknown,
        key = key,
        "P84-I: unknown cache name — invalidating all config caches as safety net"
      );
      cache.server_config.invalidate_all();
      cache.throttle_config.invalidate_all();
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::cache::{CacheConfig, WorkspaceSettingsCached};

  #[tokio::test]
  async fn remote_feature_signal_removes_l2_value_written_by_a_racing_fill() {
    use myoxus_application::ports::RedisPort;
    let cache = QueryCache::new(&CacheConfig::default());
    let redis = myoxus_infrastructure::redis::InMemoryRedisAdapter::new("cache");
    let user = Uuid::new_v4();
    let key = format!("cache:features:{user}");
    // Model a fill that completed after the CLI's original L2 DEL and before
    // the subscriber acquired the local fill guard for the notification.
    redis
      .set_string(&key, "[\"manager\"]", Some(300))
      .await
      .expect("seed late L2 fill");
    cache
      .user_features
      .insert(cache.user_features_key(user), vec!["manager".into()])
      .await;
    apply_invalidation(&cache, "user_features", &user.to_string(), Some(&redis)).await;
    assert_eq!(redis.get_string(&key).await.expect("read invalidated L2"), None);
    assert_eq!(cache.user_features.get(&cache.user_features_key(user)).await, None);
  }

  #[tokio::test]
  async fn workspace_content_signal_invalidates_local_workspace_projections() {
    let cache = QueryCache::new(&CacheConfig::default());
    let workspace_id = Uuid::new_v4();
    cache
      .ws_settings
      .insert(
        cache.ws_settings_key(workspace_id),
        WorkspaceSettingsCached {
          enable_ai: true,
          enable_sharing: true,
          enable_url_preview: true,
          enable_doc_embedding: true,
        },
      )
      .await;

    apply_invalidation(&cache, "workspace_content", &workspace_id.to_string(), None).await;

    assert!(
      cache
        .ws_settings
        .get(&cache.ws_settings_key(workspace_id))
        .await
        .is_none()
    );
  }
}
