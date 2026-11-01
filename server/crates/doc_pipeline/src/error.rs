//! Error types for the document parsing pipeline.

/// Errors that can occur during document parsing.
#[derive(Debug, thiserror::Error)]
pub enum PipelineError {
  /// The document format is not supported or the required feature is disabled.
  #[error("unsupported format: {0}")]
  UnsupportedFormat(String),

  /// The document data is malformed or could not be parsed.
  #[error("parse error: {0}")]
  ParseError(String),

  /// The document is encrypted and cannot be read without a password.
  #[error("document is encrypted")]
  Encrypted,

  /// The document is empty or contains no extractable text.
  #[error("no text content found")]
  NoContent,

  /// An I/O or other unexpected error.
  #[error(transparent)]
  Other(#[from] Box<dyn std::error::Error + Send + Sync>),
}

/// Convenience alias.
pub type Result<T> = std::result::Result<T, PipelineError>;
