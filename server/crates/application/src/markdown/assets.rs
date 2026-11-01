// SPDX-License-Identifier: AGPL-3.0-or-later
//! Markdown asset normalization for server-owned import paths.
//!
//! Markdown documents may legally embed images as `data:image/*` URLs. Active
//! Myoxus documents, public publishing, PDF export, and blob ACLs expect binary
//! assets to be represented as workspace blobs instead. This module performs
//! that boundary conversion before Markdown is turned into Yjs blocks, so every
//! consuming renderer sees the same document/asset model.

use super::ConversionError;
use crate::ports::blob_service::BlobService;
use base64::Engine;
use bytes::Bytes;
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, ops::Range};
use tracing::{debug, instrument};
use uuid::Uuid;

const DEFAULT_MARKDOWN_ASSET_PREFIX: &str = "markdown-import";

/// Summary of a data-image that was converted into a workspace blob.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedMarkdownAsset {
  /// Original Markdown image destination URL.
  pub original_source: String,
  /// Workspace blob key written through [`BlobService`].
  pub blob_key: String,
  /// MIME type declared by the data URL and stored in blob metadata.
  pub mime: String,
  /// Decoded byte length.
  pub size: usize,
  /// SHA-256 checksum of the decoded bytes.
  pub checksum: String,
}

/// Result of normalizing embedded Markdown image assets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedMarkdown {
  /// Markdown with `data:image/*` destinations replaced by blob keys.
  pub markdown: String,
  /// Assets written to blob storage during normalization.
  pub assets: Vec<MaterializedMarkdownAsset>,
}

#[derive(Debug, Clone)]
struct DataImage {
  mime: String,
  bytes: Vec<u8>,
  extension: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MarkdownImageOccurrence {
  source: String,
  alt: String,
  title: String,
  occurrence_range: Range<usize>,
  destination_range: Option<Range<usize>>,
}

/// Materialize embedded Markdown data-image URLs as workspace blobs.
///
/// The function rewrites Markdown image destinations before the Yjs importer
/// runs. Standalone Markdown images can then become native `myoxus:image`
/// blocks whose `sourceId` is already a valid blob key, while the same blob
/// metadata is later used by public publishing and export paths.
#[instrument(skip(markdown, blob_service), fields(%workspace_id, %doc_id, source_label))]
pub async fn materialize_markdown_data_images(
  markdown: &str,
  workspace_id: Uuid,
  doc_id: Uuid,
  source_label: &str,
  blob_service: &BlobService,
) -> Result<MaterializedMarkdown, ConversionError> {
  let prepared = prepare_markdown_data_images(markdown, doc_id)?;
  for asset in &prepared.writes {
    blob_service
      .upload_single_part_blob(
        workspace_id,
        &asset.metadata.blob_key,
        asset.bytes.clone(),
        &asset.metadata.mime,
        Some(asset.metadata.mime.clone()),
        Some(&asset.metadata.checksum),
      )
      .await
      .map_err(|err| ConversionError::Conversion(format!("markdown image blob upload failed: {err}")))?;
  }
  debug!(
    asset_count = prepared.writes.len(),
    source_label, "materialized embedded markdown image assets"
  );
  Ok(MaterializedMarkdown {
    markdown: prepared.markdown,
    assets: prepared.writes.into_iter().map(|write| write.metadata).collect(),
  })
}

/// Validated immutable bytes awaiting the importing operation's publication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedMarkdownAssetWrite {
  pub metadata: MaterializedMarkdownAsset,
  pub bytes: Bytes,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedMarkdownAssets {
  pub markdown: String,
  pub writes: Vec<PreparedMarkdownAssetWrite>,
}

/// Decode every image before any external write; parser-owned code and
/// annotation literals remain untouched.
pub fn prepare_markdown_data_images(markdown: &str, doc_id: Uuid) -> Result<PreparedMarkdownAssets, ConversionError> {
  let occurrences = markdown_image_occurrences(markdown);
  let mut sources = occurrences
    .iter()
    .map(|image| image.source.clone())
    .filter(|source| source.to_ascii_lowercase().starts_with("data:image/"))
    .collect::<Vec<_>>();
  sources.sort();
  sources.dedup();
  let limits = myoxus_workspace_import::WorkspaceImportLimits::default();
  if sources.len() > limits.max_assets {
    return Err(ConversionError::Conversion(
      "Markdown images exceed asset count limit".into(),
    ));
  }
  let mut total_bytes = 0u64;
  let mut writes = Vec::with_capacity(sources.len());
  let mut replacements = HashMap::new();
  for source in sources {
    let image = decode_data_image(&source)?;
    total_bytes = total_bytes
      .checked_add(image.bytes.len() as u64)
      .ok_or_else(|| ConversionError::Conversion("Markdown image aggregate overflow".into()))?;
    if total_bytes > limits.max_asset_bytes {
      return Err(ConversionError::Conversion(
        "Markdown images exceed asset byte limit".into(),
      ));
    }
    let checksum = format!("{:x}", Sha256::digest(&image.bytes));
    let blob_key = format!(
      "{DEFAULT_MARKDOWN_ASSET_PREFIX}/{doc_id}/{checksum}.{}",
      image.extension
    );
    replacements.insert(source.clone(), blob_key.clone());
    writes.push(PreparedMarkdownAssetWrite {
      metadata: MaterializedMarkdownAsset {
        original_source: source,
        blob_key,
        mime: image.mime,
        size: image.bytes.len(),
        checksum,
      },
      bytes: Bytes::from(image.bytes),
    });
  }
  Ok(PreparedMarkdownAssets {
    markdown: rewrite_image_occurrences(markdown, &occurrences, &replacements)?,
    writes,
  })
}

fn markdown_image_occurrences(markdown: &str) -> Vec<MarkdownImageOccurrence> {
  // Definition children use the same image syntax and asset limits as the parent body.
  let options =
    Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES;
  let mut occurrences = Vec::new();
  let mut capture: Option<(String, String, String, LinkType, Range<usize>)> = None;
  let literal_annotations = yjs::markdown::markdown_annotation_ranges(markdown);
  let mut annotation_index = 0;

  for (event, range) in Parser::new_ext(markdown, options).into_offset_iter() {
    while literal_annotations
      .get(annotation_index)
      .is_some_and(|span| span.end <= range.start)
    {
      annotation_index += 1;
    }
    if literal_annotations
      .get(annotation_index)
      .is_some_and(|span| span.start <= range.start && range.end <= span.end)
    {
      continue;
    }
    match event {
      Event::Start(Tag::Image {
        link_type,
        dest_url,
        title,
        ..
      }) => {
        let source = dest_url.to_string();
        capture = Some((source, String::new(), title.to_string(), link_type, range));
      }
      Event::Text(text) | Event::Code(text) => {
        if let Some((_, alt, _, _, _)) = &mut capture {
          alt.push_str(&text);
        }
      }
      Event::SoftBreak | Event::HardBreak => {
        if let Some((_, alt, _, _, _)) = &mut capture {
          alt.push(' ');
        }
      }
      Event::End(TagEnd::Image) => {
        if let Some((source, alt, title, link_type, occurrence_range)) = capture.take() {
          let destination_range = matches!(link_type, LinkType::Inline)
            .then(|| inline_destination_range(markdown, occurrence_range.clone()))
            .flatten();
          occurrences.push(MarkdownImageOccurrence {
            source,
            alt,
            title,
            occurrence_range,
            destination_range,
          });
        }
      }
      _ => {}
    }
  }

  occurrences
}

/// Collect parser-recognized image destinations without matching code literals
/// or ordinary links that happen to contain image-like text.
pub fn markdown_image_sources(markdown: &str) -> Vec<String> {
  let mut sources = markdown_image_occurrences(markdown)
    .into_iter()
    .map(|occurrence| occurrence.source)
    .collect::<Vec<_>>();
  sources.sort();
  sources.dedup();
  sources
}

/// Rewrite only complete parser-recognized image occurrences. Reference-style
/// images become equivalent inline images so shared definitions and ordinary
/// links using the same label remain unchanged.
pub fn rewrite_markdown_image_sources(
  markdown: &str,
  replacements: &HashMap<String, String>,
) -> Result<String, ConversionError> {
  rewrite_image_occurrences(markdown, &markdown_image_occurrences(markdown), replacements)
}

fn inline_destination_range(markdown: &str, occurrence: Range<usize>) -> Option<Range<usize>> {
  let raw = markdown.get(occurrence.clone())?;
  let open = raw.rfind("](")? + 2;
  let bytes = raw.as_bytes();
  let mut start = open;
  while bytes.get(start).is_some_and(u8::is_ascii_whitespace) {
    start += 1;
  }
  if bytes.get(start) == Some(&b'<') {
    let end = raw.get(start + 1..)?.find('>')? + start + 1;
    return Some(occurrence.start + start + 1..occurrence.start + end);
  }

  let mut escaped = false;
  let mut nested_parentheses = 0usize;
  for (offset, byte) in bytes.iter().copied().enumerate().skip(start) {
    if escaped {
      escaped = false;
      continue;
    }
    match byte {
      b'\\' => escaped = true,
      b'(' => nested_parentheses += 1,
      b')' if nested_parentheses == 0 => return Some(occurrence.start + start..occurrence.start + offset),
      b')' => nested_parentheses -= 1,
      value if value.is_ascii_whitespace() && nested_parentheses == 0 => {
        return Some(occurrence.start + start..occurrence.start + offset);
      }
      _ => {}
    }
  }
  None
}

fn escape_image_label(value: &str) -> String {
  value.replace('\\', "\\\\").replace('[', "\\[").replace(']', "\\]")
}

fn escape_image_title(value: &str) -> String {
  value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn rewrite_image_occurrences(
  markdown: &str,
  occurrences: &[MarkdownImageOccurrence],
  blob_keys: &HashMap<String, String>,
) -> Result<String, ConversionError> {
  let mut edits = occurrences
    .iter()
    .filter_map(|occurrence| {
      let blob_key = blob_keys.get(&occurrence.source)?;
      if let Some(destination_range) = &occurrence.destination_range {
        Some((destination_range.clone(), blob_key.clone()))
      } else {
        let title = if occurrence.title.is_empty() {
          String::new()
        } else {
          format!(" \"{}\"", escape_image_title(&occurrence.title))
        };
        Some((
          occurrence.occurrence_range.clone(),
          format!("![{}]({blob_key}{title})", escape_image_label(&occurrence.alt)),
        ))
      }
    })
    .collect::<Vec<_>>();
  edits.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));

  let mut rewritten = markdown.to_string();
  let mut next_start = markdown.len();
  for (range, replacement) in edits {
    if range.start > range.end
      || range.end > next_start
      || !markdown.is_char_boundary(range.start)
      || !markdown.is_char_boundary(range.end)
    {
      return Err(ConversionError::Conversion(
        "markdown image parser produced overlapping or invalid source spans".to_string(),
      ));
    }
    rewritten.replace_range(range.clone(), &replacement);
    next_start = range.start;
  }
  Ok(rewritten)
}

fn decode_data_image(source: &str) -> Result<DataImage, ConversionError> {
  let Some(prefix) = source.get(.."data:".len()) else {
    return Err(ConversionError::Conversion(
      "markdown image is not a data URL".to_string(),
    ));
  };
  if !prefix.eq_ignore_ascii_case("data:") {
    return Err(ConversionError::Conversion(
      "markdown image is not a data URL".to_string(),
    ));
  }
  let rest = source
    .get("data:".len()..)
    .ok_or_else(|| ConversionError::Conversion("markdown image is not a data URL".to_string()))?;
  let Some((metadata, payload)) = rest.split_once(',') else {
    return Err(ConversionError::Conversion(
      "markdown image data URL has no payload".to_string(),
    ));
  };

  let mut parts = metadata.split(';');
  let mime = parts.next().unwrap_or_default().to_ascii_lowercase();
  let is_base64 = parts.any(|part| part.eq_ignore_ascii_case("base64"));
  let extension = image_extension_for_mime(&mime).ok_or_else(|| {
    ConversionError::Conversion(format!("markdown image data URL uses unsupported MIME type `{mime}`"))
  })?;

  let bytes = if is_base64 {
    base64::engine::general_purpose::STANDARD
      .decode(payload)
      .map_err(|err| ConversionError::Conversion(format!("markdown image base64 decode failed: {err}")))?
  } else {
    percent_decode_bytes(payload)?
  };
  if bytes.is_empty() {
    return Err(ConversionError::Conversion(
      "markdown image data URL payload is empty".to_string(),
    ));
  }

  Ok(DataImage { mime, bytes, extension })
}

fn image_extension_for_mime(mime: &str) -> Option<&'static str> {
  match mime {
    "image/png" => Some("png"),
    "image/jpeg" | "image/jpg" => Some("jpg"),
    "image/gif" => Some("gif"),
    "image/webp" => Some("webp"),
    "image/avif" => Some("avif"),
    "image/svg+xml" => Some("svg"),
    _ => None,
  }
}

fn percent_decode_bytes(payload: &str) -> Result<Vec<u8>, ConversionError> {
  let bytes = payload.as_bytes();
  let mut decoded = Vec::with_capacity(bytes.len());
  let mut index = 0;
  while index < bytes.len() {
    match bytes[index] {
      b'%' => {
        let hi = bytes
          .get(index + 1)
          .copied()
          .ok_or_else(|| ConversionError::Conversion("markdown image percent escape is truncated".to_string()))?;
        let lo = bytes
          .get(index + 2)
          .copied()
          .ok_or_else(|| ConversionError::Conversion("markdown image percent escape is truncated".to_string()))?;
        decoded.push((hex_nibble(hi)? << 4) | hex_nibble(lo)?);
        index += 3;
      }
      value => {
        decoded.push(value);
        index += 1;
      }
    }
  }
  Ok(decoded)
}

fn hex_nibble(value: u8) -> Result<u8, ConversionError> {
  match value {
    b'0'..=b'9' => Ok(value - b'0'),
    b'a'..=b'f' => Ok(value - b'a' + 10),
    b'A'..=b'F' => Ok(value - b'A' + 10),
    _ => Err(ConversionError::Conversion(
      "markdown image percent escape contains non-hex digits".to_string(),
    )),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn detects_only_markdown_image_data_sources() {
    let markdown = r#"
Inline code `![Ignored](data:image/png;base64,AAAA)` must not count.

Before %%![Literal](data:image/png;base64,AAAA)%% after.

![SVG](data:image/svg+xml,%3Csvg%3E%3C/svg%3E)
![PNG](data:image/png;base64,iVBORw0KGgo=)
![Upper](DATA:IMAGE/PNG;base64,iVBORw0KGgo=)
"#;

    let sources = markdown_image_occurrences(markdown)
      .into_iter()
      .filter(|occurrence| occurrence.source.to_ascii_lowercase().starts_with("data:image/"))
      .map(|occurrence| occurrence.source)
      .collect::<Vec<_>>();

    assert_eq!(sources.len(), 3);
    assert!(sources[0].starts_with("data:image/svg+xml,"));
    assert!(sources[1].starts_with("data:image/png;base64,"));
    assert!(sources[2].starts_with("DATA:IMAGE/PNG;base64,"));
  }

  #[test]
  fn rewrites_only_parser_identified_image_occurrences() {
    let source = "data:image/png;base64,iVBORw0KGgo=";
    let markdown = format!(
      "Präfix {source}\n\n`{source}`\n\n[ordinary]({source})\n\n![ä](&lt;ignored&gt;)\n\n![inline](<{source}> \"title\")\n\n![reference][shared]\n\n[ordinary reference][shared]\n\n![repeat]({source})\n\n[shared]: {source}\n"
    );
    let occurrences = markdown_image_occurrences(&markdown)
      .into_iter()
      .filter(|occurrence| occurrence.source.to_ascii_lowercase().starts_with("data:image/"))
      .collect::<Vec<_>>();
    assert_eq!(occurrences.len(), 3);
    let rewritten = rewrite_image_occurrences(
      &markdown,
      &occurrences,
      &HashMap::from([(source.to_string(), "markdown-import/doc/checksum.png".to_string())]),
    )
    .expect("rewrite image spans");

    assert!(rewritten.contains(&format!("Präfix {source}")));
    assert!(rewritten.contains(&format!("`{source}`")));
    assert!(rewritten.contains(&format!("[ordinary]({source})")));
    assert!(rewritten.contains("[ordinary reference][shared]"));
    assert!(rewritten.contains(&format!("[shared]: {source}")));
    assert!(rewritten.contains("![inline](<markdown-import/doc/checksum.png> \"title\")"));
    assert!(rewritten.contains("![reference](markdown-import/doc/checksum.png)"));
    assert!(rewritten.contains("![repeat](markdown-import/doc/checksum.png)"));
    assert_eq!(
      rewritten.matches(source).count(),
      4,
      "only non-image occurrences and the shared definition remain"
    );
  }
}
