// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Outbound webhook delivery port for Workspace Automations.
//!
//! Application prepares the exact wire bytes and signature before native dispatch
//! admission. Infrastructure performs one HTTP attempt; Sayiir owns retry/backoff.

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAutomationWebhookPayload {
  pub workspace_id: String,
  pub automation_id: String,
  pub run_id: String,
  pub action_id: String,
  pub trigger_type: String,
  pub event: serde_json::Value,
}

#[derive(Clone)]
pub struct WorkspaceAutomationWebhookRequest {
  pub url: String,
  pub body: Vec<u8>,
  pub delivery_id: String,
  pub timestamp: i64,
  pub signature: Option<String>,
  pub timeout_seconds: u64,
}

impl WorkspaceAutomationWebhookRequest {
  /// Complete fallible local preparation before the fenced dispatch is admitted.
  /// The signature covers these same bytes, including the native action identity.
  pub fn new(
    url: String,
    payload: WorkspaceAutomationWebhookPayload,
    secret_ref: Option<String>,
    timeout_seconds: u64,
  ) -> Result<Self, WorkspaceAutomationWebhookError> {
    let body = serde_json::to_vec(&payload)
      .map_err(|_| WorkspaceAutomationWebhookError::new(None, "webhook payload encoding failed"))?;
    let timestamp = chrono::Utc::now().timestamp();
    let signature = secret_ref
      .map(|secret| -> Result<String, WorkspaceAutomationWebhookError> {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
          .map_err(|_| WorkspaceAutomationWebhookError::new(None, "webhook signing failed"))?;
        mac.update(timestamp.to_string().as_bytes());
        mac.update(b".");
        mac.update(&body);
        Ok(format!("sha256={}", hex::encode(mac.finalize().into_bytes())))
      })
      .transpose()?;
    Ok(Self {
      url,
      body,
      delivery_id: payload.action_id,
      timestamp,
      signature,
      timeout_seconds,
    })
  }
}

#[derive(Debug, Clone)]
pub struct WorkspaceAutomationWebhookResponse {
  pub status: u16,
}

#[derive(Debug, Clone)]
pub struct WorkspaceAutomationWebhookError {
  pub status: Option<u16>,
  pub message: String,
}

impl WorkspaceAutomationWebhookError {
  pub fn new(status: Option<u16>, message: impl Into<String>) -> Self {
    Self {
      status,
      message: message.into(),
    }
  }
}

impl std::fmt::Display for WorkspaceAutomationWebhookError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self.status {
      Some(status) => write!(f, "webhook returned HTTP {status}: {}", self.message),
      None => write!(f, "webhook delivery failed: {}", self.message),
    }
  }
}

impl std::error::Error for WorkspaceAutomationWebhookError {}

#[async_trait]
pub trait WorkspaceAutomationWebhookPort: Send + Sync {
  async fn deliver(
    &self,
    request: WorkspaceAutomationWebhookRequest,
  ) -> Result<WorkspaceAutomationWebhookResponse, WorkspaceAutomationWebhookError>;
}
