// SPDX-License-Identifier: AGPL-3.0-or-later
//! GraphQL surface for PDF template administration (`P-PDF-TPL-07`).
//!
//! Admin-only queries and mutations that wrap [`PdfTemplateRepository`] +
//! [`PdfBlobStore`]:
//!
//! | Field                          | Purpose                                                         |
//! |--------------------------------|-----------------------------------------------------------------|
//! | `pdfTemplates`                 | List every registered template (optionally including soft-deleted). |
//! | `pdfTemplate`                  | Single template by id.                                          |
//! | `pdfTemplateFiles`             | Bundle file rows of a single template.                          |
//! | `uploadPdfTemplate`            | Multipart upload — runs `PdfTemplateManifest` schema validation **and** the V2 Typst compile validator before any blob is written. |
//! | `deletePdfTemplate`            | Soft-delete; refused while workspace assignments exist.         |
//! | `updatePdfTemplateMetadata`    | Update `name` (column + `manifest.name`) and `manifest.description` atomically. |
//!
//! Every mutation emits an [`AuditCategory::PdfExportConfig`] event with
//! `pdf_template.{upload,delete,update_metadata}` action codes so the admin
//! audit log can tell who shipped which template version.
//!
//! ## Atomicity
//!
//! Upload/replacement compilation precedes staging. Header/file activation and
//! authenticated audit commit in one repository transaction. Failed initial
//! uploads clean only their own UUID namespace; shared content-addressed revisions
//! remain available to concurrent writers and admitted exports. Preview caches
//! are invalidated only after successful commit.

use std::{
  collections::{HashMap, HashSet},
  io::Read,
  sync::Arc,
  time::Duration,
};

use async_graphql::{Context, ID, Object, Result, SimpleObject, Upload};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use tracing::{info, instrument, warn};
use uuid::Uuid;

use myoxus_application::auth::AuthError;
use myoxus_domain::entities::{PdfTemplate, PdfTemplateFile};
use myoxus_domain::pdf_template_manifest::PdfTemplateManifest;
use myoxus_domain::repositories::{PdfTemplateRepository, RepositoryError};
use myoxus_pdf_export::template_v2::{CompileError, TYPST_ENGINE_VERSION};

use crate::graphql::admin::resolve_audit_actor;
use crate::graphql::pdf_export::invalidate_pdf_template_preview_cache;
use crate::graphql::utils::{map_gql_error, require_session};
use crate::state::ApiState;

/// Maximum slug length — mirrors the manifest schema bound. Validated up-front
/// so the error surfaces before any I/O.
const MAX_SLUG_LEN: usize = 64;

// ── GraphQL types ────────────────────────────────────────────────────────────

/// Admin-facing projection of [`PdfTemplate`]. Mirrors the DB row shape
/// 1:1 — workspace-facing surface uses
/// [`crate::graphql::pdf_workspace::PdfTemplatePublic`] instead.
#[derive(SimpleObject, Clone)]
pub struct PdfTemplateAdminType {
  pub id: ID,
  pub slug: String,
  pub name: String,
  pub version: String,
  pub schema_version: String,
  /// Full L2 manifest JSON. Surfaced verbatim so the admin UI can render
  /// the capability matrix without an extra query.
  pub manifest: serde_json::Value,
  /// Author of the upload; `None` for system-seeded entries (`default`,
  /// `report`, `letter`).
  pub created_by: Option<ID>,
  pub created_at: DateTime<Utc>,
  pub deleted_at: Option<DateTime<Utc>>,
}

impl From<PdfTemplate> for PdfTemplateAdminType {
  fn from(t: PdfTemplate) -> Self {
    Self {
      id: ID(t.id.to_string()),
      slug: t.slug,
      name: t.name,
      version: t.version,
      schema_version: t.schema_version,
      manifest: t.manifest,
      created_by: t.created_by.map(|id| ID(id.to_string())),
      created_at: t.created_at,
      deleted_at: t.deleted_at,
    }
  }
}

/// One row from `pdf_template_files` — the manifest-declared bundle files
/// of a template. The blob key + sha256 let an admin page link straight
/// to the storage backend for diagnostics.
#[derive(SimpleObject, Clone)]
pub struct PdfTemplateFileType {
  pub template_id: ID,
  pub file_path: String,
  pub blob_key: String,
  pub content_hash: String,
}

impl From<PdfTemplateFile> for PdfTemplateFileType {
  fn from(f: PdfTemplateFile) -> Self {
    Self {
      template_id: ID(f.template_id.to_string()),
      file_path: f.file_path,
      blob_key: f.blob_key,
      content_hash: f.content_hash,
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Reject non-admin sessions. Returns the resolved `(state, admin_user_id)`
/// pair on success. Mirrors the helper in [`crate::graphql::pdf_workspace`]
/// so the admin guard semantics stay consistent across surfaces.
async fn require_admin(ctx: &Context<'_>) -> Result<(Arc<ApiState>, Uuid)> {
  let (state, snapshot) = require_session(ctx).await?;
  if !snapshot.user.is_admin {
    warn!(user_id = %snapshot.user.id, "non-admin tried to access pdf template admin surface");
    return Err(map_gql_error(AuthError::ActionForbidden));
  }
  Ok((state, snapshot.user.id))
}

fn require_template_repo(state: &ApiState) -> Result<Arc<dyn PdfTemplateRepository>> {
  state
    .pdf_template_repo()
    .ok_or_else(|| async_graphql::Error::new("pdf template repository is not configured on this server"))
}

fn require_blob_store(state: &ApiState) -> Result<Arc<myoxus_infrastructure::pdf_export::PdfBlobStore>> {
  state
    .pdf_blob_store()
    .ok_or_else(|| async_graphql::Error::new("pdf blob store is not configured on this server"))
}

fn map_repo_err(err: RepositoryError) -> async_graphql::Error {
  match err {
    RepositoryError::Conflict(msg) => async_graphql::Error::new(format!("conflict: {msg}")),
    RepositoryError::NotFound(what) => async_graphql::Error::new(format!("{what} not found")),
    other => async_graphql::Error::new(other.to_string()),
  }
}

fn validate_slug(slug: &str) -> Result<()> {
  if slug.is_empty() || slug.len() > MAX_SLUG_LEN {
    return Err(async_graphql::Error::new(format!(
      "slug must be 1..={} characters",
      MAX_SLUG_LEN
    )));
  }
  let valid = slug
    .chars()
    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    && !slug.starts_with('-')
    && !slug.ends_with('-')
    && !slug.contains("--");
  if !valid {
    return Err(async_graphql::Error::new(
      "slug must be kebab-case (lowercase letters, digits, single hyphens)",
    ));
  }
  Ok(())
}

fn validate_bundle_path(path: &str) -> Result<()> {
  if path.is_empty()
    || path.len() > 256
    || path.starts_with('/')
    || path.starts_with('\\')
    || path.contains('\\')
    || path
      .split('/')
      .any(|part| part.is_empty() || part == "." || part == "..")
    || !path
      .chars()
      .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '/' | '-'))
  {
    return Err(async_graphql::Error::new(format!(
      "bundle path `{path}` must be a safe manifest-relative path"
    )));
  }
  Ok(())
}

fn map_compile_error(error: CompileError) -> async_graphql::Error {
  match error {
    CompileError::CompileFailed { diagnostics } => {
      async_graphql::Error::new(format!("template failed to compile: {}", diagnostics.join("; ")))
    }
    CompileError::MissingFont(name) => {
      async_graphql::Error::new(format!("template requires a font that is not available: {name}"))
    }
    CompileError::MemoryLimit => {
      let mut error = async_graphql::Error::new("template compilation exceeded memory limit");
      let mut extensions = async_graphql::ErrorExtensionValues::default();
      extensions.set("class", "TooLarge");
      error.extensions = Some(extensions);
      error
    }
    CompileError::Timeout => {
      async_graphql::Error::new("template compilation timed out — likely an infinite loop in the template")
    }
    CompileError::PanickedDuringCompile(message) => {
      async_graphql::Error::new(format!("template compilation panicked: {message}"))
    }
    CompileError::IoError(message) => async_graphql::Error::new(format!("template compilation I/O error: {message}")),
  }
}

struct PreparedTemplateBundle {
  manifest: PdfTemplateManifest,
  manifest_json: serde_json::Value,
  files: HashMap<String, Vec<u8>>,
}

async fn prepare_template_bundle(
  ctx: &Context<'_>,
  state: &ApiState,
  manifest: serde_json::Value,
  file_paths: Vec<String>,
  files: Vec<Upload>,
  rights_confirmed: bool,
) -> Result<PreparedTemplateBundle> {
  if !rights_confirmed {
    return Err(async_graphql::Error::new(
      "template upload requires confirmation that the declared license and source provenance are accurate",
    ));
  }
  if file_paths.len() != files.len() {
    return Err(async_graphql::Error::new(
      "filePaths and files must have the same length",
    ));
  }
  if files.is_empty() {
    return Err(async_graphql::Error::new("at least one bundle file is required"));
  }

  let parsed_manifest: PdfTemplateManifest = serde_json::from_value(manifest)
    .map_err(|error| async_graphql::Error::new(format!("manifest is not valid against the V2 schema: {error}")))?;
  validate_slug(&parsed_manifest.id)?;
  parsed_manifest
    .validate_package_metadata()
    .map_err(|error| async_graphql::Error::new(format!("manifest package metadata rejected: {error}")))?;
  parsed_manifest
    .validate_locale()
    .map_err(|error| async_graphql::Error::new(format!("manifest locale rejected: {error}")))?;
  parsed_manifest
    .validate_engine_compatibility(TYPST_ENGINE_VERSION)
    .map_err(|error| {
      async_graphql::Error::new(format!(
        "manifest Typst engine rejected: {error}; server renderer is {TYPST_ENGINE_VERSION}"
      ))
    })?;

  let mut declared_assets = parsed_manifest.assets.clone();
  for path in &declared_assets {
    validate_bundle_path(path)?;
  }
  validate_bundle_path(&parsed_manifest.entry)?;
  declared_assets.sort();
  declared_assets.dedup();
  if declared_assets.len() != parsed_manifest.assets.len() {
    return Err(async_graphql::Error::new("manifest.assets contains duplicate paths"));
  }

  let mut uploaded_paths = file_paths.clone();
  for path in &uploaded_paths {
    validate_bundle_path(path)?;
  }
  uploaded_paths.sort();
  uploaded_paths.dedup();
  if uploaded_paths.len() != file_paths.len() {
    return Err(async_graphql::Error::new("filePaths contains duplicate entries"));
  }
  if uploaded_paths != declared_assets {
    return Err(async_graphql::Error::new(format!(
      "uploaded files do not match manifest.assets — expected {:?}, got {:?}",
      parsed_manifest.assets, file_paths
    )));
  }
  if !file_paths.iter().any(|path| path == &parsed_manifest.entry) {
    return Err(async_graphql::Error::new(format!(
      "manifest.entry `{}` is not among the uploaded files",
      parsed_manifest.entry
    )));
  }

  let mut bundle = HashMap::with_capacity(file_paths.len());
  let mut total_bytes = 0usize;
  let max_bundle_bytes = state.config.pdf_export.max_template_bytes();
  for (path, upload) in file_paths.iter().zip(files) {
    let mut data = Vec::new();
    let value = upload
      .value(ctx)
      .map_err(|error| async_graphql::Error::new(format!("invalid upload for `{path}`: {error}")))?;
    value
      .content
      .take(max_bundle_bytes as u64 + 1)
      .read_to_end(&mut data)
      .map_err(|error| async_graphql::Error::new(format!("failed to read upload `{path}`: {error}")))?;
    if data.is_empty() {
      return Err(async_graphql::Error::new(format!("uploaded file `{path}` is empty")));
    }
    if data.len() > max_bundle_bytes {
      return Err(async_graphql::Error::new(format!(
        "uploaded file `{path}` exceeds {max_bundle_bytes} byte limit"
      )));
    }
    total_bytes = total_bytes.saturating_add(data.len());
    if total_bytes > max_bundle_bytes {
      return Err(async_graphql::Error::new(format!(
        "total uploaded bundle size exceeds {max_bundle_bytes} byte limit"
      )));
    }
    bundle.insert(path.clone(), data);
  }

  let execution_limits = crate::pdf_export_adapter::effective_pdf_limits(state)
    .await
    .map_err(|_| async_graphql::Error::new("PDF resource configuration is unavailable"))?;
  let compiler_limits = myoxus_pdf_export::execution::CompilerLimits {
    watchdog: execution_limits.render_timeout.max(Duration::from_secs(1)),
    max_memory_mb: execution_limits.max_memory_mb,
  };
  myoxus_pdf_export::template_v2::compile_validator::render_stub_pdf_bytes_with_limits_and_permit(
    &bundle,
    &parsed_manifest,
    compiler_limits,
    (),
  )
  .await
  .map_err(map_compile_error)?;
  let manifest_json = serde_json::to_value(&parsed_manifest)
    .map_err(|error| async_graphql::Error::new(format!("failed to canonicalize manifest: {error}")))?;

  Ok(PreparedTemplateBundle {
    manifest: parsed_manifest,
    manifest_json,
    files: bundle,
  })
}

async fn cleanup_blob_keys(
  blob_store: &myoxus_infrastructure::pdf_export::PdfBlobStore,
  keys: impl IntoIterator<Item = String>,
  protected: &HashSet<String>,
) {
  for key in keys {
    if !protected.contains(&key)
      && let Err(error) = blob_store.delete(&key).await
    {
      warn!(blob_key = key, error = %error, "failed to clean up inactive pdf template blob");
    }
  }
}

async fn write_template_bundle(
  blob_store: &myoxus_infrastructure::pdf_export::PdfBlobStore,
  template_id: Uuid,
  bundle: &HashMap<String, Vec<u8>>,
  revisioned: bool,
  protected: &HashSet<String>,
) -> Result<(Vec<PdfTemplateFile>, Vec<String>)> {
  let mut written_blobs = Vec::with_capacity(bundle.len());
  let mut file_records = Vec::with_capacity(bundle.len());
  for (path, bytes) in bundle {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let expected_sha = format!("{:x}", hasher.finalize());
    let stored = if revisioned {
      blob_store.put_template_revision_file(template_id, path, bytes).await
    } else {
      blob_store.put_template_file(template_id, path, bytes).await
    };
    let (blob_key, blob_sha) = match stored {
      Ok(value) => value,
      Err(error) => {
        if !revisioned {
          cleanup_blob_keys(blob_store, written_blobs, protected).await;
        }
        return Err(map_repo_err(error));
      }
    };
    if blob_sha != expected_sha {
      if !revisioned {
        cleanup_blob_keys(
          blob_store,
          written_blobs.into_iter().chain(std::iter::once(blob_key)),
          protected,
        )
        .await;
      }
      return Err(async_graphql::Error::new(format!(
        "blob store reported sha256 mismatch for `{path}`"
      )));
    }
    written_blobs.push(blob_key.clone());
    file_records.push(PdfTemplateFile {
      template_id,
      file_path: path.clone(),
      blob_key,
      content_hash: expected_sha,
    });
  }
  file_records.sort_by(|left, right| left.file_path.cmp(&right.file_path));
  Ok((file_records, written_blobs))
}

// ── Queries ──────────────────────────────────────────────────────────────────

pub struct PdfTemplateAdminQueryRoot;

#[Object]
impl PdfTemplateAdminQueryRoot {
  /// List all PDF templates. By default soft-deleted rows are excluded;
  /// pass `includeDeleted: true` to include them (admin diagnostic view).
  #[instrument(skip(self, ctx))]
  pub async fn pdf_templates(
    &self,
    ctx: &Context<'_>,
    #[graphql(default = false)] include_deleted: bool,
  ) -> Result<Vec<PdfTemplateAdminType>> {
    let (state, _admin_id) = require_admin(ctx).await?;
    let repo = require_template_repo(&state)?;
    let rows = repo.list(include_deleted).await.map_err(map_repo_err)?;
    Ok(rows.into_iter().map(Into::into).collect())
  }

  /// Fetch a single PDF template by its UUID. Returns `null` when no row
  /// matches.
  #[instrument(skip(self, ctx))]
  pub async fn pdf_template(&self, ctx: &Context<'_>, id: ID) -> Result<Option<PdfTemplateAdminType>> {
    let (state, _admin_id) = require_admin(ctx).await?;
    let uuid = Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new("invalid UUID"))?;
    let repo = require_template_repo(&state)?;
    let row = repo.get_by_id(uuid).await.map_err(map_repo_err)?;
    Ok(row.map(Into::into))
  }

  /// Return every bundle file row associated with `templateId`. The order is
  /// alphabetical by `file_path` (same as the underlying SQL query).
  #[instrument(skip(self, ctx))]
  pub async fn pdf_template_files(&self, ctx: &Context<'_>, template_id: ID) -> Result<Vec<PdfTemplateFileType>> {
    let (state, _admin_id) = require_admin(ctx).await?;
    let uuid = Uuid::parse_str(template_id.as_str()).map_err(|_| async_graphql::Error::new("invalid UUID"))?;

    // Verify the template exists first so callers get a "template not found"
    // instead of an empty list when they pass a wrong id.
    let repo = require_template_repo(&state)?;
    if repo.get_by_id(uuid).await.map_err(map_repo_err)?.is_none() {
      return Err(async_graphql::Error::new("pdf_template not found"));
    }

    let pool = state
      .metrics_pool()
      .ok_or_else(|| async_graphql::Error::new("database pool is not configured on this server"))?;
    let files = myoxus_infrastructure::pdf_export::list_files_for_template(&pool, uuid)
      .await
      .map_err(map_repo_err)?;
    Ok(files.into_iter().map(Into::into).collect())
  }
}

// ── Mutations ────────────────────────────────────────────────────────────────

pub struct PdfTemplateAdminMutationRoot;

#[Object]
impl PdfTemplateAdminMutationRoot {
  /// Upload a new PDF template bundle. The mutation enforces the full V2
  /// pipeline up-front: manifest schema (`PdfTemplateManifest` deserialise
  /// + locale check) → bundle file consistency check → Typst compile
  /// validation. Only after every check passes does the server write blobs
  /// or insert DB rows.
  ///
  /// `filePaths[i]` declares the in-bundle relative path for `files[i]`;
  /// the two arrays must have the same length and together cover every
  /// asset declared by the manifest.
  ///
  /// Returns the persisted [`PdfTemplateAdminType`].
  #[instrument(skip_all)]
  pub async fn upload_pdf_template(
    &self,
    ctx: &Context<'_>,
    manifest: serde_json::Value,
    file_paths: Vec<String>,
    files: Vec<Upload>,
    rights_confirmed: bool,
  ) -> Result<PdfTemplateAdminType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let actor = Some(resolve_audit_actor(ctx).await);
    let prepared = prepare_template_bundle(ctx, &state, manifest, file_paths, files, rights_confirmed).await?;
    let slug = prepared.manifest.id.clone();
    let name = prepared.manifest.name.clone();
    let version = prepared.manifest.version.clone();
    let template_id = Uuid::new_v4();
    let blob_store = require_blob_store(&state)?;
    let repo = require_template_repo(&state)?;
    let protected = HashSet::new();
    let (file_records, written_blobs) =
      write_template_bundle(&blob_store, template_id, &prepared.files, false, &protected).await?;
    let now = Utc::now();
    let row = PdfTemplate {
      id: template_id,
      slug: slug.clone(),
      name: name.clone(),
      version: version.clone(),
      schema_version: prepared.manifest.schema_version.clone(),
      manifest: prepared.manifest_json,
      created_by: Some(admin_id),
      created_at: now,
      deleted_at: None,
    };
    if let Err(err) = repo.create(&row, &file_records, actor).await {
      cleanup_blob_keys(&blob_store, written_blobs, &protected).await;
      return Err(map_repo_err(err));
    }

    info!(
      template_id = %template_id,
      slug = %slug,
      version = %version,
      files = file_records.len(),
      admin_id = %admin_id,
      "pdf template uploaded"
    );
    invalidate_pdf_template_preview_cache("template_upload");

    Ok(row.into())
  }

  /// Atomically publish a newer complete bundle for an administrator-owned
  /// template while preserving its UUID and workspace assignments.
  #[instrument(skip_all)]
  pub async fn replace_pdf_template_bundle(
    &self,
    ctx: &Context<'_>,
    id: ID,
    manifest: serde_json::Value,
    file_paths: Vec<String>,
    files: Vec<Upload>,
    rights_confirmed: bool,
  ) -> Result<PdfTemplateAdminType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let actor = Some(resolve_audit_actor(ctx).await);
    let template_id = Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new("invalid UUID"))?;
    let repo = require_template_repo(&state)?;
    let Some(existing) = repo.get_by_id(template_id).await.map_err(map_repo_err)? else {
      return Err(async_graphql::Error::new("pdf_template not found"));
    };
    if existing.deleted_at.is_some() {
      return Err(async_graphql::Error::new("cannot replace a soft-deleted template"));
    }
    if existing.created_by.is_none() {
      return Err(async_graphql::Error::new(
        "system templates are updated only by the bundled server release",
      ));
    }

    let prepared = prepare_template_bundle(ctx, &state, manifest, file_paths, files, rights_confirmed).await?;
    if prepared.manifest.id != existing.slug {
      return Err(async_graphql::Error::new(format!(
        "replacement manifest.id `{}` must preserve template slug `{}`",
        prepared.manifest.id, existing.slug
      )));
    }
    let previous_version = semver::Version::parse(&existing.version)
      .map_err(|_| async_graphql::Error::new("stored template version is not valid SemVer"))?;
    let next_version = semver::Version::parse(&prepared.manifest.version)
      .map_err(|_| async_graphql::Error::new("replacement template version is not valid SemVer"))?;
    if next_version <= previous_version {
      return Err(async_graphql::Error::new(format!(
        "replacement version {} must be newer than stored version {}",
        prepared.manifest.version, existing.version
      )));
    }

    let old_files = repo.list_files(template_id).await.map_err(map_repo_err)?;
    let protected = old_files
      .iter()
      .map(|file| file.blob_key.clone())
      .collect::<HashSet<_>>();
    let blob_store = require_blob_store(&state)?;
    let (file_records, _) = write_template_bundle(&blob_store, template_id, &prepared.files, true, &protected).await?;
    let replacement = PdfTemplate {
      id: existing.id,
      slug: existing.slug.clone(),
      name: prepared.manifest.name.clone(),
      version: prepared.manifest.version.clone(),
      schema_version: prepared.manifest.schema_version.clone(),
      manifest: prepared.manifest_json,
      created_by: existing.created_by,
      created_at: existing.created_at,
      deleted_at: None,
    };
    if let Err(error) = repo
      .replace_bundle(&replacement, &file_records, &existing, &old_files, actor)
      .await
    {
      return Err(map_repo_err(error));
    }

    // Revision blobs can be shared with concurrent uploads and in-flight
    // exports. The DB swap owns activation, not cross-storage garbage collection;
    // deleting apparently inactive keys here could remove another writer's bytes.
    info!(
      template_id = %template_id,
      slug = %replacement.slug,
      previous_version = %existing.version,
      version = %replacement.version,
      files = file_records.len(),
      admin_id = %admin_id,
      "pdf template bundle replaced"
    );
    invalidate_pdf_template_preview_cache("template_bundle_replace");

    Ok(replacement.into())
  }

  /// Soft-delete a PDF template. Refused while any active workspace
  /// assignment still references the template — admins must un-assign first
  /// (or delete the workspace) to keep the FK referential integrity clear.
  ///
  /// Returns `true` when a row was soft-deleted, `false` when the id was
  /// unknown or already archived.
  #[instrument(skip_all)]
  pub async fn delete_pdf_template(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    let (state, admin_id) = require_admin(ctx).await?;
    let actor = Some(resolve_audit_actor(ctx).await);
    let uuid = Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new("invalid UUID"))?;
    let repo = require_template_repo(&state)?;
    let removed = repo.soft_delete(uuid, actor).await.map_err(map_repo_err)?;
    if !removed {
      return Ok(false);
    };
    info!(template_id=%uuid,admin_id=%admin_id,"pdf template soft-deleted");
    invalidate_pdf_template_preview_cache("template_soft_delete");

    Ok(true)
  }

  /// Update a template's display metadata. Either argument may be omitted.
  /// Updates the `name` column and the corresponding `manifest.name` /
  /// `manifest.description` fields atomically — readers never see a
  /// half-renamed row.
  ///
  /// To swap the manifest's capability matrix or files, re-upload the
  /// template via [`replace_pdf_template_bundle`](Self::replace_pdf_template_bundle).
  #[instrument(skip_all)]
  pub async fn update_pdf_template_metadata(
    &self,
    ctx: &Context<'_>,
    id: ID,
    name: Option<String>,
    description: Option<String>,
  ) -> Result<PdfTemplateAdminType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let actor = Some(resolve_audit_actor(ctx).await);
    let uuid = Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new("invalid UUID"))?;
    if name.is_none() && description.is_none() {
      return Err(async_graphql::Error::new(
        "at least one of `name` or `description` must be provided",
      ));
    }
    let repo = require_template_repo(&state)?;
    let trimmed_name = name.as_deref().map(str::trim).map(str::to_owned);
    let trimmed_desc = description.as_deref().map(str::trim).map(str::to_owned);

    if let Some(n) = trimmed_name.as_deref() {
      if n.is_empty() {
        return Err(async_graphql::Error::new("name must not be empty"));
      }
      if n.len() > 80 {
        return Err(async_graphql::Error::new("name must be ≤ 80 characters"));
      }
    }
    if let Some(d) = trimmed_desc.as_deref() {
      if d.len() > 500 {
        return Err(async_graphql::Error::new("description must be ≤ 500 characters"));
      }
    }

    let existing = repo
      .update_metadata(uuid, trimmed_name.as_deref(), trimmed_desc.as_deref(), actor)
      .await
      .map_err(map_repo_err)?;

    info!(
      template_id = %uuid,
      slug = %existing.slug,
      admin_id = %admin_id,
      name_updated = trimmed_name.is_some(),
      description_updated = trimmed_desc.is_some(),
      "pdf template metadata updated"
    );
    invalidate_pdf_template_preview_cache("template_metadata_update");

    Ok(existing.into())
  }
}
