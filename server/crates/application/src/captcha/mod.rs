// SPDX-License-Identifier: AGPL-3.0-or-later
//! ALTCHA proof-of-work CAPTCHA service.
//!
//! [`CaptchaService`] wraps [`altcha_lib_rs`] and orchestrates the full
//! verification pipeline: signature + solution check (via the library),
//! per-IP and per-account rate limiting, and replay protection.
//!
//! ## Verification order (REVIEW-B)
//!
//! The order is deliberately:
//!
//! 1. Rate-limit per IP (fast, cheap) — prevents brute-force signature
//!    probing.
//! 2. Rate-limit per account (when known).
//! 3. ALTCHA signature + solution check — library call, constant-time HMAC
//!    comparison inside `altcha_lib_rs::verify_solution`.
//! 4. Replay check — Redis SETNX; must run last because a replay of a
//!    previously-valid solution MUST NOT consume a slot for a different
//!    (fresh) solution.
//!
//! Errors short-circuit in this order — rate-limit errors hide the
//! signature/solution error code from the client.

use std::sync::Arc;

use altcha_lib_rs::{
  ChallengeOptions, algorithm::AltchaAlgorithm, create_challenge as altcha_create_challenge, verify_json_solution,
};
use base64::{Engine, engine::general_purpose};
use chrono::{Duration, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tracing::{debug, instrument, trace, warn};

pub use altcha_lib_rs::{Challenge, algorithm::AltchaAlgorithm as Algorithm};
use myoxus_domain::captcha::{CaptchaRateLimiter, CaptchaStoreError, RateLimitOutcome, SolvedChallengeRegistry};

/// Service-layer configuration for the CAPTCHA pipeline.
///
/// Mirrors [`myoxus_api::config::CaptchaConfig`] but held as a plain struct
/// here so the application crate does not depend on the api crate.
#[derive(Debug, Clone)]
pub struct CaptchaSettings {
  pub enabled: bool,
  pub algorithm: AltchaAlgorithm,
  pub hmac_key: String,
  pub challenge_expires_seconds: u64,
  pub max_number: u64,
  pub rate_limit_per_ip_per_min: u32,
  pub rate_limit_per_account_per_hour: u32,
  pub honeypot_field_name: String,
}

/// Errors returned by [`CaptchaService`].
#[derive(Debug, Error)]
pub enum CaptchaError {
  /// CAPTCHA is globally disabled via config — callers MUST NOT issue
  /// challenges or run verification. The GET /challenge endpoint surfaces
  /// this as HTTP 503.
  #[error("captcha is disabled")]
  Disabled,

  /// The server was misconfigured (empty hmac_key in spite of enabled).
  /// Should be unreachable thanks to INV-CAPTCHA-01 / INV-CAPTCHA-08.
  #[error("captcha hmac_key is not configured")]
  MissingHmacKey,

  /// The client-supplied payload could not be decoded (bad base64 / JSON).
  #[error("captcha payload invalid")]
  InvalidPayload,

  /// Challenge has expired (INV-CAPTCHA-03).
  #[error("captcha challenge expired")]
  Expired,

  /// HMAC signature did not match — either tampered or wrong hmac_key.
  #[error("captcha signature invalid")]
  InvalidSignature,

  /// The proof-of-work solution does not match the expected challenge hash.
  #[error("captcha solution invalid")]
  InvalidSolution,

  /// Same (signed) payload was submitted twice (INV-CAPTCHA-02).
  #[error("captcha solution replay")]
  Replay,

  /// Per-IP rate limit exhausted.
  #[error("captcha per-ip rate limit exceeded")]
  RateLimitedIp,

  /// Per-account rate limit exhausted.
  #[error("captcha per-account rate limit exceeded")]
  RateLimitedAccount,

  /// Redis / storage backend error.
  #[error("captcha store error: {0}")]
  Store(String),

  /// Library-level challenge creation error (should be rare — only when
  /// the RNG fails or numbers exceed bounds).
  #[error("captcha internal error: {0}")]
  Internal(String),
}

impl CaptchaError {
  /// Stable machine-readable code for surfacing to the HTTP client.
  pub fn code(&self) -> &'static str {
    match self {
      Self::Disabled => "captcha_disabled",
      Self::MissingHmacKey => "captcha_misconfigured",
      Self::InvalidPayload => "captcha_invalid_payload",
      Self::Expired => "captcha_expired",
      Self::InvalidSignature => "captcha_invalid_signature",
      Self::InvalidSolution => "captcha_invalid_solution",
      Self::Replay => "captcha_replay",
      Self::RateLimitedIp => "captcha_rate_limited_ip",
      Self::RateLimitedAccount => "captcha_rate_limited_account",
      Self::Store(_) => "captcha_store_error",
      Self::Internal(_) => "captcha_internal_error",
    }
  }
}

impl From<CaptchaStoreError> for CaptchaError {
  fn from(e: CaptchaStoreError) -> Self {
    Self::Store(e.to_string())
  }
}

pub type CaptchaResult<T> = Result<T, CaptchaError>;

/// Proof-of-work CAPTCHA service.
///
/// Use [`Self::create_challenge`] to issue a new challenge to the client, and
/// [`Self::verify`] to validate a submitted payload before letting the
/// protected endpoint proceed.
pub struct CaptchaService {
  settings: CaptchaSettings,
  replay_registry: Arc<dyn SolvedChallengeRegistry>,
  rate_limiter: Arc<dyn CaptchaRateLimiter>,
}

impl CaptchaService {
  pub fn new(
    settings: CaptchaSettings,
    replay_registry: Arc<dyn SolvedChallengeRegistry>,
    rate_limiter: Arc<dyn CaptchaRateLimiter>,
  ) -> Self {
    Self {
      settings,
      replay_registry,
      rate_limiter,
    }
  }

  /// True when the feature is active and a hmac_key is set.
  pub fn is_enabled(&self) -> bool {
    self.settings.enabled && !self.settings.hmac_key.trim().is_empty()
  }

  /// Name of the honeypot form-field the HTTP layer should check for
  /// (P-Captcha-C).
  pub fn honeypot_field_name(&self) -> &str {
    &self.settings.honeypot_field_name
  }

  /// Issue a fresh challenge. Returns [`CaptchaError::Disabled`] when the
  /// feature is off so that the HTTP layer can map it to 503.
  #[instrument(skip(self), fields(algorithm = %self.settings.algorithm))]
  pub fn create_challenge(&self) -> CaptchaResult<Challenge> {
    if !self.settings.enabled {
      return Err(CaptchaError::Disabled);
    }
    if self.settings.hmac_key.trim().is_empty() {
      return Err(CaptchaError::MissingHmacKey);
    }
    let expires = Utc::now() + Duration::seconds(self.settings.challenge_expires_seconds as i64);
    altcha_create_challenge(ChallengeOptions {
      algorithm: Some(self.settings.algorithm),
      max_number: Some(self.settings.max_number),
      hmac_key: self.settings.hmac_key.as_str(),
      expires: Some(expires),
      ..Default::default()
    })
    .map_err(|e| CaptchaError::Internal(e.to_string()))
  }

  /// Verify a client-submitted solution payload.
  ///
  /// `payload` is the ALTCHA widget payload from `x-captcha-token`. The
  /// browser widget emits base64-encoded JSON; server-side tests may pass raw
  /// JSON. Both forms are normalized to one canonical JSON string before
  /// verification and replay hashing so representation changes cannot bypass
  /// INV-CAPTCHA-02.
  ///
  /// `ip_hash` is a caller-provided hash of the remote IP (DSGVO: raw IPs
  /// MUST NOT be stored — REVIEW-C).
  /// `account_hash` is an optional sha256 of the lowercased email or
  /// other stable account identifier.
  ///
  /// Payload is never logged (INV-CAPTCHA-07).
  #[instrument(skip(self, payload), fields(account_hash_present = account_hash.is_some()))]
  pub async fn verify(&self, payload: &str, ip_hash: &str, account_hash: Option<&str>) -> CaptchaResult<()> {
    if !self.settings.enabled {
      return Err(CaptchaError::Disabled);
    }
    if self.settings.hmac_key.trim().is_empty() {
      return Err(CaptchaError::MissingHmacKey);
    }

    // 1. Rate-limit per IP.
    match self
      .rate_limiter
      .check_ip(ip_hash, self.settings.rate_limit_per_ip_per_min, 60)
      .await?
    {
      RateLimitOutcome::Allowed => {}
      RateLimitOutcome::Exceeded => {
        debug!("captcha rate-limited per-ip");
        return Err(CaptchaError::RateLimitedIp);
      }
    }

    // 2. Rate-limit per account (if we know who the caller claims to be).
    if let Some(acc) = account_hash {
      match self
        .rate_limiter
        .check_account(acc, self.settings.rate_limit_per_account_per_hour, 3600)
        .await?
      {
        RateLimitOutcome::Allowed => {}
        RateLimitOutcome::Exceeded => {
          debug!("captcha rate-limited per-account");
          return Err(CaptchaError::RateLimitedAccount);
        }
      }
    }

    let normalized_payload = normalize_payload(payload)?;

    // 3. Library signature + solution check. `verify_json_solution` checks
    //    expiration, HMAC signature, and the proof-of-work hash in one call.
    verify_json_solution(&normalized_payload, &self.settings.hmac_key, true).map_err(|e| {
      use altcha_lib_rs::error::Error as AE;
      match e {
        AE::VerificationFailedExpired(_) | AE::ParseExpire(_) | AE::ParseInteger(_) => CaptchaError::Expired,
        AE::VerificationMismatchSignature(_) => CaptchaError::InvalidSignature,
        AE::VerificationMismatchChallenge(_) => CaptchaError::InvalidSolution,
        AE::ParseJson(_) => CaptchaError::InvalidPayload,
        other => {
          warn!(error = %other, "altcha verification failed with unexpected error");
          CaptchaError::InvalidPayload
        }
      }
    })?;

    // 4. Replay check — hash the payload to avoid storing it verbatim.
    let payload_hash = hex::encode(Sha256::digest(normalized_payload.as_bytes()));
    let fresh = self
      .replay_registry
      .try_register(&payload_hash, self.settings.challenge_expires_seconds)
      .await?;
    if !fresh {
      debug!("captcha replay detected");
      return Err(CaptchaError::Replay);
    }

    trace!("captcha verification ok");
    Ok(())
  }
}

fn normalize_payload(payload: &str) -> CaptchaResult<String> {
  let trimmed = payload.trim();
  if trimmed.is_empty() {
    return Err(CaptchaError::InvalidPayload);
  }
  if trimmed.starts_with('{') {
    return canonicalize_payload_json(trimmed);
  }

  let decoded = general_purpose::STANDARD
    .decode(trimmed)
    .or_else(|_| general_purpose::URL_SAFE_NO_PAD.decode(trimmed))
    .map_err(|_| CaptchaError::InvalidPayload)?;
  let decoded = String::from_utf8(decoded).map_err(|_| CaptchaError::InvalidPayload)?;
  canonicalize_payload_json(&decoded)
}

fn canonicalize_payload_json(raw: &str) -> CaptchaResult<String> {
  let mut value: Value = serde_json::from_str(raw).map_err(|_| CaptchaError::InvalidPayload)?;
  if let Some(obj) = value.as_object_mut()
    && obj.get("took").is_some_and(|v| !(v.is_null() || v.is_u64()))
  {
    // ALTCHA v3 reports sub-millisecond solve duration as a decimal, while
    // altcha-lib-rs 0.3.x models this optional diagnostic field as u32.
    // It is not part of the signature or PoW check, so drop incompatible
    // duration metadata instead of rejecting an otherwise valid solution.
    obj.remove("took");
  }
  serde_json::to_string(&value).map_err(|_| CaptchaError::InvalidPayload)
}

#[cfg(test)]
mod tests {
  use super::*;
  use altcha_lib_rs::{Payload, solve_challenge};
  use async_trait::async_trait;
  use std::sync::Mutex;

  #[derive(Default)]
  struct MemRegistry {
    seen: Mutex<Vec<String>>,
  }

  #[async_trait]
  impl SolvedChallengeRegistry for MemRegistry {
    async fn try_register(&self, key: &str, _ttl: u64) -> Result<bool, CaptchaStoreError> {
      let mut g = self.seen.lock().unwrap();
      if g.iter().any(|k| k == key) {
        return Ok(false);
      }
      g.push(key.to_string());
      Ok(true)
    }
  }

  #[derive(Default)]
  struct AllowAllLimiter;

  #[async_trait]
  impl CaptchaRateLimiter for AllowAllLimiter {
    async fn check_ip(&self, _: &str, _: u32, _: u64) -> Result<RateLimitOutcome, CaptchaStoreError> {
      Ok(RateLimitOutcome::Allowed)
    }
    async fn check_account(&self, _: &str, _: u32, _: u64) -> Result<RateLimitOutcome, CaptchaStoreError> {
      Ok(RateLimitOutcome::Allowed)
    }
  }

  #[derive(Default)]
  struct DenyIpLimiter;

  #[async_trait]
  impl CaptchaRateLimiter for DenyIpLimiter {
    async fn check_ip(&self, _: &str, _: u32, _: u64) -> Result<RateLimitOutcome, CaptchaStoreError> {
      Ok(RateLimitOutcome::Exceeded)
    }
    async fn check_account(&self, _: &str, _: u32, _: u64) -> Result<RateLimitOutcome, CaptchaStoreError> {
      Ok(RateLimitOutcome::Allowed)
    }
  }

  #[derive(Default)]
  struct DenyAccountLimiter;

  #[async_trait]
  impl CaptchaRateLimiter for DenyAccountLimiter {
    async fn check_ip(&self, _: &str, _: u32, _: u64) -> Result<RateLimitOutcome, CaptchaStoreError> {
      Ok(RateLimitOutcome::Allowed)
    }
    async fn check_account(&self, _: &str, _: u32, _: u64) -> Result<RateLimitOutcome, CaptchaStoreError> {
      Ok(RateLimitOutcome::Exceeded)
    }
  }

  fn settings(enabled: bool, hmac_key: &str) -> CaptchaSettings {
    CaptchaSettings {
      enabled,
      algorithm: AltchaAlgorithm::Sha256,
      hmac_key: hmac_key.to_string(),
      challenge_expires_seconds: 60,
      max_number: 1000,
      rate_limit_per_ip_per_min: 10,
      rate_limit_per_account_per_hour: 5,
      honeypot_field_name: "website".to_string(),
    }
  }

  fn solved_payload(service: &CaptchaService) -> String {
    let challenge = service.create_challenge().expect("challenge");
    let number = solve_challenge(
      &challenge.challenge,
      &challenge.salt,
      Some(challenge.algorithm),
      Some(challenge.maxnumber),
      0,
    )
    .expect("solve");
    serde_json::to_string(&Payload {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      number,
      salt: challenge.salt,
      signature: challenge.signature,
      took: None,
    })
    .unwrap()
  }

  fn svc(enabled: bool, hmac: &str, limiter: Arc<dyn CaptchaRateLimiter>) -> CaptchaService {
    CaptchaService::new(settings(enabled, hmac), Arc::new(MemRegistry::default()), limiter)
  }

  #[tokio::test]
  async fn inv_captcha_service_disabled_rejects() {
    let s = svc(false, "k".repeat(32).as_str(), Arc::new(AllowAllLimiter));
    assert!(matches!(s.create_challenge(), Err(CaptchaError::Disabled)));
    let r = s.verify("{}", "ip", None).await;
    assert!(matches!(r, Err(CaptchaError::Disabled)));
  }

  #[tokio::test]
  async fn inv_captcha_happy_path() {
    let s = svc(true, &"k".repeat(32), Arc::new(AllowAllLimiter));
    let payload = solved_payload(&s);
    s.verify(&payload, "ip", Some("acct")).await.expect("ok");
  }

  #[tokio::test]
  async fn inv_captcha_widget_base64_payload_is_accepted() {
    let s = svc(true, &"k".repeat(32), Arc::new(AllowAllLimiter));
    let payload = solved_payload(&s);
    let widget_payload = general_purpose::STANDARD.encode(payload.as_bytes());
    s.verify(&widget_payload, "ip", Some("acct")).await.expect("ok");
  }

  #[tokio::test]
  async fn inv_captcha_widget_decimal_took_is_accepted() {
    let s = svc(true, &"k".repeat(32), Arc::new(AllowAllLimiter));
    let payload = solved_payload(&s);
    let mut value: serde_json::Value = serde_json::from_str(&payload).expect("payload json");
    value["took"] = serde_json::json!(12.3);
    let widget_payload = general_purpose::STANDARD.encode(value.to_string().as_bytes());
    s.verify(&widget_payload, "ip", Some("acct")).await.expect("ok");
  }

  #[tokio::test]
  async fn inv_captcha02_replay_is_encoding_invariant() {
    let s = svc(true, &"k".repeat(32), Arc::new(AllowAllLimiter));
    let payload = solved_payload(&s);
    let widget_payload = general_purpose::STANDARD.encode(payload.as_bytes());
    s.verify(&payload, "ip", None).await.expect("first ok");
    let err = s.verify(&widget_payload, "ip", None).await.unwrap_err();
    assert!(matches!(err, CaptchaError::Replay), "got {err:?}");
  }

  #[tokio::test]
  async fn inv_captcha02_replay_rejected() {
    let s = svc(true, &"k".repeat(32), Arc::new(AllowAllLimiter));
    let payload = solved_payload(&s);
    s.verify(&payload, "ip", None).await.expect("first ok");
    let err = s.verify(&payload, "ip", None).await.unwrap_err();
    assert!(matches!(err, CaptchaError::Replay), "got {err:?}");
  }

  #[tokio::test]
  async fn inv_captcha_invalid_signature() {
    // Build a payload against one hmac, verify against another.
    let s_issuer = svc(true, &"a".repeat(32), Arc::new(AllowAllLimiter));
    let payload = solved_payload(&s_issuer);
    let s_verifier = svc(true, &"b".repeat(32), Arc::new(AllowAllLimiter));
    let err = s_verifier.verify(&payload, "ip", None).await.unwrap_err();
    assert!(matches!(err, CaptchaError::InvalidSignature), "got {err:?}");
  }

  #[tokio::test]
  async fn inv_captcha_invalid_payload() {
    let s = svc(true, &"k".repeat(32), Arc::new(AllowAllLimiter));
    let err = s.verify("not-json", "ip", None).await.unwrap_err();
    assert!(matches!(err, CaptchaError::InvalidPayload), "got {err:?}");
  }

  #[tokio::test]
  async fn inv_captcha_ip_rate_limit_short_circuits_before_verify() {
    let s = svc(true, &"k".repeat(32), Arc::new(DenyIpLimiter));
    // Payload is intentionally invalid — IP limiter should fire first.
    let err = s.verify("garbage", "ip", None).await.unwrap_err();
    assert!(matches!(err, CaptchaError::RateLimitedIp), "got {err:?}");
  }

  #[tokio::test]
  async fn inv_captcha_account_rate_limit_only_when_account_known() {
    let s = svc(true, &"k".repeat(32), Arc::new(DenyAccountLimiter));
    // No account → account-limiter is skipped, so a valid payload succeeds.
    let payload = solved_payload(&s);
    s.verify(&payload, "ip", None).await.expect("no-account ok");
    // With account → limiter fires.
    let err = s.verify("garbage", "ip", Some("acct")).await.unwrap_err();
    assert!(matches!(err, CaptchaError::RateLimitedAccount), "got {err:?}");
  }

  #[tokio::test]
  async fn inv_captcha_expired_challenge_rejected() {
    // Settings with 0-second expiry would be caught by validation — so we
    // hand-craft a payload using an expiry in the past.
    let mut set = settings(true, &"k".repeat(32));
    set.challenge_expires_seconds = 60;
    let s = CaptchaService::new(set, Arc::new(MemRegistry::default()), Arc::new(AllowAllLimiter));
    let past = Utc::now() - Duration::seconds(120);
    let challenge = altcha_create_challenge(ChallengeOptions {
      algorithm: Some(AltchaAlgorithm::Sha256),
      max_number: Some(1000),
      hmac_key: "k".repeat(32).as_str(),
      expires: Some(past),
      ..Default::default()
    })
    .unwrap();
    let number = solve_challenge(
      &challenge.challenge,
      &challenge.salt,
      Some(challenge.algorithm),
      Some(challenge.maxnumber),
      0,
    )
    .unwrap();
    let payload = serde_json::to_string(&Payload {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      number,
      salt: challenge.salt,
      signature: challenge.signature,
      took: None,
    })
    .unwrap();
    let err = s.verify(&payload, "ip", None).await.unwrap_err();
    assert!(matches!(err, CaptchaError::Expired), "got {err:?}");
  }
}
