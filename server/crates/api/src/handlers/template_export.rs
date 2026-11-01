//! Authenticated native template bundle downloads.
//!
//! `GET /api/admin/templates/export/{revision_id}` — admin-only binary download.
//! `POST /api/admin/templates/workspace-source/export` — current transactional source capture.

use axum::{
  extract::{Path, State},
  http::{HeaderMap, StatusCode, header},
  response::IntoResponse,
};
use myoxus_application::template_registry::bundle;
use myoxus_application::{
  document_metadata::DocumentMetadataServiceError,
  document_template::{DocumentTemplateCaptureError, DocumentTemplateCaptureRequest, DocumentTemplateError},
  template_registry::source_export::{
    DocumentTemplateBundleMetadata, DocumentTemplateSourceExportError, LocalizedDocumentTemplateCapture,
    compose_source_export,
  },
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tracing::{instrument, warn};
use uuid::Uuid;

use crate::request_id::REQUEST_ID_HEADER;
use crate::state::ApiState;

/// Response header carrying the SHA-256 of the exported ZIP bytes.
const EXPORT_CONTAINER_CHECKSUM_HEADER: header::HeaderName =
  header::HeaderName::from_static("x-template-export-container-sha256");
/// Response header carrying the SHA-256 of the `content.template.zip` payload used for export.
const EXPORT_CONTENT_CHECKSUM_HEADER: header::HeaderName =
  header::HeaderName::from_static("x-template-export-content-sha256");

/// This endpoint accepts selection metadata, never uploaded document bodies.
pub(crate) const MAX_WORKSPACE_SOURCE_EXPORT_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceTemplateSourceSelection {
  doc_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceTemplateSourceLocale {
  locale: String,
  source: WorkspaceTemplateSourceSelection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceTemplateSourceExportRequest {
  workspace_id: Uuid,
  source: WorkspaceTemplateSourceSelection,
  metadata: DocumentTemplateBundleMetadata,
  #[serde(default)]
  localized_sources: Vec<WorkspaceTemplateSourceLocale>,
}

type SourceExportFailure = (StatusCode, axum::Json<serde_json::Value>);

/// Download current persisted workspace sources without importing or publishing
/// them. The server captures current sources in one transaction and applies
/// ordinary source/asset ACLs. Discovery revisions are not preconditions.
#[instrument(skip_all)]
pub(crate) async fn workspace_template_source_export_handler(
  State(state): State<ApiState>,
  headers: HeaderMap,
  axum::Json(request): axum::Json<WorkspaceTemplateSourceExportRequest>,
) -> Result<impl IntoResponse, SourceExportFailure> {
  let actor_id = crate::require_admin_user(&state, &headers)
    .await
    .map_err(|status| source_export_failure(status, "UNAUTHORIZED", "Admin access is required", None))?;
  if !crate::graphql::template_registry::is_template_registry_enabled(&state).await {
    return Err(source_export_failure(
      StatusCode::SERVICE_UNAVAILABLE,
      "TEMPLATES_UNAVAILABLE",
      "template registry is not enabled",
      None,
    ));
  }
  let registry = state.template_registry().ok_or_else(|| {
    source_export_failure(
      StatusCode::SERVICE_UNAVAILABLE,
      "TEMPLATES_UNAVAILABLE",
      "template registry is unavailable",
      None,
    )
  })?;
  let limits = registry.zip_limits();
  if request.localized_sources.len() as u64 + 2 > limits.max_entries {
    return Err(source_export_failure(
      StatusCode::PAYLOAD_TOO_LARGE,
      "BUNDLE_LIMIT_EXCEEDED",
      "too many native language sources",
      None,
    ));
  }
  let templates = state.document_template_service().ok_or_else(|| {
    source_export_failure(
      StatusCode::SERVICE_UNAVAILABLE,
      "TEMPLATES_UNAVAILABLE",
      "document template service is unavailable",
      None,
    )
  })?;
  let assets = state.blob_service();
  let external_ids = std::iter::once(request.source.doc_id)
    .chain(
      request
        .localized_sources
        .iter()
        .map(|variant| variant.source.doc_id.clone()),
    )
    .collect();
  let captured = templates
    .capture_sources(
      DocumentTemplateCaptureRequest {
        actor_id,
        workspace_id: request.workspace_id,
        external_ids,
      },
      assets.as_ref(),
      limits,
    )
    .await
    .map_err(|error| source_capture_failure(error, "/source"))?;
  let mut captured = captured.into_iter();
  let source = captured.next().expect("capture includes its primary source");
  let localized = request
    .localized_sources
    .into_iter()
    .zip(captured)
    .map(|(variant, source)| LocalizedDocumentTemplateCapture {
      locale: variant.locale,
      source,
    })
    .collect::<Vec<_>>();
  let exported = compose_source_export(request.metadata, &source, &localized, limits).map_err(|error| match error {
    DocumentTemplateSourceExportError::InvalidMetadata(findings) => (
      StatusCode::UNPROCESSABLE_ENTITY,
      axum::Json(
        serde_json::json!({"code":"INVALID_METADATA", "error":"invalid native bundle metadata", "findings":findings}),
      ),
    ),
    DocumentTemplateSourceExportError::InvalidLocale => source_export_failure(
      StatusCode::UNPROCESSABLE_ENTITY,
      "INVALID_LOCALE_MAPPING",
      "each language requires exactly one selected native source",
      Some("/localizedSources"),
    ),
    DocumentTemplateSourceExportError::UnsupportedSource => source_export_failure(
      StatusCode::UNPROCESSABLE_ENTITY,
      "UNSUPPORTED_SOURCE",
      "only Page template sources can be exported",
      None,
    ),
    DocumentTemplateSourceExportError::InvalidContent => source_export_failure(
      StatusCode::UNPROCESSABLE_ENTITY,
      "INVALID_CONTENT",
      "native source bundle validation failed",
      None,
    ),
    DocumentTemplateSourceExportError::LimitExceeded => source_export_failure(
      StatusCode::PAYLOAD_TOO_LARGE,
      "BUNDLE_LIMIT_EXCEEDED",
      "native bundle exceeds configured archive limits",
      None,
    ),
  })?;
  tracing::info!(%actor_id, workspace_id = %request.workspace_id, locale_sources = localized.len(), "workspace template source bundle exported");
  Ok((
    StatusCode::OK,
    [
      (EXPORT_CONTAINER_CHECKSUM_HEADER, exported.container_checksum),
      (EXPORT_CONTENT_CHECKSUM_HEADER, exported.content_checksum),
      (header::CACHE_CONTROL, "no-store".to_owned()),
      (header::CONTENT_TYPE, "application/zip".to_owned()),
      (
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{}\"", exported.filename),
      ),
    ],
    exported.bytes,
  ))
}

fn source_capture_failure(error: DocumentTemplateCaptureError, path: &str) -> SourceExportFailure {
  use DocumentTemplateCaptureError as Error;
  let (status, code, message) = match error {
    // A source-scoped denial must not invalidate the valid global Admin session.
    Error::Template(DocumentTemplateError::Forbidden | DocumentTemplateError::NotFound)
    | Error::Template(DocumentTemplateError::Metadata(DocumentMetadataServiceError::NotFound)) => (
      StatusCode::NOT_FOUND,
      "SOURCE_UNAVAILABLE",
      "workspace template source is no longer available",
    ),
    Error::Template(DocumentTemplateError::InvalidDocumentKey) => (
      StatusCode::BAD_REQUEST,
      "INVALID_SOURCE",
      "invalid workspace template source identity",
    ),
    Error::UnsupportedContent
    | Error::Template(DocumentTemplateError::Content | DocumentTemplateError::InvalidVariables) => (
      StatusCode::UNPROCESSABLE_ENTITY,
      "UNSUPPORTED_CONTENT",
      "workspace template source contains unsupported native content",
    ),
    Error::UnsupportedReference => (
      StatusCode::UNPROCESSABLE_ENTITY,
      "UNSUPPORTED_REFERENCE",
      "workspace template source has unsupported or private dependencies",
    ),
    Error::AssetUnavailable => (
      StatusCode::UNPROCESSABLE_ENTITY,
      "ASSET_UNAVAILABLE",
      "a referenced source file is missing, deleted or incomplete",
    ),
    Error::LimitExceeded => (
      StatusCode::PAYLOAD_TOO_LARGE,
      "BUNDLE_LIMIT_EXCEEDED",
      "workspace template source exceeds configured archive limits",
    ),
    Error::Template(_) => (
      StatusCode::INTERNAL_SERVER_ERROR,
      "SOURCE_CAPTURE_FAILED",
      "workspace template source capture failed",
    ),
  };
  source_export_failure(status, code, message, Some(path))
}

fn source_export_failure(status: StatusCode, code: &str, message: &str, path: Option<&str>) -> SourceExportFailure {
  (
    status,
    axum::Json(serde_json::json!({"code":code, "error":message, "path":path})),
  )
}

/// Compute a hex-encoded SHA-256 digest for the provided bytes.
fn sha256_hex(bytes: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  format!("{:x}", hasher.finalize())
}

/// `GET /api/admin/templates/export/{revision_id}` — export a template revision as a ZIP bundle.
///
/// Admin-only. Validates the revision is in Published or Deprecated state,
/// reads the bundle content from blob storage, reconstructs the ZIP via
/// `TemplateRegistryService::export_revision`, and returns it with
/// `Content-Disposition: attachment`.
#[instrument(skip_all)]
pub async fn template_export_handler(
  State(state): State<ApiState>,
  Path(revision_id): Path<String>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, axum::Json<serde_json::Value>)> {
  let request_id = request_id_from_headers(&headers);
  // Admin auth check
  crate::require_admin_user(&state, &headers).await.map_err(|status| {
    warn!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      status = %status.as_u16(),
      raw_revision_id = %revision_id,
      "unauthorized template export attempt"
    );
    (status, axum::Json(serde_json::json!({ "error": "unauthorized" })))
  })?;

  let rid = Uuid::parse_str(&revision_id).map_err(|_| {
    warn!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      raw_revision_id = %revision_id,
      "invalid revision ID for template export"
    );
    (
      StatusCode::BAD_REQUEST,
      axum::Json(serde_json::json!({ "error": "invalid revision ID" })),
    )
  })?;

  let service = state.template_registry().ok_or_else(|| {
    warn!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      revision_id = %rid,
      "template registry disabled during template export"
    );
    (
      StatusCode::SERVICE_UNAVAILABLE,
      axum::Json(serde_json::json!({ "error": "template registry is not enabled" })),
    )
  })?;

  // Load the revision
  let revision = service
    .store()
    .get_revision(rid)
    .await
    .map_err(|e| {
      warn!(
        request_id = %request_id.as_deref().unwrap_or("unavailable"),
        request_id_available = request_id.is_some(),
        error = %e,
        revision_id = %rid,
        "failed to load revision for export"
      );
      (
        StatusCode::INTERNAL_SERVER_ERROR,
        axum::Json(serde_json::json!({ "error": format!("failed to load revision: {e}") })),
      )
    })?
    .ok_or_else(|| {
      (
        StatusCode::NOT_FOUND,
        axum::Json(serde_json::json!({ "error": "revision not found" })),
      )
    })?;

  // Verify exportable state
  let rev_state = revision.state;
  if rev_state != myoxus_domain::template_registry::RevisionState::Published
    && rev_state != myoxus_domain::template_registry::RevisionState::Deprecated
  {
    warn!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      revision_id = %rid,
      template_id = %revision.template_id,
      revision_state = ?rev_state,
      "template export rejected due to revision state"
    );
    return Err((
      StatusCode::CONFLICT,
      axum::Json(serde_json::json!({
          "error": format!("cannot export revision in state '{rev_state}' — only Published or Deprecated revisions can be exported")
      })),
    ));
  }

  // Read content blob
  let blob_id = revision.bundle_blob_id.as_deref().ok_or_else(|| {
    warn!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      revision_id = %rid,
      template_id = %revision.template_id,
      "template export rejected because revision has no bundle blob"
    );
    (
      StatusCode::INTERNAL_SERVER_ERROR,
      axum::Json(serde_json::json!({ "error": "revision has no bundle_blob_id" })),
    )
  })?;

  let bundle_blob = state.storage().read_blob(blob_id).await.map_err(|e| {
    warn!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      error = %e,
      revision_id = %rid,
      template_id = %revision.template_id,
      blob_id = %blob_id,
      "failed to read bundle blob for export"
    );
    (
      StatusCode::INTERNAL_SERVER_ERROR,
      axum::Json(serde_json::json!({ "error": format!("failed to read bundle blob: {e}") })),
    )
  })?;

  let zip_limits = bundle::TemplateBundleZipLimits {
    max_entries: state.config.template_registry.zip_limits.max_entries as usize,
    max_single_file_size: state.config.template_registry.zip_limits.max_entry_uncompressed_size_mb * 1024 * 1024,
    max_total_uncompressed_size: state.config.template_registry.zip_limits.max_total_uncompressed_size_mb * 1024 * 1024,
    max_compression_ratio: state.config.template_registry.zip_limits.max_compression_ratio,
    max_path_length: state.config.template_registry.zip_limits.max_path_length as usize,
  };
  let parsed_bundle = match bundle::parse_bundle_with_limits(&bundle_blob.data, zip_limits) {
    Ok(parsed) => parsed,
    Err(e) => {
      // Backward compatibility: older revisions may still point to raw
      // content blobs instead of full bundle blobs.
      warn!(
        request_id = %request_id.as_deref().unwrap_or("unavailable"),
        request_id_available = request_id.is_some(),
        error = %e,
        revision_id = %rid,
        template_id = %revision.template_id,
        blob_id = %blob_id,
        "failed to parse stored template bundle for export, falling back to raw content blob"
      );
      bundle::ParsedBundle {
        manifest: bundle::Manifest {
          template_id: "legacy-template".to_string(),
          version: revision.version.clone(),
          title: "Legacy Template".to_string(),
          description: None,
          category: None,
          tags: Vec::new(),
          locale: None,
          kind: None,
          min_server_version: None,
          checksum: None,
          localized_contents: std::collections::BTreeMap::new(),
          title_policy: None,
          purpose: None,
        },
        content_bytes: bundle_blob.data.to_vec(),
        localized_contents: std::collections::BTreeMap::new(),
        preview_bytes: None,
        format: bundle::BundleFormat::RawWorkspaceZip,
        ignored_entries: Vec::new(),
        bundle_checksum: String::new(),
        content_checksum: String::new(),
        parse_timings: bundle::ParseTimings {
          detect: std::time::Duration::from_secs(0),
          unpack: std::time::Duration::from_secs(0),
          normalize: std::time::Duration::from_secs(0),
        },
      }
    }
  };

  // Optionally read preview blob
  let preview_bytes = if let Some(preview_id) = revision.preview_blob_id.as_deref() {
    state
      .storage()
      .read_blob(preview_id)
      .await
      .ok()
      .map(|b| b.data.to_vec())
  } else {
    parsed_bundle.preview_bytes.clone()
  };

  // Build the export ZIP
  let zip_bytes = service
    .export_revision(
      rid,
      &parsed_bundle.content_bytes,
      preview_bytes.as_deref(),
      &parsed_bundle.localized_contents,
    )
    .await
    .map_err(|e| {
      warn!(
        request_id = %request_id.as_deref().unwrap_or("unavailable"),
        request_id_available = request_id.is_some(),
        error = %e,
        revision_id = %rid,
        template_id = %revision.template_id,
        "failed to build export bundle"
      );
      (
        StatusCode::INTERNAL_SERVER_ERROR,
        axum::Json(serde_json::json!({ "error": format!("failed to build export bundle: {e}") })),
      )
    })?;

  // Look up the template slug for the filename
  let slug = service
    .store()
    .get_catalog_entry(revision.template_id)
    .await
    .ok()
    .flatten()
    .map(|e| e.slug)
    .unwrap_or_else(|| "template".to_string());

  let filename = format!("template-{}-{}.zip", slug, revision.version);
  // Keep the existing response contract intact; add explicit checksum headers.
  let container_checksum = sha256_hex(&zip_bytes);
  let content_checksum = if parsed_bundle.content_checksum.is_empty() {
    sha256_hex(&parsed_bundle.content_bytes)
  } else {
    parsed_bundle.content_checksum.clone()
  };
  tracing::info!(
    request_id = %request_id.as_deref().unwrap_or("unavailable"),
    request_id_available = request_id.is_some(),
    revision_id = %rid,
    template_id = %revision.template_id,
    template_slug = %slug,
    export_filename = %filename,
    container_checksum = %container_checksum,
    content_checksum = %content_checksum,
    "template export completed"
  );

  Ok((
    StatusCode::OK,
    [
      (EXPORT_CONTAINER_CHECKSUM_HEADER, container_checksum),
      (EXPORT_CONTENT_CHECKSUM_HEADER, content_checksum),
      (header::CACHE_CONTROL, "no-store".to_string()),
      (header::CONTENT_TYPE, "application/zip".to_string()),
      (
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{}\"", filename),
      ),
    ],
    zip_bytes,
  ))
}

fn request_id_from_headers(headers: &HeaderMap) -> Option<String> {
  headers
    .get(REQUEST_ID_HEADER)
    .and_then(|value| value.to_str().ok())
    .filter(|value| !value.is_empty())
    .map(|value| value.to_string())
}
