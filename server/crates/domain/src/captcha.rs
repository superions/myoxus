//! Port traits for CAPTCHA infrastructure dependencies.
//!
//! `CaptchaService` (in the application crate) depends on these traits, not
//! concrete Redis types, so the service stays testable and the storage
//! backend can be swapped.
//!
//! * [`SolvedChallengeRegistry`] — replay-protection store (INV-CAPTCHA-02).
//!   A successfully verified solution is atomically recorded with a TTL equal
//!   to the challenge expiry; subsequent submissions of the same solution are
//!   rejected.
//! * [`CaptchaRateLimiter`] — per-IP and per-account rate limits
//!   (INV-CAPTCHA-06). Implementations must expire counters at the configured
//!   TTL and not on sign-in success.

use async_trait::async_trait;
use thiserror::Error;

/// Errors that may surface from a [`SolvedChallengeRegistry`] or
/// [`CaptchaRateLimiter`] implementation. Kept coarse-grained so the
/// application layer only needs to distinguish "quota exhausted" from
/// "backend failure".
#[derive(Debug, Error)]
pub enum CaptchaStoreError {
  /// Backend I/O failure (Redis unavailable, connection timeout, etc.).
  #[error("captcha store backend error: {0}")]
  Backend(String),
}

pub type CaptchaStoreResult<T> = Result<T, CaptchaStoreError>;

/// Replay-protection registry for verified ALTCHA solutions.
///
/// Keyed by a hash of the client-supplied payload; the first caller to
/// register the key wins, all subsequent callers MUST be rejected as replays
/// until the entry expires.
#[async_trait]
pub trait SolvedChallengeRegistry: Send + Sync {
  /// Atomically record `key` with `ttl_seconds`. Returns `Ok(true)` if the
  /// key was newly inserted (first-seen), `Ok(false)` if it already existed
  /// (replay).
  async fn try_register(&self, key: &str, ttl_seconds: u64) -> CaptchaStoreResult<bool>;
}

/// Outcome of a rate-limit check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitOutcome {
  /// The request is within quota and was counted.
  Allowed,
  /// The quota was exhausted for the current window.
  Exceeded,
}

/// Per-IP and per-account rate limiter for CAPTCHA verification attempts.
///
/// Implementations must count one unit per call and expire the window at the
/// configured TTL; successful verification MUST NOT reset the counter, or an
/// attacker could bypass the limit by alternating successful/failed attempts.
#[async_trait]
pub trait CaptchaRateLimiter: Send + Sync {
  /// Increment the per-IP counter for `ip_hash`. The `window_seconds` argument
  /// sets the TTL applied the first time a counter is opened in the window.
  async fn check_ip(&self, ip_hash: &str, max: u32, window_seconds: u64) -> CaptchaStoreResult<RateLimitOutcome>;

  /// Increment the per-account counter for `account_hash`.
  async fn check_account(
    &self,
    account_hash: &str,
    max: u32,
    window_seconds: u64,
  ) -> CaptchaStoreResult<RateLimitOutcome>;
}
