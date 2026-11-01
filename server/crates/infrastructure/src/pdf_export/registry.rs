// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL + blob-store backed implementation of
//! [`myoxus_pdf_export::template_v2::PdfTemplateRegistry`]
//! (`P-PDF-TPL-06-01`).
//!
//! Loading a template materialises:
//! 1. The `pdf_templates` row + its `pdf_template_files` rows in one query
//!    pair (driven through [`PdfTemplateRepository`] and
//!    [`list_files_for_template`]).
//! 2. The manifest JSON as a strongly-typed [`PdfTemplateManifest`].
//! 3. Every referenced bundle file from the [`PdfBlobStore`].
//!
//! The cache layer ([`super::registry_cache::CachingPdfTemplateRegistry`])
//! sits on top of this and is added in `P-PDF-TPL-06-02`.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use sqlx::PgPool;
use tracing::{debug, instrument, warn};
use uuid::Uuid;

use myoxus_domain::pdf_template_manifest::PdfTemplateManifest;
use myoxus_domain::repositories::{PdfTemplateRepository, RepositoryError};
use myoxus_pdf_export::template_v2::{LoadedTemplate, PdfTemplateRegistry, RegistryError, TYPST_ENGINE_VERSION};

use crate::pdf_export::PdfBlobStore;
use crate::pdf_export::templates_repo::list_files_for_template;

/// DB-backed registry: pulls metadata + files from PostgreSQL and bytes from
/// the configured opendal blob store.
#[derive(Clone)]
pub struct PgPdfTemplateRegistry {
  pool: PgPool,
  repo: Arc<dyn PdfTemplateRepository>,
  blob_store: Arc<PdfBlobStore>,
}

impl PgPdfTemplateRegistry {
  pub fn new(pool: PgPool, repo: Arc<dyn PdfTemplateRepository>, blob_store: Arc<PdfBlobStore>) -> Self {
    Self { pool, repo, blob_store }
  }

  fn map_repo_err(err: RepositoryError, template_id: Uuid) -> RegistryError {
    match err {
      RepositoryError::NotFound(_) => RegistryError::NotFound(template_id),
      RepositoryError::Storage(msg) => RegistryError::Storage(msg),
      RepositoryError::Conflict(msg) => RegistryError::Storage(format!("conflict: {msg}")),
      other => RegistryError::Storage(other.to_string()),
    }
  }
}

impl PgPdfTemplateRegistry {
  /// Materialise a [`PdfTemplate`] row into a [`LoadedTemplate`].
  /// Shared between [`load`] (by id) and [`load_by_slug`] so both
  /// paths produce byte-identical results.
  ///
  /// [`load`]: PdfTemplateRegistry::load
  /// [`load_by_slug`]: PdfTemplateRegistry::load_by_slug
  async fn materialise(&self, tpl: myoxus_domain::entities::PdfTemplate) -> Result<LoadedTemplate, RegistryError> {
    let template_id = tpl.id;
    let manifest: PdfTemplateManifest =
      serde_json::from_value(tpl.manifest.clone()).map_err(|e| RegistryError::InvalidManifest {
        id: template_id,
        reason: e.to_string(),
      })?;
    manifest
      .validate_engine_compatibility(TYPST_ENGINE_VERSION)
      .map_err(|reason| RegistryError::InvalidManifest {
        id: template_id,
        reason: reason.to_owned(),
      })?;
    let file_rows = list_files_for_template(&self.pool, template_id)
      .await
      .map_err(|e| Self::map_repo_err(e, template_id))?;
    let mut files: HashMap<String, Vec<u8>> = HashMap::with_capacity(file_rows.len());
    for row in file_rows {
      let bytes = self
        .blob_store
        .get_template_file(&row.blob_key)
        .await
        .map_err(|e| match e {
          RepositoryError::NotFound(_) => {
            warn!(template_id = %template_id, path = %row.file_path, blob_key = %row.blob_key,
              "template file missing from blob store");
            RegistryError::MissingFile {
              id: template_id,
              path: row.file_path.clone(),
            }
          }
          other => RegistryError::Storage(other.to_string()),
        })?;
      files.insert(row.file_path, bytes);
    }
    debug!(template_id = %template_id, slug = %tpl.slug, files = files.len(),
      "loaded pdf template");
    Ok(LoadedTemplate {
      id: tpl.id,
      slug: tpl.slug,
      version: tpl.version,
      manifest,
      files,
    })
  }
}

#[async_trait]
impl PdfTemplateRegistry for PgPdfTemplateRegistry {
  #[instrument(skip(self), err)]
  async fn load(&self, template_id: Uuid) -> Result<LoadedTemplate, RegistryError> {
    let tpl = self
      .repo
      .get_by_id(template_id)
      .await
      .map_err(|e| Self::map_repo_err(e, template_id))?
      .ok_or(RegistryError::NotFound(template_id))?;
    if tpl.deleted_at.is_some() {
      return Err(RegistryError::NotFound(template_id));
    }
    self.materialise(tpl).await
  }

  #[instrument(skip(self), err)]
  async fn load_by_slug(&self, slug: &str) -> Result<LoadedTemplate, RegistryError> {
    let tpl = self
      .repo
      .get_by_slug(slug)
      .await
      .map_err(|e| Self::map_repo_err(e, Uuid::nil()))?
      .ok_or_else(|| RegistryError::SlugNotFound(slug.to_owned()))?;
    if tpl.deleted_at.is_some() {
      return Err(RegistryError::SlugNotFound(slug.to_owned()));
    }
    self.materialise(tpl).await
  }
}
