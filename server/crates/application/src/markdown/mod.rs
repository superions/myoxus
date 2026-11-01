// SPDX-License-Identifier: AGPL-3.0-or-later
//! Stable server-facing Markdown import and projection boundary.
//!
//! Server consumers use this module for Markdown operations; syntax conversion
//! remains owned by the pure `yjs::markdown` codec.
//!
//! ## Conversion Boundaries
//!
//! **Export (Yjs -> Markdown):**
//! - Supported structures and normalization are defined by the `yjs` codec,
//!   including attributed text, nested lists and flat tables.
//! - Quality signal: `partial` flag on [`MarkdownResult`]
//!
//! **Import (Markdown -> Yjs):**
//! - Generates minimal Virgultum-compatible Yjs document
//! - New import operations create new block IDs; reserved batch preflight/final
//!   calls share their operation-local body block identities.
//! - Supports exactly the structures implemented by the `yjs` codec.
//! - Frontmatter must be stripped before calling [`markdown_to_yjs`]
//! - Full document replacement, no incremental merge
//!
//! Data-image materialization and one-document title/body/hash projection live
//! here because they require server policy while the codec remains pure.

use tracing::{debug, instrument, warn};

// Fixed export sections share the native codec; they must not acquire a second
// escaping or Markdown parsing implementation.
pub use yjs::markdown::{
  escape_markdown_destination, escape_markdown_label, escape_markdown_literal_text, escape_markdown_table_cell,
};

mod assets;
mod projection;
mod references;

pub use assets::{
  MaterializedMarkdown, MaterializedMarkdownAsset, PreparedMarkdownAssetWrite, PreparedMarkdownAssets,
  materialize_markdown_data_images, prepare_markdown_data_images,
};
pub use assets::{markdown_image_sources, rewrite_markdown_image_sources};
pub use projection::{
  MarkdownDocumentProjection, MarkdownProjectionPolicy, content_hash, project_document, project_document_in_batch,
  project_document_in_batch_with_images, project_document_with_policy, project_document_with_references,
};
pub use references::{
  AuthorizedMarkdownBatchDocument, AuthorizedMarkdownDocument, MarkdownBatchReferenceInventory,
  MarkdownBatchReferenceLookup, MarkdownReferenceLookup, PreparedMarkdownBatchExport, portable_markdown_block_id,
};

/// Result of converting a Yjs binary to Markdown.
#[derive(Debug, Clone)]
pub struct MarkdownResult {
  /// Extracted Markdown content.
  pub markdown: String,
  /// Document title extracted from the native page block, if present.
  pub title: Option<String>,
  /// Number of blocks visited during extraction.
  pub blocks_visited: u32,
  /// `true` when the extraction fell back or skipped unsupported block types.
  pub partial: bool,
  /// Safe conversion findings without document titles or source payloads.
  pub diagnostics: Vec<yjs::MarkdownDiagnostic>,
}

/// Prepared whole-document import produced by the canonical pure codec.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedMarkdownImport {
  pub yjs_binary: Vec<u8>,
  pub diagnostics: Vec<yjs::MarkdownDiagnostic>,
  pub native_math_count: usize,
  pub native_footnote_count: usize,
}

/// Error during markdown conversion.
#[derive(Debug, thiserror::Error)]
pub enum ConversionError {
  #[error("yjs decode failed: {0}")]
  YjsDecode(String),
  #[error("markdown conversion failed: {0}")]
  Conversion(String),
}

/// Convert a Yjs binary snapshot to Markdown.
///
/// Returns `Ok(None)` if the binary is empty/null or contains no extractable text.
#[instrument(skip(yjs_binary))]
pub fn yjs_to_markdown(yjs_binary: &[u8]) -> Result<Option<MarkdownResult>, ConversionError> {
  if yjs_binary.is_empty() || yjs_binary == [0, 0] {
    return Ok(None);
  }
  match yjs::extract_text_from_yjs(yjs_binary) {
    Ok(result) => {
      if result.markdown.trim().is_empty() {
        debug!("extracted empty markdown from yjs binary");
        Ok(None)
      } else {
        debug!(
          len = result.markdown.len(),
          title = ?result.title,
          blocks = result.blocks_visited,
          partial = result.extraction_partial,
          "extracted markdown from yjs"
        );
        Ok(Some(MarkdownResult {
          markdown: result.markdown,
          title: result.title,
          blocks_visited: result.blocks_visited,
          partial: result.extraction_partial,
          diagnostics: result.diagnostics,
        }))
      }
    }
    Err(e) => {
      warn!(error = %e, "failed to extract text from yjs binary");
      Err(ConversionError::YjsDecode(e))
    }
  }
}

/// Convert a snapshot using only the caller's authorized target inventory.
pub fn yjs_to_markdown_with_references(
  yjs_binary: &[u8],
  references: &MarkdownReferenceLookup,
) -> Result<Option<MarkdownResult>, ConversionError> {
  if yjs_binary.is_empty() || yjs_binary == [0, 0] {
    return Ok(None);
  }
  let result = yjs::extract_text_from_yjs_with_references(yjs_binary, &|_| true, &|reference| {
    references.resolve_export_reference(reference)
  })
  .map_err(ConversionError::YjsDecode)?;
  if result.markdown.trim().is_empty() && result.diagnostics.is_empty() {
    return Ok(None);
  }
  Ok(Some(MarkdownResult {
    markdown: result.markdown,
    title: result.title,
    blocks_visited: result.blocks_visited,
    partial: result.extraction_partial,
    diagnostics: result.diagnostics,
  }))
}

/// Convert Markdown text to a Yjs binary update.
#[instrument(skip(markdown))]
pub fn markdown_to_yjs(title: &str, markdown: &str) -> Result<Vec<u8>, ConversionError> {
  yjs::markdown_to_yjs(title, markdown).map_err(ConversionError::Conversion)
}

/// Convert Markdown using an authorized own-workspace URL inventory.
pub fn markdown_to_yjs_with_references(
  title: &str,
  markdown: &str,
  references: &MarkdownReferenceLookup,
) -> Result<Vec<u8>, ConversionError> {
  yjs::markdown_to_yjs_with_references(title, markdown, &|url| references.resolve_import_url(url))
    .map_err(ConversionError::Conversion)
}

/// Validate and convert Markdown before a caller enters its persistence phase.
///
/// Asset materialization, transactions, locks and audit remain with their
/// owning import workflow; this function performs no I/O.
#[instrument(skip_all)]
pub fn prepare_markdown_import(title: &str, markdown: &str) -> Result<PreparedMarkdownImport, ConversionError> {
  let imported = yjs::markdown_to_yjs_with_link_resolver(title, markdown, &|target| match target {
    yjs::MarkdownLinkTarget::Url(_) => yjs::MarkdownLinkResolution::Ordinary,
    yjs::MarkdownLinkTarget::Wiki(target) if target.contains('#') => yjs::MarkdownLinkResolution::Unsupported,
    yjs::MarkdownLinkTarget::Wiki(_) => yjs::MarkdownLinkResolution::Unresolved,
  })
  .map_err(ConversionError::Conversion)?;
  Ok(PreparedMarkdownImport {
    yjs_binary: imported.yjs_binary,
    diagnostics: imported.diagnostics,
    native_math_count: imported.native_math_count,
    native_footnote_count: imported.native_footnote_count,
  })
}

pub fn prepare_markdown_import_with_references(
  title: &str,
  markdown: &str,
  references: &MarkdownReferenceLookup,
) -> Result<PreparedMarkdownImport, ConversionError> {
  let imported = yjs::markdown_to_yjs_with_link_resolver(title, markdown, &|target| references.resolve_link(target))
    .map_err(ConversionError::Conversion)?;
  Ok(PreparedMarkdownImport {
    yjs_binary: imported.yjs_binary,
    diagnostics: imported.diagnostics,
    native_math_count: imported.native_math_count,
    native_footnote_count: imported.native_footnote_count,
  })
}

/// Prepare one member of a pre-reserved file batch.
pub fn prepare_markdown_batch_import(
  title: &str,
  markdown: &str,
  references: &MarkdownBatchReferenceLookup,
) -> Result<PreparedMarkdownImport, ConversionError> {
  if let Some(failure) = references.preflight_failure() {
    return Err(ConversionError::Conversion(failure.to_string()));
  }
  let resolve = |target: yjs::MarkdownLinkTarget<'_>| references.resolve_link(target);
  let imported = if let Some(import_id) = references.reserved_import_id() {
    yjs::markdown::markdown_to_yjs_with_reserved_blocks(title, markdown, import_id, &resolve)
  } else {
    yjs::markdown_to_yjs_with_link_resolver(title, markdown, &resolve)
  }
  .map_err(ConversionError::Conversion)?;
  Ok(PreparedMarkdownImport {
    yjs_binary: imported.yjs_binary,
    diagnostics: imported.diagnostics,
    native_math_count: imported.native_math_count,
    native_footnote_count: imported.native_footnote_count,
  })
}

/// Build an empty page that the normal Virgultum editor can edit immediately.
///
/// A page/root plus note container is structurally loadable, but it has no
/// text selection target. Server-created blank pages therefore include one
/// canonical empty paragraph instead of relying on a later client-side repair.
pub fn empty_page_to_yjs(title: &str) -> Vec<u8> {
  let mut builder = yjs::YjsDocumentBuilder::new(title);
  builder.push_paragraph(&[]);
  builder.encode()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn empty_page_to_yjs_includes_an_editable_paragraph() {
    let yjs_bin = empty_page_to_yjs("Blank page");
    let extracted = yjs::extract_text_from_yjs(&yjs_bin).expect("extract blank page");

    assert_eq!(extracted.title.as_deref(), Some("Blank page"));
    // Root, page, note and the required editable paragraph must all survive.
    assert_eq!(extracted.blocks_visited, 4);
    assert!(extracted.markdown.trim().is_empty());
  }

  #[test]
  fn authorized_url_import_survives_fragment_projection() {
    let lookup = MarkdownReferenceLookup::new(
      "https://myoxus.test/workspace/ws",
      [AuthorizedMarkdownDocument {
        external_id: "target".to_string(),
        title: "Target title".to_string(),
      }],
    )
    .expect("lookup");
    let imported = prepare_markdown_import_with_references(
      "Source",
      "[Visible alias](https://myoxus.test/workspace/ws/target?mode=page)",
      &lookup,
    )
    .expect("import reference");
    let fragment = crate::doc::document_fragment_from_yjs(&imported.yjs_binary).expect("fragment projection");
    let crate::doc::DocumentFragmentBlock::Paragraph { text, .. } = &fragment.blocks[0] else {
      panic!("expected paragraph");
    };
    let reference = text[0].reference.as_ref().expect("reference retained");
    assert_eq!(reference.page_id, "target");
    assert_eq!(reference.title.as_deref(), Some("Visible alias"));
    assert_eq!(
      reference.params.as_ref().and_then(|value| value["mode"].as_str()),
      Some("page")
    );
  }
}
