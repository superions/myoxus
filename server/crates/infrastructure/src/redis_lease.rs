// SPDX-License-Identifier: AGPL-3.0-or-later
//! Small owner-valued Redis lease shared by cluster-coordinated services.
//!
//! This module owns only the technical SET-NX, heartbeat and guarded-release
//! mechanics. Domain keys, retry policy and Redis role selection remain with
//! the caller.

use std::sync::{
  Arc,
  atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use myoxus_application::ports::{PortError, PortResult, RedisPort};
use tracing::{trace, warn};
use uuid::Uuid;

fn port_error_kind(error: &PortError) -> &'static str {
  match error {
    PortError::InvalidInput(_) => "invalid_input",
    PortError::NotFound(_) => "not_found",
    PortError::Conflict(_) => "conflict",
    PortError::Transport(_) => "transport",
  }
}

/// An acquired Redis lease whose ownership can be observed by a long-running
/// operation before it performs another persistent side effect.
pub struct RedisLease {
  redis: Arc<dyn RedisPort>,
  key: String,
  owner: String,
  owned: Arc<AtomicBool>,
  heartbeat_abort: Option<tokio::task::AbortHandle>,
}

impl RedisLease {
  /// Atomically acquire `key` and start a value-checked TTL heartbeat.
  ///
  /// `Ok(None)` means another owner currently holds the lease. Redis transport
  /// failures remain errors so callers cannot silently fall back to local
  /// coordination.
  pub async fn acquire(redis: Arc<dyn RedisPort>, key: String, ttl_seconds: u64) -> PortResult<Option<Self>> {
    let ttl_seconds = ttl_seconds.max(1);
    let owner = Uuid::new_v4().to_string();
    if !redis.setnx_string(&key, &owner, Some(ttl_seconds)).await? {
      return Ok(None);
    }

    let owned = Arc::new(AtomicBool::new(true));
    let heartbeat_abort = spawn_heartbeat(
      Arc::clone(&redis),
      key.clone(),
      owner.clone(),
      ttl_seconds,
      Arc::clone(&owned),
    );

    trace!(lease_key = %key, "Redis lease acquired");
    Ok(Some(Self {
      redis,
      key,
      owner,
      owned,
      heartbeat_abort: Some(heartbeat_abort),
    }))
  }

  /// Return whether the most recent heartbeat still confirmed ownership.
  pub fn is_owned(&self) -> bool {
    self.owned.load(Ordering::Acquire)
  }

  /// Fail closed once the heartbeat has lost or cannot verify ownership.
  pub fn ensure_owned(&self) -> PortResult<()> {
    if self.is_owned() {
      Ok(())
    } else {
      Err(PortError::Conflict("distributed lease ownership lost".to_string()))
    }
  }
}

impl Drop for RedisLease {
  fn drop(&mut self) {
    self.owned.store(false, Ordering::Release);
    if let Some(abort) = self.heartbeat_abort.take() {
      abort.abort();
    }

    let redis = Arc::clone(&self.redis);
    let key = self.key.clone();
    let owner = std::mem::take(&mut self.owner);
    tokio::spawn(async move {
      match redis.compare_and_delete(&key, &owner).await {
        Ok(true) => trace!(lease_key = %key, "Redis lease released"),
        Ok(false) => warn!(
          lease_key = %key,
          "Redis lease release found a missing or foreign owner; leaving the key untouched"
        ),
        Err(error) => warn!(
          lease_key = %key,
          error_kind = port_error_kind(&error),
          "Redis lease release failed; the key will expire by TTL"
        ),
      }
    });
  }
}

fn spawn_heartbeat(
  redis: Arc<dyn RedisPort>,
  key: String,
  owner: String,
  ttl_seconds: u64,
  owned: Arc<AtomicBool>,
) -> tokio::task::AbortHandle {
  let interval_seconds = (ttl_seconds / 3).max(1);
  let handle = tokio::spawn(async move {
    let mut ticker = tokio::time::interval(Duration::from_secs(interval_seconds));
    ticker.tick().await;
    loop {
      ticker.tick().await;
      match redis.compare_and_refresh(&key, &owner, ttl_seconds).await {
        Ok(true) => {
          owned.store(true, Ordering::Release);
          trace!(lease_key = %key, "Redis lease heartbeat refreshed");
        }
        Ok(false) => {
          owned.store(false, Ordering::Release);
          warn!(lease_key = %key, "Redis lease heartbeat lost ownership");
          break;
        }
        Err(error) => {
          owned.store(false, Ordering::Release);
          warn!(
            lease_key = %key,
            error_kind = port_error_kind(&error),
            "Redis lease heartbeat could not verify ownership"
          );
          // Keep probing so consumers that do not abort their current work
          // can refresh an unchanged owner after a transient Redis outage.
        }
      }
    }
  });
  handle.abort_handle()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::redis::{InMemoryRedisAdapter, RedisAdapter};

  fn memory_redis() -> Arc<dyn RedisPort> {
    Arc::new(InMemoryRedisAdapter::new("redis-lease-test"))
  }

  async fn wait_for_release(redis: &Arc<dyn RedisPort>, key: &str) {
    for _ in 0..20 {
      if redis.get_string(key).await.expect("read lease").is_none() {
        return;
      }
      tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("lease was not released");
  }

  #[tokio::test]
  async fn acquisition_is_exclusive_and_release_allows_takeover() {
    let redis = memory_redis();
    let key = "shared";
    let first = RedisLease::acquire(Arc::clone(&redis), key.to_string(), 60)
      .await
      .expect("acquire")
      .expect("first owner");
    assert!(
      RedisLease::acquire(Arc::clone(&redis), key.to_string(), 60)
        .await
        .expect("contended acquire")
        .is_none()
    );

    drop(first);
    wait_for_release(&redis, key).await;
    assert!(
      RedisLease::acquire(Arc::clone(&redis), key.to_string(), 60)
        .await
        .expect("takeover")
        .is_some()
    );
  }

  #[tokio::test]
  async fn release_never_deletes_a_foreign_owner() {
    let redis = memory_redis();
    let key = "foreign-release";
    let lease = RedisLease::acquire(Arc::clone(&redis), key.to_string(), 60)
      .await
      .expect("acquire")
      .expect("owner");
    redis
      .set_string(key, "replacement-owner", Some(60))
      .await
      .expect("replace owner");

    drop(lease);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
      redis.get_string(key).await.expect("read foreign owner"),
      Some("replacement-owner".to_string())
    );
  }

  #[tokio::test]
  async fn heartbeat_extends_the_lease_and_reports_lost_ownership() {
    let redis = memory_redis();
    let key = "heartbeat";
    let lease = RedisLease::acquire(Arc::clone(&redis), key.to_string(), 3)
      .await
      .expect("acquire")
      .expect("owner");

    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(redis.get_string(key).await.expect("read refreshed lease").is_some());
    assert!(lease.is_owned());

    redis
      .set_string(key, "replacement-owner", Some(60))
      .await
      .expect("replace owner");
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    assert!(!lease.is_owned());
    assert!(matches!(lease.ensure_owned(), Err(PortError::Conflict(_))));
  }

  #[tokio::test]
  async fn acquisition_error_has_no_local_fallback() {
    let redis: Arc<dyn RedisPort> =
      Arc::new(RedisAdapter::new("redis://127.0.0.1:1", "redis-lease-test").expect("adapter"));
    assert!(RedisLease::acquire(redis, "unreachable".to_string(), 60).await.is_err());
  }
}
