// SPDX-License-Identifier: AGPL-3.0-or-later
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PdfExportError {
  #[error("IR build failed: {0}")]
  IrBuild(#[from] IrBuildError),

  #[error("Typst render failed: {0}")]
  Render(#[from] RenderError),

  #[error("Template error: {0}")]
  Template(#[from] TemplateError),

  #[error("Asset error: {0}")]
  Asset(#[from] AssetError),

  #[error("Resource limit exceeded: {0}")]
  LimitExceeded(String),
}

#[derive(Debug, Error)]
pub enum IrBuildError {
  #[error("Yjs decode failed: {0}")]
  YjsDecode(String),

  #[error("Unsupported IR version: found {found}, supported {min}–{max}")]
  UnsupportedVersion { found: u32, min: u32, max: u32 },

  #[error("Block limit exceeded: {count} blocks (max {max})")]
  BlockLimitExceeded { count: usize, max: usize },

  #[error("Missing required block field '{field}' on block {block_id}")]
  MissingField { block_id: String, field: &'static str },

  #[error("Local note cannot be exported: {0}")]
  LocalNote(String),

  #[error("Native table paint is invalid or cannot be resolved from the captured theme")]
  InvalidTablePaint,

  #[error("Asset resolver error: {0}")]
  Asset(String),
}

#[derive(Debug, Error, serde::Serialize, serde::Deserialize)]
pub enum RenderError {
  #[error("Typst compilation error: {0}")]
  Compilation(String),

  #[error("Render timeout after {secs}s")]
  Timeout { secs: u64 },

  #[error("Memory limit exceeded")]
  MemoryLimit,

  #[error("Page limit exceeded: {count} pages (max {max})")]
  PageLimit { count: usize, max: usize },

  #[error("Font not found: {name}")]
  FontNotFound { name: String },

  #[error("Edgeless snapshot exceeds limits: {0}")]
  SnapshotLimitExceeded(String),

  #[error("Unsupported PDF compliance profile: {profile}")]
  UnsupportedComplianceProfile { profile: String },

  #[error("PDF/A validation failed: {0}")]
  PdfaValidationFailed(String),

  #[error("PDF/UA validation failed: {0}")]
  PdfuaValidationFailed(String),
}

#[derive(Debug, Error)]
pub enum TemplateError {
  #[error("Template '{id}' not found")]
  NotFound { id: String },

  #[error("Template manifest invalid: {reason}")]
  InvalidManifest { reason: String },

  #[error("Template variable '{key}' has invalid value: {reason}")]
  InvalidVariable { key: String, reason: String },

  #[error("Required font '{font}' not available")]
  MissingFont { font: String },
}

#[derive(Debug, Error)]
pub enum AssetError {
  #[error("Blob '{id}' not found")]
  BlobNotFound { id: String },

  #[error("Blob '{id}' too large: {size} bytes (max {max})")]
  BlobTooLarge { id: String, size: u64, max: u64 },

  #[error("Unsupported image format: {mime}")]
  UnsupportedFormat { mime: String },

  #[error("Storage backend error: {0}")]
  Storage(String),
}
