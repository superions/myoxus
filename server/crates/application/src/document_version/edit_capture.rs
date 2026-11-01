// SPDX-License-Identifier: AGPL-3.0-or-later
//! Durable automatic history capture for acknowledged document content writes.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::repositories::RepoResult;
use tracing::{info, instrument};

use super::GlobalEditCaptureSettings;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditCaptureRunSummary {
  pub reconciled: usize,
  pub examined: usize,
  pub captured: usize,
  pub unchanged: usize,
  pub skipped: usize,
  pub failed: usize,
}

/// Atomic persistence boundary for scheduling and capturing due document state.
#[async_trait]
pub trait DocumentEditCaptureRepository: Send + Sync {
  /// Recompute due times for a bounded set of dirty rows after settings or
  /// lifecycle changes. This scans only durable capture intent, never all docs.
  async fn reconcile(&self, global: &GlobalEditCaptureSettings, now: DateTime<Utc>, limit: i64) -> RepoResult<usize>;

  /// Capture a bounded due batch. Each document is isolated so corrupt content
  /// records a retry without starving later candidates.
  async fn capture_due(
    &self,
    global: &GlobalEditCaptureSettings,
    now: DateTime<Utc>,
    limit: i64,
  ) -> RepoResult<EditCaptureRunSummary>;

  /// Publish a worker heartbeat after a completed bounded polling pass.
  async fn record_heartbeat(&self, now: DateTime<Utc>) -> RepoResult<()>;
}

#[derive(Clone)]
pub struct DocumentEditCaptureService {
  repository: Arc<dyn DocumentEditCaptureRepository>,
}

impl DocumentEditCaptureService {
  pub fn new(repository: Arc<dyn DocumentEditCaptureRepository>) -> Self {
    Self { repository }
  }

  #[instrument(skip(self, global), fields(global_enabled = global.enabled, global_interval_ms = global.interval_ms))]
  pub async fn run_once(
    &self,
    global: &GlobalEditCaptureSettings,
    now: DateTime<Utc>,
    reconcile_limit: i64,
    capture_limit: i64,
  ) -> RepoResult<EditCaptureRunSummary> {
    let reconciled = self.repository.reconcile(global, now, reconcile_limit).await?;
    let mut summary = self.repository.capture_due(global, now, capture_limit).await?;
    summary.reconciled = reconciled;
    self.repository.record_heartbeat(now).await?;
    info!(
      reconciled = summary.reconciled,
      examined = summary.examined,
      captured = summary.captured,
      unchanged = summary.unchanged,
      skipped = summary.skipped,
      failed = summary.failed,
      "automatic document history polling pass completed"
    );
    Ok(summary)
  }
}
