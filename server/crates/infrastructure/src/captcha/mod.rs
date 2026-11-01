// SPDX-License-Identifier: AGPL-3.0-or-later
//! Redis-backed adapters for the CAPTCHA domain ports.
//!
//! * [`RedisSolvedChallengeRegistry`] uses `SET NX EX` to atomically claim a
//!   one-use replay slot per payload hash.
//! * [`RedisCaptchaRateLimiter`] uses `INCR` + `EXPIRE` (fixed-window) per
//!   IP and per account. Counters reset at the window TTL, not on
//!   verification success (INV-CAPTCHA-06).
//!
//! Both adapters layer on top of [`RedisPort`] so tests can run against the
//! [`InMemoryRedisAdapter`] without spinning up a real Redis.

use std::sync::Arc;

use async_trait::async_trait;
use tracing::{debug, instrument};

use myoxus_application::ports::RedisPort;
use myoxus_domain::captcha::{
  CaptchaRateLimiter, CaptchaStoreError, CaptchaStoreResult, RateLimitOutcome, SolvedChallengeRegistry,
};

const REGISTRY_PREFIX: &str = "captcha:solved:";
const RATE_LIMIT_IP_PREFIX: &str = "captcha:rl:ip:";
const RATE_LIMIT_ACCOUNT_PREFIX: &str = "captcha:rl:acct:";

/// Redis-backed replay registry (INV-CAPTCHA-02).
pub struct RedisSolvedChallengeRegistry {
  redis: Arc<dyn RedisPort>,
}

impl RedisSolvedChallengeRegistry {
  pub fn new(redis: Arc<dyn RedisPort>) -> Self {
    Self { redis }
  }
}

#[async_trait]
impl SolvedChallengeRegistry for RedisSolvedChallengeRegistry {
  #[instrument(skip(self, key))]
  async fn try_register(&self, key: &str, ttl_seconds: u64) -> CaptchaStoreResult<bool> {
    let redis_key = format!("{REGISTRY_PREFIX}{key}");
    self
      .redis
      .setnx_string(&redis_key, "1", Some(ttl_seconds))
      .await
      .map_err(|e| CaptchaStoreError::Backend(format!("setnx failed: {e}")))
  }
}

/// Redis-backed rate limiter.
pub struct RedisCaptchaRateLimiter {
  redis: Arc<dyn RedisPort>,
}

impl RedisCaptchaRateLimiter {
  pub fn new(redis: Arc<dyn RedisPort>) -> Self {
    Self { redis }
  }

  async fn check(&self, key: &str, max: u32, window_seconds: u64) -> CaptchaStoreResult<RateLimitOutcome> {
    let count = self
      .redis
      .increase(key, 1)
      .await
      .map_err(|e| CaptchaStoreError::Backend(format!("incr failed: {e}")))?;

    // Only set the TTL the first time we open the window (count == 1). Setting
    // it on every call would extend the window each hit, turning this into a
    // sliding window where a sustained attacker could never expire the key.
    if count == 1 {
      let _ = self
        .redis
        .expire_key(key, window_seconds)
        .await
        .map_err(|e| CaptchaStoreError::Backend(format!("expire failed: {e}")))?;
    }

    if count as u64 > max as u64 {
      debug!(key, count, max, "captcha rate-limit window exceeded");
      Ok(RateLimitOutcome::Exceeded)
    } else {
      Ok(RateLimitOutcome::Allowed)
    }
  }
}

#[async_trait]
impl CaptchaRateLimiter for RedisCaptchaRateLimiter {
  #[instrument(skip(self, ip_hash), fields(ip_hash_len = ip_hash.len()))]
  async fn check_ip(&self, ip_hash: &str, max: u32, window_seconds: u64) -> CaptchaStoreResult<RateLimitOutcome> {
    let key = format!("{RATE_LIMIT_IP_PREFIX}{ip_hash}");
    self.check(&key, max, window_seconds).await
  }

  #[instrument(skip(self, account_hash), fields(account_hash_len = account_hash.len()))]
  async fn check_account(
    &self,
    account_hash: &str,
    max: u32,
    window_seconds: u64,
  ) -> CaptchaStoreResult<RateLimitOutcome> {
    let key = format!("{RATE_LIMIT_ACCOUNT_PREFIX}{account_hash}");
    self.check(&key, max, window_seconds).await
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::redis::InMemoryRedisAdapter;

  fn redis() -> Arc<dyn RedisPort> {
    Arc::new(InMemoryRedisAdapter::new("myoxus"))
  }

  #[tokio::test]
  async fn inv_captcha02_replay_registry_first_wins() {
    let reg = RedisSolvedChallengeRegistry::new(redis());
    assert!(reg.try_register("hash-a", 60).await.unwrap(), "first should win");
    assert!(!reg.try_register("hash-a", 60).await.unwrap(), "replay should lose");
    assert!(reg.try_register("hash-b", 60).await.unwrap(), "different key ok");
  }

  #[tokio::test]
  async fn rate_limiter_counts_and_trips() {
    let rl = RedisCaptchaRateLimiter::new(redis());
    for _ in 0..3 {
      assert_eq!(rl.check_ip("ip1", 3, 60).await.unwrap(), RateLimitOutcome::Allowed);
    }
    assert_eq!(rl.check_ip("ip1", 3, 60).await.unwrap(), RateLimitOutcome::Exceeded);
    // Other ip unaffected.
    assert_eq!(rl.check_ip("ip2", 3, 60).await.unwrap(), RateLimitOutcome::Allowed);
  }

  #[tokio::test]
  async fn rate_limiter_ip_and_account_are_independent() {
    let rl = RedisCaptchaRateLimiter::new(redis());
    // Same string under two namespaces must NOT collide.
    assert_eq!(rl.check_ip("x", 1, 60).await.unwrap(), RateLimitOutcome::Allowed);
    assert_eq!(rl.check_account("x", 1, 60).await.unwrap(), RateLimitOutcome::Allowed);
    assert_eq!(rl.check_ip("x", 1, 60).await.unwrap(), RateLimitOutcome::Exceeded);
    assert_eq!(rl.check_account("x", 1, 60).await.unwrap(), RateLimitOutcome::Exceeded);
  }
}
