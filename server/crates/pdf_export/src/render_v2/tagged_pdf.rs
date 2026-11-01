// SPDX-License-Identifier: AGPL-3.0-or-later
//! Tagged-PDF / WCAG pre-flight (`P-PDF-TPL-A11Y-01`).
//!
//! Two pure helpers run **before** the renderer hits the Typst pipeline.
//! They surface accessibility issues as structured warnings so the
//! caller can choose to fail-hard (compliance contexts), warn-soft
//! (everyday exports), or surface the report on the admin UI without
//! re-parsing the IR.
//!
//! 1. [`audit_a11y`] — walks the IR and reports
//!    `WcagFinding`s (heading-hierarchy gaps, missing alt text, large
//!    images without captions). Pure / no IO.
//! 2. [`StructTreeReadiness::evaluate`] — predicate that decides whether
//!    the IR has enough structure to render as a Tagged-PDF (heading
//!    skeleton + at least one structural anchor).
//!
//! The actual Tagged-PDF emission lives in the renderer (`P-PDF-TPL-13`)
//! and depends on `typst-pdf` enabling its experimental tagged-pdf
//! feature flag. Until then this module surfaces the readiness signal.

use serde::Serialize;
use thiserror::Error;
use tracing::instrument;

use crate::ir::IrDocument;
use crate::ir::block::{Block, HeadingLevel, ImageRef};
use crate::ir::inline::InlineSpan;

// ─── Findings ────────────────────────────────────────────────────────────────

/// Severity of an audit finding. Compliance callers fail-hard on
/// `Error`; the everyday rendering path keeps going on `Warning` and
/// merely logs them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WcagSeverity {
  Warning,
  Error,
}

/// One WCAG / PDF-UA pre-flight finding.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WcagFinding {
  pub code: WcagCode,
  pub severity: WcagSeverity,
  /// Human-readable summary suitable for log lines.
  pub message: String,
}

/// Stable machine-readable finding codes — the admin UI translates
/// these into user-facing strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WcagCode {
  /// Heading levels skipped by more than one (`h1` → `h3` without an
  /// intervening `h2`).
  HeadingHierarchyGap,
  /// Document opens at a level deeper than `h1`.
  HeadingDoesNotStartAtH1,
  /// `Image` block has no caption / alt-text.
  MissingAltText,
  /// `Table` has no caption — assistive readers will announce it as
  /// "table" with no further context.
  TableWithoutCaption,
  /// IR has no headings at all — the resulting tagged tree would be a
  /// single flat block, which is technically valid but unusual.
  NoHeadings,
}

#[derive(Debug, Error)]
pub enum A11yError {
  #[error("ir is empty: {0}")]
  EmptyIr(&'static str),
}

// ─── Audit walker ────────────────────────────────────────────────────────────

/// Run every WCAG pre-flight check against `doc`. Always succeeds —
/// the finding list may be empty (clean document) or contain one or
/// more `WcagFinding`s. The walker never panics.
#[instrument(skip(doc))]
pub fn audit_a11y(doc: &IrDocument) -> Vec<WcagFinding> {
  let mut findings = Vec::new();
  let mut state = AuditState {
    last_heading_level: None,
    saw_heading: false,
  };
  walk(&doc.root, &mut state, &mut findings);
  if !state.saw_heading {
    findings.push(WcagFinding {
      code: WcagCode::NoHeadings,
      severity: WcagSeverity::Warning,
      message: "document has no headings — tagged-PDF tree will be a single block".into(),
    });
  }
  findings
}

struct AuditState {
  last_heading_level: Option<u8>,
  saw_heading: bool,
}

fn walk(block: &Block, state: &mut AuditState, findings: &mut Vec<WcagFinding>) {
  block.for_each_local_footnote_body(&mut |body| {
    for child in body {
      walk(child, state, findings);
    }
  });
  match block {
    Block::Heading {
      level,
      content,
      children,
    } => {
      let new_level = heading_level_to_int(*level);
      // First heading must be h1.
      if !state.saw_heading && new_level != 1 {
        findings.push(WcagFinding {
          code: WcagCode::HeadingDoesNotStartAtH1,
          severity: WcagSeverity::Warning,
          message: format!("first heading is h{new_level}; PDF-UA recommends starting at h1"),
        });
      }
      // Skip-by-more-than-one detection: previous level + 2 ≤ new level.
      if let Some(prev) = state.last_heading_level
        && new_level > prev + 1
      {
        findings.push(WcagFinding {
          code: WcagCode::HeadingHierarchyGap,
          severity: WcagSeverity::Warning,
          message: format!("heading hierarchy jumps h{prev} → h{new_level} (skipped h{})", prev + 1),
        });
      }
      state.last_heading_level = Some(new_level);
      state.saw_heading = true;
      // Empty heading content also flagged — assistive tech reads
      // nothing for them.
      let plain = inline_plain_text(content);
      if plain.trim().is_empty() {
        findings.push(WcagFinding {
          code: WcagCode::MissingAltText,
          severity: WcagSeverity::Warning,
          message: format!("h{new_level} heading has empty text"),
        });
      }
      for c in children {
        walk(c, state, findings);
      }
    }
    Block::Image(ImageRef { caption, .. }) => {
      let has_alt = caption
        .as_ref()
        .map(|spans| !inline_plain_text(spans).trim().is_empty())
        .unwrap_or(false);
      if !has_alt {
        findings.push(WcagFinding {
          code: WcagCode::MissingAltText,
          severity: WcagSeverity::Error,
          message: "image has no caption / alt text".into(),
        });
      }
    }
    Block::Table { caption, .. } if caption.is_none() => {
      findings.push(WcagFinding {
        code: WcagCode::TableWithoutCaption,
        severity: WcagSeverity::Warning,
        message: "table has no caption".into(),
      });
    }
    Block::Table { .. } => {}
    // Container blocks: descend.
    Block::Page { children, .. }
    | Block::Note { children }
    | Block::LocalNoteDefinition { children, .. }
    | Block::EdgelessText { children, .. }
    | Block::Paragraph { children, .. }
    | Block::Quote { children, .. }
    | Block::List { children, .. }
    | Block::Callout { children, .. } => {
      for c in children {
        walk(c, state, findings);
      }
    }
    _ => {}
  }
}

fn heading_level_to_int(level: HeadingLevel) -> u8 {
  match level {
    HeadingLevel::H1 => 1,
    HeadingLevel::H2 => 2,
    HeadingLevel::H3 => 3,
    HeadingLevel::H4 => 4,
    HeadingLevel::H5 => 5,
    HeadingLevel::H6 => 6,
  }
}

fn inline_plain_text(spans: &[InlineSpan]) -> String {
  let mut out = String::new();
  for span in spans {
    if let InlineSpan::Text { text, .. } = span {
      out.push_str(text);
    }
  }
  out
}

// ─── Struct-tree readiness ──────────────────────────────────────────────────

/// Predicate that summarises whether the IR has enough structure for a
/// useful Tagged-PDF emit. Used by the renderer to decide whether to
/// even attempt the tagged-pdf code path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct StructTreeReadiness {
  /// Document carries at least one heading (non-empty content).
  pub has_headings: bool,
  /// Document carries at least one structural anchor (image, table,
  /// list, quote, or callout). Without these the tagged tree is just
  /// a flat sequence of `<P>` paragraphs — typically not worth tagging.
  pub has_structural_anchor: bool,
}

impl StructTreeReadiness {
  /// Walk the IR once and return the readiness predicate.
  pub fn evaluate(doc: &IrDocument) -> Self {
    let mut readiness = Self {
      has_headings: false,
      has_structural_anchor: false,
    };
    readiness.walk(&doc.root);
    readiness
  }

  fn walk(&mut self, block: &Block) {
    block.for_each_local_footnote_body(&mut |body| {
      for child in body {
        self.walk(child);
      }
    });
    match block {
      Block::Heading { content, children, .. } => {
        if !inline_plain_text(content).trim().is_empty() {
          self.has_headings = true;
        }
        for c in children {
          self.walk(c);
        }
      }
      Block::Image(_) | Block::Table { .. } | Block::List { .. } | Block::Quote { .. } | Block::Callout { .. } => {
        self.has_structural_anchor = true;
        if let Block::List { children, .. } | Block::Quote { children, .. } | Block::Callout { children, .. } = block {
          for c in children {
            self.walk(c);
          }
        }
      }
      Block::Page { children, .. }
      | Block::Note { children }
      | Block::LocalNoteDefinition { children, .. }
      | Block::EdgelessText { children, .. }
      | Block::Paragraph { children, .. } => {
        for c in children {
          self.walk(c);
        }
      }
      _ => {}
    }
  }

  /// Returns true when the renderer should attempt the tagged-PDF
  /// emit path. Compliance callers may fail-closed when this returns
  /// false; everyday exports just emit untagged PDF.
  pub fn is_ready(self) -> bool {
    self.has_headings && self.has_structural_anchor
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use crate::ir::block::{BlobRef, ImageRef};
  use crate::ir::{Branding, DocumentMetadata, ExportOptions};
  use uuid::Uuid;

  fn doc(root: Block) -> IrDocument {
    IrDocument {
      version: crate::ir::CURRENT_IR_VERSION,
      metadata: DocumentMetadata {
        doc_id: Uuid::nil(),
        workspace_id: Uuid::nil(),
        title: None,
        author: None,
        created_at: None,
        updated_at: None,
        workspace_name: None,
        branding: Branding::default(),
      },
      options: ExportOptions::default(),
      assets: Default::default(),
      root,
    }
  }

  fn page(children: Vec<Block>) -> Block {
    Block::Page {
      title: vec![],
      children,
    }
  }

  fn h(level: HeadingLevel, text: &str) -> Block {
    Block::Heading {
      level,
      content: vec![InlineSpan::Text {
        text: text.into(),
        marks: Default::default(),
      }],
      children: vec![],
    }
  }

  fn img(caption: Option<&str>) -> Block {
    Block::Image(ImageRef {
      blob: BlobRef {
        blob_id: "b".into(),
        mime_hint: None,
      },
      caption: caption.map(|c| {
        vec![InlineSpan::Text {
          text: c.into(),
          marks: Default::default(),
        }]
      }),
      width_hint: None,
      height_hint: None,
      data: None,
    })
  }

  /// `INV-A11Y-01` (`P-PDF-TPL-A11Y-01-04`-spirit): a clean H1→H2
  /// hierarchy with captioned images yields zero findings.
  #[test]
  fn inv_a11y_clean_hierarchy_zero_findings() {
    let d = doc(page(vec![
      h(HeadingLevel::H1, "Title"),
      h(HeadingLevel::H2, "Section"),
      img(Some("a logo")),
    ]));
    assert!(audit_a11y(&d).is_empty());
  }

  /// `INV-A11Y-03` (`P-PDF-TPL-A11Y-01-06`): heading-hierarchy gap
  /// emits a `Warning` (not `Error`) — tagged-PDF can still render,
  /// the user just gets a hint.
  #[test]
  fn inv_a11y03_missing_heading_tags_emits_warning_not_error() {
    let d = doc(page(vec![h(HeadingLevel::H1, "T"), h(HeadingLevel::H4, "Skip")]));
    let findings = audit_a11y(&d);
    let gap = findings
      .iter()
      .find(|f| f.code == WcagCode::HeadingHierarchyGap)
      .expect("hierarchy gap finding");
    assert_eq!(gap.severity, WcagSeverity::Warning);
  }

  /// Missing alt text on an image is an `Error` — assistive tech
  /// can't describe an unlabelled image at all.
  #[test]
  fn missing_alt_text_is_error() {
    let d = doc(page(vec![h(HeadingLevel::H1, "T"), img(None)]));
    let findings = audit_a11y(&d);
    let alt = findings
      .iter()
      .find(|f| f.code == WcagCode::MissingAltText)
      .expect("alt-text finding");
    assert_eq!(alt.severity, WcagSeverity::Error);
  }

  /// Document opening at h2 is flagged.
  #[test]
  fn first_heading_must_be_h1() {
    let d = doc(page(vec![h(HeadingLevel::H2, "Section")]));
    let findings = audit_a11y(&d);
    assert!(
      findings.iter().any(|f| f.code == WcagCode::HeadingDoesNotStartAtH1),
      "expected HeadingDoesNotStartAtH1, got {findings:?}"
    );
  }

  /// Empty document → `NoHeadings` finding.
  #[test]
  fn empty_doc_no_headings_finding() {
    let d = doc(page(vec![]));
    let findings = audit_a11y(&d);
    assert!(findings.iter().any(|f| f.code == WcagCode::NoHeadings));
  }

  /// `StructTreeReadiness` reports `is_ready == true` only when both a
  /// heading and a structural anchor exist.
  #[test]
  fn struct_tree_readiness_predicate() {
    let just_paragraphs = doc(page(vec![Block::Paragraph {
      content: vec![InlineSpan::Text {
        text: "p".into(),
        marks: Default::default(),
      }],
      children: vec![],
    }]));
    assert!(!StructTreeReadiness::evaluate(&just_paragraphs).is_ready());

    let with_heading_only = doc(page(vec![h(HeadingLevel::H1, "T")]));
    assert!(!StructTreeReadiness::evaluate(&with_heading_only).is_ready());

    let full = doc(page(vec![h(HeadingLevel::H1, "T"), img(Some("alt"))]));
    let r = StructTreeReadiness::evaluate(&full);
    assert!(r.has_headings && r.has_structural_anchor);
    assert!(r.is_ready());
  }
}
