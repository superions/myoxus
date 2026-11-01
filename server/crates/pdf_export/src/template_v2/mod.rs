// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typst-Compile-Validator for PDF-Export V2 templates.
//!
//! Upload and replacement compile a stub through
//! [`compile_validator::render_stub_pdf_bytes_with_limits_and_permit`] before
//! persisting the bundle. This catches syntax errors, missing resources and
//! runaway loops using the effective compiler limits. Output conformance is
//! selected and validated per export, not certified by template compilation.

pub mod compile_validator;
pub mod preview_doc;
pub mod registry;
pub mod stub_doc;

/// Typst renderer embedded by this server build.
///
/// Keep this value aligned with the three pinned Typst dependencies in
/// `server/crates/pdf_export/Cargo.toml`. Upload validation accepts this exact
/// patch or the corresponding patch wildcard (`0.15.x`).
pub const TYPST_ENGINE_VERSION: &str = "0.15.1";

pub use compile_validator::{
  CompileError, render_stub_pdf_bytes, render_stub_pdf_bytes_with_timeout, validate_template_compiles,
  validate_template_compiles_with_timeout,
};
pub use registry::{DynPdfTemplateRegistry, LoadedTemplate, PdfTemplateRegistry, RegistryError};
