// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared PDF-export rendering pipeline.
//!
//! Both [`crate::pdf_export_handler::PdfExportJobHandler`] (async/queued path)
//! and the GraphQL `exportPdf` mutation (sync path for small documents)
//! drive the same Yjs → IR → Typst → PDF stages. This module owns those
//! stages so neither caller diverges:
//!
//! 1. [`load_doc_binary`] — fetch and merge the persisted Yjs snapshot plus
//!    pending `doc_updates`
//! 2. [`build_ir`] — drive the `!Send` `YjsIrBuilder` via `block_in_place`
//! 3. [`render_with_timeout`] — supervised compiler execution with a wall-clock deadline
//! 4. [`try_sync_render`] — high-level entry for the GraphQL mutation that
//!    chains the above and writes the resulting PDF blob via
//!    [`crate::PdfBlobWriter`]

use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(test)]
use std::time::Duration;

use chrono::{DateTime, Utc};
use tracing::{debug, error, warn};
use uuid::Uuid;

use myoxus_application::{doc::DocService, ports::blob_service::BlobService};
use myoxus_domain::repositories::PdfFontRepository;

use myoxus_pdf_export::{
  AssetResolver, IrDocument, YjsIrBuilder,
  error::AssetError,
  error::{IrBuildError, RenderError},
  ir::block::AssetData,
  ir::{Branding, DocumentMetadata, ExportOptions, NativeTablePalette, ThemeFontSelection, ThemeTypographySelection},
  render_v2::pdfa::{PdfaProfile, VerapdfClient, VerapdfProfile},
  typst_engine::world::BLOB_PATH_PREFIX,
};

use crate::pdf_export_handler::{
  PdfAssetReader, PdfExportLimits, PdfFontReader, ir_error_to_class, render_error_to_class,
};
use crate::pdf_export_metrics::{NoopPdfExportMetrics, PdfExportMetrics, PdfExportOutcome};
use crate::{PdfBlobWriter, font_materializer};

/// Errors produced by the IR-build + render stages, mapped to stable
/// `error_class` strings consumed by the P7 client UX matrix.
#[derive(Debug, Clone)]
pub struct PipelineError {
  /// Stable error class — see `pdf_export_handler::{ir,render}_error_to_class`.
  pub class: &'static str,
  /// Human-readable detail for admin tooling (may contain document source); never a
  /// programmatic contract.
  pub detail: String,
  /// `true` when the IR builder hit its block-count cap. The sync caller
  /// uses this to decide between "fall back to async" (this case) and
  /// "propagate as error" (every other class).
  pub is_block_limit: bool,
}

impl PipelineError {
  fn from_ir(err: &IrBuildError) -> Self {
    let (class, detail) = ir_error_to_class(err);
    let is_block_limit = matches!(err, IrBuildError::BlockLimitExceeded { .. });
    Self {
      class,
      detail,
      is_block_limit,
    }
  }

  fn from_render(err: &RenderError) -> Self {
    let (class, detail) = render_error_to_class(err);
    Self {
      class,
      detail,
      is_block_limit: false,
    }
  }
}

pub use myoxus_application::pdf_export::render::SyncRenderOutcome;

/// Output of [`render_with_timeout`]: PDF bytes, page count, and the list
/// of theme font families the renderer could not match in the FontBook
/// (typically empty — see `RenderReport::unmapped_font_families`). The
/// caller persists the list on the `pdf_export_jobs` row as diagnostics for
/// Theme DB/asset drift.
#[derive(Debug)]
pub struct RenderOutput {
  pub pdf_bytes: Vec<u8>,
  pub page_count: usize,
  pub unmapped_font_families: Vec<String>,
}

struct WorkspaceAssetResolver<'a> {
  workspace_id: Uuid,
  reader: Option<&'a Arc<dyn PdfAssetReader>>,
}

impl AssetResolver for WorkspaceAssetResolver<'_> {
  async fn resolve(&mut self, blob_id: &str) -> Result<AssetData, AssetError> {
    let Some(reader) = self.reader else {
      warn!(
        workspace_id = %self.workspace_id,
        blob_key = %blob_id,
        "pdf export: workspace asset resolver is not wired"
      );
      return Err(AssetError::BlobNotFound {
        id: blob_id.to_string(),
      });
    };
    debug!(
      workspace_id = %self.workspace_id,
      blob_key = %blob_id,
      "pdf export: resolving workspace asset for document snapshot"
    );
    let (bytes, content_type) = reader
      .read_workspace_blob(self.workspace_id, blob_id)
      .await
      .map_err(AssetError::Storage)?;
    debug!(
      workspace_id = %self.workspace_id,
      blob_key = %blob_id,
      content_type = content_type.as_deref().unwrap_or("application/octet-stream"),
      size_bytes = bytes.len(),
      "pdf export: resolved workspace asset"
    );
    Ok(AssetData {
      mime: content_type.unwrap_or_else(|| "application/octet-stream".to_string()),
      bytes,
      filename: Some(blob_id.to_string()),
    })
  }
}

const DOCUMENT_BRAND_LOGO_LARGE_BLOB_ID: &str = "__document_brand_logo_large";
const DOCUMENT_BRAND_LOGO_SMALL_BLOB_ID: &str = "__document_brand_logo_small";

async fn read_document_brand_asset(
  reader: Option<&Arc<dyn PdfAssetReader>>,
  workspace_id: Uuid,
  storage_key: &str,
  virtual_id: &'static str,
) -> Result<AssetData, PipelineError> {
  let Some(reader) = reader else {
    warn!(
      workspace_id = %workspace_id,
      storage_key,
      virtual_id,
      "pdf export: document brand asset resolver is not wired"
    );
    return Err(PipelineError {
      class: "AssetError",
      detail: "document brand asset reader is not configured".to_owned(),
      is_block_limit: false,
    });
  };

  debug!(
    workspace_id = %workspace_id,
    storage_key,
    virtual_id,
    "pdf export: resolving document brand asset"
  );
  let (bytes, content_type) = reader.read_storage_blob(storage_key).await.map_err(|detail| {
    warn!(
      workspace_id = %workspace_id,
      storage_key,
      virtual_id,
      detail = %detail,
      "pdf export: document brand asset read failed"
    );
    PipelineError {
      class: "AssetError",
      detail,
      is_block_limit: false,
    }
  })?;
  debug!(
    workspace_id = %workspace_id,
    storage_key,
    virtual_id,
    size_bytes = bytes.len(),
    content_type = content_type.as_deref().unwrap_or("application/octet-stream"),
    "pdf export: resolved document brand asset"
  );
  Ok(AssetData {
    mime: content_type.unwrap_or_else(|| "application/octet-stream".to_owned()),
    bytes,
    filename: Some(virtual_id.to_owned()),
  })
}

/// Materialize private document-branding logo blobs into the IR's virtual asset
/// map and replace storage keys with `blob:*` paths consumable by Typst.
///
/// The API owns the semantic selection (global/workspace profile and logo slot);
/// this worker step only dereferences the selected storage key. Failing fast is
/// intentional: a profile that points at a missing logo must not render a PDF
/// that silently drops required document branding.
pub async fn attach_document_brand_assets(
  ir_doc: &mut IrDocument,
  reader: Option<&Arc<dyn PdfAssetReader>>,
) -> Result<(), PipelineError> {
  let workspace_id = ir_doc.metadata.workspace_id;

  if ir_doc.metadata.branding.logo_large_path.is_none()
    && let Some(storage_key) = ir_doc.metadata.branding.logo_large_blob.clone()
  {
    let asset =
      read_document_brand_asset(reader, workspace_id, &storage_key, DOCUMENT_BRAND_LOGO_LARGE_BLOB_ID).await?;
    ir_doc
      .assets
      .insert(DOCUMENT_BRAND_LOGO_LARGE_BLOB_ID.to_owned(), asset);
    ir_doc.metadata.branding.logo_large_path = Some(format!("{BLOB_PATH_PREFIX}{DOCUMENT_BRAND_LOGO_LARGE_BLOB_ID}"));
  }

  if ir_doc.metadata.branding.logo_small_path.is_none()
    && let Some(storage_key) = ir_doc.metadata.branding.logo_small_blob.clone()
  {
    let asset =
      read_document_brand_asset(reader, workspace_id, &storage_key, DOCUMENT_BRAND_LOGO_SMALL_BLOB_ID).await?;
    ir_doc
      .assets
      .insert(DOCUMENT_BRAND_LOGO_SMALL_BLOB_ID.to_owned(), asset);
    ir_doc.metadata.branding.logo_small_path = Some(format!("{BLOB_PATH_PREFIX}{DOCUMENT_BRAND_LOGO_SMALL_BLOB_ID}"));
  }

  Ok(())
}

/// Extract template-specific V2 `typed_inputs` from the canonical render-input
/// snapshot captured by the API.
///
/// The GraphQL layer validates `typed_inputs` against the selected template's
/// JSON Schema before enqueueing or attempting sync rendering. The worker must
/// nevertheless copy the already-validated object into `ExportOptions` for both
/// paths; otherwise manifests can declare fields that pass API validation but
/// never reach Typst. Non-object payloads are ignored defensively because they
/// cannot satisfy the server-side schema and may only appear in malformed
/// direct tests or stale queue records.
pub fn template_vars_from_render_inputs(
  render_inputs: &serde_json::Value,
) -> std::collections::HashMap<String, serde_json::Value> {
  render_inputs
    .get("typed_inputs")
    .and_then(|value| value.as_object())
    .map(|object| object.iter().map(|(key, value)| (key.clone(), value.clone())).collect())
    .unwrap_or_default()
}

// ─── Stage 1: load Yjs binary ──────────────────────────────────────────────

/// Load the merged Yjs binary for `doc_id`.
///
/// The browser sync path persists current editor changes as append-only
/// `doc_updates`; `doc_snapshots` is only a compaction cache. PDF export must
/// therefore mirror the normal document read path and merge the latest snapshot
/// with every update above `last_sequence`. Reading only `doc_snapshots` makes
/// newly edited pages render as empty documents until compaction happens.
///
/// Returns a canonical empty Yjs v1 update when neither a snapshot nor updates
/// exist. Returning a raw empty byte vector is invalid Yjs and causes misleading
/// decode failures before the renderer can build the intended zero-block IR.
pub async fn load_doc_binary(doc_service: &DocService, workspace_id: Uuid, doc_id: Uuid) -> Result<Vec<u8>, String> {
  let merged = doc_service
    .load_full_doc(workspace_id, doc_id)
    .await
    .map_err(|error| error.to_string())?;
  debug!(
    workspace_id = %workspace_id,
    doc_id = %doc_id,
    merged_size = merged.len(),
    "pdf pipeline: loaded merged snapshot and pending updates"
  );
  Ok(merged)
}

/// Load a named DocHistory snapshot for a PDF render.
///
/// The GraphQL export bridge resolves document-version labels to
/// `doc_histories.id` before enqueueing. The worker re-checks the doc/workspace
/// tuple here so a malformed queue payload cannot render another document's
/// snapshot.
pub async fn load_doc_history_binary(
  doc_service: &DocService,
  workspace_id: Uuid,
  doc_id: Uuid,
  history_id: i64,
) -> Result<Vec<u8>, String> {
  let entry = doc_service
    .history_entry(history_id)
    .await
    .map_err(|error| error.to_string())?;

  let Some(entry) = entry.filter(|entry| entry.workspace_id == workspace_id && entry.doc_id == doc_id) else {
    return Err(format!(
      "doc history snapshot {history_id} not found for doc {doc_id} in workspace {workspace_id}"
    ));
  };
  let payload = entry.snapshot;
  debug!(
    workspace_id = %workspace_id,
    doc_id = %doc_id,
    history_id,
    size = payload.len(),
    "pdf pipeline: loaded document-version snapshot"
  );
  Ok(payload)
}

// ─── Stage 2: build IR ────────────────────────────────────────────────────

/// Build [`IrDocument`] from a Yjs binary, capped at `block_limit` visited
/// blocks.
///
/// `YjsIrBuilder` holds `yrs` types whose internal `NonNull` pointers are
/// `!Send`, so the build future cannot cross threads. We drive it
/// synchronously on a blocking-eligible thread via `block_in_place` +
/// `Handle::block_on`, and drop the builder before returning to async land.
pub fn build_ir(
  yjs_binary: Vec<u8>,
  metadata: DocumentMetadata,
  options: ExportOptions,
  block_limit: usize,
  asset_reader: Option<&Arc<dyn PdfAssetReader>>,
) -> Result<IrDocument, IrBuildError> {
  build_ir_with_diagnostics(yjs_binary, metadata, options, block_limit, asset_reader).map(|(document, _)| document)
}

/// The canonical builder plus its bounded, content-free omission report.
pub fn build_ir_with_diagnostics(
  yjs_binary: Vec<u8>,
  metadata: DocumentMetadata,
  options: ExportOptions,
  block_limit: usize,
  asset_reader: Option<&Arc<dyn PdfAssetReader>>,
) -> Result<(IrDocument, serde_json::Value), IrBuildError> {
  let workspace_id = metadata.workspace_id;
  tokio::task::block_in_place(|| {
    let rt = tokio::runtime::Handle::current();
    rt.block_on(async move {
      let resolver = WorkspaceAssetResolver {
        workspace_id,
        reader: asset_reader,
      };
      let mut builder = YjsIrBuilder::new(resolver).with_block_limit(block_limit);
      let document = builder.build(&yjs_binary, metadata, options).await?;
      Ok((document, builder.diagnostics()))
    })
  })
}

// ─── Stage 3: render IR to PDF bytes ──────────────────────────────────────

/// Render `ir_doc` to PDF bytes through the bounded compiler process with a
/// wall-clock timeout.
///
/// Timeout and caller cancellation stop and reap the compiler before releasing
/// admission or materialized fonts. No CPU work is detached onto a blocking pool.
pub async fn render_with_timeout(
  ir_doc: IrDocument,
  template_files: std::collections::HashMap<String, Vec<u8>>,
  static_path: PathBuf,
  materialized_fonts: Vec<tempfile::TempDir>,
  limits: PdfExportLimits,
) -> Result<RenderOutput, PipelineError> {
  let mut font_dirs = Vec::new();
  if static_path.exists() {
    font_dirs.push(static_path);
  }
  font_dirs.extend(materialized_fonts.iter().map(|dir| dir.path().to_path_buf()));
  let report = myoxus_pdf_export::execution::render(
    ir_doc,
    template_files,
    font_dirs,
    limits.max_pages,
    limits.snapshot_limits,
    myoxus_pdf_export::execution::CompilerLimits {
      watchdog: limits.render_timeout,
      max_memory_mb: limits.max_memory_mb,
    },
    materialized_fonts,
  )
  .await
  .map_err(|error| PipelineError::from_render(&error))?;
  Ok(RenderOutput {
    pdf_bytes: report.pdf_bytes,
    page_count: report.page_count,
    unmapped_font_families: report.unmapped_font_families,
  })
}

fn verapdf_profile_from_compliance_profile(profile: Option<&str>) -> Option<VerapdfProfile> {
  match profile.map(str::trim) {
    Some("pdfa-1b") => Some(PdfaProfile::Pdfa1b.into()),
    Some("pdfa-2b") => Some(PdfaProfile::Pdfa2b.into()),
    Some("pdfa-2u") => Some(PdfaProfile::Pdfa2u.into()),
    Some("pdfa-3b") => Some(PdfaProfile::Pdfa3b.into()),
    Some("pdfua-1") => Some(VerapdfProfile::Pdfua1),
    _ => None,
  }
}

/// Gate requested PDF/A or PDF/UA before publication using the same explicit profile contract.
///
/// Native Typst standards are applied by the renderer itself. This additional
/// gate is intentionally configuration-backed because local/dev stacks may not
/// run the JVM validator. When configured, only a positive report without
/// failure diagnostics permits publication. Non-compliant, incomplete or
/// contradictory reports and transport failures are fail-closed for compliance
/// requests and leave normal PDF output untouched.
pub async fn validate_compliance_if_requested(
  pdf_bytes: &[u8],
  compliance_profile: Option<&str>,
  verapdf_client: Option<&Arc<dyn VerapdfClient>>,
) -> Result<(), PipelineError> {
  let Some(profile) = verapdf_profile_from_compliance_profile(compliance_profile) else {
    return Ok(());
  };
  let Some(client) = verapdf_client else {
    warn!(
      compliance_profile = compliance_profile.unwrap_or_default(),
      "pdf export: compliance requested without an external validator; native renderer standards only"
    );
    return Ok(());
  };
  let report = client.validate(pdf_bytes, profile).await.map_err(|e| PipelineError {
    class: profile.failure_class(),
    detail: e.to_string(),
    is_block_limit: false,
  })?;
  if report.passed && report.failures.is_empty() {
    return Ok(());
  }
  Err(PipelineError {
    class: profile.failure_class(),
    detail: if report.failures.is_empty() {
      "veraPDF reported non-conformance without diagnostics".to_string()
    } else {
      report.failures.join("; ")
    },
    is_block_limit: false,
  })
}

// ─── High-level: sync path orchestration ──────────────────────────────────

/// Apply dispatch-time attribution identically in sync and queued rendering.
/// Older jobs without this snapshot retain their original request-time dates.
pub(crate) fn apply_document_attribution(metadata: &mut DocumentMetadata, render_inputs: &serde_json::Value) {
  let Some(snapshot) = render_inputs.get("documentMetadata") else {
    return;
  };
  metadata.author = snapshot
    .get("author")
    .and_then(|v| v.as_str())
    .filter(|name| !name.trim().is_empty())
    .map(str::to_owned);
  for (key, target) in [
    ("createdAt", &mut metadata.created_at),
    ("updatedAt", &mut metadata.updated_at),
  ] {
    if let Some(date) = snapshot
      .get(key)
      .and_then(|v| v.as_str())
      .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
    {
      *target = Some(date.with_timezone(&Utc));
    }
  }
}

/// Bundle of inputs the GraphQL mutation passes to [`try_sync_render`].
pub struct SyncRenderInputs<'a> {
  pub doc_service: &'a Arc<DocService>,
  pub blob_service: &'a Arc<BlobService>,
  pub font_repository: &'a Arc<dyn PdfFontRepository>,
  pub blob_writer: &'a Arc<dyn PdfBlobWriter>,
  /// Object-store reader for the admin font library. `None` skips the
  /// approved-font materialization step (e.g. test stacks without a
  /// configured opendal). `P-PDF-TPL-FONT-01-06`.
  pub font_reader: Option<&'a Arc<dyn PdfFontReader>>,
  /// Object-store reader for workspace assets referenced by Yjs, currently
  /// Edgeless export snapshots.
  pub asset_reader: Option<&'a Arc<dyn PdfAssetReader>>,
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  /// Stable timestamp written to PDF metadata. PDF/A renders require a
  /// document date; the sync path has not inserted its job row yet, so the API
  /// captures the request time and passes it explicitly.
  pub render_created_at: DateTime<Utc>,
  pub template_id: String,
  pub locale: String,
  pub paper_size: String,
  pub orientation: String,
  pub heading_font_scale: f64,
  pub body_font_scale: f64,
  pub color_profile: Option<String>,
  pub image_quality: Option<String>,
  /// PDF standards profile selected at the API boundary. `None` means normal
  /// PDF output; compliance values are passed unchanged to the renderer so
  /// sync and async paths produce the same byte-level standard.
  pub compliance_profile: Option<String>,
  /// Optional external veraPDF validator. When present, requested PDF/A or PDF/UA
  /// profiles are validated before bytes are persisted or a job is marked done.
  pub verapdf_client: Option<&'a Arc<dyn VerapdfClient>>,
  pub ligatures_enabled: bool,
  pub toc_behavior: String,
  pub footer_style: Option<String>,
  pub page_numbering: Option<String>,
  pub color_variant: Option<String>,
  /// Optional V2 cover-page capability value. `None` lets the renderer keep
  /// the selected template's default behavior.
  pub cover_page: Option<bool>,
  /// Optional V2 confidentiality/classification label rendered by templates
  /// that expose `confidentialityLabels`.
  pub confidentiality_label: Option<String>,
  /// Effective global-theme font roles resolved by the API layer from the
  /// server-owned branding profile and mapped to bundled TTF/OTF/VF families.
  pub theme_fonts: ThemeFontSelection,
  /// Complete typography metrics resolved from the same effective theme.
  pub theme_typography: ThemeTypographySelection,
  /// Captured with the render-input snapshot; rendering never reloads the theme.
  pub native_table_palette: Option<NativeTablePalette>,
  /// Full persisted render-input snapshot. Sync rendering validates
  /// `render_inputs.theme_font_assets` from the same object that is hashed and
  /// stored on the job row, so idempotency/audit and Typst input cannot
  /// diverge.
  pub render_inputs: serde_json::Value,
  /// Effective brand colors resolved with the same server-owned profile as
  /// `theme_fonts`. Passing this explicitly keeps sync rendering aligned with
  /// queued rendering and prevents the renderer from silently using defaults.
  pub branding: Branding,
  /// Optional document-version label surfaced to templates as `doc-version`.
  pub doc_version_label: Option<String>,
  /// Optional DocHistory snapshot ID. When set, the render uses that snapshot
  /// instead of the current compacted doc state.
  pub doc_history_id: Option<i64>,
  pub static_path: &'a Path,
  pub limits: PdfExportLimits,
  /// IR-builder block cap for the sync attempt. Documents above this fall
  /// through to the async path. Must be `> 0`; the caller is responsible
  /// for skipping [`try_sync_render`] entirely when sync is disabled.
  pub sync_threshold_blocks: usize,
  /// Observability hook — defaults to a no-op when the api crate has not
  /// wired a real adapter yet. Emits one `record_render` per sync attempt
  /// and one `record_pages` per success.
  pub metrics: Arc<dyn PdfExportMetrics>,
  /// V2 template bundle (`HashMap<String, Vec<u8>>`) loaded from the
  /// registry by the api crate before this struct is built. Required —
  /// the V1 hardcoded `Template::lookup` path was removed in
  /// `P-PDF-TPL-06-04-CUTOVER` (2026-04-30) so there is no fallback.
  pub template_files: std::collections::HashMap<String, Vec<u8>>,
}

/// Attempt to render `doc_id` synchronously. Returns the action the caller
/// must take — see [`SyncRenderOutcome`].
///
/// On success the PDF bytes are already persisted at
/// `{workspace_id}/pdf-export/{blob_id}` (PDFREV-SEC-02)
/// in object storage; the mutation is responsible only for the DB row.
pub async fn try_sync_render(inputs: SyncRenderInputs<'_>) -> SyncRenderOutcome {
  let started_at = std::time::Instant::now();
  let template_id = inputs.template_id.clone();
  let metrics = inputs.metrics.clone();

  let workspace_id = inputs.workspace_id;
  let doc_id = inputs.doc_id;
  let blob_writer = inputs.blob_writer;
  let blob_service = inputs.blob_service;
  // 1. Load Yjs binary. A selected document version pins the render to the
  // corresponding immutable DocHistory snapshot; otherwise we render the
  // current compacted doc state.
  let loaded_binary = if let Some(history_id) = inputs.doc_history_id {
    load_doc_history_binary(inputs.doc_service, inputs.workspace_id, inputs.doc_id, history_id).await
  } else {
    load_doc_binary(inputs.doc_service, inputs.workspace_id, inputs.doc_id).await
  };
  let yjs_binary = match loaded_binary {
    Ok(b) => b,
    Err(detail) => {
      warn!(
        workspace_id = %inputs.workspace_id,
        doc_id = %inputs.doc_id,
        error = %detail,
        "pdf sync: snapshot load failed"
      );
      metrics.record_render(
        PdfExportOutcome::StorageError,
        &template_id,
        started_at.elapsed(),
        Some("StorageError"),
      );
      return SyncRenderOutcome::Failed {
        renderer_diagnostics: None,
        class: "StorageError",
        detail,
      };
    }
  };

  let rendered = match render_snapshot(inputs, yjs_binary).await {
    Ok(rendered) => rendered,
    Err(outcome) => return outcome,
  };
  let myoxus_application::pdf_export::render::SnapshotRenderedPdf {
    bytes: pdf_bytes,
    page_count,
    unmapped_font_families,
    renderer_diagnostics,
  } = rendered;

  // 4. Persist bytes via the worker-local PdfBlobWriter trait. The opendal
  //    write happens *before* the SQL row INSERT (caller's responsibility)
  //    so a crash between the two leaves a blob orphan rather than a
  //    `done` row pointing at empty storage.
  let blob_id = Uuid::new_v4();
  let storage_key = crate::pdf_export_handler::pdf_export_storage_key(workspace_id, blob_id);
  if let Err(e) = blob_writer
    .write_pdf(&storage_key, pdf_bytes.clone(), "application/pdf")
    .await
  {
    error!(
      workspace_id = %workspace_id,
      doc_id = %doc_id,
      key = %storage_key,
      error = %e,
      "pdf sync: blob write failed"
    );
    metrics.record_render(
      PdfExportOutcome::StorageError,
      &template_id,
      started_at.elapsed(),
      Some("StorageError"),
    );
    return SyncRenderOutcome::Failed {
      renderer_diagnostics: Some(renderer_diagnostics),
      class: "StorageError",
      detail: e,
    };
  }

  // 5. Register the committed object through the canonical blob owner so the
  // download handler can resolve it.
  if let Err(e) = blob_service
    .register_completed_blob(
      workspace_id,
      &myoxus_application::pdf_export::jobs::pdf_export_blob_key(blob_id),
      pdf_bytes.len() as u64,
      "application/pdf",
    )
    .await
  {
    error!(
      workspace_id = %workspace_id,
      doc_id = %doc_id,
      key = %storage_key,
      error = %e,
      "pdf sync: blob row insert failed"
    );
    metrics.record_render(
      PdfExportOutcome::StorageError,
      &template_id,
      started_at.elapsed(),
      Some("StorageError"),
    );
    return SyncRenderOutcome::Failed {
      renderer_diagnostics: Some(renderer_diagnostics),
      class: "StorageError",
      detail: e.to_string(),
    };
  }

  metrics.record_render(PdfExportOutcome::Success, &template_id, started_at.elapsed(), None);
  metrics.record_pages(&template_id, page_count);

  SyncRenderOutcome::Rendered {
    blob_id,
    size_bytes: pdf_bytes.len(),
    page_count,
    unmapped_font_families,
    renderer_diagnostics,
  }
}

/// The canonical byte-snapshot stage. It neither loads a document nor publishes
/// a job/blob. Limits, font pinning, isolated compilation and validation are shared.
pub async fn render_snapshot(
  inputs: SyncRenderInputs<'_>,
  yjs_binary: Vec<u8>,
) -> Result<myoxus_application::pdf_export::render::SnapshotRenderedPdf, SyncRenderOutcome> {
  let started_at = std::time::Instant::now();
  let template_id = inputs.template_id.clone();
  let metrics = inputs.metrics.clone();
  // 2. Build IR with sync threshold (NOT max_input_blocks). Block-limit
  //    error → fall back to async path; any other error → propagate.
  let mut metadata = DocumentMetadata {
    doc_id: inputs.doc_id,
    workspace_id: inputs.workspace_id,
    title: None,
    author: None,
    created_at: Some(inputs.render_created_at),
    updated_at: Some(inputs.render_created_at),
    workspace_name: inputs.branding.organization_name.clone(),
    branding: inputs.branding,
  };
  apply_document_attribution(&mut metadata, &inputs.render_inputs);
  let compliance_profile = inputs.compliance_profile.clone();
  let options = ExportOptions {
    template_id: inputs.template_id,
    locale: inputs.locale,
    paper_size: inputs.paper_size,
    orientation: inputs.orientation,
    heading_font_scale: inputs.heading_font_scale,
    body_font_scale: inputs.body_font_scale,
    toc_behavior: inputs.toc_behavior,
    footer_style: inputs.footer_style,
    page_numbering: inputs.page_numbering,
    color_variant: inputs.color_variant,
    cover_page: inputs.cover_page,
    confidentiality_label: inputs.confidentiality_label,
    theme_fonts: inputs.theme_fonts,
    theme_typography: inputs.theme_typography,
    native_table_palette: inputs.native_table_palette,
    color_profile: inputs.color_profile,
    image_quality: inputs.image_quality,
    compliance_profile: inputs.compliance_profile,
    ligatures_enabled: inputs.ligatures_enabled,
    doc_version_label: inputs.doc_version_label,
    keywords: Vec::new(),
    template_vars: template_vars_from_render_inputs(&inputs.render_inputs),
  };

  let (mut ir_doc, renderer_diagnostics) = match build_ir_with_diagnostics(
    yjs_binary,
    metadata,
    options,
    inputs.sync_threshold_blocks,
    inputs.asset_reader,
  ) {
    Ok(d) => d,
    Err(err) => {
      let pe = PipelineError::from_ir(&err);
      if pe.is_block_limit {
        debug!(
          workspace_id = %inputs.workspace_id,
          doc_id = %inputs.doc_id,
          threshold = inputs.sync_threshold_blocks,
          "pdf sync: doc above threshold — falling back to async"
        );
        // Block-limit fallthrough is *not* an error outcome — the caller
        // continues on the async path and the worker will emit its own
        // `success`/`*_error` event. Skipping a metric here keeps
        // `pdf_export.render_total` aligned with completed renders.
        return Err(SyncRenderOutcome::TooLargeForSync);
      }
      warn!(
        workspace_id = %inputs.workspace_id,
        doc_id = %inputs.doc_id,
        class = %pe.class,

        "pdf sync: IR build failed"
      );
      metrics.record_render(
        PdfExportOutcome::IrError,
        &template_id,
        started_at.elapsed(),
        Some(pe.class),
      );
      return Err(SyncRenderOutcome::Failed {
        renderer_diagnostics: None,
        class: pe.class,
        detail: pe.detail,
      });
    }
  };
  if let Err(pe) = attach_document_brand_assets(&mut ir_doc, inputs.asset_reader).await {
    warn!(
      workspace_id = %inputs.workspace_id,
      doc_id = %inputs.doc_id,
      class = %pe.class,

      "pdf sync: document brand asset materialization failed"
    );
    metrics.record_render(
      PdfExportOutcome::RenderError,
      &template_id,
      started_at.elapsed(),
      Some(pe.class),
    );
    return Err(SyncRenderOutcome::Failed {
      renderer_diagnostics: Some(renderer_diagnostics),
      class: pe.class,
      detail: pe.detail,
    });
  }

  // 3. Render PDF bytes. Approved fonts (if any) materialize to a tempdir
  //    that lives at least as long as the render call; no fonts in pending
  //    or rejected status are surfaced to TypstWorld.
  let pinned_dir = match font_materializer::materialize_pinned_theme_font_assets(
    inputs.static_path,
    inputs.font_reader,
    &inputs.render_inputs,
  )
  .await
  {
    Ok(dir) => dir,
    Err(detail) => {
      warn!(
        workspace_id = %inputs.workspace_id,
        doc_id = %inputs.doc_id,

        "pdf sync: pinned theme font asset validation failed"
      );
      metrics.record_render(
        PdfExportOutcome::RenderError,
        &template_id,
        started_at.elapsed(),
        Some("AssetError"),
      );
      return Err(SyncRenderOutcome::Failed {
        renderer_diagnostics: Some(renderer_diagnostics),
        class: "AssetError",
        detail,
      });
    }
  };
  let approved_dir = font_materializer::materialize_approved_fonts(inputs.font_repository, inputs.font_reader).await;
  let materialized_fonts = [pinned_dir, approved_dir].into_iter().flatten().collect();

  let RenderOutput {
    pdf_bytes,
    page_count,
    unmapped_font_families,
  } = match render_with_timeout(
    ir_doc,
    inputs.template_files.clone(),
    inputs.static_path.to_path_buf(),
    materialized_fonts,
    inputs.limits,
  )
  .await
  {
    Ok(out) => out,
    Err(pe) => {
      warn!(
        workspace_id = %inputs.workspace_id,
        doc_id = %inputs.doc_id,
        class = %pe.class,
        "pdf sync: render failed"
      );
      metrics.record_render(
        PdfExportOutcome::RenderError,
        &template_id,
        started_at.elapsed(),
        Some(pe.class),
      );
      return Err(SyncRenderOutcome::Failed {
        renderer_diagnostics: Some(renderer_diagnostics),
        class: pe.class,
        detail: pe.detail,
      });
    }
  };

  if let Err(pe) =
    validate_compliance_if_requested(&pdf_bytes, compliance_profile.as_deref(), inputs.verapdf_client).await
  {
    warn!(
      workspace_id = %inputs.workspace_id,
      doc_id = %inputs.doc_id,
      class = %pe.class,

      "pdf sync: external PDF conformance validation failed"
    );
    metrics.record_render(
      PdfExportOutcome::RenderError,
      &template_id,
      started_at.elapsed(),
      Some(pe.class),
    );
    return Err(SyncRenderOutcome::Failed {
      renderer_diagnostics: Some(renderer_diagnostics),
      class: pe.class,
      detail: pe.detail,
    });
  }

  Ok(myoxus_application::pdf_export::render::SnapshotRenderedPdf {
    bytes: pdf_bytes,
    page_count,
    unmapped_font_families,
    renderer_diagnostics,
  })
}

/// Helper used by tests and the bootstrap path: the no-op metrics adapter.
#[doc(hidden)]
pub fn noop_metrics() -> Arc<dyn PdfExportMetrics> {
  Arc::new(NoopPdfExportMetrics)
}

#[cfg(test)]
mod tests {
  use super::*;
  use async_trait::async_trait;
  use myoxus_pdf_export::render_v2::pdfa::{PdfaError, VerapdfReport};

  fn compiler_doc() -> IrDocument {
    let mut doc = myoxus_pdf_export::template_v2::stub_doc::build_stub_doc();
    // Keep this lifecycle fixture focused on CPU work; image fidelity belongs
    // to the existing renderer and consuming API fixtures.
    if let myoxus_pdf_export::ir::Block::Page { children, .. } = &mut doc.root {
      children.retain(|block| !matches!(block, myoxus_pdf_export::ir::Block::Image(_)));
    }
    doc.assets.clear();
    doc.options.theme_fonts = ThemeFontSelection {
      heading: Some("New Computer Modern".into()),
      body: Some("New Computer Modern".into()),
      mono: Some("New Computer Modern".into()),
      symbol: Some("New Computer Modern".into()),
    };
    doc
  }

  fn compiler_bundle() -> std::collections::HashMap<String, Vec<u8>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/pdf/default");
    ["theme.typ", "preamble.typ", "i18n/en.json", "i18n/de.json"]
      .into_iter()
      .map(|name| (name.to_owned(), std::fs::read(root.join(name)).expect("system bundle")))
      .collect()
  }

  #[cfg(target_os = "linux")]
  async fn compiler_pid() -> u32 {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
      for task in std::fs::read_dir("/proc/self/task").expect("task inventory") {
        let children = std::fs::read_to_string(task.expect("task entry").path().join("children")).unwrap_or_default();
        for pid in children.split_whitespace() {
          if std::fs::read_link(format!("/proc/{pid}/exe"))
            .is_ok_and(|path| path.file_name().is_some_and(|name| name == "myoxus-pdf-compiler"))
          {
            return pid.parse().expect("compiler pid");
          }
        }
      }
      assert!(std::time::Instant::now() < deadline, "production compiler must start");
      tokio::time::sleep(Duration::from_millis(5)).await;
    }
  }

  #[cfg(target_os = "linux")]
  #[tokio::test(flavor = "multi_thread")]
  async fn compiler_timeout_reaps_and_releases_fonts_before_next_export() {
    let mut files = compiler_bundle();
    files.insert(
      "preamble.typ".into(),
      b"#for n in range(10000) { for m in range(10000) { let s = str(n + m) } }".to_vec(),
    );
    let fonts = tempfile::tempdir().expect("materialized fonts");
    let path = fonts.path().to_owned();
    let task = tokio::spawn(render_with_timeout(
      compiler_doc(),
      files,
      PathBuf::new(),
      vec![fonts],
      PdfExportLimits {
        render_timeout: Duration::from_secs(1),
        ..Default::default()
      },
    ));
    let pid = compiler_pid().await;
    assert!(path.exists(), "inputs must outlive execution");
    let error = task
      .await
      .expect("render caller")
      .expect_err("real finite work must time out");
    assert_eq!(error.class, "Timeout", "{error:?}");
    assert!(
      !Path::new(&format!("/proc/{pid}")).exists(),
      "reported timeout must reap execution"
    );
    assert!(!path.exists(), "temporary font inputs must be released");
    let output = render_with_timeout(
      compiler_doc(),
      compiler_bundle(),
      PathBuf::new(),
      vec![],
      PdfExportLimits::default(),
    )
    .await
    .expect("next normal export");
    assert!(output.pdf_bytes.starts_with(b"%PDF-") && output.page_count > 0);
  }

  #[cfg(target_os = "linux")]
  #[tokio::test(flavor = "multi_thread")]
  async fn compiler_cancellation_retains_fonts_until_reaping() {
    let mut files = compiler_bundle();
    files.insert(
      "preamble.typ".into(),
      b"#for n in range(10000) { for m in range(10000) { let s = str(n + m) } }".to_vec(),
    );
    let fonts = tempfile::tempdir().expect("materialized fonts");
    let path = fonts.path().to_owned();
    let task = tokio::spawn(render_with_timeout(
      compiler_doc(),
      files,
      PathBuf::new(),
      vec![fonts],
      PdfExportLimits::default(),
    ));
    let pid = compiler_pid().await;
    assert!(path.exists());
    task.abort();
    assert!(task.await.expect_err("cancel caller").is_cancelled());
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while path.exists() {
      assert!(
        std::time::Instant::now() < deadline,
        "supervisor must release temporary inputs"
      );
      tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
      !Path::new(&format!("/proc/{pid}")).exists(),
      "inputs cannot disappear before reaping"
    );
  }

  #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
  #[tokio::test(flavor = "multi_thread")]
  async fn compiler_memory_override_reaps_releases_fonts_and_preserves_default() {
    let mut files = compiler_bundle();
    files
      .get_mut("preamble.typ")
      .unwrap()
      .extend_from_slice(b"\n#let heap = range(12000000)");
    let default = render_with_timeout(
      compiler_doc(),
      files.clone(),
      PathBuf::new(),
      vec![],
      PdfExportLimits::default(),
    )
    .await
    .expect("same input fits existing default memory budget");
    assert!(default.pdf_bytes.starts_with(b"%PDF-"));
    let fonts = tempfile::tempdir().unwrap();
    let path = fonts.path().to_owned();
    let task = tokio::spawn(render_with_timeout(
      compiler_doc(),
      files,
      PathBuf::new(),
      vec![fonts],
      PdfExportLimits {
        max_memory_mb: 512,
        ..Default::default()
      },
    ));
    let pid = compiler_pid().await;
    let error = task
      .await
      .unwrap()
      .expect_err("the smaller override must exhaust real compiler memory");
    assert_eq!(error.class, "TooLarge", "{error:?}");
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    assert!(
      !path.exists(),
      "temporary inputs must be cleaned before failure returns"
    );
    let next = render_with_timeout(
      compiler_doc(),
      compiler_bundle(),
      PathBuf::new(),
      vec![],
      PdfExportLimits::default(),
    )
    .await
    .expect("normal export after exhaustion");
    assert!(next.pdf_bytes.starts_with(b"%PDF-") && next.page_count > 0);
  }

  #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
  #[tokio::test]
  async fn compiler_minimum_memory_budget_fails_with_resource_class() {
    let error = render_with_timeout(
      compiler_doc(),
      compiler_bundle(),
      PathBuf::new(),
      vec![],
      PdfExportLimits {
        max_memory_mb: 64,
        ..Default::default()
      },
    )
    .await
    .expect_err("minimum budget cannot fit the compiler's font world");
    assert_eq!(
      error.class, "TooLarge",
      "startup/allocator rejection must not masquerade as an unrelated crash: {error:?}"
    );
  }

  struct TestBrandAssetReader;

  #[async_trait]
  impl PdfAssetReader for TestBrandAssetReader {
    async fn read_workspace_blob(
      &self,
      _workspace_id: Uuid,
      _blob_key: &str,
    ) -> Result<(Vec<u8>, Option<String>), String> {
      Err("not used".to_owned())
    }

    async fn read_storage_blob(&self, blob_key: &str) -> Result<(Vec<u8>, Option<String>), String> {
      Ok((format!("asset:{blob_key}").into_bytes(), Some("image/png".to_owned())))
    }
  }

  struct StaticVerapdfClient {
    report: VerapdfReport,
  }

  #[async_trait]
  impl VerapdfClient for StaticVerapdfClient {
    async fn validate(&self, _pdf_bytes: &[u8], _profile: VerapdfProfile) -> Result<VerapdfReport, PdfaError> {
      Ok(self.report.clone())
    }
  }

  #[tokio::test]
  async fn attach_document_brand_assets_materializes_logo_paths() {
    let workspace_id = Uuid::new_v4();
    let mut ir_doc = IrDocument {
      version: myoxus_pdf_export::CURRENT_IR_VERSION,
      metadata: DocumentMetadata {
        doc_id: Uuid::new_v4(),
        workspace_id,
        title: None,
        author: None,
        created_at: None,
        updated_at: None,
        workspace_name: None,
        branding: Branding {
          logo_large_blob: Some(format!("pdf-brand/{workspace_id}/large")),
          logo_small_blob: Some(format!("pdf-brand/{workspace_id}/small")),
          ..Branding::default()
        },
      },
      options: ExportOptions::default(),
      root: myoxus_pdf_export::ir::block::Block::Page {
        title: vec![],
        children: vec![],
      },
      assets: Default::default(),
    };
    let reader: Arc<dyn PdfAssetReader> = Arc::new(TestBrandAssetReader);

    attach_document_brand_assets(&mut ir_doc, Some(&reader)).await.unwrap();

    assert_eq!(
      ir_doc.metadata.branding.logo_large_path.as_deref(),
      Some("blob:__document_brand_logo_large")
    );
    assert_eq!(
      ir_doc.metadata.branding.logo_small_path.as_deref(),
      Some("blob:__document_brand_logo_small")
    );
    assert!(ir_doc.assets.contains_key("__document_brand_logo_large"));
    assert!(ir_doc.assets.contains_key("__document_brand_logo_small"));
  }

  #[test]
  fn pipeline_error_from_block_limit_signals_fallback() {
    let err = IrBuildError::BlockLimitExceeded { count: 200, max: 80 };
    let pe = PipelineError::from_ir(&err);
    assert!(pe.is_block_limit, "block-limit must signal sync fallback");
    assert_eq!(pe.class, "TooLarge");
  }

  #[tokio::test]
  async fn validate_compliance_if_requested_fails_pdfa_negative_report() {
    let client: Arc<dyn VerapdfClient> = Arc::new(StaticVerapdfClient {
      report: VerapdfReport {
        passed: false,
        failures: vec!["job 1 failed PDF/A validation (failedRules=2)".into()],
      },
    });

    let err = validate_compliance_if_requested(b"%PDF", Some("pdfa-2b"), Some(&client))
      .await
      .expect_err("negative veraPDF report must fail PDF/A export");
    assert_eq!(err.class, "PdfaValidationFailed");
    assert!(err.detail.contains("failedRules=2"));
  }

  #[test]
  fn pipeline_error_from_decode_does_not_signal_fallback() {
    let err = IrBuildError::YjsDecode("bad varint".into());
    let pe = PipelineError::from_ir(&err);
    assert!(!pe.is_block_limit, "decode error must not signal fallback");
    assert_eq!(pe.class, "DecodeError");
  }

  #[test]
  fn template_vars_from_render_inputs_copies_validated_typed_inputs_only() {
    let render_inputs = serde_json::json!({
      "locale": "de",
      "typed_inputs": {
        "title": "Quartalsbericht",
        "recipient_address": ["Muster GmbH", "Hauptstrasse 1"],
        "ignored_null": null
      }
    });

    let vars = template_vars_from_render_inputs(&render_inputs);

    assert_eq!(
      vars.get("title").and_then(|value| value.as_str()),
      Some("Quartalsbericht")
    );
    assert_eq!(
      vars
        .get("recipient_address")
        .and_then(|value| value.as_array())
        .map(|value| value.len()),
      Some(2)
    );
    assert!(vars.contains_key("ignored_null"));
    assert!(template_vars_from_render_inputs(&serde_json::json!({"typed_inputs": "invalid"})).is_empty());
    assert!(template_vars_from_render_inputs(&serde_json::json!({})).is_empty());
  }

  #[test]
  fn pipeline_error_from_render_timeout_carries_class() {
    let err = RenderError::Timeout { secs: 120 };
    let pe = PipelineError::from_render(&err);
    assert!(!pe.is_block_limit);
    assert_eq!(pe.class, "Timeout");
    assert!(pe.detail.contains("120"));
  }

  #[test]
  fn pipeline_error_from_render_page_limit_classifies_too_large() {
    let err = RenderError::PageLimit { count: 600, max: 500 };
    let pe = PipelineError::from_render(&err);
    assert!(!pe.is_block_limit, "page-limit is not a sync-fallback signal");
    assert_eq!(pe.class, "TooLarge");
  }
}
