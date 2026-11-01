// SPDX-License-Identifier: AGPL-3.0-or-later
//! PDF-Export V2 infrastructure implementations.
//!
//! This module provides PostgreSQL-backed repository implementations for the
//! canonical PDF tables, plus an opendal-backed blob store for template files,
//! brand assets, and font binaries.
//!
//! ## Sub-modules
//!
//! | Module | Repository / Store |
//! |---|---|
//! | `templates_repo` | `PgPdfTemplateRepository` → `PdfTemplateRepository` |
//! | `assignments_repo` | `PgPdfWorkspaceTemplateAssignmentRepository` → `PdfWorkspaceTemplateAssignmentRepository` |
//! | `brand_repo` | `PgPdfWorkspaceBrandAssetRepository` → `PdfWorkspaceBrandAssetRepository` |
//! | `fonts_repo` | `PgPdfFontRepository` → `PdfFontRepository` |
//! | `icc_repo` | `PgPdfIccProfileRepository` → `PdfIccProfileRepository` |
//! | `jobs_repo` | `PgPdfExportJobStore` → `PdfExportJobStore` |
//! | `blob_store` | [`PdfBlobStore`] (opendal) |

pub mod assignments_repo;
pub mod blob_store;
pub mod brand_repo;
pub mod fonts_repo;
pub mod icc_bootstrap;
pub mod icc_repo;
pub mod jobs_repo;
pub mod registry;
pub mod registry_cache;
pub mod render_audit_repo;
pub mod template_bootstrap;
pub mod template_engine_migration;
pub mod templates_repo;
pub mod verapdf_client;

pub use assignments_repo::PgPdfWorkspaceTemplateAssignmentRepository;
pub use blob_store::PdfBlobStore;
pub use brand_repo::PgPdfWorkspaceBrandAssetRepository;
pub use fonts_repo::PgPdfFontRepository;
pub use icc_bootstrap::{
  SYSTEM_CMYK_SWOP_PROFILE_NAME, SYSTEM_ICC_PROFILE_NAMES, SYSTEM_POSTSCRIPT_CMYK_PROFILE_NAME,
  SYSTEM_SRGB_PROFILE_NAME, seed_system_icc_profiles,
};
pub use icc_repo::PgPdfIccProfileRepository;
pub use jobs_repo::PgPdfExportJobStore;
pub use registry::PgPdfTemplateRegistry;
pub use registry_cache::{CachingPdfTemplateRegistry, PDF_TEMPLATE_INVALIDATE_CHANNEL};
pub use render_audit_repo::PgPdfExportRenderAuditRepository;
pub use template_bootstrap::{
  SYSTEM_TEMPLATE_SLUGS, ensure_default_pdf_template_assignments, seed_system_pdf_templates, system_template_id,
  verify_active_pdf_template_engines,
};
pub use template_engine_migration::{
  TemplateEngineMigrationAction, TemplateEngineMigrationError, TemplateEngineMigrationFile,
  TemplateEngineMigrationItem, TemplateEngineMigrationReport, TemplateEngineMigrationService,
};
pub use templates_repo::{PgPdfTemplateRepository, list_files_for_template};
pub use verapdf_client::ReqwestVerapdfClient;
pub mod theme;
