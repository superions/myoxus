// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typst compile validator for V2 template uploads and replacements.
//!
//! Builds a minimal TypstWorld from the uploaded template files, renders
//! the stub document through the Typst pipeline, and reports any compile
//! failures before the template is persisted.
//!
//! # Sandboxing
//!
//! Compiler work runs in the packaged, supervised compiler process. Timeout and
//! caller cancellation terminate and reap that process before admission is released.

use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

use myoxus_domain::pdf_template_manifest::{PdfTemplateManifest, PdfTocBehavior};
use serde::{Deserialize, Serialize};
use tracing::instrument;
use typst::foundations::Bytes;
use typst_layout::PagedDocument;

use crate::typst_engine::world::TypstWorld;

use super::stub_doc::build_stub_doc;

// ─── Error type ──────────────────────────────────────────────────────────────

/// Errors produced by the compile validator.
#[derive(Debug, Serialize, Deserialize)]
pub enum CompileError {
  /// Typst emitted one or more diagnostics during compilation.
  CompileFailed { diagnostics: Vec<String> },
  /// The template references a font family that is not present in the
  /// bundled font set. The missing family name is included for operator
  /// diagnostics.
  MissingFont(String),
  /// The compile watchdog fired before Typst finished.
  Timeout,
  /// The isolated compiler cannot allocate within its configured memory budget.
  MemoryLimit,
  /// Typst (or the PDF serialiser) panicked in the compiler process.
  PanickedDuringCompile(String),
  /// I/O error in the bounded compiler protocol.
  IoError(String),
}

impl fmt::Display for CompileError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      CompileError::CompileFailed { diagnostics } => {
        write!(f, "template compile failed: {}", diagnostics.join("; "))
      }
      CompileError::MissingFont(name) => write!(f, "required font not available: {name}"),
      CompileError::MemoryLimit => write!(f, "template compilation exceeded memory limit"),
      CompileError::Timeout => write!(f, "template compilation timed out"),
      CompileError::PanickedDuringCompile(msg) => write!(f, "compile task panicked: {msg}"),
      CompileError::IoError(msg) => write!(f, "I/O error during validation: {msg}"),
    }
  }
}

impl std::error::Error for CompileError {}

// ─── Public API ──────────────────────────────────────────────────────────────

/// Validate that `template_files` compile successfully against the stub document.
///
/// Uses the default watchdog timeout of 120 s. For tests, use
/// [`validate_template_compiles_with_timeout`] to override the deadline.
#[instrument(skip(template_files, manifest), fields(template_id = %manifest.id))]
pub async fn validate_template_compiles(
  template_files: &HashMap<String, Vec<u8>>,
  manifest: &PdfTemplateManifest,
) -> Result<(), CompileError> {
  validate_template_compiles_with_timeout(template_files, manifest, Duration::from_secs(120)).await
}

/// Render the validator stub as a PDF and return the raw bytes.
///
/// Retains the small upload-validation fixture; Admin previews use the richer
/// sample through `render_preview_pdf_bytes_with_limits_and_permit`.
#[instrument(skip(template_files, manifest), fields(template_id = %manifest.id))]
pub async fn render_stub_pdf_bytes(
  template_files: &HashMap<String, Vec<u8>>,
  manifest: &PdfTemplateManifest,
) -> Result<Vec<u8>, CompileError> {
  render_stub_pdf_bytes_with_timeout(template_files, manifest, Duration::from_secs(120)).await
}

/// Render the validator stub as a PDF using a caller-provided watchdog.
#[instrument(skip(template_files, manifest), fields(template_id = %manifest.id, timeout_ms = timeout.as_millis()))]
pub async fn render_stub_pdf_bytes_with_timeout(
  template_files: &HashMap<String, Vec<u8>>,
  manifest: &PdfTemplateManifest,
  timeout: Duration,
) -> Result<Vec<u8>, CompileError> {
  render_pdf_bytes(template_files, manifest, timeout).await
}

/// Validate template compilation with an explicit `watchdog` timeout.
///
/// Callers can override the deadline without duplicating process supervision.
#[instrument(skip(template_files, manifest), fields(template_id = %manifest.id))]
pub async fn validate_template_compiles_with_timeout(
  template_files: &HashMap<String, Vec<u8>>,
  manifest: &PdfTemplateManifest,
  watchdog: Duration,
) -> Result<(), CompileError> {
  render_pdf_bytes(template_files, manifest, watchdog).await.map(|_| ())
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/// Preview and upload validation must exercise the declared defaults, including
/// cover/TOC branches that generic IR defaults would otherwise leave uncompiled.
fn with_template_defaults(mut stub: crate::ir::IrDocument, manifest: &PdfTemplateManifest) -> crate::ir::IrDocument {
  stub.options.cover_page = Some(manifest.capabilities.cover_page.default);
  stub.options.locale = manifest.capabilities.language.default.clone();
  stub.options.footer_style = Some(manifest.capabilities.footer_style.default.as_str().to_owned());
  stub.options.page_numbering = Some(manifest.capabilities.page_numbering.default.as_str().to_owned());
  stub.options.color_variant = Some(manifest.capabilities.color_variant.default.as_str().to_owned());

  stub.options.toc_behavior = match manifest.capabilities.toc_behavior.default {
    PdfTocBehavior::Off => "off",
    PdfTocBehavior::Auto => "auto",
    PdfTocBehavior::Force => "force",
  }
  .into();
  stub
}

/// Build a Typst source string that wires the sample IR through the template's
/// theme + preamble.
///
/// Two cases:
/// 1. The bundle ships the standard `theme.typ` + `preamble.typ` pair —
///    drive the same V2 source generator the renderer uses, so the
///    validator exercises the exact pipeline that production renders
///    will hit. Source-generator errors surface as a Typst diagnostic.
/// 2. The bundle uses a custom layout (entry file not backed by the
///    theme/preamble pair) — emit a minimal wrapper that `#include`s the
///    declared entry file and embeds a stub heading. If the file is
///    missing, Typst will report it as a compile diagnostic, not a Rust
///    panic.
fn build_source_for_template(
  stub: &crate::ir::IrDocument,
  template_files: &HashMap<String, Vec<u8>>,
  entry: &str,
) -> String {
  use crate::typst_engine::ir_to_typst::ir_to_typst_source_v2;

  if template_files.contains_key("theme.typ") && template_files.contains_key("preamble.typ") {
    match ir_to_typst_source_v2(stub, template_files) {
      Ok(generated) => return generated.source,
      Err(e) => {
        // Surface as a Typst-style diagnostic so the caller's
        // `CompileError::CompileFailed` aggregator collects it uniformly.
        return format!("// V2 source generation failed: {e}\n#error(\"{e}\")");
      }
    }
  }

  format!(
    r#"#include "{entry}"
= Validator Stub
A minimal document for compilation validation.
"#
  )
}

/// Supervised rendering of the small compile-validation fixture.
async fn render_pdf_bytes(
  template_files: &HashMap<String, Vec<u8>>,
  manifest: &PdfTemplateManifest,
  watchdog: Duration,
) -> Result<Vec<u8>, CompileError> {
  render_stub_pdf_bytes_with_permit(template_files, manifest, watchdog, ()).await
}

/// Keep the preview caller's admission permit owned by the compiler supervisor,
/// including when the cache loader future is cancelled.
pub async fn render_stub_pdf_bytes_with_permit<L: Send + 'static>(
  template_files: &HashMap<String, Vec<u8>>,
  manifest: &PdfTemplateManifest,
  watchdog: Duration,
  permit: L,
) -> Result<Vec<u8>, CompileError> {
  render_stub_pdf_bytes_with_limits_and_permit(
    template_files,
    manifest,
    crate::execution::CompilerLimits {
      watchdog,
      ..Default::default()
    },
    permit,
  )
  .await
}

/// Validation and preview consume the same effective timeout/memory snapshot as
/// document exports. A supplied permit remains owned until execution is reaped.
pub async fn render_stub_pdf_bytes_with_limits_and_permit<L: Send + 'static>(
  template_files: &HashMap<String, Vec<u8>>,
  manifest: &PdfTemplateManifest,
  limits: crate::execution::CompilerLimits,
  permit: L,
) -> Result<Vec<u8>, CompileError> {
  render_with_limits_and_permit(template_files, manifest, None, limits, permit).await
}

/// Render the representative sample without increasing upload-validation cost.
/// The caller's resource limits and admission permit still supervise the child.
pub async fn render_preview_pdf_bytes_with_limits_and_permit<L: Send + 'static>(
  template_files: &HashMap<String, Vec<u8>>,
  manifest: &PdfTemplateManifest,
  locale: &str,
  limits: crate::execution::CompilerLimits,
  permit: L,
) -> Result<Vec<u8>, CompileError> {
  render_with_limits_and_permit(template_files, manifest, Some(locale.into()), limits, permit).await
}

async fn render_with_limits_and_permit<L: Send + 'static>(
  template_files: &HashMap<String, Vec<u8>>,
  manifest: &PdfTemplateManifest,
  preview_locale: Option<String>,
  limits: crate::execution::CompilerLimits,
  permit: L,
) -> Result<Vec<u8>, CompileError> {
  match crate::execution::execute(
    crate::execution::CompilerRequest::Validate {
      files: crate::execution::binary_files(template_files.clone()),
      manifest: manifest.clone(),
      preview_locale,
    },
    limits,
    permit,
  )
  .await
  {
    Ok(crate::execution::CompilerResponse::Validation(result)) => result.map(|bytes| bytes.into_vec()),
    Ok(_) => Err(CompileError::IoError("unexpected compiler response".into())),
    Err(error) => Err(error),
  }
}

/// Child-process implementation shared by upload validation and preview.
pub(crate) fn render_blocking(
  files_snapshot: HashMap<String, Vec<u8>>,
  manifest: &PdfTemplateManifest,
  preview_locale: Option<&str>,
) -> Result<Vec<u8>, CompileError> {
  let mut stub = with_template_defaults(
    preview_locale.map_or_else(build_stub_doc, super::preview_doc::build_preview_doc),
    manifest,
  );
  if let Some(locale) = preview_locale {
    stub.options.locale = locale.into();
  }
  let source = build_source_for_template(&stub, &files_snapshot, &manifest.entry);
  let blobs: HashMap<String, Bytes> = stub
    .assets
    .iter()
    .map(|(id, asset)| (id.clone(), Bytes::new(asset.bytes.clone())))
    .collect();
  let world = TypstWorld::new(source, blobs, &[])
    .with_bundle_files(&files_snapshot)
    .map_err(|e| CompileError::CompileFailed {
      diagnostics: vec![format!("invalid template bundle: {e}")],
    })?;
  let document = typst::compile::<PagedDocument>(&world)
    .output
    .map_err(|diags| CompileError::CompileFailed {
      diagnostics: diags.iter().map(|d| d.message.as_str().to_owned()).collect(),
    })?;
  let pdf_opts = typst_pdf::PdfOptions {
    ident: typst::foundations::Smart::Custom("validator-stub".to_owned()),
    ..Default::default()
  };
  typst_pdf::pdf(&document, &pdf_opts).map_err(|diags| CompileError::CompileFailed {
    diagnostics: diags.iter().map(|d| d.message.as_str().to_owned()).collect(),
  })
}
