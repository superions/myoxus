// SPDX-License-Identifier: AGPL-3.0-or-later
//! Persistence contract for authenticated Git-Sync webhook deliveries.

use async_trait::async_trait;
use thiserror::Error;
use uuid::Uuid;

/// Stable metadata retained for webhook deduplication and diagnostics.
#[derive(Debug, Clone)]
pub struct GitSyncWebhookDelivery {
  pub dedupe_key: String,
  pub delivery_id: Option<String>,
  pub payload_hash: String,
  pub provider: Option<String>,
  pub event_name: Option<String>,
  pub ref_name: Option<String>,
}

/// Result of the insert-if-absent delivery admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitSyncWebhookDeliveryAdmission {
  Inserted,
  Duplicate {
    accepted: bool,
    run_id: Option<Uuid>,
    rejection_reason: Option<String>,
  },
}

#[derive(Debug, Error)]
pub enum GitSyncWebhookStoreError {
  #[error("Git-Sync webhook persistence failed: {0}")]
  Storage(String),
}

/// Atomic owner for webhook delivery deduplication and run resolution.
#[async_trait]
pub trait GitSyncWebhookStore: Send + Sync {
  async fn record_delivery(
    &self,
    profile_id: Uuid,
    delivery: &GitSyncWebhookDelivery,
    accepted: bool,
    run_id: Option<Uuid>,
    rejection_reason: Option<&str>,
  ) -> Result<GitSyncWebhookDeliveryAdmission, GitSyncWebhookStoreError>;

  async fn resolve_delivery(
    &self,
    profile_id: Uuid,
    dedupe_key: &str,
    accepted: bool,
    run_id: Option<Uuid>,
    rejection_reason: Option<&str>,
  ) -> Result<(), GitSyncWebhookStoreError>;
}
