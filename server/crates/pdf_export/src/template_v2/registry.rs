// SPDX-License-Identifier: AGPL-3.0-or-later
//! Template registry abstraction (`P-PDF-TPL-06-01`).
//!
//! Initial PDF-Export bundled all templates into the binary via `include_str!`
//! (see [`crate::template`]). V2 stores templates in PostgreSQL + the PDF
//! blob store and exposes them through the [`PdfTemplateRegistry`] trait.
//!
//! Consumers (the renderer, the admin diff/preview UI, the worker job) only
//! ever see [`LoadedTemplate`] values — they never reach into the database
//! directly. The DB-backed implementation lives in
//! [`myoxus_infrastructure::pdf_export`] so this crate can stay
//! infrastructure-free.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use thiserror::Error;
use uuid::Uuid;

use myoxus_domain::pdf_template_manifest::PdfTemplateManifest;

/// A fully materialised template ready for rendering.
///
/// Contains the validated L2 manifest plus every bundle file referenced by
/// the manifest, keyed by relative path (e.g. `"main.typ"`,
/// `"i18n/en.json"`). Files are eager-loaded so the renderer never has to
/// reach back into the registry mid-compile.
#[derive(Debug, Clone)]
pub struct LoadedTemplate {
  /// Database primary key. Stable across renames.
  pub id: Uuid,
  /// Stable kebab-case identifier from the manifest, mirrored on `pdf_templates.slug`.
  pub slug: String,
  /// Semver string declared in the manifest.
  pub version: String,
  /// Validated L2 manifest.
  pub manifest: PdfTemplateManifest,
  /// All bundle files keyed by relative path.
  pub files: HashMap<String, Vec<u8>>,
}

/// Errors produced by registry implementations.
///
/// Storage-layer errors are flattened into [`RegistryError::Storage`] so that
/// downstream renderers do not need to reach into infrastructure types.
#[derive(Debug, Error)]
pub enum RegistryError {
  #[error("template {0} not found")]
  NotFound(Uuid),
  #[error("template with slug `{0}` not found")]
  SlugNotFound(String),
  #[error("template {id} manifest is invalid: {reason}")]
  InvalidManifest { id: Uuid, reason: String },
  #[error("template {id} bundle file {path} missing from blob store")]
  MissingFile { id: Uuid, path: String },
  #[error("template registry storage error: {0}")]
  Storage(String),
}

/// Async port for loading PDF templates.
///
/// Implementations are expected to be **deterministic and idempotent**:
/// repeatedly calling [`load`] with the same id must yield byte-identical
/// `files` maps until either the template is updated or
/// [`invalidate`] is called.
///
/// [`load`]: PdfTemplateRegistry::load
/// [`invalidate`]: PdfTemplateRegistry::invalidate
#[async_trait]
pub trait PdfTemplateRegistry: Send + Sync {
  /// Load a single template by primary key.
  async fn load(&self, template_id: Uuid) -> Result<LoadedTemplate, RegistryError>;

  /// Load a single template by stable kebab-case slug. Used by callers
  /// that received a slug (e.g. `"default"` / `"report"` / `"letter"`)
  /// rather than a UUID, for example system-template exports or admin
  /// tooling. Returns
  /// [`RegistryError::SlugNotFound`] for unknown slugs.
  async fn load_by_slug(&self, slug: &str) -> Result<LoadedTemplate, RegistryError>;

  /// Hint to the registry that the in-memory snapshot for `template_id`
  /// should be discarded. The next [`load`](Self::load) call must re-fetch
  /// from the underlying store.
  ///
  /// Default no-op for non-caching registries.
  async fn invalidate(&self, _template_id: Uuid) -> Result<(), RegistryError> {
    Ok(())
  }
}

/// Convenience trait-object alias used throughout the codebase.
pub type DynPdfTemplateRegistry = Arc<dyn PdfTemplateRegistry>;
