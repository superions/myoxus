// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native presentation projected into ordinary, editable Word formatting.

use super::*;
use wordcraft_doc::props::{Align, LineSpacing};

/// Reuse the already captured native snapshot for properties absent from the
/// reading IR. Opaque document/Database references retain the inventory boundary.
pub(in crate::docx) fn enrich_presentation(ir: &mut PublicDocIr, snapshot: Option<&serde_json::Value>) {
  let Some(snapshot) = snapshot else { return };
  for block in crate::docx::references::native_content_blocks(snapshot) {
    let Some(id) = block["id"].as_str() else { continue };
    match block["flavour"].as_str() {
      Some("myoxus:image") => {
        let native = ir
          .native_text
          .entry(id.into())
          .or_insert_with(|| yjs::native_text::NativeBlockText {
            kind: "myoxus:image".into(),
            fields: Vec::new(),
            properties: BTreeMap::new(),
          });
        for name in ["width", "height"] {
          if let Some(value) = block["props"].get(name) {
            native.properties.insert(name.into(), value.clone());
          }
        }
      }
      Some("myoxus:table") => {
        if let Some(native) = ir.native_text.get_mut(id) {
          let cells = block["props"]["cells"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(key, cell)| {
              Some((
                key.clone(),
                serde_json::json!({"backgroundColor": cell.get("backgroundColor")?.as_str()?}),
              ))
            })
            .collect::<serde_json::Map<_, _>>();
          native.properties.insert("cells".into(), cells.into());
        }
      }
      _ => {}
    }
  }
}

pub(super) fn alignment(value: &str) -> Option<Align> {
  match value {
    "left" => Some(Align::Left),
    "center" => Some(Align::Center),
    "right" => Some(Align::Right),
    "justify" => Some(Align::Justify),
    _ => None,
  }
}

impl Encoder {
  fn property(&self, id: &str, name: &str) -> Option<&serde_json::Value> {
    self.source.native_text.get(id)?.properties.get(name)
  }

  pub(super) fn color(&self, value: &str) -> Option<Rgb> {
    let value = value.trim();
    let key = value
      .strip_prefix("var(")
      .and_then(|v| v.strip_suffix(')'))
      .map(str::trim)
      .unwrap_or(value);
    self
      .fonts
      .colors
      .get(key)
      .or_else(|| {
        key
          .strip_prefix("--myoxus-text-highlight-background-")
          .and_then(|name| self.fonts.colors.get(&format!("--myoxus-text-highlight-{name}")))
      })
      .and_then(|v| Rgb::parse(v))
      .or_else(|| Rgb::parse(value))
  }

  pub(super) fn label_tone(&self, props: &mut CharProps, tone: &str) {
    let (paper, ink) = match tone {
      "neutral" => ("paper-deep", "ink-soft"),
      "info" => ("status-info-paper", "status-info-deep"),
      "positive" => ("status-success-paper", "status-success-deep"),
      "warning" => ("status-pending-paper", "status-pending-deep"),
      "danger" => ("status-error-paper", "status-error-deep"),
      "accent" => ("status-preset-paper", "accent-primary"),
      _ => return,
    };
    props.shading = self.color(paper);
    props.color = self.color(ink).map(TextColor::Rgb);
  }

  pub(super) fn format_document_styles(&mut self) {
    let rule = self.fonts.table_rule.as_deref().and_then(Rgb::parse);
    let styles = Arc::make_mut(&mut self.document.styles);
    // Word's single line box already includes font ascent/descent and leading;
    // multiplying it by the CSS body line-height counts that space twice.
    let body_size = styles.default_chr.size.unwrap_or(11.0);
    styles.get_mut("Normal").unwrap().para.line_spacing = Some(LineSpacing::Multiple(1.0));
    let callout = styles.get_mut("MyoxusCallout").unwrap();
    callout.para.space_before = Some(0.0);
    callout.para.space_after = Some(body_size * 0.7);
    // H6 uses the existing H5 role, as the editor does; no new theme role.
    if !self.fonts.typography.contains_key("Heading6") {
      let h5 = styles.get("Heading5").unwrap().clone();
      let h6 = styles.get_mut("Heading6").unwrap();
      h6.chr = h5.chr;
      h6.para = h5.para;
    }
    let quote = styles.get_mut("Quote").unwrap();
    quote.para.align = Some(Align::Left);
    quote.para.indent_left = Some(12.0);
    quote.para.borders = Some(Borders {
      left: Some(Border {
        width: 2.0,
        color: rule,
        space: 6.0,
        ..Border::single(2.0)
      }),
      ..Default::default()
    });
    quote.chr.italic = Some(false);
    quote.chr.color = Some(TextColor::Auto);
    if let Some(style) = styles.get_mut("MyoxusEyebrow") {
      style.chr.caps = Some(true);
    }
  }

  pub(super) fn paragraph_presentation(&self, paragraph: &mut Paragraph, id: &str) {
    paragraph.props.align = self
      .property(id, "textAlign")
      .and_then(serde_json::Value::as_str)
      .and_then(alignment);
    if self.property(id, "presentation").and_then(serde_json::Value::as_str) == Some("eyebrow") {
      paragraph.props.style = Some("MyoxusEyebrow".into());
    }
  }

  pub(super) fn image_dimensions(&self, id: &str, width: f32, height: f32) -> (f32, f32) {
    let dimension = |name| {
      self
        .property(id, name)
        .and_then(serde_json::Value::as_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| v as f32 * 0.75)
        .filter(|v| v.is_finite())
    };
    let scale = dimension("width")
      .map(|w| w / width)
      .or_else(|| dimension("height").map(|h| h / height))
      .unwrap_or(1.0);
    (width * scale, height * scale)
  }

  pub(super) fn callout_colors(&self, id: &str) -> (Option<Rgb>, Option<Rgb>) {
    let name = self
      .property(id, "backgroundColorName")
      .and_then(serde_json::Value::as_str)
      .unwrap_or("grey");
    let fill_key = if name == "grey" || name == "default" {
      "--myoxus-tag-gray".into()
    } else if let Some(marker) = name.strip_prefix("neon-") {
      format!("--myoxus-sem-text-marker-{marker}")
    } else {
      format!("--myoxus-text-highlight-{name}")
    };
    let fill = if self.property(id, "appearance").and_then(serde_json::Value::as_str) == Some("accent") {
      self.color("--myoxus-background-secondary-color")
    } else {
      self.color(&fill_key)
    };
    (
      fill,
      self
        .color(&format!("--myoxus-text-highlight-foreground-{name}"))
        .or(fill),
    )
  }

  pub(super) fn callout_icon(
    &mut self,
    paragraph: &mut Paragraph,
    id: &str,
    fill: Option<Rgb>,
    bold: bool,
  ) -> Result<usize, ImportError> {
    let Some(icon) = self.property(id, "icon") else {
      return Ok(0);
    };
    let unicode = icon.get("unicode").and_then(serde_json::Value::as_str);
    if icon.is_null() || unicode == Some("") {
      return Ok(0);
    }
    let label = unicode
      .or_else(|| icon.get("name").and_then(serde_json::Value::as_str))
      .unwrap_or("")
      .to_owned();
    let ink = myoxus_domain::color::adaptive_foreground(&format!("#{}", fill.unwrap_or(Rgb(255, 255, 255)).hex()));
    let color = icon.get("color").and_then(serde_json::Value::as_str).and_then(|value| {
      let reference = value
        .trim()
        .strip_prefix("var(")
        .and_then(|v| v.strip_suffix(')'))
        .unwrap_or(value.trim());
      self
        .fonts
        .colors
        .get_key_value(reference)
        .map(|(key, _)| key.clone())
        .or_else(|| {
          self
            .fonts
            .colors
            .iter()
            .find(|(key, paint)| key.contains("foreground-") && paint.eq_ignore_ascii_case(reference))
            .map(|(key, _)| key.clone())
        })
    });
    if icon.get("color").is_some() && color.is_none() {
      self.warn("callout_icon_normalized");
    }
    let color = color.or_else(|| {
      self
        .property(id, "backgroundColorName")
        .and_then(serde_json::Value::as_str)
        .map(|name| format!("--myoxus-text-highlight-foreground-{name}"))
    });
    let white = ink.eq_ignore_ascii_case("#ffffff");
    let asset = myoxus_pdf_export::document_icons::document_icon_colored(&label, color.as_deref(), white)
      .unwrap_or_else(|| {
        self.warn("callout_icon_normalized");
        myoxus_pdf_export::document_icons::document_icon_colored("InformationIcon", color.as_deref(), white)
          .expect("generated fallback icon")
      });
    // Both complete assets are generated at icon-build time. Export only selects
    // the authored palette or neutral pair; it never rasterizes or recolours an icon.
    let png = asset.png_bytes();
    let svg = asset.svg;
    let media = self.document.add_media(png, "png");
    let vector = self.document.add_media(svg.as_bytes().to_vec(), "svg");
    let media = self.document.pair_svg(media, vector);
    let text_size = self.document.styles.default_chr.size.unwrap_or(11.0);
    let size = text_size + 1.0;
    let text = paragraph.final_text();
    let text_center = self
      .fonts
      .assets
      .iter()
      .find(|font| font.name == self.fonts.body && font.bold == bold && !font.italic)
      .and_then(|font| ttf_parser::Face::parse(&font.data, 0).ok())
      .and_then(|face| {
        let bounds = text
          .lines()
          .next()
          .unwrap_or_default()
          .chars()
          .filter_map(|c| face.glyph_index(c).and_then(|g| face.glyph_bounding_box(g)))
          .fold(None::<(i16, i16)>, |bounds, r| {
            let (lo, hi) = bounds.unwrap_or((r.y_min, r.y_max));
            Some((lo.min(r.y_min), hi.max(r.y_max)))
          })?;
        Some((f32::from(bounds.0) + f32::from(bounds.1)) / 2.0 / f32::from(face.units_per_em()) * text_size)
      })
      .unwrap_or(text_size * 0.35);
    let icon_center = size * (1.0 - (asset.ink_bounds[1] + asset.ink_bounds[3]) / 192.0);
    // Centre the actual glyph ink, not the SVG's square, on the header ink.
    // Word stores this run offset in half-points; a negative value lowers it.
    let position = ((text_center - icon_center) * 2.0).round() / 2.0;
    paragraph
      .insert_text(0, " ", &CharProps::default())
      .map_err(|_| ImportError::Conversion)?;
    paragraph
      .insert_object(
        0,
        wordcraft_doc::InlineObject::Image {
          media,
          w: size,
          h: size,
          alt: format!("Callout icon: {label}"),
          float: Default::default(),
          crop: [0.0; 4],
          fx: Default::default(),
          ole: None,
        },
        &CharProps {
          position: Some(position),
          ..Default::default()
        },
      )
      .map_err(|_| ImportError::Conversion)?;
    Ok(wordcraft_doc::para::OBJ.len_utf8() + 1)
  }

  fn callout_ink(blocks: &mut [Arc<wordcraft_doc::Block>], fill: Option<Rgb>) {
    for block in blocks {
      match Arc::make_mut(block) {
        wordcraft_doc::Block::Para(p) if p.props.style.as_deref() != Some("MyoxusCode") => {
          if let Some(fill) = p.props.shading.or(fill) {
            let ink = TextColor::parse(myoxus_domain::color::adaptive_foreground(&format!("#{}", fill.hex()))).unwrap();
            for run in &mut p.runs {
              run.props.color.get_or_insert(ink);
            }
          }
        }
        wordcraft_doc::Block::Table(t) => {
          for cell in t.rows.iter_mut().flat_map(|r| &mut r.cells) {
            Self::callout_ink(&mut cell.blocks, cell.props.shading.or(fill));
          }
        }
        _ => {}
      }
    }
  }

  pub(super) fn finish_callout_frame(
    &mut self,
    start: usize,
    indent: f32,
    width: f32,
    fill: Option<Rgb>,
    rule: Option<Rgb>,
  ) {
    let mut blocks = self.document.body.split_off(start);
    // Titles/icons are inserted before this pass; headings and transparent
    // nested table cells need the same contrast as prose on the frame fill.
    Self::callout_ink(&mut blocks, fill);
    // Indents inside a Word cell are relative to that cell. The frame retains
    // its outer indent; nested frames and data tables retain their own local one.
    for block in &mut blocks {
      match Arc::make_mut(block) {
        wordcraft_doc::Block::Para(p) => {
          p.props.indent_left = Some((p.props.indent_left.unwrap_or_default() - indent).max(0.0));
          if matches!(p.props.style.as_deref(), None | Some("Normal")) {
            p.props.space_after = Some(self.document.styles.default_chr.size.unwrap_or(11.0) * 0.7);
          }
          if p.props.style.as_deref() == Some("MyoxusCode") {
            // Paragraph border spacing extends its paint outside the text box;
            // reserve that extent inside the callout's right cell padding.
            let space = self
              .document
              .styles
              .get("MyoxusCode")
              .and_then(|style| style.para.borders)
              .and_then(|borders| borders.right)
              .map_or(0.0, |border| border.space);
            p.props.indent_right = Some(p.props.indent_right.unwrap_or_default() + space);
          }
        }
        wordcraft_doc::Block::Table(t) => {
          t.props.indent = Some((t.props.indent.unwrap_or_default() - indent).max(0.0));
        }
      }
    }
    if let Some(wordcraft_doc::Block::Para(p)) = blocks.first_mut().map(Arc::make_mut) {
      p.props.space_before = Some(0.0);
    }
    if let Some(wordcraft_doc::Block::Para(p)) = blocks.last_mut().map(Arc::make_mut) {
      p.props.space_after = Some(0.0);
    }
    let mut cell = wordcraft_doc::Cell::empty();
    cell.blocks = blocks;
    cell.props.shading = fill;
    let none = Border::default();
    let mut table = wordcraft_doc::Table {
      grid: vec![width],
      ..Default::default()
    };
    table.props.style = Some(super::super::CALLOUT_FRAME_STYLE.into());
    table.props.width = Some(width);
    table.props.fixed = true;
    table.props.indent = Some(indent);
    table.props.cell_margins = Some([CALLOUT_PADDING_PT; 4]);
    table.props.borders = Some(Borders {
      left: Some(Border {
        color: rule,
        ..Border::single(2.0)
      }),
      top: Some(none),
      right: Some(none),
      bottom: Some(none),
      between: Some(none),
      inside_v: Some(none),
    });
    table.rows.push(wordcraft_doc::Row {
      cells: vec![cell],
      ..Default::default()
    });
    // Keep adjacent layout/data tables independent in Word's editable model.
    if matches!(
      self.document.body.last().map(|b| &**b),
      Some(wordcraft_doc::Block::Table(_))
    ) {
      let mut gap = Paragraph::new();
      gap.props.space_before = Some(0.0);
      gap.props.space_after = Some(0.0);
      gap.props.line_spacing = Some(LineSpacing::Exactly(
        self.document.styles.default_chr.size.unwrap_or(11.0) * 1.2,
      ));
      self.document.body.push(wordcraft_doc::para_block(gap));
    }
    self.document.body.push(Arc::new(wordcraft_doc::Block::Table(table)));
  }

  pub(super) fn push_code(&mut self, mut paragraph: Paragraph, id: &str) -> Result<(), ImportError> {
    // Word joins identical borders on adjacent paragraphs. An ordinary empty
    // paragraph separates source blocks without altering their literal code.
    if self
      .document
      .body
      .last()
      .is_some_and(|b| matches!(&**b, wordcraft_doc::Block::Para(p) if p.props.style.as_deref() == Some("MyoxusCode")))
    {
      let mut gap = Paragraph::new();
      gap.props.space_before = Some(0.0);
      gap.props.space_after = Some(0.0);
      gap.props.line_spacing = Some(LineSpacing::Exactly(4.0));
      gap.props.keep_next = Some(true);
      self.push(gap);
    }
    if self.property(id, "lineNumber").and_then(serde_json::Value::as_bool) == Some(true) {
      let num = Arc::make_mut(&mut self.document.numbering).add_list(ListKind::Numbered);
      Arc::make_mut(&mut self.document.numbering)
        .abstracts
        .last_mut()
        .unwrap()
        .levels[0]
        .chr
        .font = Some(self.fonts.mono.clone());
      let mut first = true;
      loop {
        let tail = if let Some(at) = paragraph.text.find('\n') {
          let tail = paragraph.split_off(at + 1).map_err(|_| ImportError::Conversion)?;
          paragraph.delete(at, at + 1).map_err(|_| ImportError::Conversion)?;
          Some(tail)
        } else {
          None
        };
        paragraph.props.numbering = Some(NumRef { num, level: 0 });
        paragraph.props.indent_left = Some(self.indent + self.list_level as f32 * super::super::CONTENT_INDENT + 18.0);
        paragraph.props.indent_first = Some(-18.0);
        paragraph.props.space_before = Some(if first { 5.0 } else { 0.0 });
        paragraph.props.space_after = Some(if tail.is_some() { 0.0 } else { 5.0 });
        if first {
          paragraph = self.bookmarked(paragraph, id)?;
        }
        self.push(paragraph);
        first = false;
        let Some(tail) = tail else { break };
        paragraph = tail;
      }
    } else {
      let paragraph = self.bookmarked(paragraph, id)?;
      self.push(paragraph);
    }
    if let Some(caption) = self
      .property(id, "caption")
      .and_then(serde_json::Value::as_str)
      .filter(|v| !v.is_empty())
      .map(str::to_owned)
    {
      self.push(Paragraph::with_text(&caption, CharProps::default()).styled("Caption"));
    }
    Ok(())
  }
}
