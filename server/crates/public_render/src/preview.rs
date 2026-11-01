// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded browser-free Page preview rendering.
//!
//! The module consumes an already bounded [`PublicDocIr`] excerpt plus explicit
//! media and prepared fonts. It performs no storage, network, host-font or
//! configuration lookup, so API and future native adapters can share the same
//! deterministic render kernel without inheriting server state.

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use image::ImageFormat;
use myoxus_mermaid_render::{MermaidPreviewTheme, MermanSvgRenderer};
use thiserror::Error;
use tiny_skia::Pixmap;
use usvg::fontdb::{Database, Family, Query, Stretch, Style, Weight};
use usvg::{Options, Tree, WriteOptions};

use crate::ir::{TableAppearance, TableDensity};
use crate::{Block, InlineText, PreviewProjectionLimits, PublicDocIr, PublicListKind, RenderDiagnostic};

pub const PREVIEW_WIDTH: u32 = 640;
pub const PREVIEW_HEIGHT: u32 = 400;

// These are intrinsic image units: normal desktop cards display about half
// this width. Prefer a readable excerpt over miniature full-page typography.
const BODY_SIZE: f32 = 24.0;
const TABLE_SIZE: f32 = 22.0;
const CODE_SIZE: f32 = 20.0;
const LABEL_SIZE: f32 = 18.0;
const INDENT: usize = 32;

/// Operator-owned limits resolved before entering the render kernel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewPolicy {
  pub projection: PreviewProjectionLimits,
  pub max_font_bytes: usize,
  pub max_media_bytes: usize,
  pub max_decoded_image_pixels: u64,
  pub max_svg_input_bytes: usize,
  pub max_mermaid_source_bytes: usize,
  pub max_mermaid_elements: usize,
  pub max_outlined_paths: usize,
  pub max_output_svg_bytes: usize,
  pub max_png_pixels: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewTheme {
  pub background: String,
  pub surface: String,
  pub text: String,
  pub muted: String,
  pub border: String,
  pub accent: String,
  pub body_font_family: String,
  pub heading_font_family: String,
  pub mono_font_family: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewFont {
  pub bytes: Vec<u8>,
}

/// Parsed fonts and validated visual roles reused for every render at a theme
/// revision. The API host owns revision-keyed caching of this immutable value.
#[derive(Debug, Clone)]
pub struct PreparedPreviewContext {
  pub revision: String,
  theme: PreviewTheme,
  fontdb: Arc<Database>,
}

impl PreparedPreviewContext {
  pub fn prepare(
    revision: impl Into<String>,
    theme: PreviewTheme,
    fonts: Vec<PreviewFont>,
    policy: &PreviewPolicy,
  ) -> Result<Self, PreviewRenderError> {
    validate_theme(&theme)?;
    let total_bytes = fonts
      .iter()
      .try_fold(0usize, |sum, font| sum.checked_add(font.bytes.len()))
      .ok_or(PreviewRenderError::FontLimit)?;
    if fonts.is_empty() || total_bytes == 0 || total_bytes > policy.max_font_bytes {
      return Err(PreviewRenderError::FontLimit);
    }

    let mut fontdb = Database::new();
    for font in fonts {
      fontdb.load_font_data(font.bytes);
    }
    if fontdb.is_empty() {
      return Err(PreviewRenderError::InvalidFont);
    }
    for family in [
      &theme.body_font_family,
      &theme.heading_font_family,
      &theme.mono_font_family,
    ] {
      if !font_family_exists(&fontdb, family) {
        return Err(PreviewRenderError::MissingFontFamily(family.clone()));
      }
    }
    fontdb.set_sans_serif_family(theme.body_font_family.clone());
    fontdb.set_serif_family(theme.heading_font_family.clone());
    fontdb.set_monospace_family(theme.mono_font_family.clone());
    Ok(Self {
      revision: revision.into(),
      theme,
      fontdb: Arc::new(fontdb),
    })
  }

  fn options(&self) -> Options<'static> {
    Options {
      resources_dir: None,
      // A missing resource directory does not disable usvg's file resolver.
      // Only caller-supplied image data may enter the preview render kernel.
      image_href_resolver: usvg::ImageHrefResolver {
        resolve_string: Box::new(|_, _| None),
        ..usvg::ImageHrefResolver::default()
      },
      font_family: self.theme.body_font_family.clone(),
      fontdb: Arc::clone(&self.fontdb),
      ..Options::default()
    }
  }

  fn text_width(&self, text: &str, family: &str, size: f32, bold: bool, italic: bool) -> f32 {
    let query = Query {
      families: &[Family::Name(family)],
      weight: if bold { Weight::BOLD } else { Weight::NORMAL },
      stretch: Stretch::Normal,
      style: if italic { Style::Italic } else { Style::Normal },
    };
    let Some(id) = self.fontdb.query(&query) else {
      return f32::INFINITY;
    };
    self
      .fontdb
      .with_face_data(id, |bytes, index| {
        let Ok(face) = ttf_parser::Face::parse(bytes, index) else {
          return f32::INFINITY;
        };
        let units = f32::from(face.units_per_em());
        text
          .chars()
          .map(|character| {
            face
              .glyph_index(character)
              .and_then(|glyph| face.glyph_hor_advance(glyph))
              .map(f32::from)
              .unwrap_or(units * 0.6)
          })
          .sum::<f32>()
          * size
          / units
      })
      .unwrap_or(f32::INFINITY)
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewAssetKind {
  Raster,
  Svg,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewAsset {
  pub source: String,
  pub revision: String,
  pub kind: PreviewAssetKind,
  pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewOutputFormat {
  Svg,
  Png,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewOutput {
  pub bytes: Vec<u8>,
  pub mime_type: &'static str,
  pub width: u32,
  pub height: u32,
  /// Painted content bottom in intrinsic pixels, excluding the full-page background.
  pub content_height: u32,
  /// Content was omitted or simplified beyond the bounded excerpt.
  pub partial: bool,
  /// A projection or viewport budget cut off the excerpt.
  pub truncated: bool,
  pub diagnostics: Vec<RenderDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewOutputPair {
  pub svg: PreviewOutput,
  pub png: Option<PreviewOutput>,
}

#[derive(Debug, Error)]
pub enum PreviewRenderError {
  #[error("preview requires explicit valid theme colors")]
  InvalidTheme,
  #[error("preview font payload is empty or exceeds its configured byte limit")]
  FontLimit,
  #[error("preview font payload contains no usable face")]
  InvalidFont,
  #[error("preview font family is unavailable: {0}")]
  MissingFontFamily(String),
  #[error("only Page documents support generated previews")]
  UnsupportedMode,
  #[error("preview SVG normalization failed: {0}")]
  Svg(String),
  #[error("preview output exceeds its configured limit")]
  OutputLimit,
  #[error("preview PNG exceeds its configured pixel limit")]
  PngPixelLimit,
  #[error("preview PNG encoding failed: {0}")]
  Png(String),
}

/// Render one bounded Page excerpt to self-contained SVG or an optional PNG.
pub fn render_page_preview(
  ir: &PublicDocIr,
  assets: &[PreviewAsset],
  context: &PreparedPreviewContext,
  policy: &PreviewPolicy,
  format: PreviewOutputFormat,
) -> Result<PreviewOutput, PreviewRenderError> {
  let pair = render_page_preview_pair(ir, assets, context, policy, format == PreviewOutputFormat::Png)?;
  match format {
    PreviewOutputFormat::Svg => Ok(pair.svg),
    PreviewOutputFormat::Png => pair.png.ok_or(PreviewRenderError::PngPixelLimit),
  }
}

/// Render SVG and, when requested, its PNG derivative from one finalized tree.
/// This is the server cache entry point; it avoids repeating projection,
/// Mermaid layout, font outlining or SVG normalization for PNG requests.
pub fn render_page_preview_pair(
  ir: &PublicDocIr,
  assets: &[PreviewAsset],
  context: &PreparedPreviewContext,
  policy: &PreviewPolicy,
  include_png: bool,
) -> Result<PreviewOutputPair, PreviewRenderError> {
  if !ir.document.public_mode.eq_ignore_ascii_case("page") {
    return Err(PreviewRenderError::UnsupportedMode);
  }
  let assets = assets
    .iter()
    .map(|asset| (asset.source.as_str(), asset))
    .collect::<HashMap<_, _>>();
  let mut renderer = PageSvgRenderer {
    context,
    policy,
    assets,
    diagnostics: ir.diagnostics.clone(),
    backgrounds: String::new(),
    body: String::new(),
    y: BODY_SIZE + 2.0,
    viewport_truncated: false,
    outlined_glyphs: 0,
    visual_time: Duration::ZERO,
  };
  let layout_started = Instant::now();
  let mut blocks = ir.document.blocks.as_slice();
  // The card already names the document. Keep its excerpt for content rather
  // than repeating metadata and an identical opening heading inside the image.
  if let Some(Block::Heading { text, .. }) = blocks.first() {
    let heading: String = text.iter().map(|part| part.text.as_str()).collect();
    if heading.trim() == ir.document.title.trim() {
      blocks = &blocks[1..];
    }
  }
  if blocks.is_empty() {
    renderer.render_title(&ir.document.title);
  } else {
    renderer.render_blocks(blocks, 0);
  }
  let layout_time = layout_started.elapsed().saturating_sub(renderer.visual_time);
  let (svg, tree) = renderer.finish(ir.document.workspace_id, ir.document.doc_id)?;
  let content_height = tree
    .node_by_id("preview-content")
    .and_then(usvg::Node::abs_layer_bounding_box)
    .map(|bounds| bounds.bottom().ceil().clamp(1.0, PREVIEW_HEIGHT as f32) as u32)
    .ok_or_else(|| PreviewRenderError::Svg("finalized content bounds are unavailable".to_string()))?;
  tracing::debug!(
    target: "myoxus_preview_perf",
    workspace_id = %ir.document.workspace_id,
    doc_id = %ir.document.doc_id,
    layout_us = layout_time.as_micros() as u64,
    visual_us = renderer.visual_time.as_micros() as u64,
    output_bytes = svg.len(),
    "laid out preview content"
  );
  let diagnostics = renderer.diagnostics;
  // Diagnostic codes are renderer-owned; messages are not a transport contract.
  let truncated = diagnostics.iter().any(|diagnostic| {
    matches!(
      diagnostic.code.as_str(),
      "preview_viewport_truncated"
        | "preview_excerpt_truncated"
        | "preview_table_truncated"
        | "preview_depth_limit"
        | "preview_visual_limit"
    )
  });
  let partial = !diagnostics.is_empty();

  let svg_output = PreviewOutput {
    bytes: svg.into_bytes(),
    mime_type: "image/svg+xml",
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    content_height,
    partial,
    truncated,
    diagnostics: diagnostics.clone(),
  };
  let png_output = if include_png {
    let pixels = u64::from(PREVIEW_WIDTH) * u64::from(PREVIEW_HEIGHT);
    if pixels > policy.max_png_pixels {
      return Err(PreviewRenderError::PngPixelLimit);
    }
    let mut pixmap = Pixmap::new(PREVIEW_WIDTH, PREVIEW_HEIGHT).ok_or(PreviewRenderError::PngPixelLimit)?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    let bytes = pixmap
      .encode_png()
      .map_err(|error| PreviewRenderError::Png(error.to_string()))?;
    Some(PreviewOutput {
      bytes,
      mime_type: "image/png",
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
      content_height,
      partial,
      truncated,
      diagnostics,
    })
  } else {
    None
  };
  Ok(PreviewOutputPair {
    svg: svg_output,
    png: png_output,
  })
}

struct PageSvgRenderer<'a> {
  context: &'a PreparedPreviewContext,
  policy: &'a PreviewPolicy,
  assets: HashMap<&'a str, &'a PreviewAsset>,
  diagnostics: Vec<RenderDiagnostic>,
  backgrounds: String,
  body: String,
  y: f32,
  viewport_truncated: bool,
  outlined_glyphs: usize,
  visual_time: Duration,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct InlineStyle {
  bold: bool,
  italic: bool,
  strike: bool,
  code: bool,
  link: bool,
}

impl InlineStyle {
  fn plain() -> Self {
    Self {
      bold: false,
      italic: false,
      strike: false,
      code: false,
      link: false,
    }
  }
}

struct StyledText {
  text: String,
  style: InlineStyle,
}

struct NormalizedVisual {
  width: f32,
  height: f32,
  inner: String,
}

fn append_styled(line: &mut Vec<StyledText>, text: &str, style: InlineStyle) {
  if let Some(last) = line.last_mut() {
    if last.style == style {
      last.text.push_str(text);
      return;
    }
  }
  line.push(StyledText {
    text: text.to_string(),
    style,
  });
}

impl PageSvgRenderer<'_> {
  fn render_title(&mut self, title: &str) {
    self.y = 34.0;
    self.render_text_lines(title, 32.0, true, 600.0, 20.0, "heading");
    self.y += 8.0;
  }

  fn render_blocks(&mut self, blocks: &[Block], indent: usize) {
    for block in blocks {
      if self.y >= 390.0 {
        self.mark_viewport_truncated();
        break;
      }
      match block {
        Block::Paragraph { text, .. } => self.render_inline(text, BODY_SIZE, false, indent, None),
        Block::Heading { level, text, .. } => {
          let size = match level {
            1 => 30.0,
            2 => 27.0,
            _ => BODY_SIZE,
          };
          self.render_inline(text, size, true, indent, Some("heading"));
        }
        Block::Quote { text, .. } => {
          self.body.push_str(&format!(
            "<path d=\"M{} {}V{}\" stroke=\"{}\" stroke-width=\"3\"/>",
            20 + indent * INDENT,
            self.y - BODY_SIZE,
            (self.y + BODY_SIZE * 0.42).min(390.0),
            esc_attr(&self.context.theme.accent)
          ));
          self.render_inline(text, BODY_SIZE, false, indent + 1, None);
        }
        Block::Callout {
          title, text, children, ..
        } => {
          let start = self.y;
          let background_offset = self.backgrounds.len();
          if let Some(title) = title {
            self.render_inline(
              &[InlineText::plain(if title.is_empty() { "Note" } else { title })],
              BODY_SIZE,
              true,
              indent + 1,
              None,
            );
          }
          self.render_inline(text, BODY_SIZE, true, indent + 1, None);
          self.render_blocks(children, indent + 1);
          let height = (self.y - start + 6.0).max(26.0);
          self.backgrounds.insert_str(
            background_offset,
            &format!(
              "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"6\" fill=\"{}\" stroke=\"{}\"/>",
              16 + indent * INDENT,
              start - BODY_SIZE - 2.0,
              608usize.saturating_sub(indent * INDENT),
              height,
              esc_attr(&self.context.theme.surface),
              esc_attr(&self.context.theme.border)
            ),
          );
          self.y += 6.0;
        }
        Block::FootnoteDefinition {
          placement,
          number,
          children,
          ..
        } => {
          let name = crate::ir::local_note_name(*placement, *number, "en");
          self.render_text_lines(
            &name,
            LABEL_SIZE,
            true,
            580.0,
            28.0 + indent as f32 * INDENT as f32,
            "ui",
          );
          self.render_blocks(children, indent);
        }
        Block::List { list, .. } => {
          for (index, item) in list.items.iter().enumerate() {
            if self.y + BODY_SIZE * 0.42 > 390.0 {
              self.mark_viewport_truncated();
              break;
            }
            self.render_list_marker(list.kind, index, item.todo_checked.unwrap_or(false), indent);
            self.render_inline(&item.text, BODY_SIZE, false, indent + 1, None);
            self.render_blocks(&item.children, indent + 1);
          }
        }
        Block::Code { language, text, .. } => {
          let start = self.y;
          if let Some(language) = language {
            self.render_text_lines(
              language,
              LABEL_SIZE,
              true,
              580.0,
              28.0 + indent as f32 * INDENT as f32,
              "mono",
            );
          }
          for line in text.lines().take(5) {
            self.render_text_lines(
              line,
              CODE_SIZE,
              false,
              576.0,
              32.0 + indent as f32 * INDENT as f32,
              "mono",
            );
          }
          let height = (self.y - start + 8.0).max(28.0);
          self.backgrounds.push_str(&format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"5\" fill=\"{}\"/>",
            16 + indent * INDENT,
            start - CODE_SIZE - 2.0,
            608usize.saturating_sub(indent * INDENT),
            height,
            esc_attr(&self.context.theme.surface)
          ));
        }
        Block::Table {
          block_id,
          rows,
          header_rows,
          appearance,
          density,
        } => self.render_table(block_id, rows, *header_rows, *appearance, *density, indent),
        Block::TablePlaceholder { block_id } => {
          self.diagnostics.push(RenderDiagnostic {
            code: "preview_table_placeholder".to_string(),
            message: "A table could not be represented in the bounded preview.".to_string(),
            block_id: Some(block_id.clone()),
          });
          self.render_placeholder(indent);
        }
        Block::Divider { .. } => {
          self.body.push_str(&format!(
            "<path d=\"M20 {}H620\" stroke=\"{}\"/>",
            self.y,
            esc_attr(&self.context.theme.border)
          ));
          self.y += 12.0;
        }
        Block::Image { block_id, asset } => self.render_asset(block_id, &asset.source, indent),
        Block::Mermaid {
          block_id,
          source,
          title,
          caption,
        } => self.render_mermaid(block_id, source, title, caption, indent),
        Block::BookmarkCard { title, url, .. } => {
          let label = if title.trim().is_empty() { url } else { title };
          self.render_text_lines(
            label,
            BODY_SIZE,
            true,
            570.0,
            28.0 + indent as f32 * INDENT as f32,
            "body",
          );
        }
        Block::UnsupportedBlock { block_id, flavour } => {
          if !self
            .diagnostics
            .iter()
            .any(|item| item.block_id.as_deref() == Some(block_id))
          {
            self.diagnostics.push(RenderDiagnostic {
              code: "preview_unsupported_block".to_string(),
              message: format!("Block flavour '{flavour}' was omitted from the preview."),
              block_id: Some(block_id.clone()),
            });
          }
          self.render_placeholder(indent);
        }
      }
    }
  }

  fn render_inline(&mut self, text: &[InlineText], size: f32, bold: bool, indent: usize, role: Option<&str>) {
    // A distinct opening heading can be taller than the body-text baseline.
    self.y = self.y.max(size + 2.0);
    let x = 20.0 + indent as f32 * INDENT as f32;
    let width = 600.0 - indent as f32 * INDENT as f32;
    let family = if role == Some("heading") {
      &self.context.theme.heading_font_family
    } else {
      &self.context.theme.body_font_family
    };
    let Some(lines) = self.wrap_inline(text, size, bold, family, width) else {
      self.mark_viewport_truncated();
      return;
    };
    for line in &lines {
      if !self.push_inline_line(line, x, size, family) {
        self.mark_viewport_truncated();
        return;
      }
    }
  }

  // Layout is shared by paragraphs and cells so both preserve attributed word
  // boundaries and can be measured before a table row is admitted to the image.
  fn wrap_inline(
    &self,
    text: &[InlineText],
    size: f32,
    bold: bool,
    family: &str,
    width: f32,
  ) -> Option<Vec<Vec<StyledText>>> {
    let chars: Vec<_> = text
      .iter()
      .flat_map(|part| {
        let style = InlineStyle {
          bold: bold || part.bold,
          italic: part.italic,
          strike: part.strike,
          code: part.code,
          link: part.link.is_some(),
        };
        part.text.chars().map(move |character| (character, style))
      })
      .collect();
    let mut lines = Vec::new();
    let mut line = Vec::new();
    let mut line_width = 0.0;
    let mut index = 0;
    while index < chars.len() {
      let (character, style) = chars[index];
      if character == '\n' {
        lines.push(std::mem::take(&mut line));
        line_width = 0.0;
        index += 1;
        continue;
      }
      if character.is_whitespace() {
        // Collapsible whitespace at a wrap edge is layout, not part of a mark.
        if !line.is_empty() {
          let space = self.inline_width(" ", style, family, size);
          if line_width + space <= width {
            append_styled(&mut line, " ", style);
            line_width += space;
          }
        }
        index += 1;
        continue;
      }
      let start = index;
      let mut word = Vec::new();
      let mut word_width = 0.0;
      while index < chars.len() && !chars[index].0.is_whitespace() {
        let (character, style) = chars[index];
        append_styled(&mut word, &character.to_string(), style);
        index += 1;
      }
      for part in &word {
        word_width += self.inline_width(&part.text, part.style, family, size);
      }
      if line_width + word_width > width && !line.is_empty() {
        lines.push(std::mem::take(&mut line));
        line_width = 0.0;
      }
      if word_width <= width {
        for part in word {
          append_styled(&mut line, &part.text, part.style);
        }
        line_width += word_width;
      } else {
        // Long unbroken tokens wrap at characters; never silently replace the suffix.
        for &(character, style) in &chars[start..index] {
          let character_width = self.inline_width(&character.to_string(), style, family, size);
          if line_width + character_width > width && !line.is_empty() {
            lines.push(std::mem::take(&mut line));
            line_width = 0.0;
          }
          if character_width > width {
            // A glyph wider than the available cell is not silently discarded.
            return None;
          }
          append_styled(&mut line, &character.to_string(), style);
          line_width += character_width;
        }
      }
    }
    if !line.is_empty() {
      lines.push(line);
    }
    Some(lines)
  }

  fn inline_width(&self, text: &str, style: InlineStyle, family: &str, size: f32) -> f32 {
    let family = if style.code {
      &self.context.theme.mono_font_family
    } else {
      family
    };
    self.context.text_width(text, family, size, style.bold, style.italic)
  }

  fn push_inline_line(&mut self, line: &[StyledText], x: f32, size: f32, family: &str) -> bool {
    if self.y + size * 0.42 > 390.0 {
      return false;
    }
    self.paint_inline_line(line, x, self.y, size, family);
    self.y += size * 1.42;
    true
  }

  fn paint_inline_line(&mut self, line: &[StyledText], x: f32, baseline: f32, size: f32, family: &str) {
    let mut cursor = x;
    for part in line {
      let font = if part.style.code {
        &self.context.theme.mono_font_family
      } else {
        family
      };
      let width = self.inline_width(&part.text, part.style, family, size);
      if part.style.code {
        self.backgrounds.push_str(&format!(
          "<rect x=\"{cursor}\" y=\"{}\" width=\"{width}\" height=\"{}\" fill=\"{}\"/>",
          baseline - size,
          size * 1.25,
          esc_attr(&self.context.theme.surface)
        ));
      }
      self.outlined_glyphs = self.outlined_glyphs.saturating_add(part.text.chars().count());
      self.body.push_str(&format!(
        "<text x=\"{cursor}\" y=\"{}\" font-family=\"{}\" font-size=\"{size}\" font-weight=\"{}\" font-style=\"{}\" fill=\"{}\">{}</text>",
        baseline,
        esc_attr(font),
        if part.style.bold { 700 } else { 400 },
        if part.style.italic { "italic" } else { "normal" },
        esc_attr(if part.style.link { &self.context.theme.accent } else { &self.context.theme.text }),
        esc(&part.text)
      ));
      if part.style.strike || part.style.link {
        let rule_y = if part.style.strike {
          baseline - size * 0.3
        } else {
          baseline + size * 0.1
        };
        self.body.push_str(&format!(
          "<path d=\"M{cursor} {rule_y}h{width}\" stroke=\"{}\" stroke-width=\"1\"/>",
          esc_attr(if part.style.link {
            &self.context.theme.accent
          } else {
            &self.context.theme.text
          })
        ));
      }
      cursor += width;
    }
  }

  fn render_list_marker(&mut self, kind: PublicListKind, index: usize, checked: bool, indent: usize) {
    let x = 22.0 + indent as f32 * INDENT as f32;
    match kind {
      PublicListKind::Bulleted => self.body.push_str(&format!(
        "<circle cx=\"{}\" cy=\"{}\" r=\"4\" fill=\"{}\"/>",
        x + 8.0,
        self.y - 8.0,
        esc_attr(&self.context.theme.text)
      )),
      PublicListKind::Todo => {
        self.body.push_str(&format!(
          "<rect x=\"{x}\" y=\"{}\" width=\"18\" height=\"18\" rx=\"2\" fill=\"{}\" stroke=\"{}\"/>",
          self.y - 19.0,
          if checked {
            esc_attr(&self.context.theme.accent)
          } else {
            "none".to_string()
          },
          esc_attr(&self.context.theme.border)
        ));
        if checked {
          self.body.push_str(&format!(
            "<path d=\"M{} {}l4 4 8-9\" fill=\"none\" stroke=\"{}\" stroke-width=\"2\"/>",
            x + 3.0,
            self.y - 10.0,
            esc_attr(&self.context.theme.background)
          ));
        }
      }
      PublicListKind::Numbered => {
        let marker = format!("{}.", index + 1);
        self.outlined_glyphs = self.outlined_glyphs.saturating_add(marker.chars().count());
        self.body.push_str(&format!(
          "<text x=\"{x}\" y=\"{}\" font-family=\"{}\" font-size=\"{CODE_SIZE}\" fill=\"{}\">{marker}</text>",
          self.y,
          esc_attr(&self.context.theme.body_font_family),
          esc_attr(&self.context.theme.text),
        ));
      }
    }
  }

  fn render_text_lines(&mut self, text: &str, size: f32, bold: bool, max_width: f32, x: f32, role: &str) {
    let max_width = max_width.min(620.0 - x);
    if max_width <= 0.0 {
      self.mark_viewport_truncated();
      return;
    }
    let family = match role {
      "heading" => &self.context.theme.heading_font_family,
      "mono" => &self.context.theme.mono_font_family,
      _ => &self.context.theme.body_font_family,
    };
    let mut line = String::new();
    let mut emitted = false;
    let mut words = text.split_whitespace().peekable();
    while let Some(word) = words.next() {
      if line.is_empty() && self.context.text_width(word, family, size, bold, false) > max_width {
        let clipped = clip_to_width(self.context, word, family, size, max_width);
        self.push_text(&clipped, x, size, bold, family);
        self.mark_viewport_truncated();
        emitted = true;
        if self.y >= 390.0 {
          return;
        }
        continue;
      }
      let candidate = if line.is_empty() {
        word.to_string()
      } else {
        format!("{line} {word}")
      };
      if !line.is_empty() && self.context.text_width(&candidate, family, size, bold, false) > max_width {
        self.push_text(&line, x, size, bold, family);
        emitted = true;
        line = word.to_string();
        if self.y >= 390.0 {
          if words.peek().is_some() || !line.is_empty() {
            self.mark_viewport_truncated();
          }
          return;
        }
      } else {
        line = candidate;
      }
    }
    if !line.is_empty() {
      if self.context.text_width(&line, family, size, bold, false) > max_width {
        line = clip_to_width(self.context, &line, family, size, max_width);
        self.mark_viewport_truncated();
      }
      self.push_text(&line, x, size, bold, family);
    } else if !emitted && !text.is_empty() {
      self.push_text(text, x, size, bold, family);
    }
  }

  fn push_text(&mut self, text: &str, x: f32, size: f32, bold: bool, family: &str) {
    if self.y + size * 0.42 > 390.0 {
      self.mark_viewport_truncated();
      return;
    }
    self.outlined_glyphs = self.outlined_glyphs.saturating_add(text.chars().count());
    self.body.push_str(&format!(
      "<text x=\"{x}\" y=\"{}\" font-family=\"{}\" font-size=\"{size}\" font-weight=\"{}\" fill=\"{}\">{}</text>",
      self.y,
      esc_attr(family),
      if bold { 700 } else { 400 },
      esc_attr(&self.context.theme.text),
      esc(text)
    ));
    self.y += size * 1.42;
  }

  fn render_table(
    &mut self,
    block_id: &str,
    rows: &[Vec<Vec<InlineText>>],
    header_rows: Option<usize>,
    appearance: Option<TableAppearance>,
    density: Option<TableDensity>,
    indent: usize,
  ) {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    if columns == 0 {
      return;
    }
    let x = 20.0 + indent as f32 * INDENT as f32;
    let width = 600.0 - indent as f32 * INDENT as f32;
    let column_width = width / columns as f32;
    let padding = if density == Some(TableDensity::Compact) {
      4.0
    } else {
      6.0
    };
    let size = TABLE_SIZE;
    let line_height = size * 1.42;
    let headers = header_rows.unwrap_or(0).min(rows.len());
    let family = &self.context.theme.body_font_family;
    for (row_index, row) in rows.iter().enumerate() {
      // Measure every admitted cell before painting any part of this row.
      let mut cells = Vec::with_capacity(columns);
      for column in 0..columns {
        let Some(lines) = self.wrap_inline(
          row.get(column).map(Vec::as_slice).unwrap_or_default(),
          size,
          row_index < headers,
          family,
          column_width - padding * 2.0,
        ) else {
          self.mark_table_truncated(block_id);
          self.y = 390.0;
          return;
        };
        cells.push(lines);
      }
      let lines = cells.iter().map(Vec::len).max().unwrap_or(0).max(1);
      let height = lines as f32 * line_height + padding * 2.0;
      let baseline_offset = size + 1.0;
      let top = self.y - baseline_offset;
      if top + height > 390.0 {
        self.mark_table_truncated(block_id);
        // Preserve the table position when the first data row cannot fit.
        if top < 390.0 {
          let mark_height = line_height;
          let corner_width = size + padding * 2.0;
          let (mark_x, mark_y, mark_width) = if top + mark_height <= 390.0 {
            (x, top, width)
          } else {
            // The header reaches the edge: use its trailing corner rather
            // than painting a partial row over the next block.
            (x + width - corner_width, (top - mark_height).max(0.0), corner_width)
          };
          self.backgrounds.push_str(&format!(
            "<rect x=\"{mark_x}\" y=\"{mark_y}\" width=\"{mark_width}\" height=\"{mark_height}\" fill=\"{}\"/>",
            esc_attr(&self.context.theme.surface)
          ));
          self.paint_inline_line(
            &[StyledText {
              text: "…".to_string(),
              style: InlineStyle::plain(),
            }],
            mark_x + padding,
            mark_y + size,
            size,
            family,
          );
        }
        self.y = 390.0;
        break;
      }
      for (column, cell) in cells.iter().enumerate() {
        let left = x + column as f32 * column_width;
        if row_index < headers {
          self.backgrounds.push_str(&format!(
            "<rect x=\"{left}\" y=\"{top}\" width=\"{column_width}\" height=\"{height}\" fill=\"{}\"/>",
            esc_attr(&self.context.theme.surface)
          ));
        }
        match appearance.unwrap_or(TableAppearance::Grid) {
          TableAppearance::Grid => self.body.push_str(&format!(
            "<rect x=\"{left}\" y=\"{top}\" width=\"{column_width}\" height=\"{height}\" fill=\"none\" stroke=\"{}\"/>",
            esc_attr(&self.context.theme.border)
          )),
          TableAppearance::Ruled => self.body.push_str(&format!(
            "<path d=\"M{left} {}h{column_width}\" stroke=\"{}\"/>",
            top + height,
            esc_attr(&self.context.theme.border)
          )),
          TableAppearance::Plain => {}
        }
        for (line_index, line) in cell.iter().enumerate() {
          self.paint_inline_line(
            line,
            left + padding,
            top + padding + size + line_index as f32 * line_height,
            size,
            family,
          );
        }
      }
      self.y = top + height + baseline_offset;
    }
    self.y += 6.0;
  }

  fn mark_table_truncated(&mut self, block_id: &str) {
    self.diagnostics.push(RenderDiagnostic {
      code: "preview_table_truncated".to_string(),
      message: "A complete table row did not fit in the preview viewport.".to_string(),
      block_id: Some(block_id.to_string()),
    });
  }

  fn mark_viewport_truncated(&mut self) {
    if self.viewport_truncated {
      return;
    }
    self.viewport_truncated = true;
    self.diagnostics.push(RenderDiagnostic {
      code: "preview_viewport_truncated".to_string(),
      message: "Remaining Page content was omitted after the preview viewport was filled.".to_string(),
      block_id: None,
    });
  }

  fn render_placeholder(&mut self, indent: usize) {
    if self.y + 24.0 > 390.0 {
      self.mark_viewport_truncated();
      return;
    }
    let x = 20 + indent * INDENT;
    let width = 600usize.saturating_sub(indent * INDENT);
    self.backgrounds.push_str(&format!(
      "<rect x=\"{x}\" y=\"{}\" width=\"{width}\" height=\"32\" rx=\"4\" fill=\"{}\" stroke=\"{}\" stroke-dasharray=\"4 3\"/>",
      self.y - 14.0,
      esc_attr(&self.context.theme.surface),
      esc_attr(&self.context.theme.border)
    ));
    self.outlined_glyphs += 1;
    self.body.push_str(&format!(
      "<text x=\"{}\" y=\"{}\" font-family=\"{}\" font-size=\"{LABEL_SIZE}\" fill=\"{}\">…</text>",
      x + 12,
      self.y + 5.0,
      esc_attr(&self.context.theme.body_font_family),
      esc_attr(&self.context.theme.muted)
    ));
    self.y += 40.0;
  }

  fn render_asset(&mut self, block_id: &str, source: &str, indent: usize) {
    let Some(asset) = self.assets.get(source).copied() else {
      self.diagnostics.push(RenderDiagnostic {
        code: "preview_media_missing".to_string(),
        message: "Referenced image bytes were not resolved for preview.".to_string(),
        block_id: Some(block_id.to_string()),
      });
      self.render_placeholder(indent);
      return;
    };
    let started = Instant::now();
    match normalized_visual(asset, self.context, self.policy, block_id) {
      Ok(visual) => self.embed_visual(&visual, indent),
      Err(diagnostic) => {
        self.diagnostics.push(diagnostic);
        self.render_placeholder(indent);
      }
    }
    self.visual_time += started.elapsed();
  }

  fn render_mermaid(&mut self, block_id: &str, source: &str, title: &str, caption: &str, indent: usize) {
    if source.len() > self.policy.max_mermaid_source_bytes
      || mermaid_element_count(source) > self.policy.max_mermaid_elements
    {
      self.diagnostics.push(RenderDiagnostic {
        code: "preview_mermaid_limit".to_string(),
        message: "Mermaid source exceeds the configured preview complexity limit.".to_string(),
        block_id: Some(block_id.to_string()),
      });
      self.render_placeholder(indent);
      return;
    }
    if !title.trim().is_empty() {
      self.render_text_lines(
        title,
        TABLE_SIZE,
        true,
        590.0,
        24.0 + indent as f32 * INDENT as f32,
        "body",
      );
    }
    let started = Instant::now();
    let svg = match MermanSvgRenderer.render_svg_with_preview_theme(
      source,
      &format!("preview-{block_id}"),
      MermaidPreviewTheme {
        font_family: &self.context.theme.body_font_family,
        background: &self.context.theme.background,
        text_color: &self.context.theme.text,
        primary_color: &self.context.theme.surface,
        primary_border_color: &self.context.theme.border,
        line_color: &self.context.theme.muted,
      },
    ) {
      Ok(svg) => svg,
      Err(error) => {
        self.visual_time += started.elapsed();
        self.diagnostics.push(RenderDiagnostic {
          code: "preview_mermaid_unsupported".to_string(),
          message: error.to_string(),
          block_id: Some(block_id.to_string()),
        });
        self.render_placeholder(indent);
        return;
      }
    };
    match normalized_svg(svg.as_bytes(), self.context, self.policy, block_id) {
      Ok(visual) => {
        let before = self.y;
        self.embed_visual(&visual, indent);
        if self.y > before {
          let marker_x = 600usize.saturating_sub(indent * INDENT);
          self.outlined_glyphs += 1;
          self.body.push_str(&format!(
            "<text x=\"{marker_x}\" y=\"{}\" font-family=\"{}\" font-size=\"13\" fill=\"{}\">≈</text>",
            before,
            esc_attr(&self.context.theme.body_font_family),
            esc_attr(&self.context.theme.muted)
          ));
          self.diagnostics.push(RenderDiagnostic {
            code: "preview_mermaid_simplified".to_string(),
            message: "Server-rendered diagram omits native editor presentation.".to_string(),
            block_id: Some(block_id.to_string()),
          });
        }
      }
      Err(diagnostic) => {
        self.diagnostics.push(diagnostic);
        self.render_placeholder(indent);
      }
    }
    self.visual_time += started.elapsed();
    if !caption.trim().is_empty() && self.y < 385.0 {
      self.render_text_lines(
        caption,
        LABEL_SIZE,
        false,
        590.0,
        24.0 + indent as f32 * INDENT as f32,
        "body",
      );
    }
  }

  fn embed_visual(&mut self, visual: &NormalizedVisual, indent: usize) {
    let available_height = (392.0 - self.y).max(0.0);
    if available_height <= 0.0 || visual.width <= 0.0 || visual.height <= 0.0 {
      self.mark_viewport_truncated();
      return;
    }
    let x = 20 + indent * INDENT;
    let width = 600usize.saturating_sub(indent * INDENT);
    // Fit once inside the remaining Page budget. The source dimensions, not a
    // pre-scaled 180-unit thumbnail, determine the visible diagram proportions.
    let scale = (width as f32 / visual.width).min(available_height / visual.height);
    let height = visual.height * scale;
    let drawn_width = visual.width * scale;
    self.body.push_str(&format!(
      "<svg x=\"{x}\" y=\"{}\" width=\"{drawn_width}\" height=\"{height}\" viewBox=\"0 0 {} {}\" preserveAspectRatio=\"xMinYMin meet\">{}</svg>",
      self.y - 14.0,
      visual.width,
      visual.height,
      visual.inner
    ));
    self.y += height + 8.0;
  }

  fn finish(&self, workspace_id: uuid::Uuid, doc_id: uuid::Uuid) -> Result<(String, Tree), PreviewRenderError> {
    let started = Instant::now();
    let raw = format!(
      // Normalized embedded images use xlink:href after their source SVG root
      // has been removed. Bind the prefix on the composed document as well.
      "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{PREVIEW_WIDTH}\" height=\"{PREVIEW_HEIGHT}\" viewBox=\"0 0 {PREVIEW_WIDTH} {PREVIEW_HEIGHT}\"><rect width=\"{PREVIEW_WIDTH}\" height=\"{PREVIEW_HEIGHT}\" fill=\"{}\"/><g id=\"preview-content\">{}{}</g></svg>",
      esc_attr(&self.context.theme.background),
      self.backgrounds,
      self.body
    );
    if raw.len() > self.policy.max_output_svg_bytes {
      return Err(PreviewRenderError::OutputLimit);
    }
    if raw.matches("<path").count().saturating_add(self.outlined_glyphs) > self.policy.max_outlined_paths {
      return Err(PreviewRenderError::OutputLimit);
    }
    let options = self.context.options();
    let outline_started = Instant::now();
    let tree = Tree::from_str(&raw, &options).map_err(|error| PreviewRenderError::Svg(error.to_string()))?;
    let outline_time = outline_started.elapsed();
    let mut svg = tree.to_string(&WriteOptions {
      id_prefix: Some("preview-".to_string()),
      preserve_text: false,
      ..WriteOptions::default()
    });
    if !svg.starts_with("<svg ") {
      return Err(PreviewRenderError::Svg("normalized output has no SVG root".to_string()));
    }
    if !svg[..svg.find('>').unwrap_or(svg.len())].contains("viewBox=") {
      svg.insert_str(4, " viewBox=\"0 0 640 400\"");
    }
    validate_final_svg(&svg, self.policy)?;
    tracing::debug!(
      target: "myoxus_preview_perf",
      %workspace_id,
      %doc_id,
      outline_us = outline_time.as_micros() as u64,
      serialization_us = started.elapsed().saturating_sub(outline_time).as_micros() as u64,
      "finalized preview SVG"
    );
    Ok((svg, tree))
  }
}

fn normalized_visual(
  asset: &PreviewAsset,
  context: &PreparedPreviewContext,
  policy: &PreviewPolicy,
  block_id: &str,
) -> Result<NormalizedVisual, RenderDiagnostic> {
  if asset.bytes.len() > policy.max_media_bytes {
    return Err(media_diagnostic(
      block_id,
      "preview_media_limit",
      "Image exceeds the configured byte limit.",
    ));
  }
  match asset.kind {
    PreviewAssetKind::Svg => normalized_svg(&asset.bytes, context, policy, block_id),
    PreviewAssetKind::Raster => {
      let reader = image::ImageReader::new(Cursor::new(&asset.bytes))
        .with_guessed_format()
        .map_err(|_| media_diagnostic(block_id, "preview_media_invalid", "Image format could not be detected."))?;
      let (width, height) = reader
        .into_dimensions()
        .map_err(|_| media_diagnostic(block_id, "preview_media_invalid", "Image dimensions could not be read."))?;
      let pixels = u64::from(width).saturating_mul(u64::from(height));
      if pixels > policy.max_decoded_image_pixels {
        return Err(media_diagnostic(
          block_id,
          "preview_media_pixel_limit",
          "Image dimensions exceed the configured decoded-pixel limit.",
        ));
      }
      let image = image::load_from_memory(&asset.bytes)
        .map_err(|_| media_diagnostic(block_id, "preview_media_invalid", "Image could not be decoded."))?;
      let image = image.thumbnail(600, image.height());
      let mut png = Cursor::new(Vec::new());
      image
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|_| media_diagnostic(block_id, "preview_media_invalid", "Image could not be normalized."))?;
      let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
      let inner = format!(
        "<image width=\"{}\" height=\"{}\" href=\"data:image/png;base64,{encoded}\"/>",
        image.width(),
        image.height()
      );
      Ok(NormalizedVisual {
        width: image.width() as f32,
        height: image.height() as f32,
        inner,
      })
    }
  }
}

fn normalized_svg(
  bytes: &[u8],
  context: &PreparedPreviewContext,
  policy: &PreviewPolicy,
  block_id: &str,
) -> Result<NormalizedVisual, RenderDiagnostic> {
  if bytes.is_empty() || bytes.len() > policy.max_svg_input_bytes {
    return Err(media_diagnostic(
      block_id,
      "preview_svg_limit",
      "SVG exceeds the configured input limit.",
    ));
  }
  let lower = String::from_utf8_lossy(bytes).to_ascii_lowercase();
  if lower
    .matches("<path")
    .count()
    .saturating_add(lower.matches(":path").count())
    > policy.max_outlined_paths
  {
    return Err(media_diagnostic(
      block_id,
      "preview_svg_path_limit",
      "SVG exceeds the configured path-complexity limit.",
    ));
  }
  let options = context.options();
  let tree = Tree::from_data(bytes, &options)
    .map_err(|_| media_diagnostic(block_id, "preview_svg_invalid", "SVG could not be normalized safely."))?;
  let size = tree.size();
  let svg = tree.to_string(&WriteOptions {
    id_prefix: Some(format!("preview-{block_id}-")),
    preserve_text: false,
    ..WriteOptions::default()
  });
  let inner = svg
    .split_once('>')
    .and_then(|(_, rest)| rest.rsplit_once("</svg>").map(|(inner, _)| inner.to_string()))
    .ok_or_else(|| media_diagnostic(block_id, "preview_svg_invalid", "Normalized SVG has no valid root."))?;
  Ok(NormalizedVisual {
    width: size.width(),
    height: size.height(),
    inner,
  })
}

fn validate_theme(theme: &PreviewTheme) -> Result<(), PreviewRenderError> {
  let valid_color = |value: &str| {
    value
      .strip_prefix('#')
      .is_some_and(|hex| matches!(hex.len(), 6 | 8) && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
  };
  if [
    &theme.background,
    &theme.surface,
    &theme.text,
    &theme.muted,
    &theme.border,
    &theme.accent,
  ]
  .into_iter()
  .all(|value| valid_color(value))
  {
    Ok(())
  } else {
    Err(PreviewRenderError::InvalidTheme)
  }
}

fn font_family_exists(fontdb: &Database, family: &str) -> bool {
  fontdb
    .faces()
    .any(|face| face.families.iter().any(|(name, _)| name.eq_ignore_ascii_case(family)))
}

fn clip_to_width(context: &PreparedPreviewContext, value: &str, family: &str, size: f32, width: f32) -> String {
  if context.text_width(value, family, size, false, false) <= width {
    return value.to_string();
  }
  let mut clipped = String::new();
  for character in value.chars() {
    let candidate = format!("{clipped}{character}…");
    if context.text_width(&candidate, family, size, false, false) > width {
      break;
    }
    clipped.push(character);
  }
  clipped.push('…');
  clipped
}

fn mermaid_element_count(source: &str) -> usize {
  let lines = source
    .lines()
    .filter(|line| {
      let line = line.trim();
      !line.is_empty() && !line.starts_with("%%") && !line.starts_with("flowchart") && !line.starts_with("graph")
    })
    .count();
  let syntax = ["-->", "---", "-.->", "==>", "[[", "[(", "((", "{{", "[/"]
    .into_iter()
    .map(|token| source.matches(token).count())
    .sum::<usize>();
  lines.saturating_add(syntax)
}

fn validate_final_svg(svg: &str, policy: &PreviewPolicy) -> Result<(), PreviewRenderError> {
  if svg.len() > policy.max_output_svg_bytes {
    return Err(PreviewRenderError::OutputLimit);
  }
  let lower = svg.to_ascii_lowercase();
  let has_expected_view_box = usvg::roxmltree::Document::parse(svg)
    .ok()
    .and_then(|document| {
      let root = document.root_element();
      root.attribute("viewBox").map(|value| {
        value
          .split(|character: char| character.is_ascii_whitespace() || character == ',')
          .filter(|part| !part.is_empty())
          .filter_map(|part| part.parse::<f32>().ok())
          .collect::<Vec<_>>()
      })
    })
    .is_some_and(|parts| parts == [0.0, 0.0, PREVIEW_WIDTH as f32, PREVIEW_HEIGHT as f32]);
  let mut violations = Vec::new();
  for (violated, name) in [
    (!has_expected_view_box, "viewBox"),
    (lower.contains("<script"), "script"),
    (lower.contains("<foreignobject"), "foreignObject"),
    (lower.contains("<text"), "text"),
    (lower.contains("file:"), "file URL"),
    (lower.contains("javascript:"), "JavaScript URL"),
    (lower.contains(" onload="), "onload handler"),
    (lower.contains(" onclick="), "onclick handler"),
  ] {
    if violated {
      violations.push(name);
    }
  }
  if !violations.is_empty() {
    return Err(PreviewRenderError::Svg(format!(
      "final output violates: {}",
      violations.join(", ")
    )));
  }
  for fragment in lower.split("href=\"").skip(1) {
    let value = fragment.split('"').next().unwrap_or_default();
    if !value.starts_with("data:image/") && !value.starts_with('#') {
      return Err(PreviewRenderError::Svg(
        "final output contains an external resource".to_string(),
      ));
    }
  }
  if lower.matches("<path").count() > policy.max_outlined_paths {
    return Err(PreviewRenderError::OutputLimit);
  }
  Ok(())
}

fn media_diagnostic(block_id: &str, code: &str, message: &str) -> RenderDiagnostic {
  RenderDiagnostic {
    code: code.to_string(),
    message: message.to_string(),
    block_id: Some(block_id.to_string()),
  }
}

fn esc(value: &str) -> String {
  v_htmlescape::escape(value).to_string()
}

fn esc_attr(value: &str) -> String {
  v_htmlescape::escape(value).to_string()
}
