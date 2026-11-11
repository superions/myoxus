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

  pub(super) fn callout_presentation(&self, paragraph: &mut Paragraph, id: &str) {
    let name = self
      .property(id, "backgroundColorName")
      .and_then(serde_json::Value::as_str)
      .unwrap_or("grey");
    let (paper, ink) = match name {
      "red" => ("status-error-paper", "status-error-deep"),
      "yellow" | "orange" => ("status-pending-paper", "status-pending-deep"),
      "green" => ("status-success-paper", "status-success-deep"),
      "blue" | "purple" => ("status-info-paper", "status-info-deep"),
      _ => ("paper-deep", "ink-soft"),
    };
    paragraph.props.shading = self.color(paper);
    if let Some(fill) = paragraph.props.shading {
      let ink = TextColor::parse(myoxus_domain::color::adaptive_foreground(&format!("#{}", fill.hex()))).unwrap();
      for run in &mut paragraph.runs {
        run.props.color.get_or_insert(ink);
      }
    }
    paragraph.props.borders = Some(Borders {
      left: Some(Border {
        color: self.color(ink),
        space: 6.0,
        ..Border::single(2.0)
      }),
      ..Default::default()
    });
    paragraph.props.space_before = Some(6.0);
    paragraph.props.space_after = Some(6.0);
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
