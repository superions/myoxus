// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Durable outbox handoff and worker dispatch for MCP API-key creation emails.
//!
//! Security-critical account emails bypass optional collaboration opt-outs and
//! resolve the recipient's current active account and locale/timezone preferences
//! at delivery time. Plaintext keys and hashes never enter this pipeline.

use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::ports::{MailPort, MailTemplate, PortError};
use myoxus_worker::{JobError, JobOptions, RedisQueue};
use serde_json::{Value, json};
use tracing::{info, instrument};
use uuid::Uuid;

use crate::state::ApiState;

pub const MCP_API_KEY_CREATED_JOB_NAME: &str = "notification.sendMcpApiKeyCreated";

fn required_uuid(data: &Value, field: &str) -> Result<Uuid, JobError> {
  data
    .get(field)
    .and_then(Value::as_str)
    .and_then(|value| value.parse::<Uuid>().ok())
    .ok_or_else(|| JobError::Permanent(format!("mcp_api_key_created {field} is missing or invalid")))
}

/// Enqueue one idempotent worker job for a committed `mcp_api_key_created` outbox row.
#[instrument(skip_all)]
pub async fn enqueue_mcp_api_key_created_notification(
  queue: &RedisQueue,
  event_id: Uuid,
  payload: &Value,
) -> AuthResult<()> {
  let mut data = payload.clone();
  if let Some(object) = data.as_object_mut() {
    object.insert("intentId".into(), json!(event_id));
  }
  queue
    .enqueue_idempotent(
      "notification",
      &format!("mcp-api-key-created:{event_id}"),
      MCP_API_KEY_CREATED_JOB_NAME,
      data,
      JobOptions::default(),
    )
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
  Ok(())
}

/// Resolve the owning active user and send the localized MCP API-key creation email.
///
/// Returns `Ok(true)` when delivered and `Ok(false)` when suppressed because the
/// account no longer exists or is disabled.
#[instrument(skip_all)]
pub async fn dispatch_mcp_api_key_created_notification(
  state: &ApiState,
  mail: &dyn MailPort,
  data: &Value,
) -> Result<bool, JobError> {
  let user_id = required_uuid(data, "userId")?;
  let api_key_id = required_uuid(data, "apiKeyId")?;

  let Some(user) = state
    .auth()
    .get_user_by_id(user_id)
    .await
    .map_err(|error| JobError::Retryable(error.to_string()))?
    .filter(|user| !user.disabled)
  else {
    info!(%user_id, %api_key_id, "suppressing MCP API-key creation email for inactive or deleted account");
    return Ok(false);
  };

  let key_name = data
    .get("name")
    .and_then(Value::as_str)
    .unwrap_or_default()
    .trim()
    .to_string();
  let key_scopes: Vec<String> = data
    .get("scopes")
    .and_then(Value::as_array)
    .map(|items| {
      items
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(str::to_string)
        .collect()
    })
    .unwrap_or_default();
  let created_at = data
    .get("createdAt")
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_string();
  let expires_at = data
    .get("expiresAt")
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_string();

  let context = json!({
    "key_name": key_name,
    "key_scopes": key_scopes,
    "created_at": created_at,
    "expires_at": expires_at,
    "url": "/",
  });

  let template_mail = state
    .auth()
    .prepare_mail_for_user(Some(user.id), &user.email, MailTemplate::McpApiKeyCreated, context)
    .await
    .map_err(|error| JobError::Retryable(error.to_string()))?;

  mail.send_template(template_mail).await.map_err(|error| match error {
    PortError::InvalidInput(message) => JobError::Permanent(message),
    other => JobError::Retryable(other.to_string()),
  })?;

  info!(%user_id, %api_key_id, "dispatched MCP API-key creation email");
  Ok(true)
}
