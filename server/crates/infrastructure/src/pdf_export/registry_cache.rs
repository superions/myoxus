// SPDX-License-Identifier: AGPL-3.0-or-later
//! In-process LRU cache + Redis Pub/Sub invalidation for the PDF template
//! registry (`P-PDF-TPL-06-02`).
//!
//! [`CachingPdfTemplateRegistry`] wraps any inner [`PdfTemplateRegistry`]
//! (typically [`super::PgPdfTemplateRegistry`]) with:
//!
//! 1. A bounded `moka::future::Cache<Uuid, Arc<LoadedTemplate>>` that holds
//!    fully-materialised templates so subsequent renders skip the DB +
//!    blob-store round-trip.
//! 2. A Redis Pub/Sub fan-out on channel
//!    [`PDF_TEMPLATE_INVALIDATE_CHANNEL`]. Mutations call
//!    [`CachingPdfTemplateRegistry::invalidate`], which both clears the local
//!    cache *and* publishes the template UUID so other instances see the same
//!    invalidation.
//!
//! The pattern mirrors the cross-instance config cache in
//! `crates/api/src/cache_bus.rs`: a single channel with a small JSON payload
//! and self-skip via instance_id.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use moka::future::Cache;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tracing::{debug, error, info, instrument, trace, warn};
use uuid::Uuid;

use myoxus_pdf_export::template_v2::{LoadedTemplate, PdfTemplateRegistry, RegistryError};

use crate::redis::RedisAdapter;

/// Pub/Sub channel name for cross-instance template invalidations.
pub const PDF_TEMPLATE_INVALIDATE_CHANNEL: &str = "myoxus:pdf_template:invalidate";

/// Default cache capacity (templates). Templates rarely exceed a few MB each,
/// so 64 leaves us well below 1 GiB even for unusually large bundles while
/// covering all assigned templates on a typical workspace.
const DEFAULT_CAPACITY: u64 = 64;

/// Default cache TTL. Beyond this the cache treats entries as stale; the
/// next request triggers a background reload via the inner registry.
const DEFAULT_TTL_SECS: u64 = 300;

/// Throttle interval for publish-failure warnings (mirrors `cache_bus.rs`).
const THROTTLE_INTERVAL_SECS: u64 = 60;

/// Maximum reconnect backoff for the subscriber.
const MAX_BACKOFF_SECS: u64 = 30;

/// JSON payload for cross-instance invalidation messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PdfTemplateInvalidationMessage {
  /// Template UUID being invalidated.
  template_id: Uuid,
  /// Originating instance id (used to skip self-delivery).
  source: String,
}

/// Caching wrapper around any [`PdfTemplateRegistry`].
///
/// Cloning is cheap — the cache is an `Arc` internally.
#[derive(Clone)]
pub struct CachingPdfTemplateRegistry {
  inner: Arc<dyn PdfTemplateRegistry>,
  cache: Cache<Uuid, Arc<LoadedTemplate>>,
  /// Optional Redis adapter for Pub/Sub fan-out. `None` disables cross-instance
  /// invalidation (single-instance deployments).
  redis: Option<Arc<RedisAdapter>>,
  /// This server's instance id, embedded in invalidation messages.
  instance_id: Uuid,
  /// Last publish-failure warning timestamp (epoch seconds), for throttling.
  last_warn_timestamp: Arc<AtomicU64>,
}

impl CachingPdfTemplateRegistry {
  /// Build a caching registry with default capacity and TTL.
  pub fn new(inner: Arc<dyn PdfTemplateRegistry>, redis: Option<Arc<RedisAdapter>>, instance_id: Uuid) -> Self {
    Self::with_capacity(inner, redis, instance_id, DEFAULT_CAPACITY, DEFAULT_TTL_SECS)
  }

  /// Build a caching registry with a custom capacity and TTL.
  pub fn with_capacity(
    inner: Arc<dyn PdfTemplateRegistry>,
    redis: Option<Arc<RedisAdapter>>,
    instance_id: Uuid,
    capacity: u64,
    ttl_secs: u64,
  ) -> Self {
    let cache = Cache::builder()
      .max_capacity(capacity)
      .time_to_live(Duration::from_secs(ttl_secs))
      .build();
    Self {
      inner,
      cache,
      redis,
      instance_id,
      last_warn_timestamp: Arc::new(AtomicU64::new(0)),
    }
  }

  /// Convenience accessor for tests and metrics.
  pub fn cache(&self) -> &Cache<Uuid, Arc<LoadedTemplate>> {
    &self.cache
  }

  /// Publish a `pdf_template_invalidated` event to Redis. Failures are logged
  /// (throttled to one warning per minute).
  async fn publish_invalidate(&self, template_id: Uuid) {
    let Some(redis) = self.redis.as_ref() else {
      trace!("no redis adapter configured; skipping cross-instance pdf template invalidation");
      return;
    };
    let message = PdfTemplateInvalidationMessage {
      template_id,
      source: self.instance_id.to_string(),
    };
    let serialized = match serde_json::to_string(&message) {
      Ok(s) => s,
      Err(e) => {
        error!(error = %e, "failed to serialise pdf template invalidation message");
        return;
      }
    };

    let result: Result<usize, String> = async {
      let mut conn = redis
        .command_connection()
        .await
        .map_err(|e| format!("redis connection: {e}"))?;
      conn
        .publish::<_, _, usize>(PDF_TEMPLATE_INVALIDATE_CHANNEL, &serialized)
        .await
        .map_err(|e| format!("redis PUBLISH: {e}"))
    }
    .await;

    match result {
      Ok(receivers) => {
        debug!(template_id = %template_id, receivers,
          "pdf template invalidation published");
      }
      Err(e) => {
        let now = std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .unwrap_or_default()
          .as_secs();
        let last = self.last_warn_timestamp.load(Ordering::Relaxed);
        if now.saturating_sub(last) >= THROTTLE_INTERVAL_SECS {
          self.last_warn_timestamp.store(now, Ordering::Relaxed);
          warn!(template_id = %template_id, error = %e,
            "failed to publish pdf template invalidation (throttled, max 1/min)");
        }
      }
    }
  }

  /// Spawn a background subscriber that listens for invalidations from other
  /// instances and clears the local cache on each one.
  ///
  /// Returns the join handle plus a oneshot that fires once the subscription
  /// is established (mirrors `cache_bus::start_subscriber`). Production
  /// callers can ignore the receiver.
  pub fn start_subscriber(
    cache: Cache<Uuid, Arc<LoadedTemplate>>,
    redis: Arc<RedisAdapter>,
    instance_id: Uuid,
  ) -> (JoinHandle<()>, oneshot::Receiver<()>) {
    let local_instance = instance_id.to_string();
    let (ready_tx, ready_rx) = oneshot::channel::<()>();
    let mut ready_tx = Some(ready_tx);

    let handle = tokio::spawn(async move {
      info!(channel = PDF_TEMPLATE_INVALIDATE_CHANNEL, instance_id = %instance_id,
        "starting pdf template invalidation subscriber");

      let mut backoff_secs: u64 = 1;
      loop {
        match redis.client().get_async_pubsub().await {
          Ok(mut pubsub) => {
            if let Err(e) = pubsub.subscribe(PDF_TEMPLATE_INVALIDATE_CHANNEL).await {
              error!(error = %e, backoff_secs,
                "failed to subscribe to pdf template invalidation channel — retrying");
              tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
              backoff_secs = (backoff_secs * 2).min(MAX_BACKOFF_SECS);
              continue;
            }

            info!(
              channel = PDF_TEMPLATE_INVALIDATE_CHANNEL,
              "subscribed to pdf template invalidation channel"
            );

            if let Some(tx) = ready_tx.take() {
              let _ = tx.send(());
            }
            backoff_secs = 1;

            loop {
              use futures_util::StreamExt;
              let msg = pubsub.on_message().next().await;
              match msg {
                Some(msg) => {
                  let payload: String = match msg.get_payload() {
                    Ok(p) => p,
                    Err(e) => {
                      warn!(error = %e, "invalid pdf template invalidation payload");
                      continue;
                    }
                  };
                  let message: PdfTemplateInvalidationMessage = match serde_json::from_str(&payload) {
                    Ok(m) => m,
                    Err(e) => {
                      warn!(error = %e, "malformed pdf template invalidation JSON");
                      continue;
                    }
                  };
                  if message.source == local_instance {
                    trace!("skipping self-originated pdf template invalidation");
                    continue;
                  }
                  info!(template_id = %message.template_id, source = %message.source,
                    "received cross-instance pdf template invalidation");
                  cache.invalidate(&message.template_id).await;
                }
                None => {
                  warn!("pdf template invalidation message stream ended — reconnecting with backoff");
                  break;
                }
              }
            }
          }
          Err(e) => {
            error!(error = %e, backoff_secs,
              "redis pubsub connection failed for pdf template invalidations — retrying");
          }
        }

        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(MAX_BACKOFF_SECS);

        // Conservative: clear the entire cache on reconnect so we never serve
        // stale templates after a window of missed invalidations.
        info!("invalidating ALL pdf templates after reconnect (conservative)");
        cache.invalidate_all();
      }
    });
    (handle, ready_rx)
  }
}

#[async_trait]
impl PdfTemplateRegistry for CachingPdfTemplateRegistry {
  #[instrument(skip(self), fields(template_id = %template_id), err)]
  async fn load(&self, template_id: Uuid) -> Result<LoadedTemplate, RegistryError> {
    if let Some(cached) = self.cache.get(&template_id).await {
      trace!(template_id = %template_id, "pdf template cache hit");
      return Ok((*cached).clone());
    }
    let loaded = self.inner.load(template_id).await?;
    let arc = Arc::new(loaded.clone());
    self.cache.insert(template_id, arc).await;
    debug!(template_id = %template_id, slug = %loaded.slug,
      "pdf template loaded into cache");
    Ok(loaded)
  }

  #[instrument(skip(self), fields(slug = %slug), err)]
  async fn load_by_slug(&self, slug: &str) -> Result<LoadedTemplate, RegistryError> {
    // Slug-keyed lookup defers to the inner registry, then warms the
    // by-id cache so subsequent UUID-form requests hit the cache. We
    // do not maintain a separate slug→id index because slug renames
    // would invalidate it; the inner registry already enforces the
    // active-slug uniqueness via the partial unique index.
    let loaded = self.inner.load_by_slug(slug).await?;
    let template_id = loaded.id;
    let arc = Arc::new(loaded.clone());
    self.cache.insert(template_id, arc).await;
    debug!(slug, template_id = %template_id, "pdf template loaded by slug + cache warmed");
    Ok(loaded)
  }

  #[instrument(skip(self), fields(template_id = %template_id), err)]
  async fn invalidate(&self, template_id: Uuid) -> Result<(), RegistryError> {
    self.cache.invalidate(&template_id).await;
    self.inner.invalidate(template_id).await?;
    self.publish_invalidate(template_id).await;
    Ok(())
  }
}
