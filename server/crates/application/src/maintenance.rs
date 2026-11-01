// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded retention operations shared by the nightly scheduler.

use std::sync::Arc;

use async_trait::async_trait;

use crate::auth::AuthResult;

#[async_trait]
pub trait RetentionRepository: Send + Sync {
  async fn clean_expired_sessions(&self) -> AuthResult<u64>;
  async fn clean_document_histories(&self, retention_days: i64) -> AuthResult<u64>;
  async fn clean_notifications(&self, retention_days: i64) -> AuthResult<u64>;
  async fn clean_pending_blobs(&self, retention_hours: i64) -> AuthResult<u64>;
  async fn clean_processed_outbox_events(&self, retention_days: i64) -> AuthResult<u64>;
  async fn clean_merged_document_updates(&self) -> AuthResult<u64>;
  async fn clean_orphaned_session_links(&self) -> AuthResult<u64>;
}

#[derive(Clone)]
pub struct RetentionService {
  repository: Arc<dyn RetentionRepository>,
}

impl RetentionService {
  pub fn new(repository: Arc<dyn RetentionRepository>) -> Self {
    Self { repository }
  }

  pub async fn clean_expired_sessions(&self) -> AuthResult<u64> {
    self.repository.clean_expired_sessions().await
  }

  pub async fn clean_document_histories(&self, retention_days: i64) -> AuthResult<u64> {
    self.repository.clean_document_histories(retention_days.max(1)).await
  }

  pub async fn clean_notifications(&self, retention_days: i64) -> AuthResult<u64> {
    self.repository.clean_notifications(retention_days.max(1)).await
  }

  pub async fn clean_pending_blobs(&self, retention_hours: i64) -> AuthResult<u64> {
    self.repository.clean_pending_blobs(retention_hours.max(1)).await
  }

  pub async fn clean_processed_outbox_events(&self, retention_days: i64) -> AuthResult<u64> {
    self
      .repository
      .clean_processed_outbox_events(retention_days.max(1))
      .await
  }

  pub async fn clean_merged_document_updates(&self) -> AuthResult<u64> {
    self.repository.clean_merged_document_updates().await
  }

  pub async fn clean_orphaned_session_links(&self) -> AuthResult<u64> {
    self.repository.clean_orphaned_session_links().await
  }
}
