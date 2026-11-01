// SPDX-License-Identifier: AGPL-3.0-or-later
//! Account-scoped orchestration for server-backed full-workspace imports.
//!
//! The decoder remains pure in `myoxus-workspace-import`; this module owns
//! authorization, target-id planning and the redacted preview projection.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;

use crate::auth::{AuthError, AuthResult};
use async_trait::async_trait;
use bytes::Bytes;
use chrono::{Duration, Utc};
use myoxus_domain::ids::{UserId, WorkspaceImportId};
use myoxus_domain::workspace_import::{
  WorkspaceImportCompensation, WorkspaceImportCompensationKind, WorkspaceImportIdMapping, WorkspaceImportOperation,
  WorkspaceImportPart, WorkspaceImportProgressStage, WorkspaceImportRecord, WorkspaceImportStatus,
};
use myoxus_workspace_import::{
  DecodedOmittedObjectCounts, WorkspaceDecoder, WorkspaceImportDiagnostic, WorkspaceImportDiagnosticCode,
  WorkspaceImportDiagnosticSeverity, WorkspaceImportFormat, WorkspaceImportLimits, extract_database_blocks,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::database::{
  DatabaseImportExportService, LegacyDatabaseDocumentSource, LegacyDatabaseMigrationPlan,
  plan_fresh_workspace_legacy_database_migration,
};
use crate::doc::{DocService, DocSpaceKind};
use crate::mime_policy::detect_mime;
use crate::organizer::{CreateOrganizerFolder, CreateOrganizerLink, OrganizerLinkType, OrganizerService};
use crate::ports::blob_service::BlobService;
use crate::ports::{BlobStoragePort, BlobWriteRequest};
use crate::worker::WorkQueuePort;
use crate::workspace::WorkspaceStore;
use crate::{metrics::MetricsCategory, metrics::MetricsService};

mod obsidian;
pub use obsidian::{
  ObsidianVaultPlan, VaultAssetPlan, VaultClassification, VaultDocumentPlan, VaultFolderPlan, VaultPreservation,
};

pub const WORKSPACE_IMPORT_QUEUE: &str = "workspace-import";
pub const WORKSPACE_IMPORT_JOB: &str = "workspaceImport.execute";
pub const WORKSPACE_IMPORT_PART_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceImportPolicy {
  pub limits: WorkspaceImportLimits,
  pub staging_retention_hours: u64,
  pub job_timeout_seconds: u64,
}

impl WorkspaceImportPolicy {
  /// Content-free fingerprint bound to a staged import. A policy change makes
  /// an unfinished preview stale instead of applying under different limits.
  pub fn fingerprint(self) -> String {
    let limits = self.limits;
    let material = format!(
      "{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
      limits.max_upload_bytes,
      limits.max_expanded_bytes,
      limits.max_archive_entries,
      limits.max_entry_bytes,
      limits.max_compression_ratio,
      limits.max_sqlite_bytes,
      limits.max_document_bytes,
      limits.max_documents,
      limits.max_blocks,
      limits.max_databases,
      limits.max_fields_per_database,
      limits.max_views_per_database,
      limits.max_rows_per_database,
      limits.max_cells_per_database,
      limits.max_assets,
      limits.max_asset_bytes,
      self.staging_retention_hours,
      self.job_timeout_seconds,
    );
    // Conversion semantics are part of the confirmation contract, not just
    // resource limits. Old previews must not apply under the new native mapping.
    let material = format!("native-parent-local-footnotes-2026-10-02-tight-containers:{material}");
    format!("{:x}", Sha256::digest(material.as_bytes()))
  }
}

#[async_trait]
pub trait WorkspaceImportPolicyProvider: Send + Sync {
  async fn current_policy(&self) -> WorkspaceImportPolicy;
}

/// Durable persistence boundary for the import aggregate.
///
/// The repository owns compare-and-transition semantics. Product writes remain
/// behind their existing Workspace, Document, Database and Blob services.
#[async_trait]
pub trait WorkspaceImportRepository: Send + Sync {
  async fn create(&self, record: WorkspaceImportRecord) -> AuthResult<WorkspaceImportRecord>;
  async fn get(&self, import_id: WorkspaceImportId) -> AuthResult<Option<WorkspaceImportRecord>>;
  async fn get_for_actor(
    &self,
    import_id: WorkspaceImportId,
    actor_id: UserId,
  ) -> AuthResult<Option<WorkspaceImportRecord>>;
  async fn upsert_part(&self, actor_id: UserId, part: WorkspaceImportPart) -> AuthResult<WorkspaceImportPart>;
  async fn list_parts(&self, import_id: WorkspaceImportId) -> AuthResult<Vec<WorkspaceImportPart>>;
  async fn complete_upload(
    &self,
    import_id: WorkspaceImportId,
    actor_id: UserId,
    source_size_bytes: i64,
    source_hash: &str,
  ) -> AuthResult<WorkspaceImportRecord>;
  /// Queue exactly one operation. The boolean is true only when a Redis job
  /// must be emitted by the caller.
  async fn queue_operation(
    &self,
    import_id: WorkspaceImportId,
    actor_id: Option<UserId>,
    operation: WorkspaceImportOperation,
  ) -> AuthResult<(WorkspaceImportRecord, bool)>;
  /// Restore the durable pre-queue state if Redis rejects the enqueue. This
  /// prevents an operation from becoming permanently `queued` without a job.
  async fn restore_after_enqueue_failure(
    &self,
    import_id: WorkspaceImportId,
    operation: WorkspaceImportOperation,
  ) -> AuthResult<()>;
  async fn claim_operation(
    &self,
    import_id: WorkspaceImportId,
    operation: WorkspaceImportOperation,
  ) -> AuthResult<WorkspaceImportRecord>;
  /// Reset aggregate progress before replaying an already-running queue
  /// attempt. Product compensation must complete before an apply replay.
  async fn prepare_operation_replay(
    &self,
    import_id: WorkspaceImportId,
    operation: WorkspaceImportOperation,
  ) -> AuthResult<()>;
  async fn store_preview(
    &self,
    import_id: WorkspaceImportId,
    preview: serde_json::Value,
  ) -> AuthResult<WorkspaceImportRecord>;
  async fn mark_succeeded(
    &self,
    import_id: WorkspaceImportId,
    workspace_id: myoxus_domain::ids::WorkspaceId,
    tags: &[myoxus_domain::workspace_tags::WorkspaceTag],
    assignments: &[(Uuid, Vec<Uuid>)],
  ) -> AuthResult<WorkspaceImportRecord>;
  async fn mark_failed(
    &self,
    import_id: WorkspaceImportId,
    error_code: &str,
    error_message: &str,
    cleanup_required: bool,
  ) -> AuthResult<WorkspaceImportRecord>;
  async fn request_cancel(&self, import_id: WorkspaceImportId, actor_id: UserId) -> AuthResult<WorkspaceImportRecord>;
  async fn mark_cancelled(&self, import_id: WorkspaceImportId) -> AuthResult<WorkspaceImportRecord>;
  /// Complete operator recovery without retaining a cleanup-required state.
  async fn complete_cleanup(&self, import_id: WorkspaceImportId) -> AuthResult<WorkspaceImportRecord>;
  async fn update_progress(
    &self,
    import_id: WorkspaceImportId,
    stage: WorkspaceImportProgressStage,
    current: i64,
    total: i64,
  ) -> AuthResult<()>;
  async fn upsert_id_mappings(&self, mappings: &[WorkspaceImportIdMapping]) -> AuthResult<()>;
  async fn list_id_mappings(&self, import_id: WorkspaceImportId) -> AuthResult<Vec<WorkspaceImportIdMapping>>;
  async fn append_compensation(
    &self,
    import_id: WorkspaceImportId,
    sequence: i64,
    kind: WorkspaceImportCompensationKind,
    target_id: &str,
  ) -> AuthResult<WorkspaceImportCompensation>;
  async fn pending_compensations(&self, import_id: WorkspaceImportId) -> AuthResult<Vec<WorkspaceImportCompensation>>;
  async fn complete_compensation(&self, compensation_id: i64) -> AuthResult<()>;
  async fn fail_compensation(&self, compensation_id: i64, redacted_error: &str) -> AuthResult<()>;
  /// Current operator-actionable cleanup backlog. This excludes ordinary
  /// failed/expired imports that retention can purge automatically.
  async fn cleanup_required_count(&self) -> AuthResult<i64>;
  /// Atomically expire safe terminal/staged records and include expired records
  /// whose durable staging metadata still requires deletion.
  async fn claim_retention_candidates(
    &self,
    terminal_before: chrono::DateTime<Utc>,
    limit: i64,
  ) -> AuthResult<Vec<WorkspaceImportRecord>>;
  /// Remove import-only artifacts after protected object deletion succeeds.
  async fn purge_retained_artifacts(&self, import_id: WorkspaceImportId) -> AuthResult<()>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportObjectCounts {
  pub documents: usize,
  pub assets: usize,
  pub databases: usize,
  pub fields: usize,
  pub rows: usize,
  pub cells: usize,
  pub views: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportTargetPlan {
  pub workspace_id: Uuid,
  pub document_ids: Vec<Uuid>,
  pub asset_ids: Vec<Uuid>,
  pub database_ids: Vec<Uuid>,
  #[serde(default)]
  pub tag_ids: Vec<Uuid>,
  #[serde(default)]
  pub vault: Option<ObsidianVaultPlan>,
}

/// Redacted preview projection. Raw document updates, archive names, SQLite
/// rows, asset bytes and cell values are intentionally absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportPreview {
  pub import_id: WorkspaceImportId,
  pub detected_format: WorkspaceImportFormat,
  /// Source root interpretation selected for this immutable preview.
  pub source_root: String,
  pub proposed_workspace_title: String,
  pub counts: WorkspaceImportObjectCounts,
  pub omitted_counts: DecodedOmittedObjectCounts,
  pub target_plan: WorkspaceImportTargetPlan,
  pub diagnostics: Vec<WorkspaceImportDiagnostic>,
  pub source_hash: String,
  pub config_fingerprint: String,
  /// Fingerprint of the immutable source, selected format, conversion policy
  /// and deterministic target plan accepted by Apply.
  #[serde(default)]
  pub plan_fingerprint: String,
  pub apply_allowed: bool,
}

#[derive(Debug, Clone)]
pub struct WorkspaceImportPreviewService {
  limits: WorkspaceImportLimits,
}

impl WorkspaceImportPreviewService {
  pub const fn new(limits: WorkspaceImportLimits) -> Self {
    Self { limits }
  }

  /// Fully decode and plan one staged import without creating any product
  /// entity. Actor and immutable source/config fingerprints are checked before
  /// the staged path is opened.
  pub fn preview_staged(
    &self,
    actor: UserId,
    record: &WorkspaceImportRecord,
    staged_path: impl AsRef<Path>,
  ) -> Result<WorkspaceImportPreview, WorkspaceImportDiagnostic> {
    if record.actor_id != actor {
      return Err(blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportPermissionDenied,
        "workspace import is owned by another account",
      ));
    }
    if record.expires_at <= Utc::now() || record.status == WorkspaceImportStatus::Expired {
      return Err(blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportExpired,
        "workspace import staging record has expired",
      ));
    }
    let is_staged = record.status == WorkspaceImportStatus::Staged;
    let is_preview_worker = record.status == WorkspaceImportStatus::Running
      && record.queued_operation == Some(WorkspaceImportOperation::Preview);
    if !is_staged && !is_preview_worker {
      return Err(blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportApplyBlocked,
        "workspace import is not in the staged state",
      ));
    }
    if record.source_hash.trim().is_empty() || record.config_fingerprint.trim().is_empty() {
      return Err(blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportApplyBlocked,
        "workspace import staging fingerprints are incomplete",
      ));
    }

    let selected_format = selected_format(record).map_err(|_| {
      blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported,
        "workspace import selected format is invalid",
      )
    })?;
    let decoded = WorkspaceDecoder::new(self.limits).decode_path_as(staged_path, selected_format)?;
    let database_sources = decoded
      .documents
      .iter()
      .map(|document| {
        extract_database_blocks(document).map(|blocks| LegacyDatabaseDocumentSource {
          source_document_id: document.source_id.clone(),
          blocks,
        })
      })
      .collect::<Result<Vec<_>, _>>()?;
    let database_plan = plan_fresh_workspace_legacy_database_migration(record.id, &database_sources, self.limits);
    Ok(build_preview(record, decoded, database_plan))
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportUpload {
  pub import_id: WorkspaceImportId,
  pub part_size_bytes: usize,
  pub max_part_count: usize,
  pub expires_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportWorkerEnvelope {
  pub import_id: WorkspaceImportId,
  pub actor_id: UserId,
  pub operation: WorkspaceImportOperation,
}

/// Durable orchestration for upload, preview, apply, cancellation and cleanup.
#[derive(Clone)]
pub struct WorkspaceImportService {
  repository: Arc<dyn WorkspaceImportRepository>,
  staging: Arc<dyn BlobStoragePort>,
  blobs: Arc<BlobService>,
  workspaces: Arc<dyn WorkspaceStore>,
  documents: DocService,
  databases: Arc<DatabaseImportExportService>,
  queue: Arc<dyn WorkQueuePort>,
  policy: Arc<dyn WorkspaceImportPolicyProvider>,
  metrics: Arc<std::sync::RwLock<Option<Arc<MetricsService>>>>,
}

impl WorkspaceImportService {
  #[allow(clippy::too_many_arguments)]
  pub fn new(
    repository: Arc<dyn WorkspaceImportRepository>,
    staging: Arc<dyn BlobStoragePort>,
    blobs: Arc<BlobService>,
    workspaces: Arc<dyn WorkspaceStore>,
    documents: DocService,
    databases: Arc<DatabaseImportExportService>,
    queue: Arc<dyn WorkQueuePort>,
    policy: Arc<dyn WorkspaceImportPolicyProvider>,
  ) -> Self {
    Self {
      repository,
      staging,
      blobs,
      workspaces,
      documents,
      databases,
      queue,
      policy,
      metrics: Arc::new(std::sync::RwLock::new(None)),
    }
  }

  pub fn set_metrics_service(&self, metrics: Arc<MetricsService>) {
    if let Ok(mut slot) = self.metrics.write() {
      *slot = Some(metrics);
    }
  }

  fn record_metric(&self, name: &str, labels: &[(&str, &str)], delta: f64) {
    let metrics = self.metrics.read().ok().and_then(|slot| slot.clone());
    let Some(metrics) = metrics else {
      return;
    };
    let mut values = JsonMap::with_capacity(labels.len());
    for (key, value) in labels {
      values.insert((*key).to_string(), Value::String((*value).to_string()));
    }
    metrics.record_with(MetricsCategory::Workspace, name, values, delta);
  }

  /// Record queue observations supplied by the existing BullMQ worker. Labels
  /// are bounded enums only; import ids and filenames are deliberately absent.
  pub fn record_worker_observation(
    &self,
    operation: WorkspaceImportOperation,
    status: Option<WorkspaceImportStatus>,
    duration_ms: f64,
    queue_latency_ms: f64,
    retried: bool,
  ) {
    let operation = operation.as_str();
    self.record_metric(
      "workspace_import_operation_duration_ms_sum",
      &[("operation", operation)],
      duration_ms,
    );
    self.record_metric(
      "workspace_import_operation_duration_ms_count",
      &[("operation", operation)],
      1.0,
    );
    self.record_metric(
      "workspace_import_queue_latency_ms_sum",
      &[("operation", operation)],
      queue_latency_ms.max(0.0),
    );
    self.record_metric(
      "workspace_import_queue_latency_ms_count",
      &[("operation", operation)],
      1.0,
    );
    if retried {
      self.record_metric("workspace_import_retries_total", &[("operation", operation)], 1.0);
    }
    if let Some(status) = status.filter(|status| {
      matches!(
        status,
        WorkspaceImportStatus::Succeeded
          | WorkspaceImportStatus::Failed
          | WorkspaceImportStatus::Cancelled
          | WorkspaceImportStatus::CleanupRequired
          | WorkspaceImportStatus::Expired
      )
    }) {
      self.record_metric(
        "workspace_import_jobs_terminal_total",
        &[("operation", operation), ("status", status.as_str())],
        1.0,
      );
      if status == WorkspaceImportStatus::CleanupRequired {
        self.record_metric("workspace_import_cleanup_required_total", &[], 1.0);
      }
    }
  }

  pub async fn current_policy(&self) -> WorkspaceImportPolicy {
    self.policy.current_policy().await
  }

  #[tracing::instrument(skip(self), fields(%actor_id))]
  pub async fn create_upload(&self, actor_id: UserId) -> AuthResult<WorkspaceImportUpload> {
    self.create_upload_as(actor_id, None).await
  }

  pub async fn create_upload_as(
    &self,
    actor_id: UserId,
    selected_format: Option<WorkspaceImportFormat>,
  ) -> AuthResult<WorkspaceImportUpload> {
    if selected_format.is_some_and(|format| format != WorkspaceImportFormat::ObsidianZip) {
      return Err(AuthError::InvalidInput(
        "explicit workspace import format is unsupported".to_string(),
      ));
    }
    let now = Utc::now();
    let policy = self.current_policy().await;
    let import_id = Uuid::new_v4();
    let retention_hours = i64::try_from(policy.staging_retention_hours).unwrap_or(i64::MAX);
    let expires_at = now + Duration::hours(retention_hours.max(1));
    self
      .repository
      .create(WorkspaceImportRecord {
        id: import_id,
        actor_id,
        status: WorkspaceImportStatus::Staged,
        selected_format: selected_format.map(format_name).unwrap_or("auto").to_string(),
        staging_object_key: format!("workspace-import/{actor_id}/{import_id}"),
        source_hash: String::new(),
        source_size_bytes: 0,
        config_fingerprint: policy.fingerprint(),
        preview: None,
        target_workspace_id: None,
        queued_operation: None,
        progress_stage: None,
        progress_current: 0,
        progress_total: 0,
        cancel_requested: false,
        error_code: None,
        error_message: None,
        created_at: now,
        updated_at: now,
        expires_at,
      })
      .await?;
    Ok(WorkspaceImportUpload {
      import_id,
      part_size_bytes: WORKSPACE_IMPORT_PART_BYTES,
      max_part_count: usize::try_from(policy.limits.max_upload_bytes)
        .unwrap_or(usize::MAX)
        .div_ceil(WORKSPACE_IMPORT_PART_BYTES),
      expires_at,
    })
  }

  /// Persist one bounded, authenticated upload part. HTTP signature validation
  /// occurs before this method; account ownership is checked again here.
  #[tracing::instrument(skip(self, body), fields(%actor_id, %import_id, part_number, size = body.len()))]
  pub async fn upload_part(
    &self,
    actor_id: UserId,
    import_id: WorkspaceImportId,
    part_number: i32,
    declared_hash: &str,
    body: Bytes,
  ) -> AuthResult<WorkspaceImportPart> {
    if part_number < 1 || body.is_empty() || body.len() > WORKSPACE_IMPORT_PART_BYTES {
      return Err(AuthError::InvalidInput(
        "workspace import part size or number is invalid".to_string(),
      ));
    }
    let record = self
      .repository
      .get_for_actor(import_id, actor_id)
      .await?
      .ok_or(AuthError::ActionForbidden)?;
    let policy = self.policy_for(&record).await?;
    if record.status != WorkspaceImportStatus::Staged || record.expires_at <= Utc::now() {
      return Err(AuthError::InvalidInput(
        "workspace import is not accepting upload parts".to_string(),
      ));
    }
    if body.len() as u64 > policy.limits.max_upload_bytes {
      return Err(AuthError::InvalidInput(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportUploadLimit
          .as_str()
          .to_string(),
      ));
    }
    let content_hash = format!("{:x}", Sha256::digest(&body));
    if content_hash != declared_hash {
      return Err(AuthError::InvalidInput(
        "workspace import part hash does not match".to_string(),
      ));
    }
    let object_key = format!("{}/parts/{part_number}", record.staging_object_key);
    self
      .staging
      .write_blob(BlobWriteRequest {
        key: object_key.clone(),
        content_type: Some("application/octet-stream".to_string()),
        body: body.clone(),
      })
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    self
      .repository
      .upsert_part(
        actor_id,
        WorkspaceImportPart {
          import_id,
          part_number,
          object_key,
          size_bytes: body.len() as i64,
          content_hash,
          created_at: Utc::now(),
        },
      )
      .await
  }

  #[tracing::instrument(skip(self), fields(%actor_id, %import_id, expected_size_bytes))]
  pub async fn complete_upload(
    &self,
    actor_id: UserId,
    import_id: WorkspaceImportId,
    expected_size_bytes: i64,
    expected_hash: &str,
  ) -> AuthResult<WorkspaceImportRecord> {
    let record = self
      .repository
      .get_for_actor(import_id, actor_id)
      .await?
      .ok_or(AuthError::ActionForbidden)?;
    let policy = self.policy_for(&record).await?;
    if expected_size_bytes <= 0 || expected_size_bytes as u64 > policy.limits.max_upload_bytes {
      return Err(AuthError::InvalidInput(
        "workspace import upload exceeds the configured limit".to_string(),
      ));
    }
    if record.status != WorkspaceImportStatus::Staged {
      return Err(AuthError::InvalidInput(
        "workspace import upload is not staged".to_string(),
      ));
    }
    let parts = self.repository.list_parts(import_id).await?;
    if parts.is_empty()
      || parts
        .iter()
        .enumerate()
        .any(|(index, part)| part.part_number != index as i32 + 1)
    {
      return Err(AuthError::InvalidInput(
        "workspace import upload parts are not contiguous".to_string(),
      ));
    }
    let mut hasher = Sha256::new();
    let mut size = 0_i64;
    for part in &parts {
      let response = self
        .staging
        .read_blob(&part.object_key)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?;
      if response.data.len() as i64 != part.size_bytes
        || format!("{:x}", Sha256::digest(&response.data)) != part.content_hash
      {
        return Err(AuthError::InvalidInput(
          "workspace import staged part verification failed".to_string(),
        ));
      }
      size = size
        .checked_add(part.size_bytes)
        .ok_or_else(|| AuthError::InvalidInput("workspace import size overflow".to_string()))?;
      hasher.update(&response.data);
    }
    if size != expected_size_bytes || format!("{:x}", hasher.finalize()) != expected_hash {
      return Err(AuthError::InvalidInput(
        "workspace import whole-file fingerprint does not match".to_string(),
      ));
    }
    let record = self
      .repository
      .complete_upload(import_id, actor_id, size, expected_hash)
      .await?;
    self.record_metric("workspace_import_staged_bytes_total", &[], size as f64);
    Ok(record)
  }

  pub async fn status(&self, actor_id: UserId, import_id: WorkspaceImportId) -> AuthResult<WorkspaceImportRecord> {
    self
      .repository
      .get_for_actor(import_id, actor_id)
      .await?
      .ok_or(AuthError::ActionForbidden)
  }

  /// Privileged local-operator lookup used by `myoxus-cli`. Account-scoped API
  /// callers must use [`Self::status`] so ownership remains enforced.
  pub async fn operator_status(&self, import_id: WorkspaceImportId) -> AuthResult<WorkspaceImportRecord> {
    self
      .repository
      .get(import_id)
      .await?
      .ok_or_else(|| AuthError::NotFound("workspace import".to_string()))
  }

  pub async fn queue_preview(
    &self,
    actor_id: UserId,
    import_id: WorkspaceImportId,
  ) -> AuthResult<WorkspaceImportRecord> {
    let record = self.status(actor_id, import_id).await?;
    self.policy_for(&record).await?;
    self
      .queue_operation(import_id, Some(actor_id), WorkspaceImportOperation::Preview)
      .await
  }

  pub async fn queue_apply(&self, actor_id: UserId, import_id: WorkspaceImportId) -> AuthResult<WorkspaceImportRecord> {
    let record = self.status(actor_id, import_id).await?;
    self.policy_for(&record).await?;
    self
      .queue_operation(import_id, Some(actor_id), WorkspaceImportOperation::Apply)
      .await
  }

  pub async fn retry_cleanup(&self, import_id: WorkspaceImportId) -> AuthResult<WorkspaceImportRecord> {
    self
      .queue_operation(import_id, None, WorkspaceImportOperation::Cleanup)
      .await
  }

  async fn queue_operation(
    &self,
    import_id: WorkspaceImportId,
    actor_id: Option<UserId>,
    operation: WorkspaceImportOperation,
  ) -> AuthResult<WorkspaceImportRecord> {
    let (record, should_enqueue) = self.repository.queue_operation(import_id, actor_id, operation).await?;
    if should_enqueue
      && let Err(error) = self
        .queue
        .add_job(
          WORKSPACE_IMPORT_QUEUE,
          WORKSPACE_IMPORT_JOB,
          serde_json::to_value(WorkspaceImportWorkerEnvelope {
            import_id,
            actor_id: record.actor_id,
            operation,
          })
          .map_err(|error| AuthError::Storage(error.to_string()))?,
          Some(3),
          None,
        )
        .await
    {
      self
        .repository
        .restore_after_enqueue_failure(import_id, operation)
        .await?;
      return Err(error);
    }
    Ok(record)
  }

  pub async fn cancel(&self, actor_id: UserId, import_id: WorkspaceImportId) -> AuthResult<WorkspaceImportRecord> {
    let record = self.repository.request_cancel(import_id, actor_id).await?;
    self.record_metric("workspace_import_cancellations_total", &[], 1.0);
    Ok(record)
  }

  /// Worker entry point. Redis carries only the envelope; all source and
  /// transition state is reloaded from the durable aggregate.
  #[tracing::instrument(skip(self), fields(import_id = %envelope.import_id, actor_id = %envelope.actor_id, operation = envelope.operation.as_str()))]
  pub async fn run_worker_operation(
    &self,
    envelope: WorkspaceImportWorkerEnvelope,
  ) -> AuthResult<WorkspaceImportRecord> {
    let record = self
      .repository
      .claim_operation(envelope.import_id, envelope.operation)
      .await?;
    if record.actor_id != envelope.actor_id {
      return Err(AuthError::ActionForbidden);
    }
    if matches!(
      (envelope.operation, record.status),
      (WorkspaceImportOperation::Preview, WorkspaceImportStatus::Previewed)
        | (WorkspaceImportOperation::Apply, WorkspaceImportStatus::Succeeded)
        | (WorkspaceImportOperation::Cleanup, WorkspaceImportStatus::Failed)
        | (_, WorkspaceImportStatus::Cancelled)
    ) {
      return Ok(record);
    }
    let replaying = record.progress_stage.is_some();
    // A worker may be retried after its process died mid-apply. Every product
    // write is preceded by a durable compensation entry, so clear that partial
    // hidden target before replaying the immutable id plan.
    if replaying {
      if envelope.operation == WorkspaceImportOperation::Apply
        && !self.repository.pending_compensations(record.id).await?.is_empty()
        && !self.compensate(record.id).await
      {
        return self
          .repository
          .mark_failed(
            record.id,
            WorkspaceImportDiagnosticCode::MixWorkspaceImportCleanupRequired.as_str(),
            "workspace import compensation requires operator recovery",
            true,
          )
          .await;
      }
      self
        .repository
        .prepare_operation_replay(record.id, envelope.operation)
        .await?;
    }
    let result = match envelope.operation {
      WorkspaceImportOperation::Preview => self.run_preview(record.clone()).await,
      WorkspaceImportOperation::Apply => self.run_apply(record.clone()).await,
      WorkspaceImportOperation::Cleanup => self.run_cleanup(record.clone()).await,
    };
    match result {
      Ok(record) => Ok(record),
      Err(error) => {
        let latest = self
          .repository
          .get(record.id)
          .await?
          .ok_or_else(|| AuthError::NotFound("workspace import".to_string()))?;
        let cancelled = latest.cancel_requested;
        if matches!(error, AuthError::Storage(_)) && !cancelled {
          tracing::warn!(import_id = %record.id, error = %error, "workspace import worker operation will retry");
          return Err(error);
        }
        let cleanup_ok = if envelope.operation == WorkspaceImportOperation::Apply {
          self.compensate(record.id).await
        } else {
          true
        };
        if cancelled && cleanup_ok {
          return self.repository.mark_cancelled(record.id).await;
        }
        let code = if cleanup_ok {
          WorkspaceImportDiagnosticCode::MixWorkspaceImportApplyBlocked.as_str()
        } else {
          WorkspaceImportDiagnosticCode::MixWorkspaceImportCleanupRequired.as_str()
        };
        let message = if cleanup_ok {
          "workspace import operation failed"
        } else {
          "workspace import compensation requires operator recovery"
        };
        let failed = self
          .repository
          .mark_failed(record.id, code, message, !cleanup_ok)
          .await?;
        tracing::warn!(import_id = %record.id, error = %error, cleanup_ok, "workspace import worker operation failed");
        Ok(failed)
      }
    }
  }

  /// Finalize a retryable worker failure after the queue exhausts its attempt
  /// budget. This keeps the durable import aggregate out of `running` and uses
  /// the same compensation path as a deterministic apply failure.
  pub async fn finalize_retry_exhaustion(&self, import_id: WorkspaceImportId) -> AuthResult<WorkspaceImportRecord> {
    let latest = self
      .repository
      .get(import_id)
      .await?
      .ok_or_else(|| AuthError::NotFound("workspace import".to_string()))?;
    let cleanup_ok = self.compensate(import_id).await;
    if latest.cancel_requested && cleanup_ok {
      return self.repository.mark_cancelled(import_id).await;
    }
    self
      .repository
      .mark_failed(
        import_id,
        if cleanup_ok {
          WorkspaceImportDiagnosticCode::MixWorkspaceImportApplyBlocked.as_str()
        } else {
          WorkspaceImportDiagnosticCode::MixWorkspaceImportCleanupRequired.as_str()
        },
        if cleanup_ok {
          "workspace import retry budget exhausted"
        } else {
          "workspace import compensation requires operator recovery"
        },
        !cleanup_ok,
      )
      .await
  }

  #[tracing::instrument(skip(self, record), fields(import_id = %record.id, actor_id = %record.actor_id))]
  async fn run_preview(&self, record: WorkspaceImportRecord) -> AuthResult<WorkspaceImportRecord> {
    let policy = self.policy_for_record(record.id).await?;
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::Validation, 0, 1)
      .await?;
    let staged = self.materialize_staged_file(record.id).await?;
    let preview =
      match WorkspaceImportPreviewService::new(policy.limits).preview_staged(record.actor_id, &record, staged.path()) {
        Ok(preview) => preview,
        Err(diagnostic) => {
          return self
            .repository
            .mark_failed(record.id, diagnostic.code.as_str(), &diagnostic.message, false)
            .await;
        }
      };
    let blocking = preview
      .diagnostics
      .iter()
      .filter(|diagnostic| diagnostic.severity == WorkspaceImportDiagnosticSeverity::Blocking)
      .count();
    if blocking > 0 {
      self.record_metric("workspace_import_blocking_diagnostics_total", &[], blocking as f64);
    }
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::DatabasePlanning, 1, 1)
      .await?;
    let preview = serde_json::to_value(preview).map_err(|error| AuthError::Storage(error.to_string()))?;
    self.repository.store_preview(record.id, preview).await
  }

  #[tracing::instrument(skip(self, record), fields(import_id = %record.id, actor_id = %record.actor_id))]
  async fn run_apply(&self, record: WorkspaceImportRecord) -> AuthResult<WorkspaceImportRecord> {
    let policy = self.policy_for_record(record.id).await?;
    self.ensure_not_cancelled(record.id).await?;
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::Validation, 0, 1)
      .await?;
    let staged = self.materialize_staged_file(record.id).await?;
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::Validation, 1, 1)
      .await?;
    let decoder = WorkspaceDecoder::new(policy.limits);
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::DocumentDecode, 0, 1)
      .await?;
    let decoded = match decoder.decode_path_as(staged.path(), selected_format(&record)?) {
      Ok(decoded) => decoded,
      Err(diagnostic) => {
        return self
          .repository
          .mark_failed(record.id, diagnostic.code.as_str(), &diagnostic.message, false)
          .await;
      }
    };
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::DocumentDecode, 1, 1)
      .await?;
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::AssetPlanning, 0, 1)
      .await?;
    let database_sources = match decoded
      .documents
      .iter()
      .map(|document| {
        extract_database_blocks(document).map(|blocks| LegacyDatabaseDocumentSource {
          source_document_id: document.source_id.clone(),
          blocks,
        })
      })
      .collect::<Result<Vec<_>, _>>()
    {
      Ok(database_sources) => database_sources,
      Err(diagnostic) => {
        return self
          .repository
          .mark_failed(record.id, diagnostic.code.as_str(), &diagnostic.message, false)
          .await;
      }
    };
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::AssetPlanning, 1, 1)
      .await?;
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::DatabasePlanning, 0, 1)
      .await?;
    let database_plan = plan_fresh_workspace_legacy_database_migration(record.id, &database_sources, policy.limits);
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::DatabasePlanning, 1, 1)
      .await?;
    let preview = build_preview(&record, decoded.clone(), database_plan.clone());
    let stored_preview = record
      .preview
      .as_ref()
      .ok_or_else(|| AuthError::InvalidInput("workspace import has no durable preview".to_string()))?;
    let expected_target_plan =
      serde_json::to_value(&preview.target_plan).map_err(|error| AuthError::Storage(error.to_string()))?;
    if !preview.apply_allowed
      || stored_preview.get("sourceHash") != Some(&Value::String(record.source_hash.clone()))
      || stored_preview.get("configFingerprint") != Some(&Value::String(record.config_fingerprint.clone()))
      || stored_preview.get("planFingerprint") != Some(&Value::String(preview.plan_fingerprint.clone()))
      || stored_preview.get("targetPlan") != Some(&expected_target_plan)
    {
      return Err(AuthError::InvalidInput(
        "workspace import preview is stale or blocks apply".to_string(),
      ));
    }

    let mappings = build_id_mappings(record.id, &decoded, &database_plan, &preview.target_plan);
    self.repository.upsert_id_mappings(&mappings).await?;
    let workspace_id = preview.target_plan.workspace_id;
    let vault_plan = preview.target_plan.vault.as_ref();
    let label_plan = crate::workspace_tags::transfer::plan_import(
      record.id,
      workspace_id,
      record.actor_id,
      vault_plan.map_or(decoded.workspace_tags.as_slice(), |plan| plan.labels.as_slice()),
      vault_plan.map_or_else(
        || {
          decoded
            .documents
            .iter()
            .map(|document| &document.tags)
            .collect::<Vec<_>>()
        },
        |plan| plan.documents.iter().map(|document| &document.tags).collect(),
      ),
    )
    .map_err(diagnostic_error)?;
    let label_assignments = decoded
      .documents
      .iter()
      .map(|document| {
        let tags = vault_plan
          .and_then(|plan| {
            plan
              .documents
              .iter()
              .find(|planned| planned.source_path == document.source_id)
          })
          .map_or(document.tags.as_slice(), |planned| planned.tags.as_slice());
        (
          target_id(record.id, "document", &document.source_id),
          tags.iter().map(|id| label_plan.mappings[id]).collect::<Vec<_>>(),
        )
      })
      .collect::<Vec<_>>();
    self
      .repository
      .append_compensation(
        record.id,
        0,
        WorkspaceImportCompensationKind::Workspace,
        &workspace_id.to_string(),
      )
      .await?;
    let target_creation_total = preview.target_plan.asset_ids.len() as i64 + 1;
    self
      .repository
      .update_progress(
        record.id,
        WorkspaceImportProgressStage::TargetCreation,
        0,
        target_creation_total,
      )
      .await?;
    let mut workspace_name = crate::workspace::WorkspaceName::parse(&preview.proposed_workspace_title)
      .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
    // Import creates a new workspace even when another vault proposed the same
    // title. Keep the accepted suffix for the workspace root below as well.
    let mut name_attempts = 0;
    loop {
      name_attempts += 1;
      if name_attempts > crate::workspace::MAX_WORKSPACE_NAME_SUFFIX {
        return Err(AuthError::InvalidInput(
          "workspace name suffix space is exhausted".to_string(),
        ));
      }
      match self
        .workspaces
        .create_importing_workspace(record.id, record.actor_id, workspace_id, workspace_name.clone())
        .await
      {
        Err(AuthError::WorkspaceNameConflict { suggestion }) => {
          workspace_name = crate::workspace::WorkspaceName::parse(&suggestion)
            .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
        }
        Ok(workspace) => {
          workspace_name = crate::workspace::WorkspaceName::parse(&workspace.name)
            .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
          break;
        }
        Err(error) => return Err(error),
      }
    }
    self
      .repository
      .update_progress(
        record.id,
        WorkspaceImportProgressStage::TargetCreation,
        1,
        target_creation_total,
      )
      .await?;
    self.ensure_not_cancelled(record.id).await?;

    let mut asset_keys = HashMap::new();
    let mut uploaded_asset_keys = HashSet::new();
    let mut created_assets = 0_i64;
    for (index, asset) in decoded.assets.iter().enumerate() {
      let target_asset_id = vault_plan
        .and_then(|plan| {
          plan
            .assets
            .iter()
            .find(|planned| planned.source_path == asset.source_key)
        })
        .map_or_else(
          || target_id(record.id, "asset", &asset.source_key),
          |planned| planned.target_asset_id,
        );
      let blob_key = target_asset_id.to_string();
      let mut temp = tempfile::NamedTempFile::new().map_err(|error| AuthError::Storage(error.to_string()))?;
      let copied = decoder
        .copy_asset_to_as(staged.path(), &asset.source_key, selected_format(&record)?, &mut temp)
        .map_err(diagnostic_error)?;
      temp.flush().map_err(|error| AuthError::Storage(error.to_string()))?;
      let copied_hash = hash_file(temp.path())?;
      if copied != asset.size_bytes || copied_hash != asset.content_hash {
        return Err(AuthError::InvalidInput(
          "workspace import asset fingerprint changed after preview".to_string(),
        ));
      }
      if uploaded_asset_keys.insert(blob_key.clone()) {
        self
          .repository
          .append_compensation(
            record.id,
            1_000 + index as i64,
            WorkspaceImportCompensationKind::Asset,
            &format!("{workspace_id}:{blob_key}"),
          )
          .await?;
        let mut header = [0_u8; 8 * 1024];
        let header_size = std::fs::File::open(temp.path())
          .and_then(|mut file| file.read(&mut header))
          .map_err(|error| AuthError::Storage(error.to_string()))?;
        let mime = detect_mime(&header[..header_size], &asset.source_key, "").effective_mime;
        self
          .blobs
          .upload_blob_from_path(
            workspace_id,
            &blob_key,
            temp.path().to_path_buf(),
            copied,
            &mime,
            Some(&copied_hash),
          )
          .await?;
        created_assets += 1;
      }
      for alias in myoxus_workspace_import::asset_aliases(&asset.source_key) {
        asset_keys.insert(alias, blob_key.clone());
      }
      self
        .repository
        .update_progress(
          record.id,
          WorkspaceImportProgressStage::TargetCreation,
          created_assets + 1,
          target_creation_total,
        )
        .await?;
      self.ensure_not_cancelled(record.id).await?;
    }
    if let Some(plan) = vault_plan {
      for (index, document) in decoded.documents.iter().enumerate() {
        let Some(planned) = plan
          .documents
          .iter()
          .find(|planned| planned.source_path == document.source_id)
        else {
          return Err(AuthError::Storage("Obsidian document plan is incomplete".to_string()));
        };
        let Some(recovery_id) = planned.recovery_source_asset_id else {
          continue;
        };
        let myoxus_workspace_import::DecodedDocumentContent::MarkdownUtf8(bytes) = &document.content else {
          return Err(AuthError::Storage(
            "Obsidian recovery source is not Markdown".to_string(),
          ));
        };
        let blob_key = recovery_id.to_string();
        self
          .repository
          .append_compensation(
            record.id,
            10_000 + index as i64,
            WorkspaceImportCompensationKind::Asset,
            &format!("{workspace_id}:{blob_key}"),
          )
          .await?;
        let mut temp = tempfile::NamedTempFile::new().map_err(|error| AuthError::Storage(error.to_string()))?;
        temp
          .write_all(bytes)
          .and_then(|_| temp.flush())
          .map_err(|error| AuthError::Storage(error.to_string()))?;
        let checksum = format!("{:x}", Sha256::digest(bytes));
        self
          .blobs
          .upload_blob_from_path(
            workspace_id,
            &blob_key,
            temp.path().to_path_buf(),
            bytes.len() as u64,
            "text/markdown",
            Some(&checksum),
          )
          .await?;
        created_assets += 1;
        self
          .repository
          .update_progress(
            record.id,
            WorkspaceImportProgressStage::TargetCreation,
            created_assets + 1,
            target_creation_total,
          )
          .await?;
        self.ensure_not_cancelled(record.id).await?;
      }
    }

    let document_ids = decoded
      .documents
      .iter()
      .map(|document| {
        (
          document.source_id.clone(),
          target_id(record.id, "document", &document.source_id),
        )
      })
      .collect::<HashMap<_, _>>();
    let mut replacements = document_ids
      .iter()
      .map(|(source, target)| (source.clone(), target.to_string()))
      .collect::<HashMap<_, _>>();
    replacements.extend(asset_keys.clone());
    self
      .repository
      .update_progress(
        record.id,
        WorkspaceImportProgressStage::DocumentMaterialization,
        0,
        decoded.documents.len() as i64,
      )
      .await?;
    let mut imported_pages = Vec::with_capacity(decoded.documents.len());
    let import_timestamp_ms = record.created_at.timestamp_millis();
    for (index, document) in decoded.documents.iter().enumerate() {
      let document_id = document_ids[&document.source_id];
      let planned_vault_document = vault_plan.and_then(|plan| {
        plan
          .documents
          .iter()
          .find(|planned| planned.source_path == document.source_id)
      });
      let document_title =
        planned_vault_document.map_or_else(|| document.title.clone(), |planned| planned.display_title.clone());
      self
        .repository
        .append_compensation(
          record.id,
          200_000 + index as i64,
          WorkspaceImportCompensationKind::Document,
          &format!("{workspace_id}:{document_id}"),
        )
        .await?;
      let initial = match &document.content {
        myoxus_workspace_import::DecodedDocumentContent::YjsV1(update) => update.clone(),
        myoxus_workspace_import::DecodedDocumentContent::SnapshotBlocks(blocks) => {
          yjs::snapshot_blocks_to_yjs(blocks).map_err(AuthError::InvalidInput)?
        }
        myoxus_workspace_import::DecodedDocumentContent::MarkdownUtf8(_) => planned_vault_document
          .filter(|planned| !planned.prepared_yjs.is_empty())
          .map(|planned| planned.prepared_yjs.clone())
          .ok_or_else(|| AuthError::Storage("Obsidian document preparation is missing".to_string()))?,
      };
      let initial = yjs::rewrite_snapshot_resource_uris(&initial, &replacements).map_err(AuthError::InvalidInput)?;
      let references = database_plan
        .block_references
        .iter()
        .filter(|reference| reference.source_document_id == document.source_id && !reference.already_migrated)
        .map(|reference| yjs::LegacyDatabaseReferenceRewrite {
          block_id: reference.block_id.clone(),
          server_database_id: reference.target_database_id,
          server_view_id: reference.target_view_id,
        })
        .collect::<Vec<_>>();
      let rewritten =
        yjs::rewrite_legacy_database_references(&initial, &references).map_err(AuthError::InvalidInput)?;
      if yjs::extract_legacy_database_blocks(&rewritten.full_state)
        .map_err(AuthError::InvalidInput)?
        .iter()
        .any(|block| !block.is_reference_only())
      {
        return Err(AuthError::InvalidInput(
          "workspace import retained an editor-local Database payload".to_string(),
        ));
      }
      self
        .documents
        .create_imported_doc(workspace_id, document_id, document_title.clone(), record.actor_id)
        .await?;
      self
        .documents
        .push_update_raw(workspace_id, document_id, rewritten.full_state, DocSpaceKind::Workspace)
        .await?;
      let metadata = planned_vault_document.map_or_else(
        || {
          serde_json::json!({
            "mode": document.mode,
            "parentId": document.parent_source_id.as_ref().and_then(|source| document_ids.get(source)).map(Uuid::to_string),
            "order": document.order,
            "createdAt": document.created_at_ms,
          })
        },
        |planned| {
          serde_json::json!({
            "mode": document.mode,
            "order": document.order,
            "obsidian": {
              "sourcePath": planned.source_path,
              "aliases": planned.aliases,
              "properties": planned.properties,
              "recoverySourceKey": planned.recovery_source_asset_id.map(|id| id.to_string()),
            },
          })
        },
      );
      self
        .documents
        .apply_imported_doc_metadata(
          workspace_id,
          document_id,
          document_title.clone(),
          metadata,
          document.created_at_ms,
          document.is_trashed,
        )
        .await?;
      let source_timestamp_ms = document.created_at_ms.unwrap_or(import_timestamp_ms);
      imported_pages.push(yjs::ImportedWorkspacePage {
        id: document_id.to_string(),
        title: document_title,
        mode: document.mode.clone(),
        parent_id: document
          .parent_source_id
          .as_ref()
          .and_then(|source| document_ids.get(source))
          .map(Uuid::to_string),
        order: document.order.clone(),
        created_at_ms: source_timestamp_ms,
        updated_at_ms: source_timestamp_ms,
        is_trashed: document.is_trashed,
      });
      tracing::debug!(
        import_id = %record.id,
        workspace_id = %workspace_id,
        document_id = %document_id,
        position = index,
        "workspace import document materialized"
      );
      self
        .repository
        .update_progress(
          record.id,
          WorkspaceImportProgressStage::DocumentMaterialization,
          index as i64 + 1,
          decoded.documents.len() as i64,
        )
        .await?;
      self.ensure_not_cancelled(record.id).await?;
    }
    if let Some(plan) = vault_plan {
      let organizer = OrganizerService::new(self.documents.clone());
      for folder in &plan.folders {
        organizer
          .create_folder(
            workspace_id,
            CreateOrganizerFolder {
              id: folder.target_folder_id.to_string(),
              parent_id: folder.parent_folder_id.map(|id| id.to_string()),
              name: folder.name.clone(),
              index: None,
            },
          )
          .await
          .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
      }
      for document in &plan.documents {
        let Some(parent_id) = document.organizer_folder_ids.last() else {
          continue;
        };
        organizer
          .create_link(
            workspace_id,
            CreateOrganizerLink {
              id: target_id(record.id, "organizer-link", &document.source_path).to_string(),
              parent_id: parent_id.to_string(),
              link_type: OrganizerLinkType::Doc,
              target_id: document.target_document_id.to_string(),
              target_workspace_id: None,
              index: None,
            },
          )
          .await
          .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
      }
    }
    self
      .repository
      .update_progress(
        record.id,
        WorkspaceImportProgressStage::DatabaseMaterialization,
        0,
        database_plan.databases.len() as i64,
      )
      .await?;
    for (index, database) in database_plan.databases.iter().enumerate() {
      self
        .repository
        .append_compensation(
          record.id,
          100_000 + index as i64,
          WorkspaceImportCompensationKind::Database,
          &format!("{workspace_id}:{}", database.target_id),
        )
        .await?;
      self
        .databases
        .materialize_legacy_database_plan(record.actor_id, workspace_id, database, &asset_keys)
        .await
        .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
      self
        .repository
        .update_progress(
          record.id,
          WorkspaceImportProgressStage::DatabaseMaterialization,
          index as i64 + 1,
          database_plan.databases.len() as i64,
        )
        .await?;
      self.ensure_not_cancelled(record.id).await?;
    }
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::ReferenceRewrite, 1, 1)
      .await?;
    let root = yjs::create_imported_workspace_doc(workspace_name.display(), &imported_pages);
    self
      .documents
      .push_update_raw(workspace_id, workspace_id, root, DocSpaceKind::Workspace)
      .await?;
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::FinalValidation, 1, 1)
      .await?;
    self.ensure_not_cancelled(record.id).await?;
    self
      .repository
      .update_progress(record.id, WorkspaceImportProgressStage::Publication, 0, 1)
      .await?;
    let result = self
      .repository
      .mark_succeeded(record.id, workspace_id, &label_plan.tags, &label_assignments)
      .await?;
    tracing::info!(import_id = %record.id, workspace_id = %workspace_id, "workspace import target published");
    for (metric, count) in [
      ("workspace_import_migrated_documents_total", decoded.documents.len()),
      (
        "workspace_import_migrated_databases_total",
        database_plan.databases.len(),
      ),
      ("workspace_import_migrated_rows_total", database_plan.row_count),
      ("workspace_import_migrated_assets_total", decoded.assets.len()),
    ] {
      self.record_metric(metric, &[], count as f64);
    }
    if let Err(error) = self.delete_staging_parts(record.id).await {
      tracing::warn!(import_id = %record.id, error = %error, "workspace import staging cleanup deferred to retention");
    }
    Ok(result)
  }

  #[tracing::instrument(skip(self, record), fields(import_id = %record.id, actor_id = %record.actor_id))]
  async fn run_cleanup(&self, record: WorkspaceImportRecord) -> AuthResult<WorkspaceImportRecord> {
    if !self.compensate(record.id).await {
      return Err(AuthError::Storage(
        "workspace import cleanup remains incomplete".to_string(),
      ));
    }
    self.delete_staging_parts(record.id).await?;
    self.repository.complete_cleanup(record.id).await
  }

  /// Expire a bounded batch without racing queued or running operations.
  /// Cleanup-required records are deliberately never selected by retention.
  #[tracing::instrument(skip(self), fields(batch_limit = limit))]
  pub async fn cleanup_retained_imports(&self, limit: i64) -> AuthResult<usize> {
    let policy = self.current_policy().await;
    let terminal_before = Utc::now() - Duration::hours(policy.staging_retention_hours as i64);
    let cleanup_backlog = self.repository.cleanup_required_count().await?;
    self.record_metric("workspace_import_cleanup_backlog_sum", &[], cleanup_backlog as f64);
    self.record_metric("workspace_import_cleanup_backlog_count", &[], 1.0);
    let candidates = self
      .repository
      .claim_retention_candidates(terminal_before, limit.clamp(1, 1_000))
      .await?;
    let mut purged = 0;
    for record in candidates {
      self.delete_staging_parts(record.id).await?;
      self.repository.purge_retained_artifacts(record.id).await?;
      purged += 1;
    }
    if purged > 0 {
      self.record_metric("workspace_import_retention_purged_total", &[], purged as f64);
    }
    Ok(purged)
  }

  async fn ensure_not_cancelled(&self, import_id: WorkspaceImportId) -> AuthResult<()> {
    let record = self
      .repository
      .get(import_id)
      .await?
      .ok_or_else(|| AuthError::NotFound("workspace import".to_string()))?;
    if record.cancel_requested {
      Err(AuthError::InvalidInput(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportCancelled
          .as_str()
          .to_string(),
      ))
    } else {
      Ok(())
    }
  }

  async fn policy_for_record(&self, import_id: WorkspaceImportId) -> AuthResult<WorkspaceImportPolicy> {
    let record = self
      .repository
      .get(import_id)
      .await?
      .ok_or_else(|| AuthError::NotFound("workspace import".to_string()))?;
    self.policy_for(&record).await
  }

  async fn policy_for(&self, record: &WorkspaceImportRecord) -> AuthResult<WorkspaceImportPolicy> {
    let policy = self.current_policy().await;
    if record.config_fingerprint != policy.fingerprint() {
      return Err(AuthError::InvalidInput(
        "workspace import configuration changed; create a new import".to_string(),
      ));
    }
    Ok(policy)
  }

  async fn materialize_staged_file(&self, import_id: WorkspaceImportId) -> AuthResult<tempfile::NamedTempFile> {
    let record = self
      .repository
      .get(import_id)
      .await?
      .ok_or_else(|| AuthError::NotFound("workspace import".to_string()))?;
    let parts = self.repository.list_parts(import_id).await?;
    let mut temp = tempfile::NamedTempFile::new().map_err(|error| AuthError::Storage(error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut total = 0_i64;
    for part in parts {
      let response = self
        .staging
        .read_blob(&part.object_key)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?;
      if response.data.len() > WORKSPACE_IMPORT_PART_BYTES
        || response.data.len() as i64 != part.size_bytes
        || format!("{:x}", Sha256::digest(&response.data)) != part.content_hash
      {
        return Err(AuthError::InvalidInput(
          "workspace import staged part changed after completion".to_string(),
        ));
      }
      temp
        .write_all(&response.data)
        .map_err(|error| AuthError::Storage(error.to_string()))?;
      hasher.update(&response.data);
      total += part.size_bytes;
    }
    temp.flush().map_err(|error| AuthError::Storage(error.to_string()))?;
    if total != record.source_size_bytes || format!("{:x}", hasher.finalize()) != record.source_hash {
      return Err(AuthError::InvalidInput(
        "workspace import staged source fingerprint changed".to_string(),
      ));
    }
    Ok(temp)
  }

  #[tracing::instrument(skip(self), fields(%import_id))]
  async fn compensate(&self, import_id: WorkspaceImportId) -> bool {
    let compensations = match self.repository.pending_compensations(import_id).await {
      Ok(compensations) => compensations,
      Err(_) => return false,
    };
    let total = compensations.len() as i64;
    if let Err(error) = self
      .repository
      .update_progress(import_id, WorkspaceImportProgressStage::Compensation, 0, total)
      .await
    {
      // A resumed cleanup may already have published a later compensation
      // count. Progress is monotonic, so retaining that durable value is safer
      // than making recovery depend on an informational update.
      tracing::debug!(%import_id, error = %error, "workspace import compensation progress already advanced");
    }
    let mut complete = true;
    for (index, compensation) in compensations.into_iter().enumerate() {
      let result = match compensation.kind {
        WorkspaceImportCompensationKind::Workspace => match Uuid::parse_str(&compensation.target_id) {
          Ok(workspace_id) => {
            self
              .workspaces
              .hard_delete_importing_workspace(import_id, workspace_id)
              .await
          }
          Err(error) => Err(AuthError::Storage(error.to_string())),
        },
        WorkspaceImportCompensationKind::Document => {
          let result = split_target_pair(&compensation.target_id);
          match result {
            Ok((workspace_id, document_id)) => self.documents.hard_delete_imported_doc(workspace_id, document_id).await,
            Err(error) => Err(error),
          }
        }
        WorkspaceImportCompensationKind::Database => match split_target_pair(&compensation.target_id) {
          Ok((workspace_id, database_id)) => {
            match self.databases.delete_imported_database(workspace_id, database_id).await {
              Ok(()) => Ok(()),
              Err(error) if error.code == crate::database::ERR_NOT_FOUND => Ok(()),
              Err(error) => Err(AuthError::Storage(error.to_string())),
            }
          }
          Err(error) => Err(AuthError::Storage(error.to_string())),
        },
        WorkspaceImportCompensationKind::Asset => match split_target_pair(&compensation.target_id) {
          Ok((workspace_id, asset_id)) => {
            self
              .blobs
              .delete_imported_blob(workspace_id, &asset_id.to_string())
              .await
          }
          Err(error) => Err(error),
        },
      };
      if result.is_ok() {
        if self.repository.complete_compensation(compensation.id).await.is_err() {
          complete = false;
        } else if let Err(error) = self
          .repository
          .update_progress(
            import_id,
            WorkspaceImportProgressStage::Compensation,
            index as i64 + 1,
            total,
          )
          .await
        {
          tracing::debug!(%import_id, error = %error, "workspace import compensation progress already advanced");
        }
      } else {
        complete = false;
        self.record_metric(
          "workspace_import_compensation_failures_total",
          &[("kind", compensation.kind.as_str())],
          1.0,
        );
        let _ = self
          .repository
          .fail_compensation(compensation.id, "compensation action failed")
          .await;
      }
    }
    complete
  }

  async fn delete_staging_parts(&self, import_id: WorkspaceImportId) -> AuthResult<()> {
    let parts = self.repository.list_parts(import_id).await?;
    for part in parts {
      self
        .staging
        .delete_blob(&part.object_key)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?;
    }
    Ok(())
  }
}

fn build_id_mappings(
  import_id: WorkspaceImportId,
  decoded: &myoxus_workspace_import::DecodedWorkspace,
  database_plan: &LegacyDatabaseMigrationPlan,
  target_plan: &WorkspaceImportTargetPlan,
) -> Vec<WorkspaceImportIdMapping> {
  let now = Utc::now();
  let mut mappings = vec![WorkspaceImportIdMapping {
    import_id,
    kind: myoxus_domain::workspace_import::WorkspaceImportMappingKind::Workspace,
    source_id: "workspace".to_string(),
    target_id: target_plan.workspace_id,
    created_at: now,
  }];
  mappings.extend(decoded.documents.iter().map(|document| WorkspaceImportIdMapping {
    import_id,
    kind: myoxus_domain::workspace_import::WorkspaceImportMappingKind::Document,
    source_id: document.source_id.clone(),
    target_id: target_id(import_id, "document", &document.source_id),
    created_at: now,
  }));
  let mut mapped_asset_targets = HashSet::new();
  for asset in &decoded.assets {
    let target_id = target_plan
      .vault
      .as_ref()
      .and_then(|plan| {
        plan
          .assets
          .iter()
          .find(|planned| planned.source_path == asset.source_key)
      })
      .map_or_else(
        || target_id(import_id, "asset", &asset.source_key),
        |planned| planned.target_asset_id,
      );
    // The ledger owns one row per materialized target. Vault path aliases stay
    // in the accepted plan and in the operation-local resource rewrite map.
    if mapped_asset_targets.insert(target_id) {
      mappings.push(WorkspaceImportIdMapping {
        import_id,
        kind: myoxus_domain::workspace_import::WorkspaceImportMappingKind::Asset,
        source_id: asset.source_key.clone(),
        target_id,
        created_at: now,
      });
    }
  }
  for database in &database_plan.databases {
    mappings.push(WorkspaceImportIdMapping {
      import_id,
      kind: myoxus_domain::workspace_import::WorkspaceImportMappingKind::Database,
      source_id: database.source_id.clone(),
      target_id: database.target_id,
      created_at: now,
    });
    mappings.extend(database.fields.iter().map(|field| WorkspaceImportIdMapping {
      import_id,
      kind: myoxus_domain::workspace_import::WorkspaceImportMappingKind::Field,
      source_id: format!("{}:{}", database.source_id, field.source_id),
      target_id: field.target_id,
      created_at: now,
    }));
    mappings.extend(database.views.iter().map(|view| WorkspaceImportIdMapping {
      import_id,
      kind: myoxus_domain::workspace_import::WorkspaceImportMappingKind::View,
      source_id: format!("{}:{}", database.source_id, view.source_id),
      target_id: view.target_id,
      created_at: now,
    }));
    mappings.extend(database.rows.iter().map(|row| WorkspaceImportIdMapping {
      import_id,
      kind: myoxus_domain::workspace_import::WorkspaceImportMappingKind::Row,
      source_id: format!("{}:{}", database.source_id, row.source_id),
      target_id: row.target_id,
      created_at: now,
    }));
  }
  mappings
}

fn split_target_pair(value: &str) -> AuthResult<(Uuid, Uuid)> {
  let (left, right) = value
    .split_once(':')
    .ok_or_else(|| AuthError::Storage("workspace import compensation target is invalid".to_string()))?;
  Ok((
    Uuid::parse_str(left).map_err(|error| AuthError::Storage(error.to_string()))?,
    Uuid::parse_str(right).map_err(|error| AuthError::Storage(error.to_string()))?,
  ))
}

fn diagnostic_error(diagnostic: WorkspaceImportDiagnostic) -> AuthError {
  AuthError::InvalidInput(diagnostic.code.as_str().to_string())
}

fn format_name(format: WorkspaceImportFormat) -> &'static str {
  match format {
    WorkspaceImportFormat::SqliteV1 => "sqlite_v1",
    WorkspaceImportFormat::SqliteDocStorage => "sqlite_doc_storage",
    WorkspaceImportFormat::SnapshotZip => "snapshot_zip",
    WorkspaceImportFormat::ObsidianZip => "obsidian_zip",
  }
}

fn selected_format(record: &WorkspaceImportRecord) -> AuthResult<Option<WorkspaceImportFormat>> {
  match record.selected_format.as_str() {
    "auto" => Ok(None),
    "obsidian_zip" => Ok(Some(WorkspaceImportFormat::ObsidianZip)),
    _ => Err(AuthError::Storage(
      "workspace import contains an invalid selected format".to_string(),
    )),
  }
}

fn hash_file(path: &Path) -> AuthResult<String> {
  let mut file = std::fs::File::open(path).map_err(|error| AuthError::Storage(error.to_string()))?;
  let mut hasher = Sha256::new();
  let mut buffer = [0_u8; 1024 * 1024];
  loop {
    let read = file
      .read(&mut buffer)
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    if read == 0 {
      break;
    }
    hasher.update(&buffer[..read]);
  }
  Ok(format!("{:x}", hasher.finalize()))
}

fn build_preview(
  record: &WorkspaceImportRecord,
  decoded: myoxus_workspace_import::DecodedWorkspace,
  database_plan: LegacyDatabaseMigrationPlan,
) -> WorkspaceImportPreview {
  let vault_plan = (decoded.format == WorkspaceImportFormat::ObsidianZip)
    .then(|| obsidian::plan_vault(record, &decoded))
    .transpose();
  let vault_tags = vault_plan
    .as_ref()
    .ok()
    .and_then(Option::as_ref)
    .map(|plan| plan.documents.iter().map(|document| &document.tags).collect::<Vec<_>>());
  let label_plan = crate::workspace_tags::transfer::plan_import(
    record.id,
    target_id(record.id, "workspace", "target"),
    record.actor_id,
    vault_plan
      .as_ref()
      .ok()
      .and_then(Option::as_ref)
      .map_or(decoded.workspace_tags.as_slice(), |plan| plan.labels.as_slice()),
    vault_tags.unwrap_or_else(|| decoded.documents.iter().map(|document| &document.tags).collect()),
  );
  let mut diagnostics = decoded.diagnostics;
  if let Ok(Some(plan)) = &vault_plan {
    diagnostics.extend(plan.diagnostics.clone());
  } else if let Err(diagnostic) = &vault_plan {
    diagnostics.push(diagnostic.clone());
  }
  if decoded.format == WorkspaceImportFormat::ObsidianZip {
    diagnostics.push(WorkspaceImportDiagnostic::informational(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultRoot,
      "ZIP archive root is the Obsidian vault root; top-level folders are preserved",
    ));
    if decoded.omitted_counts.excluded_entries > 0 {
      diagnostics.push(WorkspaceImportDiagnostic::informational(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultEntriesExcluded,
        format!(
          "{} Obsidian configuration, trash, or operating-system metadata entries are excluded",
          decoded.omitted_counts.excluded_entries
        ),
      ));
    }
  }
  match &label_plan {
    Ok(plan) => diagnostics.extend(plan.diagnostics.clone()),
    Err(error) => diagnostics.push(error.clone()),
  }
  diagnostics.extend(database_plan.diagnostics.clone());
  diagnostics.extend(omitted_diagnostics());
  let omitted_counts = decoded.omitted_counts.clone();
  let asset_ids = vault_plan
    .as_ref()
    .ok()
    .and_then(Option::as_ref)
    .map(|plan| {
      plan
        .assets
        .iter()
        .map(|asset| asset.target_asset_id)
        .chain(
          plan
            .documents
            .iter()
            .filter_map(|document| document.recovery_source_asset_id),
        )
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>()
    })
    .unwrap_or_else(|| {
      decoded
        .assets
        .iter()
        .map(|asset| target_id(record.id, "asset", &asset.source_key))
        .collect()
    });
  let target_plan = WorkspaceImportTargetPlan {
    tag_ids: label_plan
      .as_ref()
      .map(|plan| plan.tags.iter().map(|tag| tag.id).collect())
      .unwrap_or_default(),
    workspace_id: target_id(record.id, "workspace", "target"),
    document_ids: decoded
      .documents
      .iter()
      .map(|document| target_id(record.id, "document", &document.source_id))
      .collect(),
    asset_ids,
    database_ids: database_plan
      .databases
      .iter()
      .map(|database| database.target_id)
      .collect(),
    vault: vault_plan.ok().flatten(),
  };
  let proposed_workspace_title = sanitize_title(&decoded.title);
  let apply_allowed = database_plan.apply_allowed
    && diagnostics
      .iter()
      .all(|diagnostic| diagnostic.severity != WorkspaceImportDiagnosticSeverity::Blocking);
  let plan_fingerprint = obsidian::plan_fingerprint(
    &record.source_hash,
    &record.selected_format,
    &record.config_fingerprint,
    &target_plan,
  );
  WorkspaceImportPreview {
    import_id: record.id,
    detected_format: decoded.format,
    source_root: if decoded.format == WorkspaceImportFormat::ObsidianZip {
      "archive_root".to_string()
    } else {
      "source_root".to_string()
    },
    proposed_workspace_title,
    counts: WorkspaceImportObjectCounts {
      documents: decoded.documents.len(),
      assets: decoded.assets.len(),
      databases: database_plan.databases.len(),
      fields: database_plan.field_count,
      rows: database_plan.row_count,
      cells: database_plan.cell_count,
      views: database_plan.view_count,
    },
    omitted_counts,
    target_plan,
    diagnostics,
    source_hash: record.source_hash.clone(),
    config_fingerprint: record.config_fingerprint.clone(),
    plan_fingerprint,
    apply_allowed,
  }
}

fn omitted_diagnostics() -> Vec<WorkspaceImportDiagnostic> {
  [
    (
      WorkspaceImportDiagnosticCode::MixWorkspaceImportMembershipsOmitted,
      "Account memberships are intentionally omitted",
    ),
    (
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSessionsOmitted,
      "Sessions are intentionally omitted",
    ),
    (
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSharingPublicationsOmitted,
      "Sharing and publication state are intentionally omitted",
    ),
    (
      WorkspaceImportDiagnosticCode::MixWorkspaceImportCommentsOmitted,
      "Comments are intentionally omitted",
    ),
    (
      WorkspaceImportDiagnosticCode::MixWorkspaceImportActivityHistoryOmitted,
      "Activity and history are intentionally omitted",
    ),
    (
      WorkspaceImportDiagnosticCode::MixWorkspaceImportExternalIntegrationsCredentialsOmitted,
      "External integrations and credentials are intentionally omitted",
    ),
  ]
  .into_iter()
  .map(|(code, message)| WorkspaceImportDiagnostic {
    code,
    severity: WorkspaceImportDiagnosticSeverity::Informational,
    message: message.to_string(),
    context: None,
  })
  .collect()
}

fn sanitize_title(value: &str) -> String {
  let title = value
    .chars()
    .filter(|character| !character.is_control())
    .take(256)
    .collect::<String>();
  let title = title.trim();
  if title.is_empty() {
    "Imported workspace".to_string()
  } else {
    title.to_string()
  }
}

fn target_id(namespace: Uuid, kind: &str, source_id: &str) -> Uuid {
  Uuid::new_v5(&namespace, format!("{kind}:{source_id}").as_bytes())
}

fn blocking(code: WorkspaceImportDiagnosticCode, message: impl Into<String>) -> WorkspaceImportDiagnostic {
  WorkspaceImportDiagnostic::blocking(code, message)
}

#[cfg(test)]
mod tests {
  use std::collections::HashSet;
  use std::path::{Path, PathBuf};

  use chrono::Duration;
  use myoxus_domain::workspace_import::WorkspaceImportStatus;

  use super::*;

  #[test]
  fn label_validation_blocks_publication_before_target_creation() {
    let record = staged_record(Uuid::new_v4());
    let mut decoded = myoxus_workspace_import::WorkspaceDecoder::new(WorkspaceImportLimits::default())
      .decode_path(fixture("workspace-snapshot-valid.zip"))
      .unwrap();
    decoded.documents[0].tags.push("unknown-label".into());
    let databases = plan_fresh_workspace_legacy_database_migration(record.id, &[], WorkspaceImportLimits::default());
    let preview = build_preview(&record, decoded.clone(), databases);
    assert!(!preview.apply_allowed);
    assert!(preview.target_plan.tag_ids.is_empty());
    assert!(
      preview
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == WorkspaceImportDiagnosticCode::MixWorkspaceImportApplyBlocked)
    );
  }

  #[test]
  fn obsidian_preview_is_bounded_deterministic_and_carries_apply_materialization() {
    let mut record = staged_record(Uuid::new_v4());
    record.selected_format = "obsidian_zip".to_string();
    let decoded = myoxus_workspace_import::DecodedWorkspace {
      format: WorkspaceImportFormat::ObsidianZip,
      title: "Obsidian vault".to_string(),
      workspace_tags: Vec::new(),
      documents: vec![myoxus_workspace_import::DecodedDocument {
        source_id: "Folder/Note.md".to_string(),
        title: "Note".to_string(),
        mode: "page".to_string(),
        parent_source_id: None,
        order: "Folder/Note.md".to_string(),
        created_at_ms: None,
        is_trashed: false,
        tags: Vec::new(),
        content: myoxus_workspace_import::DecodedDocumentContent::MarkdownUtf8(
          b"# Note\n\nResult $x^2$.\n\n$$\ny=2x\n$$".to_vec(),
        ),
      }],
      assets: Vec::new(),
      directories: vec!["Empty folder".to_string()],
      omitted_counts: DecodedOmittedObjectCounts {
        excluded_entries: 2,
        ..DecodedOmittedObjectCounts::default()
      },
      diagnostics: Vec::new(),
    };
    let databases = plan_fresh_workspace_legacy_database_migration(record.id, &[], WorkspaceImportLimits::default());
    let preview = build_preview(&record, decoded.clone(), databases);

    assert_eq!(preview.source_root, "archive_root");
    assert_eq!(preview.counts.documents, 1);
    assert_eq!(preview.omitted_counts.excluded_entries, 2);
    assert!(preview.apply_allowed);
    let vault = preview.target_plan.vault.as_ref().expect("vault target plan");
    assert_eq!(vault.documents[0].source_path, "Folder/Note.md");
    assert!(!vault.documents[0].prepared_yjs.is_empty());
    assert!(!vault.documents[0].recovery_source_required);
    assert!(
      vault
        .classifications
        .iter()
        .any(|finding| finding.code == "VAULT_MATH_NATIVE")
    );
    assert_eq!(vault.folders[0].source_path, "Empty folder");
    assert_eq!(vault.folders[1].source_path, "Folder");
    assert_eq!(
      preview,
      build_preview(
        &record,
        decoded.clone(),
        plan_fresh_workspace_legacy_database_migration(record.id, &[], WorkspaceImportLimits::default(),)
      )
    );
    assert!(
      preview
        .diagnostics
        .iter()
        .any(|diagnostic| { diagnostic.code == WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultRoot })
    );
    let mut unsupported = decoded;
    unsupported.documents[0].content =
      myoxus_workspace_import::DecodedDocumentContent::MarkdownUtf8(b"Before $$x^2$$ after.".to_vec());
    let diagnosed = build_preview(
      &record,
      unsupported,
      plan_fresh_workspace_legacy_database_migration(record.id, &[], WorkspaceImportLimits::default()),
    );
    let recovery = diagnosed.target_plan.vault.as_ref().unwrap();
    assert!(diagnosed.apply_allowed);
    assert!(recovery.documents[0].recovery_source_required);
    assert_eq!(
      recovery.documents[0].target_document_id,
      vault.documents[0].target_document_id
    );
    assert!(
      recovery
        .classifications
        .iter()
        .any(|finding| finding.code == "VAULT_MATH_SOURCE_PRESERVED")
    );
    assert!(
      !recovery
        .classifications
        .iter()
        .any(|finding| finding.code == "VAULT_MATH_NATIVE")
    );
  }

  #[test]
  fn obsidian_preview_binds_forward_and_local_targets_to_its_apply_tree() {
    let record = staged_record(Uuid::new_v4());
    let make_document = |path: &str, source: &str| myoxus_workspace_import::DecodedDocument {
      source_id: path.into(),
      title: path.trim_end_matches(".md").into(),
      mode: "page".into(),
      parent_source_id: None,
      order: path.into(),
      created_at_ms: None,
      is_trashed: false,
      tags: Vec::new(),
      content: myoxus_workspace_import::DecodedDocumentContent::MarkdownUtf8(source.as_bytes().to_vec()),
    };
    let decoded = myoxus_workspace_import::DecodedWorkspace {
      format: WorkspaceImportFormat::ObsidianZip,
      title: "Navigation review".into(),
      workspace_tags: Vec::new(),
      documents: vec![
        make_document(
          "Source.md",
          "# Navigation review\n\nOpen [[Target#Über Größe|the heading]], [the checklist item](Target.md#%5Erelease), or [[Target#^instruction|the instruction]].\n\nLocal decision for the release review. ^local\n\nReturn to [[#^local|the local decision]].\n\nCode remains literal: `[[Target#^instruction]]`.\n\n%%The private annotation [[Target#^instruction]] stays literal.%%\n",
        ),
        make_document(
          "Target.md",
          "---\ntitle: Current target\n---\n# Über Größe\n\nRelease instruction for Anna. ^instruction\n\n- Check the backup before publishing. ^release\n  - Confirm the audit log.\n\n## Review notes\n\nThis paragraph is not referenced and needs no generated export anchor.\n",
        ),
      ],
      assets: Vec::new(),
      directories: Vec::new(),
      omitted_counts: DecodedOmittedObjectCounts::default(),
      diagnostics: Vec::new(),
    };
    let preview = build_preview(
      &record,
      decoded.clone(),
      plan_fresh_workspace_legacy_database_migration(record.id, &[], WorkspaceImportLimits::default()),
    );
    assert!(preview.apply_allowed);
    let vault = preview.target_plan.vault.as_ref().expect("native vault plan");
    assert!(
      vault
        .documents
        .iter()
        .all(|document| !document.recovery_source_required),
      "all four navigable references must resolve, while code and annotations remain literal: {:?}",
      preview.diagnostics
    );
    assert!(vault.classifications.iter().any(|finding| {
      finding.source_path == "Source.md"
        && finding.code == "VAULT_REFERENCE_TARGET_NATIVE"
        && finding.preservation == VaultPreservation::Native
    }));
    let source = &vault.documents[0];
    let target = &vault.documents[1];
    assert_eq!(target.display_title, "Current target");
    let target_tree = yjs::markdown::markdown_native_targets(&target.prepared_yjs).unwrap();
    let source_tree = yjs::markdown::markdown_native_targets(&source.prepared_yjs).unwrap();
    let heading = yjs::markdown::resolve_markdown_target(&target_tree, "Über Größe").unwrap();
    let item = yjs::markdown::resolve_markdown_target(&target_tree, "^release").unwrap();
    let instruction = yjs::markdown::resolve_markdown_target(&target_tree, "^instruction").unwrap();
    let local = yjs::markdown::resolve_markdown_target(&source_tree, "^local").unwrap();
    let references = yjs::extract_document_references_from_yjs(&source.prepared_yjs).unwrap();
    assert_eq!(references.occurrences.len(), 4);
    for (reference, expected_doc, expected_block) in references
      .occurrences
      .iter()
      .zip([
        (target.target_document_id, &heading.block_id),
        (target.target_document_id, &item.block_id),
        (target.target_document_id, &instruction.block_id),
        (source.target_document_id, &local.block_id),
      ])
      .map(|(reference, (doc, block))| (reference, doc, block))
    {
      assert_eq!(reference.raw_target_doc_id, expected_doc.to_string());
      assert_eq!(reference.params_json["params"]["blockIds"][0], expected_block.as_str());
    }
    assert_eq!(
      preview,
      build_preview(
        &record,
        decoded.clone(),
        plan_fresh_workspace_legacy_database_migration(record.id, &[], WorkspaceImportLimits::default()),
      ),
      "confirmation does not depend on fresh operation-local native IDs"
    );

    let mut ambiguous = decoded;
    ambiguous.documents[1].content = myoxus_workspace_import::DecodedDocumentContent::MarkdownUtf8(
      b"# Same\n\n# Same\n\nFirst ^repeat\n\nSecond ^repeat\n".to_vec(),
    );
    ambiguous.documents[0].content = myoxus_workspace_import::DecodedDocumentContent::MarkdownUtf8(
      b"[[Target#Same]] [[Target#^repeat]] [[Target#^missing]]".to_vec(),
    );
    let ambiguous = build_preview(
      &record,
      ambiguous,
      plan_fresh_workspace_legacy_database_migration(record.id, &[], WorkspaceImportLimits::default()),
    );
    let unresolved = &ambiguous.target_plan.vault.as_ref().unwrap().documents[0];
    assert!(unresolved.recovery_source_required);
    assert!(
      yjs::extract_document_references_from_yjs(&unresolved.prepared_yjs)
        .unwrap()
        .occurrences
        .is_empty()
    );
    assert!(
      ambiguous
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultSourcePreserved)
    );
  }

  #[test]
  fn obsidian_preview_blocks_malformed_yaml_without_dropping_deterministic_identities() {
    let mut record = staged_record(Uuid::new_v4());
    record.selected_format = "obsidian_zip".to_string();
    let decoded = myoxus_workspace_import::DecodedWorkspace {
      format: WorkspaceImportFormat::ObsidianZip,
      title: "Obsidian vault".to_string(),
      workspace_tags: Vec::new(),
      documents: vec![myoxus_workspace_import::DecodedDocument {
        source_id: "Bad.md".to_string(),
        title: "Bad".to_string(),
        mode: "page".to_string(),
        parent_source_id: None,
        order: "Bad.md".to_string(),
        created_at_ms: None,
        is_trashed: false,
        tags: Vec::new(),
        content: myoxus_workspace_import::DecodedDocumentContent::MarkdownUtf8(
          b"---\naliases: [broken\n---\nBody".to_vec(),
        ),
      }],
      assets: Vec::new(),
      directories: Vec::new(),
      omitted_counts: DecodedOmittedObjectCounts::default(),
      diagnostics: Vec::new(),
    };
    let preview = build_preview(
      &record,
      decoded,
      plan_fresh_workspace_legacy_database_migration(record.id, &[], WorkspaceImportLimits::default()),
    );

    assert!(!preview.apply_allowed);
    let vault = preview.target_plan.vault.as_ref().expect("blocked vault plan");
    assert_eq!(vault.documents.len(), 1);
    assert!(vault.classifications.iter().any(|classification| {
      classification.source_path == "Bad.md" && classification.preservation == VaultPreservation::Blocking
    }));
    assert!(preview.diagnostics.iter().any(|diagnostic| {
      diagnostic.code == WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultYamlInvalid
        && diagnostic
          .context
          .as_ref()
          .and_then(|context| context.source_path.as_deref())
          == Some("Bad.md")
    }));
  }

  fn footnote_preview(source: &str) -> WorkspaceImportPreview {
    let mut record = staged_record(Uuid::new_v4());
    record.selected_format = "obsidian_zip".into();
    let decoded = myoxus_workspace_import::DecodedWorkspace {
      format: WorkspaceImportFormat::ObsidianZip,
      title: "Footnote vault".into(),
      workspace_tags: Vec::new(),
      documents: vec![myoxus_workspace_import::DecodedDocument {
        source_id: "Note.md".into(),
        title: "Note".into(),
        mode: "page".into(),
        parent_source_id: None,
        order: "Note.md".into(),
        created_at_ms: None,
        is_trashed: false,
        tags: Vec::new(),
        content: myoxus_workspace_import::DecodedDocumentContent::MarkdownUtf8(source.as_bytes().to_vec()),
      }],
      assets: vec![myoxus_workspace_import::DecodedAsset {
        source_key: "media/pixel.svg".into(),
        size_bytes: 114,
        content_hash: "00a99eded544426817c9effcd5d844d93a44f2a4506308fb92aad960cd5d603f".into(),
      }],
      directories: Vec::new(),
      omitted_counts: DecodedOmittedObjectCounts::default(),
      diagnostics: Vec::new(),
    };
    build_preview(
      &record,
      decoded,
      plan_fresh_workspace_legacy_database_migration(record.id, &[], WorkspaceImportLimits::default()),
    )
  }

  #[test]
  fn obsidian_invalid_footnotes_block_before_writes_with_bounded_label_only_diagnostics() {
    for (source, label) in [
      ("Missing[^Lost-α]", "Lost-α"),
      ("[^Same]: one\n\n[^same]: two", "same"),
      ("[^outer]: nested[^inner]\n\n[^inner]: body", "inner"),
      ("[^bad]: {\"type\":\"doc\",\"title\":\"PRIVATE-BODY-PAYLOAD\"}", "bad"),
      ("[^bad-json]: {\"type\":\"url\",PRIVATE-BODY-PAYLOAD}", "bad-json"),
    ] {
      let preview = footnote_preview(source);
      assert!(!preview.apply_allowed, "invalid definition must block {label}");
      let vault = preview.target_plan.vault.as_ref().unwrap();
      assert_eq!(vault.documents.len(), 1);
      assert!(vault.documents[0].prepared_yjs.is_empty());
      assert!(vault.documents[0].recovery_source_required);
      assert!(
        vault
          .classifications
          .iter()
          .any(|finding| finding.code == "VAULT_FOOTNOTE_BLOCKING")
      );
      let diagnostic = preview
        .diagnostics
        .iter()
        .find(|d| d.severity == WorkspaceImportDiagnosticSeverity::Blocking)
        .unwrap();
      assert!(
        diagnostic.message.contains(label),
        "label-specific admission failure: {diagnostic:?}"
      );
      assert!(!diagnostic.message.contains("PRIVATE-BODY-PAYLOAD"));
      assert!(diagnostic.message.len() < 400);
    }
  }

  fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../workspace_import/tests/fixtures")
      .join(name)
  }

  fn staged_record(actor_id: UserId) -> WorkspaceImportRecord {
    let now = Utc::now();
    WorkspaceImportRecord {
      id: Uuid::new_v4(),
      actor_id,
      status: WorkspaceImportStatus::Staged,
      selected_format: "auto".to_string(),
      staging_object_key: "workspace-import/test/source".to_string(),
      source_hash: "fixture-source-hash".to_string(),
      source_size_bytes: 1,
      config_fingerprint: "fixture-config-fingerprint".to_string(),
      preview: None,
      target_workspace_id: None,
      queued_operation: None,
      progress_stage: None,
      progress_current: 0,
      progress_total: 0,
      cancel_requested: false,
      error_code: None,
      error_message: None,
      created_at: now,
      updated_at: now,
      expires_at: now + Duration::hours(1),
    }
  }

  #[test]
  fn both_canonical_sources_share_exact_preview_and_database_conversion_counts() {
    let actor = Uuid::new_v4();
    let service = WorkspaceImportPreviewService::new(WorkspaceImportLimits::default());
    let record = staged_record(actor);
    let sqlite = service
      .preview_staged(actor, &record, fixture("workspace-sqlite-v1-valid.myoxus"))
      .expect("SQLite preview");
    let snapshot = service
      .preview_staged(actor, &record, fixture("workspace-snapshot-valid.zip"))
      .expect("snapshot preview");

    let expected = WorkspaceImportObjectCounts {
      documents: 2,
      assets: 1,
      databases: 2,
      fields: 18,
      rows: 3,
      cells: 24,
      views: 3,
    };
    assert_eq!(sqlite.counts, expected);
    assert_eq!(snapshot.counts, expected);
    assert!(sqlite.apply_allowed, "SQLite diagnostics: {:?}", sqlite.diagnostics);
    assert!(
      snapshot.apply_allowed,
      "snapshot diagnostics: {:?}",
      snapshot.diagnostics
    );
    assert_eq!(sqlite.omitted_counts, DecodedOmittedObjectCounts::default());
    assert_eq!(snapshot.omitted_counts, DecodedOmittedObjectCounts::default());
    let omitted_codes = sqlite
      .diagnostics
      .iter()
      .filter(|diagnostic| diagnostic.severity == WorkspaceImportDiagnosticSeverity::Informational)
      .map(|diagnostic| diagnostic.code)
      .collect::<HashSet<_>>();
    assert_eq!(omitted_codes.len(), 7);
    assert!(omitted_codes.contains(&WorkspaceImportDiagnosticCode::MixWorkspaceImportLabelColorNormalized));
    assert!(omitted_codes.contains(&WorkspaceImportDiagnosticCode::MixWorkspaceImportMembershipsOmitted));
    assert!(omitted_codes.contains(&WorkspaceImportDiagnosticCode::MixWorkspaceImportSessionsOmitted));
    assert!(omitted_codes.contains(&WorkspaceImportDiagnosticCode::MixWorkspaceImportSharingPublicationsOmitted));
    assert!(omitted_codes.contains(&WorkspaceImportDiagnosticCode::MixWorkspaceImportCommentsOmitted));
    assert!(omitted_codes.contains(&WorkspaceImportDiagnosticCode::MixWorkspaceImportActivityHistoryOmitted));
    assert!(
      omitted_codes.contains(&WorkspaceImportDiagnosticCode::MixWorkspaceImportExternalIntegrationsCredentialsOmitted)
    );
    assert_eq!(sqlite.target_plan, snapshot.target_plan);
    assert_eq!(sqlite.source_hash, record.source_hash);
    assert_eq!(sqlite.config_fingerprint, record.config_fingerprint);
    let serialized = serde_json::to_string(&sqlite).expect("preview JSON");
    for prohibited in [
      "yjs",
      "blocks",
      "asset-logo",
      "row-alpha",
      "Server-owned migration",
      "Migration service",
    ] {
      assert!(!serialized.contains(prohibited), "preview leaked {prohibited}");
    }
  }

  #[test]
  fn preview_rejects_cross_account_and_expired_staging_before_decoding() {
    let actor = Uuid::new_v4();
    let service = WorkspaceImportPreviewService::new(WorkspaceImportLimits::default());
    let record = staged_record(actor);
    let denial = service
      .preview_staged(Uuid::new_v4(), &record, fixture("format-does-not-matter"))
      .expect_err("cross-account preview");
    assert_eq!(
      denial.code,
      WorkspaceImportDiagnosticCode::MixWorkspaceImportPermissionDenied
    );

    let mut expired = record;
    expired.expires_at = Utc::now() - Duration::seconds(1);
    let denial = service
      .preview_staged(actor, &expired, fixture("format-does-not-matter"))
      .expect_err("expired preview");
    assert_eq!(denial.code, WorkspaceImportDiagnosticCode::MixWorkspaceImportExpired);
  }

  #[test]
  fn invalid_database_payloads_and_database_limits_block_the_complete_preview() {
    let actor = Uuid::new_v4();
    let record = staged_record(actor);
    let service = WorkspaceImportPreviewService::new(WorkspaceImportLimits::default());
    for fixture_name in ["invalid/database-invalid.zip", "invalid/database-unsupported.zip"] {
      let preview = service
        .preview_staged(actor, &record, fixture(fixture_name))
        .expect("decoder can report Database planner diagnostics");
      assert!(!preview.apply_allowed, "{fixture_name} must block apply");
      assert!(preview.diagnostics.iter().any(|diagnostic| {
        matches!(
          diagnostic.code,
          WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid
            | WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseUnsupported
        )
      }));
    }

    for limits in [
      WorkspaceImportLimits {
        max_databases: 1,
        ..WorkspaceImportLimits::default()
      },
      WorkspaceImportLimits {
        max_fields_per_database: 1,
        ..WorkspaceImportLimits::default()
      },
      WorkspaceImportLimits {
        max_views_per_database: 1,
        ..WorkspaceImportLimits::default()
      },
      WorkspaceImportLimits {
        max_rows_per_database: 1,
        ..WorkspaceImportLimits::default()
      },
      WorkspaceImportLimits {
        max_cells_per_database: 1,
        ..WorkspaceImportLimits::default()
      },
    ] {
      let preview = WorkspaceImportPreviewService::new(limits)
        .preview_staged(actor, &record, fixture("workspace-snapshot-valid.zip"))
        .expect("resource-limit preview");
      assert!(!preview.apply_allowed);
      assert!(
        preview
          .diagnostics
          .iter()
          .any(|diagnostic| diagnostic.code == WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseUnsupported)
      );
    }
  }
}
