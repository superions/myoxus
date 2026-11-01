// SPDX-License-Identifier: AGPL-3.0-or-later
//! Adapters that let the worker's `PdfBlobWriter` and `PdfExportMetrics`
//! traits be satisfied by the api's [`BlobStoragePort`] /
//! [`MetricsService`] and the shared PDF create/get use case.
//!
//! Both the binary's queue-handler wiring and the GraphQL `exportPdf`
//! mutation (sync path) construct one of these to hand into the worker
//! pipeline.

use std::sync::Arc;
use std::time::Duration;

use myoxus_application::metrics::{MetricsCategory, MetricsService};
use myoxus_application::ports::blob::BlobKey;
use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest};
use myoxus_pdf_export::render_v2::pdfa::VerapdfClient;
use myoxus_worker::pdf_export_metrics::{PdfExportMetrics, PdfExportOutcome};
use serde_json::{Map as JsonMap, Value};
use uuid::Uuid;

use crate::config::PdfExportConfig;

/// Translate the common live resource snapshot at the API/worker wiring boundary.
/// Request and queued consumers capture it once before starting document work.
pub async fn effective_pdf_limits(state: &crate::state::ApiState) -> Result<myoxus_worker::PdfExportLimits, String> {
  let config = state.effective_config().await.pdf_export_limits()?;
  Ok(myoxus_worker::PdfExportLimits {
    max_input_blocks: config.max_input_blocks as usize,
    max_pages: config.max_pages as usize,
    render_timeout: Duration::from_secs(config.render_timeout_seconds),
    max_memory_mb: config.max_memory_mb,
    snapshot_limits: state.config.pdf_export.edgeless_snapshot_limits(),
  })
}

pub struct PdfExportLimitsProviderAdapter {
  pub state: Arc<crate::state::ApiState>,
}
#[async_trait::async_trait]
impl myoxus_worker::pdf_export_handler::PdfExportLimitsProvider for PdfExportLimitsProviderAdapter {
  async fn current_limits(&self) -> Result<myoxus_worker::PdfExportLimits, String> {
    effective_pdf_limits(&self.state).await
  }
}

/// Build the optional external veraPDF validator used by sync and queued PDF/A
/// exports. The renderer already applies native Typst standards; this client is
/// an additional deployment-time gate and therefore only exists when a base URL
/// is configured.
pub fn build_verapdf_client(
  config: &PdfExportConfig,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> Result<Option<Arc<dyn VerapdfClient>>, myoxus_pdf_export::render_v2::pdfa::PdfaError> {
  let Some(base_url) = config
    .verapdf_validator_url
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
  else {
    return Ok(None);
  };
  // A configured validation gate must never disappear after client setup fails.
  let client = myoxus_infrastructure::pdf_export::ReqwestVerapdfClient::new(
    base_url,
    Duration::from_secs(config.verapdf_timeout_seconds.max(1)),
    additional_ca,
  )?;
  Ok(Some(Arc::new(client)))
}

pub struct PdfExportBlobWriterAdapter {
  pub storage: Arc<dyn BlobStoragePort>,
}

#[async_trait::async_trait]
impl myoxus_worker::PdfBlobWriter for PdfExportBlobWriterAdapter {
  async fn write_pdf(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> Result<(), String> {
    self
      .storage
      .write_blob(BlobWriteRequest {
        key: key.to_string(),
        content_type: Some(content_type.to_string()),
        body: bytes::Bytes::from(bytes),
      })
      .await
      .map_err(|e| e.to_string())
  }
}

/// Worker-facing adapter that lets the render pipeline read approved-font
/// blobs (`pdf-fonts/<sha256>.<ext>`) without depending on the application
/// crate. Mikropaket: `P-PDF-TPL-FONT-01-06`.
pub struct PdfExportFontReaderAdapter {
  pub storage: Arc<dyn BlobStoragePort>,
}

#[async_trait::async_trait]
impl myoxus_worker::PdfFontReader for PdfExportFontReaderAdapter {
  async fn read_font(&self, blob_key: &str) -> Result<Vec<u8>, String> {
    let response = self.storage.read_blob(blob_key).await.map_err(|e| e.to_string())?;
    Ok(response.data.to_vec())
  }
}

/// Worker-facing adapter for workspace blobs referenced from Yjs snapshots.
///
/// PDF export stores document media in the normal workspace blob namespace and
/// writes only the blob key into the document. Keys may contain safe nested
/// prefixes, including the server-owned `markdown-import/<doc>/` namespace.
/// The worker resolves `{workspace_id}/{blob_key}` through the production
/// BlobStoragePort before the IR builder embeds the asset.
pub struct PdfExportAssetReaderAdapter {
  pub storage: Arc<dyn BlobStoragePort>,
}

fn validate_workspace_blob_key(blob_key: &str) -> Result<BlobKey, String> {
  BlobKey::parse(blob_key).map_err(|_| format!("unsafe workspace blob key: {blob_key}"))
}

fn validate_document_brand_blob_key(blob_key: &str) -> Result<(), String> {
  let key = blob_key.trim();
  let valid_segments = key
    .split('/')
    .all(|segment| !segment.is_empty() && segment != "." && segment != "..");
  if !key.starts_with("pdf-brand/") || key.contains('\\') || !valid_segments {
    return Err(format!("unsafe document brand blob key: {blob_key}"));
  }
  Ok(())
}

#[async_trait::async_trait]
impl myoxus_worker::PdfAssetReader for PdfExportAssetReaderAdapter {
  async fn read_workspace_blob(&self, workspace_id: Uuid, blob_key: &str) -> Result<(Vec<u8>, Option<String>), String> {
    let blob_key = validate_workspace_blob_key(blob_key)?;
    let storage_key = format!("{workspace_id}/{}", blob_key.as_str());
    let response = self
      .storage
      .read_blob(&storage_key)
      .await
      .map_err(|e| format!("failed to read workspace blob {storage_key}: {e}"))?;
    Ok((response.data.to_vec(), response.content_type))
  }

  async fn read_storage_blob(&self, blob_key: &str) -> Result<(Vec<u8>, Option<String>), String> {
    validate_document_brand_blob_key(blob_key)?;
    let response = self
      .storage
      .read_blob(blob_key)
      .await
      .map_err(|e| format!("failed to read document brand blob {blob_key}: {e}"))?;
    Ok((response.data.to_vec(), response.content_type))
  }
}

/// Adapter from the worker's [`PdfExportMetrics`] trait to the shared
/// [`MetricsService`]. Emits four counter series under category
/// `pdf_export`:
///
/// | metric              | labels                                   |
/// |---------------------|------------------------------------------|
/// | `render_total`      | `outcome`, `template_id`, `error_class?` |
/// | `pages_total`       | `template_id`                            |
/// | `duration_ms_count` | `outcome`                                |
/// | `duration_ms_sum`   | `outcome`                                |
///
/// Cardinality is bounded: `outcome` × `error_class` is a fixed
/// enumeration, and `template_id` is bounded by the workspace template
/// registry. The recorder's per-metric cardinality guard (INV-MET-06)
/// remains the safety net.
pub struct PdfExportMetricsAdapter {
  pub metrics: Arc<MetricsService>,
}

impl PdfExportMetricsAdapter {
  pub fn new(metrics: Arc<MetricsService>) -> Self {
    Self { metrics }
  }
}

impl PdfExportMetrics for PdfExportMetricsAdapter {
  fn record_render(&self, outcome: PdfExportOutcome, template_id: &str, duration: Duration, error_class: Option<&str>) {
    let outcome_str = outcome.as_str();

    // 1. render_total{outcome,template_id,error_class?}
    let mut total_labels = JsonMap::with_capacity(3);
    total_labels.insert("outcome".to_string(), Value::String(outcome_str.to_string()));
    total_labels.insert("template_id".to_string(), Value::String(template_id.to_string()));
    if let Some(class) = error_class {
      total_labels.insert("error_class".to_string(), Value::String(class.to_string()));
    }
    self
      .metrics
      .record_with(MetricsCategory::PdfExport, "render_total", total_labels, 1.0);

    // 2. duration_ms_count{outcome} + 3. duration_ms_sum{outcome}
    //    The {count, sum} pair lets Prometheus rate-derive an average
    //    latency without proper histograms — adequate for a coarse SLO
    //    overview.
    let ms = duration.as_secs_f64() * 1_000.0;
    let mut dur_labels = JsonMap::with_capacity(1);
    dur_labels.insert("outcome".to_string(), Value::String(outcome_str.to_string()));
    self
      .metrics
      .record_with(MetricsCategory::PdfExport, "duration_ms_count", dur_labels.clone(), 1.0);
    self
      .metrics
      .record_with(MetricsCategory::PdfExport, "duration_ms_sum", dur_labels, ms);
  }

  fn record_pages(&self, template_id: &str, pages: usize) {
    if pages == 0 {
      return;
    }
    let mut labels = JsonMap::with_capacity(1);
    labels.insert("template_id".to_string(), Value::String(template_id.to_string()));
    self
      .metrics
      .record_with(MetricsCategory::PdfExport, "pages_total", labels, pages as f64);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_application::metrics::{InMemoryMetricsRecorder, MetricsPolicy};
  use myoxus_domain::metrics::{
    CacheTuningHistorySample, CacheTuningRecord, CacheTuningSnapshot, MetricSample, MetricsRepository,
    MetricsStoreResult,
  };
  use std::collections::HashMap;

  /// Stub repo — the recorder snapshot is the test surface; the repo never
  /// gets called because we do not invoke `flush_now`.
  #[derive(Default)]
  struct TestRepo;

  #[async_trait::async_trait]
  impl MetricsRepository for TestRepo {
    async fn insert_minute_batch(&self, samples: &[MetricSample]) -> MetricsStoreResult<u64> {
      Ok(samples.len() as u64)
    }
    async fn rollup_day(&self, _day: chrono::NaiveDate) -> MetricsStoreResult<u64> {
      Ok(0)
    }
    async fn prune_raw_before(&self, _cutoff: chrono::DateTime<chrono::Utc>) -> MetricsStoreResult<u64> {
      Ok(0)
    }
    async fn prune_daily_before(&self, _cutoff: chrono::NaiveDate) -> MetricsStoreResult<u64> {
      Ok(0)
    }
    async fn count_recent(&self, _since: chrono::DateTime<chrono::Utc>) -> MetricsStoreResult<u64> {
      Ok(0)
    }
    async fn count_daily_since(&self, _since: chrono::NaiveDate) -> MetricsStoreResult<u64> {
      Ok(0)
    }
    async fn cache_tuning_snapshot(&self, _cache_name: &str) -> MetricsStoreResult<CacheTuningSnapshot> {
      panic!("PDF metrics tests must not query cache-tuning storage")
    }
    async fn cache_tuning_history(
      &self,
      _cache_name: &str,
      _hours: i64,
    ) -> MetricsStoreResult<Vec<CacheTuningHistorySample>> {
      panic!("PDF metrics tests must not query cache-tuning storage")
    }
    async fn record_cache_tuning(&self, _record: &CacheTuningRecord) -> MetricsStoreResult<()> {
      panic!("PDF metrics tests must not write cache-tuning storage")
    }
    async fn cache_tuning_is_oscillating(&self, _cache_name: &str) -> MetricsStoreResult<bool> {
      panic!("PDF metrics tests must not query cache-tuning storage")
    }
    async fn cache_tuning_ttl_around_24h(&self, _cache_name: &str) -> MetricsStoreResult<Option<i32>> {
      panic!("PDF metrics tests must not query cache-tuning storage")
    }
    async fn prune_cache_tuning_history(&self) -> MetricsStoreResult<(u64, u64)> {
      panic!("PDF metrics tests must not prune cache-tuning storage")
    }
    async fn latest_daily_cache_ttl(&self, _cache_name: &str) -> MetricsStoreResult<Option<i32>> {
      panic!("PDF metrics tests must not query cache-tuning storage")
    }
  }

  fn build_service() -> Arc<MetricsService> {
    let mut categories = HashMap::new();
    for c in myoxus_application::metrics::METRICS_CATEGORIES {
      categories.insert((*c).to_string(), true);
    }
    let policy = MetricsPolicy {
      enabled: true,
      categories,
      label_workspace_id_enabled: false,
      cardinality_limit_per_metric: 100,
    };
    let recorder = Arc::new(InMemoryMetricsRecorder::new(policy));
    let repo: Arc<dyn MetricsRepository> = Arc::new(TestRepo);
    Arc::new(MetricsService::new(recorder, repo))
  }

  /// INV-PDFMET-01: A successful render emits exactly one
  /// `render_total{outcome=success}` sample, one each for `duration_ms_*`,
  /// and one `pages_total` proportional to the page count.
  #[test]
  fn document_brand_blob_key_accepts_only_pdf_brand_namespace() {
    assert!(validate_document_brand_blob_key("pdf-brand/00000000-0000-0000-0000-000000000000/logo-large").is_ok());
    for bad in [
      "",
      "pdf-export/ws/logo",
      "pdf-brand/ws/../secret",
      "pdf-brand/ws//logo",
      "pdf-brand\\ws\\logo",
    ] {
      assert!(
        validate_document_brand_blob_key(bad).is_err(),
        "unsafe key must be rejected: {bad}"
      );
    }
  }

  #[test]
  fn inv_pdfmet_01_success_emits_full_metric_set() {
    let svc = build_service();
    let adapter = PdfExportMetricsAdapter::new(svc.clone());
    adapter.record_render(PdfExportOutcome::Success, "default", Duration::from_millis(123), None);
    adapter.record_pages("default", 5);

    let body = svc.render_prometheus();
    assert!(body.contains("myoxus_metric_pdf_export_render_total"));
    assert!(body.contains("outcome=\"success\""));
    assert!(body.contains("template_id=\"default\""));
    assert!(body.contains("myoxus_metric_pdf_export_duration_ms_count"));
    assert!(body.contains("myoxus_metric_pdf_export_duration_ms_sum"));
    assert!(body.contains("myoxus_metric_pdf_export_pages_total"));
    // Sum should be ~123ms (loose check — the exporter prints with f64
    // precision and we want to allow tiny float drift).
    let line = body
      .lines()
      .find(|l| l.starts_with("myoxus_metric_pdf_export_duration_ms_sum"))
      .expect("duration_ms_sum line");
    assert!(line.contains(" 123"), "got: {line}");
  }

  /// INV-PDFMET-02: A failure emits `render_total` with `error_class` set
  /// and the matching outcome label, *without* a `pages_total` sample.
  #[test]
  fn inv_pdfmet_02_failure_carries_error_class_and_omits_pages() {
    let svc = build_service();
    let adapter = PdfExportMetricsAdapter::new(svc.clone());
    adapter.record_render(
      PdfExportOutcome::RenderError,
      "default",
      Duration::from_secs(1),
      Some("Timeout"),
    );

    let body = svc.render_prometheus();
    assert!(body.contains("outcome=\"render_error\""));
    assert!(body.contains("error_class=\"Timeout\""));
    assert!(
      !body.contains("myoxus_metric_pdf_export_pages_total"),
      "failure must not emit pages_total: {body}"
    );
  }

  /// INV-PDFMET-03: Zero-page success is a no-op for `pages_total` —
  /// guards against future code paths that report success on an empty
  /// document and would otherwise pollute the metric with 0-value rows.
  #[test]
  fn inv_pdfmet_03_zero_pages_does_not_emit_pages_total() {
    let svc = build_service();
    let adapter = PdfExportMetricsAdapter::new(svc.clone());
    adapter.record_pages("default", 0);
    let body = svc.render_prometheus();
    assert!(
      !body.contains("myoxus_metric_pdf_export_pages_total"),
      "zero pages must not emit pages_total: {body}"
    );
  }

  /// INV-PDFMET-04: Two renders against the same template + outcome
  /// collapse onto a single series (canonical-labels invariant). The
  /// recorder's `myoxus_metrics_active_series` gauge surfaces this.
  #[test]
  fn inv_pdfmet_04_repeat_renders_collapse_onto_one_series() {
    let svc = build_service();
    let adapter = PdfExportMetricsAdapter::new(svc.clone());
    for _ in 0..3 {
      adapter.record_render(PdfExportOutcome::Success, "default", Duration::from_millis(10), None);
    }
    // 1 series each: render_total + duration_ms_count + duration_ms_sum = 3
    assert_eq!(svc.active_series(), 3);
  }
}

/// Map the shared error once at the GraphQL boundary, preserving shipped fields.
pub fn map_pdf_error(error: myoxus_application::pdf_export::error::PdfExportError) -> async_graphql::Error {
  if let Some(authorization) = error.authorization {
    return crate::graphql::utils::map_gql_error(authorization);
  }
  let mut mapped = async_graphql::Error::new(error.message);
  if let Some(details) = error.extensions {
    let mut extensions = async_graphql::ErrorExtensionValues::default();
    for (key, value) in details.0 {
      extensions.set(
        key,
        async_graphql::Value::from_json(value).expect("PDF error details are JSON values"),
      );
    }
    mapped.extensions = Some(extensions);
  }
  mapped
}

/// Build the same shared use case for authenticated GraphQL and MCP callers.
/// The adapter captures service handles; no transport owns a duplicate PDF policy.
pub fn create_get_service(
  state: Arc<crate::state::ApiState>,
) -> myoxus_application::pdf_export::service::PdfExportService {
  use myoxus_application::pdf_export::service::{PdfExportDefaults, PdfExportService};
  let config = &state.config.pdf_export;
  PdfExportService {
    permission: state.permission_service(),
    doc: state.doc().clone(),
    jobs: state.pdf_export_jobs(),
    pdf_template_repo: state.pdf_template_repo(),
    pdf_assignment_repo: state.pdf_assignment_repo(),
    pdf_render_audit_repo: state.pdf_render_audit_repo(),
    document_version_repo: state.document_version_repo(),
    document_version_settings_repo: state.document_version_settings_repo(),
    document_metadata_policy_repo: state.document_metadata_policy_repo(),
    document_metadata_service: state.document_metadata_service(),
    audit: state.audit_recorder().clone(),
    defaults: PdfExportDefaults {
      default_paper_size: config.default_paper_size.clone(),
      default_color_profile: config.default_color_profile.clone(),
      default_image_quality: config.default_image_quality.clone(),
      heading_font_scale: config.heading_font_scale,
      body_font_scale: config.body_font_scale,
      main_web_locale: state.config.i18n.default_locale.clone(),
      max_concurrent_per_workspace: i64::from(config.limits.max_concurrent_per_workspace),
      sync_threshold_blocks: config.sync_threshold_blocks as usize,
    },
    backend: Arc::new(PdfCreateGetAdapter { state }),
  }
}

struct PdfCreateGetAdapter {
  state: Arc<crate::state::ApiState>,
}
use myoxus_application::pdf_export::{
  error::{PdfExportError, PdfExportErrorDetails, Result as PdfResult},
  service::{PdfExportBackend, PdfExportRenderRequest},
};
use myoxus_pdf_export::ir::{DEFAULT_BODY_FONT_SCALE, DEFAULT_HEADING_FONT_SCALE};
#[async_trait::async_trait]
impl PdfExportBackend for PdfCreateGetAdapter {
  fn ensure_database(&self) -> PdfResult<()> {
    self
      .state
      .metrics_pool()
      .map(|_| ())
      .ok_or_else(|| PdfExportError::new("DB unavailable"))
  }
  async fn theme(&self, workspace_id: Uuid) -> PdfResult<myoxus_application::pdf_export::dispatch::PdfThemeContext> {
    let pool = self
      .state
      .metrics_pool()
      .ok_or_else(|| PdfExportError::new("DB unavailable"))?;
    myoxus_infrastructure::pdf_export::theme::resolve_effective_pdf_theme_context(
      &pool,
      workspace_id,
      self.state.pdf_brand_repo(),
      self.state.pdf_font_repo(),
    )
    .await
  }
  async fn template(&self, selector: &str) -> PdfResult<myoxus_pdf_export::template_v2::LoadedTemplate> {
    use myoxus_pdf_export::template_v2::PdfTemplateRegistry as _;
    let template_repo = self
      .state
      .pdf_template_repo()
      .ok_or_else(|| PdfExportError::new("pdf template repository is not configured on this server"))?;
    let blob_store = self
      .state
      .pdf_blob_store()
      .ok_or_else(|| PdfExportError::new("pdf blob store is not configured on this server"))?;
    let pool = self
      .state
      .metrics_pool()
      .ok_or_else(|| PdfExportError::new("DB unavailable"))?;
    let registry = myoxus_infrastructure::pdf_export::PgPdfTemplateRegistry::new(pool, template_repo, blob_store);
    let loaded = if let Ok(id) = Uuid::parse_str(selector) {
      registry.load(id).await
    } else {
      registry.load_by_slug(selector).await
    };
    loaded.map_err(|e| {
      tracing::warn!(template_id = %selector, error = %e, "pdf export: registry load failed");
      let mut error = PdfExportError::new(format!("template registry: {e}"));
      let mut details = PdfExportErrorDetails::default();
      details.set("class", "TemplateError");
      error.extensions = Some(details);
      error
    })
  }
  async fn render(
    &self,
    request: PdfExportRenderRequest,
  ) -> PdfResult<myoxus_application::pdf_export::render::SyncRenderOutcome> {
    match self.render_source(request, None).await? {
      BackendRender::Document(outcome) => Ok(outcome),
      _ => unreachable!(),
    }
  }
  async fn render_snapshot(
    &self,
    request: PdfExportRenderRequest,
    bytes: Vec<u8>,
    created_at: chrono::DateTime<chrono::Utc>,
  ) -> PdfResult<myoxus_application::pdf_export::render::SnapshotRenderedPdf> {
    match self.render_source(request, Some((bytes, created_at))).await? {
      BackendRender::Snapshot(outcome) => Ok(outcome),
      _ => unreachable!(),
    }
  }
  async fn remove_unpublished_pdf(&self, workspace_id: Uuid, blob_id: Uuid) -> PdfResult<()> {
    self
      .state
      .blob_service()
      .delete_imported_blob(
        workspace_id,
        &myoxus_application::pdf_export::jobs::pdf_export_blob_key(blob_id),
      )
      .await
      .map_err(|_| PdfExportError::new("PDF artifact rollback failed"))
  }
  async fn enqueue(
    &self,
    payload: serde_json::Value,
    stable_job_id: Option<Uuid>,
  ) -> Result<Option<myoxus_application::pdf_export::service::PdfEnqueueOutcome>, String> {
    match self.state.redis_queue() {
      Some(queue) if stable_job_id.is_some() => queue
        .enqueue_idempotent(
          "pdf-export",
          &stable_job_id.expect("checked above").to_string(),
          "render",
          payload,
          myoxus_worker::JobOptions::default(),
        )
        .await
        .map(|(id, created)| Some(myoxus_application::pdf_export::service::PdfEnqueueOutcome { id, created }))
        .map_err(|e| e.to_string()),
      Some(queue) => queue
        .add_job("pdf-export", "render", payload, None)
        .await
        .map(|id| Some(myoxus_application::pdf_export::service::PdfEnqueueOutcome { id, created: true }))
        .map_err(|e| e.to_string()),
      None => Ok(None),
    }
  }
}

enum BackendRender {
  Document(myoxus_application::pdf_export::render::SyncRenderOutcome),
  Snapshot(myoxus_application::pdf_export::render::SnapshotRenderedPdf),
}
impl PdfCreateGetAdapter {
  async fn render_source(
    &self,
    request: PdfExportRenderRequest,
    source: Option<(Vec<u8>, chrono::DateTime<chrono::Utc>)>,
  ) -> PdfResult<BackendRender> {
    let state = &self.state;
    let workspace_uuid = request.workspace_id;
    let doc_uuid = request.doc_id;
    let input = request.input;
    let template_id = input.template_id.clone();
    let locale = input
      .locale
      .clone()
      .ok_or_else(|| PdfExportError::new("PDF dispatch locale is missing"))?;
    let paper_size = input
      .paper_size
      .clone()
      .ok_or_else(|| PdfExportError::new("PDF dispatch paper size is missing"))?;
    let toc_behavior = input.toc_behavior.as_deref().unwrap_or("off").to_owned();
    let theme_context = request.theme;
    let render_inputs = request.render_inputs;
    let sync_threshold = request.sync_threshold_blocks;
    let blob_writer: Arc<dyn myoxus_worker::PdfBlobWriter> =
      Arc::new(crate::pdf_export_adapter::PdfExportBlobWriterAdapter {
        storage: state.storage().clone(),
      });
    let font_reader: Arc<dyn myoxus_worker::PdfFontReader> =
      Arc::new(crate::pdf_export_adapter::PdfExportFontReaderAdapter {
        storage: state.storage().clone(),
      });
    let asset_reader: Arc<dyn myoxus_worker::PdfAssetReader> =
      Arc::new(crate::pdf_export_adapter::PdfExportAssetReaderAdapter {
        storage: state.storage().clone(),
      });
    let limits = crate::pdf_export_adapter::effective_pdf_limits(state)
      .await
      .map_err(|_| PdfExportError::new("PDF resource configuration is unavailable"))?;
    let static_path = crate::graphql::pdf_export::bundled_static_fonts_path();

    let pdf_metrics: Arc<dyn myoxus_worker::PdfExportMetrics> = Arc::new(
      crate::pdf_export_adapter::PdfExportMetricsAdapter::new(state.metrics_arc()),
    );
    let verapdf_client =
      crate::pdf_export_adapter::build_verapdf_client(&state.config.pdf_export, state.config.additional_ca.as_ref())
        .map_err(|_| PdfExportError::new("Configured PDF validation client initialization failed"))?;
    let doc_service = Arc::new(state.doc().clone());
    let blob_service = state.blob_service();
    let font_repository = state
      .pdf_font_repo()
      .ok_or_else(|| PdfExportError::new("PDF font repository is not configured on this server"))?;

    let template_files = match request.template_files {
      Some(files) => files,
      None => self.template(&template_id).await?.files,
    };
    let inputs = myoxus_worker::SyncRenderInputs {
      doc_service: &doc_service,
      blob_service: &blob_service,
      font_repository: &font_repository,
      blob_writer: &blob_writer,
      font_reader: Some(&font_reader),
      asset_reader: Some(&asset_reader),
      workspace_id: workspace_uuid,
      doc_id: doc_uuid,
      render_created_at: source.as_ref().map(|(_, date)| *date).unwrap_or_else(chrono::Utc::now),
      template_id: template_id.clone(),
      locale: locale.clone(),
      paper_size: paper_size.clone(),
      orientation: input.orientation.clone().unwrap_or_else(|| "portrait".to_owned()),
      heading_font_scale: input.heading_font_scale.unwrap_or(DEFAULT_HEADING_FONT_SCALE),
      body_font_scale: input.body_font_scale.unwrap_or(DEFAULT_BODY_FONT_SCALE),
      color_profile: input.color_profile.clone(),
      image_quality: input.image_quality.clone(),
      compliance_profile: input.compliance_profile.clone(),
      verapdf_client: verapdf_client.as_ref(),
      ligatures_enabled: input.ligatures_enabled.unwrap_or(theme_context.ligatures_enabled),
      toc_behavior: toc_behavior.clone(),
      footer_style: input.footer_style.clone(),
      page_numbering: input.page_numbering.clone(),
      color_variant: input.color_variant.clone(),
      cover_page: input.cover_page,
      confidentiality_label: input.confidentiality_label.clone(),
      theme_fonts: theme_context.fonts.clone(),
      theme_typography: theme_context.typography.clone(),
      native_table_palette: theme_context.native_table_palette.clone(),
      render_inputs: render_inputs.clone(),
      branding: theme_context.branding.clone(),
      doc_version_label: input.version_label.clone(),
      doc_history_id: input.doc_history_id,
      static_path: &static_path,
      limits,
      sync_threshold_blocks: if source.is_some() {
        limits.max_input_blocks
      } else {
        sync_threshold
      },
      metrics: pdf_metrics.clone(),
      template_files,
    };
    match source {
      None => Ok(BackendRender::Document(myoxus_worker::try_sync_render(inputs).await)),
      Some((bytes, _)) => {
        let started = std::time::Instant::now();
        let rendered = myoxus_worker::pdf_pipeline::render_snapshot(inputs, bytes)
          .await
          .map_err(|outcome| match outcome {
            myoxus_worker::SyncRenderOutcome::TooLargeForSync => PdfExportError::new("Answer exceeds PDF block limits"),
            myoxus_worker::SyncRenderOutcome::Failed { class, .. } => {
              PdfExportError::new(format!("Answer PDF render failed: {class}"))
            }
            _ => PdfExportError::new("Unexpected PDF render outcome"),
          })?;
        pdf_metrics.record_render(PdfExportOutcome::Success, &template_id, started.elapsed(), None);
        pdf_metrics.record_pages(&template_id, rendered.page_count);
        Ok(BackendRender::Snapshot(rendered))
      }
    }
  }
}
