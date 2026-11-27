// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded native MiTeX admission inside the supervised PDF compiler. Never
//! return upstream errors: they can contain private author source.

use std::collections::BTreeMap;

use mitex_parser::syntax::SyntaxKind;

use super::ir_to_typst::SourceV2Error;
use crate::{
  error::LatexErrorReason,
  ir::{Block, InlineSpan},
};

const MAX_SOURCE_BYTES: usize = 8192;
const MAX_NESTING: usize = 64;
const MAX_DOCUMENT_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_CONVERTED_BYTES: usize = 64 * 1024;

#[derive(Default)]
struct Formulas {
  converted: BTreeMap<String, (usize, String)>,
  index: usize,
  source_bytes: usize,
}

pub(super) fn convert_document(root: &Block) -> Result<BTreeMap<String, (usize, String)>, SourceV2Error> {
  let mut formulas = Formulas::default();
  formulas.block(root)?;
  Ok(formulas.converted)
}

impl Formulas {
  fn formula(&mut self, source: &str) -> Result<(), SourceV2Error> {
    self.index += 1;
    self.source_bytes = self.source_bytes.saturating_add(source.len());
    let fail = |reason| SourceV2Error::Latex {
      index: self.index,
      reason,
    };
    if source.len() > MAX_SOURCE_BYTES || self.source_bytes > MAX_DOCUMENT_SOURCE_BYTES {
      return Err(fail(LatexErrorReason::SourceLimit));
    }
    if self.converted.contains_key(source) {
      return Ok(());
    }
    // Bound parser recursion before building its AST. Escapes and comments
    // carry literal braces, not structural nesting.
    let mut braces = 0usize;
    let mut chars = source.chars();
    while let Some(c) = chars.next() {
      match c {
        '\\' => {
          chars.next();
        }
        '%' => {
          for c in chars.by_ref() {
            if c == '\n' {
              break;
            }
          }
        }
        '{' => {
          braces += 1;
          if braces > MAX_NESTING {
            return Err(fail(LatexErrorReason::NestingLimit));
          }
        }
        '}' => {
          braces = braces
            .checked_sub(1)
            .ok_or_else(|| fail(LatexErrorReason::UnmatchedBrace))?;
        }
        _ => {}
      }
    }
    if braces != 0 {
      return Err(fail(LatexErrorReason::UnclosedBrace));
    }
    let spec = mitex_spec_gen::DEFAULT_SPEC.clone();
    // Parse without expansion before invoking the native public converter.
    // In particular, MiTeX's iftypst escape hatch must never reach eval.
    let ast = mitex_parser::parse_without_macro(source, spec.clone());
    for node in ast.descendants_with_tokens() {
      if node.ancestors().count() > MAX_NESTING {
        return Err(fail(LatexErrorReason::NestingLimit));
      }
      match node.kind() {
        SyntaxKind::TokenError => return Err(fail(LatexErrorReason::Malformed)),
        SyntaxKind::ItemTypstCode | SyntaxKind::ItemBlockComment => {
          return Err(fail(LatexErrorReason::EmbeddedCode));
        }
        SyntaxKind::ClauseCommandName => {
          let token = node.as_token().expect("command name is a token");
          let name = token.text().trim_start_matches('\\');
          if (spec.get_cmd(name).is_none() && !matches!(name, "left" | "right"))
            || matches!(
              name,
              "input"
                | "include"
                | "includegraphics"
                | "documentclass"
                | "usepackage"
                | "newcommand"
                | "renewcommand"
                | "providecommand"
                | "def"
                | "gdef"
                | "edef"
                | "label"
                | "tag"
                | "ref"
                | "eqref"
                | "cite"
                | "caption"
                | "url"
                | "href"
            )
          {
            return Err(fail(LatexErrorReason::UnsupportedCommand));
          }
        }
        SyntaxKind::ItemCurly => {
          let group = node.as_node().expect("curly group is a node");
          if group
            .last_token()
            .is_none_or(|token| token.kind() != SyntaxKind::TokenRBrace)
          {
            return Err(fail(LatexErrorReason::UnclosedBrace));
          }
        }
        SyntaxKind::ItemEnv => {
          let group = node.as_node().expect("environment is a node");
          let begin = group.children().find(|n| n.kind() == SyntaxKind::ItemBegin);
          let end = group.children().find(|n| n.kind() == SyntaxKind::ItemEnd);
          let begin_name = begin.and_then(|n| n.first_token()).map(|t| t.text().to_string());
          let end_name = end.and_then(|n| n.first_token()).map(|t| t.text().to_string());
          let (Some(begin), Some(end)) = (begin_name, end_name) else {
            return Err(fail(LatexErrorReason::UnclosedEnvironment));
          };
          if begin != end {
            return Err(fail(LatexErrorReason::MismatchedEnvironment));
          }
          let name = begin.as_str();
          if !matches!(
            name,
            "matrix"
              | "pmatrix"
              | "bmatrix"
              | "Bmatrix"
              | "vmatrix"
              | "Vmatrix"
              | "smallmatrix"
              | "cases"
              | "aligned"
              | "alignedat"
              | "gathered"
              | "array"
              | "subarray"
          ) {
            return Err(fail(LatexErrorReason::UnsupportedEnvironment));
          }
        }
        _ => {}
      }
    }
    let converted = mitex::convert_math(source, Some(spec)).map_err(|_| fail(LatexErrorReason::ConversionFailed))?;
    if converted.len() > MAX_CONVERTED_BYTES {
      return Err(fail(LatexErrorReason::OutputLimit));
    }
    self.converted.insert(source.to_owned(), (self.index, converted));
    Ok(())
  }

  fn inline(&mut self, spans: &[InlineSpan]) -> Result<(), SourceV2Error> {
    for span in spans {
      match span {
        InlineSpan::Latex { source } => self.formula(source)?,
        InlineSpan::Footnote { content } => self.inline(content)?,
        InlineSpan::LocalFootnote { body: Some(blocks), .. } => self.blocks(blocks)?,
        _ => {}
      }
    }
    Ok(())
  }

  fn blocks(&mut self, blocks: &[Block]) -> Result<(), SourceV2Error> {
    for block in blocks {
      self.block(block)?;
    }
    Ok(())
  }

  fn block(&mut self, block: &Block) -> Result<(), SourceV2Error> {
    match block {
      Block::Page { title, children } => {
        self.inline(title)?;
        self.blocks(children)?;
      }
      Block::Note { children } | Block::LocalNoteDefinition { children, .. } => self.blocks(children)?,
      Block::Paragraph { content, children, .. }
      | Block::Heading { content, children, .. }
      | Block::List { content, children, .. }
      | Block::Quote { content, children }
      | Block::Callout { content, children, .. }
      | Block::EdgelessText { content, children } => {
        self.inline(content)?;
        self.blocks(children)?;
      }
      Block::LatexBlock { source } => self.formula(source)?,
      Block::Table { rows, caption, .. } => {
        for row in rows {
          for cell in &row.cells {
            self.inline(&cell.content)?;
          }
        }
        if let Some(caption) = caption {
          self.inline(caption)?;
        }
      }
      Block::Database(table) => {
        for row in &table.rows {
          for cell in row {
            self.inline(cell)?;
          }
        }
      }
      Block::Image(image) => {
        if let Some(caption) = &image.caption {
          self.inline(caption)?;
        }
      }
      Block::Code(code) => {
        if let Some(caption) = &code.caption {
          self.inline(caption)?;
        }
      }
      Block::Mermaid(diagram) => {
        if let Some(title) = &diagram.title {
          self.inline(title)?;
        }
        if let Some(caption) = &diagram.caption {
          self.inline(caption)?;
        }
      }
      Block::Surface(s) | Block::SurfaceRef(s) | Block::Frame(s) | Block::Mindmap(s) => {
        if let Some(caption) = &s.caption {
          self.inline(caption)?;
        }
      }
      Block::AiChat { messages } => {
        for message in messages {
          self.inline(&message.content)?;
        }
      }
      Block::Unknown {
        text_fallback: Some(content),
        ..
      } => self.inline(content)?,
      Block::Unknown {
        text_fallback: None, ..
      }
      | Block::Divider
      | Block::TableOfContents { .. }
      | Block::Attachment { .. }
      | Block::Bookmark(_)
      | Block::Embed(_) => {}
    }
    Ok(())
  }
}
