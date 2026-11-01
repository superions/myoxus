// SPDX-License-Identifier: AGPL-3.0-or-later
//! Git-Sync HTTP ingress handlers.
//!
//! The webhook endpoint intentionally uses a Myoxus-owned HMAC contract instead
//! of provider-specific token headers. Provider webhooks should be configured to
//! send the raw event body plus:
//!
//! - `X-Myoxus-Timestamp`: Unix timestamp in seconds
//! - `X-Myoxus-Signature`: `sha256=<hex(hmac(secret, "{timestamp}.{body}"))>`
//! - `X-Myoxus-Delivery`: optional provider delivery id for diagnostics

use axum::{
  extract::{Path, State},
  http::{HeaderMap, StatusCode},
  response::{IntoResponse, Json},
};
use hmac::{Hmac, Mac};
use myoxus_application::git_sync::{GitSyncWebhookDelivery, GitSyncWebhookDeliveryAdmission, GitSyncWebhookStore};
use myoxus_domain::git_sync::{GitSyncRunSource, TriggerMode};
use myoxus_infrastructure::git_sync::{GitSyncStoreError, SqlxGitSyncStore};
use serde::Serialize;
use sha2::Sha256;
use subtle::ConstantTimeEq as _;
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use crate::state::ApiState;

type HmacSha256 = Hmac<Sha256>;

const WEBHOOK_MAX_CLOCK_SKEW_SECS: i64 = 300;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncWebhookResponse {
  accepted: bool,
  queued: bool,
  run_id: Option<Uuid>,
  reason: Option<String>,
}

#[instrument(skip(state, headers, body), fields(profile_id = %profile_id))]
pub async fn git_sync_webhook_handler(
  State(state): State<ApiState>,
  Path(profile_id): Path<Uuid>,
  headers: HeaderMap,
  body: bytes::Bytes,
) -> impl IntoResponse {
  let Some(pool) = state.metrics_pool() else {
    return json_response(
      StatusCode::SERVICE_UNAVAILABLE,
      false,
      false,
      None,
      Some("database not available"),
    );
  };

  let webhook_policy = match state.effective_git_sync_policy().await {
    Ok(policy) => policy,
    Err(error) => {
      warn!(%profile_id, error, "git-sync webhook rejected because effective policy is unavailable");
      return json_response(
        StatusCode::SERVICE_UNAVAILABLE,
        false,
        false,
        None,
        Some("git sync policy is unavailable"),
      );
    }
  };
  if !webhook_policy.enabled {
    return json_response(StatusCode::FORBIDDEN, false, false, None, Some("git sync is disabled"));
  }
  if !webhook_policy.webhook_allowed {
    return json_response(
      StatusCode::FORBIDDEN,
      false,
      false,
      None,
      Some("git sync webhooks are disabled"),
    );
  }

  let Some(secret) = state
    .config
    .git_sync
    .webhook_secret
    .as_deref()
    .map(str::trim)
    .filter(|secret| !secret.is_empty())
  else {
    warn!(%profile_id, "git-sync webhook rejected because webhook_secret is not configured");
    return json_response(
      StatusCode::SERVICE_UNAVAILABLE,
      false,
      false,
      None,
      Some("git sync webhook secret is not configured"),
    );
  };

  let Some(timestamp) = header_str(&headers, "x-myoxus-timestamp").and_then(|raw| raw.parse::<i64>().ok()) else {
    return json_response(
      StatusCode::UNAUTHORIZED,
      false,
      false,
      None,
      Some("missing or invalid X-Myoxus-Timestamp"),
    );
  };
  let now = chrono::Utc::now().timestamp();
  if (now - timestamp).abs() > WEBHOOK_MAX_CLOCK_SKEW_SECS {
    warn!(%profile_id, timestamp, now, "git-sync webhook rejected because timestamp is outside replay window");
    return json_response(
      StatusCode::UNAUTHORIZED,
      false,
      false,
      None,
      Some("webhook timestamp is outside the replay window"),
    );
  }

  let Some(signature) = header_str(&headers, "x-myoxus-signature") else {
    return json_response(
      StatusCode::UNAUTHORIZED,
      false,
      false,
      None,
      Some("missing X-Myoxus-Signature"),
    );
  };
  if !verify_webhook_signature(secret, timestamp, &body, signature) {
    warn!(%profile_id, "git-sync webhook rejected because signature verification failed");
    return json_response(
      StatusCode::UNAUTHORIZED,
      false,
      false,
      None,
      Some("invalid webhook signature"),
    );
  }

  let delivery_id = header_str(&headers, "x-myoxus-delivery")
    .map(str::to_string)
    .or_else(|| header_str(&headers, "x-github-delivery").map(str::to_string))
    .or_else(|| header_str(&headers, "x-gitlab-event-uuid").map(str::to_string));

  let store = SqlxGitSyncStore::new(pool.clone());
  let profile = match store.get_profile(profile_id).await {
    Ok(profile) if profile.enabled => profile,
    Ok(_) | Err(GitSyncStoreError::NotFound) => {
      return json_response(
        StatusCode::NOT_FOUND,
        false,
        false,
        None,
        Some("git sync profile not found or disabled"),
      );
    }
    Err(e) => {
      warn!(%profile_id, error = %e, "git-sync webhook profile lookup failed");
      return json_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        false,
        false,
        None,
        Some("git sync profile lookup failed"),
      );
    }
  };

  let workspace_id = profile.workspace_id;
  if profile.trigger_mode != TriggerMode::Webhook {
    return json_response(
      StatusCode::CONFLICT,
      false,
      false,
      None,
      Some("git sync profile is not configured for webhook trigger mode"),
    );
  }

  let delivery = webhook_delivery_from_request(secret, &headers, &body, delivery_id);
  let Some(ref_name) = delivery.ref_name.as_deref() else {
    if let Err(e) = store
      .record_delivery(profile_id, &delivery, false, None, Some("missing ref"))
      .await
    {
      warn!(%profile_id, error = %e, "git-sync webhook failed to persist missing-ref rejection");
    }
    return json_response(StatusCode::ACCEPTED, false, false, None, Some("webhook ref is missing"));
  };
  if !ref_matches_branch(ref_name, &profile.branch) {
    if let Err(e) = store
      .record_delivery(profile_id, &delivery, false, None, Some("branch mismatch"))
      .await
    {
      warn!(%profile_id, %ref_name, branch = %profile.branch, error = %e, "git-sync webhook failed to persist branch rejection");
    }
    return json_response(
      StatusCode::ACCEPTED,
      false,
      false,
      None,
      Some("webhook ref does not match profile branch"),
    );
  }

  match store.record_delivery(profile_id, &delivery, true, None, None).await {
    Ok(GitSyncWebhookDeliveryAdmission::Inserted) => {}
    Ok(GitSyncWebhookDeliveryAdmission::Duplicate {
      accepted,
      run_id,
      rejection_reason,
    }) => {
      debug!(%profile_id, %workspace_id, delivery_id = ?delivery.delivery_id, run_id = ?run_id, "git-sync webhook delivery duplicate");
      if accepted
        && let Some(run_id) = run_id
        && let Ok(run) = store.get_run(run_id).await
        && matches!(
          run.status,
          myoxus_domain::git_sync::RunStatus::Pending | myoxus_domain::git_sync::RunStatus::Running
        )
      {
        let Some(queue) = state.redis_queue() else {
          return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            false,
            false,
            Some(run_id),
            Some("Git Sync dispatcher is unavailable; Pending run remains recoverable"),
          );
        };
        return match crate::git_sync_engine::dispatch::dispatch_run(
          &queue,
          &store,
          crate::git_sync_engine::dispatch::pending_dispatch(run),
        )
        .await
        {
          Ok(_) => json_response(
            StatusCode::ACCEPTED,
            true,
            true,
            Some(run_id),
            Some("duplicate delivery"),
          ),
          Err(error) => {
            warn!(%profile_id, %workspace_id, %run_id, %error, "duplicate git-sync webhook dispatch failed");
            json_response(
              StatusCode::SERVICE_UNAVAILABLE,
              false,
              false,
              Some(run_id),
              Some("Git Sync dispatch failed; Pending run remains recoverable"),
            )
          }
        };
      }
      return json_response(
        StatusCode::ACCEPTED,
        accepted,
        false,
        run_id,
        rejection_reason.as_deref().or(Some("duplicate delivery")),
      );
    }
    Err(e) => {
      warn!(%profile_id, error = %e, "git-sync webhook failed to persist delivery");
      return json_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        false,
        false,
        None,
        Some("failed to persist git sync webhook delivery"),
      );
    }
  }

  let (run, inserted) = match store
    .create_pending_run_if_absent(profile_id, profile.sync_direction, GitSyncRunSource::Webhook)
    .await
  {
    Ok(result) => result,
    Err(e) => {
      warn!(%profile_id, error = %e, "git-sync webhook failed to create or select run");
      let _ = store
        .resolve_delivery(profile_id, &delivery.dedupe_key, false, None, Some("run create failed"))
        .await;
      return json_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        false,
        false,
        None,
        Some("failed to create git sync run"),
      );
    }
  };
  let run_id = run.id;
  if let Err(e) = store
    .resolve_delivery(profile_id, &delivery.dedupe_key, true, Some(run_id), None)
    .await
  {
    warn!(%profile_id, %run_id, error = %e, "git-sync webhook failed to link delivery to run");
    return json_response(
      StatusCode::INTERNAL_SERVER_ERROR,
      false,
      false,
      None,
      Some("failed to create git sync run"),
    );
  }

  let Some(queue) = state.redis_queue() else {
    warn!(%profile_id, %workspace_id, %run_id, "git-sync webhook left recoverable Pending run because dispatcher is unavailable");
    return json_response(
      StatusCode::SERVICE_UNAVAILABLE,
      false,
      false,
      Some(run_id),
      Some("Git Sync dispatcher is unavailable; Pending run remains recoverable"),
    );
  };
  match crate::git_sync_engine::dispatch::dispatch_run(
    &queue,
    &store,
    crate::git_sync_engine::dispatch::pending_dispatch(run),
  )
  .await
  {
    Ok(dispatched) => {
      info!(%profile_id, %workspace_id, %run_id, job_id = ?dispatched.job_id, inserted, "git-sync webhook dispatch acknowledged");
      let reason = (!inserted).then_some("sync already pending or running");
      json_response(StatusCode::ACCEPTED, true, true, Some(run_id), reason)
    }
    Err(error) => {
      warn!(%profile_id, %workspace_id, %run_id, %error, "git-sync webhook dispatch failed");
      json_response(
        StatusCode::SERVICE_UNAVAILABLE,
        false,
        false,
        Some(run_id),
        Some("Git Sync dispatch failed; Pending run remains recoverable"),
      )
    }
  }
}

pub fn verify_webhook_signature(secret: &str, timestamp: i64, body: &[u8], provided_signature: &str) -> bool {
  let Some(provided_hex) = provided_signature.trim().strip_prefix("sha256=") else {
    return false;
  };
  let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
    Ok(mac) => mac,
    Err(_) => return false,
  };
  mac.update(timestamp.to_string().as_bytes());
  mac.update(b".");
  mac.update(body);
  let expected = hex::encode(mac.finalize().into_bytes());
  expected.as_bytes().ct_eq(provided_hex.as_bytes()).into()
}

fn webhook_delivery_from_request(
  secret: &str,
  headers: &HeaderMap,
  body: &[u8],
  delivery_id: Option<String>,
) -> GitSyncWebhookDelivery {
  let payload_hash = payload_fingerprint(secret, body);
  let provider = header_str(headers, "x-github-delivery")
    .map(|_| "github".to_string())
    .or_else(|| header_str(headers, "x-gitlab-event-uuid").map(|_| "gitlab".to_string()))
    .or_else(|| header_str(headers, "x-myoxus-delivery").map(|_| "myoxus".to_string()));
  let event_name = header_str(headers, "x-github-event")
    .or_else(|| header_str(headers, "x-gitlab-event"))
    .or_else(|| header_str(headers, "x-myoxus-event"))
    .map(str::to_string);
  let ref_name = extract_ref_name(body);
  let dedupe_key = delivery_id.clone().unwrap_or_else(|| format!("payload:{payload_hash}"));
  GitSyncWebhookDelivery {
    dedupe_key,
    delivery_id,
    payload_hash,
    provider,
    event_name,
    ref_name,
  }
}

fn payload_fingerprint(secret: &str, body: &[u8]) -> String {
  let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts arbitrary key lengths");
  mac.update(body);
  hex::encode(mac.finalize().into_bytes())
}

fn extract_ref_name(body: &[u8]) -> Option<String> {
  let value: serde_json::Value = serde_json::from_slice(body).ok()?;
  value
    .get("ref")
    .and_then(|ref_value| ref_value.as_str())
    .map(str::trim)
    .filter(|ref_name| !ref_name.is_empty())
    .map(str::to_string)
}

fn ref_matches_branch(ref_name: &str, branch: &str) -> bool {
  let branch = branch.trim();
  ref_name == branch || ref_name == format!("refs/heads/{branch}")
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
  headers.get(name).and_then(|value| value.to_str().ok())
}

fn json_response(
  status: StatusCode,
  accepted: bool,
  queued: bool,
  run_id: Option<Uuid>,
  reason: Option<&str>,
) -> (StatusCode, Json<GitSyncWebhookResponse>) {
  (
    status,
    Json(GitSyncWebhookResponse {
      accepted,
      queued,
      run_id,
      reason: reason.map(str::to_string),
    }),
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn webhook_signature_verifier_requires_timestamped_hmac() {
    let secret = "test-secret";
    let timestamp = 1_770_000_000;
    let body = br#"{"ref":"refs/heads/main"}"#;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    let signature = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));

    assert!(verify_webhook_signature(secret, timestamp, body, &signature));
    assert!(!verify_webhook_signature(secret, timestamp + 1, body, &signature));
    assert!(!verify_webhook_signature(
      secret,
      timestamp,
      br#"{"ref":"tampered"}"#,
      &signature
    ));
    assert!(!verify_webhook_signature(secret, timestamp, body, "bad-format"));
  }
}
