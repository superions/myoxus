// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical projection of one Yjs document into Markdown.

use sha2::{Digest, Sha256};
use tracing::instrument;

use super::ConversionError;
use super::{MarkdownBatchReferenceLookup, MarkdownReferenceLookup};

/// Stable Markdown projection used by exports and change detection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownDocumentProjection {
  pub citations: Vec<(String, serde_json::Value)>,
  pub title: String,
  pub markdown: String,
  pub content_hash: String,
  pub partial: bool,
  pub diagnostics: Vec<yjs::MarkdownDiagnostic>,
}

/// Narrow export policy for private server projections.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MarkdownProjectionPolicy {
  pub omit_insecure_external_images: bool,
}

/// Project one loaded document without confusing an empty body with absence.
///
/// Decode failures remain fatal. An extracted blank title falls back to the
/// authoritative database title supplied by the caller.
pub fn project_document(
  yjs_binary: &[u8],
  database_title: impl Into<String>,
) -> Result<MarkdownDocumentProjection, ConversionError> {
  project_document_with_policy(yjs_binary, database_title, MarkdownProjectionPolicy::default())
}

/// Project one document while applying private image-source policy during the
/// codec walk, never by parsing or rewriting emitted Markdown.
pub fn project_document_with_policy(
  yjs_binary: &[u8],
  database_title: impl Into<String>,
  policy: MarkdownProjectionPolicy,
) -> Result<MarkdownDocumentProjection, ConversionError> {
  let database_title = database_title.into();
  if yjs_binary.is_empty() || yjs_binary == [0, 0] {
    return Ok(MarkdownDocumentProjection {
      citations: Vec::new(),
      title: database_title,
      markdown: String::new(),
      content_hash: content_hash(""),
      partial: false,
      diagnostics: Vec::new(),
    });
  }
  let converted = yjs::extract_text_from_yjs_with_image_filter(yjs_binary, &|source| {
    !policy.omit_insecure_external_images || !source.starts_with("http://")
  })
  .map_err(ConversionError::YjsDecode)?;
  let title = converted
    .title
    .filter(|title| !title.trim().is_empty())
    .unwrap_or(database_title);
  let markdown = converted.markdown;
  let partial = converted.extraction_partial;
  let content_hash = content_hash(&markdown);
  Ok(MarkdownDocumentProjection {
    citations: converted.citations,
    title,
    markdown,
    content_hash,
    partial,
    diagnostics: converted.diagnostics,
  })
}

/// Project one document using only caller-authorized reference metadata.
pub fn project_document_with_references(
  yjs_binary: &[u8],
  database_title: impl Into<String>,
  policy: MarkdownProjectionPolicy,
  references: &MarkdownReferenceLookup,
) -> Result<MarkdownDocumentProjection, ConversionError> {
  let database_title = database_title.into();
  if yjs_binary.is_empty() || yjs_binary == [0, 0] {
    return Ok(MarkdownDocumentProjection {
      citations: Vec::new(),
      title: database_title,
      markdown: String::new(),
      content_hash: content_hash(""),
      partial: false,
      diagnostics: Vec::new(),
    });
  }
  let converted = yjs::extract_text_from_yjs_with_references(
    yjs_binary,
    &|source| !policy.omit_insecure_external_images || !source.starts_with("http://"),
    &|reference| references.resolve_export_reference(reference),
  )
  .map_err(ConversionError::YjsDecode)?;
  let title = converted
    .title
    .filter(|title| !title.trim().is_empty())
    .unwrap_or(database_title);
  let markdown = converted.markdown;
  Ok(MarkdownDocumentProjection {
    citations: converted.citations,
    title,
    content_hash: content_hash(&markdown),
    markdown,
    partial: converted.extraction_partial,
    diagnostics: converted.diagnostics,
  })
}

/// Project one member of a final file-path plan with portable relative links.
pub fn project_document_in_batch(
  yjs_binary: &[u8],
  database_title: impl Into<String>,
  policy: MarkdownProjectionPolicy,
  references: &MarkdownBatchReferenceLookup,
) -> Result<MarkdownDocumentProjection, ConversionError> {
  let database_title = database_title.into();
  if yjs_binary.is_empty() || yjs_binary == [0, 0] {
    return Ok(MarkdownDocumentProjection {
      citations: Vec::new(),
      title: database_title,
      markdown: String::new(),
      content_hash: content_hash(""),
      partial: false,
      diagnostics: Vec::new(),
    });
  }
  let converted = yjs::extract_text_from_yjs_with_references(
    yjs_binary,
    &|source| !policy.omit_insecure_external_images || !source.starts_with("http://"),
    &|reference| references.resolve_export_reference(reference),
  )
  .map_err(ConversionError::YjsDecode)?;
  let title = converted
    .title
    .filter(|title| !title.trim().is_empty())
    .unwrap_or(database_title);
  let markdown = converted.markdown;
  Ok(MarkdownDocumentProjection {
    citations: converted.citations,
    title,
    content_hash: content_hash(&markdown),
    markdown,
    partial: converted.extraction_partial,
    diagnostics: converted.diagnostics,
  })
}

/// Project one batch member while rewriting native and attributed inline image
/// sources to the final archive-relative asset paths planned by the caller.
pub fn project_document_in_batch_with_images(
  yjs_binary: &[u8],
  database_title: impl Into<String>,
  policy: MarkdownProjectionPolicy,
  references: &MarkdownBatchReferenceLookup,
  resolve_image: &dyn Fn(&str) -> Option<String>,
) -> Result<MarkdownDocumentProjection, ConversionError> {
  let database_title = database_title.into();
  if yjs_binary.is_empty() || yjs_binary == [0, 0] {
    return Ok(MarkdownDocumentProjection {
      citations: Vec::new(),
      title: database_title,
      markdown: String::new(),
      content_hash: content_hash(""),
      partial: false,
      diagnostics: Vec::new(),
    });
  }
  let converted = yjs::extract_text_from_yjs_with_references_and_images(
    yjs_binary,
    &|source| !policy.omit_insecure_external_images || !source.starts_with("http://"),
    &|reference| references.resolve_export_reference(reference),
    resolve_image,
  )
  .map_err(ConversionError::YjsDecode)?;
  let title = converted
    .title
    .filter(|title| !title.trim().is_empty())
    .unwrap_or(database_title);
  let markdown = converted.markdown;
  Ok(MarkdownDocumentProjection {
    citations: converted.citations,
    title,
    content_hash: content_hash(&markdown),
    markdown,
    partial: converted.extraction_partial,
    diagnostics: converted.diagnostics,
  })
}

/// SHA-256 of the canonical Markdown body used for change detection.
#[instrument(skip(markdown))]
pub fn content_hash(markdown: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(markdown.as_bytes());
  format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn projection_preserves_title_body_and_hash() {
    let yjs = crate::markdown::markdown_to_yjs("Projected title", "Projected body").expect("Yjs fixture");
    let projected = project_document(&yjs, "Database title").expect("project document");

    assert_eq!(projected.title, "Projected title");
    assert!(projected.markdown.contains("Projected body"));
    assert_eq!(projected.content_hash, content_hash(&projected.markdown));
    assert!(!projected.partial);
  }

  #[test]
  fn projection_preserves_empty_document_as_a_real_object() {
    let projected = project_document(&[], "Empty document").expect("project empty document");

    assert_eq!(projected.title, "Empty document");
    assert_eq!(projected.markdown, "");
    assert_eq!(projected.content_hash, content_hash(""));
  }

  #[test]
  fn projection_keeps_decode_failure_fatal() {
    assert!(project_document(&[0xff, 0xff, 0xff], "Broken").is_err());
  }
}
