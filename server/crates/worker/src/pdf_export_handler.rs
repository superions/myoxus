// SPDX-License-Identifier: AGPL-3.0-or-later
//! Worker handler for the `pdf-export` queue.
//!
//! Picks up queued PDF export jobs, renders the Yjs document to PDF via the
//! `myoxus-pdf-export` pipeline, persists the result via [`PdfBlobWriter`],
//! and updates the `pdf_export_jobs` row.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use myoxus_application::{
  doc::DocService,
  pdf_export::jobs::{PdfExportJobCompletion, PdfExportJobStore},
  ports::blob_service::BlobService,
};
use myoxus_domain::repositories::PdfFontRepository;

use myoxus_pdf_export::{
  EdgelessSnapshotLimits,
  error::{IrBuildError, RenderError},
  ir::{
    Branding, DEFAULT_BODY_FONT_SCALE, DEFAULT_HEADING_FONT_SCALE, DocumentMetadata, ExportOptions, NativeTablePalette,
    ThemeFontSelection, ThemeTypographySelection,
  },
  render_v2::pdfa::VerapdfClient,
  template_v2::PdfTemplateRegistry,
};

use crate::job::{Job, JobError};
use crate::pdf_export_metrics::{NoopPdfExportMetrics, PdfExportMetrics, PdfExportOutcome};
use crate::pdf_pipeline;
use crate::runtime::JobHandler;

/// Queue name consumed by this handler.
pub const PDF_EXPORT_QUEUE: &str = "pdf-export";

/// Physical object key for the PDF writer, using the normal workspace prefix.
/// Blob registry rows store only the relative `pdf-export/<blob_id>` key.
pub fn pdf_export_storage_key(workspace_id: Uuid, blob_id: Uuid) -> String {
  format!(
    "{workspace_id}/{}",
    myoxus_application::pdf_export::jobs::pdf_export_blob_key(blob_id)
  )
}

/// Resource limits enforced by [`PdfExportJobHandler`].
///
/// Defined in the worker crate (rather than depending on `myoxus-api`'s config
/// types) so the worker stays free of api/application dependencies.  The api
/// crate constructs a `PdfExportLimits` from `AppConfig::pdf_export.limits`
/// at handler-registration time.
#[derive(Debug, Clone, Copy)]
pub struct PdfExportLimits {
  /// Maximum block count the IR builder will visit before erroring out.
  pub max_input_blocks: usize,
  /// Maximum compiled-document page count.
  pub max_pages: usize,
  /// Wall-clock timeout for the synchronous render phase.
  pub render_timeout: Duration,
  /// Per-compiler address-space budget from the existing server setting (MiB).
  pub max_memory_mb: u32,
  /// Bounds for Edgeless canvas snapshots before they are embedded.
  pub snapshot_limits: EdgelessSnapshotLimits,
}

impl Default for PdfExportLimits {
  fn default() -> Self {
    Self {
      max_input_blocks: 10_000,
      max_pages: 500,
      render_timeout: Duration::from_secs(120),
      max_memory_mb: myoxus_pdf_export::execution::DEFAULT_MEMORY_MB,
      snapshot_limits: EdgelessSnapshotLimits::DEFAULT,
    }
  }
}

/// Resolves one coherent server-owned resource snapshot at job execution time.
#[async_trait]
pub trait PdfExportLimitsProvider: Send + Sync {
  async fn current_limits(&self) -> Result<PdfExportLimits, String>;
}

/// Thin abstraction over the object-store write path used by the PDF worker.
///
/// Defined in the worker crate (rather than depending on the heavyweight
/// `myoxus-application` ports module) so that this crate stays decoupled from
/// the application layer.  The api crate wires a concrete adapter that
/// delegates to the production [`BlobStoragePort`] implementation.
#[async_trait]
pub trait PdfBlobWriter: Send + Sync {
  /// Persist `bytes` at the given object-store key with the given MIME type.
  ///
  /// Implementations must perform an atomic write — partial writes must be
  /// either committed in full or surfaced as `Err`.
  async fn write_pdf(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> Result<(), String>;
}

/// Thin abstraction over the object-store read path for the admin font
/// library (`pdf-fonts/<sha256>.<ext>` blobs).
///
/// Used by the render pipeline to materialize approved fonts into a temp
/// directory before invoking the Typst world. Defined in the worker crate
/// (alongside [`PdfBlobWriter`]) so neither callers nor pdf_export need to
/// depend on the application or infrastructure crates. The api crate wires
/// a concrete adapter that delegates to the production opendal `Operator`.
///
/// Mikropaket: `P-PDF-TPL-FONT-01-06`.
#[async_trait]
pub trait PdfFontReader: Send + Sync {
  /// Read the font binary stored at `blob_key`. Returns the raw bytes
  /// untouched (no decompression — the renderer handles WOFF2). Errors are
  /// returned as opaque strings so the caller can decide whether to skip
  /// the missing font (best-effort) or fail the render.
  async fn read_font(&self, blob_key: &str) -> Result<Vec<u8>, String>;
}

/// Read workspace-owned binary assets referenced by the document snapshot.
///
/// Edgeless PDF export writes `exportSnapshotBlobId` onto the Yjs surface
/// block. The IR builder must resolve that key against the same workspace
/// blob namespace as normal uploads (`{workspace_id}/{blob_key}`); otherwise
/// every real canvas export degenerates into the "Canvas snapshot not
/// available" placeholder. Keeping this as a tiny worker trait avoids pulling
/// the application storage port into the worker crate.
#[async_trait]
pub trait PdfAssetReader: Send + Sync {
  async fn read_workspace_blob(&self, workspace_id: Uuid, blob_key: &str) -> Result<(Vec<u8>, Option<String>), String>;

  /// Read a vetted non-workspace-prefixed storage blob. This is used for
  /// document-branding assets whose canonical key already contains the
  /// `pdf-brand/<workspace_id>/...` namespace. Implementations must reject
  /// arbitrary paths; the default keeps test readers conservative.
  async fn read_storage_blob(&self, blob_key: &str) -> Result<(Vec<u8>, Option<String>), String> {
    Err(format!("storage blob reads are not supported for key {blob_key}"))
  }
}

/// Worker handler for PDF export jobs.
///
/// Receives jobs from the `pdf-export` Redis queue, renders the Yjs document
/// binary to PDF bytes via `myoxus-pdf-export`, writes the output via
/// [`PdfBlobWriter`], and updates `pdf_export_jobs` accordingly.
pub struct PdfExportJobHandler {
  pub job_store: Arc<dyn PdfExportJobStore>,
  pub doc_service: Arc<DocService>,
  pub blob_service: Arc<BlobService>,
  pub font_repository: Arc<dyn PdfFontRepository>,
  /// Filesystem root used by the Typst world (fonts, assets).
  pub static_path: PathBuf,
  /// Object-store sink for the rendered PDF bytes.
  pub blob_writer: Arc<dyn PdfBlobWriter>,
  /// Object-store source for admin-library fonts. `None` disables the
  /// approved-font materialization step (e.g. unit tests that don't have
  /// opendal wired). When `Some`, only fonts with `license_status =
  /// 'approved'` are loaded into the renderer's font book.
  pub font_reader: Option<Arc<dyn PdfFontReader>>,
  /// Workspace blob reader for document assets such as Edgeless raster
  /// snapshots. `None` is only acceptable for unit tests that intentionally
  /// exercise placeholder behaviour.
  pub asset_reader: Option<Arc<dyn PdfAssetReader>>,
  /// Per-export resource limits.
  pub limits: PdfExportLimits,
  /// Production uses the shared live server configuration; explicit standalone
  /// callers retain the supplied limits when no provider is installed.
  pub limits_provider: Option<Arc<dyn PdfExportLimitsProvider>>,
  /// Observability hook for render outcomes — defaults to a no-op so the
  /// worker stays functional even when the api crate has not wired a real
  /// adapter. The api crate replaces this with an adapter that delegates
  /// into `MetricsService` (category `pdf_export`).
  pub metrics: Arc<dyn PdfExportMetrics>,
  /// V2 PDF template registry (`P-PDF-TPL-13`). Used to load the
  /// theme.typ + preamble.typ + i18n bundle for the requested
  /// template before each render call. The api crate constructs this
  /// from the same `PgPdfTemplateRepository` + `PdfBlobStore` that
  /// the admin GraphQL surface uses.
  pub template_registry: Arc<dyn PdfTemplateRegistry>,
  /// Optional external veraPDF client for requested PDF/A or PDF/UA profiles. `None`
  /// keeps normal and native-only PDF renders available in local/dev stacks
  /// that do not run the validator container.
  pub verapdf_client: Option<Arc<dyn VerapdfClient>>,
}

impl PdfExportJobHandler {
  /// Construct a handler with a no-op metrics hook and no font reader. The
  /// api crate replaces those fields via direct assignment (struct is
  /// `pub`) immediately after construction.
  #[expect(
    clippy::too_many_arguments,
    reason = "the worker constructor exposes all mandatory runtime capabilities"
  )]
  pub fn new(
    job_store: Arc<dyn PdfExportJobStore>,
    doc_service: Arc<DocService>,
    blob_service: Arc<BlobService>,
    font_repository: Arc<dyn PdfFontRepository>,
    static_path: PathBuf,
    blob_writer: Arc<dyn PdfBlobWriter>,
    limits: PdfExportLimits,
    template_registry: Arc<dyn PdfTemplateRegistry>,
  ) -> Self {
    Self {
      job_store,
      doc_service,
      blob_service,
      font_repository,
      static_path,
      blob_writer,
      font_reader: None,
      asset_reader: None,
      limits,
      limits_provider: None,
      metrics: Arc::new(NoopPdfExportMetrics),
      template_registry,
      verapdf_client: None,
    }
  }
}

#[async_trait]
impl JobHandler for PdfExportJobHandler {
  fn queue_name(&self) -> &str {
    PDF_EXPORT_QUEUE
  }

  // NOTE: #[instrument] cannot be used here because YjsIrBuilder holds yrs types
  // (NonNull pointers) that are not Send/Sync, making the instrumented future
  // non-Send. Structured logging is emitted manually via debug!/info!/warn!/error!.
  async fn process(&self, job: &Job) -> Result<Option<serde_json::Value>, JobError> {
    // --- 1. Parse job payload ---
    let job_id_str = job
      .data
      .get("job_id")
      .and_then(|v| v.as_str())
      .ok_or_else(|| JobError::Permanent("missing job_id in payload".into()))?;
    let job_uuid = Uuid::parse_str(job_id_str).map_err(|e| JobError::Permanent(format!("invalid job_id UUID: {e}")))?;

    let workspace_id_str = job
      .data
      .get("workspace_id")
      .and_then(|v| v.as_str())
      .ok_or_else(|| JobError::Permanent("missing workspace_id in payload".into()))?;
    let workspace_uuid =
      Uuid::parse_str(workspace_id_str).map_err(|e| JobError::Permanent(format!("invalid workspace_id UUID: {e}")))?;

    let doc_id_str = job
      .data
      .get("doc_id")
      .and_then(|v| v.as_str())
      .ok_or_else(|| JobError::Permanent("missing doc_id in payload".into()))?;
    let doc_uuid = Uuid::parse_str(doc_id_str).map_err(|e| JobError::Permanent(format!("invalid doc_id UUID: {e}")))?;

    let template_id = job
      .data
      .get("template_id")
      .and_then(|v| v.as_str())
      .unwrap_or("default")
      .to_string();

    let render_inputs_val = job.data.get("render_inputs").cloned().unwrap_or_default();
    let locale = render_inputs_val
      .get("locale")
      .and_then(|v| v.as_str())
      .unwrap_or("en")
      .to_string();
    let paper_size = render_inputs_val
      .get("paper_size")
      .and_then(|v| v.as_str())
      .unwrap_or("A4")
      .to_string();
    let orientation = render_inputs_val
      .get("orientation")
      .and_then(|v| v.as_str())
      .unwrap_or("portrait")
      .to_string();
    let heading_font_scale = render_inputs_val
      .get("heading_font_scale")
      .and_then(|v| v.as_f64())
      .unwrap_or(DEFAULT_HEADING_FONT_SCALE);
    let body_font_scale = render_inputs_val
      .get("body_font_scale")
      .and_then(|v| v.as_f64())
      .unwrap_or(DEFAULT_BODY_FONT_SCALE);
    let toc_behavior = render_inputs_val
      .get("toc_behavior")
      .and_then(|v| v.as_str())
      .unwrap_or("off")
      .to_string();
    let cover_page = render_inputs_val.get("cover_page").and_then(|v| v.as_bool());
    let confidentiality_label = render_inputs_val
      .get("confidentiality_label")
      .and_then(|v| v.as_str())
      .map(str::trim)
      .filter(|v| !v.is_empty())
      .map(str::to_string);
    let color_profile = render_inputs_val
      .get("color_profile")
      .and_then(|v| v.as_str())
      .map(str::trim)
      .filter(|v| !v.is_empty())
      .unwrap_or("sRGB")
      .to_string();
    let image_quality = render_inputs_val
      .get("image_quality")
      .and_then(|v| v.as_str())
      .map(str::trim)
      .filter(|v| !v.is_empty())
      .unwrap_or("high")
      .to_string();
    let compliance_profile = render_inputs_val
      .get("compliance_profile")
      .and_then(|v| v.as_str())
      .map(str::trim)
      .filter(|v| !v.is_empty())
      .map(str::to_string);
    let requested_compliance_profile = compliance_profile.clone();
    let ligatures_enabled = render_inputs_val
      .get("ligatures_enabled")
      .and_then(|v| v.as_bool())
      .unwrap_or(true);
    let theme_fonts = theme_fonts_from_render_inputs(&render_inputs_val);
    let theme_typography = match theme_typography_from_render_inputs(&render_inputs_val) {
      Ok(value) => value,
      Err(detail) => {
        warn!(job_id = %job_uuid, error = %detail, "pdf export: persisted theme typography is invalid");
        self.mark_failed(job_uuid, "ConfigurationError", &detail).await;
        return Err(JobError::Permanent(detail));
      }
    };
    let branding = branding_from_render_inputs(&render_inputs_val);
    let native_table_palette = match native_table_palette_from_render_inputs(&render_inputs_val) {
      Ok(value) => value,
      Err(detail) => {
        warn!(job_id = %job_uuid, "pdf export: persisted native table palette is invalid");
        self.mark_failed(job_uuid, "ConfigurationError", &detail).await;
        return Err(JobError::Permanent(detail));
      }
    };
    let doc_version_label: Option<String> = render_inputs_val
      .get("version_label")
      .and_then(|v| v.as_str())
      .map(|s| s.to_string());
    let doc_history_id: Option<i64> = render_inputs_val.get("doc_history_id").and_then(|v| v.as_i64());

    debug!(
      job_id = %job_uuid,
      workspace_id = %workspace_uuid,
      doc_id = %doc_uuid,
      template_id = %template_id,
      "pdf export worker: processing job"
    );

    // Capture start time for the duration metric. Measured against the
    // entire job-processing path (DB transitions + render + blob write)
    // rather than just the typst compile, so the metric reflects the
    // user-observable wall-clock cost.
    let started_at = std::time::Instant::now();

    // --- 2. Mark job as running ---
    let render_created_at = match self.job_store.claim_queued(job_uuid).await {
      Ok(Some(created_at)) => created_at,
      Ok(None) => {
        info!(job_id = %job_uuid, "pdf export: job no longer queued, skipping render");
        return Ok(Some(serde_json::json!({
          "job_id": job_uuid,
          "skipped": true,
          "reason": "not_queued"
        })));
      }
      Err(e) => {
        warn!(job_id = %job_uuid, error = %e, "pdf export: failed to mark job running (possible concurrent worker)");
        return Err(JobError::Retryable(format!("DB update failed: {e}")));
      }
    };

    let limits = match &self.limits_provider {
      Some(provider) => match provider.current_limits().await {
        Ok(limits) => limits,
        Err(_) => {
          self
            .mark_failed(job_uuid, "RenderError", "PDF resource configuration is unavailable")
            .await;
          return Err(JobError::Permanent("PDF resource configuration is unavailable".into()));
        }
      },
      None => self.limits,
    };

    // --- 3. Fetch Yjs binary via the shared pipeline.
    //    Normal exports merge the compacted snapshot with pending
    //    `doc_updates`, matching the regular document read path so freshly
    //    edited pages render before compaction runs.
    let loaded_binary = if let Some(history_id) = doc_history_id {
      pdf_pipeline::load_doc_history_binary(&self.doc_service, workspace_uuid, doc_uuid, history_id).await
    } else {
      pdf_pipeline::load_doc_binary(&self.doc_service, workspace_uuid, doc_uuid).await
    };
    let yjs_binary = match loaded_binary {
      Ok(b) => b,
      Err(e) => {
        self.mark_failed(job_uuid, "StorageError", &e).await;
        self.metrics.record_render(
          PdfExportOutcome::StorageError,
          &template_id,
          started_at.elapsed(),
          Some("StorageError"),
        );
        return Err(JobError::Permanent(format!("doc fetch failed: {e}")));
      }
    };

    let yjs_binary = match myoxus_application::pdf_export::render::document_field_snapshot(
      yjs_binary,
      workspace_uuid,
      doc_uuid,
      doc_history_id.is_some(),
      &render_inputs_val,
    ) {
      Ok(snapshot) => snapshot,
      Err(error) => {
        let class = pdf_pipeline::document_field_error_class(error);
        self
          .mark_failed(job_uuid, class, "PDF document field context unavailable")
          .await;
        self.metrics.record_render(
          PdfExportOutcome::IrError,
          &template_id,
          started_at.elapsed(),
          Some(class),
        );
        return Err(JobError::Permanent("PDF document field context unavailable".into()));
      }
    };

    // --- 4. Build IR (shared pipeline drives the !Send YjsIrBuilder via
    //    block_in_place).
    let mut metadata = DocumentMetadata {
      doc_id: doc_uuid,
      workspace_id: workspace_uuid,
      title: None,
      author: None,
      created_at: Some(render_created_at),
      updated_at: Some(render_created_at),
      workspace_name: branding.organization_name.clone(),
      branding,
    };
    crate::pdf_pipeline::apply_document_attribution(&mut metadata, &render_inputs_val);
    let options = ExportOptions {
      template_id: template_id.clone(),
      locale: locale.clone(),
      paper_size: paper_size.clone(),
      orientation,
      heading_font_scale,
      body_font_scale,
      toc_behavior: toc_behavior.clone(),
      footer_style: render_inputs_val
        .get("footer_style")
        .and_then(|v| v.as_str())
        .map(str::to_owned),
      page_numbering: render_inputs_val
        .get("page_numbering")
        .and_then(|v| v.as_str())
        .map(str::to_owned),
      color_variant: render_inputs_val
        .get("color_variant")
        .and_then(|v| v.as_str())
        .map(str::to_owned),
      cover_page,
      confidentiality_label,
      theme_fonts,
      theme_typography,
      native_table_palette,
      color_profile: Some(color_profile),
      image_quality: Some(image_quality),
      compliance_profile,
      ligatures_enabled,
      doc_version_label,
      keywords: Vec::new(),
      template_vars: pdf_pipeline::template_vars_from_render_inputs(&render_inputs_val),
    };

    let (mut ir_doc, renderer_diagnostics) = match pdf_pipeline::build_ir_with_diagnostics(
      yjs_binary,
      metadata,
      options,
      limits.max_input_blocks,
      self.asset_reader.as_ref(),
    ) {
      Ok(d) => d,
      Err(e) => {
        let (class, detail) = ir_error_to_class(&e);
        error!(job_id = %job_uuid, error = %e, class = %class, "pdf export: IR build failed");
        self.mark_failed(job_uuid, class, &detail).await;
        self.metrics.record_render(
          PdfExportOutcome::IrError,
          &template_id,
          started_at.elapsed(),
          Some(class),
        );
        return Err(JobError::Permanent(format!("ir build failed: {detail}")));
      }
    };
    if let Err(pe) = pdf_pipeline::attach_document_brand_assets(&mut ir_doc, self.asset_reader.as_ref()).await {
      error!(
        job_id = %job_uuid,
        class = %pe.class,
        detail = %pe.detail,
        "pdf export: document brand asset materialization failed"
      );
      self
        .mark_failed_with_diagnostics(job_uuid, pe.class, &pe.detail, Some(&renderer_diagnostics))
        .await;
      self.metrics.record_render(
        PdfExportOutcome::RenderError,
        &template_id,
        started_at.elapsed(),
        Some(pe.class),
      );
      return Err(JobError::Permanent(format!(
        "document brand asset materialization failed: {}",
        pe.detail
      )));
    }

    // --- 5. Resolve template bundle via the V2 registry.
    //         `template_id` may be either a slug (`"default"`/`"report"`/
    //         `"letter"`) or a UUID (admin-uploaded templates).
    let loaded_template = if let Ok(tpl_uuid) = Uuid::parse_str(&template_id) {
      self.template_registry.load(tpl_uuid).await
    } else {
      self.template_registry.load_by_slug(&template_id).await
    };
    let loaded_template = match loaded_template {
      Ok(t) => t,
      Err(e) => {
        let detail = format!("template registry: {e}");
        error!(job_id = %job_uuid, template_id = %template_id, error = %e,
          "pdf export: template registry load failed");
        self
          .mark_failed_with_diagnostics(job_uuid, "TemplateError", &detail, Some(&renderer_diagnostics))
          .await;
        self.metrics.record_render(
          PdfExportOutcome::RenderError,
          &template_id,
          started_at.elapsed(),
          Some("TemplateError"),
        );
        return Err(JobError::Permanent(detail));
      }
    };

    // --- 6. Render IR to PDF (shared supervised compiler owner).
    //         Approved-font materialization runs first so the tempdir lives
    //         at least until render_with_timeout completes; pending/rejected
    //         fonts never reach TypstWorld.
    let pinned_dir = match crate::font_materializer::materialize_pinned_theme_font_assets(
      &self.static_path,
      self.font_reader.as_ref(),
      &render_inputs_val,
    )
    .await
    {
      Ok(dir) => dir,
      Err(detail) => {
        error!(
          job_id = %job_uuid,
          detail = %detail,
          "pdf export: pinned theme font asset validation failed"
        );
        self
          .mark_failed_with_diagnostics(job_uuid, "AssetError", &detail, Some(&renderer_diagnostics))
          .await;
        self.metrics.record_render(
          PdfExportOutcome::RenderError,
          &template_id,
          started_at.elapsed(),
          Some("AssetError"),
        );
        return Err(JobError::Permanent(format!(
          "theme font asset validation failed: {detail}"
        )));
      }
    };
    let approved_dir =
      crate::font_materializer::materialize_approved_fonts(&self.font_repository, self.font_reader.as_ref()).await;
    let materialized_fonts = [pinned_dir, approved_dir].into_iter().flatten().collect();

    let pdf_pipeline::RenderOutput {
      pdf_bytes,
      page_count,
      unmapped_font_families,
    } = match pdf_pipeline::render_with_timeout(
      ir_doc,
      loaded_template.files,
      self.static_path.clone(),
      materialized_fonts,
      limits,
    )
    .await
    {
      Ok(out) => out,
      Err(pe) => {
        error!(
          job_id = %job_uuid,
          class = %pe.class,
          "pdf export: render failed"
        );
        self
          .mark_failed_with_diagnostics(job_uuid, pe.class, &pe.detail, Some(&renderer_diagnostics))
          .await;
        self.metrics.record_render(
          PdfExportOutcome::RenderError,
          &template_id,
          started_at.elapsed(),
          Some(pe.class),
        );
        // The queue runtime logs Permanent messages. Keep source diagnostics in
        // the protected PDF job detail, never in that outer log/history message.
        return Err(JobError::Permanent(format!("render failed ({})", pe.class)));
      }
    };

    if let Err(pe) = pdf_pipeline::validate_compliance_if_requested(
      &pdf_bytes,
      requested_compliance_profile.as_deref(),
      self.verapdf_client.as_ref(),
    )
    .await
    {
      error!(
        job_id = %job_uuid,
        class = %pe.class,
        detail = %pe.detail,
        "pdf export: external PDF conformance validation failed"
      );
      self
        .mark_failed_with_diagnostics(job_uuid, pe.class, &pe.detail, Some(&renderer_diagnostics))
        .await;
      self.metrics.record_render(
        PdfExportOutcome::RenderError,
        &template_id,
        started_at.elapsed(),
        Some(pe.class),
      );
      return Err(JobError::Permanent(format!("{}: {}", pe.class, pe.detail)));
    }

    // --- 6. Store PDF: bytes to opendal first, SQL row second.
    //
    // Order matters. If the SQL row is committed but the blob bytes are
    // never written, the download handler will return placeholder bytes
    // forever (the row says `done` but `read_blob` returns NotFound).
    // Writing bytes first means: on a failure between the two steps the
    // blob is orphaned (cleaned up by the nightly sweep) but the user
    // sees a `failed` job — never a successful job that can't download.
    let blob_id = Uuid::new_v4();
    let storage_key = pdf_export_storage_key(workspace_uuid, blob_id);

    if let Err(e) = self
      .blob_writer
      .write_pdf(&storage_key, pdf_bytes.clone(), "application/pdf")
      .await
    {
      error!(job_id = %job_uuid, error = %e, key = %storage_key, "pdf export: opendal write_pdf failed");
      self
        .mark_failed_with_diagnostics(job_uuid, "StorageError", &e, Some(&renderer_diagnostics))
        .await;
      self.metrics.record_render(
        PdfExportOutcome::StorageError,
        &template_id,
        started_at.elapsed(),
        Some("StorageError"),
      );
      return Err(JobError::Permanent(format!("blob write failed: {e}")));
    }

    if let Err(e) = self
      .blob_service
      .register_completed_blob(
        workspace_uuid,
        &myoxus_application::pdf_export::jobs::pdf_export_blob_key(blob_id),
        pdf_bytes.len() as u64,
        "application/pdf",
      )
      .await
    {
      let msg = e.to_string();
      error!(job_id = %job_uuid, error = %msg, "pdf export: blob row insert failed");
      self
        .mark_failed_with_diagnostics(job_uuid, "StorageError", &msg, Some(&renderer_diagnostics))
        .await;
      self.metrics.record_render(
        PdfExportOutcome::StorageError,
        &template_id,
        started_at.elapsed(),
        Some("StorageError"),
      );
      return Err(JobError::Permanent(format!("blob insert failed: {msg}")));
    }

    // --- 7. Mark job done ---
    let page_count_i32: i32 = i32::try_from(page_count).unwrap_or(i32::MAX);
    let done_result = self
      .job_store
      .complete(&PdfExportJobCompletion {
        renderer_diagnostics,
        id: job_uuid,
        output_blob_id: blob_id,
        page_count: page_count_i32,
        unmapped_font_families: unmapped_font_families.clone(),
      })
      .await;

    if let Err(e) = done_result {
      let msg = e.to_string();
      error!(job_id = %job_uuid, error = %msg, "pdf export: failed to mark job done");
      return Err(JobError::Retryable(format!("failed to update job to done: {msg}")));
    }

    self
      .metrics
      .record_render(PdfExportOutcome::Success, &template_id, started_at.elapsed(), None);
    self.metrics.record_pages(&template_id, page_count);

    info!(
      job_id = %job_uuid,
      workspace_id = %workspace_uuid,
      doc_id = %doc_uuid,
      blob_id = %blob_id,
      pdf_bytes = pdf_bytes.len(),
      pages = page_count,
      "pdf export job completed successfully"
    );

    Ok(Some(serde_json::json!({
      "blob_id": blob_id.to_string(),
      "size": pdf_bytes.len(),
      "pages": page_count,
    })))
  }
}

impl PdfExportJobHandler {
  /// Update the job to `failed` status with error details.
  pub async fn mark_failed(&self, job_uuid: Uuid, error_class: &str, error_detail: &str) {
    self
      .mark_failed_with_diagnostics(job_uuid, error_class, error_detail, None)
      .await;
  }

  async fn mark_failed_with_diagnostics(
    &self,
    job_uuid: Uuid,
    error_class: &str,
    error_detail: &str,
    renderer_diagnostics: Option<&serde_json::Value>,
  ) {
    let result = self
      .job_store
      .fail(job_uuid, error_class, error_detail, renderer_diagnostics)
      .await;

    if let Err(e) = result {
      error!(job_id = %job_uuid, error = %e, "pdf export: failed to mark job as failed in DB");
    }
  }
}

fn theme_fonts_from_render_inputs(render_inputs: &serde_json::Value) -> ThemeFontSelection {
  let get = |role: &str| -> Option<String> {
    render_inputs
      .get("theme_fonts")
      .and_then(|value| value.get(role))
      .and_then(|value| value.as_str())
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(str::to_owned)
  };
  ThemeFontSelection {
    heading: get("heading"),
    body: get("body"),
    mono: get("mono"),
    symbol: get("symbol"),
  }
}

fn theme_typography_from_render_inputs(render_inputs: &serde_json::Value) -> Result<ThemeTypographySelection, String> {
  let Some(value) = render_inputs.get("theme_typography") else {
    // Bounded compatibility for jobs queued before theme typography metrics
    // became part of the persisted render contract.
    return Ok(ThemeTypographySelection::default());
  };
  serde_json::from_value(value.clone()).map_err(|error| format!("invalid theme_typography render input: {error}"))
}

fn native_table_palette_from_render_inputs(
  render_inputs: &serde_json::Value,
) -> Result<Option<NativeTablePalette>, String> {
  // Missing data belongs to already queued jobs, not a reason to resolve today's theme.
  serde_json::from_value(render_inputs.get("native_table_palette").cloned().unwrap_or_default())
    .map_err(|error| format!("invalid native_table_palette render input: {error}"))
}

fn branding_from_render_inputs(render_inputs: &serde_json::Value) -> Branding {
  let document_branding = render_inputs.get("document_branding");
  let get = |snake_key: &str, camel_key: &str| -> Option<String> {
    document_branding
      .and_then(|value| value.get(snake_key).or_else(|| value.get(camel_key)))
      .and_then(|value| value.as_str())
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(str::to_owned)
  };
  Branding {
    organization_name: get("organization_name", "organizationName"),
    footer_text: get("footer_text", "footerText"),
    legal_text: get("legal_text", "legalText"),
    logo_large_blob: get("logo_large_blob", "logoLargeBlob"),
    logo_large_sha256: get("logo_large_sha256", "logoLargeSha256"),
    logo_small_blob: get("logo_small_blob", "logoSmallBlob"),
    logo_small_sha256: get("logo_small_sha256", "logoSmallSha256"),
    logo_large_path: get("logo_large_path", "logoLargePath"),
    logo_small_path: get("logo_small_path", "logoSmallPath"),
    color_policy: get("color_policy", "colorPolicy"),
    color_palette_key: get("color_palette_key", "colorPaletteKey"),
    primary: get("primary", "primary"),
    accent: get("accent", "accent"),
    rule: get("rule", "rule"),
    text_primary: get("text_primary", "textPrimary"),
    background: get("background", "background"),
    code_background: get("code_background", "codeBackground"),
  }
}

/// Map an [`IrBuildError`] to a stable `error_class` plus a human-readable
/// detail. The class is the contract surfaced to the client (see
/// `docs/dev/server/api-reference.md` and the P7 error UX matrix); the detail
/// is best-effort log/admin context only.
pub fn ir_error_to_class(err: &IrBuildError) -> (&'static str, String) {
  match err {
    IrBuildError::BlockLimitExceeded { count, max } => ("TooLarge", format!("document has {count} blocks (max {max})")),
    IrBuildError::UnsupportedVersion { found, min, max } => (
      "TemplateError",
      format!("unsupported IR version {found} (supported {min}-{max})"),
    ),
    IrBuildError::YjsDecode(msg) => ("DecodeError", msg.clone()),
    IrBuildError::MissingField { block_id, field } => {
      ("DecodeError", format!("block {block_id} missing field '{field}'"))
    }
    IrBuildError::Asset(msg) => ("AssetError", msg.clone()),
    IrBuildError::LocalNote(reason) => ("DecodeError", reason.clone()),
    IrBuildError::InvalidTablePaint => ("DecodeError", err.to_string()),
  }
}

/// Map a [`RenderError`] to a stable `error_class` plus detail.
pub fn render_error_to_class(err: &RenderError) -> (&'static str, String) {
  match err {
    RenderError::PageLimit { count, max } => ("TooLarge", format!("document compiled to {count} pages (max {max})")),
    RenderError::Timeout { secs } => ("Timeout", format!("render exceeded {secs}s")),
    RenderError::MemoryLimit => ("TooLarge", "render exceeded memory limit".into()),
    RenderError::FontNotFound { name } => ("TemplateError", format!("font '{name}' not available")),
    RenderError::SnapshotLimitExceeded(reason) => ("TooLarge", format!("edgeless snapshot exceeds limits: {reason}")),
    RenderError::UnsupportedComplianceProfile { profile } => (
      "UnsupportedComplianceProfile",
      format!("unsupported pdf compliance profile '{profile}'"),
    ),
    RenderError::PdfaValidationFailed(detail) => ("PdfaValidationFailed", detail.clone()),
    RenderError::PdfuaValidationFailed(detail) => ("PdfuaValidationFailed", detail.clone()),
    RenderError::Compilation(msg) => ("RenderError", msg.clone()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn queued_theme_snapshot_preserves_optional_paint_and_legacy_typography() {
    let render_inputs = serde_json::json!({
      "theme_typography": {
        "body": {
          "font_weight": 400,
          "font_style": "normal",
          "size_px": 14.0,
          "line_height": 1.55,
          "letter_spacing_em": 0.0
        }
      }
    });

    let typography = theme_typography_from_render_inputs(&render_inputs).expect("legacy queued typography");
    let body = typography.body.expect("body role");
    assert_eq!(body.text_transform, "none");
    assert_eq!(body.decoration, "none");
    assert!(
      native_table_palette_from_render_inputs(&render_inputs)
        .expect("legacy queued palette")
        .is_none()
    );

    let current = serde_json::json!({
      "native_table_palette": {
        "--myoxus-sem-status-success-paper": { "fill": "#c7e5d2", "foreground": "#000000" }
      },
      "theme_typography": {
        "body": {
          "font_weight": 400,
          "font_style": "normal",
          "size_px": 14.0,
          "line_height": 1.55,
          "letter_spacing_em": 0.0,
          "text_transform": "lowercase",
          "decoration": "line-through"
        }
      }
    });
    let palette = native_table_palette_from_render_inputs(&current)
      .expect("captured palette")
      .expect("present palette");
    assert_eq!(palette["--myoxus-sem-status-success-paper"].fill, "#c7e5d2");
    let current = theme_typography_from_render_inputs(&current).expect("current queued typography");
    let current_body = current.body.expect("current body role");
    assert_eq!(current_body.text_transform, "lowercase");
    assert_eq!(current_body.decoration, "line-through");
  }

  #[test]
  fn branding_from_render_inputs_reads_full_document_branding_contract() {
    let value = serde_json::json!({
      "document_branding": {
        "organizationName": "Acme GmbH",
        "footerText": "Footer",
        "legalText": "Legal",
        "logoLargeBlob": "pdf-brand/ws/large",
        "logoLargeSha256": "sha-large",
        "logoSmallBlob": "pdf-brand/ws/small",
        "logoSmallSha256": "sha-small",
        "logoLargePath": "blob:large",
        "logoSmallPath": "blob:small",
        "colorPolicy": "custom",
        "colorPaletteKey": null,
        "primary": "#111111",
        "accent": "#222222",
        "rule": "#444444",
        "textPrimary": "#333333",
        "background": "#ffffff",
        "codeBackground": "#e4e4e7"
      }
    });
    let branding = branding_from_render_inputs(&value);
    assert_eq!(branding.organization_name.as_deref(), Some("Acme GmbH"));
    assert_eq!(branding.footer_text.as_deref(), Some("Footer"));
    assert_eq!(branding.legal_text.as_deref(), Some("Legal"));
    assert_eq!(branding.logo_large_blob.as_deref(), Some("pdf-brand/ws/large"));
    assert_eq!(branding.logo_large_sha256.as_deref(), Some("sha-large"));
    assert_eq!(branding.logo_small_blob.as_deref(), Some("pdf-brand/ws/small"));
    assert_eq!(branding.logo_small_sha256.as_deref(), Some("sha-small"));
    assert_eq!(branding.logo_large_path.as_deref(), Some("blob:large"));
    assert_eq!(branding.logo_small_path.as_deref(), Some("blob:small"));
    assert_eq!(branding.color_policy.as_deref(), Some("custom"));
    assert_eq!(branding.color_palette_key, None);
    assert_eq!(branding.primary.as_deref(), Some("#111111"));
    assert_eq!(branding.accent.as_deref(), Some("#222222"));
    assert_eq!(branding.rule.as_deref(), Some("#444444"));
    assert_eq!(branding.text_primary.as_deref(), Some("#333333"));
    assert_eq!(branding.background.as_deref(), Some("#ffffff"));
    assert_eq!(branding.code_background.as_deref(), Some("#e4e4e7"));
  }

  #[test]
  fn ir_block_limit_maps_to_too_large() {
    let (class, detail) = ir_error_to_class(&IrBuildError::BlockLimitExceeded {
      count: 11_000,
      max: 10_000,
    });
    assert_eq!(class, "TooLarge");
    assert!(detail.contains("11000"));
    assert!(detail.contains("10000"));
  }

  #[test]
  fn ir_yjs_decode_maps_to_decode_error() {
    let (class, _) = ir_error_to_class(&IrBuildError::YjsDecode("bad varint".into()));
    assert_eq!(class, "DecodeError");
  }

  #[test]
  fn render_page_limit_maps_to_too_large() {
    let (class, detail) = render_error_to_class(&RenderError::PageLimit { count: 600, max: 500 });
    assert_eq!(class, "TooLarge");
    assert!(detail.contains("600") && detail.contains("500"));
  }

  #[test]
  fn render_timeout_maps_to_timeout() {
    let (class, detail) = render_error_to_class(&RenderError::Timeout { secs: 120 });
    assert_eq!(class, "Timeout");
    assert!(detail.contains("120"));
  }

  #[test]
  fn render_compilation_maps_to_render_error() {
    let (class, _) = render_error_to_class(&RenderError::Compilation("syntax error at 10:5".into()));
    assert_eq!(class, "RenderError");
  }

  #[test]
  fn render_snapshot_limit_maps_to_too_large() {
    let (class, detail) = render_error_to_class(&RenderError::SnapshotLimitExceeded(
      "width 8193px exceeds max 8192px".into(),
    ));
    assert_eq!(class, "TooLarge");
    assert!(detail.contains("edgeless snapshot"));
    assert!(detail.contains("8193"));
  }

  #[test]
  fn limits_default_is_production_safe() {
    let l = PdfExportLimits::default();
    assert_eq!(l.max_input_blocks, 10_000);
    assert_eq!(l.max_pages, 500);
    assert_eq!(l.render_timeout, Duration::from_secs(120));
  }

  /// The canonical worker error_class set is part of the public contract:
  ///   * `docs/dev/clients/pdf-export-architecture.md` §10.1 (metric labels)
  ///   * `crates/api/src/graphql/pdf_export.rs::PdfExportJobType.error_class`
  ///   * `pdf_export_jobs.error_class` DB column
  ///
  /// Every variant of [`IrBuildError`] and [`RenderError`] must map to a
  /// class in this set. Adding a new variant without extending the
  /// matchers in `ir_error_to_class` / `render_error_to_class` is a
  /// breaking-contract bug and this test must catch it.
  #[test]
  fn inv_error_classes_stay_in_canonical_worker_set() {
    const CANONICAL: &[&str] = &[
      "TooLarge",
      "Timeout",
      "RenderError",
      "DecodeError",
      "AssetError",
      "TemplateError",
      "StorageError",
      "UnsupportedComplianceProfile",
      "PdfaValidationFailed",
      "PdfuaValidationFailed",
    ];

    let ir_cases: Vec<IrBuildError> = vec![
      IrBuildError::BlockLimitExceeded { count: 1, max: 0 },
      IrBuildError::UnsupportedVersion {
        found: 99,
        min: 1,
        max: 1,
      },
      IrBuildError::YjsDecode("decode".into()),
      IrBuildError::MissingField {
        block_id: "b".into(),
        field: "f",
      },
      IrBuildError::Asset("missing".into()),
    ];
    for case in ir_cases {
      let (class, _) = ir_error_to_class(&case);
      assert!(
        CANONICAL.contains(&class),
        "ir variant {case:?} → {class} not canonical"
      );
    }

    let render_cases: Vec<RenderError> = vec![
      RenderError::PageLimit { count: 1, max: 0 },
      RenderError::Timeout { secs: 1 },
      RenderError::MemoryLimit,
      RenderError::FontNotFound { name: "x".into() },
      RenderError::SnapshotLimitExceeded("x".into()),
      RenderError::UnsupportedComplianceProfile {
        profile: "pdfx-4".into(),
      },
      RenderError::PdfaValidationFailed("x".into()),
      RenderError::PdfuaValidationFailed("x".into()),
      RenderError::Compilation("x".into()),
    ];
    for case in render_cases {
      let (class, _) = render_error_to_class(&case);
      assert!(
        CANONICAL.contains(&class),
        "render variant {case:?} → {class} not canonical"
      );
    }
  }
}
