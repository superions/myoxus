// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Bounded Word conversion through the normal editable page, projection and blob owners.

mod export;
pub use export::{ExportFonts, ExportTypography, ExportedDocx, encode_export, resolve_export_assets};

use std::{
  collections::{BTreeMap, BTreeSet},
  io::Cursor,
};

use bytes::Bytes;
use myoxus_domain::entities::Doc;
use myoxus_public_render::PublicDocIr;
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use wordcraft_doc::{Block, Document, InlineObject, Paragraph, numbering::Counters, section::NumFormat};
use yjs::{YjsDocumentBuilder, YjsTextSegment};

use crate::{
  auth::AuthError,
  doc::DocService,
  ports::{blob::BlobStatus, blob_service::BlobService},
};

// Ordinary Word paragraph/table indentation carries the visible hierarchy of
// the two named semantic styles, not private roundtrip metadata.
const CONTENT_INDENT: f32 = 18.0;

mod math;
mod media;
pub use media::{NativeFallback, ReadableFallback, block_fallback_inventory, safe_external_reference};
mod references;
pub use references::{
  ExportReferencePresentation, NativeReference, ReadableReference, ReferenceTarget, block_reference_inventory,
  inline_reference_key,
};

pub struct CapturedDocx {
  pub ir: PublicDocIr,
  pub native_snapshot: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionWarning {
  pub code: &'static str,
  pub count: usize,
}

#[derive(Debug)]
pub enum ImportError {
  Invalid,
  TooLarge,
  Empty,
  Conversion,
  Storage(AuthError),
}

impl From<AuthError> for ImportError {
  fn from(error: AuthError) -> Self {
    Self::Storage(error)
  }
}

struct Asset {
  bytes: Bytes,
  key: String,
  mime: &'static str,
  checksum: String,
}

pub struct PreparedDocx {
  title: String,
  snapshot: Vec<u8>,
  assets: Vec<Asset>,
  pub warnings: Vec<ConversionWarning>,
}

pub struct ImportedDocx {
  pub doc: Doc,
  pub warnings: Vec<ConversionWarning>,
  /// Exact committed deltas for the transport's existing live publication path.
  pub sync_updates: crate::doc::CreatedPageSyncUpdates,
}

/// Capture the committed head once and keep the native editing projection
/// attached to that same state. The DOCX encoder must not reload independently
/// or use the paginated structured response as its source of truth.
pub async fn capture_export_source(
  docs: &DocService,
  workspace: Uuid,
  document: &Doc,
) -> Result<CapturedDocx, ImportError> {
  let captured = docs
    .load
    .load_full_doc_with_revision_bounded(workspace, document.id, docs.snapshot_ingress_max_bytes())
    .await
    .map_err(|cause| match cause {
      AuthError::DocSyncPayloadTooLarge { .. } => ImportError::TooLarge,
      cause => ImportError::Storage(cause),
    })?;
  if captured.payload.len() > docs.snapshot_ingress_max_bytes() {
    return Err(ImportError::TooLarge);
  }
  let id = document.id;
  let title = document.title.clone();
  tokio::task::spawn_blocking(move || {
    let ir = crate::doc::content_projection::project_snapshot_for_export(workspace, id, &title, &captured.payload)
      .map_err(|_| ImportError::Conversion)?;
    let native_snapshot =
      yjs::native_snapshot::document_to_export_snapshot(&captured.payload, &id.to_string(), &title).ok();
    Ok(CapturedDocx { ir, native_snapshot })
  })
  .await
  .map_err(|_| ImportError::Conversion)?
}

/// Parse completely before publishing a page. WordCraft may silently ignore
/// markup it does not understand; consumers must also show the general
/// best-effort notice, independently of the observed warnings here.
pub fn prepare_docx(bytes: &[u8], filename: &str) -> Result<PreparedDocx, ImportError> {
  let limits = myoxus_workspace_import::WorkspaceImportLimits::default();
  if bytes.is_empty() {
    return Err(ImportError::Invalid);
  }
  if bytes.len() as u64 > limits.max_upload_bytes.min(limits.max_document_bytes) {
    return Err(ImportError::TooLarge);
  }
  let source = wordcraft_docx::read(bytes).map_err(|error| match error {
    wordcraft_docx::DocxError::Limit(_) => ImportError::TooLarge,
    _ => ImportError::Invalid,
  })?;
  let fallback = filename
    .rsplit(['/', '\\'])
    .next()
    .unwrap_or(filename)
    .trim_end_matches(|c: char| c == ' ' || c == '.');
  let fallback = fallback
    .get(..fallback.len().saturating_sub(5))
    .filter(|_| fallback.to_ascii_lowercase().ends_with(".docx"))
    .unwrap_or(fallback)
    .trim();
  let title = source.core.title.trim();
  let title = if title.is_empty() { fallback } else { title };
  let title = if title.is_empty() { "Untitled" } else { title };
  let clean_title = title.chars().filter(|c| !c.is_control()).take(255).collect::<String>();
  let title = clean_title.trim();
  let title = if title.is_empty() { "Untitled" } else { title };
  let mut mapper = Mapper::new(&source, title, limits.max_assets, limits.max_asset_bytes);
  if title != source.core.title.trim() && !source.core.title.trim().is_empty() {
    mapper.warn("title_normalized");
  }
  mapper.map_body()?;
  if mapper.usable == 0 {
    return Err(ImportError::Empty);
  }
  if mapper.builder.block_count() > limits.max_blocks {
    return Err(ImportError::TooLarge);
  }
  let snapshot = mapper.builder.encode();
  if snapshot.len() as u64 > limits.max_document_bytes {
    return Err(ImportError::TooLarge);
  }
  Ok(PreparedDocx {
    title: title.to_string(),
    snapshot,
    assets: mapper.assets.into_values().collect(),
    warnings: mapper
      .warnings
      .into_iter()
      .map(|(code, count)| ConversionWarning { code, count })
      .collect(),
  })
}

/// Materialize immutable, hash-addressed media without deleting existing shared
/// bytes on publication failure; only the lifecycle owner creates the page.
pub async fn publish_docx(
  prepared: PreparedDocx,
  workspace: Uuid,
  actor: Uuid,
  blobs: &BlobService,
  docs: &DocService,
) -> Result<ImportedDocx, ImportError> {
  if prepared.snapshot.len() > docs.snapshot_ingress_max_bytes() {
    return Err(ImportError::TooLarge);
  }
  for asset in prepared.assets {
    if let Some(existing) = blobs.get_blob_metadata(workspace, &asset.key).await? {
      if existing.status != BlobStatus::Completed
        || existing.size != asset.bytes.len() as u64
        || existing.mime != asset.mime
        || existing.checksum.as_deref() != Some(asset.checksum.as_str())
      {
        return Err(ImportError::Storage(AuthError::InvalidInput(
          "import image conflicts with existing blob".into(),
        )));
      }
      continue;
    }
    blobs
      .upload_single_part_blob(
        workspace,
        &asset.key,
        asset.bytes,
        asset.mime,
        Some(asset.mime.into()),
        Some(&asset.checksum),
      )
      .await?;
  }
  let (doc, sync_updates) = docs
    .create_page_from_snapshot_with_sync_updates(workspace, actor, Some(prepared.title), prepared.snapshot)
    .await?;
  Ok(ImportedDocx {
    doc,
    sync_updates,
    warnings: prepared.warnings,
  })
}

struct Mapper<'a> {
  source: &'a Document,
  builder: YjsDocumentBuilder,
  counters: Counters,
  assets: BTreeMap<String, Asset>,
  media_keys: BTreeMap<String, String>,
  warnings: BTreeMap<&'static str, usize>,
  usable: usize,
  max_assets: usize,
  max_asset_bytes: u64,
  asset_bytes: u64,
  notes: BTreeMap<u32, (String, String, yjs::footnote::FootnotePlacement)>,
  current_note: Option<u32>,
  note_bookmarks: BTreeMap<String, u32>,
  content_indent: f32,
  source_bookmarks: BTreeMap<String, Option<String>>,
}

impl<'a> Mapper<'a> {
  fn segment(text: &str, props: &wordcraft_doc::resolve::ResolvedChar) -> YjsTextSegment {
    let mut segment = YjsTextSegment::plain(text);
    segment.bold = props.bold;
    segment.italic = props.italic;
    segment.underline = props.underline != Default::default();
    segment.strike = props.strike;
    segment.link = props
      .link
      .as_deref()
      .filter(|target| {
        target.starts_with('#')
          || url::Url::parse(target).is_ok_and(|url| matches!(url.scheme(), "https" | "http" | "mailto"))
      })
      .map(str::to_string);
    segment
  }

  fn new(source: &'a Document, title: &str, max_assets: usize, max_asset_bytes: u64) -> Self {
    fn referenced(
      source: &Document,
      blocks: &[std::sync::Arc<Block>],
      ids: &mut BTreeSet<u32>,
      active: &mut Vec<String>,
      bookmarks: &mut BTreeMap<String, Option<u32>>,
    ) {
      for block in blocks {
        match &**block {
          Block::Para(paragraph) => {
            let mut runs = paragraph.run_ranges().peekable();
            let objects = paragraph.objects_with_offsets().collect::<Vec<_>>();
            for (position, (offset, object)) in objects.iter().copied().enumerate() {
              while runs.peek().is_some_and(|(range, _)| range.end <= offset) {
                runs.next();
              }
              let visible = runs
                .peek()
                .filter(|(range, _)| range.contains(&offset))
                .is_some_and(|(_, props)| {
                  let props = source.styles.resolve_char(paragraph.props.style.as_deref(), props);
                  props.del.is_none() && !props.hidden
                });
              if !visible {
                continue;
              }
              match object {
                InlineObject::BookmarkStart { name } if active.len() < 256 => active.push(name.clone()),
                InlineObject::BookmarkEnd { name } => active.retain(|value| value != name),
                InlineObject::NoteRef { id, .. } => {
                  ids.insert(*id);
                  // Only a bookmark around the atomic note anchor is a note
                  // target. A whole paragraph containing a note remains an
                  // ordinary block bookmark, not a repeated-note alias.
                  if let (
                    Some((before, InlineObject::BookmarkStart { name })),
                    Some((after, InlineObject::BookmarkEnd { name: end })),
                  ) = (
                    position.checked_sub(1).and_then(|index| objects.get(index)),
                    objects.get(position + 1),
                  ) && name == end
                    && active.contains(name)
                    && *before + wordcraft_doc::para::OBJ.len_utf8() == offset
                    && offset + wordcraft_doc::para::OBJ.len_utf8() == *after
                  {
                    bookmarks
                      .entry(name.clone())
                      .and_modify(|value| {
                        if *value != Some(*id) {
                          *value = None;
                        }
                      })
                      .or_insert(Some(*id));
                  }
                }
                InlineObject::CommentEnd { id } => {
                  if let Some(comment) = source.comments.get(id) {
                    ids.insert(comment.part);
                  }
                }
                _ => {}
              }
            }
          }
          Block::Table(table) => {
            for row in &table.rows {
              for cell in &row.cells {
                referenced(source, &cell.blocks, ids, active, bookmarks);
              }
            }
          }
        }
      }
    }
    let mut ids = BTreeSet::new();
    let mut bookmarks = BTreeMap::new();
    referenced(source, &source.body, &mut ids, &mut Vec::new(), &mut bookmarks);
    let mut builder = YjsDocumentBuilder::new(title);
    let notes = source
      .parts
      .iter()
      .filter_map(|(id, part)| {
        let placement = match part.kind {
          wordcraft_doc::PartKind::Footnote => yjs::footnote::FootnotePlacement::Footnote,
          wordcraft_doc::PartKind::Endnote => yjs::footnote::FootnotePlacement::Endnote,
          wordcraft_doc::PartKind::Comment => yjs::footnote::FootnotePlacement::Footnote,
          _ => return None,
        };
        if !ids.contains(id) {
          return None;
        }
        let label = format!("word-note-{id}");
        Some((*id, (builder.reserve_footnote_definition(&label), label, placement)))
      })
      .collect();
    Self {
      source,
      builder,
      counters: Counters::default(),
      assets: BTreeMap::new(),
      media_keys: BTreeMap::new(),
      warnings: BTreeMap::new(),
      usable: 0,
      max_assets,
      max_asset_bytes,
      asset_bytes: 0,
      notes,
      current_note: None,
      note_bookmarks: bookmarks
        .into_iter()
        .filter_map(|(name, id)| id.map(|id| (name, id)))
        .collect(),
      content_indent: 0.0,
      source_bookmarks: BTreeMap::new(),
    }
  }

  fn warn(&mut self, code: &'static str) {
    *self.warnings.entry(code).or_default() += 1;
  }

  fn map_body(&mut self) -> Result<(), ImportError> {
    self.map_blocks(&self.source.body)?;
    let notes = self.notes.clone();
    for (word_id, (id, _, placement)) in notes {
      let part = &self.source.parts[&word_id];
      self
        .builder
        .begin_footnote_body(&id, placement)
        .map_err(|_| ImportError::Conversion)?;
      self.current_note = Some(word_id);
      let counters = std::mem::take(&mut self.counters);
      if part.kind == wordcraft_doc::PartKind::Comment {
        self.builder.push_paragraph(&[YjsTextSegment::plain("[Word comment]")]);
        self.warn("comment_note_normalized");
      }
      self.map_blocks(&part.blocks)?;
      self.counters = counters;
      self.current_note = None;
      self.builder.end_footnote_body();
      let options = self.source.note_options(
        &self.source.last_section,
        placement == yjs::footnote::FootnotePlacement::Endnote,
      );
      if part.kind != wordcraft_doc::PartKind::Comment
        && (options.num_fmt != NumFormat::Decimal
          || options.num_start != 1
          || options.num_restart != wordcraft_doc::section::NoteRestart::Continuous)
      {
        self.warn("note_numbering_normalized");
      }
    }
    self.map_secondary_stories();
    let targets = self
      .source_bookmarks
      .iter()
      .filter_map(|(name, id)| Some((name.clone(), id.clone()?)))
      .collect();
    let missing = self.builder.bind_local_bookmark_links(&targets);
    if missing > 0 {
      *self.warnings.entry("bookmark_target_normalized").or_default() += missing;
    }
    Ok(())
  }

  fn record_bookmarks(&mut self, block: &Block, target: &str) {
    match block {
      Block::Para(paragraph) => {
        for (_, object) in paragraph.objects_with_offsets() {
          if let InlineObject::BookmarkStart { name } = object
            && !self.note_bookmarks.contains_key(name)
          {
            self
              .source_bookmarks
              .entry(name.clone())
              .and_modify(|previous| {
                if previous.as_deref() != Some(target) {
                  *previous = None;
                }
              })
              .or_insert(Some(target.to_string()));
          }
        }
      }
      Block::Table(table) => {
        for child in table
          .rows
          .iter()
          .flat_map(|row| &row.cells)
          .flat_map(|cell| &cell.blocks)
        {
          self.record_bookmarks(child, target);
        }
      }
    }
  }

  fn map_blocks(&mut self, blocks: &[std::sync::Arc<Block>]) -> Result<(), ImportError> {
    self.map_nested_blocks(blocks, 0)
  }

  fn relative_depth(&self, indent: f32) -> usize {
    ((indent - self.content_indent).max(0.0) / CONTENT_INDENT)
      .round()
      .min(8.0) as usize
  }

  fn map_nested_blocks(&mut self, blocks: &[std::sync::Arc<Block>], depth: usize) -> Result<(), ImportError> {
    if depth > 64 {
      return Err(ImportError::TooLarge);
    }
    let mut index = 0;
    while index < blocks.len() {
      let block = &blocks[index];
      // A normal Word Caption paired with an otherwise standalone image is
      // the visible form of that image's alternative/caption text. Collapse
      // only an exact, visible pair, never arbitrary duplicate prose.
      let paired_caption = match (&**block, blocks.get(index + 1).map(|block| &**block)) {
        (Block::Para(image), Some(Block::Para(caption)))
          if image.objects.len() == 1
            && image
              .text
              .chars()
              .all(|character| character == wordcraft_doc::para::OBJ || character.is_whitespace())
            && caption.props.style.as_deref() == Some("Caption")
            && [image, caption].iter().all(|paragraph| {
              paragraph.runs.iter().all(|run| {
                let props = self
                  .source
                  .styles
                  .resolve_char(paragraph.props.style.as_deref(), &run.props);
                !props.hidden && props.del.is_none()
              })
            }) =>
        {
          matches!(&image.objects[0],InlineObject::Image{alt,..} if !alt.is_empty() && caption.final_text()==*alt)
        }
        _ => false,
      };
      if let Block::Para(paragraph) = &**block {
        let style = paragraph.props.style.as_deref().unwrap_or_default();
        let indent = block_indent(block);
        if style == "MyoxusCallout" {
          let (segments, images) = self.segments(paragraph)?;
          let parent = self
            .builder
            .parent_at_list_depth(self.relative_depth(indent))
            .map(str::to_owned);
          let id = self
            .builder
            .push_callout_under("note", "", false, true, parent.as_deref());
          self.record_bookmarks(block, &id);
          self.builder.set_container_body(&id, &segments);
          self.usable += usize::from(segments.iter().any(|segment| !segment.text.trim().is_empty()));
          let mut end = index + 1;
          while end < blocks.len() && block_indent(&blocks[end]) > indent {
            end += 1;
          }
          let outer = self.builder.enter_content_parent(id);
          let outer_indent = std::mem::replace(&mut self.content_indent, indent + CONTENT_INDENT);
          for (_, key, alt) in images {
            self.builder.push_image(&key, &alt);
            self.usable += 1;
            self.warn("inline_image_structure_normalized");
          }
          let result = self.map_nested_blocks(&blocks[index + 1..end], depth + 1);
          self.content_indent = outer_indent;
          self.builder.restore_content_parent(outer);
          result?;
          index = end;
          continue;
        }
        if style == "MyoxusCode" {
          let (segments, images) = self.segments(paragraph)?;
          if !images.is_empty() {
            // Images are not literal code. Reuse the ordinary ordered native
            // text/image path rather than dropping a figure or retaining an
            // unreferenced imported blob behind a fake code placeholder.
            self.warn("code_structure_normalized");
            self.map_paragraph_content(paragraph, segments, images, None)?;
            if let Some(id) = self.builder.last_created_block_id() {
              self.record_bookmarks(block, &id);
            }
            index += 1;
            continue;
          }
          if segments.iter().any(|segment| {
            segment.bold || segment.italic || segment.strike || segment.underline || segment.link.is_some()
          }) {
            self.warn("code_inline_style_normalized");
          }
          let mut text = String::new();
          for segment in segments {
            if segment.footnote.is_some() {
              text.push_str("[Note]");
              self.warn("code_inline_object_normalized");
            } else {
              text.push_str(&segment.text);
            }
          }
          let level = self.relative_depth(indent);
          if level == 0 {
            self.builder.push_code("plaintext", &text);
          } else {
            let parent = self.builder.parent_at_list_depth(level).map(str::to_owned);
            self.builder.push_code_under("plaintext", &text, parent.as_deref());
          }
          self.usable += usize::from(!text.trim().is_empty());
          if let Some(id) = self.builder.last_created_block_id() {
            self.record_bookmarks(block, &id);
          }
          index += 1;
          continue;
        }
      }
      let previous_count = self.builder.block_count();
      match &**block {
        Block::Para(para) => self.map_paragraph(para)?,
        Block::Table(table) => {
          let mut rows = Vec::new();
          let mut table_images = Vec::new();
          let header_rows = table.rows.iter().take_while(|row| row.props.header).count();
          if table.props.borders.is_some()
            || table.props.cell_margins.is_some()
            || table.props.style.is_some()
            || table
              .rows
              .iter()
              .flat_map(|row| &row.cells)
              .any(|cell| cell.props.shading.is_some())
          {
            self.warn("table_style_normalized");
          }
          let mut merged = false;
          let mut grid_offsets = false;
          for row in &table.rows {
            let mut cells = vec![Vec::new(); row.first_grid()];
            grid_offsets |= row.first_grid() > 0 || row.grid_after() > 0;
            for cell in &row.cells {
              merged |= cell.span() > 1 || cell.props.vmerge != wordcraft_doc::props::VMerge::None;
              let mut text = Vec::new();
              for block in &cell.blocks {
                if let Block::Para(p) = &**block {
                  if !text.is_empty() {
                    text.push(YjsTextSegment::plain("\n"));
                  }
                  let (mut paragraph, images) = self.segments(p)?;
                  for (offset, (position, key, alt)) in images.into_iter().enumerate() {
                    paragraph.insert(position + offset, YjsTextSegment::plain(format!("[Image: {alt}]")));
                    table_images.push((key, alt));
                  }
                  text.extend(paragraph);
                } else {
                  self.warn("nested_table_omitted");
                }
              }
              cells.push(text);
              cells.extend(std::iter::repeat_n(Vec::new(), cell.span() - 1));
            }
            cells.extend(std::iter::repeat_n(Vec::new(), row.grid_after()));
            rows.push(cells);
          }
          if merged {
            self.warn("merged_cells_normalized");
          }
          if grid_offsets {
            self.warn("table_grid_normalized");
          }
          if rows
            .iter()
            .any(|r| r.iter().flatten().any(|s| !s.text.trim().is_empty()))
          {
            self.usable += 1;
          }
          let level = self.relative_depth(block_indent(block));
          if level == 0 {
            self.builder.push_table_with_header_rows(&rows, header_rows);
          } else {
            let parent = self.builder.parent_at_list_depth(level).map(str::to_owned);
            self
              .builder
              .push_table_under(&rows, &[], parent.as_deref(), Some(header_rows));
          }
          for (key, alt) in table_images {
            self.builder.push_image(&key, &alt);
            self.usable += 1;
            self.warn("table_image_structure_normalized");
          }
        }
      }
      if self.builder.block_count() > previous_count
        && let Some(id) = self.builder.last_created_block_id()
      {
        self.record_bookmarks(block, &id);
      }
      index += if paired_caption { 2 } else { 1 };
    }
    Ok(())
  }

  fn map_secondary_stories(&mut self) {
    // Secondary Word stories are not live Myoxus review/layout state. Retain
    // their readable text as ordinary, labelled page content instead.
    for (id, part) in &self.source.parts {
      if self.notes.contains_key(id) {
        continue;
      }
      // A deleted/hidden anchor or an orphan Word story must not resurrect its
      // note body as visible prose after accepting revisions.
      if matches!(
        part.kind,
        wordcraft_doc::PartKind::Footnote | wordcraft_doc::PartKind::Endnote | wordcraft_doc::PartKind::Comment
      ) {
        continue;
      }
      let kind = match part.kind {
        wordcraft_doc::PartKind::Header => "header",
        wordcraft_doc::PartKind::Footer => "footer",
        wordcraft_doc::PartKind::Footnote => "footnote",
        wordcraft_doc::PartKind::Endnote => "endnote",
        wordcraft_doc::PartKind::Comment => "comment",
        wordcraft_doc::PartKind::TextBox => "text_box",
      };
      let mut lines = Vec::new();
      for block in &part.blocks {
        match &**block {
          Block::Para(p) => lines.push(p.final_text()),
          Block::Table(table) => {
            self.warn("secondary_table_normalized");
            for row in &table.rows {
              lines.push(
                row
                  .cells
                  .iter()
                  .map(|cell| {
                    cell
                      .blocks
                      .iter()
                      .filter_map(|block| {
                        if let Block::Para(p) = &**block {
                          Some(p.final_text())
                        } else {
                          None
                        }
                      })
                      .collect::<Vec<_>>()
                      .join(" ")
                  })
                  .collect::<Vec<_>>()
                  .join(" | "),
              );
            }
          }
        }
      }
      let body = lines
        .into_iter()
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
      if !body.is_empty() {
        self
          .builder
          .push_paragraph(&[YjsTextSegment::plain(format!("[Word {kind}] {body}"))]);
        self.warn("secondary_story_normalized");
        self.usable += 1;
      }
    }
  }

  fn map_paragraph(&mut self, para: &Paragraph) -> Result<(), ImportError> {
    // A display equation can share a source paragraph with surrounding prose.
    // Split using Wordcraft's rich paragraph operation, never plain text slicing.
    let displays = para
      .objects_with_offsets()
      .filter_map(|(offset, object)| {
        if !matches!(object, InlineObject::Equation { display: true, .. }) {
          return None;
        }
        let (_, props) = para.run_ranges().find(|(range, _)| range.contains(&offset))?;
        let props = self.source.styles.resolve_char(para.props.style.as_deref(), props);
        (!props.hidden && props.del.is_none()).then_some(offset)
      })
      .collect::<Vec<_>>();
    if !displays.is_empty() {
      let mut remaining = para.clone();
      let mut consumed = 0;
      for offset in displays {
        let mut equation = remaining
          .split_off(offset - consumed)
          .map_err(|_| ImportError::Conversion)?;
        if !remaining.final_text().trim().is_empty() {
          self.map_paragraph(&remaining)?;
        }
        let InlineObject::Equation { math, linear, .. } = equation.object_at(0).expect("split equation") else {
          return Err(ImportError::Conversion);
        };
        let source = math::to_latex(math);
        let level = self.relative_depth(para.props.indent_left.unwrap_or(0.0));
        let parent = self.builder.parent_at_list_depth(level).map(str::to_owned);
        if let Some(source) = source {
          self.builder.push_latex_under(&source, parent.as_deref());
          self.usable += 1;
        } else if !linear.trim().is_empty() {
          self.builder.push_paragraph_under(
            &[YjsTextSegment::plain(format!("[Formula: {linear}]"))],
            parent.as_deref(),
          );
          self.warn("formula_structure_normalized");
          self.usable += 1;
        } else {
          self.warn("formula_omitted");
        }
        remaining = equation
          .split_off(wordcraft_doc::para::OBJ.len_utf8())
          .map_err(|_| ImportError::Conversion)?;
        consumed = offset + wordcraft_doc::para::OBJ.len_utf8();
      }
      if !remaining.final_text().trim().is_empty() {
        self.map_paragraph(&remaining)?;
      }
      return Ok(());
    }
    let checked = leading_checkbox(self.source, para);
    let (segments, images) = self.segments_with_task(para, checked.is_some())?;
    self.map_paragraph_content(para, segments, images, checked)
  }

  fn map_paragraph_content(
    &mut self,
    para: &Paragraph,
    mut segments: Vec<YjsTextSegment>,
    images: Vec<(usize, String, String)>,
    checked: Option<bool>,
  ) -> Result<(), ImportError> {
    if checked.is_some() {
      while let Some(first) = segments.first_mut() {
        first.text = first.text.trim_start().to_string();
        if !first.text.is_empty() {
          break;
        }
        segments.remove(0);
      }
    }
    let resolved = self.source.styles.resolve_para(&para.props);
    let plain = segments
      .iter()
      .all(|segment| segment.text.trim().is_empty() && segment.latex.is_none());
    if plain
      && checked.is_none()
      && images.is_empty()
      && resolved.borders.as_ref().is_some_and(|borders| {
        borders.bottom.is_some_and(|border| border.is_visible())
          && borders.top.is_none()
          && borders.left.is_none()
          && borders.right.is_none()
      })
    {
      self.builder.push_divider();
      self.usable += 1;
      self.warn("border_divider_normalized");
      return Ok(());
    }
    if !plain || checked.is_some() {
      self.usable += 1;
    }
    if images.is_empty() {
      self.emit_text(
        &segments,
        resolved.numbering,
        resolved.outline_level,
        &resolved.style,
        checked,
        para.props.indent_left.unwrap_or(0.0),
      );
    } else {
      let mut start = 0;
      let mut first = true;
      for (end, key, alt) in images {
        if end > start {
          if first {
            self.emit_text(
              &segments[start..end],
              resolved.numbering,
              resolved.outline_level,
              &resolved.style,
              checked,
              para.props.indent_left.unwrap_or(0.0),
            );
          } else {
            self.builder.push_paragraph(&segments[start..end]);
          }
        }
        self.builder.push_image(&key, &alt);
        self.usable += 1;
        start = end;
        first = false;
      }
      if start < segments.len() {
        if first {
          self.emit_text(
            &segments[start..],
            resolved.numbering,
            resolved.outline_level,
            &resolved.style,
            checked,
            para.props.indent_left.unwrap_or(0.0),
          );
        } else {
          self.builder.push_paragraph(&segments[start..]);
        }
      }
      if !segments.is_empty() {
        self.warn("inline_image_structure_normalized");
      }
    }
    Ok(())
  }

  fn emit_text(
    &mut self,
    segments: &[YjsTextSegment],
    numbering: Option<wordcraft_doc::props::NumRef>,
    outline: Option<u8>,
    style: &str,
    checked: Option<bool>,
    indent: f32,
  ) {
    if let Some(checked) = checked {
      if numbering.is_some_and(|number| number.num != 0) {
        self.warn("task_numbering_normalized");
      }
      let level = numbering
        .filter(|n| n.num != 0)
        .map_or(self.relative_depth(indent), |number| number.level.min(8) as usize);
      self.builder.push_list_item(segments, false, level, Some(checked));
    } else if let Some(number) = numbering.filter(|n| n.num != 0) {
      if let Some((_, level)) = self
        .counters
        .next_label(&self.source.numbering, number.num, number.level)
      {
        if level.format == NumFormat::None {
          self.builder.push_paragraph(segments);
          return;
        }
        let ordered = level.format != NumFormat::Bullet;
        if ordered && level.format != NumFormat::Decimal {
          self.warn("numbering_style_normalized");
        }
        let order = ordered
          .then(|| {
            self
              .counters
              .values(&self.source.numbering, number.num)
              .map(|v| v[number.level.min(8) as usize] as u64)
          })
          .flatten();
        if number.level > 8 {
          self.warn("list_depth_normalized");
        }
        self
          .builder
          .push_list_item_with_order(segments, ordered, number.level.min(8) as usize, None, order);
      } else {
        self.builder.push_paragraph(segments);
      }
    } else if self.relative_depth(indent) > 0 {
      let parent = self
        .builder
        .parent_at_list_depth(self.relative_depth(indent))
        .map(str::to_owned);
      if matches!(style, "Quote" | "IntenseQuote") {
        self.builder.push_quote_under(segments, parent.as_deref());
      } else {
        self.builder.push_paragraph_typed_under(
          segments,
          outline.filter(|level| *level < 6).map(|level| level + 1),
          parent.as_deref(),
        );
      }
    } else if let Some(level) = outline.filter(|level| *level < 6) {
      self.builder.push_heading(level + 1, segments);
    } else if matches!(style, "Quote" | "IntenseQuote") {
      self.builder.push_quote(segments);
    } else {
      if outline.is_some_and(|level| level >= 6) {
        self.warn("heading_level_normalized");
      }
      self.builder.push_paragraph(segments);
    }
  }

  fn segments(&mut self, para: &Paragraph) -> Result<(Vec<YjsTextSegment>, Vec<(usize, String, String)>), ImportError> {
    self.segments_with_task(para, false)
  }

  fn segments_with_task(
    &mut self,
    para: &Paragraph,
    task: bool,
  ) -> Result<(Vec<YjsTextSegment>, Vec<(usize, String, String)>), ImportError> {
    let mut result = Vec::new();
    let mut pictures = Vec::new();
    let mut checkbox_depth = 0usize;
    for (range, props) in para.run_ranges() {
      let resolved = self.source.styles.resolve_char(para.props.style.as_deref(), props);
      if resolved.del.is_some() || resolved.hidden {
        continue;
      }
      if resolved
        .link
        .as_ref()
        .is_some_and(|link| !url::Url::parse(link).is_ok_and(|url| matches!(url.scheme(), "https" | "http" | "mailto")))
      {
        self.warn("link_destination_normalized");
      }
      let Some(text) = para.text.get(range.clone()) else {
        self.warn("invalid_run_omitted");
        continue;
      };
      let mut start = 0;
      for (offset, character) in text.char_indices() {
        if character != wordcraft_doc::para::OBJ {
          continue;
        }
        if offset > start && checkbox_depth == 0 {
          result.push(Self::segment(&text[start..offset], &resolved));
        }
        let absolute = range.start + offset;
        if checkbox_depth > 0 {
          match para.object_at(absolute) {
            Some(InlineObject::ControlStart { .. }) => checkbox_depth += 1,
            Some(InlineObject::ControlEnd) => checkbox_depth -= 1,
            _ => {}
          }
          start = offset + character.len_utf8();
          continue;
        }
        match para.object_at(absolute) {
          Some(InlineObject::BookmarkStart { .. } | InlineObject::BookmarkEnd { .. }) => {}
          Some(InlineObject::CommentEnd { id }) if self.current_note.is_none() => {
            if let Some((definition, label, _)) = self
              .source
              .comments
              .get(id)
              .and_then(|comment| self.notes.get(&comment.part))
            {
              let mut segment = YjsTextSegment::plain(" ");
              segment.footnote = Some(serde_json::json!({"label":label,"definitionId":definition}));
              result.push(segment);
            } else {
              self.warn("missing_comment_omitted");
            }
          }
          Some(InlineObject::Equation { math, linear, display }) => {
            if let Some(source) = math::to_latex(math) {
              let mut segment = YjsTextSegment::plain(" ");
              segment.latex = Some(source);
              result.push(segment);
              if *display {
                self.warn("formula_placement_normalized");
              }
            } else if !linear.trim().is_empty() {
              result.push(YjsTextSegment::plain(format!("[Formula: {linear}]")));
              self.warn("formula_structure_normalized");
            } else {
              self.warn("formula_omitted");
            }
          }
          Some(InlineObject::Field { instr, .. })
            if self.current_note.is_none()
              && note_field_target(instr)
                .and_then(|name| self.note_bookmarks.get(name))
                .is_some_and(|id| self.notes.contains_key(id)) =>
          {
            let id = self.note_bookmarks[note_field_target(instr).expect("matched note field")];
            let (definition, label, _) = &self.notes[&id];
            let mut segment = YjsTextSegment::plain(" ");
            segment.footnote = Some(serde_json::json!({"label": label, "definitionId": definition}));
            result.push(segment);
          }
          Some(InlineObject::NoteRef { id, kind, custom }) => {
            // Word writes the note's own number as a self-reference in its body.
            // It is decoration, not a second native anchor or a nested note.
            if self.current_note == Some(*id) {
            } else if self.current_note.is_none() {
              if let Some((definition, label, _)) = self.notes.get(id).filter(|(_, _, placement)| {
                (*placement == yjs::footnote::FootnotePlacement::Footnote)
                  == (*kind == wordcraft_doc::para::NoteKind::Footnote)
              }) {
                let mut segment = YjsTextSegment::plain(" ");
                segment.footnote = Some(serde_json::json!({"label": label, "definitionId": definition}));
                result.push(segment);
                if !custom.is_empty() {
                  self.warn("note_numbering_normalized");
                }
              } else {
                result.push(YjsTextSegment::plain("[Note]"));
                self.warn("missing_note_normalized");
              }
            } else {
              result.push(YjsTextSegment::plain("[Note]"));
              self.warn("nested_note_normalized");
            }
          }
          Some(InlineObject::Image { media, alt, ole, .. }) => {
            if ole.is_some() {
              self.warn("embedded_object_normalized");
            }
            // Repeated drawing references reuse validated bytes. Without this
            // lookup a tiny document with many anchors can force repeated full
            // raster decodes of the same compressed picture.
            if let Some(key) = self.media_keys.get(media) {
              pictures.push((result.len(), key.clone(), alt.clone()));
              start = offset + character.len_utf8();
              continue;
            }
            if let Some(bytes) = self.source.media.get(media) {
              let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                Some(("image/png", "png"))
              } else if bytes.starts_with(b"\xff\xd8\xff") {
                Some(("image/jpeg", "jpg"))
              } else {
                None
              };
              if let Some((mime, ext)) = mime {
                let mut reader = image::ImageReader::new(Cursor::new(bytes.as_ref()));
                reader.set_format(if ext == "png" {
                  image::ImageFormat::Png
                } else {
                  image::ImageFormat::Jpeg
                });
                let mut limits = image::Limits::default();
                limits.max_image_width = Some(8192);
                limits.max_image_height = Some(8192);
                limits.max_alloc = Some(64 * 1024 * 1024);
                reader.limits(limits);
                if reader.decode().is_err() {
                  if !alt.is_empty() {
                    result.push(YjsTextSegment::plain(format!("[Image: {alt}]")));
                  }
                  self.warn("unreadable_image_omitted");
                  start = offset + character.len_utf8();
                  continue;
                }
                let checksum = format!("{:x}", Sha256::digest(bytes.as_ref()));
                let key = format!("docx-import/{checksum}.{ext}");
                if !self.assets.contains_key(&key) {
                  self.asset_bytes = self
                    .asset_bytes
                    .checked_add(bytes.len() as u64)
                    .ok_or(ImportError::TooLarge)?;
                  if self.assets.len() >= self.max_assets || self.asset_bytes > self.max_asset_bytes {
                    return Err(ImportError::TooLarge);
                  }
                  self.assets.insert(
                    key.clone(),
                    Asset {
                      bytes: Bytes::copy_from_slice(bytes),
                      key: key.clone(),
                      mime,
                      checksum,
                    },
                  );
                }
                self.media_keys.insert(media.clone(), key.clone());
                pictures.push((result.len(), key, alt.clone()));
              } else {
                if !alt.is_empty() {
                  result.push(YjsTextSegment::plain(format!("[Image: {alt}]")));
                }
                self.warn("unsupported_image_omitted");
              }
            } else {
              if !alt.is_empty() {
                result.push(YjsTextSegment::plain(format!("[Image: {alt}]")));
              }
              self.warn("missing_image_omitted");
            }
          }
          Some(InlineObject::Graphic { alt, .. }) => {
            if !alt.is_empty() {
              result.push(YjsTextSegment::plain(format!("[Diagram: {alt}]")));
            }
            self.warn("diagram_normalized");
          }
          Some(InlineObject::ControlStart { control }) => {
            if let wordcraft_doc::ControlKind::CheckBox { checked, .. } = control.kind {
              if !task {
                result.push(YjsTextSegment::plain(if checked { "[x]" } else { "[ ]" }));
                self.warn("checkbox_normalized");
              }
              checkbox_depth = 1;
            }
          }
          Some(
            InlineObject::ControlEnd
            | InlineObject::CommentStart { .. }
            | InlineObject::CommentEnd { .. }
            | InlineObject::FieldStart { .. }
            | InlineObject::FieldEnd,
          ) => {}
          Some(other) => {
            let label = other.plain_text();
            if !label.is_empty() {
              result.push(YjsTextSegment::plain(label));
              self.warn("inline_object_normalized");
            } else {
              self.warn("inline_object_omitted");
            }
          }
          None => self.warn("missing_inline_object_omitted"),
        }
        start = offset + character.len_utf8();
      }
      if start < text.len() && checkbox_depth == 0 {
        result.push(Self::segment(&text[start..], &resolved));
      }
    }
    if checkbox_depth > 0 {
      self.warn("checkbox_body_omitted");
    }
    Ok((result, pictures))
  }
}

fn block_indent(block: &Block) -> f32 {
  let value = match block {
    Block::Para(paragraph) => paragraph.props.indent_left,
    Block::Table(table) => table.props.indent,
  }
  .unwrap_or(0.0);
  if value.is_finite() { value.max(0.0) } else { 0.0 }
}

/// Only a leading, balanced, single checkbox becomes a Task. Inline form
/// controls in prose/tables retain a labelled checked-state normalization.
fn leading_checkbox(source: &Document, paragraph: &Paragraph) -> Option<bool> {
  let (offset, object) = paragraph.objects_with_offsets().next()?;
  let InlineObject::ControlStart { control } = object else {
    return None;
  };
  let wordcraft_doc::ControlKind::CheckBox { checked, .. } = control.kind else {
    return None;
  };
  if !paragraph.text[..offset].trim().is_empty() {
    return None;
  }
  let (_, props) = paragraph.run_ranges().find(|(range, _)| range.contains(&offset))?;
  let props = source.styles.resolve_char(paragraph.props.style.as_deref(), props);
  if props.hidden || props.del.is_some() {
    return None;
  }
  if paragraph.objects.iter().filter(|object| matches!(object, InlineObject::ControlStart { control } if matches!(control.kind, wordcraft_doc::ControlKind::CheckBox { .. }))).count() != 1 { return None; }
  let mut depth = 0usize;
  for object in &paragraph.objects {
    match object {
      InlineObject::ControlStart { .. } => depth += 1,
      InlineObject::ControlEnd if depth > 0 => {
        depth -= 1;
        if depth == 0 {
          return Some(checked);
        }
      }
      _ => {}
    }
  }
  None
}

fn note_field_target(instruction: &str) -> Option<&str> {
  let mut words = instruction.split_ascii_whitespace();
  let kind = words.next()?;
  if !kind.eq_ignore_ascii_case("NOTEREF") && !kind.eq_ignore_ascii_case("REF") {
    return None;
  }
  let name = words.next()?.trim_matches('"');
  (!name.is_empty()
    && name
      .chars()
      .all(|character| character.is_alphanumeric() || character == '_'))
  .then_some(name)
}

#[cfg(test)]
mod tests {
  use super::*;
  use image::{DynamicImage, ImageFormat};
  use std::{io::Cursor, sync::Arc};
  use wordcraft_doc::{
    Cell, CharProps, Paragraph, Row, Table,
    numbering::ListKind,
    para_block,
    props::{Border, Borders, NumRef},
  };
  use yrs::{Doc as YDoc, Map, ReadTxn, Transact, Update, updates::decoder::Decode};

  #[test]
  fn imported_word_content_is_an_editable_page_with_the_original_title_and_number() {
    let mut document = Document::new();
    document.core.title = "Canonical title".into();
    let mut heading = Paragraph::with_text("Leading heading", CharProps::default()).styled("Heading1");
    heading
      .insert_text(
        heading.text.len(),
        " intact",
        &CharProps {
          bold: Some(true),
          underline: Some(wordcraft_doc::props::Underline::Single),
          ..Default::default()
        },
      )
      .unwrap();
    let num = Arc::make_mut(&mut document.numbering).add_list(ListKind::Numbered);
    Arc::make_mut(&mut document.numbering).abstracts[0].levels[0].start = 4;
    let mut item = Paragraph::with_text("Nested entry", CharProps::default());
    item.props.numbering = Some(NumRef { num, level: 0 });
    document.body = vec![para_block(heading), para_block(item)];
    let bytes = wordcraft_docx::write(&document).expect("write real Word package");
    let imported = prepare_docx(&bytes, "fallback.docx").expect("import Word document");
    assert_eq!(imported.title, "Canonical title");
    let extracted = yjs::extract_text_from_yjs(&imported.snapshot).expect("extract native page");
    assert_eq!(extracted.title.as_deref(), Some("Canonical title"));
    assert!(extracted.markdown.contains("Leading heading"));
    assert!(extracted.markdown.contains("intact"));
    assert!(extracted.markdown.contains("Nested entry"));
    let fragment = crate::doc::document_fragment_from_yjs(&imported.snapshot).expect("native fragment");
    assert!(matches!(
      fragment.blocks.first(),
      Some(crate::doc::DocumentFragmentBlock::Heading { level: 1, .. })
    ));
    assert!(matches!(
      fragment.blocks.get(1),
      Some(crate::doc::DocumentFragmentBlock::ListItem { .. })
    ));
    let ydoc = YDoc::new();
    ydoc
      .transact_mut()
      .apply_update(Update::decode_v1(&imported.snapshot).unwrap())
      .unwrap();
    let txn = ydoc.transact();
    let blocks = txn.get_map("blocks").unwrap();
    assert!(blocks.iter(&txn).any(|(_, block)| match block {
      yrs::Out::YMap(block) => matches!(block.get(&txn, "prop:order"), Some(yrs::Out::Any(yrs::Any::Number(value))) if value.as_f64() == Some(4.0)),
      _ => false,
    }));
    let exported = super::export::encode_test_snapshot(&imported.snapshot, &imported.assets);
    let word = wordcraft_docx::read(&exported.bytes).expect("exported package is readable Word");
    assert_eq!(word.core.title, "Canonical title");
    let Block::Para(heading) = &*word.body[0] else {
      panic!("heading paragraph");
    };
    assert_eq!(word.styles.resolve_para(&heading.props).outline_level, Some(0));
    assert!(
      heading
        .run_ranges()
        .any(|(_, props)| props.bold == Some(true) && props.underline == Some(wordcraft_doc::props::Underline::Single))
    );
    assert_eq!(
      word
        .styles
        .resolve_char(heading.props.style.as_deref(), &CharProps::default())
        .font,
      "Test Heading"
    );
    let Block::Para(item) = &*word.body[1] else {
      panic!("list paragraph");
    };
    let number = word.styles.resolve_para(&item.props).numbering.unwrap();
    let mut counters = Counters::default();
    assert_eq!(
      counters
        .next_label(&word.numbering, number.num, number.level)
        .unwrap()
        .0,
      "4."
    );
  }

  #[test]
  fn empty_or_non_word_input_is_not_a_successful_document() {
    assert!(matches!(
      prepare_docx(b"not a Word document", "wrong.docx"),
      Err(ImportError::Invalid)
    ));
    let blank = wordcraft_docx::write(&Document::new()).expect("write empty Word document");
    assert!(matches!(prepare_docx(&blank, "blank.docx"), Err(ImportError::Empty)));
  }

  #[test]
  fn local_word_notes_keep_rich_bodies_placement_and_repeated_anchor_identity() {
    let mut document = Document::new();
    document.core.title = "Local Word notes".into();
    document.settings.endnote_format = NumFormat::Decimal;
    let mut table = Table::default();
    let mut cell = Cell::empty();
    cell.blocks = vec![para_block(Paragraph::with_text(
      "Note table cell",
      CharProps {
        italic: Some(true),
        ..Default::default()
      },
    ))];
    table.rows.push(Row {
      cells: vec![cell],
      ..Default::default()
    });
    table.grid = vec![200.0];
    let note_list = Arc::make_mut(&mut document.numbering).add_list(ListKind::Bullet);
    let mut first_item = Paragraph::with_text("First note list item", CharProps::default());
    first_item.props.numbering = Some(NumRef {
      num: note_list,
      level: 0,
    });
    let mut second_item = Paragraph::with_text("Second note list item", CharProps::default());
    second_item.props.numbering = Some(NumRef {
      num: note_list,
      level: 0,
    });
    let foot = document.add_part(
      wordcraft_doc::PartKind::Footnote,
      vec![
        para_block(Paragraph::with_text(
          "Rich footnote body",
          CharProps {
            bold: Some(true),
            ..Default::default()
          },
        )),
        Arc::new(Block::Table(table)),
        para_block(first_item),
        para_block(second_item),
      ],
    );
    let end = document.add_part(
      wordcraft_doc::PartKind::Endnote,
      vec![para_block(Paragraph::with_text(
        "Linked endnote body",
        CharProps {
          link: Some("https://example.com/notes".into()),
          ..Default::default()
        },
      ))],
    );
    let hidden = document.add_part(
      wordcraft_doc::PartKind::Footnote,
      vec![para_block(Paragraph::with_text(
        "Hidden note must not reappear",
        CharProps::default(),
      ))],
    );
    let mut paragraph = Paragraph::with_text("Before notes ", CharProps::default());
    for (index, (id, kind)) in [
      (foot, wordcraft_doc::para::NoteKind::Footnote),
      (foot, wordcraft_doc::para::NoteKind::Footnote),
      (end, wordcraft_doc::para::NoteKind::Endnote),
    ]
    .into_iter()
    .enumerate()
    {
      if index == 0 {
        paragraph
          .insert_object(
            paragraph.text.len(),
            InlineObject::BookmarkStart {
              name: "SourceFootnote".into(),
            },
            &CharProps::default(),
          )
          .unwrap();
      }
      paragraph
        .insert_object(
          paragraph.text.len(),
          InlineObject::NoteRef {
            id,
            kind,
            custom: String::new(),
          },
          &CharProps::default(),
        )
        .unwrap();
      if index == 0 {
        paragraph
          .insert_object(
            paragraph.text.len(),
            InlineObject::BookmarkEnd {
              name: "SourceFootnote".into(),
            },
            &CharProps::default(),
          )
          .unwrap();
      }
      if index > 0 {
        paragraph
          .insert_text(paragraph.text.len(), " after ", &CharProps::default())
          .unwrap();
      }
    }
    paragraph
      .insert_object(
        paragraph.text.len(),
        InlineObject::Field {
          instr: "REF SourceFootnote \\h".into(),
          result: "1".into(),
          locked: false,
          dirty: false,
          code: false,
          form: String::new(),
        },
        &CharProps::default(),
      )
      .unwrap();
    paragraph
      .insert_object(
        paragraph.text.len(),
        InlineObject::NoteRef {
          id: hidden,
          kind: wordcraft_doc::para::NoteKind::Footnote,
          custom: String::new(),
        },
        &CharProps {
          hidden: Some(true),
          ..Default::default()
        },
      )
      .unwrap();
    document.body = vec![para_block(paragraph)];
    let imported = prepare_docx(&wordcraft_docx::write(&document).unwrap(), "notes.docx").unwrap();
    let native_notes = |snapshot: &[u8]| {
      let ir =
        crate::doc::content_projection::project_snapshot_for_export(Uuid::new_v4(), Uuid::new_v4(), "Notes", snapshot)
          .unwrap();
      let definitions = ir
        .document
        .blocks
        .iter()
        .filter_map(|block| match block {
          myoxus_public_render::Block::FootnoteDefinition {
            block_id,
            placement,
            number,
            ..
          } => Some((block_id.clone(), (*placement, *number))),
          _ => None,
        })
        .collect::<BTreeMap<_, _>>();
      let references = ir
        .native_text
        .values()
        .flat_map(|block| &block.fields)
        .flat_map(|field| &field.spans)
        .filter_map(|span| {
          Some((
            span.footnote.as_ref()?.definition_id.clone()?,
            span.text.as_ref().map_or(1, |text| text.chars().count()),
          ))
        })
        .fold(BTreeMap::new(), |mut counts, (id, count)| {
          *counts.entry(id).or_insert(0usize) += count;
          counts
        });
      assert_eq!(definitions.len(), 2);
      assert_eq!(references.len(), 2);
      for (id, count) in references {
        let (placement, number) = definitions[&id];
        assert_eq!(number, Some(1));
        assert_eq!(
          count,
          if placement == Some(yjs::footnote::FootnotePlacement::Footnote) {
            3
          } else {
            1
          }
        );
      }
    };
    native_notes(&imported.snapshot);
    let exported = super::export::encode_test_snapshot(&imported.snapshot, &imported.assets);
    assert!(
      !exported
        .warnings
        .iter()
        .any(|warning| warning.code.starts_with("footnote_"))
    );
    let word = wordcraft_docx::read(&exported.bytes).unwrap();
    assert_eq!(word.last_section.endnote_pr.num_fmt, Some(NumFormat::Decimal));
    assert_eq!(
      word
        .parts
        .values()
        .filter(|part| part.kind == wordcraft_doc::PartKind::Footnote)
        .count(),
      1
    );
    assert_eq!(
      word
        .parts
        .values()
        .filter(|part| part.kind == wordcraft_doc::PartKind::Endnote)
        .count(),
      1
    );
    let Block::Para(paragraph) = &*word.body[0] else {
      panic!("Main note anchors")
    };
    let refs = paragraph
      .objects
      .iter()
      .filter_map(|object| match object {
        InlineObject::NoteRef { id, kind, .. } => Some((*id, *kind)),
        _ => None,
      })
      .collect::<Vec<_>>();
    assert_eq!(refs.len(), 2);
    assert_ne!(refs[0], refs[1]);
    assert_eq!(paragraph.objects.iter().filter(|object| matches!(object, InlineObject::Field { instr, result, .. } if instr.starts_with("NOTEREF ") && result == "1")).count(), 2);
    let foot = &word.parts[&refs[0].0];
    let note_lists = foot
      .blocks
      .iter()
      .filter_map(|block| match &**block {
        Block::Para(paragraph) => paragraph.props.numbering,
        _ => None,
      })
      .collect::<Vec<_>>();
    assert_eq!(note_lists.len(), 2);
    assert!(note_lists.iter().all(|number| number.level == 0));
    let Block::Para(body) = &*foot.blocks[0] else {
      panic!("Rich note paragraph")
    };
    assert!(body.text.contains("Rich footnote body"));
    assert!(body.run_ranges().any(|(_, props)| props.bold == Some(true)));
    assert!(foot.blocks.iter().any(|block| matches!(&**block, Block::Table(table) if table.rows[0].cells[0].blocks.iter().any(|block| matches!(&**block, Block::Para(p) if p.text.contains("Note table cell"))))));
    let end = &word.parts[&refs[1].0];
    assert!(end.blocks.iter().any(|block| matches!(&**block, Block::Para(p) if p.run_ranges().any(|(_, props)| props.link.as_deref() == Some("https://example.com/notes")))));
    let again = prepare_docx(&exported.bytes, "again.docx").unwrap();
    native_notes(&again.snapshot);
    assert!(
      !yjs::extract_text_from_yjs(&again.snapshot)
        .unwrap()
        .markdown
        .contains("Hidden note must not reappear")
    );
  }

  #[test]
  fn named_word_styles_and_checkbox_controls_keep_native_body_hierarchy() {
    use myoxus_public_render::{Block as NativeBlock, PublicListKind};
    let mut builder = YjsDocumentBuilder::new("Structured bodies");
    builder.push_list_item(&[YjsTextSegment::plain("Checked task")], false, 0, Some(true));
    builder.push_list_item(&[YjsTextSegment::plain("Nested pending task")], false, 1, Some(false));
    builder.push_list_item(&[YjsTextSegment::plain("Sibling pending task")], false, 0, Some(false));
    let id = builder.push_callout_under("warning", "", true, true, None);
    let mut rich_body = YjsTextSegment::plain("Rich callout");
    rich_body.bold = true;
    builder.set_container_body(&id, &[rich_body]);
    let context = builder.enter_content_parent(id);
    let mut rich_child = YjsTextSegment::plain("First child");
    rich_child.italic = true;
    builder.push_paragraph(&[rich_child]);
    let code = "let x = 1;\nprintln!(\"{x}\");\n";
    builder.push_code("rust", code);
    let nested = builder.push_callout_under("note", "", false, true, None);
    builder.set_container_body(&nested, &[YjsTextSegment::plain("Nested note")]);
    let nested_context = builder.enter_content_parent(nested);
    builder.push_paragraph(&[YjsTextSegment::plain("Nested child")]);
    builder.restore_content_parent(nested_context);
    builder.push_table_with_header_rows(&[vec![vec![YjsTextSegment::plain("Cell under callout")]]], 0);
    builder.push_list_item(&[YjsTextSegment::plain("Callout task")], false, 0, Some(false));
    builder.push_paragraph(&[YjsTextSegment::plain("Last child")]);
    builder.restore_content_parent(context);
    builder.push_paragraph(&[YjsTextSegment::plain("After callout")]);
    let exported = super::export::encode_test_snapshot(&builder.encode(), &[]);
    assert!(
      exported
        .warnings
        .iter()
        .any(|warning| warning.code == "code_language_normalized")
    );
    assert!(
      exported
        .warnings
        .iter()
        .any(|warning| warning.code == "callout_variant_normalized")
    );
    let mut word = wordcraft_docx::read(&exported.bytes).unwrap();
    assert_eq!(word.body.iter().filter_map(|block| match &**block { Block::Para(p) => Some(p), _ => None })
      .flat_map(|p| &p.objects).filter(|object| matches!(object, InlineObject::ControlStart { control } if matches!(control.kind, wordcraft_doc::ControlKind::CheckBox { .. }))).count(), 4);
    assert!(word.body.iter().any(
      |block| matches!(&**block, Block::Para(p) if p.props.style.as_deref() == Some("MyoxusCode") && p.final_text() == code)
    ));
    assert_eq!(
      word
        .body
        .iter()
        .filter(|block| matches!(&***block, Block::Para(p) if p.props.style.as_deref() == Some("MyoxusCallout")))
        .count(),
      2
    );
    Arc::make_mut(&mut word.styles).styles.push(wordcraft_doc::Style {
      id: "ForeignCode".into(),
      name: "Foreign code style".into(),
      based_on: Some("MyoxusCode".into()),
      ..Default::default()
    });
    word.body.push(para_block(
      Paragraph::with_text("Ordinary custom style", CharProps::default()).styled("ForeignCode"),
    ));
    let imported = prepare_docx(&wordcraft_docx::write(&word).unwrap(), "structured.docx").unwrap();
    assert!(
      !imported
        .warnings
        .iter()
        .any(|warning| warning.code == "checkbox_normalized")
    );
    let ir = crate::doc::content_projection::project_snapshot_for_export(
      Uuid::new_v4(),
      Uuid::new_v4(),
      "Structured bodies",
      &imported.snapshot,
    )
    .unwrap();
    let NativeBlock::List { list, .. } = &ir.document.blocks[0] else {
      panic!("Tasks must stay a native list");
    };
    assert_eq!(list.kind, PublicListKind::Todo);
    assert_eq!(list.items.len(), 2);
    assert_eq!(list.items[0].todo_checked, Some(true));
    assert_eq!(list.items[1].todo_checked, Some(false));
    let NativeBlock::List { list: nested, .. } = &list.items[0].children[0] else {
      panic!("Nested native task");
    };
    assert_eq!(nested.items.len(), 1);
    assert_eq!(nested.items[0].todo_checked, Some(false));
    let NativeBlock::Callout { text, children, .. } = &ir.document.blocks[1] else {
      panic!("Native callout");
    };
    assert!(text.iter().any(|part| part.text == "Rich callout" && part.bold));
    assert_eq!(children.len(), 6);
    assert!(
      matches!(&children[0], NativeBlock::Paragraph { text, .. } if text.iter().any(|part| part.text == "First child" && part.italic))
    );
    assert!(matches!(&children[1], NativeBlock::Code { text, .. } if text == code));
    assert!(matches!(&children[2], NativeBlock::Callout { children, .. } if children.len() == 1));
    assert!(matches!(&children[3], NativeBlock::Table { rows, .. } if rows.len() == 1));
    assert!(matches!(&children[4], NativeBlock::List { list, .. } if list.items[0].todo_checked == Some(false)));
    assert!(
      matches!(&children[5], NativeBlock::Paragraph { text, .. } if text.iter().any(|part| part.text == "Last child"))
    );
    assert!(
      matches!(&ir.document.blocks[2], NativeBlock::Paragraph { text, .. } if text.iter().any(|part| part.text == "After callout"))
    );
    assert!(
      matches!(&ir.document.blocks[3], NativeBlock::Paragraph { text, .. } if text.iter().any(|part| part.text == "Ordinary custom style"))
    );
  }

  #[test]
  fn word_math_roundtrip_keeps_structure_placement_and_complete_limit_fallback() {
    use myoxus_public_render::Block as NativeBlock;
    let inline = r"\frac{x^{2}+1}{\sqrt{y}}";
    let display = r"\sum_{i=1}^{n} i=\frac{n(n+1)}{2}";
    let mut builder = YjsDocumentBuilder::new("Equations");
    let mut marker = YjsTextSegment::plain(" ");
    marker.latex = Some(inline.into());
    builder.push_paragraph(&[
      YjsTextSegment::plain("Before "),
      marker.clone(),
      marker,
      YjsTextSegment::plain(" after"),
    ]);
    builder.push_latex_under(display, None);
    let limited = format!("{}tail-not-to-be-truncated", "x".repeat(9000));
    builder.push_latex_under(&limited, None);
    let exported = super::export::encode_test_snapshot(&builder.encode(), &[]);
    assert_eq!(
      exported
        .warnings
        .iter()
        .find(|warning| warning.code == "formula_structure_normalized")
        .unwrap()
        .count,
      1
    );
    let word = wordcraft_docx::read(&exported.bytes).unwrap();
    let equations = word
      .body
      .iter()
      .filter_map(|block| match &**block {
        Block::Para(paragraph) => Some(paragraph),
        _ => None,
      })
      .flat_map(|paragraph| &paragraph.objects)
      .filter_map(|object| match object {
        InlineObject::Equation { math, display, .. } => Some((math, *display)),
        _ => None,
      })
      .collect::<Vec<_>>();
    assert_eq!(equations.len(), 3);
    assert_eq!(
      equations.iter().map(|(_, display)| *display).collect::<Vec<_>>(),
      vec![false, false, true]
    );
    assert_eq!(
      wordcraft_doc::math_latex::to_latex(&equations[0].0.nodes),
      wordcraft_doc::math_latex::to_latex(&math::from_latex(inline).unwrap().nodes)
    );
    let imported = prepare_docx(&exported.bytes, "equations.docx").unwrap();
    let ir = crate::doc::content_projection::project_snapshot_for_export(
      Uuid::new_v4(),
      Uuid::new_v4(),
      "Equations",
      &imported.snapshot,
    )
    .unwrap();
    assert!(
      matches!(&ir.document.blocks[1], NativeBlock::Code { native_latex: true, text, .. } if math::from_latex(text).unwrap().nodes == math::from_latex(display).unwrap().nodes)
    );
    let field = ir
      .native_text
      .values()
      .flat_map(|block| &block.fields)
      .find(|field| field.spans.iter().any(|span| span.latex.is_some()))
      .unwrap();
    assert_eq!(
      field
        .spans
        .iter()
        .filter(|span| span.latex.is_some())
        .map(|span| span.text.as_ref().unwrap().chars().count())
        .sum::<usize>(),
      2
    );
    assert!(field.spans.iter().any(|span| span.text.as_deref() == Some("Before ")));
    assert!(field.spans.iter().any(|span| span.text.as_deref() == Some(" after")));
    assert!(
      yjs::extract_text_from_yjs(&imported.snapshot)
        .unwrap()
        .markdown
        .contains(&limited)
    );
    assert!(math::from_latex(&format!("{}x{}", "\\sqrt{".repeat(30), "}".repeat(30))).is_none());

    // An ordinary Word display object may occur between rich text runs.
    let mut paragraph = Paragraph::with_text(
      "Prefix ",
      CharProps {
        bold: Some(true),
        ..Default::default()
      },
    );
    paragraph
      .insert_object(
        paragraph.text.len(),
        InlineObject::Equation {
          linear: "x^2".into(),
          display: true,
          math: math::from_latex("x^2").unwrap(),
        },
        &CharProps::default(),
      )
      .unwrap();
    paragraph
      .insert_text(paragraph.text.len(), " suffix", &CharProps::default())
      .unwrap();
    let mut document = Document::default();
    document.body = vec![para_block(paragraph)];
    let imported = prepare_docx(&wordcraft_docx::write(&document).unwrap(), "display-between-text.docx").unwrap();
    let ir = crate::doc::content_projection::project_snapshot_for_export(
      Uuid::new_v4(),
      Uuid::new_v4(),
      "Equations",
      &imported.snapshot,
    )
    .unwrap();
    assert!(
      matches!(&ir.document.blocks[0], NativeBlock::Paragraph { text, .. } if text.iter().any(|run| run.text == "Prefix " && run.bold))
    );
    assert!(matches!(
      &ir.document.blocks[1],
      NativeBlock::Code { native_latex: true, .. }
    ));
    assert!(
      matches!(&ir.document.blocks[2], NativeBlock::Paragraph { text, .. } if text.iter().any(|run| run.text == " suffix"))
    );
    let mut formula_only = Paragraph::new();
    formula_only
      .insert_object(
        0,
        InlineObject::Equation {
          linear: "x^2".into(),
          display: false,
          math: math::from_latex("x^2").unwrap(),
        },
        &CharProps::default(),
      )
      .unwrap();
    document.body = vec![para_block(formula_only)];
    assert!(prepare_docx(&wordcraft_docx::write(&document).unwrap(), "formula-only.docx").is_ok());
  }

  #[test]
  fn rich_annotations_and_word_comments_become_ordered_labelled_notes_without_threads() {
    let mut builder = YjsDocumentBuilder::new("Annotation bodies");
    let note = builder.reserve_footnote_definition("existing");
    let mut bold = YjsTextSegment::plain("Complete bold ");
    bold.annotation = Some("same-native-identity".into());
    bold.bold = true;
    let mut italic = YjsTextSegment::plain("and italic linked body");
    italic.annotation = bold.annotation.clone();
    italic.italic = true;
    italic.link = Some("https://example.org/source".into());
    let mut marker = YjsTextSegment::plain(" ");
    marker.footnote = Some(serde_json::json!({"label":"existing","definitionId":note}));
    let mut separated = YjsTextSegment::plain("Separated body");
    separated.annotation = bold.annotation.clone();
    builder.push_paragraph(&[
      YjsTextSegment::plain("Before "),
      bold,
      italic,
      YjsTextSegment::plain(" between "),
      marker.clone(),
      YjsTextSegment::plain(" repeated "),
      marker,
      separated,
      YjsTextSegment::plain(" after"),
    ]);
    builder
      .begin_footnote_body(&note, yjs::footnote::FootnotePlacement::Footnote)
      .unwrap();
    builder.push_paragraph(&[YjsTextSegment::plain("Existing ordinary footnote")]);
    builder.end_footnote_body();
    let exported = super::export::encode_test_snapshot(&builder.encode(), &[]);
    assert_eq!(
      exported
        .warnings
        .iter()
        .find(|warning| warning.code == "annotation_note_normalized")
        .unwrap()
        .count,
      2
    );
    let mut word = wordcraft_docx::read(&exported.bytes).unwrap();
    assert!(word.comments.is_empty());
    let Block::Para(paragraph) = &*word.body[0] else {
      panic!("Main paragraph");
    };
    assert!(!paragraph.final_text().contains("Complete bold"));
    let note_ids = paragraph
      .objects
      .iter()
      .filter_map(|object| match object {
        InlineObject::NoteRef { id, .. } => Some(*id),
        _ => None,
      })
      .collect::<Vec<_>>();
    assert_eq!(note_ids.len(), 3);
    assert!(paragraph.objects.iter().any(
      |object| matches!(object, InlineObject::Field {instr,result,..} if instr.starts_with("NOTEREF ") && result == "2")
    ));
    let body = &word.parts[&note_ids[0]];
    let Block::Para(body) = &*body.blocks[0] else {
      panic!("Rich note body");
    };
    assert_eq!(body.final_text(), "Complete bold and italic linked body");
    assert!(body.runs.iter().any(|run| run.props.bold == Some(true)));
    assert!(
      body
        .runs
        .iter()
        .any(|run| run.props.italic == Some(true) && run.props.link.as_deref() == Some("https://example.org/source"))
    );
    // Comment IDs and part IDs are separate namespaces; never assume equality.
    let part = word.add_part(
      wordcraft_doc::PartKind::Comment,
      vec![para_block(Paragraph::with_text(
        "Rich Word comment",
        CharProps {
          underline: Some(wordcraft_doc::props::Underline::Single),
          ..Default::default()
        },
      ))],
    );
    word.comments.insert(
      901,
      wordcraft_doc::Comment {
        part,
        author: "Historical author, not a user".into(),
        ..Default::default()
      },
    );
    let mut anchor = Paragraph::with_text("Commented text", CharProps::default());
    anchor
      .insert_object(0, InlineObject::CommentStart { id: 901 }, &CharProps::default())
      .unwrap();
    anchor
      .insert_object(
        anchor.text.len(),
        InlineObject::CommentEnd { id: 901 },
        &CharProps::default(),
      )
      .unwrap();
    word.body.push(para_block(anchor));
    let imported = prepare_docx(&wordcraft_docx::write(&word).unwrap(), "notes-and-comment.docx").unwrap();
    assert_eq!(
      imported
        .warnings
        .iter()
        .find(|warning| warning.code == "comment_note_normalized")
        .unwrap()
        .count,
      1
    );
    let ir = crate::doc::content_projection::project_snapshot_for_export(
      Uuid::new_v4(),
      Uuid::new_v4(),
      "Annotation bodies",
      &imported.snapshot,
    )
    .unwrap();
    let definitions = ir
      .native_text
      .values()
      .filter(|block| block.kind == "myoxus:footnote-definition")
      .count();
    assert_eq!(definitions, 4);
    let all = ir
      .native_text
      .values()
      .flat_map(|block| &block.fields)
      .flat_map(|field| &field.spans)
      .collect::<Vec<_>>();
    assert!(
      all
        .iter()
        .any(|span| span.text.as_deref() == Some("Complete bold ") && span.bold)
    );
    assert!(
      all
        .iter()
        .any(|span| span.text.as_deref() == Some("and italic linked body")
          && span.italic
          && span.link.as_deref() == Some("https://example.org/source"))
    );
    assert!(all.iter().any(|span| span.text.as_deref() == Some("[Word comment]")));
    assert!(
      all
        .iter()
        .any(|span| span.text.as_deref() == Some("Rich Word comment") && span.underline)
    );
    assert!(!all.iter().any(|span| {
      span
        .text
        .as_ref()
        .is_some_and(|text| text.contains("Historical author"))
        || span.annotation_id.is_some()
    }));
  }

  #[test]
  fn bookmark_links_bind_new_native_targets_and_reference_labels_require_admission() {
    let mut reference_builder = YjsDocumentBuilder::new("Reference inventory");
    reference_builder.push_bookmark("https://example.org", "Ordinary bookmark");
    let id = reference_builder.last_created_block_id().unwrap();
    let mut snapshot =
      yjs::native_snapshot::document_to_snapshot(&reference_builder.encode(), "source", "Reference inventory").unwrap();
    let block = snapshot["blocks"]
      .as_array_mut()
      .unwrap()
      .iter_mut()
      .find(|block| block["id"] == id)
      .unwrap();
    block["flavour"] = "myoxus:embed-linked-doc".into();
    block["props"] = serde_json::json!({"pageId":"readable","caption":"Authored embed alias"});
    let inventory = block_reference_inventory(&snapshot, Uuid::nil());
    assert!(matches!(&inventory[&id].target,Some(ReferenceTarget::Document{key,..}) if key=="readable"));
    assert_eq!(inventory[&id].alias.as_deref(), Some("Authored embed alias"));
    let mut word = Document::new();
    let mut jump = Paragraph::with_text(
      "Go to target",
      CharProps {
        link: Some("#SectionTarget".into()),
        ..Default::default()
      },
    );
    jump
      .insert_text(
        jump.text.len(),
        " and unresolved",
        &CharProps {
          link: Some("#MissingTarget".into()),
          ..Default::default()
        },
      )
      .unwrap();
    let mut target = Paragraph::with_text("Target heading", CharProps::default()).styled("Heading1");
    target
      .insert_object(
        0,
        InlineObject::BookmarkStart {
          name: "SectionTarget".into(),
        },
        &CharProps::default(),
      )
      .unwrap();
    target
      .insert_object(
        target.text.len(),
        InlineObject::BookmarkEnd {
          name: "SectionTarget".into(),
        },
        &CharProps::default(),
      )
      .unwrap();
    word.body = vec![para_block(jump), para_block(target)];
    let imported = prepare_docx(&wordcraft_docx::write(&word).unwrap(), "bookmarks.docx").unwrap();
    assert_eq!(
      imported
        .warnings
        .iter()
        .find(|warning| warning.code == "bookmark_target_normalized")
        .unwrap()
        .count,
      1
    );
    let ir = crate::doc::content_projection::project_snapshot_for_export(
      Uuid::new_v4(),
      Uuid::new_v4(),
      "Bookmarks",
      &imported.snapshot,
    )
    .unwrap();
    let target_id = ir
      .native_text
      .iter()
      .find(|(_, block)| {
        block.fields.iter().any(|field| {
          field
            .spans
            .iter()
            .any(|span| span.text.as_deref() == Some("Target heading"))
        })
      })
      .unwrap()
      .0;
    assert!(
      ir.native_text
        .values()
        .flat_map(|block| &block.fields)
        .flat_map(|field| &field.spans)
        .any(|span| span.link.as_deref() == Some(&format!("?blockIds={target_id}")))
    );
    let exported = super::export::encode_test_snapshot(&imported.snapshot, &[]);
    let word = wordcraft_docx::read(&exported.bytes).unwrap();
    let Block::Para(jump) = &*word.body[0] else {
      panic!("Jump paragraph");
    };
    let link = jump.runs.iter().find_map(|run| run.props.link.as_deref()).unwrap();
    assert!(word.body.iter().any(|block|matches!(&**block,Block::Para(paragraph) if paragraph.objects.iter().any(|object|matches!(object,InlineObject::BookmarkStart{name} if format!("#{name}")==link)))));

    let mut builder = YjsDocumentBuilder::new("References");
    let mut presentation = ExportReferencePresentation::default();
    let mut spans = vec![YjsTextSegment::plain("Visible ")];
    for block in ["a", "b"] {
      let reference = yjs::MarkdownDocumentReference {
        page_id: "readable".into(),
        title: Some(format!("Alias {block}")),
        description: None,
        params: Some(serde_json::json!({"blockIds":[block]})),
      };
      presentation.documents.insert(
        inline_reference_key(&reference, None),
        ReadableReference {
          label: "Current authorized title".into(),
          url: format!("https://example.org/workspace/ws/readable?blockIds={block}"),
        },
      );
      let mut span = YjsTextSegment::plain(" ");
      span.reference = Some(reference);
      span.bold = true;
      spans.push(span.clone());
      spans.push(span);
    }
    let mut denied = YjsTextSegment::plain(" ");
    denied.reference = Some(yjs::MarkdownDocumentReference {
      page_id: "private-key".into(),
      title: Some("SECRET CACHED TITLE".into()),
      description: None,
      params: None,
    });
    denied.link = Some("https://example.org/SECRET-stale-target-key".into());
    spans.push(denied);
    let mut mention = YjsTextSegment::plain("\u{200b}");
    mention.mention = Some(yjs::NativeMemberMention {
      member: "readable-member".into(),
    });
    spans.push(mention);
    presentation
      .mentions
      .insert("readable-member".into(), "Visible Name".into());
    builder.push_paragraph(&spans);
    let output = super::export::encode_test_snapshot_with_references(&builder.encode(), &[], presentation);
    let word = wordcraft_docx::read(&output.bytes).unwrap();
    let Block::Para(paragraph) = &*word.body[0] else {
      panic!("References paragraph");
    };
    assert!(paragraph.final_text().contains("Alias aAlias aAlias bAlias b"));
    assert!(paragraph.final_text().contains("@Visible Name"));
    assert!(paragraph.final_text().contains("[Unavailable document]"));
    assert!(!paragraph.final_text().contains("SECRET") && !paragraph.final_text().contains("private-key"));
    assert!(
      !paragraph
        .runs
        .iter()
        .any(|run| run.props.link.as_ref().is_some_and(|link| link.contains("SECRET")))
    );
    assert!(paragraph.runs.iter().any(|run| run.props.bold == Some(true)
      && run.props.link.as_deref() == Some("https://example.org/workspace/ws/readable?blockIds=a")));
    assert!(
      paragraph
        .runs
        .iter()
        .any(|run| run.props.link.as_deref() == Some("https://example.org/workspace/ws/readable?blockIds=b"))
    );
  }

  #[test]
  fn real_word_image_bytes_are_preserved_and_inline_order_is_diagnosed() {
    let mut image = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(2, 2)
      .write_to(&mut image, ImageFormat::Png)
      .unwrap();
    let png = image.into_inner();
    let mut document = Document::new();
    document.media.insert("sample.png".into(), Arc::new(png.clone()));
    let mut paragraph = Paragraph::with_text("before after", CharProps::default());
    paragraph
      .insert_object(
        7,
        InlineObject::Image {
          media: "sample.png".into(),
          w: 24.0,
          h: 24.0,
          alt: "sample figure".into(),
          float: Default::default(),
          crop: [0.0; 4],
          fx: Default::default(),
          ole: None,
        },
        &CharProps::default(),
      )
      .unwrap();
    paragraph
      .insert_object(
        paragraph.text.len(),
        InlineObject::Image {
          media: "sample.png".into(),
          w: 24.0,
          h: 24.0,
          alt: "repeated figure".into(),
          float: Default::default(),
          crop: [0.0; 4],
          fx: Default::default(),
          ole: None,
        },
        &CharProps::default(),
      )
      .unwrap();
    document.body = vec![para_block(paragraph)];
    let package = wordcraft_docx::write(&document).unwrap();
    let imported = prepare_docx(&package, "test.docx").unwrap();
    assert_eq!(imported.assets.len(), 1);
    assert_eq!(imported.assets[0].bytes.as_ref(), png);
    assert!(
      imported
        .warnings
        .iter()
        .any(|w| w.code == "inline_image_structure_normalized" && w.count == 1)
    );
    let fragment = crate::doc::document_fragment_from_yjs(&imported.snapshot).unwrap();
    assert!(
      matches!(&fragment.blocks[0], crate::doc::DocumentFragmentBlock::Paragraph { text, .. } if text.iter().any(|s| s.text.contains("before")))
    );
    assert!(matches!(
      &fragment.blocks[1],
      crate::doc::DocumentFragmentBlock::Image { .. }
    ));
    assert!(
      matches!(&fragment.blocks[2], crate::doc::DocumentFragmentBlock::Paragraph { text, .. } if text.iter().any(|s| s.text.contains("after")))
    );
    assert!(matches!(
      &fragment.blocks[3],
      crate::doc::DocumentFragmentBlock::Image { .. }
    ));
    let exported = super::export::encode_test_snapshot(&imported.snapshot, &imported.assets);
    let word = wordcraft_docx::read(&exported.bytes).expect("exported figures");
    assert_eq!(word.media.len(), 1, "repeated figures reuse media bytes");
    assert!(word.media.values().any(|bytes| bytes.as_ref() == &png));

    // Native table cells only hold attributed text: keep a labelled position
    // in the cell and materialize the binary as an adjacent editable figure.
    let mut table_document = Document::new();
    table_document.media.insert("sample.png".into(), Arc::new(png.clone()));
    let mut cell_text = Paragraph::with_text("label ", CharProps::default());
    cell_text
      .insert_object(
        cell_text.text.len(),
        InlineObject::Image {
          media: "sample.png".into(),
          w: 24.0,
          h: 24.0,
          alt: "cell figure".into(),
          float: Default::default(),
          crop: [0.0; 4],
          fx: Default::default(),
          ole: None,
        },
        &CharProps::default(),
      )
      .unwrap();
    let mut cell = Cell::empty();
    cell.blocks = vec![para_block(cell_text)];
    table_document.body = vec![Arc::new(Block::Table(Table {
      rows: vec![Row {
        cells: vec![cell],
        ..Default::default()
      }],
      ..Default::default()
    }))];
    let table_bytes = wordcraft_docx::write(&table_document).unwrap();
    let table_import = prepare_docx(&table_bytes, "table-image.docx").unwrap();
    assert_eq!(table_import.assets.len(), 1);
    assert_eq!(table_import.assets[0].bytes.as_ref(), png);
    assert!(
      table_import
        .warnings
        .iter()
        .any(|warning| warning.code == "table_image_structure_normalized")
    );
    let table_fragment = crate::doc::document_fragment_from_yjs(&table_import.snapshot).unwrap();
    assert!(
      matches!(&table_fragment.blocks[0], crate::doc::DocumentFragmentBlock::Table { rows, .. }
      if rows[0][0].iter().any(|segment| segment.text.contains("cell figure")))
    );
    assert!(matches!(
      &table_fragment.blocks[1],
      crate::doc::DocumentFragmentBlock::Image { .. }
    ));
  }

  #[test]
  fn word_merged_columns_keep_following_cells_in_their_original_grid_positions() {
    let mut document = Document::new();
    let mut merged = Cell::with_text("wide");
    merged.props.span = 2;
    let table = Table {
      grid: vec![80.0; 3],
      rows: vec![
        Row {
          props: wordcraft_doc::props::RowProps {
            header: true,
            ..Default::default()
          },
          cells: vec![Cell::with_text("one"), Cell::with_text("two"), Cell::with_text("three")],
          ..Default::default()
        },
        Row {
          cells: vec![merged, Cell::with_text("after")],
          ..Default::default()
        },
      ],
      ..Default::default()
    };
    document.body = vec![std::sync::Arc::new(Block::Table(table))];
    let bytes = wordcraft_docx::write(&document).expect("write table package");
    let imported = prepare_docx(&bytes, "table.docx").expect("read table package");
    assert!(
      imported
        .warnings
        .iter()
        .any(|warning| warning.code == "merged_cells_normalized")
    );
    let fragment = crate::doc::document_fragment_from_yjs(&imported.snapshot).unwrap();
    let crate::doc::DocumentFragmentBlock::Table { rows, .. } = &fragment.blocks[0] else {
      panic!("native editable table")
    };
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].len(), 3);
    assert!(rows[1][0].iter().any(|segment| segment.text == "wide"));
    assert!(rows[1][1].is_empty());
    assert!(rows[1][2].iter().any(|segment| segment.text == "after"));
    let exported = super::export::encode_test_snapshot(&imported.snapshot, &imported.assets);
    let word = wordcraft_docx::read(&exported.bytes).unwrap();
    let Block::Table(table) = &*word.body[0] else {
      panic!("Word table, not a text placeholder");
    };
    assert!(table.rows[0].props.header);
    assert_eq!(table.rows[1].cells.len(), 3);
    assert!(matches!(&*table.rows[1].cells[2].blocks[0], Block::Para(paragraph) if paragraph.plain_text() == "after"));
  }

  #[test]
  fn bordered_word_rule_becomes_a_visible_native_divider() {
    let mut document = Document::new();
    let mut rule = Paragraph::new();
    rule.props.borders = Some(Borders {
      bottom: Some(Border::single(1.0)),
      ..Default::default()
    });
    document.body = vec![para_block(rule)];
    let bytes = wordcraft_docx::write(&document).unwrap();
    let imported = prepare_docx(&bytes, "divider.docx").expect("line is usable document content");
    assert!(
      imported
        .warnings
        .iter()
        .any(|warning| warning.code == "border_divider_normalized")
    );
    let fragment = crate::doc::document_fragment_from_yjs(&imported.snapshot).unwrap();
    assert!(matches!(fragment.blocks[0], crate::doc::DocumentFragmentBlock::Divider));
  }
}
