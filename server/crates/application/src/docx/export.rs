// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! DOCX encoding of one complete private native projection; never a renderer response page.

use std::{
  collections::{BTreeMap, BTreeSet},
  sync::Arc,
};

use myoxus_public_render::{Block, InlineText, PublicDocIr, PublicListKind};
use wordcraft_doc::{
  Cell, CharProps, Document, InlineObject, Paragraph, Row, Table,
  numbering::ListKind,
  para_block,
  props::{Border, Borders, NumRef, Underline},
};
use yjs::native_text::{NativeTextField, NativeTextSpan};

use super::{ConversionWarning, ImportError};
use crate::ports::{
  blob::{BlobKey, BlobStatus},
  blob_service::BlobService,
};

/// Font family names resolved from the effective server theme, not client presets.
pub struct ExportFonts {
  pub body: String,
  pub heading: String,
  pub mono: String,
  pub visuals: Option<(
    Arc<myoxus_public_render::PreparedPreviewContext>,
    myoxus_public_render::PreviewPolicy,
  )>,
  pub typography: BTreeMap<String, ExportTypography>,
  pub table_fill: Option<String>,
  pub table_ink: Option<String>,
  pub table_rule: Option<String>,
}

/// Server-validated typography in CSS pixels; Word converts to points once.
pub struct ExportTypography {
  pub family: String,
  pub style: myoxus_pdf_export::ir::ThemeTypographyStyle,
}

pub struct ExportedDocx {
  pub bytes: Vec<u8>,
  pub title: String,
  pub warnings: Vec<ConversionWarning>,
}

pub struct ExportSource {
  ir: PublicDocIr,
  images: BTreeMap<String, Vec<u8>>,
  warnings: BTreeMap<&'static str, usize>,
  references: super::ExportReferencePresentation,
}

/// Only workspace-local completed assets are read. External URLs and unavailable
/// individual figures become diagnostics; they never trigger network fetches.
pub async fn resolve_export_assets(
  captured: super::CapturedDocx,
  blobs: &BlobService,
  can_read_blobs: bool,
  references: super::ExportReferencePresentation,
) -> Result<ExportSource, ImportError> {
  let ir = captured.ir;
  let mut images = BTreeMap::new();
  let warnings = BTreeMap::new();
  let mut total = 0u64;
  let limit = myoxus_workspace_import::WorkspaceImportLimits::default().max_document_bytes;
  if !can_read_blobs {
    return Ok(ExportSource {
      ir,
      images,
      warnings,
      references,
    });
  }
  for candidate in myoxus_public_render::resolve_asset_candidates(&ir) {
    let key = candidate.blob_key;
    if images.contains_key(&key) {
      continue;
    }
    if BlobKey::parse(&key).is_err() || url::Url::parse(&key).is_ok() {
      continue;
    }
    let metadata = blobs.get_blob_metadata(ir.document.workspace_id, &key).await?;
    let Some(metadata) = metadata.filter(|m| m.status == BlobStatus::Completed && m.deleted_at.is_none()) else {
      continue;
    };
    if !matches!(
      metadata.mime.as_str(),
      "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml"
    ) {
      continue;
    }
    total = total.checked_add(metadata.size).ok_or(ImportError::TooLarge)?;
    if total > limit {
      return Err(ImportError::TooLarge);
    }
    match blobs.get_blob(ir.document.workspace_id, &key).await {
      Ok(blob) if blob.data.len() as u64 == metadata.size => {
        images.insert(key, blob.data.to_vec());
      }
      _ => {}
    }
  }
  Ok(ExportSource {
    ir,
    images,
    warnings,
    references,
  })
}

pub fn encode_export(source: ExportSource, fonts: ExportFonts) -> Result<ExportedDocx, ImportError> {
  let mut encoder = Encoder {
    source: source.ir,
    references: source.references,
    block_bookmarks: BTreeMap::new(),
    images: source.images,
    warnings: source.warnings,
    document: Document::new(),
    fonts,
    usable: 0,
    figures: BTreeMap::new(),
    notes: BTreeMap::new(),
    in_note: false,
    note_anchors: BTreeMap::new(),
    note_numbers: [0; 2],
    indent: 0.0,
    list_level: 0,
  };
  encoder.document.body.clear();
  encoder.document.core.title = encoder.source.document.title.clone();
  Arc::make_mut(&mut encoder.document.styles).default_chr.font = Some(encoder.fonts.body.clone());
  // Native local notes number each placement independently in first-anchor
  // order. Word's default endnote Roman glyphs are not that native numbering.
  encoder.document.settings.endnote_format = wordcraft_doc::section::NumFormat::Decimal;
  if encoder.document.styles.get("Caption").is_none() {
    Arc::make_mut(&mut encoder.document.styles)
      .styles
      .push(wordcraft_doc::Style {
        id: "Caption".into(),
        name: "Caption".into(),
        kind: wordcraft_doc::StyleKind::Paragraph,
        based_on: Some("Normal".into()),
        ..Default::default()
      });
  }
  // Writer otherwise applies its Roman endnote default despite the document's
  // decimal setting. The section must state the same effective native format.
  encoder.document.last_section.endnote_pr.num_fmt = Some(wordcraft_doc::section::NumFormat::Decimal);
  for (id, font) in [
    ("MyoxusCode", &encoder.fonts.mono),
    ("MyoxusCallout", &encoder.fonts.body),
  ] {
    Arc::make_mut(&mut encoder.document.styles)
      .styles
      .push(wordcraft_doc::Style {
        id: id.into(),
        name: id.into(),
        kind: wordcraft_doc::StyleKind::Paragraph,
        based_on: Some("Normal".into()),
        chr: CharProps {
          font: Some(font.clone()),
          ..Default::default()
        },
        ..Default::default()
      });
  }
  for level in 1..=6 {
    if let Some(style) = Arc::make_mut(&mut encoder.document.styles).get_mut(&format!("Heading{level}")) {
      style.chr.font = Some(encoder.fonts.heading.clone());
    }
  }
  for (id, typography) in &encoder.fonts.typography {
    let style = &typography.style;
    let chr = CharProps {
      font: Some(typography.family.clone()),
      size: Some(style.size_px as f32 * 0.75),
      bold: Some(style.font_weight >= 600),
      italic: Some(style.font_style != "normal"),
      caps: Some(style.text_transform == "uppercase"),
      underline: (style.decoration == "underline").then_some(Underline::Single),
      strike: (style.decoration == "line-through").then_some(true),
      spacing: Some((style.letter_spacing_em * style.size_px * 0.75) as f32),
      ..Default::default()
    };
    if id == "Normal" {
      Arc::make_mut(&mut encoder.document.styles).default_chr = chr.clone();
    }
    if let Some(target) = Arc::make_mut(&mut encoder.document.styles).get_mut(id) {
      target.chr = chr;
      target.para.line_spacing = Some(wordcraft_doc::props::LineSpacing::Multiple(style.line_height as f32));
      target.para.space_after = Some(style.size_px as f32 * 0.75 * 0.5);
      target.para.keep_next = Some(id.starts_with("Heading"));
      target.para.widow_control = Some(true);
    }
  }
  // Cells inherit body typography without prose spacing or keep-with-next
  // rules that would inflate every row or bind a whole table together.
  Arc::make_mut(&mut encoder.document.styles)
    .styles
    .push(wordcraft_doc::Style {
      id: "MyoxusTable".into(),
      name: "Myoxus Table".into(),
      kind: wordcraft_doc::StyleKind::Paragraph,
      based_on: Some("Normal".into()),
      para: wordcraft_doc::ParaProps {
        space_before: Some(0.0),
        space_after: Some(0.0),
        keep_next: Some(false),
        ..Default::default()
      },
      ..Default::default()
    });
  // Explicit unsupported blocks are counted by the encoder below. Other
  // projection diagnostics describe readable fallbacks or missing source units;
  // never send the renderer's text/identities in conversion headers.
  fn omitted_ids(blocks: &[Block], ids: &mut BTreeSet<String>) {
    for block in blocks {
      match block {
        Block::UnsupportedBlock { block_id, .. } | Block::TablePlaceholder { block_id } => {
          ids.insert(block_id.clone());
        }
        Block::Callout { children, .. } | Block::FootnoteDefinition { children, .. } => omitted_ids(children, ids),
        Block::List { list, .. } => {
          for item in &list.items {
            omitted_ids(&item.children, ids);
          }
        }
        _ => {}
      }
    }
  }
  let mut omitted = BTreeSet::new();
  omitted_ids(&encoder.source.document.blocks, &mut omitted);
  let diagnostics = encoder.source.diagnostics.clone();
  for diagnostic in diagnostics {
    if diagnostic.block_id.as_ref().is_some_and(|id| {
      encoder.references.blocks.contains_key(id)
        || encoder.references.unavailable_blocks.contains(id)
        || encoder.references.fallbacks.contains_key(id)
    }) {
      continue;
    }
    if diagnostic.block_id.as_ref().is_some_and(|id| omitted.contains(id)) {
      continue;
    }
    encoder.warn(if diagnostic.code == "partial_yjs_extraction" {
      "source_construct_omitted"
    } else {
      "source_construct_normalized"
    });
  }
  let blocks = encoder.source.document.blocks.clone();
  let bookmark_ids = encoder
    .source
    .native_text
    .iter()
    .filter(|(_, block)| {
      matches!(
        block.kind.as_str(),
        "myoxus:paragraph"
          | "myoxus:list"
          | "myoxus:callout"
          | "myoxus:table"
          | "myoxus:code"
          | "myoxus:latex"
          | "myoxus:bookmark"
      )
    })
    .map(|(id, _)| id)
    .chain(encoder.references.blocks.keys())
    .chain(encoder.references.unavailable_blocks.iter())
    .chain(
      encoder
        .references
        .fallbacks
        .iter()
        .filter(|(_, fallback)| !fallback.label.is_empty())
        .map(|(id, _)| id),
    )
    .collect::<BTreeSet<_>>();
  for (index, id) in bookmark_ids.into_iter().enumerate() {
    encoder
      .block_bookmarks
      .insert(id.clone(), format!("MyoxusBlock{index}"));
  }
  encoder.register_notes(&blocks);
  encoder.blocks(&blocks, 0)?;
  if encoder.usable == 0 {
    return Err(ImportError::Empty);
  }
  let bytes = wordcraft_docx::write(&encoder.document).map_err(|_| ImportError::Conversion)?;
  if bytes.len() as u64 > myoxus_workspace_import::WorkspaceImportLimits::default().max_document_bytes {
    return Err(ImportError::TooLarge);
  }
  Ok(ExportedDocx {
    bytes,
    title: encoder.source.document.title,
    warnings: encoder
      .warnings
      .into_iter()
      .map(|(code, count)| ConversionWarning { code, count })
      .collect(),
  })
}

struct Encoder {
  source: PublicDocIr,
  references: super::ExportReferencePresentation,
  block_bookmarks: BTreeMap<String, String>,
  images: BTreeMap<String, Vec<u8>>,
  warnings: BTreeMap<&'static str, usize>,
  document: Document,
  fonts: ExportFonts,
  usable: usize,
  figures: BTreeMap<String, (String, f32, f32)>,
  notes: BTreeMap<String, (u32, wordcraft_doc::para::NoteKind, u32)>,
  note_anchors: BTreeMap<String, (String, u32)>,
  note_numbers: [u32; 2],
  in_note: bool,
  indent: f32,
  list_level: usize,
}

impl Encoder {
  fn register_notes(&mut self, blocks: &[Block]) {
    for block in blocks {
      match block {
        Block::FootnoteDefinition {
          block_id,
          placement: Some(placement),
          number: Some(number),
          ..
        } => {
          if self.notes.contains_key(block_id) {
            continue;
          }
          let (part, kind) = match placement {
            yjs::footnote::FootnotePlacement::Footnote => (
              wordcraft_doc::PartKind::Footnote,
              wordcraft_doc::para::NoteKind::Footnote,
            ),
            yjs::footnote::FootnotePlacement::Endnote => {
              (wordcraft_doc::PartKind::Endnote, wordcraft_doc::para::NoteKind::Endnote)
            }
          };
          let id = self.document.add_part(part, Vec::new());
          self.notes.insert(block_id.clone(), (id, kind, *number));
        }
        Block::Callout { children, .. } => self.register_notes(children),
        Block::List { list, .. } => {
          for item in &list.items {
            self.register_notes(&item.children);
          }
        }
        _ => {}
      }
    }
  }

  fn warn(&mut self, code: &'static str) {
    *self.warnings.entry(code).or_default() += 1;
  }

  fn append(para: &mut Paragraph, text: &str, props: CharProps) -> Result<(), ImportError> {
    para
      .insert_text(para.text.len(), text, &props)
      .map_err(|_| ImportError::Conversion)?;
    Ok(())
  }

  fn native_field(&self, id: &str) -> Option<NativeTextField> {
    self
      .source
      .native_text
      .get(id)?
      .fields
      .iter()
      .find(|f| f.field == "text" && f.row_id.is_none())
      .cloned()
  }

  fn span_props(&self, span: &NativeTextSpan, link: Option<String>) -> CharProps {
    CharProps {
      bold: span.bold.then_some(true),
      italic: span.italic.then_some(true),
      strike: span.strike.then_some(true),
      underline: span.underline.then_some(Underline::Single),
      font: span.code.then(|| self.fonts.mono.clone()),
      link,
      ..Default::default()
    }
  }

  fn paragraph(&mut self, id: &str, fallback: &[InlineText]) -> Result<Paragraph, ImportError> {
    let mut para = Paragraph::new();
    if let Some(field) = self.native_field(id) {
      self.field(&mut para, &field)?;
    } else {
      for run in fallback {
        if run.reference.is_some() {
          // Reading IR alone cannot prove an explicit native workspace scope.
          // Without its exact private field, never reuse a same-key admission.
          self.warn("document_reference_omitted");
          let (text, link) = ("[Unavailable document]", None);
          Self::append(
            &mut para,
            &text,
            CharProps {
              bold: Some(run.bold),
              italic: Some(run.italic),
              strike: Some(run.strike),
              link,
              ..Default::default()
            },
          )?;
          continue;
        }
        if let Some((source, _, _)) = &run.latex {
          self.equation(&mut para, source, false)?;
          continue;
        }
        let link = self.link(run.link.as_deref());
        let text = run.text.clone();
        Self::append(
          &mut para,
          &text,
          CharProps {
            bold: Some(run.bold),
            italic: Some(run.italic),
            strike: Some(run.strike),
            font: run.code.then(|| self.fonts.mono.clone()),
            link,
            ..Default::default()
          },
        )?;
      }
    }
    self.bookmarked(para, id)
  }

  fn bookmarked(&self, mut para: Paragraph, id: &str) -> Result<Paragraph, ImportError> {
    if let Some(name) = self.block_bookmarks.get(id) {
      para
        .insert_object(
          0,
          InlineObject::BookmarkStart { name: name.clone() },
          &CharProps::default(),
        )
        .map_err(|_| ImportError::Conversion)?;
      para
        .insert_object(
          para.text.len(),
          InlineObject::BookmarkEnd { name: name.clone() },
          &CharProps::default(),
        )
        .map_err(|_| ImportError::Conversion)?;
    }
    Ok(para)
  }

  fn field(&mut self, para: &mut Paragraph, field: &NativeTextField) -> Result<(), ImportError> {
    let mut spans = field.spans.iter().peekable();
    while let Some(span) = spans.next() {
      if let Some(identity) = &span.annotation_id {
        // An identity can occur in separated ranges. Only adjacent attributed
        // runs form one body, matching the native editor's range semantics.
        let mut body = vec![span.clone()];
        while spans
          .peek()
          .is_some_and(|next| next.annotation_id.as_ref() == Some(identity) && next.start == body.last().unwrap().end)
        {
          body.push(spans.next().unwrap().clone());
        }
        for run in &mut body {
          run.annotation_id = None;
          // Annotation bodies are literal rich text, not nested inline atoms.
          run.latex = None;
          run.reference = None;
          run.reference_workspace = None;
          run.mention = None;
          run.footnote = None;
        }
        self.annotation(
          para,
          NativeTextField {
            field: "text".into(),
            row_id: None,
            column_id: None,
            range_unit: field.range_unit,
            length: body.last().unwrap().end - body[0].start,
            spans: body,
          },
        )?;
        continue;
      }
      if let Some(source) = &span.latex {
        for _ in 0..span.text.as_ref().map_or(1, |text| text.chars().count()) {
          self.equation(para, source, false)?;
        }
        continue;
      }
      if !self.in_note
        && let Some(note) = &span.footnote
        && let Some(definition) = &note.definition_id
        && let Some((id, kind, _)) = self.notes.get(definition).copied()
      {
        // Word's ordinary repeated-note representation is NOTEREF to the first
        // anchor, not another footnoteReference that Office may duplicate.
        // Yjs may coalesce adjacent equal atomic placeholders into one span.
        for _ in 0..span.text.as_ref().map_or(1, |text| text.chars().count()) {
          if let Some((name, number)) = self.note_anchors.get(definition) {
            para
              .insert_object(
                para.text.len(),
                InlineObject::Field {
                  instr: format!("NOTEREF {name} \\h"),
                  result: number.to_string(),
                  locked: false,
                  dirty: false,
                  code: false,
                  form: String::new(),
                },
                &CharProps {
                  vert_align: Some(wordcraft_doc::props::VertAlign::Superscript),
                  ..Default::default()
                },
              )
              .map_err(|_| ImportError::Conversion)?;
          } else {
            let name = format!("MyoxusNote{id}");
            let number = self.next_note_number(kind);
            for object in [
              InlineObject::BookmarkStart { name: name.clone() },
              InlineObject::NoteRef {
                kind,
                id,
                custom: String::new(),
              },
              InlineObject::BookmarkEnd { name: name.clone() },
            ] {
              para
                .insert_object(para.text.len(), object, &CharProps::default())
                .map_err(|_| ImportError::Conversion)?;
            }
            self.note_anchors.insert(definition.clone(), (name, number));
          }
        }
        continue;
      }
      // A reference's destination comes only from its admitted target. A stale
      // coexisting link attribute must not survive a denied-reference fallback.
      let link = if span.reference.is_none() {
        self.link(span.link.as_deref())
      } else {
        None
      };
      if span.color.is_some() || span.background.is_some() || span.label_tone.is_some() {
        self.warn("text_style_normalized");
      }
      let text = if span.mention.is_some() {
        let label = span
          .text
          .as_ref()
          .filter(|text| {
            !text
              .trim_matches(|c: char| {
                c.is_whitespace() || matches!(c, '\u{200b}' | '\u{200c}' | '\u{feff}' | '\u{fffc}')
              })
              .is_empty()
          })
          .cloned()
          .or_else(|| {
            span
              .mention
              .as_ref()
              .and_then(|mention| self.references.mentions.get(&mention.member))
              .map(|name| vec![format!("@{name}"); span.text.as_ref().map_or(1, |text| text.chars().count())].join(" "))
          });
        if let Some(label) = label {
          self.warn("mention_normalized");
          label
        } else {
          self.warn("mention_label_omitted");
          "[Mention]".into()
        }
      } else if let Some(reference) = &span.reference {
        if let Some(target) = self
          .references
          .documents
          .get(&super::inline_reference_key(
            reference,
            span.reference_workspace.as_ref(),
          ))
          .cloned()
        {
          let label = reference
            .title
            .as_ref()
            .filter(|title| !title.trim().is_empty())
            .cloned()
            .unwrap_or(target.label);
          let count = span
            .text
            .as_deref()
            .filter(|text| {
              text
                .chars()
                .all(|c| c.is_whitespace() || matches!(c, '\u{200b}' | '\u{200c}' | '\u{fffc}'))
            })
            .map_or(1, |text| text.chars().count());
          for _ in 0..count {
            self.warn("document_reference_normalized");
            Self::append(para, &label, self.span_props(span, Some(target.url.clone())))?;
          }
          continue;
        }
        self.warn("document_reference_omitted");
        "[Unavailable document]".into()
      } else if let Some(note) = &span.footnote {
        self.warn("footnote_reference_normalized");
        format!("[{}]", note.label)
      } else {
        if span.text.is_none() {
          self.warn("inline_object_omitted");
        }
        span.text.clone().unwrap_or_default()
      };
      Self::append(para, &text, self.span_props(span, link))?;
    }
    Ok(())
  }

  fn next_note_number(&mut self, kind: wordcraft_doc::para::NoteKind) -> u32 {
    let index = usize::from(kind == wordcraft_doc::para::NoteKind::Endnote);
    self.note_numbers[index] += 1;
    self.note_numbers[index]
  }

  fn annotation(&mut self, anchor: &mut Paragraph, field: NativeTextField) -> Result<(), ImportError> {
    self.warn("annotation_note_normalized");
    if self.in_note {
      // Word has no nested footnotes. Keep the whole rich body at its position
      // within the containing note rather than inventing a dangling reference.
      Self::append(anchor, " [Annotation: ", CharProps::default())?;
      self.field(anchor, &field)?;
      Self::append(anchor, "]", CharProps::default())?;
    } else {
      self.in_note = true;
      let mut body = Paragraph::new();
      let result = self.field(&mut body, &field);
      self.in_note = false;
      result?;
      let id = self
        .document
        .add_part(wordcraft_doc::PartKind::Footnote, vec![para_block(body)]);
      self.next_note_number(wordcraft_doc::para::NoteKind::Footnote);
      anchor
        .insert_object(
          anchor.text.len(),
          InlineObject::NoteRef {
            id,
            kind: wordcraft_doc::para::NoteKind::Footnote,
            custom: String::new(),
          },
          &CharProps::default(),
        )
        .map_err(|_| ImportError::Conversion)?;
    }
    Ok(())
  }

  fn push(&mut self, paragraph: Paragraph) {
    let mut paragraph = paragraph;
    if self.indent > 0.0 || self.list_level > 0 {
      paragraph.props.indent_left = Some(self.indent + self.list_level as f32 * super::CONTENT_INDENT);
    }
    if !paragraph.text.trim().is_empty() {
      self.usable += 1;
    }
    self.document.body.push(para_block(paragraph));
  }

  fn equation(&mut self, paragraph: &mut Paragraph, source: &str, display: bool) -> Result<(), ImportError> {
    if source.trim().is_empty() {
      self.warn("formula_omitted");
    } else if let Some(math) = super::math::from_latex(source) {
      paragraph
        .insert_object(
          paragraph.text.len(),
          InlineObject::Equation {
            linear: wordcraft_doc::math::to_linear(&math.nodes),
            display,
            math,
          },
          &CharProps::default(),
        )
        .map_err(|_| ImportError::Conversion)?;
    } else {
      Self::append(paragraph, &format!("[Formula: {source}]"), CharProps::default())?;
      self.warn("formula_structure_normalized");
    }
    Ok(())
  }

  fn blocks(&mut self, blocks: &[Block], depth: usize) -> Result<(), ImportError> {
    if depth > 64 {
      return Err(ImportError::TooLarge);
    }
    for block in blocks {
      let id = block.block_id();
      if let Some(fallback) = self.references.fallbacks.remove(id) {
        self.warn(fallback.code);
        if !fallback.label.is_empty() {
          let mut paragraph = Paragraph::with_text(
            &fallback.label,
            CharProps {
              link: fallback.url,
              ..Default::default()
            },
          );
          if let Some(explanation) = fallback.explanation {
            Self::append(&mut paragraph, &format!(" — {explanation}"), CharProps::default())?;
          }
          let paragraph = self.bookmarked(paragraph, id)?;
          self.push(paragraph);
        }
        continue;
      }
      if let Some(target) = self.references.blocks.get(id).cloned() {
        self.warn("document_reference_normalized");
        let paragraph = self.bookmarked(
          Paragraph::with_text(
            &target.label,
            CharProps {
              link: Some(target.url),
              ..Default::default()
            },
          ),
          id,
        )?;
        self.push(paragraph);
        continue;
      }
      if self.references.unavailable_blocks.contains(id) {
        self.warn("document_reference_omitted");
        let paragraph = self.bookmarked(
          Paragraph::with_text("[Unavailable reference]", CharProps::default()),
          id,
        )?;
        self.push(paragraph);
        continue;
      }
      match block {
        Block::Paragraph { block_id, text }
        | Block::Quote { block_id, text }
        | Block::Heading { block_id, text, .. } => {
          let mut paragraph = self.paragraph(block_id, text)?;
          match block {
            Block::Heading { level, .. } => paragraph.props.style = Some(format!("Heading{}", level.clamp(&1, &6))),
            Block::Quote { .. } => paragraph.props.style = Some("Quote".into()),
            _ => {}
          }
          self.push(paragraph);
        }
        Block::Divider { .. } => {
          let mut paragraph = Paragraph::new();
          paragraph.props.borders = Some(Borders {
            bottom: Some(Border::single(0.75)),
            ..Default::default()
          });
          self.push(paragraph);
          self.usable += 1;
        }
        Block::List { list, .. } => {
          let numbered = list.kind == PublicListKind::Numbered;
          let number = Arc::make_mut(&mut self.document.numbering).add_list(if numbered {
            ListKind::Numbered
          } else {
            ListKind::Bullet
          });
          if numbered {
            let definition = Arc::make_mut(&mut self.document.numbering)
              .abstracts
              .last_mut()
              .ok_or(ImportError::Conversion)?;
            for (index, level) in definition.levels.iter_mut().enumerate() {
              level.format = wordcraft_doc::section::NumFormat::Decimal;
              level.text = format!("%{}.", index + 1);
            }
          }
          let mut current = number;
          let mut expected = 1u64;
          for item in &list.items {
            let mut paragraph = self.paragraph(&item.block_id, &item.text)?;
            if list.kind == PublicListKind::Todo {
              let checked = item.todo_checked == Some(true);
              let mut kind = wordcraft_doc::ControlKind::check_box();
              if let wordcraft_doc::ControlKind::CheckBox { checked: value, .. } = &mut kind {
                *value = checked;
              }
              paragraph
                .insert_object(
                  0,
                  InlineObject::ControlStart {
                    control: Box::new(wordcraft_doc::ContentControl::new(kind)),
                  },
                  &CharProps::default(),
                )
                .map_err(|_| ImportError::Conversion)?;
              paragraph
                .insert_text(
                  wordcraft_doc::para::OBJ.len_utf8(),
                  if checked { "☒" } else { "☐" },
                  &CharProps::default(),
                )
                .map_err(|_| ImportError::Conversion)?;
              paragraph
                .insert_object(
                  wordcraft_doc::para::OBJ.len_utf8() + "☐".len(),
                  InlineObject::ControlEnd,
                  &CharProps::default(),
                )
                .map_err(|_| ImportError::Conversion)?;
              paragraph
                .insert_text(
                  wordcraft_doc::para::OBJ.len_utf8() * 2 + "☐".len(),
                  " ",
                  &CharProps::default(),
                )
                .map_err(|_| ImportError::Conversion)?;
              paragraph.props.indent_left = Some(self.indent + self.list_level as f32 * super::CONTENT_INDENT);
            } else {
              let order = self
                .source
                .native_text
                .get(&item.block_id)
                .and_then(|n| n.properties.get("order"))
                .and_then(|o| o.as_f64())
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| n as u64)
                .unwrap_or(expected);
              if numbered && order != expected {
                current = Arc::make_mut(&mut self.document.numbering)
                  .restart(number)
                  .ok_or(ImportError::Conversion)?;
                let value = u32::try_from(order).unwrap_or_else(|_| {
                  self.warn("numbering_value_normalized");
                  u32::MAX
                });
                Arc::make_mut(&mut self.document.numbering)
                  .nums
                  .last_mut()
                  .ok_or(ImportError::Conversion)?
                  .start_overrides = vec![(self.list_level.min(8) as u8, value)];
              }
              expected = order.saturating_add(1);
              paragraph.props.numbering = Some(NumRef {
                num: current,
                level: self.list_level.min(8) as u8,
              });
            }
            self.push(paragraph);
            self.list_level += 1;
            self.blocks(&item.children, depth + 1)?;
            self.list_level -= 1;
          }
        }
        Block::Table {
          block_id,
          rows,
          header_rows,
          appearance,
          density,
          ..
        } => {
          let identity = self.source.native_tables.get(block_id).cloned();
          let fields = self
            .source
            .native_text
            .get(block_id)
            .map(|n| n.fields.clone())
            .unwrap_or_default();
          let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
          if columns == 0 {
            self.warn("empty_table_omitted");
            continue;
          }
          if columns > 63 {
            // Word's table grid has at most 63 columns. Preserve readable cell
            // bodies instead of writing an invalid table or dropping columns.
            self.warn("table_structure_normalized");
            for row in rows {
              for cell in row {
                let paragraph = self.paragraph("", cell)?;
                self.push(paragraph);
              }
            }
            continue;
          }
          let properties = self
            .source
            .native_text
            .get(block_id)
            .map(|block| block.properties.clone())
            .unwrap_or_default();
          let available = self.text_width();
          let widths = (0..columns)
            .map(|column| {
              identity
                .as_ref()
                .and_then(|identity| identity.column_ids.get(column))
                .and_then(|id| properties.get("columns")?.get(id)?.get("width")?.as_f64())
                .filter(|width| width.is_finite() && *width > 0.0)
                .unwrap_or(160.0) as f32
            })
            .collect::<Vec<_>>();
          let total = widths.iter().sum::<f32>();
          let mut table = Table {
            grid: widths.into_iter().map(|width| width / total * available).collect(),
            ..Default::default()
          };
          table.props.width = Some(available);
          table.props.fixed = true;
          table.props.look = wordcraft_doc::props::TableLook {
            header_row: header_rows.unwrap_or(0) > 0,
            total_row: false,
            banded_rows: false,
            first_column: false,
            last_column: false,
            banded_columns: false,
          };
          let font_size = self
            .fonts
            .typography
            .get("Normal")
            .map_or(11.0, |typography| typography.style.size_px as f32 * 0.75);
          let inset = font_size
            * if *density == Some(myoxus_public_render::ir::TableDensity::Compact) {
              0.25
            } else {
              0.5
            };
          table.props.cell_margins = Some([inset, inset, inset, inset]);
          let line = Border {
            color: self
              .fonts
              .table_rule
              .as_deref()
              .and_then(wordcraft_doc::props::Rgb::parse),
            ..Border::single(0.5)
          };
          let none = Border::default();
          table.props.borders = Some(match appearance {
            Some(myoxus_public_render::ir::TableAppearance::Plain) => Borders {
              top: Some(none),
              bottom: Some(none),
              left: Some(none),
              right: Some(none),
              between: Some(none),
              inside_v: Some(none),
            },
            Some(myoxus_public_render::ir::TableAppearance::Ruled) => Borders {
              top: Some(line),
              bottom: Some(line),
              left: Some(none),
              right: Some(none),
              between: Some(line),
              inside_v: Some(none),
            },
            _ => Borders {
              top: Some(line),
              bottom: Some(line),
              left: Some(line),
              right: Some(line),
              between: Some(line),
              inside_v: Some(line),
            },
          });
          if self.indent > 0.0 || self.list_level > 0 {
            table.props.indent = Some(self.indent + self.list_level as f32 * super::CONTENT_INDENT);
          }
          for (row_index, row) in rows.iter().enumerate() {
            let mut output = Row::default();
            output.props.header = row_index < header_rows.unwrap_or(0);
            // Keep ordinary rows atomic; Word owns overflow for a row larger
            // than a page. Splitting every row makes continuation pages begin
            // with detached value text and no identifying first-column value.
            output.props.cant_split = true;
            for (column_index, cell) in row.iter().enumerate() {
              let native = identity.as_ref().and_then(|identity| {
                let r = identity.row_ids.get(row_index)?;
                let c = identity.column_ids.get(column_index)?;
                fields
                  .iter()
                  .find(|f| f.row_id.as_ref() == Some(r) && f.column_id.as_ref() == Some(c))
              });
              let mut paragraph = Paragraph::new();
              if let Some(field) = native {
                self.field(&mut paragraph, field)?;
              } else {
                paragraph = self.paragraph("", cell)?;
              }
              if !paragraph.text.trim().is_empty() {
                self.usable += 1;
              }
              if row_index == 0 && column_index == 0 {
                paragraph = self.bookmarked(paragraph, block_id)?;
              }
              let mut cell = Cell::empty();
              cell.props.width = table.grid.get(column_index).copied();
              paragraph.props.style = Some("MyoxusTable".into());
              if output.props.header {
                cell.props.shading = self
                  .fonts
                  .table_fill
                  .as_deref()
                  .and_then(wordcraft_doc::props::Rgb::parse);
                for run in &mut paragraph.runs {
                  run.props.bold = Some(true);
                  run.props.color = self
                    .fonts
                    .table_ink
                    .as_deref()
                    .and_then(wordcraft_doc::props::TextColor::parse);
                }
              }
              cell.blocks = vec![para_block(paragraph)];
              output.cells.push(cell);
            }
            table.rows.push(output);
          }
          self.document.body.push(Arc::new(wordcraft_doc::Block::Table(table)));
        }
        Block::Image { asset, .. } => {
          if let Some((name, width, height)) = self.figures.get(&asset.source).cloned() {
            self.figure(name, width, height, &asset.alt)?;
            continue;
          }
          if let Some(source) = self.images.get(asset.source.trim().trim_start_matches('/')) {
            let Some((bytes, format, pixel_width, pixel_height)) = self.document_image(source) else {
              self.image_fallback("unsupported_image_omitted", &asset.alt);
              continue;
            };
            let name = format!(
              "image-{}.{}",
              self.document.media.len(),
              if format == image::ImageFormat::Png {
                "png"
              } else {
                "jpg"
              }
            );
            let width = (pixel_width as f32 * 0.75).min(468.0);
            let height = width * pixel_height as f32 / pixel_width.max(1) as f32;
            self.document.media.insert(name.clone(), Arc::new(bytes));
            self.figures.insert(asset.source.clone(), (name.clone(), width, height));
            self.figure(name, width, height, &asset.alt)?;
          } else {
            self.image_fallback("unavailable_image_omitted", &asset.alt);
          }
        }
        Block::Code {
          block_id,
          text,
          native_latex: true,
          ..
        } => {
          let mut paragraph = Paragraph::new();
          let complete = self
            .source
            .native_text
            .get(block_id)
            .and_then(|block| block.fields.iter().find(|field| field.field == "source"))
            .map(|field| {
              field
                .spans
                .iter()
                .filter_map(|span| span.text.as_deref())
                .collect::<String>()
            });
          self.equation(&mut paragraph, complete.as_deref().unwrap_or(text), true)?;
          let paragraph = self.bookmarked(paragraph, block_id)?;
          self.push(paragraph);
        }
        Block::Code {
          block_id,
          text,
          language,
          ..
        } => {
          if language
            .as_deref()
            .is_some_and(|language| !matches!(language, "" | "plaintext" | "text"))
          {
            self.warn("code_language_normalized");
          }
          let paragraph = self.bookmarked(
            Paragraph::with_text(
              text,
              CharProps {
                font: Some(self.fonts.mono.clone()),
                ..Default::default()
              },
            )
            .styled("MyoxusCode"),
            block_id,
          )?;
          self.push(paragraph);
        }
        Block::Mermaid {
          block_id,
          source,
          title,
          caption,
        } => {
          use myoxus_pdf_export::mermaid::{MermaidExportRenderer, MermanSvgRenderer};
          let png = self.fonts.visuals.as_ref().and_then(|(context, policy)| {
            if source.len() > policy.max_mermaid_source_bytes {
              return None;
            }
            let svg = MermanSvgRenderer.render_svg(source, block_id).ok()?;
            context.rasterize_svg(svg.as_bytes(), policy).ok()
          });
          let label = [title.as_str(), caption.as_str()]
            .into_iter()
            .filter(|label| !label.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
          if let Some(png) = png {
            let image = image::load_from_memory(&png).map_err(|_| ImportError::Conversion)?;
            let width = (image.width() as f32 * 0.75).min(468.0);
            let height = width * image.height() as f32 / image.width().max(1) as f32;
            let name = format!("diagram-{}.png", self.document.media.len());
            self.document.media.insert(name.clone(), Arc::new(png));
            self.figure(name, width, height, &label)?;
            self.warn("diagram_normalized");
            continue;
          }
          self.warn("diagram_image_omitted");
          self.push(Paragraph::with_text(
            &format!("[Diagram source: {label}]\n{source}"),
            CharProps {
              font: Some(self.fonts.mono.clone()),
              ..Default::default()
            },
          ));
        }
        Block::Callout {
          block_id,
          text,
          children,
          native_callout,
          ..
        } => {
          if native_callout
            .kind
            .as_deref()
            .is_some_and(|kind| !matches!(kind, "" | "note"))
            || native_callout.foldable == Some(true)
          {
            self.warn("callout_variant_normalized");
          }
          let mut paragraph = self.paragraph(block_id, text)?.styled("MyoxusCallout");
          if let Some(title) = native_callout.title.as_ref().filter(|t| !t.is_empty()) {
            self.warn("callout_title_normalized");
            let label = if paragraph.text.is_empty() {
              title.clone()
            } else {
              format!("{title}\n")
            };
            paragraph
              .insert_text(
                0,
                &label,
                &CharProps {
                  bold: Some(true),
                  ..Default::default()
                },
              )
              .map_err(|_| ImportError::Conversion)?;
          }
          self.push(paragraph);
          let (indent, list_level) = (self.indent, self.list_level);
          self.indent += (self.list_level + 1) as f32 * super::CONTENT_INDENT;
          self.list_level = 0;
          self.blocks(children, depth + 1)?;
          (self.indent, self.list_level) = (indent, list_level);
        }
        Block::FootnoteDefinition {
          block_id,
          label,
          children,
          ..
        } => {
          if !self.in_note
            && let Some((id, _, _)) = self.notes.get(block_id).copied()
          {
            // Use the same block encoder and asset/numbering owners in the note
            // story, retaining rich bodies without duplicating main-body text.
            let outer = std::mem::take(&mut self.document.body);
            let (indent, list_level) = (self.indent, self.list_level);
            (self.indent, self.list_level) = (0.0, 0);
            self.in_note = true;
            self.blocks(children, depth + 1)?;
            let body = std::mem::replace(&mut self.document.body, outer);
            self.in_note = false;
            (self.indent, self.list_level) = (indent, list_level);
            self.document.parts.get_mut(&id).ok_or(ImportError::Conversion)?.blocks = body;
          } else {
            self.warn("footnote_body_normalized");
            self.push(Paragraph::with_text(&format!("[Note {label}]"), CharProps::default()));
            self.blocks(children, depth + 1)?;
          }
        }
        Block::BookmarkCard {
          block_id, title, url, ..
        } => {
          // A reading-IR attachment can look like a bookmark whose destination
          // is only a storage key. Without an admitted native fallback, neither
          // that key nor its cached filename is authorized portable content.
          if safe_link(Some(url)).is_none() {
            self.warn("media_reference_omitted");
            self.push(Paragraph::with_text("[Reference unavailable]", CharProps::default()));
            continue;
          }
          self.warn("bookmark_normalized");
          let link = self.link(Some(url));
          let paragraph = self.bookmarked(
            Paragraph::with_text(
              title,
              CharProps {
                link,
                ..Default::default()
              },
            ),
            block_id,
          )?;
          self.push(paragraph);
        }
        Block::TablePlaceholder { .. } | Block::UnsupportedBlock { .. } => self.warn("unsupported_block_omitted"),
      }
    }
    Ok(())
  }

  fn figure(&mut self, name: String, width: f32, height: f32, alt: &str) -> Result<(), ImportError> {
    let section = &self.document.last_section;
    let available_height = (section.page_h - section.margin_top - section.margin_bottom) * 0.9;
    let scale = (self.text_width() / width).min(available_height / height).min(1.0);
    let (width, height) = (width * scale, height * scale);
    let mut paragraph = Paragraph::new();
    paragraph.props.keep_next = Some(!alt.is_empty());
    paragraph
      .insert_object(
        0,
        InlineObject::Image {
          media: name,
          w: width,
          h: height,
          alt: alt.to_string(),
          float: Default::default(),
          crop: [0.0; 4],
          fx: Default::default(),
          ole: None,
        },
        &CharProps::default(),
      )
      .map_err(|_| ImportError::Conversion)?;
    self.push(paragraph);
    if !alt.is_empty() {
      self.push(Paragraph::with_text(alt, CharProps::default()).styled("Caption"));
    }
    Ok(())
  }

  fn document_image(&self, source: &[u8]) -> Option<(Vec<u8>, image::ImageFormat, u32, u32)> {
    if let Ok(format) = image::guess_format(source) {
      let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(source), format)
        .into_dimensions()
        .ok()?;
      if u64::from(width) * u64::from(height) > 32_000_000 {
        return None;
      }
      let mut reader = image::ImageReader::with_format(std::io::Cursor::new(source), format);
      let mut limits = image::Limits::default();
      limits.max_alloc = Some(128 * 1024 * 1024);
      reader.limits(limits);
      let image = reader.decode().ok()?;
      if u64::from(image.width()) * u64::from(image.height()) > 32_000_000 {
        return None;
      }
      if matches!(format, image::ImageFormat::Png | image::ImageFormat::Jpeg) {
        return Some((source.to_vec(), format, width, height));
      }
      let mut png = std::io::Cursor::new(Vec::new());
      image.write_to(&mut png, image::ImageFormat::Png).ok()?;
      return Some((png.into_inner(), image::ImageFormat::Png, width, height));
    }
    let (context, policy) = self.fonts.visuals.as_ref()?;
    context.rasterize_svg(source, policy).ok().and_then(|png| {
      let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(&png), image::ImageFormat::Png)
        .into_dimensions()
        .ok()?;
      Some((png, image::ImageFormat::Png, width, height))
    })
  }

  fn text_width(&self) -> f32 {
    let section = &self.document.last_section;
    (section.page_w
      - section.margin_left
      - section.margin_right
      - self.indent
      - self.list_level as f32 * super::CONTENT_INDENT)
      .max(36.0)
  }

  fn link(&mut self, value: Option<&str>) -> Option<String> {
    if let Some(value) = value.and_then(|value| value.strip_prefix("?blockIds=")) {
      let target = urlencoding::decode(value)
        .ok()
        .and_then(|id| self.block_bookmarks.get(id.as_ref()));
      if let Some(name) = target {
        return Some(format!("#{name}"));
      }
      self.warn("bookmark_target_normalized");
      return None;
    }
    let link = safe_link(value);
    if value.is_some() && link.is_none() {
      self.warn("link_destination_normalized");
    }
    link
  }

  fn image_fallback(&mut self, code: &'static str, alt: &str) {
    self.warn(code);
    if !alt.is_empty() {
      self.push(Paragraph::with_text(
        &format!("[Image unavailable: {alt}]"),
        CharProps::default(),
      ));
    }
  }
}

fn safe_link(value: Option<&str>) -> Option<String> {
  value
    .filter(|value| url::Url::parse(value).is_ok_and(|u| matches!(u.scheme(), "http" | "https" | "mailto")))
    .map(str::to_string)
}

#[cfg(test)]
mod figure_tests {
  use super::*;
  use myoxus_public_render::{
    PreparedPreviewContext, PreviewFont, PreviewPolicy, PreviewProjectionLimits, PreviewTheme,
  };

  #[test]
  fn theme_typography_and_compact_ruled_tables_keep_content_and_word_layout_contracts() {
    let mut builder = yjs::YjsDocumentBuilder::new("Styled content");
    builder.push_heading(1, &[yjs::YjsTextSegment::plain("Server heading")]);
    builder.push_table_with_header_rows(
      &[
        vec![
          vec![yjs::YjsTextSegment::plain("Column A")],
          vec![yjs::YjsTextSegment::plain("Column B")],
        ],
        vec![
          vec![yjs::YjsTextSegment::plain("Complete value A")],
          vec![yjs::YjsTextSegment::plain("Complete value B")],
        ],
      ],
      1,
    );
    let mut ir = crate::doc::content_projection::project_snapshot_for_export(
      uuid::Uuid::nil(),
      uuid::Uuid::new_v4(),
      "Styled content",
      &builder.encode(),
    )
    .unwrap();
    let Block::Table {
      appearance, density, ..
    } = &mut ir.document.blocks[1]
    else {
      panic!("Native table");
    };
    *appearance = Some(myoxus_public_render::ir::TableAppearance::Ruled);
    *density = Some(myoxus_public_render::ir::TableDensity::Compact);
    let style = |size, weight| ExportTypography {
      family: "Server Font".into(),
      style: myoxus_pdf_export::ir::ThemeTypographyStyle {
        font_weight: weight,
        font_style: "normal".into(),
        size_px: size,
        line_height: 1.4,
        letter_spacing_em: 0.0,
        text_transform: "none".into(),
        decoration: "none".into(),
      },
    };
    let output = encode_export(
      ExportSource {
        ir,
        images: BTreeMap::new(),
        warnings: BTreeMap::new(),
        references: Default::default(),
      },
      ExportFonts {
        body: "Server Font".into(),
        heading: "Server Font".into(),
        mono: "Server Mono".into(),
        visuals: None,
        typography: BTreeMap::from([
          ("Normal".into(), style(16.0, 400)),
          ("Heading1".into(), style(32.0, 700)),
        ]),
        table_fill: Some("#112233".into()),
        table_ink: Some("#ffffff".into()),
        table_rule: Some("#556677".into()),
      },
    )
    .unwrap();
    let word = wordcraft_docx::read(&output.bytes).unwrap();
    let heading = word.styles.get("Heading1").unwrap();
    assert_eq!(heading.chr.font.as_deref(), Some("Server Font"));
    assert_eq!(heading.chr.size, Some(24.0));
    assert_eq!(heading.chr.bold, Some(true));
    let wordcraft_doc::Block::Para(paragraph) = &*word.body[0] else {
      panic!("Heading paragraph");
    };
    assert_eq!(paragraph.final_text(), "Server heading");
    assert!(
      paragraph.runs.iter().all(|run| run.props.bold != Some(false)),
      "Unmarked source text must not cancel theme heading weight"
    );
    let wordcraft_doc::Block::Table(table) = &*word.body[1] else {
      panic!("Table");
    };
    assert!(table.rows[0].props.header && !table.rows[1].props.header);
    assert!(
      table.rows.iter().all(|row| row.props.cant_split),
      "Normal rows must not start continuation pages with detached value text"
    );
    assert_eq!(table.props.cell_margins, Some([3.0; 4]));
    assert!(table.props.borders.unwrap().between.unwrap().is_visible());
    assert!(!table.props.borders.unwrap().inside_v.unwrap().is_visible());
    assert_eq!(
      table.rows[0].cells[0].props.shading,
      wordcraft_doc::props::Rgb::parse("#112233")
    );
    let imported = super::super::prepare_docx(&output.bytes, "styled.docx").unwrap();
    let text = yjs::extract_text_from_yjs(&imported.snapshot).unwrap().markdown;
    for expected in [
      "Server heading",
      "Column A",
      "Column B",
      "Complete value A",
      "Complete value B",
    ] {
      assert!(text.contains(expected), "{expected}");
    }
  }

  #[test]
  fn diagram_and_svg_figures_carry_visible_media_captions_and_readable_failure_source() {
    let font = include_bytes!("../../../../static/fonts/inter-vf.ttf");
    let policy = PreviewPolicy {
      projection: PreviewProjectionLimits {
        max_input_bytes: 1_000_000,
        max_source_blocks: 100,
        max_projected_blocks: 30,
        max_text_chars: 4_000,
        max_depth: 16,
        max_table_rows: 4,
        max_table_columns: 4,
        max_visuals: 4,
      },
      max_font_bytes: font.len() + 1,
      max_media_bytes: 2_000_000,
      max_decoded_image_pixels: 4_000_000,
      max_svg_input_bytes: 2_000_000,
      max_mermaid_source_bytes: 20_000,
      max_mermaid_elements: 500,
      max_outlined_paths: 20_000,
      max_output_svg_bytes: 4_000_000,
      max_png_pixels: 4_000_000,
    };
    let context = PreparedPreviewContext::prepare(
      "test",
      PreviewTheme {
        background: "#ffffff".into(),
        surface: "#eeeeee".into(),
        text: "#222222".into(),
        muted: "#555555".into(),
        border: "#777777".into(),
        accent: "#336699".into(),
        body_font_family: "Inter".into(),
        heading_font_family: "Inter".into(),
        mono_font_family: "Inter".into(),
      },
      vec![PreviewFont { bytes: font.to_vec() }],
      &policy,
    )
    .unwrap();
    let mut builder = yjs::YjsDocumentBuilder::new("Figures");
    builder.push_mermaid(
      "flowchart LR\n A[Start] --> B[Finish]",
      "Useful diagram",
      "Diagram caption",
    );
    builder.push_image("native-svg", "Vector caption");
    builder.push_mermaid("flowchart TD\n A[", "Broken diagram", "Keep this fallback caption");
    let snapshot = builder.encode();
    let ir = crate::doc::content_projection::project_snapshot_for_export(
      uuid::Uuid::nil(),
      uuid::Uuid::new_v4(),
      "Figures",
      &snapshot,
    )
    .unwrap();
    let svg=br##"<svg xmlns="http://www.w3.org/2000/svg" width="180" height="90"><rect width="180" height="90" fill="#336699"/><circle cx="90" cy="45" r="30" fill="#ffffff"/></svg>"##.to_vec();
    let output = encode_export(
      ExportSource {
        ir,
        images: BTreeMap::from([("native-svg".into(), svg)]),
        warnings: BTreeMap::new(),
        references: Default::default(),
      },
      ExportFonts {
        body: "Inter".into(),
        heading: "Inter".into(),
        mono: "Inter".into(),
        visuals: Some((Arc::new(context), policy)),
        typography: BTreeMap::new(),
        table_fill: None,
        table_ink: None,
        table_rule: None,
      },
    )
    .unwrap();
    let word = wordcraft_docx::read(&output.bytes).unwrap();
    let images = word
      .body
      .iter()
      .filter_map(|block| match &**block {
        wordcraft_doc::Block::Para(paragraph) => Some(paragraph),
        _ => None,
      })
      .flat_map(|paragraph| &paragraph.objects)
      .filter_map(|object| match object {
        InlineObject::Image { media, w, h, alt, .. } => Some((media, w, h, alt)),
        _ => None,
      })
      .collect::<Vec<_>>();
    assert_eq!(images.len(), 2);
    for (media, w, h, alt) in images {
      let pixels = image::load_from_memory(&word.media[media]).unwrap().to_rgba8();
      assert!(pixels.pixels().any(|pixel| pixel.0[3] > 0));
      assert!((w / h - pixels.width() as f32 / pixels.height() as f32).abs() < 0.02);
      assert!(!alt.is_empty());
    }
    let body = word
      .body
      .iter()
      .filter_map(|block| match &**block {
        wordcraft_doc::Block::Para(paragraph) => Some(paragraph.final_text()),
        _ => None,
      })
      .collect::<String>();
    assert!(body.contains("Useful diagram\nDiagram caption"));
    assert!(body.contains("Vector caption"));
    assert!(body.contains("[Diagram source: Broken diagram\nKeep this fallback caption]\nflowchart TD\n A["));
    assert_eq!(
      output
        .warnings
        .iter()
        .find(|warning| warning.code == "diagram_normalized")
        .unwrap()
        .count,
      1
    );
    assert_eq!(
      output
        .warnings
        .iter()
        .find(|warning| warning.code == "diagram_image_omitted")
        .unwrap()
        .count,
      1
    );
    let imported = super::super::prepare_docx(&output.bytes, "figures.docx").unwrap();
    let reimported = yjs::extract_text_from_yjs(&imported.snapshot).unwrap();
    assert_eq!(
      reimported.markdown.matches("Vector caption").count(),
      1,
      "Image alternative text and ordinary matching Word caption are one native caption"
    );
    assert_eq!(reimported.markdown.matches("Diagram caption").count(), 1);
  }
}

#[cfg(test)]
pub(super) fn encode_test_snapshot(snapshot: &[u8], assets: &[super::Asset]) -> ExportedDocx {
  encode_test_snapshot_with_references(snapshot, assets, Default::default())
}

#[cfg(test)]
pub(super) fn encode_test_snapshot_with_references(
  snapshot: &[u8],
  assets: &[super::Asset],
  references: super::ExportReferencePresentation,
) -> ExportedDocx {
  let ir = crate::doc::content_projection::project_snapshot_for_export(
    uuid::Uuid::new_v4(),
    uuid::Uuid::new_v4(),
    "Fallback",
    snapshot,
  )
  .unwrap();
  encode_export(
    ExportSource {
      ir,
      images: assets
        .iter()
        .map(|asset| (asset.key.clone(), asset.bytes.to_vec()))
        .collect(),
      warnings: BTreeMap::new(),
      references,
    },
    ExportFonts {
      body: "Test Body".into(),
      heading: "Test Heading".into(),
      mono: "Test Mono".into(),
      visuals: None,
      typography: BTreeMap::new(),
      table_fill: None,
      table_ink: None,
      table_rule: None,
    },
  )
  .unwrap()
}
