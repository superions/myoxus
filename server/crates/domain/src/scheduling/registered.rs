// SPDX-License-Identifier: AGPL-3.0-or-later
//! Closed server-owned worker destinations. Disabled registrations remain in
//! this inventory so their queued native deliveries survive timing migration.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! registered_jobs {
  ($($variant:ident => ($queue:literal,$name:literal)),+ $(,)?)=>{
    #[derive(Debug,Clone,Copy,PartialEq,Eq,PartialOrd,Ord,Hash,Serialize,Deserialize)]
    #[serde(rename_all="snake_case")]
    pub enum RegisteredJob{$($variant),+}
    impl RegisteredJob{
      pub const ALL:&'static [Self]=&[$(Self::$variant),+];
      pub fn queue(self)->&'static str{match self{$(Self::$variant=>$queue),+}}
      pub fn name(self)->&'static str{match self{$(Self::$variant=>$name),+}}
    }
  }
}

registered_jobs! {
  CleanUserSessions=>("nightly","nightly.cleanExpiredUserSessions"),
  CleanHistories=>("nightly","nightly.cleanExpiredHistories"),
  CleanNotifications=>("nightly","nightly.cleanExpiredNotifications"),
  CleanPendingBlobs=>("nightly","nightly.cleanExpiredPendingBlobs"),
  CleanOutbox=>("nightly","nightly.cleanProcessedOutboxEvents"),
  CleanMergedUpdates=>("nightly","nightly.cleanMergedDocUpdates"),
  CleanGitRepos=>("nightly","nightly.cleanStaleGitSyncRepos"),
  CleanSessionLinks=>("nightly","nightly.cleanOrphanedSessionLinks"),
  CleanOrphanedBlobs=>("nightly","nightly.cleanOrphanedBlobs"),
  CleanMultipartUploads=>("nightly","nightly.cleanStaleMultipartUploads"),
  CleanCopilotBlobs=>("nightly","nightly.cleanOrphanedCopilotBlobs"),
  ReconcileStorage=>("nightly","nightly.reconcileStorageStats"),
  CleanPdfExports=>("nightly","nightly.cleanExpiredPdfExportJobs"),
  DocumentVersionDaily=>("nightly","nightly.documentVersionDaily"),
  DocumentVersionGc=>("nightly","nightly.documentVersionGc"),
  CleanWorkspaceImports=>("nightly","nightly.cleanExpiredWorkspaceImports"),
  CleanCopilotSessions=>("copilot","copilot.session.cleanupEmptySessions"),
  GenerateCopilotTitles=>("copilot","copilot.session.generateMissingTitles"),
  CountPendingUpdates=>("doc","doc.recordPendingDocUpdatesCount"),
  FindEmptySummaries=>("doc","doc.findEmptySummaryDocs"),
  CaptureDocumentHistory=>("doc","doc.captureDueDocumentHistory"),
  ReindexDocumentGraph=>("document-graph","documentGraph.reindexWorkspaceBatch"),
  RecomputeDatabase=>("database","database.recomputeStaleProjections"),
  CaldavSync=>("caldav-sync","caldav.syncAll"),
  GoogleCalendarSync=>("google-calendar-sync","googleCalendar.syncAll"),
  GoogleChannelRenewal=>("google-calendar-sync","calendar.renewGoogleChannels"),
  IndexWorkspaces=>("indexer","indexer.autoIndexWorkspaces"),
  ReconcileTemplates=>("template-registry","template-registry.reconcileAll"),
  ScanTemplateDrift=>("template-registry","template-registry.driftScan"),
  TelemetryFlush=>("telemetry-flush","telemetry.flush"),
  TelemetryRollup=>("telemetry-flush","telemetry.rollup"),
  TelemetryRetention=>("telemetry-flush","telemetry.retention"),
  MetricsFlush=>("metrics-flush","metrics.flush"),
  MetricsRollup=>("metrics-flush","metrics.rollup"),
  MetricsRetention=>("metrics-flush","metrics.retention"),
}

impl RegisteredJob {
  pub fn schedule_id(self) -> Uuid {
    Uuid::new_v5(
      &Uuid::NAMESPACE_URL,
      format!("myoxus:registered-worker:{}:{}", self.queue(), self.name()).as_bytes(),
    )
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkerTiming {
  UtcCron { expression: String },
  Interval { every_ms: u64 },
}

/// Startup-owned configuration, not another operator-editable registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerSchedule {
  pub timing: WorkerTiming,
  pub data: serde_json::Value,
  pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct RegisteredWorker {
  pub job: RegisteredJob,
  pub schedule: WorkerSchedule,
}

impl RegisteredWorker {
  pub fn cron(job: RegisteredJob, expression: &str, data: serde_json::Value) -> Self {
    Self {
      job,
      schedule: WorkerSchedule {
        timing: WorkerTiming::UtcCron {
          expression: expression.into(),
        },
        data,
        enabled: true,
      },
    }
  }
  pub fn interval(job: RegisteredJob, every_ms: u64, data: serde_json::Value) -> Self {
    Self {
      job,
      schedule: WorkerSchedule {
        timing: WorkerTiming::Interval { every_ms },
        data,
        enabled: true,
      },
    }
  }
  pub fn with_enabled(mut self, enabled: bool) -> Self {
    self.schedule.enabled = enabled;
    self
  }
}

/// Frozen server registration and payload accepted with its future UTC slot.
/// Queue execution/retry remains native; no workflow Run is created.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisteredDispatch {
  pub schedule_id: Uuid,
  pub generation: i64,
  pub dispatch_id: Uuid,
  pub scheduled_for: chrono::DateTime<chrono::Utc>,
  pub job: RegisteredJob,
  pub data: serde_json::Value,
}

impl RegisteredDispatch {
  pub fn job_id(&self) -> String {
    format!("scheduled-worker-{}", self.dispatch_id)
  }
}
