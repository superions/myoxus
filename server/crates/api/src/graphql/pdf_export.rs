// SPDX-License-Identifier: AGPL-3.0-or-later
//! GraphQL types and resolvers for PDF export (create job, poll status).

use std::{
  collections::HashMap,
  fmt,
  sync::{Arc, LazyLock, Mutex},
  time::{Duration, Instant},
};

use async_graphql::{Context, InputObject, Result, SimpleObject};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use chrono::{DateTime, Utc};
use moka::future::Cache;
use myoxus_application::pdf_export::jobs::{PdfExportAdminJob, PdfExportAdminJobFilter, PdfExportJob};
use myoxus_application::permission::AccessController;
use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
use myoxus_domain::pdf_template_manifest::PdfTemplateManifest;
use sha2::{Digest, Sha256};
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

const PDF_TEMPLATE_PREVIEW_CACHE_CAPACITY: u64 = 256;
const PDF_TEMPLATE_PREVIEW_CACHE_TTL_SECS: u64 = 300;
const PDF_TEMPLATE_PREVIEW_PER_ACTOR_LIMIT: usize = 1;

static PDF_TEMPLATE_PREVIEW_CACHE: LazyLock<Cache<String, Arc<String>>> = LazyLock::new(|| {
  Cache::builder()
    .max_capacity(PDF_TEMPLATE_PREVIEW_CACHE_CAPACITY)
    .time_to_live(Duration::from_secs(PDF_TEMPLATE_PREVIEW_CACHE_TTL_SECS))
    .build()
});

static PDF_TEMPLATE_PREVIEW_RENDER_GUARD: LazyLock<Mutex<PreviewRenderGuardState>> =
  LazyLock::new(|| Mutex::new(PreviewRenderGuardState::default()));

#[derive(Default)]
struct PreviewRenderGuardState {
  global_running: usize,
  per_actor_running: HashMap<Uuid, usize>,
}

struct PreviewRenderPermit {
  actor_id: Uuid,
}

#[derive(Debug, Clone)]
enum PreviewCacheLoadError {
  Throttled {
    scope: &'static str,
    active: usize,
    limit: usize,
  },
  Timeout {
    timeout_ms: u128,
  },
  MemoryLimit,
  Render {
    message: String,
  },
  Internal {
    message: String,
  },
}

impl fmt::Display for PreviewCacheLoadError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Throttled { scope, active, limit } => {
        write!(
          f,
          "pdf template preview render throttled for {scope}: active={active}, limit={limit}"
        )
      }
      Self::Timeout { timeout_ms } => {
        write!(
          f,
          "template preview render failed: render timed out after {timeout_ms} ms"
        )
      }
      Self::MemoryLimit => write!(f, "template preview exceeded memory limit"),
      Self::Render { message } => write!(f, "template preview render failed: {message}"),
      Self::Internal { message } => write!(f, "template preview internal error: {message}"),
    }
  }
}

impl std::error::Error for PreviewCacheLoadError {}

impl Drop for PreviewRenderPermit {
  fn drop(&mut self) {
    let mut guard = PDF_TEMPLATE_PREVIEW_RENDER_GUARD
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.global_running = guard.global_running.saturating_sub(1);
    if let Some(count) = guard.per_actor_running.get_mut(&self.actor_id) {
      *count = count.saturating_sub(1);
      if *count == 0 {
        guard.per_actor_running.remove(&self.actor_id);
      }
    }
  }
}

fn try_acquire_preview_render_permit(
  actor_id: Uuid,
  global_limit: usize,
) -> std::result::Result<PreviewRenderPermit, PreviewCacheLoadError> {
  let mut guard = PDF_TEMPLATE_PREVIEW_RENDER_GUARD
    .lock()
    .map_err(|_| PreviewCacheLoadError::Internal {
      message: "pdf template preview render guard is poisoned".to_owned(),
    })?;
  let actor_running = guard.per_actor_running.get(&actor_id).copied().unwrap_or(0);
  if actor_running >= PDF_TEMPLATE_PREVIEW_PER_ACTOR_LIMIT {
    return Err(PreviewCacheLoadError::Throttled {
      scope: "actor",
      active: actor_running,
      limit: PDF_TEMPLATE_PREVIEW_PER_ACTOR_LIMIT,
    });
  }
  if guard.global_running >= global_limit {
    return Err(PreviewCacheLoadError::Throttled {
      scope: "global",
      active: guard.global_running,
      limit: global_limit,
    });
  }

  guard.global_running += 1;
  *guard.per_actor_running.entry(actor_id).or_insert(0) += 1;
  Ok(PreviewRenderPermit { actor_id })
}

pub(crate) fn invalidate_pdf_template_preview_cache(reason: &'static str) {
  PDF_TEMPLATE_PREVIEW_CACHE.invalidate_all();
  info!(
    cache_name = "pdf_template_preview",
    reason, "pdf template preview cache invalidated"
  );
}

fn normalise_preview_locale(locale: Option<&str>, default_locale: &str) -> String {
  locale
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .unwrap_or(default_locale)
    .to_ascii_lowercase()
}

fn pdf_template_preview_content_hash(
  manifest: &PdfTemplateManifest,
  files: &HashMap<String, Vec<u8>>,
) -> std::result::Result<String, PreviewCacheLoadError> {
  let mut hasher = Sha256::new();
  // Bump when preview content changes; template bytes alone cannot identify it.
  hasher.update(b"representative-preview-v1\0");
  let manifest_bytes =
    serde_json::to_vec(manifest).map_err(|e| PreviewCacheLoadError::Internal { message: e.to_string() })?;
  hasher.update(b"manifest\0");
  hasher.update(manifest_bytes);

  let mut entries: Vec<(&String, &Vec<u8>)> = files.iter().collect();
  entries.sort_by_key(|(path, _)| *path);
  for (path, bytes) in entries {
    hasher.update(b"\0file\0");
    hasher.update(path.as_bytes());
    hasher.update(b"\0");
    hasher.update(bytes);
  }

  Ok(format!("{:x}", hasher.finalize()))
}

fn preview_cache_error_to_gql(err: &PreviewCacheLoadError) -> async_graphql::Error {
  let mut gql = async_graphql::Error::new(err.to_string());
  gql.extensions = Some({
    let mut ext = async_graphql::ErrorExtensionValues::default();
    match err {
      PreviewCacheLoadError::Throttled { scope, active, limit } => {
        ext.set("class", "Throttled");
        ext.set("scope", *scope);
        ext.set("active", *active as i32);
        ext.set("limit", *limit as i32);
      }
      PreviewCacheLoadError::Timeout { timeout_ms } => {
        ext.set("class", "Timeout");
        ext.set("timeoutMs", *timeout_ms as i64);
      }
      PreviewCacheLoadError::MemoryLimit => {
        ext.set("class", "TooLarge");
      }
      PreviewCacheLoadError::Render { .. } => {
        ext.set("class", "TemplateError");
      }
      PreviewCacheLoadError::Internal { .. } => {
        ext.set("class", "InternalError");
      }
    }
    ext
  });
  gql
}

pub(crate) fn bundled_static_fonts_path() -> std::path::PathBuf {
  let relative = std::path::PathBuf::from("static/fonts");
  if relative.is_dir() {
    return relative;
  }
  let manifest_relative = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .and_then(|path| path.parent())
    .map(|server_root| server_root.join("static/fonts"));
  match manifest_relative {
    Some(path) if path.is_dir() => path,
    _ => relative,
  }
}

// ---------------------------------------------------------------------------
// GraphQL enum: job status
// ---------------------------------------------------------------------------

#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum PdfExportJobStatus {
  #[graphql(name = "queued")]
  Queued,
  #[graphql(name = "running")]
  Running,
  #[graphql(name = "done")]
  Done,
  #[graphql(name = "failed")]
  Failed,
}

impl PdfExportJobStatus {
  fn from_str(s: &str) -> Self {
    match s {
      "queued" => Self::Queued,
      "running" => Self::Running,
      "done" => Self::Done,
      "failed" => Self::Failed,
      _ => Self::Queued,
    }
  }

  fn as_db_str(self) -> &'static str {
    match self {
      Self::Queued => "queued",
      Self::Running => "running",
      Self::Done => "done",
      Self::Failed => "failed",
    }
  }
}

/// Filter object for the admin PDF-export diagnostics table.
///
/// Keeping the filters in one input object prevents resolver-argument drift as
/// the diagnostics UI grows and keeps this surface aligned with other admin
/// modules that pass explicit filter structs instead of loose fields.
#[derive(InputObject, Clone, Debug, Default)]
pub struct AdminPdfExportJobsFilterInput {
  pub status: Option<PdfExportJobStatus>,
  pub workspace_id: Option<String>,
  pub user_id: Option<String>,
  pub created_after: Option<DateTime<Utc>>,
  pub created_before: Option<DateTime<Utc>>,
  pub limit: Option<i32>,
}

// ---------------------------------------------------------------------------
// GraphQL output type: a PDF export job record
// ---------------------------------------------------------------------------

/// One PDF export job. Returned by `exportPdf` (sync or async path) and
/// `pdfExportJob` (poll). State machine: `queued → running → done|failed`.
/// Sync renders skip `queued`/`running` and land directly in `done` (or
/// fail with a GraphQL error before any row is returned).
#[derive(SimpleObject, Clone)]
pub struct PdfExportJobType {
  pub id: String,
  pub workspace_id: String,
  pub doc_id: String,
  pub status: PdfExportJobStatus,
  /// Present only when `status == done` and `output_blob_id` is set. The
  /// path is workspace-scoped: a leaked `id` alone is not enough to fetch
  /// the file (the REST handler re-checks workspace Read permission).
  pub download_url: Option<String>,
  /// Stable machine-readable failure category, set when `status == failed`.
  /// Possible values: `TooLarge`, `Timeout`, `RenderError`, `DecodeError`,
  /// `AssetError`, `TemplateError`, `StorageError`, `EnqueueError`,
  /// `Stalled`. Pin user-facing translations on this field, never on
  /// `error_detail`.
  pub error_class: Option<String>,
  /// Free-form failure message suitable for log lines. May contain
  /// renderer/storage-backend text and is **not** intended for end-user
  /// display.
  pub error_detail: Option<String>,
  pub created_at: DateTime<Utc>,
  /// Set when the worker (or sync path) begins rendering. `None` while the
  /// job is still `queued`. Clients can use `(now - started_at)` to estimate
  /// how long the active render has been running.
  pub started_at: Option<DateTime<Utc>>,
  /// Set when the job transitions to `done`. The download URL stops working
  /// after this timestamp; the nightly cleanup sweep purges the row and
  /// the underlying blob shortly after.
  pub expires_at: Option<DateTime<Utc>>,
  /// Number of pages in the rendered PDF. Populated when `status == done`;
  /// `None` while queued/running and on failed renders.
  pub page_count: Option<i32>,
  /// Theme font families the renderer could not match in the FontBook.
  /// This should stay empty in production because the API resolves every
  /// effective role to a pinned TTF/OTF/VF asset before dispatch. A non-empty
  /// value is therefore diagnostic evidence that the server-side Theme DB gate
  /// was bypassed or an asset vanished after enqueue.
  pub unmapped_font_families: Vec<String>,
}

/// Latest render-audit projection attached to an admin job row.
#[derive(SimpleObject, Clone)]
pub struct PdfExportRenderAuditType {
  pub id: String,
  pub document_version_id: Option<String>,
  pub template_version: String,
  pub render_appearance_hash: String,
  pub locale: String,
  pub classification: Option<String>,
  pub l3_inputs: serde_json::Value,
  pub document_metadata_snapshot: serde_json::Value,
  pub metadata_validation: serde_json::Value,
  pub created_at: DateTime<Utc>,
}

/// Admin-facing job row used by the PDF Export render-jobs tab.
#[derive(SimpleObject, Clone)]
pub struct PdfExportAdminJobType {
  pub id: String,
  pub workspace_id: String,
  pub doc_id: String,
  pub requested_by: String,
  pub requested_by_email: Option<String>,
  pub requested_by_name: Option<String>,
  pub template_id: String,
  pub status: PdfExportJobStatus,
  pub sync_or_async: String,
  pub page_count: Option<i32>,
  pub error_class: Option<String>,
  pub error_detail: Option<String>,
  pub created_at: DateTime<Utc>,
  pub started_at: Option<DateTime<Utc>>,
  pub finished_at: Option<DateTime<Utc>>,
  pub expires_at: Option<DateTime<Utc>>,
  /// Wall-clock duration in milliseconds when enough timestamps are known.
  /// Running jobs use `now - started_at`; queued jobs return `None`.
  pub duration_ms: Option<i64>,
  pub unmapped_font_families: Vec<String>,
  pub audit: Option<PdfExportRenderAuditType>,
}

/// Workspace-facing PDF export history entry for one document.
///
/// Unlike the admin jobs table this intentionally exposes only the fields a
/// document user needs for re-download/re-export. Authorization is checked per
/// workspace before any row is returned.
#[derive(SimpleObject, Clone)]
pub struct PdfExportHistoryEntryType {
  pub id: String,
  pub workspace_id: String,
  pub doc_id: String,
  pub template_id: String,
  pub status: PdfExportJobStatus,
  pub download_url: Option<String>,
  pub error_class: Option<String>,
  pub error_detail: Option<String>,
  pub render_inputs: serde_json::Value,
  pub page_count: Option<i32>,
  pub created_at: DateTime<Utc>,
  pub started_at: Option<DateTime<Utc>>,
  pub finished_at: Option<DateTime<Utc>>,
  pub expires_at: Option<DateTime<Utc>>,
  pub unmapped_font_families: Vec<String>,
}

// ---------------------------------------------------------------------------
// GraphQL input type
// ---------------------------------------------------------------------------

/// V2 export input (`P-PDF-TPL-11-01`). Mirrors the application-layer
/// [`PdfExportInputV2`] one-to-one so the GraphQL surface accepts the
/// full L3 shape declared by the V2 PDF-Export architecture (D1/D2/D3
/// in `docs/dev/server/pdf-export-v2-architecture.md`). Every optional
/// field is gated by the template's capability matrix at validation
/// time — the [`exportPdf`] mutation refuses inputs that touch
/// off-capabilities before any render is dispatched.
///
/// [`PdfExportInputV2`]: myoxus_application::pdf_export::render_context::PdfExportInputV2
/// [`exportPdf`]: PdfExportMutation::export_pdf
#[derive(InputObject, Clone, Debug)]
pub struct PdfExportInputV2Input {
  /// Workspace UUID (string-form for GraphQL transport).
  pub workspace_id: String,
  /// Document UUID. Nanoid forms are accepted by the underlying parser
  /// but the canonical wire form is the UUIDv5 derived from the nanoid.
  pub doc_id: String,
  /// Template selector — accepts the kebab-case slug
  /// (`"default"`/`"report"`/`"letter"`) or a UUID. The slug path is
  /// preserved for backward compat with clients that have not migrated
  /// to UUIDs; both forms resolve through the V2 registry.
  pub template_id: String,
  /// Override locale (BCP-47, e.g. `"de-AT"`). Falls through to the
  /// brand default and finally to the server default when `None`.
  pub locale: Option<String>,
  /// Per-render override for the paper size: `"A4"`, `"Letter"`, `"A3"`,
  /// `"A5"`, or `"16:9"`. The renderer consumes these V2 literals directly.
  pub paper_size: Option<String>,
  /// Page orientation. Always available independent of template capabilities.
  /// Defaults to portrait for every export.
  pub orientation: Option<String>,
  /// Image quality tier. Accepts `"low"` / `"med"` / `"high"` /
  /// `"lossless"`. This per-render value overrides `pdf_export_settings`
  /// and is persisted in the render-input/audit snapshot.
  pub image_quality: Option<String>,
  /// Optional PDF writer standards profile. Accepted values are
  /// `"standard"`, `"pdfa-1b"`, `"pdfa-2b"`, `"pdfa-2u"`, `"pdfa-3b"` and
  /// `"pdfua-1"`. PDF/X is intentionally not accepted until the renderer
  /// has a proven PDF/X output path.
  pub compliance_profile: Option<String>,
  /// Cover-page override; absence uses the selected template default.
  pub cover_page: Option<bool>,
  /// TOC behavior — `"off"` / `"auto"` / `"force"`.
  pub toc_behavior: Option<String>,
  /// Footer layout from the selected template capability; absence keeps its default.
  pub footer_style: Option<String>,
  /// Page-number format independent of the selected footer layout.
  pub page_numbering: Option<String>,
  /// Color treatment applied to the effective document palette.
  pub color_variant: Option<String>,
  /// Confidentiality watermark label. Must be present in the
  /// manifest's `confidentialityLabels` allowed-set.
  pub confidentiality_label: Option<String>,
  /// Free-form template inputs validated against the manifest's
  /// `inputs_schema`. Persisted on `pdf_export_render_audit.l3_inputs`
  /// for compliance.
  pub typed_inputs: Option<async_graphql::Json<serde_json::Value>>,
  /// Document-version selector from the export dialog.
  ///
  /// `latest` means "current document state"; if document versioning is
  /// enabled and `on_pdf_export` is configured, the server captures a named
  /// snapshot before rendering. A UUID pins the render to that named version's
  /// DocHistory snapshot.
  pub document_version_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Row → type mapping helper
// ---------------------------------------------------------------------------

fn job_to_type(job: PdfExportJob) -> PdfExportJobType {
  let status = PdfExportJobStatus::from_str(&job.status);
  let download_url = if matches!(status, PdfExportJobStatus::Done) && job.output_blob_id.is_some() {
    Some(format!("/api/pdf-export/{}/download", job.id))
  } else {
    None
  };

  PdfExportJobType {
    id: job.id.to_string(),
    workspace_id: job.workspace_id.to_string(),
    doc_id: job.doc_id.to_string(),
    status,
    download_url,
    error_class: job.error_class,
    error_detail: job.error_detail,
    created_at: job.created_at,
    started_at: job.started_at,
    expires_at: job.expires_at,
    page_count: job.page_count,
    unmapped_font_families: job.unmapped_font_families,
  }
}

fn admin_job_to_type(record: PdfExportAdminJob) -> PdfExportAdminJobType {
  let job = record.job;
  let status = PdfExportJobStatus::from_str(&job.status);
  let duration_ms = job.started_at.map(|start| {
    let end = job.finished_at.unwrap_or_else(Utc::now);
    (end - start).num_milliseconds().max(0)
  });
  let audit = record.audit.map(|audit| PdfExportRenderAuditType {
    id: audit.id.to_string(),
    document_version_id: audit.document_version_id.map(|id| id.to_string()),
    template_version: audit.template_version,
    render_appearance_hash: audit.render_appearance_hash,
    locale: audit.locale,
    classification: audit.classification,
    l3_inputs: audit.l3_inputs,
    document_metadata_snapshot: audit.document_metadata_snapshot,
    metadata_validation: audit.metadata_validation,
    created_at: audit.created_at,
  });

  PdfExportAdminJobType {
    id: job.id.to_string(),
    workspace_id: job.workspace_id.to_string(),
    doc_id: job.doc_id.to_string(),
    requested_by: job.requested_by.to_string(),
    requested_by_email: record.requested_by_email,
    requested_by_name: record.requested_by_name,
    template_id: job.template_id,
    status,
    sync_or_async: job.sync_or_async,
    page_count: job.page_count,
    error_class: job.error_class,
    error_detail: job.error_detail,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    expires_at: job.expires_at,
    duration_ms,
    unmapped_font_families: job.unmapped_font_families,
    audit,
  }
}

fn job_to_history_entry_type(job: PdfExportJob) -> PdfExportHistoryEntryType {
  let status = PdfExportJobStatus::from_str(&job.status);
  PdfExportHistoryEntryType {
    id: job.id.to_string(),
    workspace_id: job.workspace_id.to_string(),
    doc_id: job.doc_id.to_string(),
    template_id: job.template_id,
    status,
    download_url: if job.status == "done" && job.output_blob_id.is_some() {
      Some(format!("/api/pdf-export/{}/download", job.id))
    } else {
      None
    },
    error_class: job.error_class,
    error_detail: job.error_detail,
    render_inputs: job.render_inputs,
    page_count: job.page_count,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    expires_at: job.expires_at,
    unmapped_font_families: job.unmapped_font_families,
  }
}

// ---------------------------------------------------------------------------
// Sync-render error sanitization (PDFREV-SEC-03)
// ---------------------------------------------------------------------------

/// Map a stable error `class` (as emitted by the worker, see
/// `pdf_export_handler::{ir,render}_error_to_class`) to a deterministic
/// one-line summary that is safe to surface on the GraphQL wire.
///
/// The matching `detail` strings stay server-side: they may contain Typst
/// compiler text, opendal/S3 backend codes, asset paths, or workspace-internal
/// block UUIDs — none of which a remote client should see. This summary is
/// stable so the frontend can pin user-facing translations on the `class`
/// extension instead of the message.
// ---------------------------------------------------------------------------
// Query root
// ---------------------------------------------------------------------------

pub struct PdfExportQueryRoot;

#[async_graphql::Object]
impl PdfExportQueryRoot {
  /// Inline preview for a template bundle.
  ///
  /// Renders the validator stub document through the materialised template and
  /// returns base64-encoded PDF bytes. Preview renders are cached by template
  /// identity + content hash + locale and protected by an in-process render
  /// guard so repeated UI refreshes cannot stampede the Typst blocking pool.
  ///
  /// Authorization:
  /// - Without `workspace_id`, the resolver is admin-only for the Admin
  ///   Template detail drawer.
  /// - With `workspace_id`, the caller must have workspace Read permission and
  ///   the template must be explicitly assigned to that workspace. This is the
  ///   workspace-facing thumbnail path; it deliberately reuses the same render
  ///   cache instead of creating a second preview API root.
  #[instrument(skip(self, ctx), level = "debug")]
  pub async fn pdf_template_preview_pdf(
    &self,
    ctx: &Context<'_>,
    template_id: String,
    locale: Option<String>,
    workspace_id: Option<String>,
  ) -> Result<String> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let workspace_uuid = workspace_id
      .as_deref()
      .map(Uuid::parse_str)
      .transpose()
      .map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let actor_id = if let Some(workspace_uuid) = workspace_uuid {
      let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
      state
        .permission_service()
        .assert(
          &myoxus_application::permission::WorkspaceResource {
            user_id: snapshot.user.id,
            workspace_id: workspace_uuid,
          },
          myoxus_domain::permission::WorkspaceAction::Read,
        )
        .await
        .map_err(crate::graphql::utils::map_gql_error)?;
      snapshot.user.id
    } else {
      crate::graphql::ensure_admin_snapshot_fn(ctx, state).await?.user.id
    };
    let Some(pool) = state.metrics_pool() else {
      return Err(async_graphql::Error::new("DB unavailable"));
    };
    let template_repo = state
      .pdf_template_repo()
      .ok_or_else(|| async_graphql::Error::new("pdf template repository is not configured on this server"))?;
    let blob_store = state
      .pdf_blob_store()
      .ok_or_else(|| async_graphql::Error::new("pdf blob store is not configured on this server"))?;
    let registry = myoxus_infrastructure::pdf_export::PgPdfTemplateRegistry::new(pool, template_repo, blob_store);
    use myoxus_pdf_export::template_v2::PdfTemplateRegistry as _;
    let loaded = match if let Ok(tpl_uuid) = Uuid::parse_str(&template_id) {
      registry.load(tpl_uuid).await
    } else {
      registry.load_by_slug(&template_id).await
    } {
      Ok(loaded) => loaded,
      Err(e) => {
        let preview_scope = workspace_uuid.map_or_else(|| "admin".to_owned(), |id| id.to_string());
        warn!(
          template_ref = %template_id,
          workspace_id = %preview_scope,
          actor_id = %actor_id,
          error = %e,
          "pdf template preview registry load failed"
        );
        if workspace_uuid.is_some() {
          return Err(crate::graphql::utils::map_gql_error(
            myoxus_application::auth::AuthError::ActionForbidden,
          ));
        }
        return Err(async_graphql::Error::new(format!("template registry: {e}")));
      }
    };

    if let Some(workspace_uuid) = workspace_uuid {
      let assignment_repo = state
        .pdf_assignment_repo()
        .ok_or_else(|| async_graphql::Error::new("pdf assignment repository is not configured on this server"))?;
      let assigned = assignment_repo
        .get(workspace_uuid, loaded.id)
        .await
        .map_err(|e| async_graphql::Error::new(e.to_string()))?
        .is_some();
      if !assigned {
        warn!(
          template_id = %loaded.id,
          slug = %loaded.slug,
          workspace_id = %workspace_uuid,
          actor_id = %actor_id,
          "workspace member tried to preview an unassigned pdf template"
        );
        return Err(crate::graphql::utils::map_gql_error(
          myoxus_application::auth::AuthError::ActionForbidden,
        ));
      }
    }

    let preview_locale = normalise_preview_locale(locale.as_deref(), &state.config.i18n.default_locale);
    let content_hash =
      pdf_template_preview_content_hash(&loaded.manifest, &loaded.files).map_err(|e| preview_cache_error_to_gql(&e))?;
    let content_hash_prefix = content_hash.chars().take(12).collect::<String>();
    let cache_key = format!(
      "{}:{}:{}:{}:{}",
      loaded.id, loaded.slug, loaded.version, preview_locale, content_hash
    );
    if let Some(cached) = PDF_TEMPLATE_PREVIEW_CACHE.get(&cache_key).await {
      debug!(
        template_id = %loaded.id,
        slug = %loaded.slug,
        version = %loaded.version,
        locale = %preview_locale,
        actor_id = %actor_id,
        content_hash = %content_hash_prefix,
        cache_name = "pdf_template_preview",
        "pdf template preview cache hit"
      );
      return Ok(cached.as_ref().clone());
    }

    debug!(
      template_id = %loaded.id,
      slug = %loaded.slug,
      version = %loaded.version,
      locale = %preview_locale,
      actor_id = %actor_id,
      content_hash = %content_hash_prefix,
      cache_name = "pdf_template_preview",
      "pdf template preview cache miss"
    );

    let execution_limits = crate::pdf_export_adapter::effective_pdf_limits(state)
      .await
      .map_err(|_| async_graphql::Error::new("PDF resource configuration is unavailable"))?;
    let compiler_limits = myoxus_pdf_export::execution::CompilerLimits {
      watchdog: execution_limits.render_timeout.max(Duration::from_secs(1)),
      max_memory_mb: execution_limits.max_memory_mb,
    };
    let render_timeout = compiler_limits.watchdog;
    let global_limit = (state.config.pdf_export.limits.max_concurrent_per_workspace as usize).max(1);
    let files = loaded.files.clone();
    let manifest = loaded.manifest.clone();
    let loaded_id = loaded.id;
    let loaded_slug = loaded.slug.clone();
    let loaded_version = loaded.version.clone();
    let loader_slug = loaded_slug.clone();
    let loader_version = loaded_version.clone();
    let loader_locale = preview_locale.clone();
    let loader_hash_prefix = content_hash_prefix.clone();

    let rendered: std::result::Result<Arc<String>, Arc<PreviewCacheLoadError>> = PDF_TEMPLATE_PREVIEW_CACHE
      .try_get_with(cache_key, async move {
        let started = Instant::now();
        let permit = try_acquire_preview_render_permit(actor_id, global_limit)?;
        let pdf_bytes =
          myoxus_pdf_export::template_v2::compile_validator::render_preview_pdf_bytes_with_limits_and_permit(
            &files,
            &manifest,
            &loader_locale,
            compiler_limits,
            permit,
          )
          .await
          .map_err(|e| match e {
            myoxus_pdf_export::template_v2::CompileError::Timeout => PreviewCacheLoadError::Timeout {
              timeout_ms: render_timeout.as_millis(),
            },
            myoxus_pdf_export::template_v2::CompileError::MemoryLimit => PreviewCacheLoadError::MemoryLimit,
            other => PreviewCacheLoadError::Render {
              message: other.to_string(),
            },
          })?;
        let duration_ms = started.elapsed().as_millis();
        info!(
          template_id = %loaded_id,
          slug = %loader_slug,
          version = %loader_version,
          locale = %loader_locale,
          actor_id = %actor_id,
          bytes = pdf_bytes.len(),
          timeout_ms = render_timeout.as_millis(),
          duration_ms,
          global_limit,
          content_hash = %loader_hash_prefix,
          cache_name = "pdf_template_preview",
          "pdf template preview rendered and cached"
        );
        Ok(Arc::new(BASE64_STANDARD.encode(pdf_bytes)))
      })
      .await;

    match rendered {
      Ok(encoded) => Ok(encoded.as_ref().clone()),
      Err(e) => {
        warn!(
          template_id = %loaded_id,
          slug = %loaded_slug,
          version = %loaded_version,
          locale = %preview_locale,
          actor_id = %actor_id,
          error_class = match e.as_ref() {
            PreviewCacheLoadError::Throttled { .. } => "Throttled",
            PreviewCacheLoadError::Timeout { .. } => "Timeout",
            PreviewCacheLoadError::MemoryLimit => "TooLarge",
            PreviewCacheLoadError::Render { .. } => "TemplateError",
            PreviewCacheLoadError::Internal { .. } => "InternalError",
          },
          content_hash = %content_hash_prefix,
          cache_name = "pdf_template_preview",
          "pdf template preview render/cache load failed"
        );
        Err(preview_cache_error_to_gql(e.as_ref()))
      }
    }
  }

  /// Admin-only render-job list for the PDF Export diagnostics tab.
  ///
  /// Defaults to the last 24 hours and clamps `limit` to 1..=200 so the
  /// table cannot become an accidental unbounded export endpoint.
  #[instrument(skip(self, ctx), level = "debug")]
  pub async fn admin_pdf_export_jobs(
    &self,
    ctx: &Context<'_>,
    filter: Option<AdminPdfExportJobsFilterInput>,
  ) -> Result<Vec<PdfExportAdminJobType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    crate::graphql::ensure_admin(ctx, state).await?;
    let filter = filter.unwrap_or_default();

    let workspace_uuid = filter
      .workspace_id
      .as_deref()
      .map(Uuid::parse_str)
      .transpose()
      .map_err(|_| async_graphql::Error::new("invalid workspace_id"))?;
    let user_uuid = filter
      .user_id
      .as_deref()
      .map(Uuid::parse_str)
      .transpose()
      .map_err(|_| async_graphql::Error::new("invalid user_id"))?;
    let jobs = state
      .pdf_export_jobs()
      .list_admin(&PdfExportAdminJobFilter {
        status: filter.status.map(|status| status.as_db_str().to_string()),
        workspace_id: workspace_uuid,
        user_id: user_uuid,
        created_after: filter.created_after,
        created_before: filter.created_before,
        limit: filter.limit.unwrap_or(100).clamp(1, 200) as i64,
      })
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;
    Ok(jobs.into_iter().map(admin_job_to_type).collect())
  }

  /// Poll the status of a PDF export job.
  ///
  /// Authorization: the caller must be the original requester
  /// (`requested_by`) **or** hold workspace Read permission on the job's
  /// workspace. A non-matching caller without Read permission gets the
  /// permission service's standard error (no row leak).
  ///
  /// The recommended client polling cadence is 2 s with exponential
  /// backoff to a 10 s ceiling — see `docs/dev/clients/pdf-export-architecture.md`
  /// § 9. When `status == done`, `download_url` is populated and the
  /// caller can issue an authenticated `GET` to fetch the PDF; the URL
  /// stops working after `expires_at`.
  #[instrument(skip(self, ctx), level = "debug")]
  pub async fn pdf_export_job(&self, ctx: &Context<'_>, job_id: String) -> Result<PdfExportJobType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;

    let job_uuid = Uuid::parse_str(&job_id).map_err(|_| async_graphql::Error::new("invalid job_id"))?;

    crate::pdf_export_adapter::create_get_service(state.clone())
      .get(snapshot.user.id, job_uuid)
      .await
      .map(job_to_type)
      .map_err(crate::pdf_export_adapter::map_pdf_error)
  }

  /// List recent PDF export jobs for a document.
  ///
  /// Authorization is workspace-read based. Rows are returned only after the
  /// caller has Read permission on the row's workspace; this avoids leaking
  /// whether another workspace has a colliding document id.
  #[instrument(skip(self, ctx), level = "debug")]
  pub async fn document_pdf_export_history(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    limit: Option<i32>,
  ) -> Result<Vec<PdfExportHistoryEntryType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
    let workspace_uuid =
      Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace_id"))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(state, workspace_uuid, &doc_id).await?;
    let limit = limit.unwrap_or(20).clamp(1, 100) as i64;

    let rows = state
      .pdf_export_jobs()
      .list_document(doc_uuid, limit)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;

    let mut out = Vec::with_capacity(rows.len());
    for job in rows {
      if state
        .permission_service()
        .assert(
          &myoxus_application::permission::WorkspaceResource {
            user_id: snapshot.user.id,
            workspace_id: job.workspace_id,
          },
          myoxus_domain::permission::WorkspaceAction::Read,
        )
        .await
        .is_ok()
      {
        out.push(job_to_history_entry_type(job));
      }
    }

    debug!(
      doc_id = %doc_uuid,
      user_id = %snapshot.user.id,
      rows = out.len(),
      "pdf export document history listed"
    );
    Ok(out)
  }
}

// ---------------------------------------------------------------------------
// Mutation root
// ---------------------------------------------------------------------------

pub struct PdfExportMutationRoot;

#[async_graphql::Object]
impl PdfExportMutationRoot {
  /// Cancel a queued PDF export job.
  ///
  /// Authorization: the caller must be the original requester or an admin.
  /// Workspace readers who did not start the job cannot cancel it, because a
  /// PDF export is scoped to `requested_by` for both idempotency and download
  /// ownership. Running jobs are not interrupted because the Typst render runs
  /// in a blocking thread that cannot be safely killed. Returns `true` only
  /// when a queued row was transitioned to failed.
  #[instrument(skip(self, ctx), level = "debug")]
  pub async fn cancel_pdf_export_job(&self, ctx: &Context<'_>, job_id: String) -> Result<bool> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
    let job_uuid = Uuid::parse_str(&job_id).map_err(|_| async_graphql::Error::new("invalid job_id"))?;

    let Some(job) = state
      .pdf_export_jobs()
      .get(job_uuid)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?
    else {
      debug!(job_id = %job_uuid, user_id = %snapshot.user.id, "pdf export cancel requested for unknown job");
      return Ok(false);
    };

    let requested_by = job.requested_by;
    let actor_is_owner = requested_by == snapshot.user.id;
    let actor_is_admin = snapshot.user.is_admin;
    if !actor_is_owner && !actor_is_admin {
      warn!(
        job_id = %job_uuid,
        user_id = %snapshot.user.id,
        requested_by = %requested_by,
        "pdf export cancel denied for non-owner"
      );
      return Ok(false);
    }

    let cancel_detail = if actor_is_admin && !actor_is_owner {
      "cancelled by admin"
    } else {
      "cancelled by requester"
    };
    let cancelled_job = state
      .pdf_export_jobs()
      .cancel_queued(job_uuid, cancel_detail)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;

    let cancelled = cancelled_job.is_some();
    info!(
      job_id = %job_uuid,
      user_id = %snapshot.user.id,
      requested_by = %requested_by,
      actor_is_admin,
      cancelled,
      "pdf export job cancel requested"
    );
    if let Some(cancelled_job) = cancelled_job {
      let actor = crate::graphql::admin::resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "pdf_export.cancel",
          AuditCategory::PdfExportConfig,
          Some(AuditTarget::entity("pdf_export_job", job_uuid, None)),
          actor,
          None,
          Some(serde_json::json!({
            "jobId": job_uuid.to_string(),
            "workspaceId": cancelled_job.workspace_id.to_string(),
            "docId": cancelled_job.doc_id.to_string(),
            "requestedBy": cancelled_job.requested_by.to_string(),
            "templateId": cancelled_job.template_id,
            "cancelledBy": if actor_is_admin && !actor_is_owner { "admin" } else { "requester" },
          })),
        ))
        .await;
    }
    Ok(cancelled)
  }

  /// V2 export mutation (`P-PDF-TPL-11-{01,02}`).
  ///
  /// Accepts the full L3-input shape declared in
  /// `application::pdf_export::render_context::PdfExportInputV2` (locale,
  /// paper_size, image_quality, cover_page, toc_behavior,
  /// confidentiality_label, typed_inputs). Runs
  /// [`validate_inputs_against_manifest`] before any DB write so an
  /// off-capability input (e.g. a confidentiality label against a
  /// template that disabled the capability) is rejected with
  /// `extensions.class = "CapabilityViolation"` and a structured list of
  /// violations.
  ///
  /// On a clean validation the same V2 input is dispatched to the render
  /// pipeline and persisted on the job/audit rows with V2 field names.
  ///
  /// **Authorization** requires workspace `Read` permission, plus an active
  /// assignment to the resolved template, whether selected by UUID or slug.
  ///
  /// **Idempotency / concurrency / audit**: handled by the V2 dispatch helper
  /// after capability validation.
  ///
  /// [`validate_inputs_against_manifest`]:
  /// myoxus_application::pdf_export::capability_validator::validate_inputs_against_manifest
  #[instrument(skip(self, ctx, input), fields(
    workspace_id = %input.workspace_id,
    doc_id = %input.doc_id,
    template_id = %input.template_id,
  ))]
  pub async fn export_pdf(&self, ctx: &Context<'_>, input: PdfExportInputV2Input) -> Result<PdfExportJobType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
    let workspace_id =
      Uuid::parse_str(&input.workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace_id"))?;
    let doc_id = crate::graphql::utils::resolve_doc_id(state, workspace_id, &input.doc_id).await?;
    let actor = crate::graphql::admin::resolve_audit_actor(ctx).await;
    let request = myoxus_application::pdf_export::service::PdfExportCreateRequest {
      workspace_id,
      doc_id,
      template_id: input.template_id,
      locale: input.locale,
      paper_size: input.paper_size,
      orientation: input.orientation,
      image_quality: input.image_quality,
      compliance_profile: input.compliance_profile,
      cover_page: input.cover_page,
      toc_behavior: input.toc_behavior,
      footer_style: input.footer_style,
      page_numbering: input.page_numbering,
      color_variant: input.color_variant,
      confidentiality_label: input.confidentiality_label,
      document_version_id: input.document_version_id,
      typed_inputs: input.typed_inputs.map(|value| value.0),
    };
    crate::pdf_export_adapter::create_get_service(state.clone())
      .create(actor, snapshot.user.id, request)
      .await
      .map(job_to_type)
      .map_err(crate::pdf_export_adapter::map_pdf_error)
  }
}
