// SPDX-License-Identifier: AGPL-3.0-or-later
//! Cross-reference anchor resolver (`P-PDF-TPL-XR-01`).
//!
//! Walks an [`IrDocument`] to:
//!
//! 1. Build an **anchor index** of every heading / figure / table id.
//!    Headings derive their id from their plain-text content via the
//!    same slugifier the upstream UI uses; figures and tables are
//!    counted in document order (`figure-1`, `figure-2`, …) so the
//!    counter is reproducible across renders.
//! 2. Auto-number captions: `Figure 1: …`, `Table 1: …`, etc., using
//!    the locale's word for "Figure" / "Table".
//! 3. Resolve `<a href="#anchor-id">` link spans against the index.
//!    An unknown anchor surfaces as
//!    [`CrossRefError::UnknownAnchor`] which the renderer maps to
//!    `LinkValidationFailed`.
//!
//! Pure / synchronous / no-IO. The output is `Send`able so the worker
//! can pass the resolved index across thread boundaries.

use std::collections::HashMap;

use thiserror::Error;
use tracing::{debug, instrument, trace, warn};

use crate::ir::IrDocument;
use crate::ir::block::{Block, RichText};
use crate::ir::inline::InlineSpan;

// ─── Public types ────────────────────────────────────────────────────────────

/// One entry in the resolved anchor index. Carries enough context for
/// the renderer to build a Typst `<label "anchor">` plus a human-
/// readable display string for inline references.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnchorEntry {
  pub kind: AnchorKind,
  /// Stable kebab-case id derived from the source content.
  pub id: String,
  /// Human-readable display string (e.g. heading text, "Figure 1").
  pub display: String,
}

/// What kind of element produced this anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorKind {
  Heading,
  Figure,
  Table,
}

/// Result of a cross-ref pass over one document.
#[derive(Debug, Clone, Default)]
pub struct CrossRefIndex {
  /// `anchor-id → entry`. Lookup is O(1) at render time so each `<a
  /// href="#…">` resolves quickly even on long documents.
  pub anchors: HashMap<String, AnchorEntry>,
  /// Caption text the renderer should emit for each anchor (`Figure 1:
  /// …`). Keyed by anchor id; for headings the value matches
  /// `entry.display`.
  pub captions: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CrossRefError {
  #[error("unknown anchor `#{0}`")]
  UnknownAnchor(String),
}

// ─── Public API ──────────────────────────────────────────────────────────────

/// Build the cross-reference index for a document.
///
/// Heading anchors are built from the plain-text content via
/// [`slugify`]; figures and tables receive auto-numbered ids
/// (`figure-1`, `figure-2`, …) so cross-reference targets stay stable
/// across re-renders of the same document.
#[instrument(skip(doc))]
pub fn build_index(doc: &IrDocument, locale: &str) -> CrossRefIndex {
  let mut state = WalkState {
    index: CrossRefIndex::default(),
    figure_counter: 0,
    table_counter: 0,
    locale_words: locale_words(locale),
    seen_slugs: HashMap::new(),
  };
  state.walk(&doc.root);
  debug!(
    headings = state
      .index
      .anchors
      .values()
      .filter(|a| a.kind == AnchorKind::Heading)
      .count(),
    figures = state
      .index
      .anchors
      .values()
      .filter(|a| a.kind == AnchorKind::Figure)
      .count(),
    tables = state
      .index
      .anchors
      .values()
      .filter(|a| a.kind == AnchorKind::Table)
      .count(),
    "cross-ref index built"
  );
  state.index
}

/// Resolve a `<a href="#anchor-id">` link. Returns the rendered Typst
/// reference (`@anchor-id`) and the human-readable display text the
/// caller should fall back to if the renderer wants a textual link.
pub fn resolve_anchor<'a>(index: &'a CrossRefIndex, href: &str) -> Result<&'a AnchorEntry, CrossRefError> {
  // Strip the `#` prefix if present.
  let id = href.strip_prefix('#').unwrap_or(href);
  if let Some(entry) = index.anchors.get(id) {
    trace!(id, kind = ?entry.kind, "anchor resolved");
    Ok(entry)
  } else {
    warn!(id, "unknown anchor — emitting LinkValidationFailed");
    Err(CrossRefError::UnknownAnchor(id.to_owned()))
  }
}

/// Slugify a heading's plain-text content. Lowercases, replaces every
/// non-alphanumeric run with a single `-`, trims leading / trailing
/// `-`. Mirrors the conventional GFM/markdown-it slugifier so authors
/// who hand-author cross-references can predict the output.
pub fn slugify(input: &str) -> String {
  let mut out = String::with_capacity(input.len());
  let mut prev_dash = true; // suppress leading '-'
  for ch in input.chars() {
    if ch.is_ascii_alphanumeric() {
      for c in ch.to_lowercase() {
        out.push(c);
      }
      prev_dash = false;
    } else if !prev_dash {
      out.push('-');
      prev_dash = true;
    }
  }
  // Strip trailing '-' if the loop appended one.
  if out.ends_with('-') {
    out.pop();
  }
  out
}

// ─── Walker internals ────────────────────────────────────────────────────────

/// Locale-driven words used in caption auto-numbering. Falls back to
/// English for any locale that doesn't have an explicit translation.
struct LocaleWords {
  figure: &'static str,
  table: &'static str,
}

fn locale_words(locale: &str) -> LocaleWords {
  let base = locale.split('-').next().unwrap_or(locale);
  match base {
    "de" => LocaleWords {
      figure: "Abbildung",
      table: "Tabelle",
    },
    "fr" => LocaleWords {
      figure: "Figure",
      table: "Tableau",
    },
    "es" => LocaleWords {
      figure: "Figura",
      table: "Tabla",
    },
    "it" => LocaleWords {
      figure: "Figura",
      table: "Tabella",
    },
    "pt" => LocaleWords {
      figure: "Figura",
      table: "Tabela",
    },
    "nl" => LocaleWords {
      figure: "Afbeelding",
      table: "Tabel",
    },
    "pl" => LocaleWords {
      figure: "Rysunek",
      table: "Tabela",
    },
    "cs" => LocaleWords {
      figure: "Obrázek",
      table: "Tabulka",
    },
    "sk" => LocaleWords {
      figure: "Obrázok",
      table: "Tabuľka",
    },
    "hu" => LocaleWords {
      figure: "Ábra",
      table: "Táblázat",
    },
    "ro" => LocaleWords {
      figure: "Figura",
      table: "Tabelul",
    },
    "ru" => LocaleWords {
      figure: "Рисунок",
      table: "Таблица",
    },
    "uk" => LocaleWords {
      figure: "Рисунок",
      table: "Таблиця",
    },
    "el" => LocaleWords {
      figure: "Σχήμα",
      table: "Πίνακας",
    },
    "tr" => LocaleWords {
      figure: "Şekil",
      table: "Tablo",
    },
    "sv" => LocaleWords {
      figure: "Figur",
      table: "Tabell",
    },
    "no" => LocaleWords {
      figure: "Figur",
      table: "Tabell",
    },
    "da" => LocaleWords {
      figure: "Figur",
      table: "Tabel",
    },
    "fi" => LocaleWords {
      figure: "Kuva",
      table: "Taulukko",
    },
    _ => LocaleWords {
      figure: "Figure",
      table: "Table",
    },
  }
}

struct WalkState {
  index: CrossRefIndex,
  figure_counter: u32,
  table_counter: u32,
  locale_words: LocaleWords,
  /// Tracks slug collisions: same heading text appearing twice in the
  /// document. The second occurrence becomes `slug-2`, the third
  /// `slug-3`, etc.
  seen_slugs: HashMap<String, u32>,
}

impl WalkState {
  fn walk(&mut self, block: &Block) {
    block.for_each_local_footnote_body(&mut |body| {
      for child in body {
        self.walk(child);
      }
    });
    match block {
      Block::Heading { content, children, .. } => {
        let text = inline_to_plain_text(content);
        let mut id = slugify(&text);
        if id.is_empty() {
          // Fallback: still emit a deterministic id so empty-text
          // headings remain referenceable. Keyed on figure_counter so
          // it never collides with intentional content.
          id = format!("heading-empty-{}", self.figure_counter + self.table_counter);
        }
        let unique = self.dedup_slug(&id);
        let display = if text.is_empty() { unique.clone() } else { text };
        self.index.anchors.insert(
          unique.clone(),
          AnchorEntry {
            kind: AnchorKind::Heading,
            id: unique.clone(),
            display: display.clone(),
          },
        );
        self.index.captions.insert(unique, display);
        for c in children {
          self.walk(c);
        }
      }

      Block::Image(img) => {
        // Only count images that carry a caption — captionless images
        // are not addressed in cross-references in practice.
        if let Some(caption) = &img.caption {
          self.figure_counter += 1;
          let id = format!("figure-{}", self.figure_counter);
          let caption_text = inline_to_plain_text(caption);
          let display = format!("{} {}", self.locale_words.figure, self.figure_counter);
          let caption_full = if caption_text.is_empty() {
            display.clone()
          } else {
            format!("{display}: {caption_text}")
          };
          self.index.anchors.insert(
            id.clone(),
            AnchorEntry {
              kind: AnchorKind::Figure,
              id: id.clone(),
              display,
            },
          );
          self.index.captions.insert(id, caption_full);
        }
      }

      Block::Table { caption, .. } => {
        // Tables receive an auto-anchor regardless of caption presence
        // — referenced data tables typically lack captions but still
        // need cross-ref targets.
        self.table_counter += 1;
        let id = format!("table-{}", self.table_counter);
        let display = format!("{} {}", self.locale_words.table, self.table_counter);
        // RichText is Vec<InlineSpan>; reuse the inline plain-text
        // helper for caption extraction.
        let caption_text = caption
          .as_ref()
          .map(|r: &RichText| inline_to_plain_text(r))
          .unwrap_or_default();
        let caption_full = if caption_text.is_empty() {
          display.clone()
        } else {
          format!("{display}: {caption_text}")
        };
        self.index.anchors.insert(
          id.clone(),
          AnchorEntry {
            kind: AnchorKind::Table,
            id: id.clone(),
            display,
          },
        );
        self.index.captions.insert(id, caption_full);
      }

      // Recursive containers: walk their children.
      Block::Page { children, .. }
      | Block::Note { children }
      | Block::LocalNoteDefinition { children, .. }
      | Block::EdgelessText { children, .. }
      | Block::Paragraph { children, .. }
      | Block::Quote { children, .. }
      | Block::List { children, .. }
      | Block::Callout { children, .. } => {
        for c in children {
          self.walk(c);
        }
      }

      // Leaves with no children + no anchor.
      _ => {}
    }
  }

  fn dedup_slug(&mut self, slug: &str) -> String {
    let count = self.seen_slugs.entry(slug.to_owned()).or_insert(0);
    *count += 1;
    if *count == 1 {
      slug.to_owned()
    } else {
      format!("{slug}-{}", *count)
    }
  }
}

fn inline_to_plain_text(spans: &[InlineSpan]) -> String {
  let mut out = String::new();
  for span in spans {
    match span {
      InlineSpan::Text { text, .. } => out.push_str(text),
      InlineSpan::Latex { source } => out.push_str(source),
      InlineSpan::Reference { title, doc_id } => {
        out.push_str(title.as_deref().unwrap_or(doc_id));
      }
      InlineSpan::Mention { display_name, user_id } => {
        out.push_str(display_name.as_deref().unwrap_or(user_id));
      }
      InlineSpan::Footnote { content } => out.push_str(&inline_to_plain_text(content)),
      InlineSpan::LocalFootnote { number, .. } => {
        out.push_str(&number.map_or_else(|| "[?]".into(), |n| format!("[{n}]")))
      }
    }
  }
  out
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use crate::ir::block::{BlobRef, HeadingLevel, ImageRef};
  use crate::ir::{Branding, DocumentMetadata, ExportOptions};
  use uuid::Uuid;

  fn doc_with_root(root: Block) -> IrDocument {
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

  /// `INV-XR-01` (`P-PDF-TPL-XR-01-05`): a heading produces an anchor
  /// keyed on its slugified text, and the resolver returns it when
  /// referenced via `#`.
  #[test]
  fn inv_xr01_heading_anchor_resolved_to_label() {
    let doc = doc_with_root(page(vec![Block::Heading {
      level: HeadingLevel::H1,
      content: vec![InlineSpan::Text {
        text: "Quarterly Report 2026".into(),
        marks: Default::default(),
      }],
      children: vec![],
    }]));
    let index = build_index(&doc, "en");
    let entry = resolve_anchor(&index, "#quarterly-report-2026").expect("resolved");
    assert_eq!(entry.kind, AnchorKind::Heading);
    assert_eq!(entry.display, "Quarterly Report 2026");
  }

  /// `INV-XR-02` (`P-PDF-TPL-XR-01-06`): unknown anchor returns
  /// `LinkValidationFailed`.
  #[test]
  fn inv_xr02_unknown_anchor_emits_error() {
    let doc = doc_with_root(page(vec![]));
    let index = build_index(&doc, "en");
    let err = resolve_anchor(&index, "#bogus").expect_err("must err");
    assert!(matches!(err, CrossRefError::UnknownAnchor(s) if s == "bogus"));
  }

  /// `INV-XR-03` (`P-PDF-TPL-XR-01-07`): figure auto-numbering
  /// increments per document — the third figure becomes `figure-3`
  /// regardless of its caption text.
  #[test]
  fn inv_xr03_figure_numbering_increments_per_doc() {
    let img = |caption: &str| {
      Block::Image(ImageRef {
        blob: BlobRef {
          blob_id: "blob-1".into(),
          mime_hint: None,
        },
        caption: Some(vec![InlineSpan::Text {
          text: caption.into(),
          marks: Default::default(),
        }]),
        width_hint: None,
        height_hint: None,
        data: None,
      })
    };
    let doc = doc_with_root(page(vec![img("First"), img("Second"), img("Third")]));
    let index = build_index(&doc, "en");
    assert_eq!(index.anchors.get("figure-1").unwrap().display, "Figure 1");
    assert_eq!(index.anchors.get("figure-2").unwrap().display, "Figure 2");
    assert_eq!(index.anchors.get("figure-3").unwrap().display, "Figure 3");
    assert_eq!(index.captions.get("figure-3").unwrap(), "Figure 3: Third");
  }

  /// Slugify follows GFM-ish conventions: lowercase, runs of
  /// non-alphanumeric become a single `-`, no leading/trailing `-`.
  #[test]
  fn slugify_handles_unicode_and_punctuation() {
    assert_eq!(slugify("Hello, World!"), "hello-world");
    assert_eq!(slugify("  spaced   out  "), "spaced-out");
    // Non-ASCII alphanumeric chars are dropped (we don't try to
    // transliterate); umlauts collapse to `-`.
    assert_eq!(slugify("Über"), "ber");
    assert_eq!(slugify(""), "");
  }

  /// Two headings with the same text get distinct slugs (`-2`, `-3`, …)
  /// — the renderer must never resolve a slug collision into a
  /// stable-but-wrong anchor.
  #[test]
  fn duplicate_heading_text_gets_unique_slugs() {
    let doc = doc_with_root(page(vec![
      Block::Heading {
        level: HeadingLevel::H1,
        content: vec![InlineSpan::Text {
          text: "Background".into(),
          marks: Default::default(),
        }],
        children: vec![],
      },
      Block::Heading {
        level: HeadingLevel::H2,
        content: vec![InlineSpan::Text {
          text: "Background".into(),
          marks: Default::default(),
        }],
        children: vec![],
      },
    ]));
    let index = build_index(&doc, "en");
    assert!(index.anchors.contains_key("background"));
    assert!(index.anchors.contains_key("background-2"));
  }

  /// German locale produces the localised "Abbildung" / "Tabelle"
  /// caption words.
  #[test]
  fn locale_words_de_uses_abbildung_and_tabelle() {
    let words = locale_words("de");
    assert_eq!(words.figure, "Abbildung");
    assert_eq!(words.table, "Tabelle");
    let words_at = locale_words("de-AT");
    assert_eq!(words_at.figure, "Abbildung");
  }
}
