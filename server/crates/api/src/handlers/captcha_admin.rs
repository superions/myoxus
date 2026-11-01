//! SPDX-License-Identifier: AGPL-3.0-or-later
//!
//! Admin captcha status endpoint (P-Captcha-E).
//!
//! - `GET /api/admin/captcha/status` — operator-facing health & counters view
//!
//! Exposes the in-process Prometheus counters (verified / rejected / honeypot)
//! plus derived booleans so the admin GUI can render:
//!   * whether the CAPTCHA subsystem is wired and HMAC-key-backed,
//!   * how many submissions have been seen since process start.
//!
//! The `hmac_key_configured` flag is a boolean only — the key itself is never
//! included in the response (DSGVO + defense in depth).

use axum::{
  Json,
  extract::State,
  http::{HeaderMap, StatusCode},
  response::IntoResponse,
};
use serde::Serialize;
use tracing::{debug, instrument};

use crate::state::ApiState;

/// Response body for `GET /api/admin/captcha/status`.
#[derive(Debug, Serialize)]
pub struct CaptchaStatusResponse {
  /// Master switch state (`captcha.enabled`).
  pub enabled: bool,
  /// True if an HMAC signing key is present (length > 0 after trim).
  /// Never includes the key value itself.
  pub hmac_key_configured: bool,
  /// Active PoW algorithm (`SHA-256`, `Argon2id`, …).
  pub algorithm: String,
  /// Challenge expiration window in seconds (replay safety margin).
  pub challenge_expires_seconds: u64,
  /// Number of successful `verify_json_solution()` calls since process start.
  pub verified_total: u64,
  /// Number of rejected verifications (bad signature, replay, expired, …).
  pub rejected_total: u64,
  /// Number of rejected submissions due to honeypot trigger.
  pub honeypot_total: u64,
  /// Per-IP rate limit (attempts per minute).
  pub rate_limit_per_ip_per_min: u32,
  /// Per-account rate limit (attempts per hour).
  pub rate_limit_per_account_per_hour: u32,
}

/// `GET /api/admin/captcha/status` — Admin-only operator view.
#[instrument(skip_all, level = "debug")]
pub async fn captcha_status(State(state): State<ApiState>, headers: HeaderMap) -> impl IntoResponse {
  if let Err(status) = crate::require_admin_user(&state, &headers).await {
    return status.into_response();
  }

  let cfg = &state.config.captcha;
  let body = CaptchaStatusResponse {
    enabled: cfg.enabled,
    hmac_key_configured: !cfg.hmac_key.trim().is_empty(),
    algorithm: cfg.algorithm.clone(),
    challenge_expires_seconds: cfg.challenge_expires_seconds,
    verified_total: state.captcha_verified_count(),
    rejected_total: state.captcha_rejected_count(),
    honeypot_total: state.captcha_honeypot_count(),
    rate_limit_per_ip_per_min: cfg.rate_limit_per_ip_per_min,
    rate_limit_per_account_per_hour: cfg.rate_limit_per_account_per_hour,
  };
  debug!(
    enabled = body.enabled,
    hmac = body.hmac_key_configured,
    verified = body.verified_total,
    rejected = body.rejected_total,
    "captcha status response"
  );
  (StatusCode::OK, Json(body)).into_response()
}
